/**
 * routes/study.js  —  mounted at /api/study
 *
 * Study tab backend: subjects, daily target, to-do, focus timer (live presence),
 * stats, global room, study groups (admin / co-admin / member roles) and chat.
 *
 * Auth: every route requires a valid Telegram Mini App `x-tg-init-data` header
 * (HMAC-verified with BOT_TOKEN). The user id ALWAYS comes from that header,
 * never from the request body/URL.
 *
 * Live timers are kept in memory (single Node process). A finished timer is
 * written to MongoDB as a StudySession, which stats/leaderboards read from.
 */
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const {
  StudyProfile, StudySubject, StudyTask, StudySession, StudyGroup, StudyMessage,
} = require("../models/Study");

const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const AUTH_MAX_AGE_SEC = 3 * 24 * 60 * 60;   // Mini App initData freshness window

// ── Limits ──────────────────────────────────────────────────────────────────
const MAX_SUBJECTS = 20;
const MAX_TASKS_PER_DAY = 50;
const MAX_GROUPS_PER_USER = 10;
const MAX_GROUP_MEMBERS = 200;
const MAX_COADMINS = 3;
const MAX_SESSION_SEC = 12 * 60 * 60;        // one session can never exceed 12h
const BEAT_GAP_CAP_MS = 90 * 1000;           // count at most 90s per heartbeat
const STALE_AFTER_MS = 120 * 1000;           // no heartbeat for 2 min => timer ended
const MIN_SAVE_SEC = 30;                     // ignore sessions shorter than this
const SUBJECT_COLORS = ["#FFB38A", "#7FD1A8", "#A79BE8", "#7DB8E8", "#F2B544", "#E88FB4"];

// ── Bot (for invite links) ──────────────────────────────────────────────────
let _bot = null;
let _botUsername = process.env.BOT_USERNAME || "";
function setBot(bot) {
  _bot = bot;
  if (!_botUsername && bot && typeof bot.getMe === "function") {
    bot.getMe().then((me) => { _botUsername = me.username || ""; }).catch(() => {});
  }
}
const inviteLinkFor = (code) => (_botUsername ? `https://t.me/${_botUsername}?start=grp_${code}` : "");

// ── Auth ────────────────────────────────────────────────────────────────────
function verifyInitData(raw) {
  if (!raw || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(String(raw));
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const check = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(check).digest("hex");
    const a = Buffer.from(expected), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const authDate = Number(params.get("auth_date") || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!authDate || authDate < now - AUTH_MAX_AGE_SEC || authDate > now + 300) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user && user.id ? user : null;
  } catch (_) { return null; }
}
function auth(req, res, next) {
  const u = verifyInitData(req.headers["x-tg-init-data"]);
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  req.uid = String(u.id);
  req.tgName = String(u.first_name || u.username || "Student").slice(0, 30);
  next();
}
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[study]", req.method, req.path, e && e.message);
  if (!res.headersSent) res.status(500).json({ error: "Server error" });
});
const isId = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

// ── Time helpers (study days are IST days) ──────────────────────────────────
const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const dayKey = (d) => IST.format(d || new Date());
const addDays = (day, n) => dayKey(new Date(Date.parse(day + "T12:00:00+05:30") + n * 86400000));
const dow = (day) => (new Date(Date.parse(day + "T12:00:00+05:30")).getUTCDay() + 6) % 7; // Mon=0
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// ── Tiny TTL cache (leaderboards) ───────────────────────────────────────────
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  _cache.set(key, { exp: Date.now() + ttlMs, val });
  if (_cache.size > 500) for (const [k, v] of _cache) if (v.exp < Date.now()) _cache.delete(k);
  return val;
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE PRESENCE (in memory)
// ═══════════════════════════════════════════════════════════════════════════
/** userId -> { userId,name,anonymous,subjectId,subjectName,subjectColor,taskId,mode,
 *              startedAt,status,lastBeat,focusSec } */
const live = new Map();

async function finalizePresence(p) {
  live.delete(p.userId);
  const sec = Math.min(Math.floor(p.focusSec), MAX_SESSION_SEC);
  if (sec < MIN_SAVE_SEC) return null;
  const ended = new Date(Math.min(p.lastBeat, Date.now()));
  const doc = await StudySession.create({
    userId: p.userId, day: dayKey(new Date(p.startedAt)),
    subjectId: p.subjectId || null, subjectName: p.subjectName || "", subjectColor: p.subjectColor || "#B8B2A3",
    taskId: p.taskId || null, mode: p.mode,
    startedAt: new Date(p.startedAt), endedAt: ended, durationSec: sec,
  });
  _cache.clear();
  return doc;
}
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const p of live.values()) {
    if (now - p.lastBeat > STALE_AFTER_MS) finalizePresence(p).catch((e) => console.error("[study] sweep", e.message));
  }
}, 30 * 1000);
if (sweeper.unref) sweeper.unref();

// Focus seconds of the user's *running* session (0 if none)
const liveSecOf = (uid) => { const p = live.get(uid); return p ? Math.floor(p.focusSec) : 0; };

