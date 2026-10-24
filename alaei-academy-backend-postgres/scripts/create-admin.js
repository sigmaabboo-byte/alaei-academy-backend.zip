"use strict";
/* usage: npm run create-admin -- <adminId> <username> <password>
   e.g.   npm run create-admin -- m0 manager "a-strong-password"
   The password may also be given through the ADMIN_PASSWORD environment variable
   (keeps it out of shell history / process list). Run `npm run db:init` first. */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { q, closePool } = require("../src/db");

(async () => {
  const [id, username, argPassword] = process.argv.slice(2);
  const password = argPassword || process.env.ADMIN_PASSWORD;
  if (!id || !username || !password || password.length < 10) {
    console.log("usage: npm run create-admin -- <adminId> <username> <password (min 10 chars)>");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const rows = await q("UPDATE admins SET username=$1, password_hash=$2 WHERE id=$3 RETURNING id",
      [username.slice(0, 64), hash, id]);
    if (!rows.length) {
      console.error(`❌ no admin with id "${id}" (did you run "npm run db:init"? seeded ids: m0, a1..a5)`);
      process.exitCode = 1;
    } else console.log("✅ password set for", id, "/", username);
  } catch (e) {
    if (e.code === "23505") { console.error(`❌ username "${username}" is already used by another admin (usernames are case-insensitive)`); process.exitCode = 1; }
    else throw e;
  }
  await closePool();
})().catch(e => { console.error("❌", e.message); process.exit(1); });
