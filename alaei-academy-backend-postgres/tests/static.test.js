"use strict";
/* Static checks: need NO database and no network.  Run: npm run test:static
   1) no MySQL-only syntax is left in code or schema
   2) every SQL string in the code uses $1..$n placeholders (no "?")
   3) schema.sql has the expected tables, FKs, indexes and no duplicate index names (PostgreSQL index names are schema-wide)
   4) DATABASE_URL / SSL parsing */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const codeFiles = ["src", "scripts"].flatMap(walk).filter(f => f.endsWith(".js"));

test("package.json uses pg and not mysql2", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.dependencies.pg, "pg missing");
  assert.equal(pkg.dependencies.mysql2, undefined);
});

test("no MySQL leftovers in code", () => {
  const bad = [/mysql2|require\(["']mysql/i, /ON DUPLICATE KEY/i, /INSERT IGNORE/i, /FROM DUAL/i, /\bIFNULL\(/i, /VALUES\(\s*\w+\s*\)/i,
    /DB_HOST|DB_USER|DB_PASSWORD|DB_NAME/, /beginTransaction|getConnection/, /\.query\([^)]*\)\.then\(\(\[/];
  for (const f of codeFiles) {
    const src = read(f);
    for (const re of bad) assert.doesNotMatch(src, re, `${f} matches ${re}`);
  }
});

test("no '?' placeholders and no backtick-quoted identifiers inside SQL strings", () => {
  for (const f of codeFiles) {
    const src = read(f);
    /* every q("...") / run("...") / query("...") first argument that looks like SQL */
    const re = /\b(?:q|run|query)\(\s*(["`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(src))) {
      const sql = m[2];
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(sql)) continue;
      assert.doesNotMatch(sql.replace(/'[^']*'/g, ""), /\?/, `${f}: '?' placeholder in: ${sql.slice(0, 80)}`);
      assert.doesNotMatch(sql, /\u0060/, `${f}: backtick in SQL`);
      const nums = [...sql.matchAll(/\$(\d+)/g)].map(x => +x[1]);
      if (nums.length) {
        const max = Math.max(...nums);
        for (let i = 1; i <= max; i++) assert.ok(nums.includes(i), `${f}: placeholder $${i} missing (gap) in: ${sql.slice(0, 80)}`);
      }
    }
  }
});

test("schema.sql is PostgreSQL (no MySQL syntax)", () => {
  const sql = read("database/schema.sql").split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
  for (const re of [/ENGINE\s*=/i, /AUTO_INCREMENT/i, /\bUNSIGNED\b/i, /\bTINYINT\b/i, /INSERT IGNORE/i, /JSON_OBJECT|JSON_ARRAY/i,
    /ON DUPLICATE KEY/i, /ON UPDATE CURRENT_TIMESTAMP/i, /\bUSE\s+\w+;/i, /CREATE DATABASE/i, /SET NAMES/i, /FOREIGN_KEY_CHECKS/i, /\u0060/, /INTERVAL \d+ (MINUTE|HOUR|DAY)\b/i])
    assert.doesNotMatch(sql, re, `schema.sql matches ${re}`);
  assert.match(sql, /^\s*BEGIN;/m); assert.match(sql, /^\s*COMMIT;/m);
});

test("schema.sql: tables, foreign keys and index names", () => {
  const sql = read("database/schema.sql");
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  const expected = ["settings", "admins", "students", "packages", "videos", "enrollments", "discount_codes", "orders", "tickets",
    "ticket_messages", "questions", "faqs", "ip_firewall", "ai_settings", "ai_conversations", "ai_messages", "audit_log"];
  assert.deepEqual([...tables].sort(), [...expected].sort());
  assert.equal((sql.match(/REFERENCES \w+\(id\) ON DELETE CASCADE/g) || []).length, 9, "9 cascading foreign keys expected (same as the MySQL schema)");
  const idx = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.equal(new Set(idx).size, idx.length, "duplicate index names (PostgreSQL index names are global per schema)");
  for (const i of ["idx_students_phone", "idx_students_grade", "idx_packages_grade", "idx_videos_pkg", "idx_orders_status", "idx_tickets_status",
    "idx_ticket_messages_ticket", "idx_ip_firewall_blocked", "idx_ai_messages_conv", "idx_ai_messages_created", "idx_audit_log_created", "uq_admins_username"])
    assert.ok(idx.includes(i), "missing index " + i);
  for (const t of ["settings", "packages", "ai_settings", "ai_conversations"]) assert.match(sql, new RegExp(`trg_${t}_updated_at`));
  assert.match(sql, /trg_ip_firewall_last_seen/);
});

test("every table written by the code exists in the schema", () => {
  const schema = read("database/schema.sql");
  const tables = new Set([...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]));
  for (const f of codeFiles) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)\b/g)) {
      const t = m[1];
      if (["dual", "set", "select"].includes(t) || !/^[a-z_]+$/.test(t)) continue;
      if (!tables.has(t) && /^(settings|admins|students|packages|videos|enrollments|discount|orders|tickets|ticket|questions|faqs|ip_|ai_|audit)/.test(t))
        assert.fail(`${f}: unknown table ${t}`);
    }
  }
});

test("DATABASE_URL parsing and SSL decision", () => {
  const { buildPgConfig } = require("../src/db");
  const save = { ...process.env };
  try {
    delete process.env.DATABASE_SSL; delete process.env.DATABASE_CA_CERT;
    let c = buildPgConfig("postgresql://u1:p%40ss%2Fw@dpg-abc123-a:5432/mydb");           // Render internal host
    assert.deepEqual([c.host, c.port, c.user, c.password, c.database, c.ssl], ["dpg-abc123-a", 5432, "u1", "p@ss/w", "mydb", false]);
    c = buildPgConfig("postgres://u:p@dpg-abc123-a.frankfurt-postgres.render.com/mydb"); // external host
    assert.equal(c.port, 5432); assert.deepEqual(c.ssl, { rejectUnauthorized: false });
    c = buildPgConfig("postgres://u:p@localhost:5433/x"); assert.equal(c.ssl, false); assert.equal(c.port, 5433);
    c = buildPgConfig("postgres://u:p@db.example.com/x?sslmode=disable"); assert.equal(c.ssl, false);
    c = buildPgConfig("postgres://u:p@db.example.com/x?sslmode=verify-full"); assert.deepEqual(c.ssl, { rejectUnauthorized: true });
    process.env.DATABASE_SSL = "require";
    c = buildPgConfig("postgres://u:p@localhost/x"); assert.deepEqual(c.ssl, { rejectUnauthorized: false });
    process.env.DATABASE_SSL = "verify"; process.env.DATABASE_CA_CERT = "PEMTEXT";
    c = buildPgConfig("postgres://u:p@h.example.com/x"); assert.deepEqual(c.ssl, { rejectUnauthorized: true, ca: "PEMTEXT" });
    assert.throws(() => buildPgConfig(""), /DATABASE_URL is not set/);
    assert.throws(() => buildPgConfig("mysql://u:p@h/x"), /postgres/);
    assert.throws(() => buildPgConfig("not a url"), /not a valid URL/);
  } finally { for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k]; Object.assign(process.env, save); }
});

test("no real secrets committed", () => {
  const env = read(".env.example");
  assert.match(env, /^JWT_SECRET=\s*$/m); assert.match(env, /^APP_SECRET=\s*$/m);
  assert.match(env, /postgresql:\/\/USER:PASSWORD@HOST/);
  for (const f of [...codeFiles, "README.md", "render.yaml"]) assert.doesNotMatch(read(f), /postgres(ql)?:\/\/[^\s:@\/]+:(?!PASSWORD\b|\$|%|<)[^\s@\/]+@/, `${f} contains a connection string with a password`);
});
