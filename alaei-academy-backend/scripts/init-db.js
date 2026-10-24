"use strict";
/* usage: npm run db:init   (reads .env, runs database/schema.sql) */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/schema.sql"), "utf8");
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: true, charset: "utf8mb4" });
  await conn.query(sql);
  console.log("✅ database ready");
  await conn.end();
})().catch(e => { console.error("❌", e.message); process.exit(1); });
