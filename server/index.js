"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

/** ---------------------------
 * App middleware
 * -------------------------- */
app.use(express.json({ limit: "1mb" }));

// CORS: ALLOWED_ORIGIN set edilirse sadece onu açar, yoksa dev’de her şeye izin verir
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN : true,
    methods: ["GET", "POST"],
  })
);

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
 * Memory (safe local file)
 * -------------------------- */
const MEMORY_FILE = path.join(__dirname, "memory.json");
let MEMORY = {
  hasMemory: false,
  lastLowScenarioId: null,
  lastSaferAction: null,
  lastGeneratedMessage: null,
};

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        MEMORY = {
          hasMemory: Boolean(parsed.hasMemory),
          lastLowScenarioId: parsed.lastLowScenarioId || null,
          lastSaferAction: parsed.lastSaferAction || null,
          lastGeneratedMessage: parsed.lastGeneratedMessage || null,
        };
      }
    }
  } catch (err) {
    console.error("Failed to load memory.json:", err?.message || err);
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(MEMORY, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save memory.json:", err?.message || err);
  }
}

loadMemory();

/** ---------------------------
 * Simple rate limiter
 * -------------------------- */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
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

// cleanup timer
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitStore.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

/** ---------------------------
 * Helpers
 * -------------------------- */
function isPlaceholder(val) {
  if (!val) return true;
  const s = String(val).toLowerCase();
  return /your|placeholder|change|replace|xxxx|example/.test(s);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** ---------------------------
 * Offline risk engine (reliable demo)
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
 * Emergency message generator (for Presage + 1-click scripts)
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
 * Presage-style suggestions (backend helper)
 * NOTE: Real Presage is usually used in frontend for live autocomplete.
 * This endpoint gives simple suggestions for demo + safety phrases.
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

  if (!prefix) {
    return library.slice(0, 6);
  }

  // simple relevance: startsWith / includes
  const starts = library.filter((s) => s.toLowerCase().startsWith(prefix));
  const includes = library.filter((s) => !starts.includes(s) && s.toLowerCase().includes(prefix));

  return [...starts, ...includes].slice(0, 8);
}

/** ---------------------------
 * Basic routes
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
      risk: "/api/risk-assess",
      emergencyScript: "/api/emergency-script",
      presageSuggest: "/api/presage-suggest",
      memory: "/api/memory-echo",
      ttsInfo: "/api/tts",
    },
  })
);

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/scenarios", (req, res) => res.json(SCENARIOS));
app.get("/api/memory-echo", (req, res) => res.json(MEMORY));

app.get("/api/tts", (req, res) => {
  res.json({
    ok: true,
    note: "Use POST /api/tts with body { text } to generate audio/mpeg or fallback JSON.",
    exampleCurl:
      'curl -Method POST http://localhost:8080/api/tts -ContentType "application/json" -Body \'{"text":"hello"}\' -OutFile test.mp3',
  });
});

app.get("/api/docs", (req, res) => {
  res.json({
    endpoints: [
      { method: "GET", path: "/health", description: "Liveness check" },
      { method: "GET", path: "/api/scenarios", description: "List preset scenarios" },
      { method: "POST", path: "/api/risk-assess", description: "Assess risk using offline engine (reliable)" },
      { method: "POST", path: "/api/emergency-script", description: "Generate 1-click message + checklist" },
      { method: "POST", path: "/api/presage-suggest", description: "Presage-style safety phrase suggestions" },
      { method: "GET", path: "/api/memory-echo", description: "Return last saved memory (if any)" },
      { method: "GET", path: "/api/tts", description: "TTS usage info" },
      { method: "POST", path: "/api/tts", description: "Generate speech audio or return safe fallback JSON" },
    ],
  });
});

/** ---------------------------
 * Risk assess (offline engine)
 * -------------------------- */
app.post("/api/risk-assess", rateLimitMiddleware, async (req, res) => {
  const body = req.body || {};
  const required = ["scenarioId", "timeOfDay", "userAlone", "neighborhoodType", "routeLighting"];
  for (const field of required) {
    if (!(field in body)) return res.status(400).json({ error: `missing_${field}` });
  }

  const out = offlineRiskEngine(body);

  // store a tiny memory only for low risk (demo feature)
  if (out.riskLevel === "LOW") {
    MEMORY.hasMemory = true;
    MEMORY.lastLowScenarioId = body.scenarioId || null;
    MEMORY.lastSaferAction = out.saferAction || null;
    saveMemory();
  }

  return res.json({ ...out, model: "local-engine" });
});

/** ---------------------------
 * Emergency script
 * -------------------------- */
app.post("/api/emergency-script", rateLimitMiddleware, async (req, res) => {
  const { riskLevel, contactType, locationText, extra } = req.body || {};
  if (!riskLevel) return res.status(400).json({ error: "missing_riskLevel" });
  if (!contactType) return res.status(400).json({ error: "missing_contactType" });

  const script = buildEmergencyScript({ riskLevel, contactType, locationText, extra });

  // store last generated message for demo
  MEMORY.lastGeneratedMessage = {
    ts: Date.now(),
    riskLevel: String(riskLevel).toUpperCase(),
    contactType: String(contactType).toLowerCase(),
    preview: script.text.slice(0, 120),
  };
  MEMORY.hasMemory = true;
  saveMemory();

  return res.json({ ok: true, ...script });
});

/** ---------------------------
 * Presage-style suggestions (backend)
 * -------------------------- */
app.post("/api/presage-suggest", rateLimitMiddleware, async (req, res) => {
  const { prefix } = req.body || {};
  if (typeof prefix !== "string") return res.status(400).json({ error: "missing_prefix" });

  const suggestions = presageSuggest(prefix);
  return res.json({ ok: true, provider: "presage-style", suggestions });
});

/** ---------------------------
 * TTS (ElevenLabs; returns fallback JSON if not usable)
 * -------------------------- */
app.post("/api/tts", rateLimitMiddleware, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "missing_text" });
  if (text.length > 600) return res.status(400).json({ error: "text_too_long" });

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
      console.error("ElevenLabs TTS HTTP error:", response.status, detail?.slice(0, 200));
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
    return res.send(Buffer.from(ab));
  } catch (err) {
    console.error("ElevenLabs TTS error:", err?.message || err);
    return res.status(200).json({
      ok: false,
      fallback: true,
      provider: "browser_tts",
      text,
      reason: "elevenlabs_unavailable",
    });
  }
});

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** ---------------------------
 * 404 + error handlers
 * -------------------------- */
app.use((req, res) => res.status(404).send("Not Found"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

/** ---------------------------
 * Start
 * -------------------------- */
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
  console.log("ElevenLabs key present:", Boolean(process.env.ELEVENLABS_API_KEY));
  console.log("ElevenLabs voice id present:", Boolean(process.env.ELEVENLABS_VOICE_ID));
  console.log("Allowed origin:", process.env.ALLOWED_ORIGIN || "(dev: any)");
});

module.exports = app;