"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

/** ---------------------------
 * Middleware
 * -------------------------- */
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN : true,
    methods: ["GET", "POST", "DELETE"],
  })
);

/** ---------------------------
 * Files (simple storage)
 * -------------------------- */
const GUARDIANS_FILE = path.join(__dirname, "guardians.json");
const LOCATION_FILE = path.join(__dirname, "lastLocation.json");
const MEMORY_FILE = path.join(__dirname, "memory.json");

/** ---------------------------
 * Helpers: JSON read/write
 * -------------------------- */
function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return safeJsonParse(raw, fallback);
  } catch (err) {
    console.error("readJsonFile error:", filePath, err?.message || err);
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("writeJsonFile error:", filePath, err?.message || err);
    return false;
  }
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function isPlaceholder(val) {
  if (!val) return true;
  const s = String(val).toLowerCase();
  return /your|placeholder|change|replace|xxxx|example/.test(s);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/** ---------------------------
 * Simple rate limiter
 * -------------------------- */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 40;
const rateLimitStore = new Map();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip;
}

function rateLimitMiddleware(req, res, next) {
  try {
    const ip = getClientIp(req) || "unknown";
    const now = Date.now();
    const entry = rateLimitStore.get(ip);

    if (!entry) {
      rateLimitStore.set(ip, { count: 1, start: now });
      return next();
    }

    if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.set(ip, { count: 1, start: now });
      return next();
    }

    entry.count += 1;
    rateLimitStore.set(ip, entry);

    if (entry.count > RATE_LIMIT_MAX) return res.status(429).json({ error: "rate_limited" });
    return next();
  } catch {
    return next();
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitStore.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

/** ---------------------------
 * Scenarios (preset)
 * -------------------------- */
const SCENARIOS = [
  {
    scenarioId: "s1",
    displayName: "Morning commute",
    timeOfDay: "day",
    userAlone: false,
    neighborhoodType: "downtown",
    routeLighting: "good",
  },
  {
    scenarioId: "s2",
    displayName: "Late night walk",
    timeOfDay: "night",
    userAlone: true,
    neighborhoodType: "residential",
    routeLighting: "poor",
  },
  {
    scenarioId: "s3",
    displayName: "Evening shift exit",
    timeOfDay: "night",
    userAlone: false,
    neighborhoodType: "industrial",
    routeLighting: "mixed",
  },
  {
    scenarioId: "s4",
    displayName: "Afternoon stroll",
    timeOfDay: "day",
    userAlone: true,
    neighborhoodType: "residential",
    routeLighting: "good",
  },
  {
    scenarioId: "s5",
    displayName: "Late evening errand",
    timeOfDay: "night",
    userAlone: true,
    neighborhoodType: "downtown",
    routeLighting: "mixed",
  },
];

/** ---------------------------
 * Memory (tiny demo memory)
 * -------------------------- */
let MEMORY = readJsonFile(MEMORY_FILE, {
  hasMemory: false,
  lastLowScenarioId: null,
  lastSaferAction: null,
  lastGeneratedMessage: null,
  lastLocationTs: null,
});

function saveMemory() {
  writeJsonFile(MEMORY_FILE, MEMORY);
}

/** ---------------------------
 * Guardians storage
 * -------------------------- */
function readGuardians() {
  const list = readJsonFile(GUARDIANS_FILE, []);
  return Array.isArray(list) ? list : [];
}

function writeGuardians(list) {
  return writeJsonFile(GUARDIANS_FILE, Array.isArray(list) ? list : []);
}

function validateGuardianInput({ name, method, value }) {
  const errors = [];
  if (!name || String(name).trim().length < 1) errors.push("name_required");
  const m = String(method || "").toLowerCase();
  if (!["sms", "email"].includes(m)) errors.push("method_must_be_sms_or_email");

  const v = String(value || "").trim();
  if (!v) errors.push("value_required");

  if (m === "email" && v && !v.includes("@")) errors.push("email_invalid");
  if (m === "sms" && v && !/^\+?[0-9][0-9\s\-()]{6,}$/.test(v)) errors.push("phone_invalid");

  return errors;
}

/** ---------------------------
 * Location storage
 * -------------------------- */
function readLastLocation() {
  const loc = readJsonFile(LOCATION_FILE, { lat: null, lng: null, accuracy: null, ts: null });
  if (!loc || typeof loc !== "object") return { lat: null, lng: null, accuracy: null, ts: null };
  return {
    lat: typeof loc.lat === "number" ? loc.lat : null,
    lng: typeof loc.lng === "number" ? loc.lng : null,
    accuracy: typeof loc.accuracy === "number" ? loc.accuracy : null,
    ts: typeof loc.ts === "number" ? loc.ts : null,
  };
}

function writeLastLocation(loc) {
  return writeJsonFile(LOCATION_FILE, {
    lat: loc.lat,
    lng: loc.lng,
    accuracy: loc.accuracy ?? null,
    ts: loc.ts ?? Date.now(),
  });
}

/** ---------------------------
 * Offline risk engine
 * -------------------------- */
function offlineRiskEngine(input) {
  let score = 0;
  if (input?.timeOfDay === "night") score += 25;
  if (input?.userAlone === true) score += 25;
  if (input?.neighborhoodType === "industrial") score += 20;
  if (input?.neighborhoodType === "downtown") score += 10;
  if (input?.routeLighting === "poor") score += 20;
  if (input?.routeLighting === "mixed") score += 10;

  score = clamp(score, 0, 100);

  let riskLevel = "LOW";
  if (score >= 70) riskLevel = "HIGH";
  else if (score >= 40) riskLevel = "MEDIUM";

  const reasoning = `Offline score computed from inputs: timeOfDay=${input?.timeOfDay}, userAlone=${input?.userAlone}, neighborhoodType=${input?.neighborhoodType}, routeLighting=${input?.routeLighting}`;

  const guardianMessage =
    riskLevel === "HIGH"
      ? "High risk detected. Stay alert and consider contacting someone you trust."
      : riskLevel === "MEDIUM"
      ? "Moderate risk detected. Stay aware of your surroundings."
      : "Low risk detected. Exercise normal caution.";

  const saferAction =
    riskLevel === "HIGH"
      ? "Avoid the route if possible, choose a well-lit path, or ask someone to accompany you."
      : riskLevel === "MEDIUM"
      ? "Prefer well-lit routes and stay in populated areas."
      : "Proceed but remain aware of surroundings.";

  return { riskScore: score, riskLevel, reasoning, guardianMessage, saferAction };
}

/** ---------------------------
 * Emergency script generator (1-click)
 * -------------------------- */
function buildEmergencyScript({ riskLevel, contactType, locationText, extra }) {
  const level = (riskLevel || "MEDIUM").toUpperCase();
  const contact = (contactType || "friend").toLowerCase();
  const loc = (locationText || "").trim();
  const ctx = (extra || "").trim();

  const where = loc ? ` near ${loc}` : "";
  const contextBit = ctx ? ` (${ctx})` : "";

  const baseChecklist = [
    "Share your live location",
    "Move to a well-lit / populated area",
    "Stay on call with someone you trust",
  ];

  if (contact === "campus" || contact === "security") {
    const text =
      level === "HIGH"
        ? `Hi, I need help${where}. I feel unsafe${contextBit}. Please advise immediate steps and, if possible, send assistance.`
        : `Hi, I'm requesting safety support${where}${contextBit}. Can you advise the safest route / next steps?`;

    return {
      title: "Security message",
      text,
      checklist: ["Share location with security", ...baseChecklist],
      suggestedFollowups: [
        "I can share my exact location now.",
        "I'm moving to a well-lit area.",
        "Please stay on the line with me.",
      ],
    };
  }

  if (contact === "family") {
    const text =
      level === "HIGH"
        ? `Hey, I feel unsafe${where}${contextBit}. Can you stay on call with me? If I don't reply in 5 minutes, please check on me.`
        : `Hey, I'm heading somewhere${where}${contextBit}. Can you stay available for a quick check-in?`;

    return {
      title: "Family message",
      text,
      checklist: ["Send location to family", ...baseChecklist],
      suggestedFollowups: [
        "I'm sharing my live location now.",
        "Can you call me for a few minutes?",
        "If I stop responding, please check on me.",
      ],
    };
  }

  // default: friend
  const text =
    level === "HIGH"
      ? `Hey, I feel unsafe${where}${contextBit}. Can you stay on call with me for 10 minutes? If I stop replying, please check on me.`
      : level === "MEDIUM"
      ? `Hey, I'm a bit uncomfortable${where}${contextBit}. Can you stay on standby and check in with me in a few minutes?`
      : `Hey! Quick check-in: I'm walking${where}${contextBit}. I'll message when I arrive.`;

  return {
    title: "Quick message",
    text,
    checklist: ["Send to a trusted friend", ...baseChecklist],
    suggestedFollowups: [
      "I'm sharing my live location now.",
      "Can you stay on call with me?",
      "I'll text you when I arrive safely.",
    ],
  };
}

/** ---------------------------
 * Presage-style suggestions
 * (Real Presage is usually frontend autocomplete; this is demo-safe)
 * -------------------------- */
function presageSuggest(prefixRaw) {
  const prefix = String(prefixRaw || "").trim().toLowerCase();

  const library = [
    "Can you stay on call with me for a few minutes?",
    "I'm sharing my live location now.",
    "If I stop replying, please check on me.",
    "I'm moving to a well-lit area.",
    "Can you meet me at a nearby public place?",
    "Please call me when you can.",
    "I'm not sure this route is safe—I'm taking another path.",
    "If needed, can you contact campus security for me?",
    "I'm feeling uncomfortable and want to be extra careful.",
  ];

  if (!prefix) return library.slice(0, 6);

  const starts = library.filter((s) => s.toLowerCase().startsWith(prefix));
  const includes = library.filter((s) => !starts.includes(s) && s.toLowerCase().includes(prefix));
  return [...starts, ...includes].slice(0, 8);
}

/** ---------------------------
 * Rule-based chat (character assistant)
 * -------------------------- */
function buildChatReply(message, context) {
  const msg = String(message || "").toLowerCase();
  const level = String(context?.riskLevel || "MEDIUM").toUpperCase();

  const hasFear =
    msg.includes("scared") ||
    msg.includes("unsafe") ||
    msg.includes("help") ||
    msg.includes("follow") ||
    msg.includes("someone") ||
    msg.includes("panic");

  if (!msg.trim()) {
    return { reply: "Tell me what’s happening and I’ll guide you step by step.", intent: "ask_for_context" };
  }

  if (hasFear) {
    if (level === "HIGH") {
      return {
        reply:
          "I’m here with you. Move to a well-lit, public place now. Call a trusted contact and share your live location. If you feel in immediate danger, call emergency services.",
        intent: "calm_and_direct",
      };
    }
    if (level === "MEDIUM") {
      return {
        reply:
          "Okay. Stay aware and avoid isolated routes. Share your location with someone you trust and keep your phone ready. If the situation escalates, move to a public place.",
        intent: "calm_and_guided",
      };
    }
    return {
      reply:
        "Thanks for checking in. Keep a normal pace, stay in visible areas, and share your location if you want extra safety.",
      intent: "reassure",
    };
  }

  // generic guidance
  if (level === "HIGH") {
    return {
      reply:
        "Given the risk level, choose a safer route: well-lit streets, populated areas, and keep a trusted person on call. You can generate an emergency message anytime.",
      intent: "high_risk_guidance",
    };
  }

  return {
    reply:
      "I can help you plan safer steps. If you share your situation (alone, time, lighting), I’ll suggest what to do next.",
    intent: "general_guidance",
  };
}

/** ---------------------------
 * Emergency prepare (guardian-based package)
 * -------------------------- */
function makeMapsLink(lat, lng) {
  return `https://maps.google.com/?q=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
}

function buildEmergencyMessages({ riskLevel, note, guardians, location }) {
  const level = String(riskLevel || "HIGH").toUpperCase();
  const shareLink = makeMapsLink(location.lat, location.lng);
  const locLine = `My live location: ${shareLink}`;
  const noteLine = note ? `Note: ${note}` : "";

  const recommendedActions =
    level === "HIGH"
      ? ["Move to a well-lit area", "Stay on call with someone you trust", "Share your live location", "Seek help nearby"]
      : level === "MEDIUM"
      ? ["Stay in populated areas", "Share your location", "Avoid isolated routes"]
      : ["Keep awareness", "Check in with a trusted person if needed"];

  const messages = guardians.map((g) => {
    const to = g.value;
    const method = g.method;

    let text = "";
    if (method === "sms") {
      text =
        level === "HIGH"
          ? `I feel unsafe. Please call me now. ${locLine}${noteLine ? " " + noteLine : ""}`
          : `Quick safety check-in. ${locLine}${noteLine ? " " + noteLine : ""}`;
    } else {
      // email
      text =
        level === "HIGH"
          ? `Hi ${g.name || ""},\n\nI feel unsafe right now.\n${locLine}\n${noteLine}\n\nPlease call me. If I don’t respond, please check on me.\n`
          : `Hi ${g.name || ""},\n\nQuick check-in.\n${locLine}\n${noteLine}\n\nThank you.\n`;
    }

    return {
      guardianId: g.id,
      method,
      to,
      text: text.trim(),
      shareLink,
    };
  });

  return { messages, recommendedActions, shareLink };
}

/** ---------------------------
 * Routes: basic
 * -------------------------- */
app.get("/", (req, res) =>
  res.json({
    ok: true,
    name: "SafeCircle Backend",
    message: "Backend is running. Visit /health or /api/docs",
    links: {
      health: "/health",
      docs: "/api/docs",
      scenarios: "/api/scenarios",
      guardians: "/api/guardians",
      location: "/api/location",
      risk: "/api/risk-assess",
      emergencyScript: "/api/emergency-script",
      emergencyPrepare: "/api/emergency/prepare",
      presageSuggest: "/api/presage-suggest",
      chat: "/api/chat",
      memory: "/api/memory-echo",
      ttsInfo: "/api/tts",
    },
  })
);

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/scenarios", (req, res) => res.json(SCENARIOS));
app.get("/api/memory-echo", (req, res) => res.json(MEMORY));

/** ---------------------------
 * Docs
 * -------------------------- */
app.get("/api/docs", (req, res) => {
  res.json({
    endpoints: [
      { method: "GET", path: "/health", description: "Liveness check" },
      { method: "GET", path: "/api/scenarios", description: "List preset scenarios" },

      { method: "GET", path: "/api/guardians", description: "List guardians" },
      {
        method: "POST",
        path: "/api/guardians",
        description: "Add guardian",
        body: { name: "string", method: "sms|email", value: "string", relationship: "friend|family|campus" },
      },
      { method: "DELETE", path: "/api/guardians/:id", description: "Delete guardian by id" },

      {
        method: "POST",
        path: "/api/location",
        description: "Save last known location",
        body: { lat: "number", lng: "number", accuracy: "number?", ts: "number?" },
      },
      { method: "GET", path: "/api/location", description: "Get last known location (debug)" },

      {
        method: "POST",
        path: "/api/risk-assess",
        description: "Assess risk using offline engine",
        body: { scenarioId: "string", timeOfDay: "day|night", userAlone: "boolean", neighborhoodType: "string", routeLighting: "string" },
      },

      {
        method: "POST",
        path: "/api/emergency-script",
        description: "Generate 1-click message + checklist",
        body: { riskLevel: "HIGH|MEDIUM|LOW", contactType: "friend|family|security", locationText: "string?", extra: "string?" },
      },

      {
        method: "POST",
        path: "/api/emergency/prepare",
        description: "Generate guardian-based emergency messages using stored guardians + lastLocation",
        body: { riskLevel: "HIGH|MEDIUM|LOW", note: "string?" },
      },

      {
        method: "POST",
        path: "/api/presage-suggest",
        description: "Presage-style safety phrase suggestions",
        body: { prefix: "string" },
      },

      {
        method: "POST",
        path: "/api/chat",
        description: "Rule-based character assistant reply",
        body: { message: "string", context: { riskLevel: "HIGH|MEDIUM|LOW" } },
      },

      { method: "GET", path: "/api/memory-echo", description: "Return last saved memory" },
      { method: "GET", path: "/api/tts", description: "TTS usage info" },
      { method: "POST", path: "/api/tts", description: "Generate speech audio (mp3) or fallback JSON" },
    ],
  });
});

/** ---------------------------
 * Guardians endpoints
 * -------------------------- */
app.get("/api/guardians", (req, res) => {
  const list = readGuardians();
  res.json(list);
});

app.post("/api/guardians", rateLimitMiddleware, (req, res) => {
  const body = req.body || {};
  const guardian = {
    id: makeId("g"),
    name: String(body.name || "").trim(),
    method: String(body.method || "").toLowerCase(),
    value: String(body.value || "").trim(),
    relationship: String(body.relationship || "friend").trim(),
    createdAt: Date.now(),
  };

  const errors = validateGuardianInput(guardian);
  if (errors.length) return res.status(400).json({ ok: false, error: "invalid_guardian", details: errors });

  const list = readGuardians();
  list.push(guardian);
  writeGuardians(list);

  res.status(201).json({ ok: true, guardian });
});

app.delete("/api/guardians/:id", rateLimitMiddleware, (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

  const list = readGuardians();
  const next = list.filter((g) => g.id !== id);
  writeGuardians(next);

  res.json({ ok: true, deleted: list.length - next.length });
});

// index.js içine eklenecek rota
app.get('/api/music', (req, res) => {
  const musicList = require('./music.json');
  res.json(musicList);
});

app.post('/api/voice/speak', async (req, res) => {
  const { text, voiceId } = req.body;
  // Burada ElevenLabs API anahtarını kullanacaksın
  // Örnek: res.json({ audioUrl: "generated_audio_link_here" });
  console.log("Karakter konuşuyor:", text);
  res.json({ success: true, message: "Ses başarıyla oluşturuldu" });
});

app.post('/api/emergency/prepare', (req, res) => {
  const guardians = require('./guardians.json'); // Koruyucuları oku
  const location = require('./lastLocation.json'); // Son konumu al
  
  const emergencyPackage = {
    risk: req.body.riskLevel,
    note: req.body.note,
    currentLocation: location,
    notifiedGuardians: guardians.map(g => g.name) // Kimlere haber gitti?
  };
  
  console.log("ACİL DURUM PAKETİ HAZIRLANDI:", emergencyPackage);
  res.json(emergencyPackage);
});

/** ---------------------------
 * Location endpoints
 * -------------------------- */
app.get("/api/location", (req, res) => {
  const loc = readLastLocation();
  res.json({ ok: true, location: loc });
});

app.post("/api/location", rateLimitMiddleware, (req, res) => {
  const { lat, lng, accuracy, ts } = req.body || {};
  const latN = Number(lat);
  const lngN = Number(lng);

  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    return res.status(400).json({ ok: false, error: "invalid_lat_lng" });
  }

  const saved = {
    lat: latN,
    lng: lngN,
    accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
  };

  writeLastLocation(saved);

  MEMORY.lastLocationTs = saved.ts;
  MEMORY.hasMemory = true;
  saveMemory();

  res.json({ ok: true, saved });
});

/** ---------------------------
 * Risk assess (offline engine)
 * -------------------------- */
app.post("/api/risk-assess", rateLimitMiddleware, (req, res) => {
  const body = req.body || {};
  const required = ["scenarioId", "timeOfDay", "userAlone", "neighborhoodType", "routeLighting"];
  for (const field of required) {
    if (!(field in body)) return res.status(400).json({ ok: false, error: `missing_${field}` });
  }

  const out = offlineRiskEngine(body);

  if (out.riskLevel === "LOW") {
    MEMORY.hasMemory = true;
    MEMORY.lastLowScenarioId = body.scenarioId || null;
    MEMORY.lastSaferAction = out.saferAction || null;
    saveMemory();
  }

  res.json({ ...out, model: "local-engine" });
});

/** ---------------------------
 * Emergency script (1-click)
 * -------------------------- */
app.post("/api/emergency-script", rateLimitMiddleware, (req, res) => {
  const { riskLevel, contactType, locationText, extra } = req.body || {};
  if (!riskLevel) return res.status(400).json({ ok: false, error: "missing_riskLevel" });
  if (!contactType) return res.status(400).json({ ok: false, error: "missing_contactType" });

  const script = buildEmergencyScript({ riskLevel, contactType, locationText, extra });

  MEMORY.lastGeneratedMessage = {
    ts: Date.now(),
    riskLevel: String(riskLevel).toUpperCase(),
    contactType: String(contactType).toLowerCase(),
    preview: script.text.slice(0, 140),
  };
  MEMORY.hasMemory = true;
  saveMemory();

  res.json({ ok: true, ...script });
});

/** ---------------------------
 * Emergency prepare (guardian-based package)
 * -------------------------- */
app.post("/api/emergency/prepare", rateLimitMiddleware, (req, res) => {
  const { riskLevel, note } = req.body || {};
  if (!riskLevel) return res.status(400).json({ ok: false, error: "missing_riskLevel" });

  const guardians = readGuardians();
  if (!guardians.length) return res.status(400).json({ ok: false, error: "no_guardians" });

  const location = readLastLocation();
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return res.status(400).json({ ok: false, error: "no_location" });
  }

  const pack = buildEmergencyMessages({ riskLevel, note, guardians, location });

  res.json({
    ok: true,
    riskLevel: String(riskLevel).toUpperCase(),
    shareLink: pack.shareLink,
    messages: pack.messages,
    recommendedActions: pack.recommendedActions,
    hint: "Frontend should show Copy buttons + sms:/mailto: links (no real sending required).",
  });
});

/** ---------------------------
 * Presage-style suggestions
 * -------------------------- */
app.post("/api/presage-suggest", rateLimitMiddleware, (req, res) => {
  const { prefix } = req.body || {};
  if (typeof prefix !== "string") return res.status(400).json({ ok: false, error: "missing_prefix" });

  const suggestions = presageSuggest(prefix);
  res.json({ ok: true, provider: "presage-style", suggestions });
});

/** ---------------------------
 * Chat endpoint (character assistant)
 * -------------------------- */
app.post("/api/chat", rateLimitMiddleware, (req, res) => {
  const { message, context } = req.body || {};
  const replyObj = buildChatReply(message, context || {});
  res.json({ ok: true, reply: replyObj.reply, intent: replyObj.intent });
});

/** ---------------------------
 * TTS endpoints
 * -------------------------- */
app.get("/api/tts", (req, res) => {
  res.json({
    ok: true,
    note: "Use POST /api/tts with body { text } to generate audio/mpeg or fallback JSON.",
    examplePowerShell:
      "Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:8080/api/tts -ContentType \"application/json\" -Body '{\"text\":\"hello\"}' -OutFile test.mp3",
  });
});

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

app.post("/api/tts", rateLimitMiddleware, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ ok: false, error: "missing_text" });
  if (text.length > 700) return res.status(400).json({ ok: false, error: "text_too_long" });

  const API_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

  if (isPlaceholder(API_KEY) || isPlaceholder(VOICE_ID)) {
    return res.status(200).json({
      ok: false,
      fallback: true,
      provider: "browser_tts",
      text,
      reason: "elevenlabs_unavailable",
    });
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!response.ok) {
      const detail = await safeReadText(response);
      console.error("ElevenLabs HTTP error:", response.status, detail?.slice(0, 200));
      return res.status(200).json({
        ok: false,
        fallback: true,
        provider: "browser_tts",
        text,
        reason: "elevenlabs_unavailable",
      });
    }

    const ab = await response.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(ab));
  } catch (err) {
    console.error("ElevenLabs error:", err?.message || err);
    res.status(200).json({
      ok: false,
      fallback: true,
      provider: "browser_tts",
      text,
      reason: "elevenlabs_unavailable",
    });
  }
});

/** ---------------------------
 * 404 + error handlers
 * -------------------------- */
app.use((req, res) => res.status(404).send("Not Found"));

app.use((err, req, res, next) => {
  console.error("server_error:", err);
  res.status(500).json({ ok: false, error: "server_error" });
});

/** ---------------------------
 * Start
 * -------------------------- */
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  console.log("Allowed origin:", process.env.ALLOWED_ORIGIN || "(dev: any)");
  console.log("ElevenLabs key present:", Boolean(process.env.ELEVENLABS_API_KEY));
  console.log("ElevenLabs voice id present:", Boolean(process.env.ELEVENLABS_VOICE_ID));
});