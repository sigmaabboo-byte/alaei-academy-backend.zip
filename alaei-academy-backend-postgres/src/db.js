"use strict";
/* PostgreSQL access layer. Connection settings come ONLY from environment variables
   (DATABASE_URL, DATABASE_SSL, DATABASE_CA_CERT, DB_POOL_MAX). Nothing secret lives in code. */
const { Pool, types } = require("pg");

/* BIGINT (int8) comes back as a string by default (COUNT(*), identity ids).
   Return a Number whenever it is safe, so JSON output matches what the front-end expects. */
types.setTypeParser(20, v => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; });

/* throw this inside tx() to roll back silently; tx() then resolves to undefined */
class Rollback extends Error { constructor(msg) { super(msg || "rollback"); this.name = "Rollback"; } }

const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };

function parseUrl(raw) {
  if (!raw || !String(raw).trim())
    throw new Error("DATABASE_URL is not set. Expected: postgresql://USER:PASSWORD@HOST:5432/DBNAME");
  let u;
  try { u = new URL(String(raw).trim()); }
  catch { throw new Error("DATABASE_URL is not a valid URL (expected postgresql://USER:PASSWORD@HOST:5432/DBNAME)"); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  return u;
}

/* DATABASE_SSL (env) wins over ?sslmode= in the URL; default "auto". */
function resolveSsl(u) {
  const pick = String(process.env.DATABASE_SSL || u.searchParams.get("sslmode") || "auto").trim().toLowerCase();
  if (["disable", "false", "0", "off", "no"].includes(pick)) return false;
  if (["verify", "verify-ca", "verify-full"].includes(pick)) {
    const ssl = { rejectUnauthorized: true };
    if (process.env.DATABASE_CA_CERT) ssl.ca = process.env.DATABASE_CA_CERT;
    return ssl;
  }
  if (["require", "true", "1", "on", "yes", "prefer", "allow", "no-verify"].includes(pick)) return { rejectUnauthorized: false };
  /* auto: plain connection to localhost and to Render's internal host (no dot in the name),
     TLS for any public hostname */
  const host = u.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || !host.includes(".");
  return local ? false : { rejectUnauthorized: false };
}

/* Build node-postgres options from DATABASE_URL (explicit fields, so sslmode in the URL
   cannot silently override our SSL decision). */
function buildPgConfig(raw = process.env.DATABASE_URL) {
  const u = parseUrl(raw);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port ? +u.port : 5432,
    user: dec(u.username) || undefined,
    password: dec(u.password) || undefined,
    database: dec(u.pathname.replace(/^\//, "")) || undefined,
    ssl: resolveSsl(u),
    application_name: u.searchParams.get("application_name") || "alaei-academy"
  };
}

let pool = null;
function getPool() {
  if (pool) return pool;
  pool = new Pool({
    ...buildPgConfig(),
    max: Math.max(1, +process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    keepAlive: true
  });
  /* an error on an idle client must never crash the process */
  pool.on("error", e => console.error("[db] idle client error:", e.message));
  return pool;
}

/* q(sql, params) -> rows. Use $1, $2 ... placeholders. */
const q = (sql, params) => getPool().query(sql, params).then(r => r.rows);

/* tx(async run => { await run(sql, params); ... }) -> commits on success, rolls back on any error */
async function tx(fn) {
  const c = await getPool().connect();
  let broken = false;
  try {
    await c.query("BEGIN");
    const r = await fn((s, p) => c.query(s, p).then(x => x.rows));
    await c.query("COMMIT");
    return r;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { broken = true; }
    if (e instanceof Rollback) return undefined;
    throw e;
  } finally { c.release(broken || undefined); }
}

async function closePool() { if (pool) { const p = pool; pool = null; await p.end(); } }

module.exports = { getPool, q, tx, closePool, Rollback, buildPgConfig, resolveSsl, parseUrl };
