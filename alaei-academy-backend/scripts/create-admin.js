"use strict";
/* usage: npm run create-admin -- <adminId> <username> <password>
   e.g.   npm run create-admin -- m0 manager "a-strong-password"            */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { q } = require("../src/lib");
(async () => {
  const [id, username, password] = process.argv.slice(2);
  if (!id || !username || !password || password.length < 10) {
    console.log("usage: npm run create-admin -- <adminId> <username> <password (min 10 chars)>");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  await q("UPDATE admins SET username=?, password_hash=? WHERE id=?", [username, hash, id]);
  console.log("✅ password set for", id, "/", username);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