// ═══════════════════════════════════════════════════════════════════════════
// SHARED QUERIES
// ═══════════════════════════════════════════════════════════════════════════
async function ensureProfile(uid, name) {
  return StudyProfile.findOneAndUpdate(
    { userId: uid },
    { $set: { name } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}
async function profilesMap(ids) {
  const rows = await StudyProfile.find({ userId: { $in: ids } }).select("userId name anonymous").lean();
  return new Map(rows.map((r) => [r.userId, r]));
}
const realName = (prof) => (prof && prof.name) || "Student";
// Global Room only: people who turned on "anonymous" are masked. Inside groups real names are shown.
const shownName = (prof) => (prof && prof.anonymous ? "Anonymous" : realName(prof));

/** Seconds studied on `day` per user (finished sessions + running timer if today). */
async function secByUser(day, userIds) {
  const match = { day };
  if (userIds) match.userId = { $in: userIds };
  const rows = await StudySession.aggregate([
    { $match: match }, { $group: { _id: "$userId", sec: { $sum: "$durationSec" } } },
  ]);
  const map = new Map(rows.map((r) => [r._id, r.sec]));
  if (day === dayKey()) {
    for (const p of live.values()) {
      if (userIds && !userIds.includes(p.userId)) continue;
      map.set(p.userId, (map.get(p.userId) || 0) + Math.floor(p.focusSec));
    }
  }
  return map;
}

/** Per-subject breakdown for one user on one day. */
async function daySummary(uid, day) {
  const rows = await StudySession.aggregate([
    { $match: { userId: uid, day } },
    { $group: { _id: { id: "$subjectId", name: "$subjectName", color: "$subjectColor" }, sec: { $sum: "$durationSec" } } },
  ]);
  const by = rows.map((r) => ({ subjectId: r._id.id ? String(r._id.id) : null, name: r._id.name || "No subject", color: r._id.color, sec: r.sec }));
  const p = live.get(uid);
  if (p && day === dayKey()) {
    const sid = p.subjectId ? String(p.subjectId) : null;
    const hit = by.find((x) => x.subjectId === sid);
    if (hit) hit.sec += Math.floor(p.focusSec);
    else by.push({ subjectId: sid, name: p.subjectName || "No subject", color: p.subjectColor, sec: Math.floor(p.focusSec) });
  }
  by.sort((a, b) => b.sec - a.sec);
  return { totalSec: by.reduce((s, x) => s + x.sec, 0), bySubject: by };
}

async function streakOf(uid) {
  const today = dayKey();
  const from = addDays(today, -60);
  const rows = await StudySession.aggregate([
    { $match: { userId: uid, day: { $gte: from } } }, { $group: { _id: "$day", sec: { $sum: "$durationSec" } } },
  ]);
  const ok = new Set(rows.filter((r) => r.sec >= 600).map((r) => r._id));   // ≥10 min counts
  if (liveSecOf(uid) >= 600) ok.add(today);
  let d = ok.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (ok.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

const presenceView = (p) => ({
  status: p.status, mode: p.mode, startedAt: p.startedAt, focusSec: Math.floor(p.focusSec),
  subjectId: p.subjectId ? String(p.subjectId) : null, subjectName: p.subjectName, subjectColor: p.subjectColor,
  taskId: p.taskId ? String(p.taskId) : null,
});

// ═══════════════════════════════════════════════════════════════════════════
// ME / PROFILE
// ═══════════════════════════════════════════════════════════════════════════
router.get("/me", auth, wrap(async (req, res) => {
  const today = dayKey();
  const profile = await ensureProfile(req.uid, req.tgName);
  const [subjects, tasks, summary, streak] = await Promise.all([
    StudySubject.find({ userId: req.uid, archived: false }).sort({ createdAt: 1 }).lean(),
    loadTasks(req.uid, today),
    daySummary(req.uid, today),
    streakOf(req.uid),
  ]);
  const p = live.get(req.uid);
  res.json({
    serverNow: Date.now(), today,
    profile: { dailyTargetMin: profile.dailyTargetMin, anonymous: !!profile.anonymous, pomodoro: profile.pomodoro },
    subjects: subjects.map(subjectView), tasks, summary, streak,
    timer: p ? presenceView(p) : null,
  });
}));

router.put("/profile", auth, wrap(async (req, res) => {
  const b = req.body || {}, set = {};
  if (b.dailyTargetMin !== undefined) {
    const n = Math.round(Number(b.dailyTargetMin));
    if (!(n >= 10 && n <= 1440)) return bad(res, "Target must be 10–1440 minutes");
    set.dailyTargetMin = n;
  }
  if (b.anonymous !== undefined) set.anonymous = !!b.anonymous;
  if (b.pomodoro && typeof b.pomodoro === "object") {
    const lim = { focus: [1, 180], shortBreak: [1, 60], longBreak: [1, 90], rounds: [1, 12] };
    for (const k of Object.keys(lim)) {
      if (b.pomodoro[k] === undefined) continue;
      const n = Math.round(Number(b.pomodoro[k]));
      if (!(n >= lim[k][0] && n <= lim[k][1])) return bad(res, `Invalid pomodoro.${k}`);
      set[`pomodoro.${k}`] = n;
    }
  }
  const prof = await StudyProfile.findOneAndUpdate({ userId: req.uid }, { $set: { ...set, name: req.tgName } },
    { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  const p = live.get(req.uid); if (p && set.anonymous !== undefined) p.anonymous = !!set.anonymous;
  res.json({ profile: { dailyTargetMin: prof.dailyTargetMin, anonymous: !!prof.anonymous, pomodoro: prof.pomodoro } });
}));

// ═══════════════════════════════════════════════════════════════════════════
// SUBJECTS
// ═══════════════════════════════════════════════════════════════════════════
const subjectView = (s) => ({ id: String(s._id), name: s.name, color: s.color });
const validColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ""));
const cleanName = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

router.post("/subjects", auth, wrap(async (req, res) => {
  const name = cleanName(req.body && req.body.name, 40);
  if (!name) return bad(res, "Subject name required");
  const count = await StudySubject.countDocuments({ userId: req.uid, archived: false });
  if (count >= MAX_SUBJECTS) return bad(res, `Max ${MAX_SUBJECTS} subjects`);
  const dup = await StudySubject.findOne({ userId: req.uid, archived: false, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (dup) return res.json({ subject: subjectView(dup), existing: true });
  const color = validColor(req.body.color) ? req.body.color : SUBJECT_COLORS[count % SUBJECT_COLORS.length];
  const s = await StudySubject.create({ userId: req.uid, name, color });
  res.json({ subject: subjectView(s) });
}));

router.put("/subjects/:id", auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, "Bad id");
  const set = {};
  if (req.body.name !== undefined) { const n = cleanName(req.body.name, 40); if (!n) return bad(res, "Name required"); set.name = n; }
  if (req.body.color !== undefined) { if (!validColor(req.body.color)) return bad(res, "Bad color"); set.color = req.body.color; }
  const s = await StudySubject.findOneAndUpdate({ _id: req.params.id, userId: req.uid, archived: false }, { $set: set }, { new: true });
  if (!s) return bad(res, "Not found", 404);
  res.json({ subject: subjectView(s) });
}));

// Soft delete: old sessions keep their subject name/colour snapshot.
router.delete("/subjects/:id", auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, "Bad id");
  const r = await StudySubject.updateOne({ _id: req.params.id, userId: req.uid }, { $set: { archived: true } });
  if (!r.matchedCount) return bad(res, "Not found", 404);
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════
// TO-DO TASKS
// ═══════════════════════════════════════════════════════════════════════════
const taskView = (t, today) => ({
  id: String(t._id), text: t.text, day: t.day, done: !!t.done,
  subjectId: t.subjectId ? String(t.subjectId) : null, carried: t.day < today,
});
// Today's tasks + unfinished tasks from the last 7 days ("carried over")
async function loadTasks(uid, day) {
  const rows = await StudyTask.find({
    userId: uid,
    $or: [{ day }, { day: { $gte: addDays(day, -7), $lt: day }, done: false }],
  }).sort({ done: 1, createdAt: 1 }).lean();
  return rows.map((t) => taskView(t, day));
}

router.get("/tasks", auth, wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : dayKey();
  res.json({ tasks: await loadTasks(req.uid, day) });
}));

router.post("/tasks", auth, wrap(async (req, res) => {
  const text = cleanName(req.body && req.body.text, 120);
  if (!text) return bad(res, "Task text required");
  const day = isDay(req.body.day) ? req.body.day : dayKey();
  let subjectId = null;
  if (req.body.subjectId) {
    if (!isId(req.body.subjectId) || !(await StudySubject.exists({ _id: req.body.subjectId, userId: req.uid }))) return bad(res, "Unknown subject");
    subjectId = req.body.subjectId;
  }
  if ((await StudyTask.countDocuments({ userId: req.uid, day })) >= MAX_TASKS_PER_DAY) return bad(res, `Max ${MAX_TASKS_PER_DAY} tasks a day`);
  const t = await StudyTask.create({ userId: req.uid, day, text, subjectId });
  res.json({ task: taskView(t, dayKey()) });
}));

router.put("/tasks/:id", auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, "Bad id");
  const set = {};
  if (req.body.text !== undefined) { const t = cleanName(req.body.text, 120); if (!t) return bad(res, "Text required"); set.text = t; }
  if (req.body.done !== undefined) { set.done = !!req.body.done; set.doneAt = req.body.done ? new Date() : null; }
  if (req.body.subjectId !== undefined) {
    if (req.body.subjectId === null) set.subjectId = null;
    else if (isId(req.body.subjectId) && await StudySubject.exists({ _id: req.body.subjectId, userId: req.uid })) set.subjectId = req.body.subjectId;
    else return bad(res, "Unknown subject");
  }
  const t = await StudyTask.findOneAndUpdate({ _id: req.params.id, userId: req.uid }, { $set: set }, { new: true });
  if (!t) return bad(res, "Not found", 404);
  res.json({ task: taskView(t, dayKey()) });
}));

