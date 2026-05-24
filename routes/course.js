const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");

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

router.get("/batches", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    // Admin sees all; users see public OR legacy batches (isPublic: false = old data, show those too)
    const filter = admin ? {} : { $or: [{ isPublic: true }, { isPublic: { $exists: false } }, { isPublic: false }] };
    res.json(await Batch.find(filter).sort({ order: 1 }));
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
    await batch.save(); res.json(batch);
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

// ── Lectures (chapter-level) ──────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const subj = batch && batch.subjects.id(req.params.sid);
    const chap = subj && subj.chapters.id(req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes || "", order: chap.lectures.length });
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
    unit.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes || "", order: unit.lectures.length });
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
  userId:   { type: String, required: true, unique: true },
  expiresAt:{ type: Date, required: true },
});
accessSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Access = mongoose.model("Access", accessSchema);

// Check access
router.get("/access/:userId", async (req, res) => {
  try {
    const record = await Access.findOne({ userId: req.params.userId });
    if (!record || record.expiresAt < new Date()) return res.json({ hasAccess: false, expiresAt: null });
    res.json({ hasAccess: true, expiresAt: record.expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 1: Issue one-time token before showing ad
router.post("/access/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const existing = await Access.findOne({ userId });
    if (existing && existing.expiresAt > new Date()) {
      return res.json({ hasAccess: true, expiresAt: existing.expiresAt });
    }
    await AdToken.deleteMany({ userId });
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await AdToken.create({ userId, token, expiresAt });
    res.json({ token });
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
    await AdToken.deleteOne({ _id: record._id });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Access.findOneAndUpdate(
      { userId },
      { userId, expiresAt },
      { upsert: true, new: true }
    );
    res.json({ hasAccess: true, expiresAt });
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
