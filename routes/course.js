const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");

// ── Auto-Lecture Session — MongoDB backed (survives server restarts) ──────────
const autoLecSessionSchema = new mongoose.Schema({
  _id:          { type: String, default: 'singleton' },
  active:       { type: Boolean, default: false },
  batchId:      { type: String, default: null },
  subjectId:    { type: String, default: null },
  chapterId:    { type: String, default: null },
  unitId:       { type: String, default: null },
  lectureCount: { type: Number, default: 0 },
  batchName:    { type: String, default: '' },
  subjectName:  { type: String, default: '' },
  chapterName:  { type: String, default: '' },
  unitName:     { type: String, default: '' },
}, { _id: false });
const AutoLecSession = mongoose.model('AutoLecSession', autoLecSessionSchema);

// In-memory mirror — always synced with DB. Used by server.js bot handler.
const autoLectureSession = {
  active: false,
  batchId: null, subjectId: null, chapterId: null, unitId: null,
  lectureCount: 0,
  batchName: '', subjectName: '', chapterName: '', unitName: '',
};

// Load persisted session from DB into memory on startup
async function _loadAutoSession() {
  try {
    const doc = await AutoLecSession.findById('singleton');
    if (doc) Object.assign(autoLectureSession, doc.toObject());
  } catch (e) { console.error('AutoLecSession load error:', e.message); }
}
_loadAutoSession();

// Save current in-memory state to DB
async function _saveAutoSession() {
  try {
    await AutoLecSession.findByIdAndUpdate(
      'singleton',
      { $set: autoLectureSession },
      { upsert: true, new: true }
    );
  } catch (e) { console.error('AutoLecSession save error:', e.message); }
}

async function autoAddLecture({ batchId, subjectId, chapterId, unitId, name, link }) {
  const batch = await Batch.findById(batchId);
  if (!batch) throw new Error('Batch not found');
  const subj = batch.subjects.id(subjectId);
  if (!subj) throw new Error('Subject not found');
  const chap = subj.chapters.id(chapterId);
  if (!chap) throw new Error('Chapter not found');
  if (unitId) {
    const unit = chap.units.id(unitId);
    if (!unit) throw new Error('Unit not found');
    unit.lectures.push({ name, link, notes: '', order: unit.lectures.length });
  } else {
    chap.lectures.push({ name, link, notes: '', order: chap.lectures.length });
  }
  await batch.save();
}

// ── Admin verification using Telegram initData + OWNER_ID ────────────────────
function verifyAdmin(req, res, next) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return res.status(401).json({ error: "Unauthorized" });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return res.status(401).json({ error: "Invalid signature" });
    const user = JSON.parse(params.get("user") || "{}");
    if (user.id !== OWNER_ID) return res.status(403).json({ error: "Forbidden" });
    next();
  } catch (e) {
    return res.status(401).json({ error: "Verification failed" });
  }
}

// ── Helper: check if request is from admin (without blocking) ─────────────────
function isAdminRequest(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return false;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return false;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id === OWNER_ID;
  } catch (e) {
    return false;
  }
}

// ── Batches ───────────────────────────────────────────────────────────────────

// Helper: get requesting user's Telegram ID from initData (no admin check)
function getRequestUserId(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? String(user.id) : null;
  } catch (e) { return null; }
}

// Helper: strip lecture links from a batch for unauthorized premium users
function stripPremiumLinks(batch) {
  const b = batch.toObject();
  b.subjects = b.subjects.map(s => ({
    ...s,
    chapters: s.chapters.map(c => ({
      ...c,
      lectures: c.lectures.map(l => ({ ...l, link: l.isDemo ? l.link : '', notes: l.isDemo ? l.notes : '' })),
      units: c.units.map(u => ({
        ...u,
        lectures: u.lectures.map(l => ({ ...l, link: l.isDemo ? l.link : '', notes: l.isDemo ? l.notes : '' }))
      }))
    }))
  }));
  return b;
}

