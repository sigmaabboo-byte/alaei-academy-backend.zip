"use strict";
/* Integration tests against a REAL PostgreSQL database.   Run: TEST_DATABASE_URL=postgresql://... npm run test:db
   Use an empty / throw-away database (e.g. a free Render Postgres or a local docker `postgres:16`), NOT production:
   the tests create (and afterwards delete) their own rows, but they do run database/schema.sql (idempotent). */
const test = require("node:test");
const { before, after } = test;
const assert = require("node:assert/strict");

const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : "set TEST_DATABASE_URL to a throw-away PostgreSQL database to run the DB tests";
if (URL_) {
  process.env.DATABASE_URL = URL_;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-" + "x".repeat(32);
  process.env.APP_SECRET = process.env.APP_SECRET || "test-app-secret-" + "y".repeat(32);
  delete process.env.AI_API_KEY;
}

const T = { skip };
let q, tx, Rollback, closePool, initDb, app, server, base, bcrypt;
const RUN = Date.now().toString(36).slice(-6);        // unique suffix for rows created by this run
const ID = s => `t${RUN}${s}`.slice(0, 32);

async function api(method, path, { token, body, ip = "203.0.113." + (1 + Math.floor(Math.random() * 200)) } = {}) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

before(async () => {
  if (skip) return;
  ({ q, tx, Rollback, closePool } = require("../src/lib"));
  ({ initDb } = require("../scripts/init-db"));
  bcrypt = require("bcryptjs");
  await initDb();
  ({ app } = require("../src/server"));
  await new Promise(r => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  if (skip) return;
  await q("DELETE FROM students WHERE id LIKE $1", [`t${RUN}%`]).catch(() => {});
  await q("DELETE FROM admins WHERE id LIKE $1", [`t${RUN}%`]).catch(() => {});
  await q("DELETE FROM packages WHERE id LIKE $1", [`t${RUN}%`]).catch(() => {});
  await q("DELETE FROM ip_firewall WHERE ip LIKE '203.0.113.%'").catch(() => {});
  await q("DELETE FROM ai_conversations WHERE id LIKE $1", [`t${RUN}%`]).catch(() => {});
  await new Promise(r => server ? server.close(r) : r());
  await closePool();
});

test("connects, UTF-8 database", T, async () => {
  const [v] = await q("SELECT version() AS v, current_setting('server_encoding') AS enc");
  assert.match(v.v, /PostgreSQL/); assert.equal(v.enc, "UTF8");
});

test("schema creation is idempotent and seeds are present", T, async () => {
  await initDb(); await initDb();                                  // run twice: must not fail or duplicate
  const tables = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).map(r => r.table_name);
  for (const t of ["settings", "admins", "students", "packages", "videos", "enrollments", "discount_codes", "orders", "tickets", "ticket_messages",
    "questions", "faqs", "ip_firewall", "ai_settings", "ai_conversations", "ai_messages", "audit_log"]) assert.ok(tables.includes(t), "missing table " + t);
  const n = async t => (await q(`SELECT COUNT(*)::int AS n FROM ${t}`))[0].n;
  assert.ok(await n("admins") >= 6); assert.ok(await n("packages") >= 6); assert.ok(await n("videos") >= 39);
  assert.equal(await n("ai_settings"), 1); assert.ok(await n("faqs") >= 5);
  const [s] = await q(`SELECT "value" FROM settings WHERE "key"='site'`);
  assert.equal(typeof s.value, "object"); assert.equal(s.value.heroAccent, "نه حفظ.");
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM ip_firewall WHERE ip='185.220.101.4' AND blocked"))[0].n, 1);
});

test("Persian text + emoji round trip", T, async () => {
  const name = "نیلوفر ‌احمدی 😊";
  await q("INSERT INTO students (id,name,phone) VALUES ($1,$2,'0900')", [ID("p"), name]);
  assert.equal((await q("SELECT name FROM students WHERE id=$1", [ID("p")]))[0].name, name);
});

