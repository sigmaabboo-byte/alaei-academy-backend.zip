"use strict";
/* Data API in the exact shape the front-end app uses (alaei-academy-v3),
   backed by normalized MySQL tables. */
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { q, tx, json, requireAdmin, readToken, uid, clip, clientIp, audit } = require("../lib");

const ms = d => (d ? new Date(d).getTime() : Date.now());
let REV = Date.now().toString(36);
const bump = () => (REV = Date.now().toString(36));

async function loadState(full) {
  const [set, pk, vd, fq] = await Promise.all([
    q("SELECT `value` FROM settings WHERE `key`='site'"),
    q("SELECT * FROM packages WHERE active=1 ORDER BY sort_order, created_at"),
    q("SELECT * FROM videos ORDER BY sort_order"),
    q("SELECT question, answer FROM faqs ORDER BY sort_order, id")
  ]);
  const settings = set[0] ? json(set[0].value) : {};
  const [st] = await q("SELECT COUNT(*) n, package_id FROM enrollments GROUP BY package_id").then(r => [r]);
  const counts = Object.fromEntries(st.map(r => [r.package_id, r.n]));
  const packages = pk.map(p => ({
    id: p.id, grade: p.grade, title: p.title, desc: p.description, price: p.price, payLink: p.pay_link, hue: p.hue,
    students: counts[p.id] || 0,
    videos: vd.filter(v => v.package_id === p.id).map(v => ({ id: v.id, title: v.title, dur: v.duration, src: full ? v.src : null }))
  }));
  const state = { v: 3, settings: full ? settings : { ...settings, introVideo: settings.introVideo || null }, packages,
    faq: fq.map(f => ({ q: f.question, a: f.answer })) };
  if (!full) return state;

  const [users, enr, admins, orders, codes, tickets, msgs, questions, ips] = await Promise.all([
    q("SELECT * FROM students ORDER BY created_at"), q("SELECT * FROM enrollments"),
    q("SELECT id, name, role FROM admins WHERE active=1"), q("SELECT * FROM orders ORDER BY created_at DESC"),
    q("SELECT * FROM discount_codes"), q("SELECT * FROM tickets ORDER BY created_at DESC"),
    q("SELECT * FROM ticket_messages ORDER BY created_at"), q("SELECT * FROM questions ORDER BY created_at DESC"),
    q("SELECT * FROM ip_firewall ORDER BY hits DESC")
  ]);
  return Object.assign(state, {
    users: users.map(u => ({ id: u.id, name: u.name, phone: u.phone, grade: u.grade, bio: u.bio, ip: u.ip,
      owned: enr.filter(e => e.student_id === u.id).map(e => e.package_id) })),
    admins,
    orders: orders.map(o => ({ id: o.id, userId: o.student_id, pkgId: o.package_id, price: o.price, code: o.code, status: o.status, at: ms(o.created_at) })),
    codes: codes.map(c => ({ code: c.code, percent: c.percent, active: !!c.active, uses: c.uses, max: c.max_uses })),
    tickets: tickets.map(t => ({ id: t.id, userId: t.student_id, subject: t.subject, status: t.status,
      msgs: msgs.filter(m => m.ticket_id === t.id).map(m => ({ from: m.sender, text: m.body, at: ms(m.created_at) })) })),
    questions: questions.map(x => ({ id: x.id, userId: x.student_id, text: x.body, answer: x.answer, at: ms(x.created_at) })),
    ips: ips.map(i => ({ ip: i.ip, who: i.who, city: i.city, hits: i.hits, blocked: !!i.blocked }))
  });
}