router.delete("/tasks/:id", auth, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, "Bad id");
  await StudyTask.deleteOne({ _id: req.params.id, userId: req.uid });
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════
// TIMER  (start → heartbeat every ~30s → stop)
// ═══════════════════════════════════════════════════════════════════════════
router.get("/timer", auth, (req, res) => {
  const p = live.get(req.uid);
  res.json({ serverNow: Date.now(), timer: p ? presenceView(p) : null });
});

router.post("/timer/start", auth, wrap(async (req, res) => {
  const b = req.body || {};
  const mode = ["pomodoro", "stopwatch", "custom"].includes(b.mode) ? b.mode : "stopwatch";
  let subject = null, taskId = null;
  if (b.subjectId) {
    if (!isId(b.subjectId)) return bad(res, "Bad subject");
    subject = await StudySubject.findOne({ _id: b.subjectId, userId: req.uid, archived: false }).lean();
    if (!subject) return bad(res, "Unknown subject");
  }
  if (b.taskId) {
    if (!isId(b.taskId) || !(await StudyTask.exists({ _id: b.taskId, userId: req.uid }))) return bad(res, "Unknown task");
    taskId = b.taskId;
  }
  const old = live.get(req.uid);
  if (old) await finalizePresence(old);                      // switching subject = new session
  const prof = await ensureProfile(req.uid, req.tgName);
  const now = Date.now();
  const p = {
    userId: req.uid, name: prof.name || req.tgName, anonymous: !!prof.anonymous,
    subjectId: subject ? subject._id : null, subjectName: subject ? subject.name : "", subjectColor: subject ? subject.color : "#B8B2A3",
    taskId, mode, startedAt: now, status: "focus", lastBeat: now, focusSec: 0,
  };
  live.set(req.uid, p);
  res.json({ serverNow: now, timer: presenceView(p) });
}));

