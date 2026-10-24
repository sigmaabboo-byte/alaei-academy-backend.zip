"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("./db");

/* ---------------- database (PostgreSQL via DATABASE_URL) ---------------- */
const { q, tx, Rollback, getPool, closePool } = db;
const json = v => (typeof v === "string" ? JSON.parse(v) : v);   // jsonb columns already arrive parsed
/* PostgreSQL text/jsonb cannot hold NUL (\u0000) characters */
const noNul = s => String(s).replace(/\u0000/g, "");
const jsonParam = v => JSON.stringify(v, (k, x) => (typeof x === "string" ? noNul(x) : x));   // use with $n::jsonb

/* ---------------- encryption for the AI key (AES-256-GCM) ---------------- */
const KEY = crypto.createHash("sha256").update(process.env.APP_SECRET || "dev-secret").digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}
function decrypt(blob) {
  if (!blob) return "";
  try {
    const [iv, tag, enc] = blob.split(".").map(s => Buffer.from(s, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return ""; }
}

/* ---------------- auth ---------------- */
const SECRET = process.env.JWT_SECRET || "dev-jwt-secret";
/* called once at server start: in production the built-in dev secrets are refused */
function assertProductionSecrets() {
  if (process.env.NODE_ENV !== "production") return;
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (!process.env.APP_SECRET) missing.push("APP_SECRET");
  if (missing.length) throw new Error("Missing required environment variable(s) in production: " + missing.join(", "));
  if (process.env.JWT_SECRET.length < 32) console.warn("⚠️  JWT_SECRET is short; use at least 32 random characters.");
}
const sign = admin => jwt.sign({ sub: admin.id, role: admin.role, name: admin.name }, SECRET, { expiresIn: "12h", algorithm: "HS256" });
function readToken(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try { return jwt.verify(h.slice(7), SECRET, { algorithms: ["HS256"] }); } catch { return null; }
}
const requireAdmin = (...roles) => (req, res, next) => {
  const t = readToken(req);
  if (!t) return res.status(401).json({ error: "token" });
  if (roles.length && !roles.includes(t.role)) return res.status(403).json({ error: "forbidden" });
  req.admin = t; next();
};

/* ---------------- misc ---------------- */
const uid = () => crypto.randomBytes(5).toString("hex");
const clip = (s, n) => noNul(s == null ? "" : s).slice(0, n);
/* integer coercion that mimics MySQL's lenient behaviour: rounds, clamps, never throws.
   PostgreSQL integer columns reject "12.5" and out-of-range numbers, so every numeric input goes through here. */
const int = (v, { def = 0, min = -2147483648, max = 2147483647 } = {}) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
/* valid Date or "now" (an invalid Date would make the INSERT fail) */
const dt = v => { const d = new Date(v || Date.now()); return Number.isNaN(d.getTime()) ? new Date() : d; };
const clientIp = req => (req.ip || "").replace(/^::ffff:/, "");
const audit = (req, action, detail) =>
  q("INSERT INTO audit_log (admin_id, action, detail, ip) VALUES ($1,$2,$3::jsonb,$4)",
    [(req.admin && req.admin.sub) || null, action, jsonParam(detail || {}), clientIp(req)]).catch(() => {});

module.exports = { get pool() { return getPool(); }, getPool, closePool, q, tx, Rollback, json, jsonParam, noNul, encrypt, decrypt,
  sign, readToken, requireAdmin, assertProductionSecrets, uid, clip, int, dt, clientIp, audit };