/* full replace from the admin panel (keeps video URLs the browser stripped) */
async function saveState(s, admin) {
  const A = (x) => (Array.isArray(x) ? x : []);
  await tx(async run => {
    if (s.settings) {
      const [old] = await run("SELECT `value` FROM settings WHERE `key`='site'");
      const prev = old ? json(old.value) : {};
      const next = { ...s.settings }; if (next.introVideo == null && prev.introVideo) next.introVideo = prev.introVideo;
      if (typeof next.introVideo === "string" && next.introVideo.startsWith("data:")) next.introVideo = prev.introVideo || null;
      await run("INSERT INTO settings (`key`,`value`) VALUES ('site',?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`)", [JSON.stringify(next)]);
    }
    if (s.packages) {
      const ids = A(s.packages).map(p => clip(p.id, 32));
      const oldV = await run("SELECT id, src FROM videos");
      const src = Object.fromEntries(oldV.map(v => [v.id, v.src]));
      await run(ids.length ? "UPDATE packages SET active=0 WHERE id NOT IN (?)" : "UPDATE packages SET active=0", [ids]);
      let i = 0;
      for (const p of A(s.packages)) {
        await run(`INSERT INTO packages (id,grade,title,description,price,pay_link,hue,sort_order,active) VALUES (?,?,?,?,?,?,?,?,1)
          ON DUPLICATE KEY UPDATE grade=VALUES(grade),title=VALUES(title),description=VALUES(description),price=VALUES(price),
          pay_link=VALUES(pay_link),hue=VALUES(hue),sort_order=VALUES(sort_order),active=1`,
          [clip(p.id, 32), +p.grade || 7, clip(p.title, 200), clip(p.desc, 5000), Math.max(0, +p.price || 0), clip(p.payLink, 500), +p.hue || 180, i++]);
        const vids = A(p.videos);
        await run(vids.length ? "DELETE FROM videos WHERE package_id=? AND id NOT IN (?)" : "DELETE FROM videos WHERE package_id=?", [p.id, vids.map(v => v.id)]);
        let j = 0;
        for (const v of vids) {
          let s2 = typeof v.src === "string" && !v.src.startsWith("data:") && !v.src.startsWith("blob:") ? v.src : src[v.id] || null;
          await run(`INSERT INTO videos (id,package_id,title,duration,src,sort_order) VALUES (?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE package_id=VALUES(package_id),title=VALUES(title),duration=VALUES(duration),src=VALUES(src),sort_order=VALUES(sort_order)`,
            [clip(v.id, 32), p.id, clip(v.title, 200), +v.dur || 0, s2 ? clip(s2, 1000) : null, j++]);
        }
      }
    }
    if (s.users) for (const u of A(s.users)) {
      await run(`INSERT INTO students (id,name,phone,grade,bio,ip) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),phone=VALUES(phone),grade=VALUES(grade),bio=VALUES(bio)`,
        [clip(u.id, 32), clip(u.name, 120), clip(u.phone, 20), +u.grade || 7, clip(u.bio, 500), clip(u.ip, 45) || null]);
      await run("DELETE FROM enrollments WHERE student_id=?", [u.id]);
      for (const pid of A(u.owned)) await run("INSERT IGNORE INTO enrollments (student_id,package_id) SELECT ?,id FROM packages WHERE id=?", [u.id, pid]);
    }
    if (s.codes) {
      const codes = A(s.codes).map(c => clip(c.code, 40).toUpperCase());
      await run(codes.length ? "DELETE FROM discount_codes WHERE code NOT IN (?)" : "DELETE FROM discount_codes", [codes]);
      for (const c of A(s.codes)) await run(`INSERT INTO discount_codes (code,percent,active,uses,max_uses) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE percent=VALUES(percent),active=VALUES(active),uses=VALUES(uses),max_uses=VALUES(max_uses)`,
        [clip(c.code, 40).toUpperCase(), Math.min(100, Math.max(0, +c.percent || 0)), c.active ? 1 : 0, +c.uses || 0, +c.max || 100]);
    }
    if (s.orders) for (const o of A(s.orders)) {
      await run(`INSERT INTO orders (id,student_id,package_id,price,code,status,created_at) SELECT ?,?,?,?,?,?,? FROM DUAL
        WHERE EXISTS (SELECT 1 FROM students WHERE id=?) AND EXISTS (SELECT 1 FROM packages WHERE id=?)
        ON DUPLICATE KEY UPDATE reviewed_by=IF(status<>VALUES(status),?,reviewed_by), reviewed_at=IF(status<>VALUES(status),NOW(),reviewed_at), status=VALUES(status)`,
        [clip(o.id, 32), o.userId, o.pkgId, +o.price || 0, o.code || null, ["pending", "approved", "rejected"].includes(o.status) ? o.status : "pending",
         new Date(o.at || Date.now()), o.userId, o.pkgId, admin.sub]);
    }
    if (s.tickets) for (const t of A(s.tickets)) {
      await run(`INSERT INTO tickets (id,student_id,subject,status) SELECT ?,?,?,? FROM DUAL WHERE EXISTS (SELECT 1 FROM students WHERE id=?)
        ON DUPLICATE KEY UPDATE status=VALUES(status), subject=VALUES(subject)`, [clip(t.id, 32), t.userId, clip(t.subject, 200), t.status === "closed" ? "closed" : "open", t.userId]);
      const [{ n }] = await run("SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id=?", [t.id]);
      for (const m of A(t.msgs).slice(n)) await run("INSERT INTO ticket_messages (ticket_id,sender,body,created_at) SELECT ?,?,?,? FROM DUAL WHERE EXISTS (SELECT 1 FROM tickets WHERE id=?)",
        [t.id, m.from === "student" ? "student" : "admin", clip(m.text, 5000), new Date(m.at || Date.now()), t.id]);
    }
    if (s.questions) for (const x of A(s.questions)) {
      await run(`INSERT INTO questions (id,student_id,body,answer,created_at,answered_at) SELECT ?,?,?,?,?,? FROM DUAL WHERE EXISTS (SELECT 1 FROM students WHERE id=?)
        ON DUPLICATE KEY UPDATE answer=VALUES(answer), answered_at=IF(answer IS NULL, NULL, COALESCE(answered_at, NOW()))`,
        [clip(x.id, 32), x.userId, clip(x.text, 5000), x.answer ? clip(x.answer, 10000) : null, new Date(x.at || Date.now()), x.answer ? new Date() : null, x.userId]);
    }
    if (s.faq) {
      await run("DELETE FROM faqs");
      let i = 0; for (const f of A(s.faq)) await run("INSERT INTO faqs (question,answer,sort_order) VALUES (?,?,?)", [clip(f.q, 400), clip(f.a, 5000), i++]);
    }
    if (s.ips) for (const ip of A(s.ips)) await run(`INSERT INTO ip_firewall (ip,who,city,hits,blocked) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE blocked=VALUES(blocked), who=VALUES(who), city=VALUES(city)`, [clip(ip.ip, 45), clip(ip.who, 120) || "ناشناس", clip(ip.city, 80) || "نامشخص", +ip.hits || 0, ip.blocked ? 1 : 0]);
    if (s.admins && admin.role === "manager") for (const a of A(s.admins)) await run(`INSERT INTO admins (id,name,role) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role)`, [clip(a.id, 32), clip(a.name, 120), ["manager", "admin", "support"].includes(a.role) ? a.role : "admin"]);
  });
  return bump();
}