router.post("/timer/beat", auth, (req, res) => {
  const p = live.get(req.uid);
  if (!p) return res.status(404).json({ error: "no_timer" });
  const now = Date.now();
  if (p.status === "focus") p.focusSec += Math.min(now - p.lastBeat, BEAT_GAP_CAP_MS) / 1000;
  p.lastBeat = now;
  const st = req.body && req.body.status;
  if (["focus", "break", "paused"].includes(st)) p.status = st;
  if (p.focusSec > MAX_SESSION_SEC) { finalizePresence(p).catch(() => {}); return res.status(404).json({ error: "no_timer" }); }
  res.json({ serverNow: now, timer: presenceView(p) });
});

router.post("/timer/stop", auth, wrap(async (req, res) => {
  const p = live.get(req.uid);
  if (!p) return res.json({ saved: false });
  const now = Date.now();
  if (p.status === "focus") p.focusSec += Math.min(now - p.lastBeat, BEAT_GAP_CAP_MS) / 1000;
  p.lastBeat = now;
  const doc = await finalizePresence(p);
  res.json({ saved: !!doc, durationSec: doc ? doc.durationSec : 0 });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL ROOM + LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════
router.get("/live", auth, wrap(async (req, res) => {
  const now = Date.now();
  const all = [...live.values()].filter((p) => now - p.lastBeat <= STALE_AFTER_MS);
  all.sort((a, b) => b.focusSec - a.focusSec);
  const items = all.slice(0, 100).map((p) => ({
    name: p.anonymous ? "Anonymous" : p.name, mine: p.userId === req.uid,
    subjectName: p.anonymous ? "" : p.subjectName, status: p.status, sec: Math.floor(p.focusSec),
  }));
  res.json({ serverNow: now, count: all.length, items });
}));

async function leaderboard(day, userIds /* null = everyone */, limit, maskAnon) {
  const map = await secByUser(day, userIds);
  const top = [...map.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const profs = await profilesMap(top.map(([u]) => u));
  return top.map(([u, sec], i) => ({ rank: i + 1, userId: u, name: maskAnon ? shownName(profs.get(u)) : realName(profs.get(u)), sec }));
}

router.get("/leaderboard", auth, wrap(async (req, res) => {
  const day = dayKey();
  let rows;
  if (req.query.groupId) {
    if (!isId(req.query.groupId)) return bad(res, "Bad group");
    const g = await StudyGroup.findOne({ _id: req.query.groupId, "members.userId": req.uid }).lean();
    if (!g) return bad(res, "Not a member", 403);
    rows = await leaderboard(day, g.members.map((m) => m.userId), 20, false);
  } else {
    rows = await cached("lb:global:" + day, 15000, () => leaderboard(day, null, 20, true));
  }
  res.json({ day, items: rows.map((r) => ({ rank: r.rank, name: r.name, sec: r.sec, mine: r.userId === req.uid })) });
}));

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════
router.get("/stats", auth, wrap(async (req, res) => {
  const today = dayKey();
  const range = req.query.range === "month" ? "month" : "week";
  const start = range === "week" ? addDays(today, -dow(today)) : addDays(today, -29);
  const len = range === "week" ? 7 : 30;
  const days = Array.from({ length: len }, (_, i) => addDays(start, i));

  const sessions = await StudySession.find({ userId: req.uid, day: { $gte: start, $lte: days[len - 1] } })
    .select("day subjectId subjectName subjectColor durationSec").lean();
  const p = live.get(req.uid);
  if (p && Math.floor(p.focusSec) > 0) {
    sessions.push({ day: today, subjectId: p.subjectId, subjectName: p.subjectName, subjectColor: p.subjectColor, durationSec: Math.floor(p.focusSec) });
  }
  const subjKey = (s) => (s.subjectId ? String(s.subjectId) : "none");
  const subjects = new Map();           // key -> {subjectId,name,color,sec}
  const byDay = new Map(days.map((d) => [d, { day: d, totalSec: 0, bySubject: new Map() }]));
  for (const s of sessions) {
    const k = subjKey(s);
    if (!subjects.has(k)) subjects.set(k, { subjectId: k === "none" ? null : k, name: s.subjectName || "No subject", color: s.subjectColor, sec: 0 });
    subjects.get(k).sec += s.durationSec;
    const d = byDay.get(s.day); if (!d) continue;
    d.totalSec += s.durationSec;
    d.bySubject.set(k, (d.bySubject.get(k) || 0) + s.durationSec);
  }
  const dayRows = days.map((d) => {
    const r = byDay.get(d);
    return { day: d, future: d > today, totalSec: r.totalSec, bySubject: [...r.bySubject].map(([k, sec]) => ({ subjectId: k === "none" ? null : k, sec })) };
  });
  const total = dayRows.reduce((s, r) => s + r.totalSec, 0);
  const activeDays = dayRows.filter((r) => r.totalSec > 0).length;
  const best = dayRows.reduce((b, r) => (r.totalSec > (b ? b.totalSec : 0) ? r : b), null);
  const subjList = [...subjects.values()].sort((a, b) => b.sec - a.sec).map((s) => ({ ...s, pct: total ? Math.round((s.sec / total) * 100) : 0 }));
  const prof = await StudyProfile.findOne({ userId: req.uid }).select("dailyTargetMin").lean();
  res.json({
    range, days: dayRows, subjects: subjList, totalSec: total,
    avgSec: activeDays ? Math.round(total / activeDays) : 0,
    best: best && best.totalSec ? { day: best.day, sec: best.totalSec } : null,
    targetSec: ((prof && prof.dailyTargetMin) || 240) * 60, streak: await streakOf(req.uid),
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════════════════
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from(crypto.randomBytes(8)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
const GROUP_COLORS = ["#FFD9C2", "#CDEBDD", "#DCD6F7", "#CFE6F5", "#D4F25C"];

function roleOf(g, uid) {
  if (g.ownerId === uid) return "admin";
  if (g.coAdmins.includes(uid)) return "coadmin";
  return g.members.some((m) => m.userId === uid) ? "member" : null;
}
const isMod = (role) => role === "admin" || role === "coadmin";
const rank = { admin: 3, coadmin: 2, member: 1 };

async function loadGroupFor(req, res) {
  if (!isId(req.params.id)) { bad(res, "Bad group"); return null; }
  const g = await StudyGroup.findById(req.params.id);
  if (!g) { bad(res, "Group not found", 404); return null; }
  const role = roleOf(g, req.uid);
  if (!role) { bad(res, "You are not in this group", 403); return null; }
  return { g, role };
}
function canSeeCode(g, role) { return isMod(role) || g.joinType === "link"; }
function groupMeta(g, role) {
  return {
    id: String(g._id), name: g.name, color: g.color, role, memberCount: g.members.length,
    joinType: g.joinType, dailyGoalMin: g.dailyGoalMin, showTimers: g.showTimers,
    chatMode: g.chatMode, slowSec: g.slowSec, coAdminCount: g.coAdmins.length, maxCoAdmins: MAX_COADMINS,
    pinned: g.pinned && g.pinned.text ? { messageId: g.pinned.messageId ? String(g.pinned.messageId) : null, text: g.pinned.text } : null,
    inviteCode: canSeeCode(g, role) ? g.code : null, inviteLink: canSeeCode(g, role) ? inviteLinkFor(g.code) : null,
  };
}
async function postSystem(groupId, text) {
  await StudyMessage.create({ groupId, userId: "system", name: "", text, kind: "system" });
}

router.get("/groups", auth, wrap(async (req, res) => {
  const day = dayKey();
  const groups = await StudyGroup.find({ "members.userId": req.uid }).sort({ updatedAt: -1 }).lean();
  const out = [];
  for (const g of groups) {
    const ids = g.members.map((m) => m.userId);
    const liveCount = ids.filter((u) => live.has(u)).length;
    const secs = await cached(`gsec:${g._id}:${day}`, 15000, async () => [...(await secByUser(day, ids)).entries()]);
    const top = secs.sort((a, b) => b[1] - a[1])[0];
    let topView = null;
    if (top && top[1] > 0 && g.showTimers) { const pm = await profilesMap([top[0]]); topView = { name: realName(pm.get(top[0])), sec: top[1] }; }
    out.push({ id: String(g._id), name: g.name, color: g.color, role: roleOf(g, req.uid), memberCount: ids.length, liveCount, top: topView });
  }
  const globalLive = [...live.values()].filter((p) => Date.now() - p.lastBeat <= STALE_AFTER_MS).length;
  res.json({ global: { liveCount: globalLive }, groups: out });
}));

router.post("/groups", auth, wrap(async (req, res) => {
  const b = req.body || {};
  const name = cleanName(b.name, 40);
  if (name.length < 2) return bad(res, "Group name too short");
  if ((await StudyGroup.countDocuments({ "members.userId": req.uid })) >= MAX_GROUPS_PER_USER) return bad(res, `You can be in at most ${MAX_GROUPS_PER_USER} groups`);
  const goal = b.dailyGoalMin === undefined ? 180 : Math.round(Number(b.dailyGoalMin));
  if (!(goal >= 0 && goal <= 100000)) return bad(res, "Bad goal");
  await ensureProfile(req.uid, req.tgName);
  let g = null;
  for (let i = 0; i < 5 && !g; i++) {
    try {
      g = await StudyGroup.create({
        name, color: GROUP_COLORS.includes(b.color) || validColor(b.color) ? b.color : GROUP_COLORS[0], code: makeCode(),
        ownerId: req.uid, members: [{ userId: req.uid }],
        joinType: b.joinType === "link" ? "link" : "invite", dailyGoalMin: goal, showTimers: b.showTimers !== false,
      });
    } catch (e) { if (!(e && e.code === 11000)) throw e; }   // code collision → retry
  }
  if (!g) return bad(res, "Could not create group, try again", 500);
  res.json({ group: groupMeta(g, "admin") });
}));

router.get("/groups/preview/:code", auth, wrap(async (req, res) => {
  const g = await StudyGroup.findOne({ code: String(req.params.code || "").toUpperCase().trim() }).select("name color members").lean();
  if (!g) return bad(res, "Invalid invite code", 404);
  res.json({ name: g.name, color: g.color, memberCount: g.members.length, joined: g.members.some((m) => m.userId === req.uid) });
}));

router.post("/groups/join", auth, wrap(async (req, res) => {
  const code = String((req.body && req.body.code) || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 6) return bad(res, "Enter a valid invite code");
  const g = await StudyGroup.findOne({ code });
  if (!g) return bad(res, "Invalid invite code", 404);
  if (g.members.some((m) => m.userId === req.uid)) return res.json({ group: groupMeta(g, roleOf(g, req.uid)), already: true });
  if (g.members.length >= MAX_GROUP_MEMBERS) return bad(res, "Group is full");
  if ((await StudyGroup.countDocuments({ "members.userId": req.uid })) >= MAX_GROUPS_PER_USER) return bad(res, `You can be in at most ${MAX_GROUPS_PER_USER} groups`);
  const prof = await ensureProfile(req.uid, req.tgName);
  const r = await StudyGroup.updateOne({ _id: g._id, "members.userId": { $ne: req.uid } }, { $push: { members: { userId: req.uid } } });
  if (r.modifiedCount) await postSystem(g._id, `${realName(prof)} joined the group`);
  const fresh = await StudyGroup.findById(g._id);
  res.json({ group: groupMeta(fresh, "member") });
}));

router.get("/groups/:id", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g, role } = ctx;
  const day = dayKey();
  const ids = g.members.map((m) => m.userId);
  const [profs, secs] = await Promise.all([profilesMap(ids), secByUser(day, ids)]);
  const now = Date.now();
  const members = g.members.map((m) => {
    const r = roleOf(g, m.userId), pr = profs.get(m.userId), p = live.get(m.userId);
    const isLive = !!p && now - p.lastBeat <= STALE_AFTER_MS;
    const self = m.userId === req.uid;
    const view = { userId: m.userId, name: realName(pr), role: r, self,
      muted: !!(m.mutedUntil && m.mutedUntil > now) };
    // Timers are only shown if the group allows it (you always see your own)
    if (g.showTimers || self) Object.assign(view, {
      live: isLive, status: isLive ? p.status : "offline", liveSec: isLive ? Math.floor(p.focusSec) : 0,
      subjectName: isLive ? p.subjectName : "", todaySec: secs.get(m.userId) || 0,
    });
    return view;
  });
  members.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.liveSec || 0) - (a.liveSec || 0) || (b.todaySec || 0) - (a.todaySec || 0));
  const teamSec = g.showTimers ? ids.reduce((s, u) => s + (secs.get(u) || 0), 0) : null;
  res.json({
    serverNow: now, group: groupMeta(g, role), members,
    goal: { goalSec: g.dailyGoalMin * 60, doneSec: teamSec }, liveCount: members.filter((m) => m.live).length,
  });
}));

router.put("/groups/:id", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g, role } = ctx, b = req.body || {}, set = {};
  if (!isMod(role)) return bad(res, "Admins only", 403);
  // Chat settings: admin + co-admin
  if (b.chatMode !== undefined) { if (!["everyone", "admins"].includes(b.chatMode)) return bad(res, "Bad chatMode"); set.chatMode = b.chatMode; }
  if (b.slowSec !== undefined) { const n = Math.round(Number(b.slowSec)); if (!(n >= 0 && n <= 600)) return bad(res, "Bad slowSec"); set.slowSec = n; }
  // Everything else: group admin only
  const ownerKeys = ["name", "color", "joinType", "dailyGoalMin", "showTimers"].filter((k) => b[k] !== undefined);
  if (ownerKeys.length && role !== "admin") return bad(res, "Only the group admin can change this", 403);
  if (b.name !== undefined) { const n = cleanName(b.name, 40); if (n.length < 2) return bad(res, "Name too short"); set.name = n; }
  if (b.color !== undefined) { if (!validColor(b.color)) return bad(res, "Bad color"); set.color = b.color; }
  if (b.joinType !== undefined) { if (!["invite", "link"].includes(b.joinType)) return bad(res, "Bad joinType"); set.joinType = b.joinType; }
  if (b.dailyGoalMin !== undefined) { const n = Math.round(Number(b.dailyGoalMin)); if (!(n >= 0 && n <= 100000)) return bad(res, "Bad goal"); set.dailyGoalMin = n; }
  if (b.showTimers !== undefined) set.showTimers = !!b.showTimers;
  const fresh = await StudyGroup.findByIdAndUpdate(g._id, { $set: set }, { new: true });
  res.json({ group: groupMeta(fresh, role) });
}));

router.delete("/groups/:id", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  if (ctx.role !== "admin") return bad(res, "Only the group admin can delete it", 403);
  await Promise.all([StudyGroup.deleteOne({ _id: ctx.g._id }), StudyMessage.deleteMany({ groupId: ctx.g._id })]);
  res.json({ ok: true });
}));

