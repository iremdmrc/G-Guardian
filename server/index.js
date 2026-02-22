require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

/** ---------------------------
 * Gemini REST helpers (stable)
 * -------------------------- */
function normalizeGeminiModelName(name) {
  if (!name) return "gemini-2.0-flash";
  return name.startsWith("models/") ? name : `models/${name}`;
}

async function callGeminiREST(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");

  const model = normalizeGeminiModelName(process.env.GEMINI_MODEL || "gemini-2.0-flash");
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(
    key
  )}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await r.json();

  if (!r.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${r.status}`;
    throw new Error(msg);
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() || "";

  return text;
}

function extractJsonFromText(text) {
  const s = (text || "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i === -1 || j === -1 || j <= i) throw new Error("No JSON object found in Gemini output");
  return JSON.parse(s.slice(i, j + 1));
}

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
 * Scenarios
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
let MEMORY = { hasMemory: false, lastLowScenarioId: null, lastSaferAction: null };

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
      memory: "/api/memory-echo",
      ttsInfo: "/api/tts",
      geminiPing: "/api/gemini-ping",
      geminiModels: "/api/gemini-models",
    },
  })
);

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/api/scenarios", (req, res) => res.json(SCENARIOS));
app.get("/api/memory-echo", (req, res) => res.json(MEMORY));

app.get("/api/tts", (req, res) => {
  res.json({
    ok: true,
    note: "Use POST /api/tts with body { text } to generate audio or fallback JSON.",
    exampleCurl:
      'curl -Method POST http://localhost:8080/api/tts -ContentType "application/json" -Body \'{"text":"hello"}\'',
  });
});

app.get("/api/docs", (req, res) => {
  res.json({
    endpoints: [
      { method: "GET", path: "/health", description: "Liveness check" },
      { method: "GET", path: "/api/scenarios", description: "List preset scenarios" },
      { method: "POST", path: "/api/risk-assess", description: "Assess risk (Gemini REST or fallback)" },
      { method: "GET", path: "/api/memory-echo", description: "Return last saved low-risk memory (if any)" },
      { method: "GET", path: "/api/tts", description: "TTS usage info" },
      { method: "POST", path: "/api/tts", description: "Generate speech audio or return safe fallback JSON" },
      { method: "GET", path: "/api/gemini-ping", description: "Check Gemini key+model works (REST)" },
      { method: "GET", path: "/api/gemini-models", description: "List available Gemini models (REST)" },
      { method: "GET", path: "/api/debug-gemini", description: "Quick env check" },
    ],
  });
});

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
  } catch (err) {
    return next();
  }
}

// cleanup timer (fix: previously interval code was broken)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS * 2) rateLimitStore.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

/** ---------------------------
 * Risk assess (Gemini REST ✅)
 * -------------------------- */
app.post("/api/risk-assess", rateLimitMiddleware, async (req, res) => {
  const body = req.body || {};
  const required = ["scenarioId", "timeOfDay", "userAlone", "neighborhoodType", "routeLighting"];

  for (const field of required) {
    if (!(field in body)) return res.status(400).json({ error: `missing_${field}` });
  }

  const key = process.env.GEMINI_API_KEY;

  function isPlaceholderKey(k) {
    if (!k) return true;
    const s = String(k).toLowerCase();
    return /your|placeholder|change|replace|xxxx|example/.test(s);
  }

  function sendResult(obj, model) {
    try {
      if (obj && obj.riskLevel === "LOW") {
        MEMORY.hasMemory = true;
        MEMORY.lastLowScenarioId = body.scenarioId || null;
        MEMORY.lastSaferAction = obj.saferAction || null;
        saveMemory();
      }
    } catch (err) {
      console.error("Failed to update memory:", err?.message || err);
    }
    return res.json({ ...obj, model });
  }

  // If no valid key -> fallback
  if (isPlaceholderKey(key)) {
    const out = fallbackRisk(body);
    return sendResult(out, "fallback");
  }

  // Gemini REST call
  try {
    const prompt = `Given the scenario input: ${JSON.stringify(body)}

Return STRICT JSON ONLY (no markdown, no backticks) with keys:
- riskScore (number 0-100)
- riskLevel ("LOW"|"MEDIUM"|"HIGH")
- reasoning (1-2 short sentences)
- guardianMessage (supportive)
- saferAction (one actionable)

Respond with only the JSON object.`;

    console.log("Gemini call start (REST)");
    const raw = await callGeminiREST(prompt);
    console.log("Gemini raw preview (REST):", raw.slice(0, 200));

    const parsed = extractJsonFromText(raw);

    if (!Number.isFinite(Number(parsed.riskScore)) || !parsed.riskLevel) {
      throw new Error("Gemini JSON missing riskScore/riskLevel");
    }

    parsed.riskScore = Math.max(0, Math.min(100, Number(parsed.riskScore)));
    return sendResult(parsed, "gemini");
} catch (err) {
  const msg = err?.message || String(err);
  console.error("Gemini ping error (REST):", msg);
  return res.status(200).json({
    ok: false,
    provider: "gemini-rest",
    error: "gemini_failed",
    message: msg,
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    keyPresent: Boolean(process.env.GEMINI_API_KEY),
  });
}
    const out = fallbackRisk(body);
    return sendResult(out, "fallback");
  }
);

/** ---------------------------
 * Gemini ping (REST ✅)
 * -------------------------- */
app.get("/api/gemini-ping", async (req, res) => {
  const key = process.env.GEMINI_API_KEY;

  function isPlaceholderKey(k) {
    if (!k) return true;
    const s = String(k).toLowerCase();
    return /your|placeholder|change|replace|xxxx|example/.test(s);
  }

  if (isPlaceholderKey(key)) {
    return res.json({
      ok: false,
      provider: "gemini-rest",
      error: "no_key",
      message: "GEMINI_API_KEY missing or placeholder",
      keyPresent: Boolean(process.env.GEMINI_API_KEY),
    });
  }

  try {
    console.log("Gemini ping start (REST)");
    const raw = await callGeminiREST('Return JSON only: {"pong":true}');
    const parsed = extractJsonFromText(raw);

    return res.json({
      ok: parsed?.pong === true,
      provider: "gemini-rest",
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      parsed,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("Gemini ping error (REST):", msg);

    return res.json({
      ok: false,
      provider: "gemini-rest",
      error: "gemini_failed",
      message: msg,
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      keyPresent: Boolean(process.env.GEMINI_API_KEY),
      keyLength: (process.env.GEMINI_API_KEY || "").length,
    });
  }
});

app.get("/api/debug-gemini", (req, res) => {
  res.json({
    ok: true,
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: process.env.GEMINI_MODEL || null,
    note: "If /api/risk-assess returns fallback, check Render logs for Gemini failed (REST) message.",
  });
});

/** ---------------------------
 * List Gemini models (REST ✅)
 * -------------------------- */
app.get("/api/gemini-models", async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(200).json({ ok: false, error: "no_key" });

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      key
    )}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) {
      return res.status(200).json({
        ok: false,
        error: "list_models_failed",
        message: data?.error?.message || `HTTP ${r.status}`,
      });
    }

    const models = (data.models || []).map((m) => ({
      name: m.name,
      supportedGenerationMethods: m.supportedGenerationMethods || [],
    }));

    return res.json({ ok: true, models });
  } catch (err) {
    console.error("Gemini models error:", err?.message || err);
    return res.status(200).json({
      ok: false,
      error: "list_models_failed",
      message: err?.message || String(err),
    });
  }
});

/** ---------------------------
 * TTS (kept as-is; returns fallback JSON if ElevenLabs not usable)
 * -------------------------- */
app.post("/api/tts", rateLimitMiddleware, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "missing_text" });
  if (text.length > 400) return res.status(400).json({ error: "text_too_long" });

  const API_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

  function isPlaceholder(k) {
    if (!k) return true;
    const s = String(k).toLowerCase();
    return /your|placeholder|change|replace|xxxx|example/.test(s);
  }

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

/** ---------------------------
 * Fallback risk scoring
 * -------------------------- */
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function fallbackRisk(input) {
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

  const reasoning = `Score computed from inputs: timeOfDay=${input?.timeOfDay}, userAlone=${input?.userAlone}, neighborhoodType=${input?.neighborhoodType}, routeLighting=${input?.routeLighting}`;

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

module.exports.fallbackRisk = fallbackRisk;

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
  console.log("Gemini key present:", Boolean(process.env.GEMINI_API_KEY));
  console.log("Gemini model:", process.env.GEMINI_MODEL || "gemini-2.0-flash");
});

module.exports = app;