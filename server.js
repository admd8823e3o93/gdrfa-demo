// server.js
// Quick start:
//   npm init -y
//   npm i express multer sqlite3 cors dotenv openai
//   node server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3001;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ---------- Static paths ----------
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/", express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

// ---------- Multer (file uploads) ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg") || ".jpg";
    const base = path
      .basename(file.originalname || "photo", ext)
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({ storage });

// ---------- SQLite ----------
const DB_FILE = process.env.DB_PATH || path.join(ROOT, "scenarios.db");
const db = new sqlite3.Database(DB_FILE);
db.exec("PRAGMA journal_mode=WAL;"); // better concurrency

function initDb() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS tempered_id (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      file_path TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS immigration_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      file_path TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS tempered_passport (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      file_path TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      scenario TEXT NOT NULL,
      message TEXT NOT NULL
    )`);
  });
}
initDb();

// Small helpers
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// ---------- Scenarios config ----------
const SCENARIOS = {
  "tempered-id": {
    table: "tempered_id",
    label: "Tampered ID",
    fixedMessage:
      "Alert received: A tampered ID was reported. Security has been notified. Please follow verification protocol A.",
  },
  "immigration-queue": {
    table: "immigration_queue",
    label: "Immigration Queue Photo",
    fixedMessage:
      "Update noted: A photo of the immigration queue was received. Operations will adjust staffing to reduce wait times.",
  },
  "tempered-passport": {
    table: "tempered_passport",
    label: "Tampered Passport",
    fixedMessage:
      "Alert received: A tampered passport was reported. Border control procedure B is now in effect.",
  },
};

// ---------- KPI helper ----------
async function getKpisForTable(table) {
  const nowIso = new Date().toISOString();
  const sod = new Date();
  sod.setHours(0, 0, 0, 0);
  const startIso = sod.toISOString();

  const total = (await get(`SELECT COUNT(*) AS c FROM ${table}`))?.c || 0;
  const today =
    (
      await get(
        `SELECT COUNT(*) AS c FROM ${table} WHERE created_at >= ? AND created_at <= ?`,
        [startIso, nowIso]
      )
    )?.c || 0;
  const lastReportTime =
    (await get(`SELECT created_at AS t FROM ${table} ORDER BY created_at DESC LIMIT 1`))?.t ||
    null;

  return { totalReports: total, reportsToday: today, lastReportTime };
}

// ---------- OpenAI client (for /api/llm-chat) ----------
const openai =
  process.env.OPENAI_API_KEY && new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Detect scenario from free text
function detectScenario(text) {
  const s = (text || "").toLowerCase();
  if (s.includes("passport")) return "tempered-passport";
  if (s.includes("queue")) return "immigration-queue";
  if (s.includes("id")) return "tempered-id";
  for (const key of Object.keys(SCENARIOS)) if (s.includes(key)) return key;
  return null;
}

// Build compact alerts context for the model
async function buildAlertsContext(userMsg) {
  const scenario = detectScenario(userMsg);

  const totals = {
    "tempered-id": (await get(`SELECT COUNT(*) AS c FROM tempered_id`))?.c || 0,
    "tempered-passport": (await get(`SELECT COUNT(*) AS c FROM tempered_passport`))?.c || 0,
    "immigration-queue": (await get(`SELECT COUNT(*) AS c FROM immigration_queue`))?.c || 0,
  };
  const today = {
    "tempered-id":
      (
        await get(
          `SELECT COUNT(*) AS c FROM notifications WHERE scenario='tempered-id' AND created_at >= date('now','start of day')`
        )
      )?.c || 0,
    "tempered-passport":
      (
        await get(
          `SELECT COUNT(*) AS c FROM notifications WHERE scenario='tempered-passport' AND created_at >= date('now','start of day')`
        )
      )?.c || 0,
    "immigration-queue":
      (
        await get(
          `SELECT COUNT(*) AS c FROM notifications WHERE scenario='immigration-queue' AND created_at >= date('now','start of day')`
        )
      )?.c || 0,
  };

  let sql = `SELECT created_at, scenario, message FROM notifications`;
  const params = [];
  if (scenario) {
    sql += ` WHERE scenario = ?`;
    params.push(scenario);
  }
  sql += ` ORDER BY created_at DESC LIMIT 10`;
  const last10 = await all(sql, params);

  const lines = last10
    .map(
      (r) =>
        `- ${r.created_at} • ${r.scenario} — ${String(r.message)
          .replace(/\s+/g, " ")
          .slice(0, 180)}`
    )
    .join("\n");

  return {
    scenario,
    text: `[ALERTS SNAPSHOT]
Totals: ID=${totals["tempered-id"]}, Passport=${totals["tempered-passport"]}, Queue=${totals["immigration-queue"]}
Today:  ID=${today["tempered-id"]}, Passport=${today["tempered-passport"]}, Queue=${today["immigration-queue"]}
Recent alerts:
${lines || "(none)"}
[END SNAPSHOT]`,
  };
}

// ---------- Routes ----------

// Scenario list
app.get("/api/scenarios", (_req, res) => {
  res.json({
    scenarios: Object.entries(SCENARIOS).map(([value, cfg]) => ({
      value,
      label: cfg.label,
    })),
  });
});

// Submit (save incident + create notification)
app.post("/api/submit", upload.single("photo"), async (req, res) => {
  try {
    const { scenario } = req.body;
    const cfg = SCENARIOS[scenario];
    if (!cfg) return res.status(400).json({ error: "Invalid scenario" });
    if (!req.file) return res.status(400).json({ error: "Photo is required" });

    const createdAt = new Date().toISOString();
    const filePath = `/uploads/${req.file.filename}`;

    db.run(
      `INSERT INTO ${cfg.table} (created_at, file_path) VALUES (?, ?)`,
      [createdAt, filePath],
      function (err) {
        if (err) return res.status(500).json({ error: "DB insert failed" });

        db.run(
          `INSERT INTO notifications (created_at, scenario, message) VALUES (?, ?, ?)`,
          [createdAt, scenario, cfg.fixedMessage],
          async (e2) => {
            if (e2) return res.status(500).json({ error: "Notify insert failed" });
            const kpis = await getKpisForTable(cfg.table);
            res.json({
              ok: true,
              scenario,
              filePath,
              chatbotMessage: cfg.fixedMessage,
              kpis,
            });
          }
        );
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unexpected error" });
  }
});

// KPIs for a scenario
app.get("/api/kpis", async (req, res) => {
  try {
    const { scenario } = req.query;
    const cfg = SCENARIOS[scenario];
    if (!cfg) return res.status(400).json({ error: "Invalid scenario" });
    const kpis = await getKpisForTable(cfg.table);
    res.json({ scenario, kpis });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unexpected error" });
  }
});

// Clear selected scenario (and its notifications by default)
app.post("/api/clear", async (req, res) => {
  try {
    const { scenario, clearNotifications = true } = req.body;
    const cfg = SCENARIOS[scenario];
    if (!cfg) return res.status(400).json({ error: "Invalid scenario" });

    db.run(`DELETE FROM ${cfg.table}`, [], async (err) => {
      if (err) return res.status(500).json({ error: "DB clear failed" });

      if (clearNotifications) {
        db.run(
          `DELETE FROM notifications WHERE scenario = ?`,
          [scenario],
          (e2) => e2 && console.error("Could not clear notifications:", e2)
        );
      }
      const kpis = await getKpisForTable(cfg.table);
      res.json({
        ok: true,
        scenario,
        kpis,
        chatbotMessage:
          "Data cleared. All counters and alerts reset to 0 for this scenario.",
      });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unexpected error" });
  }
});

// Notifications feed
app.get("/api/notifications", async (req, res) => {
  try {
    const { scenario, start, end, limit = 100 } = req.query;
    let sql = `SELECT created_at, scenario, message FROM notifications`;
    const params = [];
    const where = [];
    if (scenario) {
      where.push(`scenario = ?`);
      params.push(scenario);
    }
    if (start && end) {
      where.push(`date(created_at) BETWEEN ? AND ?`);
      params.push(start, end);
    }
    if (where.length) sql += ` WHERE ` + where.join(" AND ");
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(Number(limit));

    const rows = await all(sql, params);
    res.json({ items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unexpected error" });
  }
});

// --------- OpenAI-backed chatbot ----------
app.post("/api/llm-chat", async (req, res) => {
  try {
    if (!openai) {
      return res.status(400).json({ error: "OPENAI_API_KEY missing on server." });
    }
    const { messages = [] } = req.body || {};
    const lastUser =
      messages.filter((m) => m.role === "user").slice(-1)[0]?.content || "";

    const ctx = await buildAlertsContext(lastUser);

    const systemPrompt = `
You are **Airport Assistant**, concise and helpful.
- If the user asks about alerts/incidents, rely ONLY on the data in the "ALERTS SNAPSHOT" for counts and recent items. If something isn't in the snapshot, say it's unavailable.
- Otherwise answer normally.
- Keep responses short, readable, and use Markdown: bold headline and 2–4 bullets when appropriate.

${ctx.text}
`.trim();

    const history = messages.slice(-10); // keep it light

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: systemPrompt }, ...history],
    });

    const reply = completion.choices?.[0]?.message?.content || "…";
    res.json({ reply, scenario: ctx.scenario });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Chat failed." });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