router.post("/groups/:id/leave", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g } = ctx;
  if (g.members.length === 1) {
    await Promise.all([StudyGroup.deleteOne({ _id: g._id }), StudyMessage.deleteMany({ groupId: g._id })]);
    return res.json({ ok: true, deleted: true });
  }
  const upd = { $pull: { members: { userId: req.uid }, coAdmins: req.uid } };
  if (g.ownerId === req.uid) {            // hand the group over: a co-admin first, else the longest-standing member
    const heir = g.coAdmins.find((u) => u !== req.uid) || g.members.find((m) => m.userId !== req.uid).userId;
    upd.$set = { ownerId: heir };
    upd.$pull.coAdmins = { $in: [req.uid, heir] };
  }
  await StudyGroup.updateOne({ _id: g._id }, upd);
  res.json({ ok: true });
}));

// ── Roles & moderation ──────────────────────────────────────────────────────
router.post("/groups/:id/coadmins", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g, role } = ctx, target = String((req.body && req.body.userId) || "");
  if (role !== "admin") return bad(res, "Only the group admin can appoint co-admins", 403);
  if (!g.members.some((m) => m.userId === target) || target === g.ownerId) return bad(res, "Pick a group member");
  if (g.coAdmins.includes(target)) return res.json({ ok: true });
  if (g.coAdmins.length >= MAX_COADMINS) return bad(res, `Max ${MAX_COADMINS} co-admins`);
  await StudyGroup.updateOne({ _id: g._id }, { $addToSet: { coAdmins: target } });
  const pm = await profilesMap([target]);
  await postSystem(g._id, `${realName(pm.get(target))} is now a co-admin`);
  res.json({ ok: true });
}));

