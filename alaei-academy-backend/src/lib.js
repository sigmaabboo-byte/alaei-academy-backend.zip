"use strict";
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/* ---------------- database ---------------- */
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "alaei_academy",
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  timezone: "Z"
});
const q = (sql, params) => pool.query(sql, params).then(([rows]) => rows);
async function tx(fn) {
  const c = await pool.getConnection();
  try { await c.beginTransaction(); const r = await fn((s, p) => c.query(s, p).then(([x]) => x)); await c.commit(); return r; }
  catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}
const json = v => (typeof v === "string" ? JSON.parse(v) : v);

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
if (process.env.NODE_ENV === "production" && SECRET === "dev-jwt-secret") console.warn("⚠️  JWT_SECRET is not set!");
const sign = admin => jwt.sign({ sub: admin.id, role: admin.role, name: admin.name }, SECRET, { expiresIn: "12h" });
function readToken(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try { return jwt.verify(h.slice(7), SECRET); } catch { return null; }
}
const requireAdmin = (...roles) => (req, res, next) => {
  const t = readToken(req);
  if (!t) return res.status(401).json({ error: "token" });
  if (roles.length && !roles.includes(t.role)) return res.status(403).json({ error: "forbidden" });
  req.admin = t; next();
};

/* ---------------- misc ---------------- */
const uid = () => crypto.randomBytes(5).toString("hex");
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const clientIp = req => (req.ip || "").replace(/^::ffff:/, "");
const audit = (req, action, detail) =>
  q("INSERT INTO audit_log (admin_id, action, detail, ip) VALUES (?,?,?,?)", [req.admin && req.admin.sub, action, JSON.stringify(detail || {}), clientIp(req)]).catch(() => {});

module.exports = { pool, q, tx, json, encrypt, decrypt, sign, readToken, requireAdmin, uid, clip, clientIp, audit };
