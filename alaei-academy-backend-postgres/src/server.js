"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q, closePool, sign, clientIp, assertProductionSecrets } = require("./lib");
const { router: stateRouter } = require("./routes/state");
const assistantRouter = require("./routes/assistant");

const app = express();
app.set("trust proxy", +(process.env.TRUST_PROXY || 1));
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));
if (process.env.CORS_ORIGINS) app.use(cors({ origin: process.env.CORS_ORIGINS.split(",").map(s => s.trim()), credentials: false }));

/* block IPs flagged in the firewall */
app.use("/api", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    const [b] = await q("SELECT blocked FROM ip_firewall WHERE ip=$1", [ip]);
    if (b && b.blocked) return res.status(403).json({ error: "blocked" });
    await q("INSERT INTO ip_firewall (ip, hits) VALUES ($1,1) ON CONFLICT (ip) DO UPDATE SET hits = ip_firewall.hits + 1", [ip]).catch(() => {});
    next();
  } catch (e) { next(e); }
});

/* admin login (username + password, bcrypt) */
const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "too many attempts" } });
app.post("/api/auth/admin/login", loginLimit, async (req, res, next) => {
  try {
    const { username = "", password = "" } = req.body || {};
    /* usernames are case-insensitive (same as the old MySQL collation) */
    const [a] = await q("SELECT * FROM admins WHERE lower(username)=lower($1) AND active=TRUE", [String(username).replace(/\u0000/g, "").slice(0, 64)]);
    if (!a || !a.password_hash || !(await bcrypt.compare(String(password), a.password_hash)))
      return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است" });
    await q("UPDATE admins SET last_login_at=NOW() WHERE id=$1", [a.id]);
    res.json({ token: sign(a), role: a.role, name: a.name });
  } catch (e) { next(e); }
});

app.use("/api", stateRouter);
app.use("/api", assistantRouter);
app.get("/api/health", (req, res) => res.json({ ok: true }));
/* extra: also checks the database connection (handy for uptime monitors) */
app.get("/api/health/db", async (req, res) => {
  try { await q("SELECT 1"); res.json({ ok: true, db: "up" }); }
  catch (e) { console.error("[health] db down:", e.code || "", e.message); res.status(503).json({ ok: false, db: "down" }); }
});
app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

/* static frontend (same origin = no CORS needed) */
const FE = path.resolve(process.env.FRONTEND_DIR || path.join(__dirname, "../../frontend"));
app.use(express.static(FE, { index: false, extensions: ["html"], setHeaders: (res, p) => {
  if (/\.(js|css|woff2)$/.test(p)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
} }));
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  const index = path.join(FE, "index.html");
  /* API-only deployment (frontend hosted elsewhere): answer cleanly instead of failing */
  if (!fs.existsSync(index)) return res.status(404).json({ error: "frontend not found", hint: "set FRONTEND_DIR or host the frontend separately" });
  res.sendFile(index, err => { if (err) next(err); });
});

app.use((err, req, res, next) => {
  console.error("[error]", err && err.code ? err.code : "", err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "server error" });
});

/* ---- start / graceful shutdown (Render sends SIGTERM on every deploy) ---- */
async function start() {
  assertProductionSecrets();
  await q("SELECT 1");                                   // fail fast if DATABASE_URL is wrong / DB unreachable
  const port = +(process.env.PORT || 3000);
  const server = app.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`Alaei Academy running on :${port}`));
  let closing = false;
  const shutdown = sig => {
    if (closing) return; closing = true;
    console.log(`[${sig}] shutting down...`);
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async () => { await closePool().catch(() => {}); process.exit(0); });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return server;
}

if (require.main === module) {
  process.on("unhandledRejection", e => console.error("[unhandledRejection]", e && e.message));
  start().catch(e => { console.error("❌ startup failed:", e.message); process.exit(1); });
}
module.exports = { app, start };