router.delete("/groups/:id/coadmins/:uid", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  if (ctx.role !== "admin") return bad(res, "Only the group admin can remove co-admins", 403);
  await StudyGroup.updateOne({ _id: ctx.g._id }, { $pull: { coAdmins: String(req.params.uid) } });
  res.json({ ok: true });
}));

// Moderator may act on someone only if they outrank them (admin > co-admin > member)
function canModerate(g, actorRole, targetUid) {
  const tr = roleOf(g, targetUid);
  return !!tr && isMod(actorRole) && rank[actorRole] > rank[tr];
}

router.post("/groups/:id/members/:uid/mute", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g, role } = ctx, target = String(req.params.uid);
  if (!canModerate(g, role, target)) return bad(res, "You can't moderate this member", 403);
  const minutes = Math.round(Number(req.body && req.body.minutes));
  if (!(minutes >= 0 && minutes <= 10080)) return bad(res, "Minutes must be 0–10080 (0 = unmute)");
  await StudyGroup.updateOne({ _id: g._id, "members.userId": target },
    { $set: { "members.$.mutedUntil": minutes ? new Date(Date.now() + minutes * 60000) : null } });
  res.json({ ok: true });
}));

router.delete("/groups/:id/members/:uid", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g, role } = ctx, target = String(req.params.uid);
  if (!canModerate(g, role, target)) return bad(res, "You can't remove this member", 403);
  await StudyGroup.updateOne({ _id: g._id }, { $pull: { members: { userId: target }, coAdmins: target } });
  res.json({ ok: true });
}));