router.get("/batches", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    const filter = admin ? {} : { $or: [{ isPublic: true }, { isPublic: { $exists: false } }, { isPublic: false }] };
    const batches = await Batch.find(filter).sort({ order: 1 });

    if (admin) return res.json(batches);

    // For non-admin: verify user identity, strip links from premium batches they don't have access to
    const userId = getRequestUserId(req);
    const result = batches.map(b => {
      if (!b.isPremium) return b.toObject(); // free batch — send as-is
      const hasAccess = userId && (b.premiumUsers || []).includes(userId);
      return hasAccess ? b.toObject() : stripPremiumLinks(b); // strip links if no access
    });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time migration: publish all existing legacy batches
router.post("/batches/migrate-publish", verifyAdmin, async (req, res) => {
  try {
    const result = await Batch.updateMany({ isPublic: false }, { $set: { isPublic: true } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches", verifyAdmin, async (req, res) => {
  try {
    const count = await Batch.countDocuments();
    res.json(await Batch.create({
      name: req.body.name,
      pic: req.body.pic || "",
      description: req.body.description || "",
      order: count,
      isPublic: false,
      isPremium: req.body.isPremium === true,
      premiumUsers: [],
      price: req.body.price ? Number(req.body.price) : 0,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/publish", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.isPublic = !batch.isPublic;
    await batch.save();
    res.json({ success: true, isPublic: batch.isPublic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid", verifyAdmin, async (req, res) => {
  try {
    await Batch.findByIdAndDelete(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit batch
router.patch("/batches/:bid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    if (req.body.name) batch.name = req.body.name;
    if (req.body.description !== undefined) batch.description = req.body.description;
    if (req.body.isPremium !== undefined) batch.isPremium = req.body.isPremium;
    if (req.body.price !== undefined) batch.price = Number(req.body.price) || 0;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Premium User Management ───────────────────────────────────────────────────

// Single batch GET — admin gets full data with links
router.get("/batches/:bid", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Not found" });
    if (admin) return res.json(batch.toObject());
    const userId = getRequestUserId(req);
    const hasAccess = userId && (batch.premiumUsers || []).includes(userId);
    res.json(batch.isPremium && !hasAccess ? stripPremiumLinks(batch) : batch.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    res.json({ premiumUsers: batch.premiumUsers || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const uid = String(req.body.userId || '').trim();
    if (!uid) return res.status(400).json({ error: "userId required" });
    if (!batch.premiumUsers) batch.premiumUsers = [];
    if (!batch.premiumUsers.includes(uid)) {
      batch.premiumUsers.push(uid);
      await batch.save();
    }
    res.json({ success: true, premiumUsers: batch.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/premium-users/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.premiumUsers = (batch.premiumUsers || []).filter(u => u !== req.params.uid);
    await batch.save();
    res.json({ success: true, premiumUsers: batch.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid/premium-check/:userId", async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    const hasAccess = (batch.premiumUsers || []).includes(String(req.params.userId));
    res.json({ hasAccess, isPremium: batch.isPremium === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Subjects ──────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects.push({ name: req.body.name, icon: req.body.icon || "📚", color: req.body.color || "#4f8ef7", order: batch.subjects.length });
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects = batch.subjects.filter(s => s._id.toString() !== req.params.sid);
    await batch.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit subject
router.patch("/batches/:bid/subjects/:sid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    if (req.body.name) subj.name = req.body.name;
    if (req.body.icon) subj.icon = req.body.icon;
    if (req.body.color) subj.color = req.body.color;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chapters ──────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    subj.chapters.push({ name: req.body.name, order: subj.chapters.length });
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    subj.chapters = subj.chapters.filter(c => c._id.toString() !== req.params.cid);
    await batch.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit chapter name + comingSoon flag
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    if (req.body.name) chap.name = req.body.name;
    if (req.body.comingSoon !== undefined) chap.comingSoon = req.body.comingSoon;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Units ─────────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.units.push({ name: req.body.name, order: chap.units.length });
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.units = chap.units.filter(u => u._id.toString() !== req.params.uid);
    await batch.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit unit name
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    if (req.body.name) unit.name = req.body.name;
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (chapter-level) ──────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes || "", order: chap.lectures.length, isDemo: req.body.isDemo === true });
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures = chap.lectures.filter(l => l._id.toString() !== req.params.lid);
    await batch.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit chapter-level lecture
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const lec = chap && chap.lectures.id(req.params.lid);
    if (!lec) return res.status(404).json({ error: "Not found" });
    if (req.body.name) lec.name = req.body.name;
    if (req.body.link !== undefined) lec.link = req.body.link;
    if (req.body.notes !== undefined) lec.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) lec.comingSoon = req.body.comingSoon;
    if (req.body.isDemo !== undefined) lec.isDemo = req.body.isDemo;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (unit-level) ─────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    unit.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes || "", order: unit.lectures.length, isDemo: req.body.isDemo === true });
    await batch.save();
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    unit.lectures = unit.lectures.filter(l => l._id.toString() !== req.params.lid);
    await batch.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit unit-level lecture
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    const unit = chap && chap.units.id(req.params.uid);
    const lec = unit && unit.lectures.id(req.params.lid);
    if (!lec) return res.status(404).json({ error: "Not found" });
    if (req.body.name) lec.name = req.body.name;
    if (req.body.link !== undefined) lec.link = req.body.link;
    if (req.body.notes !== undefined) lec.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) lec.comingSoon = req.body.comingSoon;
    if (req.body.isDemo !== undefined) lec.isDemo = req.body.isDemo;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;


// ── Announcement Schema ───────────────────────────────────────────────────────
const announcementSchema = new mongoose.Schema({
  emoji:     { type: String, default: "📢" },
  heading:   { type: String, required: true },
  body:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Announcement = mongoose.model("Announcement", announcementSchema);

// GET all announcements (public — all users can see)
router.get("/announcements", async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 }).limit(20);
    res.json(announcements);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST new announcement (admin only)
router.post("/announcements", verifyAdmin, async (req, res) => {
  try {
    const { emoji, heading, body } = req.body;
    if (!heading || !body) return res.status(400).json({ error: "heading and body required" });
    const ann = await Announcement.create({ emoji: emoji || "📢", heading, body });
    res.json(ann);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE announcement (admin only)
router.delete("/announcements/:id", verifyAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Ad Token Schema ───────────────────────────────────────────────────────────

const adTokenSchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  token:    { type: String, required: true, unique: true },
  issuedAt: { type: Date, default: Date.now },
  expiresAt:{ type: Date, required: true },
});
adTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdToken = mongoose.model("AdToken", adTokenSchema);

// ── Access Schema ─────────────────────────────────────────────────────────────
const accessSchema = new mongoose.Schema({
  userId:      { type: String, required: true, unique: true },
  expiresAt:   { type: Date, required: true },
  claimsToday: { type: Number, default: 0 },
  claimDay:    { type: String, default: '' }, // 'YYYY-MM-DD' UTC
});
// Note: no TTL index — doc persists so claimsToday survives same day
const Access = mongoose.model("Access", accessSchema);

// Check access
router.get("/access/:userId", async (req, res) => {
  try {
    const record = await Access.findOne({ userId: req.params.userId });
    const today = new Date().toISOString().slice(0, 10);
    const claimsToday = (record && record.claimDay === today) ? (record.claimsToday || 0) : 0;
    const claimsLeft  = Math.max(0, 3 - claimsToday);
    if (!record || record.expiresAt < new Date()) return res.json({ hasAccess: false, expiresAt: null, claimsToday, claimsLeft });
    res.json({ hasAccess: true, expiresAt: record.expiresAt, claimsToday, claimsLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 1: Issue one-time token before showing ad
router.post("/access/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const today = new Date().toISOString().slice(0, 10);
    const existing = await Access.findOne({ userId });
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday || 0) : 0;
    if (claimsToday >= 3) {
      return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao.", claimsToday: 3, claimsLeft: 0 });
    }
    await AdToken.deleteMany({ userId });
    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await AdToken.create({ userId, token, expiresAt: tokenExpiry });
    res.json({ token, claimsToday, claimsLeft: 3 - claimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: Claim access with token (min 15s after issuance)
router.post("/access/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    const record = await AdToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Please watch the ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched. Please wait..." });

    const today = new Date().toISOString().slice(0, 10);
    const existing = await Access.findOne({ userId });
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday || 0) : 0;
    if (claimsToday >= 3) {
      await AdToken.deleteOne({ _id: record._id });
      return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao." });
    }

    await AdToken.deleteOne({ _id: record._id });

    // ADD 8h to current access (not replace) — extend from now or from existing expiry
    const baseTime = (existing && existing.expiresAt > new Date()) ? existing.expiresAt : new Date();
    const expiresAt = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
    const newClaimsToday = claimsToday + 1;

    await Access.findOneAndUpdate(
      { userId },
      { userId, expiresAt, claimsToday: newClaimsToday, claimDay: today },
      { upsert: true, new: true }
    );
    res.json({ hasAccess: true, expiresAt, claimsToday: newClaimsToday, claimsLeft: 3 - newClaimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Referral System ───────────────────────────────────────────────────────────
const referralSchema = new mongoose.Schema({
  referrerId: { type: String, required: true },  // who shared the link
  referredId: { type: String, required: true },  // who joined
  createdAt:  { type: Date, default: Date.now },
});
referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1 }, { unique: true }); // each user can only be referred once
const Referral = mongoose.model('Referral', referralSchema);

// Get refer stats for a user
router.get('/refer/stats/:userId', async (req, res) => {
  try {
    const referrals = await Referral.countDocuments({ referrerId: req.params.userId });
    res.json({ referrals, points: referrals }); // 1 referral = 1 point
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a referral (called by bot when someone joins via ref link)
router.post('/refer/record', async (req, res) => {
  try {
    const { referrerId, referredId } = req.body;
    if (!referrerId || !referredId) return res.status(400).json({ error: 'Missing fields' });
    if (referrerId === referredId) return res.status(400).json({ error: 'Cannot refer yourself' });
    // Must be a brand new user (never used bot before)
    if (!req.body.isNewUser) return res.json({ success: false, isNew: false, reason: 'Not a new user' });

    // Check if already referred (extra safety)
    const existing = await Referral.findOne({ referredId });
    if (existing) return res.json({ success: false, isNew: false, reason: 'Already referred' });

    await Referral.create({ referrerId, referredId });
    res.json({ success: true, isNew: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: false, reason: 'Already referred' });
    res.status(500).json({ error: e.message });
  }
});

// ── Force Join ────────────────────────────────────────────────────────────────
// Returns list of channels user must join (from env FORCE_JOIN_CHANNELS)
// and their current membership status (checked via Telegram Bot API).
//
// ENV: FORCE_JOIN_CHANNELS = comma-separated channel IDs e.g. "-100123,-100456"
//      BOT_TOKEN is already available above
//
// GET /api/force-join/channels        — public: returns channel list (ids + invite links if set)
// POST /api/force-join/check          — body: { userId } — returns { allJoined, channels:[{id,name,link,joined}] }

// Optional: admin can store channel display names/invite links in env like:
//   FORCE_JOIN_CHANNEL_NAMES = "Channel One,Channel Two"
//   FORCE_JOIN_CHANNEL_LINKS = "https://t.me/chan1,https://t.me/chan2"

function getForceJoinChannels() {
  const ids = (process.env.FORCE_JOIN_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const names = (process.env.FORCE_JOIN_CHANNEL_NAMES || '').split(',').map(s => s.trim());
  const links = (process.env.FORCE_JOIN_CHANNEL_LINKS || '').split(',').map(s => s.trim());
  return ids.map((id, i) => ({
    id,
    name: names[i] || ('Channel ' + (i + 1)),
    link: links[i] || null,
  }));
}

router.get('/force-join/channels', (req, res) => {
  const channels = getForceJoinChannels();
  res.json({ channels, required: channels.length > 0 });
});

// In-memory cache for channel info (photo URL, username, title)
// Avoids re-fetching on every /check call. Cache for 10 minutes.
const _channelInfoCache = new Map(); // chatId -> { title, username, photoUrl, cachedAt }

async function getChannelInfo(chatId, botToken) {
  const now = Date.now();
  const cached = _channelInfoCache.get(chatId);
  if (cached && now - cached.cachedAt < 10 * 60 * 1000) return cached;

  try {
    // 1. getChat — title, username
    const chatRes = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const chatData = await chatRes.json();
    const chat = chatData.ok ? chatData.result : null;

    const title    = chat ? (chat.title || chat.first_name || '') : '';
    const username = chat ? (chat.username || '') : '';

    // 2. getChat photo — small photo file_id
    let photoUrl = null;
    if (chat && chat.photo && chat.photo.small_file_id) {
      try {
        const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(chat.photo.small_file_id)}`);
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result && fileData.result.file_path) {
          photoUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
        }
      } catch (_) {}
    }

    // Build redirect link: prefer t.me/username, else use joinchat invite link if present
    const redirectLink = username
      ? `https://t.me/${username}`
      : (chat && chat.invite_link ? chat.invite_link : null);

    const info = { title, username, photoUrl, redirectLink, cachedAt: now };
    _channelInfoCache.set(chatId, info);
    return info;
  } catch (e) {
    return { title: '', username: '', photoUrl: null, redirectLink: null, cachedAt: now };
  }
}

// ── Auto-Lecture API (admin only) ─────────────────────────────────────────────

// GET /api/auto-lecture/status — current session state
router.get('/auto-lecture/status', verifyAdmin, (req, res) => {
  res.json(autoLectureSession);
});

// POST /api/auto-lecture/start — body: { batchId, subjectId, chapterId, unitId?, batchName, subjectName, chapterName, unitName }
router.post('/auto-lecture/start', verifyAdmin, async (req, res) => {
  const { batchId, subjectId, chapterId, unitId, batchName, subjectName, chapterName, unitName } = req.body;
  if (!batchId || !subjectId || !chapterId) return res.status(400).json({ error: 'batchId, subjectId, chapterId required' });
  try {
    const batch = await Batch.findById(batchId);
    const subj = batch && batch.subjects.id(subjectId);
    const chap = subj && subj.chapters.id(chapterId);
    if (!chap) return res.status(404).json({ error: 'Chapter not found' });
    // Count existing lectures so numbering continues correctly
    let existingCount;
    if (unitId) {
      const unit = chap.units.id(unitId);
      existingCount = unit ? unit.lectures.length : 0;
    } else {
      existingCount = chap.lectures.length;
    }
    Object.assign(autoLectureSession, {
      active: true,
      batchId, subjectId, chapterId,
      unitId: unitId || null,
      lectureCount: existingCount,
      batchName: batchName || '', subjectName: subjectName || '',
      chapterName: chapterName || '', unitName: unitName || '',
    });
    await _saveAutoSession();
    res.json({ success: true, session: autoLectureSession });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auto-lecture/stop — stops session
router.post('/auto-lecture/stop', verifyAdmin, async (req, res) => {
  const totalAdded = autoLectureSession.lectureCount;
  Object.assign(autoLectureSession, {
    active: false, batchId: null, subjectId: null, chapterId: null, unitId: null,
    lectureCount: 0, batchName: '', subjectName: '', chapterName: '', unitName: '',
  });
  await _saveAutoSession();
  res.json({ success: true, totalAdded });
});

// Export helpers so server.js (bot) can use them directly
router.autoLectureSession = autoLectureSession;
router.autoAddLecture = autoAddLecture;
router.saveAutoSession = _saveAutoSession;

router.post('/force-join/check', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const channels = getForceJoinChannels();
  if (!channels.length) return res.json({ allJoined: true, channels: [] });

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });

  const results = await Promise.all(channels.map(async (ch) => {
    // Fetch channel info (title, photo, redirect link) in parallel with membership check
    const [memberData, info] = await Promise.all([
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(ch.id)}&user_id=${encodeURIComponent(userId)}`)
        .then(r => r.json()).catch(() => ({})),
      getChannelInfo(ch.id, BOT_TOKEN),
    ]);

    const status = memberData.result && memberData.result.status;
    const joined = ['member', 'administrator', 'creator'].includes(status);

    // Use env-provided name/link as override, else fall back to API data
    return {
      id:          ch.id,
      name:        ch.name !== ('Channel ' + (channels.indexOf(ch) + 1)) ? ch.name : (info.title || ch.name),
      link:        ch.link || info.redirectLink || null,   // env override wins, then API username link
      photoUrl:    info.photoUrl || null,
      joined,
      status:      status || 'not_member',
    };
  }));

  const allJoined = results.every(c => c.joined);
  res.json({ allJoined, channels: results });
});

// ── Stats API (owner only via bot) ───────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();

    // Batch/content stats
    const batches = await Batch.find({});
    const totalBatches   = batches.length;
    const publicBatches  = batches.filter(b => b.isPublic).length;
    const privateBatches = totalBatches - publicBatches;
    let totalSubjects = 0, totalChapters = 0, totalLectures = 0;
    batches.forEach(b => {
      totalSubjects += b.subjects.length;
      b.subjects.forEach(s => {
        totalChapters += s.chapters.length;
        s.chapters.forEach(c => {
          totalLectures += c.lectures.length;
          c.units.forEach(u => { totalLectures += u.lectures.length; });
        });
      });
    });

    // User stats — requires User model from server.js via mongoose
    const mongoose = require('mongoose');
    const UserModel = mongoose.models.User;
    const totalUsers  = UserModel ? await UserModel.countDocuments({}) : 'N/A';
    const recentUsers = UserModel ? await UserModel.countDocuments({ firstSeen: { $gte: new Date(Date.now() - 7*24*60*60*1000) } }) : 'N/A';

    // Access stats
    const totalAccess      = await Access.countDocuments({});
    const activeAccess     = await Access.countDocuments({ expiresAt: { $gt: now } });

    // Referral stats
    const totalReferrals   = await Referral.countDocuments({});
    const uniqueReferrers  = await Referral.distinct('referrerId');

    res.json({
      content:   { totalBatches, publicBatches, privateBatches, totalSubjects, totalChapters, totalLectures },
      users:     { totalUsers, recentUsers },
      access:    { totalAccess, activeAccess },
      referrals: { totalReferrals, uniqueReferrers: uniqueReferrers.length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
