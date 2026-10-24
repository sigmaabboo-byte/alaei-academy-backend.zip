"use strict";
/* Data API in the exact shape the front-end app uses (alaei-academy-v3),
   backed by normalized PostgreSQL tables. */
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { q, tx, Rollback, json, jsonParam, requireAdmin, readToken, uid, clip, int, dt, clientIp, audit } = require("../lib");

const ms = d => (d ? new Date(d).getTime() : Date.now());
let REV = Date.now().toString(36);
const bump = () => (REV = Date.now().toString(36));

async function loadState(full) {
  const [set, pk, vd, fq, st] = await Promise.all([
    q(`SELECT "value" FROM settings WHERE "key"='site'`),
    q("SELECT * FROM packages WHERE active = TRUE ORDER BY sort_order, created_at"),
    q("SELECT * FROM videos ORDER BY sort_order, id"),
    q("SELECT question, answer FROM faqs ORDER BY sort_order, id"),
    q("SELECT package_id, COUNT(*)::int AS n FROM enrollments GROUP BY package_id")
  ]);
  const settings = set[0] ? json(set[0].value) : {};
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
    q("SELECT * FROM students ORDER BY created_at, id"), q("SELECT * FROM enrollments"),
    q("SELECT id, name, role FROM admins WHERE active = TRUE"), q("SELECT * FROM orders ORDER BY created_at DESC, id"),
    q("SELECT * FROM discount_codes ORDER BY created_at, code"), q("SELECT * FROM tickets ORDER BY created_at DESC, id"),
    q("SELECT * FROM ticket_messages ORDER BY created_at, id"), q("SELECT * FROM questions ORDER BY created_at DESC, id"),
    q("SELECT * FROM ip_firewall ORDER BY hits DESC, ip")
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

/* full replace from the admin panel (keeps video URLs the browser stripped).
   Everything runs in ONE transaction: any failure rolls the whole sync back. */
async function saveState(s, admin) {
  const A = (x) => (Array.isArray(x) ? x : []);
  await tx(async run => {
    if (s.settings) {
      const [old] = await run(`SELECT "value" FROM settings WHERE "key"='site'`);
      const prev = old ? json(old.value) : {};
      const next = { ...s.settings }; if (next.introVideo == null && prev.introVideo) next.introVideo = prev.introVideo;
      if (typeof next.introVideo === "string" && next.introVideo.startsWith("data:")) next.introVideo = prev.introVideo || null;
      await run(`INSERT INTO settings ("key","value") VALUES ('site',$1::jsonb) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"`, [jsonParam(next)]);
    }
    if (s.packages) {
      const ids = A(s.packages).map(p => clip(p.id, 32));
      const oldV = await run("SELECT id, src FROM videos");
      const src = Object.fromEntries(oldV.map(v => [v.id, v.src]));
      /* <> ALL(empty array) is true for every row, so an empty list deactivates everything (same as before) */
      await run("UPDATE packages SET active = FALSE WHERE id <> ALL($1::text[])", [ids]);
      let i = 0;
      for (const p of A(s.packages)) {
        const pid = clip(p.id, 32);
        await run(`INSERT INTO packages (id,grade,title,description,price,pay_link,hue,sort_order,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
          ON CONFLICT (id) DO UPDATE SET grade=EXCLUDED.grade, title=EXCLUDED.title, description=EXCLUDED.description, price=EXCLUDED.price,
          pay_link=EXCLUDED.pay_link, hue=EXCLUDED.hue, sort_order=EXCLUDED.sort_order, active=TRUE`,
          [pid, int(p.grade, { min: -32768, max: 32767 }) || 7, clip(p.title, 200), clip(p.desc, 5000), int(p.price, { min: 0 }),
           clip(p.payLink, 500), int(p.hue, { min: -32768, max: 32767 }) || 180, i++]);
        const vids = A(p.videos);
        await run("DELETE FROM videos WHERE package_id=$1 AND id <> ALL($2::text[])", [pid, vids.map(v => clip(v.id, 32))]);
        let j = 0;
        for (const v of vids) {
          const vid = clip(v.id, 32);
          const s2 = typeof v.src === "string" && !v.src.startsWith("data:") && !v.src.startsWith("blob:") ? v.src : src[vid] || null;
          await run(`INSERT INTO videos (id,package_id,title,duration,src,sort_order) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (id) DO UPDATE SET package_id=EXCLUDED.package_id, title=EXCLUDED.title, duration=EXCLUDED.duration, src=EXCLUDED.src, sort_order=EXCLUDED.sort_order`,
            [vid, pid, clip(v.title, 200), int(v.dur, { min: -32768, max: 32767 }), s2 ? clip(s2, 1000) : null, j++]);
        }
      }
    }
    if (s.users) for (const u of A(s.users)) {
      const sid = clip(u.id, 32);
      await run(`INSERT INTO students (id,name,phone,grade,bio,ip) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, grade=EXCLUDED.grade, bio=EXCLUDED.bio`,
        [sid, clip(u.name, 120), clip(u.phone, 20), int(u.grade, { min: -32768, max: 32767 }) || 7, clip(u.bio, 500), clip(u.ip, 45) || null]);
      await run("DELETE FROM enrollments WHERE student_id=$1", [sid]);
      for (const pid of A(u.owned)) await run("INSERT INTO enrollments (student_id,package_id) SELECT $1::varchar, id FROM packages WHERE id=$2 ON CONFLICT DO NOTHING", [sid, clip(pid, 32)]);
    }
    if (s.codes) {
      const codes = A(s.codes).map(c => clip(c.code, 40).toUpperCase());
      await run("DELETE FROM discount_codes WHERE code <> ALL($1::text[])", [codes]);
      for (const c of A(s.codes)) await run(`INSERT INTO discount_codes (code,percent,active,uses,max_uses) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (code) DO UPDATE SET percent=EXCLUDED.percent, active=EXCLUDED.active, uses=EXCLUDED.uses, max_uses=EXCLUDED.max_uses`,
        [clip(c.code, 40).toUpperCase(), int(c.percent, { min: 0, max: 100 }), !!c.active, int(c.uses, { min: 0 }), int(c.max, { min: 0 }) || 100]);
    }
    if (s.orders) for (const o of A(s.orders)) {
      await run(`INSERT INTO orders (id,student_id,package_id,price,code,status,created_at)
        SELECT $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::varchar, $6::order_status, $7::timestamptz
        WHERE EXISTS (SELECT 1 FROM students WHERE id=$8) AND EXISTS (SELECT 1 FROM packages WHERE id=$9)
        ON CONFLICT (id) DO UPDATE SET
          reviewed_by = CASE WHEN orders.status <> EXCLUDED.status THEN $10::varchar ELSE orders.reviewed_by END,
          reviewed_at = CASE WHEN orders.status <> EXCLUDED.status THEN NOW() ELSE orders.reviewed_at END,
          status = EXCLUDED.status`,
        [clip(o.id, 32), clip(o.userId, 32) || null, clip(o.pkgId, 32) || null, int(o.price, { min: 0 }), o.code ? clip(o.code, 40) : null,
         ["pending", "approved", "rejected"].includes(o.status) ? o.status : "pending", dt(o.at),
         clip(o.userId, 32), clip(o.pkgId, 32), admin.sub]);
    }
    if (s.tickets) for (const t of A(s.tickets)) {
      const tid = clip(t.id, 32);
      await run(`INSERT INTO tickets (id,student_id,subject,status)
        SELECT $1::varchar, $2::varchar, $3::varchar, $4::ticket_status WHERE EXISTS (SELECT 1 FROM students WHERE id=$5)
        ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, subject=EXCLUDED.subject`,
        [tid, clip(t.userId, 32) || null, clip(t.subject, 200), t.status === "closed" ? "closed" : "open", clip(t.userId, 32)]);
      const [{ n }] = await run("SELECT COUNT(*)::int AS n FROM ticket_messages WHERE ticket_id=$1", [tid]);
      for (const m of A(t.msgs).slice(n)) await run(`INSERT INTO ticket_messages (ticket_id,sender,body,created_at)
        SELECT $1::varchar, $2::message_sender, $3::text, $4::timestamptz WHERE EXISTS (SELECT 1 FROM tickets WHERE id=$5)`,
        [tid, m.from === "student" ? "student" : "admin", clip(m.text, 5000), dt(m.at), tid]);
    }
    if (s.questions) for (const x of A(s.questions)) {
      await run(`INSERT INTO questions (id,student_id,body,answer,created_at,answered_at)
        SELECT $1::varchar, $2::varchar, $3::text, $4::text, $5::timestamptz, $6::timestamptz WHERE EXISTS (SELECT 1 FROM students WHERE id=$7)
        ON CONFLICT (id) DO UPDATE SET answer=EXCLUDED.answer,
          answered_at = CASE WHEN EXCLUDED.answer IS NULL THEN NULL ELSE COALESCE(questions.answered_at, NOW()) END`,
        [clip(x.id, 32), clip(x.userId, 32) || null, clip(x.text, 5000), x.answer ? clip(x.answer, 10000) : null, dt(x.at), x.answer ? new Date() : null, clip(x.userId, 32)]);
    }
    if (s.faq) {
      await run("DELETE FROM faqs");
      let i = 0; for (const f of A(s.faq)) await run("INSERT INTO faqs (question,answer,sort_order) VALUES ($1,$2,$3)", [clip(f.q, 400), clip(f.a, 5000), i++]);
    }
    if (s.ips) for (const ip of A(s.ips)) await run(`INSERT INTO ip_firewall (ip,who,city,hits,blocked) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (ip) DO UPDATE SET blocked=EXCLUDED.blocked, who=EXCLUDED.who, city=EXCLUDED.city`,
      [clip(ip.ip, 45), clip(ip.who, 120) || "ناشناس", clip(ip.city, 80) || "نامشخص", int(ip.hits, { min: 0 }), !!ip.blocked]);
    if (s.admins && admin.role === "manager") for (const a of A(s.admins)) await run(`INSERT INTO admins (id,name,role) VALUES ($1,$2,$3)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role`,
      [clip(a.id, 32), clip(a.name, 120), ["manager", "admin", "support"].includes(a.role) ? a.role : "admin"]);
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
        await q("INSERT INTO students (id,name,phone,grade,bio,ip) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [clip(d.id, 32) || uid(), clip(d.name, 120) || "دانش‌آموز", clip(d.phone, 20), [7, 8, 9].includes(+d.grade) ? +d.grade : 7, clip(d.bio, 500), ip]);
      } else if (type === "profile" && d.id === uidIn) {
        await q("UPDATE students SET name=$1, grade=$2, bio=$3 WHERE id=$4", [clip(d.name, 120), [7, 8, 9].includes(+d.grade) ? +d.grade : 7, clip(d.bio, 500), uidIn]);
      } else if (type === "order" && d.userId === uidIn) {
        /* one transaction: the discount-code use is only counted if the order row is really created,
           and the "uses < max_uses" check + increment is a single atomic UPDATE (no race between two buyers) */
        await tx(async run => {
          const [p] = await run("SELECT price FROM packages WHERE id=$1 AND active = TRUE", [clip(d.pkgId, 32)]); if (!p) throw new Rollback();
          let price = p.price, code = null;
          if (d.code) {
            const [c] = await run("UPDATE discount_codes SET uses = uses + 1 WHERE code=$1 AND active = TRUE AND uses < max_uses RETURNING code, percent",
              [clip(d.code, 40).toUpperCase()]);
            if (c) { price = Math.max(0, Math.round(price * (100 - Math.min(100, c.percent)) / 100)); code = c.code; }
          }
          const ins = await run(`INSERT INTO orders (id,student_id,package_id,price,code,status)
            SELECT $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::varchar, 'pending'::order_status WHERE EXISTS (SELECT 1 FROM students WHERE id=$6)
            ON CONFLICT DO NOTHING RETURNING id`,
            [clip(d.id, 32) || uid(), uidIn, clip(d.pkgId, 32), price, code, uidIn]);
          if (!ins.length) throw new Rollback();
        });
      } else if (type === "ticket" && d.userId === uidIn) {
        const id = clip(d.id, 32) || uid();
        await tx(async run => {
          await run("INSERT INTO tickets (id,student_id,subject) SELECT $1::varchar, $2::varchar, $3::varchar WHERE EXISTS (SELECT 1 FROM students WHERE id=$4) ON CONFLICT DO NOTHING", [id, uidIn, clip(d.subject, 200), uidIn]);
          for (const m of (Array.isArray(d.msgs) ? d.msgs : []).slice(0, 5)) await run("INSERT INTO ticket_messages (ticket_id,sender,body) SELECT $1::varchar, 'student'::message_sender, $2::text WHERE EXISTS (SELECT 1 FROM tickets WHERE id=$3 AND student_id=$4)", [id, clip(m && m.text, 5000), id, uidIn]);
        });
      } else if (type === "ticket_msg") {
        for (const m of (Array.isArray(d.msgs) ? d.msgs : []).slice(0, 5)) if (m && m.from === "student")
          await q("INSERT INTO ticket_messages (ticket_id,sender,body) SELECT $1::varchar, 'student'::message_sender, $2::text WHERE EXISTS (SELECT 1 FROM tickets WHERE id=$3 AND student_id=$4)", [clip(d.id, 32), clip(m.text, 5000), clip(d.id, 32), uidIn]);
      } else if (type === "question" && d.userId === uidIn) {
        await q("INSERT INTO questions (id,student_id,body) SELECT $1::varchar, $2::varchar, $3::text WHERE EXISTS (SELECT 1 FROM students WHERE id=$4) ON CONFLICT DO NOTHING", [clip(d.id, 32) || uid(), uidIn, clip(d.text, 5000), uidIn]);
      }
    }
    bump(); res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = { router, loadState };