// ── Chat ────────────────────────────────────────────────────────────────────
const lastPost = new Map();     // `${groupId}:${uid}` -> ms
const msgView = (m, g, uid) => ({
  id: String(m._id), kind: m.kind, mine: m.userId === uid, userId: m.userId, name: m.name,
  role: m.kind === "system" ? null : roleOf(g, m.userId), text: m.deleted ? "" : m.text, deleted: !!m.deleted, at: m.createdAt,
  reply: m.reply && m.reply.id && !m.deleted ? { id: String(m.reply.id), name: m.reply.name || "", text: m.reply.text || "" } : null,
});

router.get("/groups/:id/messages", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const q = { groupId: ctx.g._id };
  if (req.query.after) { if (!isId(req.query.after)) return bad(res, "Bad cursor"); q._id = { $gt: req.query.after }; }
  let rows = await StudyMessage.find(q).sort({ _id: req.query.after ? 1 : -1 }).limit(limit).lean();
  if (!req.query.after) rows = rows.reverse();
  const m = ctx.g.members.find((x) => x.userId === req.uid);
  res.json({
    items: rows.map((r) => msgView(r, ctx.g, req.uid)),
    pinned: ctx.g.pinned && ctx.g.pinned.text ? { messageId: ctx.g.pinned.messageId ? String(ctx.g.pinned.messageId) : null, text: ctx.g.pinned.text } : null,
    canPost: !(ctx.g.chatMode === "admins" && !isMod(ctx.role)) && !(m && m.mutedUntil && m.mutedUntil > Date.now()),
    mutedUntil: m && m.mutedUntil && m.mutedUntil > Date.now() ? m.mutedUntil : null,
    chatMode: ctx.g.chatMode, slowSec: ctx.g.slowSec,
  });
}));