test("foreign keys, cascade, enums, CHECK constraints, defaults", T, async () => {
  await assert.rejects(q("INSERT INTO enrollments (student_id,package_id) VALUES ('nope','p7a')"), e => e.code === "23503");
  await q("INSERT INTO students (id,name,phone) VALUES ($1,'x','1')", [ID("fk")]);
  const [st] = await q("SELECT grade, bio, created_at FROM students WHERE id=$1", [ID("fk")]);
  assert.equal(st.grade, 7); assert.equal(st.bio, ""); assert.ok(st.created_at instanceof Date);
  await q("INSERT INTO enrollments (student_id,package_id) VALUES ($1,'p7a')", [ID("fk")]);
  await assert.rejects(q("INSERT INTO orders (id,student_id,package_id,price,status) VALUES ($1,$2,'p7a',1,'bogus')", [ID("o"), ID("fk")]), e => e.code === "22P02");
  await assert.rejects(q("INSERT INTO orders (id,student_id,package_id,price) VALUES ($1,$2,'p7a',-5)", [ID("o"), ID("fk")]), e => e.code === "23514");
  await q("DELETE FROM students WHERE id=$1", [ID("fk")]);
  assert.equal((await q("SELECT COUNT(*)::int n FROM enrollments WHERE student_id=$1", [ID("fk")]))[0].n, 0);
  await assert.rejects(q("INSERT INTO ai_settings (id, config) VALUES (2, '{}')"), e => e.code === "23514");
});

test("updated_at trigger (ON UPDATE CURRENT_TIMESTAMP emulation)", T, async () => {
  await q("INSERT INTO packages (id,grade,title,description) VALUES ($1,7,'a','b')", [ID("pk")]);
  const get = async () => (await q("SELECT updated_at, active, price FROM packages WHERE id=$1", [ID("pk")]))[0];
  const a = await get(); assert.equal(a.active, true); assert.equal(a.price, 0);
  await new Promise(r => setTimeout(r, 20));
  await q("UPDATE packages SET title='a' WHERE id=$1", [ID("pk")]);            // no real change -> untouched
  assert.equal((await get()).updated_at.getTime(), a.updated_at.getTime());
  await q("UPDATE packages SET title='changed' WHERE id=$1", [ID("pk")]);      // real change -> bumped
  assert.ok((await get()).updated_at.getTime() > a.updated_at.getTime());
  await q("DELETE FROM packages WHERE id=$1", [ID("pk")]);
});

test("tx(): commit, rollback, Rollback sentinel", T, async () => {
  await tx(async run => { await run("INSERT INTO students (id,name,phone) VALUES ($1,'c','1')", [ID("tc")]); });
  assert.equal((await q("SELECT COUNT(*)::int n FROM students WHERE id=$1", [ID("tc")]))[0].n, 1);
  await assert.rejects(tx(async run => { await run("INSERT INTO students (id,name,phone) VALUES ($1,'r','1')", [ID("tr")]); throw new Error("boom"); }), /boom/);
  assert.equal((await q("SELECT COUNT(*)::int n FROM students WHERE id=$1", [ID("tr")]))[0].n, 0);
  const r = await tx(async run => { await run("INSERT INTO students (id,name,phone) VALUES ($1,'s','1')", [ID("ts")]); throw new Rollback(); });
  assert.equal(r, undefined);
  assert.equal((await q("SELECT COUNT(*)::int n FROM students WHERE id=$1", [ID("ts")]))[0].n, 0);
});

test("API: health, public state, 404, API-only frontend fallback", T, async () => {
  assert.deepEqual((await api("GET", "/api/health")).json, { ok: true });
  assert.deepEqual((await api("GET", "/api/health/db")).json, { ok: true, db: "up" });
  const s = await api("GET", "/api/state");
  assert.equal(s.status, 200); assert.equal(s.json.state.v, 3);
  assert.ok(s.json.state.packages.length >= 6);
  for (const p of s.json.state.packages) { assert.equal(typeof p.price, "number"); assert.equal(typeof p.students, "number"); for (const v of p.videos) assert.equal(v.src, null); }
  assert.equal(s.json.state.users, undefined);                              // admin-only data must not leak
  assert.equal((await api("GET", "/api/nope")).status, 404);
  assert.equal((await api("GET", "/api/admin/state")).status, 401);
});