/* -------- routes -------- */
router.get("/state", async (req, res, next) => {
  try {
    const t = readToken(req);
    res.set("Cache-Control", t ? "no-store" : "public, max-age=15");
    res.json({ rev: REV, state: await loadState(!!t) });
  } catch (e) { next(e); }
});

router.get("/admin/state", requireAdmin(), async (req, res, next) => {
  try { res.json({ rev: REV, state: await loadState(true) }); } catch (e) { next(e); }
});

router.put("/admin/state", requireAdmin("manager", "admin", "support"), async (req, res, next) => {
  try {
    const s = req.body && req.body.state; if (!s || typeof s !== "object") return res.status(400).json({ error: "state" });
    if (req.admin.role === "support") { const { tickets } = s; await saveState({ tickets }, req.admin); }
    else if (req.admin.role === "admin") { delete s.settings; delete s.admins; delete s.ips; await saveState(s, req.admin); }
    else await saveState(s, req.admin);
    audit(req, "state.sync", { keys: Object.keys(s) });
    res.json({ ok: true, rev: REV });
  } catch (e) { next(e); }
});

/* students: only create their own items; prices are re-computed on the server */
const evLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
router.post("/public/events", evLimit, async (req, res, next) => {
  try {
    const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 10) : [];
    const uidIn = clip(req.body.userId, 32);
    const ip = clientIp(req);
    for (const { type, data: d = {} } of events) {
      if (type === "user") {
        await q("INSERT IGNORE INTO students (id,name,phone,grade,bio,ip) VALUES (?,?,?,?,?,?)",
          [clip(d.id, 32) || uid(), clip(d.name, 120) || "دانش‌آموز", clip(d.phone, 20), [7, 8, 9].includes(+d.grade) ? +d.grade : 7, clip(d.bio, 500), ip]);
      } else if (type === "profile" && d.id === uidIn) {
        await q("UPDATE students SET name=?, grade=?, bio=? WHERE id=?", [clip(d.name, 120), [7, 8, 9].includes(+d.grade) ? +d.grade : 7, clip(d.bio, 500), uidIn]);
      } else if (type === "order" && d.userId === uidIn) {
        const [p] = await q("SELECT price FROM packages WHERE id=? AND active=1", [d.pkgId]); if (!p) continue;
        let price = p.price, code = null;
        if (d.code) {
          const [c] = await q("SELECT * FROM discount_codes WHERE code=? AND active=1 AND uses < max_uses", [clip(d.code, 40).toUpperCase()]);
          if (c) { price = Math.round(price * (100 - c.percent) / 100); code = c.code; await q("UPDATE discount_codes SET uses=uses+1 WHERE code=?", [c.code]); }
        }
        await q(`INSERT IGNORE INTO orders (id,student_id,package_id,price,code,status) SELECT ?,?,?,?,?,'pending' FROM DUAL WHERE EXISTS (SELECT 1 FROM students WHERE id=?)`,
          [clip(d.id, 32) || uid(), uidIn, d.pkgId, price, code, uidIn]);
      } else if (type === "ticket" && d.userId === uidIn) {
        const id = clip(d.id, 32) || uid();
        await q("INSERT IGNORE INTO tickets (id,student_id,subject) SELECT ?,?,? FROM DUAL WHERE EXISTS (SELECT 1 FROM students WHERE id=?)", [id, uidIn, clip(d.subject, 200), uidIn]);
        for (const m of (d.msgs || []).slice(0, 5)) await q("INSERT INTO ticket_messages (ticket_id,sender,body) SELECT ?,'student',? FROM DUAL WHERE EXISTS (SELECT 1 FROM tickets WHERE id=? AND student_id=?)", [id, clip(m.text, 5000), id, uidIn]);
      } else if (type === "ticket_msg") {
        for (const m of (d.msgs || []).slice(0, 5)) if (m.from === "student")
          await q("INSERT INTO ticket_messages (ticket_id,sender,body) SELECT ?,'student',? FROM DUAL WHERE EXISTS (SELECT 1 FROM tickets WHERE id=? AND student_id=?)", [d.id, clip(m.text, 5000), d.id, uidIn]);
      } else if (type === "question" && d.userId === uidIn) {
        await q("INSERT IGNORE INTO questions (id,student_id,body) SELECT ?,?,? FROM DUAL WHERE EXISTS (SELECT 1 FROM students WHERE id=?)", [clip(d.id, 32) || uid(), uidIn, clip(d.text, 5000), uidIn]);
      }
    }
    bump(); res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = { router, loadState };