router.post("/groups/:id/messages", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  const { g, role } = ctx;
  const text = String((req.body && req.body.text) || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
  if (!text) return bad(res, "Message is empty");
  if (g.chatMode === "admins" && !isMod(role)) return bad(res, "Only admins can chat right now", 403);
  const me = g.members.find((x) => x.userId === req.uid);
  if (me && me.mutedUntil && me.mutedUntil > Date.now()) return bad(res, "You are muted in this group", 403);
  const key = `${g._id}:${req.uid}`, now = Date.now();
  if (!isMod(role)) {              // members: 1 msg/sec, or the group's slow-mode gap (admins are exempt)
    const wait = (lastPost.get(key) || 0) + Math.max(g.slowSec * 1000, 1000) - now;
    if (wait > 0) return res.status(429).json({ error: g.slowSec ? `Slow mode: wait ${Math.ceil(wait / 1000)}s` : "Too fast", retryMs: wait });
  }
  lastPost.set(key, now);
  if (lastPost.size > 5000) for (const [k, t] of lastPost) if (now - t > 600000) lastPost.delete(k);
  const prof = await ensureProfile(req.uid, req.tgName);
  // Optional reply: only to a normal, not-deleted message of THIS group (anything else is quietly ignored)
  let reply;
  const rid = req.body && req.body.replyTo;
  if (rid && isId(rid)) {
    const target = await StudyMessage.findOne({ _id: rid, groupId: g._id });
    if (target && target.kind === "text" && !target.deleted) reply = { id: target._id, name: target.name || "", text: String(target.text).slice(0, 100) };
  }
  const m = await StudyMessage.create({ groupId: g._id, userId: req.uid, name: realName(prof), text, ...(reply ? { reply } : {}) });
  res.json({ message: msgView(m.toObject(), g, req.uid) });
}));

router.delete("/groups/:id/messages/:mid", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  if (!isId(req.params.mid)) return bad(res, "Bad id");
  const m = await StudyMessage.findOne({ _id: req.params.mid, groupId: ctx.g._id });
  if (!m) return bad(res, "Not found", 404);
  const own = m.userId === req.uid;
  if (!own && !(isMod(ctx.role) && (m.kind === "system" || canModerate(ctx.g, ctx.role, m.userId) || !roleOf(ctx.g, m.userId)))) return bad(res, "Not allowed", 403);
  m.deleted = true; m.text = "[deleted]"; await m.save();
  if (ctx.g.pinned && String(ctx.g.pinned.messageId) === String(m._id)) await StudyGroup.updateOne({ _id: ctx.g._id }, { $set: { pinned: { messageId: null, text: "" } } });
  res.json({ ok: true });
}));

router.post("/groups/:id/pin", auth, wrap(async (req, res) => {
  const ctx = await loadGroupFor(req, res); if (!ctx) return;
  if (!isMod(ctx.role)) return bad(res, "Admins only", 403);
  const mid = req.body && req.body.messageId;
  if (!mid) { await StudyGroup.updateOne({ _id: ctx.g._id }, { $set: { pinned: { messageId: null, text: "" } } }); return res.json({ ok: true, pinned: null }); }
  if (!isId(mid)) return bad(res, "Bad id");
  const m = await StudyMessage.findOne({ _id: mid, groupId: ctx.g._id, deleted: false, kind: "text" });
  if (!m) return bad(res, "Message not found", 404);
  await StudyGroup.updateOne({ _id: ctx.g._id }, { $set: { pinned: { messageId: m._id, text: m.text.slice(0, 200) } } });
  res.json({ ok: true, pinned: { messageId: String(m._id), text: m.text.slice(0, 200) } });
}));

// Called on shutdown/deploy so running timers are saved instead of lost.
async function flushAll() {
  const pending = [...live.values()].map((p) => finalizePresence(p).catch(() => null));
  await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 4000))]);
}

module.exports = router;
module.exports.setBot = setBot;
module.exports.flushAll = flushAll;
module.exports._test = { verifyInitData, dayKey, addDays, dow, live, roleOf, canModerate, makeCode };
