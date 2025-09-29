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

// ---------- Paths ----------
const ROOT = __dirname;

// Uploads folder
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Public folder
const PUBLIC_DIR = path.join(ROOT, "Public");
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

// ✅ Ensure folder exists so sqlite can create/open file
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new sqlite3.Database(
  DB_FILE,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error("Failed to open DB at", DB_FILE, err);
      process.exit(1);
    } else {
      console.log("SQLite opened at", DB_FILE);
    }
  }
);

db.exec("PRAGMA journal_mode=WAL;");

// ---------- initDb ----------
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

// ---------- Helpers ----------
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

// ---------- Scenarios ----------
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

// ---------- OpenAI client ----------
const openai =
  process.env.OPENAI_API_KEY && new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// (… keep all your routes for /api/scenarios, /api/submit, /api/kpis, /api/clear, /api/notifications, /api/llm-chat …)

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
