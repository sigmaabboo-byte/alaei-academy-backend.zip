"use strict";
/* usage: npm run db:init
   Reads DATABASE_URL (from .env or the real environment) and runs database/schema.sql against it.
   The schema file is idempotent (CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING) and runs inside one
   transaction, so a failure leaves the database exactly as it was. */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { buildPgConfig } = require("../src/db");

const SCHEMA = path.join(__dirname, "../database/schema.sql");

async function initDb() {
  const sql = fs.readFileSync(SCHEMA, "utf8");
  const client = new Client({ ...buildPgConfig(), connectionTimeoutMillis: 15_000 });
  client.on("error", e => console.error("[db] connection error:", e.message));
  await client.connect();
  try {
    /* simple-query protocol: multi-statement script, BEGIN ... COMMIT is inside the file */
    await client.query(sql);
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
    return rows[0].n;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  initDb()
    .then(n => { console.log(`✅ database ready (${n} tables in the current schema)`); process.exit(0); })
    .catch(e => { console.error("❌", e.message); process.exit(1); });
}
module.exports = { initDb };
