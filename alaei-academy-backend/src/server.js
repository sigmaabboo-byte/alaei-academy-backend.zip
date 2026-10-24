"use strict";
require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q, sign, clientIp } = require("./lib");
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
    const [b] = await q("SELECT blocked FROM ip_firewall WHERE ip=?", [clientIp(req)]);
    if (b && b.blocked) return res.status(403).json({ error: "blocked" });
    await q("INSERT INTO ip_firewall (ip, hits) VALUES (?,1) ON DUPLICATE KEY UPDATE hits=hits+1", [clientIp(req)]).catch(() => {});
    next();
  } catch (e) { next(e); }
});

/* admin login (username + password, bcrypt) */
const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "too many attempts" } });
app.post("/api/auth/admin/login", loginLimit, async (req, res, next) => {
  try {
    const { username = "", password = "" } = req.body || {};
    const [a] = await q("SELECT * FROM admins WHERE username=? AND active=1", [String(username).slice(0, 64)]);
    if (!a || !a.password_hash || !(await bcrypt.compare(String(password), a.password_hash)))
      return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است" });
    await q("UPDATE admins SET last_login_at=NOW() WHERE id=?", [a.id]);
    res.json({ token: sign(a), role: a.role, name: a.name });
  } catch (e) { next(e); }
});

app.use("/api", stateRouter);
app.use("/api", assistantRouter);
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

/* static frontend (same origin = no CORS needed) */
const FE = path.resolve(process.env.FRONTEND_DIR || path.join(__dirname, "../../frontend"));
app.use(express.static(FE, { index: false, extensions: ["html"], setHeaders: (res, p) => {
  if (/\.(js|css|woff2)$/.test(p)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
} }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(FE, "index.html")));

app.use((err, req, res, next) => {
  console.error("[error]", err && err.message);
  res.status(500).json({ error: "server error" });
});

const port = +(process.env.PORT || 3000);
app.listen(port, () => console.log(`Alaei Academy running on :${port}`));