test("API: admin login (case-insensitive username), roles, full state round trip", T, async () => {
  await q("INSERT INTO admins (id,name,role,username,password_hash) VALUES ($1,'Test Manager','manager',$2,$3)", [ID("adm"), "TestMgr" + RUN, await bcrypt.hash("correct-horse-battery", 4)]);
  const bad = await api("POST", "/api/auth/admin/login", { body: { username: "TestMgr" + RUN, password: "wrong" } });
  assert.equal(bad.status, 401);
  const ok = await api("POST", "/api/auth/admin/login", { body: { username: ("TestMgr" + RUN).toUpperCase(), password: "correct-horse-battery" } });
  assert.equal(ok.status, 200); assert.equal(ok.json.role, "manager");
  assert.ok((await q("SELECT last_login_at FROM admins WHERE id=$1", [ID("adm")]))[0].last_login_at instanceof Date);
  const token = ok.json.token;

  const FIX = "203.0.113.200";
  const g1 = await api("GET", "/api/admin/state", { token, ip: FIX });
  assert.equal(g1.status, 200);
  const st = g1.json.state;
  for (const k of ["users", "admins", "orders", "codes", "tickets", "questions", "ips"]) assert.ok(Array.isArray(st[k]), k);
  assert.ok(st.packages.some(p => p.videos.some(v => typeof v.id === "string")));

  const put = await api("PUT", "/api/admin/state", { token, ip: FIX, body: { state: JSON.parse(JSON.stringify(st)) } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const g2 = await api("GET", "/api/admin/state", { token, ip: FIX });
  const strip = s => { const c = JSON.parse(JSON.stringify(s)); c.ips = c.ips.map(i => [i.ip, i.blocked]).sort(); return c; };
  assert.deepEqual(strip(g2.json.state), strip(st), "saveState(loadState()) must be a no-op");
  assert.equal((await q("SELECT COUNT(*)::int n FROM audit_log WHERE action='state.sync'"))[0].n >= 1, true);

  /* role limits: the AI-assistant admin routes are manager-only */
  await q("UPDATE admins SET role='support' WHERE id=$1", [ID("adm")]);
  const sup = (await api("POST", "/api/auth/admin/login", { body: { username: "TestMgr" + RUN, password: "correct-horse-battery" } })).json.token;
  assert.equal((await api("GET", "/api/admin/assistant", { token: sup })).status, 403);
  await q("UPDATE admins SET role='manager' WHERE id=$1", [ID("adm")]);
});

test("API: public events (user, order + discount code, ticket, question) and server-side price", T, async () => {
  const uid = ID("stu"), ip = "203.0.113.250";
  const [before] = await q("SELECT uses FROM discount_codes WHERE code='OFF10'");
  const ev = events => api("POST", "/api/public/events", { ip, body: { userId: uid, events } });
  assert.equal((await ev([{ type: "user", data: { id: uid, name: "دانش‌آموز تست", phone: "0912", grade: 8, bio: "hi" } }])).status, 200);
  assert.equal((await q("SELECT grade FROM students WHERE id=$1", [uid]))[0].grade, 8);

  const [pkg] = await q("SELECT id, price FROM packages WHERE id='p7b'");
  const oid = ID("ord");
  await ev([{ type: "order", data: { id: oid, userId: uid, pkgId: pkg.id, code: "off10", price: 1 } }]);   // client price is ignored
  const [o] = await q("SELECT price, code, status FROM orders WHERE id=$1", [oid]);
  assert.equal(o.price, Math.round(pkg.price * 0.9)); assert.equal(o.code, "OFF10"); assert.equal(o.status, "pending");
  assert.equal((await q("SELECT uses FROM discount_codes WHERE code='OFF10'"))[0].uses, before.uses + 1);
  await ev([{ type: "order", data: { id: oid, userId: uid, pkgId: pkg.id, code: "OFF10" } }]);             // replay: no double count
  assert.equal((await q("SELECT uses FROM discount_codes WHERE code='OFF10'"))[0].uses, before.uses + 1);
  await ev([{ type: "order", data: { id: ID("ord2"), userId: "someone-else", pkgId: pkg.id } }]);           // not the caller's id: ignored
  assert.equal((await q("SELECT COUNT(*)::int n FROM orders WHERE id=$1", [ID("ord2")]))[0].n, 0);

  const tid = ID("tk");
  await ev([{ type: "ticket", data: { id: tid, userId: uid, subject: "مشکل", msgs: [{ from: "student", text: "سلام" }] } }]);
  await ev([{ type: "ticket_msg", data: { id: tid, msgs: [{ from: "student", text: "دوباره" }, { from: "admin", text: "ignored" }] } }]);
  assert.equal((await q("SELECT COUNT(*)::int n FROM ticket_messages WHERE ticket_id=$1", [tid]))[0].n, 2);
  await ev([{ type: "question", data: { id: ID("qq"), userId: uid, text: "سؤال؟" } }]);
  assert.equal((await q("SELECT body FROM questions WHERE id=$1", [ID("qq")]))[0].body, "سؤال؟");

  await q("UPDATE discount_codes SET uses=$1 WHERE code='OFF10'", [before.uses]);                          // restore seed state
});

test("API: IP firewall blocks and counts hits", T, async () => {
  const ip = "203.0.113.77";
  await api("GET", "/api/state", { ip });
  assert.ok((await q("SELECT hits FROM ip_firewall WHERE ip=$1", [ip]))[0].hits >= 1);
  await q("UPDATE ip_firewall SET blocked=TRUE WHERE ip=$1", [ip]);
  assert.equal((await api("GET", "/api/state", { ip })).status, 403);
  await q("UPDATE ip_firewall SET blocked=FALSE WHERE ip=$1", [ip]);
  assert.equal((await api("GET", "/api/state", { ip })).status, 200);
});

test("API: AI assistant config (manager), jsonb round trip, logs, no-key behaviour", T, async () => {
  await q("INSERT INTO admins (id,name,role,username,password_hash) VALUES ($1,'AI Mgr','manager',$2,$3)", [ID("ai"), "ai" + RUN, await bcrypt.hash("another-long-password", 4)]);
  const token = (await api("POST", "/api/auth/admin/login", { body: { username: "ai" + RUN, password: "another-long-password" } })).json.token;
  const pub = await api("GET", "/api/assistant/config");
  assert.equal(pub.status, 200); assert.equal(pub.json.mode, "server"); assert.equal(pub.json.apiKey, undefined);
  const cur = (await api("GET", "/api/admin/assistant", { token })).json;
  const upd = await api("PUT", "/api/admin/assistant", { token, body: { name: "نام تست", suggestions: ["الف", "ب"], baseUrl: "https://example.invalid/v1" } });
  assert.equal(upd.status, 200);
  assert.equal((await api("PUT", "/api/admin/assistant", { token, body: { baseUrl: "http://insecure.example" } })).status, 400);
  const after = (await api("GET", "/api/admin/assistant", { token })).json;
  assert.equal(after.name, "نام تست"); assert.deepEqual(after.suggestions, ["الف", "ب"]);
  await api("PUT", "/api/admin/assistant", { token, body: { name: cur.name, suggestions: cur.suggestions, baseUrl: cur.baseUrl } });
  const noKey = !cur.hasKey;
  if (noKey) assert.equal((await api("POST", "/api/assistant/chat", { body: { messages: [{ role: "user", content: "سلام" }], sessionId: ID("s") } })).json.error, "no-key");
  assert.equal((await api("GET", "/api/admin/assistant/logs?limit=5", { token })).status, 200);
  await q("INSERT INTO ai_conversations (id, ip) VALUES ($1,'1.1.1.1')", [ID("conv")]);
  await q("INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user','سلام')", [ID("conv")]);
  const logs = (await api("GET", "/api/admin/assistant/logs?limit=1", { token })).json.items;
  assert.equal(logs.length, 1); assert.ok(logs[0].conversation_id && logs[0].role && logs[0].content);
});
