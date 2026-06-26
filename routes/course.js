const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");
const db = require("../sqlite-manager");

// MongoDB connection check
function isMongo() { return mongoose.connection.readyState === 1; }

// Points awarded per successful referral
const POINTS_PER_REFERRAL = 5;

// Helper: find subdoc by _id (replaces mongoose .id() on plain objects)
function _findById(arr, id) { return (arr||[]).find(x => String(x._id) === String(id)) || null; }

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");

// ── Admin verification ────────────────────────────────────────────────────────
function verifyAdmin(req, res, next) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return res.status(401).json({ error: "Unauthorized" });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return res.status(401).json({ error: "Invalid signature" });
    const user = JSON.parse(params.get("user") || "{}");
    if (user.id !== OWNER_ID) return res.status(403).json({ error: "Forbidden" });
    next();
  } catch (e) { return res.status(401).json({ error: "Verification failed" }); }
}

function isAdminRequest(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return false;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return false;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id === OWNER_ID;
  } catch (e) { return false; }
}

function getRequestUserId(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (expectedHash !== hash) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? String(user.id) : null;
  } catch (e) { return null; }
}

// ── Helper: strip premium links ───────────────────────────────────────────────
function stripPremiumLinks(b) {
  return {
    ...b,
    subjects: (b.subjects||[]).map(s => ({
      ...s,
      chapters: (s.chapters||[]).map(c => ({
        ...c,
        lectures: (c.lectures||[]).map(l => ({ ...l, link: l.isDemo ? l.link : '', notes: l.isDemo ? l.notes : '' })),
        units: (c.units||[]).map(u => ({
          ...u,
          lectures: (u.lectures||[]).map(l => ({ ...l, link: l.isDemo ? l.link : '', notes: l.isDemo ? l.notes : '' }))
        }))
      }))
    }))
  };
}

// ── Helper: save batch to MongoDB async (backup) ──────────────────────────────
function _mongoBackupBatch(batchId) {
  // Re-read from SQLite and push to MongoDB async — fire and forget
  setImmediate(async () => {
    try {
      if (!isMongo()) return;
      const data = db.batch.getOne(batchId);
      if (!data) return;
      await Batch.findByIdAndUpdate(batchId, data, { upsert: true });
    } catch (e) { console.error('MongoDB batch backup error:', e.message); }
  });
}

// ── Auto-Lecture Session ──────────────────────────────────────────────────────
const autoLectureSession = db.autoLec.load();

async function _saveAutoSession() {
  db.autoLec.save(autoLectureSession);
  // MongoDB backup
  setImmediate(async () => {
    try {
      const AutoLecSession = mongoose.models.AutoLecSession;
      if (AutoLecSession) await AutoLecSession.findByIdAndUpdate('singleton', { $set: autoLectureSession }, { upsert: true });
    } catch (e) { console.error('AutoLecSession MongoDB backup error:', e.message); }
  });
}

async function autoAddLecture({ batchId, subjectId, chapterId, unitId, name, link }) {
  // Read from SQLite
  const batchData = db.batch.getOne(batchId);
  if (!batchData) throw new Error('Batch not found');

  const subj = (batchData.subjects||[]).find(s => String(s._id) === subjectId);
  if (!subj) throw new Error('Subject not found');
  const chap = (subj.chapters||[]).find(c => String(c._id) === chapterId);
  if (!chap) throw new Error('Chapter not found');

  const newLec = { _id: new mongoose.Types.ObjectId().toString(), name, link, notes: '', order: 0, comingSoon: false, isDemo: false };

  if (unitId) {
    const unit = (chap.units||[]).find(u => String(u._id) === unitId);
    if (!unit) throw new Error('Unit not found');
    if (!unit.lectures) unit.lectures = [];
    newLec.order = unit.lectures.length;
    unit.lectures.push(newLec);
  } else {
    if (!chap.lectures) chap.lectures = [];
    newLec.order = chap.lectures.length;
    chap.lectures.push(newLec);
  }

  // Write to SQLite
  db.batch.upsert(batchData);

  // MongoDB backup (async)
  if (isMongo()) {
  const mongoBatch = await Batch.findById(batchId).catch(() => null);
  if (mongoBatch) {
    const ms = mongoBatch.subjects.id(subjectId);
    const mc = ms && ms.chapters.id(chapterId);
    if (mc) {
      if (unitId) { const mu = mc.units.id(unitId); if (mu) mu.lectures.push({ name, link, notes: '', order: mu.lectures.length, isDemo: false }); }
      else mc.lectures.push({ name, link, notes: '', order: mc.lectures.length, isDemo: false });
      await mongoBatch.save();
    }
  }
  }
}

// ── Batches ───────────────────────────────────────────────────────────────────

router.get("/batches", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    // Admin: fresh from MongoDB
    if (admin) { return res.json(db.batch.getAll()); }

    // Users: from SQLite ⚡
    const batches = db.batch.getAll();
    const userId = getRequestUserId(req);
    res.json(batches.map(b => {
      if (!b.isPremium) return b;
      const hasAccess = userId && (b.premiumUsers||[]).includes(userId);
      return hasAccess ? b : stripPremiumLinks(b);
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid", async (req, res) => {
  try {
    const admin = isAdminRequest(req);
    const b = db.batch.getOne(req.params.bid);
    if (admin) {
      if (!b) return res.status(404).json({ error: "Not found" });
      return res.json(b);
    }
    if (!b) return res.status(404).json({ error: "Not found" });
    const userId = getRequestUserId(req);
    const hasAccess = userId && (b.premiumUsers||[]).includes(userId);
    res.json(b.isPremium && !hasAccess ? stripPremiumLinks(b) : b);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/migrate-publish", verifyAdmin, async (req, res) => {
  try {
    const allBatches = db.batch.getAll();
    let updated = 0;
    for (const b of allBatches) { if (!b.isPublic) { b.isPublic = true; db.batch.upsert(b); updated++; } }
    if (isMongo()) Batch.updateMany({ isPublic: false }, { $set: { isPublic: true } }).catch(() => {});
    res.json({ success: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches", verifyAdmin, async (req, res) => {
  try {
    const count = db.batch.count();
    // SQLite first — generate id locally
    const newId = new (require('mongoose').Types.ObjectId)().toString();
    const newBatch = { _id: newId, name: req.body.name, pic: req.body.pic||"", description: req.body.description||"", order: count, isPublic: false, isPremium: req.body.isPremium===true, premiumUsers: [], price: req.body.price ? Number(req.body.price) : 0, subjects: [] };
    db.batch.upsert(newBatch);
    // MongoDB backup (async)
    if (isMongo()) Batch.create(newBatch).catch(e => console.error('Batch create mongo backup:', e.message));
    res.json(newBatch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/publish", verifyAdmin, async (req, res) => {
  try {
    const batchData = db.batch.getOne(req.params.bid);
    if (!batchData) return res.status(404).json({ error: "Batch not found" });
    batchData.isPublic = !batchData.isPublic;
    db.batch.upsert(batchData);
    if (isMongo()) Batch.findByIdAndUpdate(req.params.bid, { isPublic: batchData.isPublic }).catch(() => {});
    res.json({ success: true, isPublic: batchData.isPublic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid", verifyAdmin, async (req, res) => {
  try {
    db.batch.delete(req.params.bid);
    if (isMongo()) Batch.findByIdAndDelete(req.params.bid).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/edit", verifyAdmin, async (req, res) => {
  try {
    const batchData = db.batch.getOne(req.params.bid);
    if (!batchData) return res.status(404).json({ error: "Batch not found" });
    if (req.body.name) batchData.name = req.body.name;
    if (req.body.description !== undefined) batchData.description = req.body.description;
    if (req.body.isPremium !== undefined) batchData.isPremium = req.body.isPremium;
    if (req.body.price !== undefined) batchData.price = Number(req.body.price)||0;
    if (req.body.pic !== undefined) batchData.pic = req.body.pic;
    db.batch.upsert(batchData);
    if (isMongo()) Batch.findByIdAndUpdate(req.params.bid, batchData).catch(() => {});
    res.json(batchData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Premium Users ─────────────────────────────────────────────────────────────

router.get("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const b = db.batch.getOne(req.params.bid);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    res.json({ premiumUsers: b.premiumUsers||[] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/:bid/premium-users", verifyAdmin, async (req, res) => {
  try {
    const batchData = db.batch.getOne(req.params.bid);
    if (!batchData) return res.status(404).json({ error: "Batch not found" });
    const uid = String(req.body.userId||'').trim();
    if (!uid) return res.status(400).json({ error: "userId required" });
    if (!batchData.premiumUsers) batchData.premiumUsers = [];
    if (!batchData.premiumUsers.includes(uid)) { batchData.premiumUsers.push(uid); }
    db.batch.upsert(batchData);
    if (isMongo()) Batch.findByIdAndUpdate(req.params.bid, { $addToSet: { premiumUsers: uid } }).catch(() => {});
    res.json({ success: true, premiumUsers: batchData.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/premium-users/:uid", verifyAdmin, async (req, res) => {
  try {
    const batchData = db.batch.getOne(req.params.bid);
    if (!batchData) return res.status(404).json({ error: "Batch not found" });
    batchData.premiumUsers = (batchData.premiumUsers||[]).filter(u => u !== req.params.uid);
    db.batch.upsert(batchData);
    if (isMongo()) Batch.findByIdAndUpdate(req.params.bid, { $pull: { premiumUsers: req.params.uid } }).catch(() => {});
    res.json({ success: true, premiumUsers: batchData.premiumUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:bid/premium-check/:userId", async (req, res) => {
  try {
    const b = db.batch.getOne(req.params.bid);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const hasAccess = (b.premiumUsers||[]).includes(String(req.params.userId));
    res.json({ hasAccess, isPremium: b.isPremium===true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Subjects ──────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects.push({ name: req.body.name, icon: req.body.icon||"📚", color: req.body.color||"#4f8ef7", order: batch.subjects.length });
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    batch.subjects = batch.subjects.filter(s => s._id.toString() !== req.params.sid);
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    if (req.body.name) subj.name = req.body.name;
    if (req.body.icon) subj.icon = req.body.icon;
    if (req.body.color) subj.color = req.body.color;
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chapters ──────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    subj.chapters.push({ name: req.body.name, order: subj.chapters.length, lectures: [], units: [] });
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    if (!subj) return res.status(404).json({ error: "Not found" });
    subj.chapters = subj.chapters.filter(c => c._id.toString() !== req.params.cid);
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    if (req.body.name) chap.name = req.body.name;
    if (req.body.comingSoon !== undefined) chap.comingSoon = req.body.comingSoon;
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Units ─────────────────────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.units.push({ name: req.body.name, order: chap.units.length, lectures: [] });
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.units = chap.units.filter(u => u._id.toString() !== req.params.uid);
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    const unit = chap && _findById(chap.units, req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    if (req.body.name) unit.name = req.body.name;
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (chapter-level) ──────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes||"", order: chap.lectures.length, isDemo: req.body.isDemo===true });
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    if (!chap) return res.status(404).json({ error: "Not found" });
    chap.lectures = chap.lectures.filter(l => l._id.toString() !== req.params.lid);
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    const lec = chap && _findById(chap.lectures, req.params.lid);
    if (!lec) return res.status(404).json({ error: "Not found" });
    if (req.body.name) lec.name = req.body.name;
    if (req.body.link !== undefined) lec.link = req.body.link;
    if (req.body.notes !== undefined) lec.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) lec.comingSoon = req.body.comingSoon;
    if (req.body.isDemo !== undefined) lec.isDemo = req.body.isDemo;
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (unit-level) ─────────────────────────────────────────────────────

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    const unit = chap && _findById(chap.units, req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    unit.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes||"", order: unit.lectures.length, isDemo: req.body.isDemo===true });
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    const unit = chap && _findById(chap.units, req.params.uid);
    if (!unit) return res.status(404).json({ error: "Not found" });
    unit.lectures = unit.lectures.filter(l => l._id.toString() !== req.params.lid);
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = db.batch.getOne(req.params.bid);
    const subj = batch && _findById(batch.subjects, req.params.sid);
    const chap = subj && _findById(subj.chapters, req.params.cid);
    const unit = chap && _findById(chap.units, req.params.uid);
    const lec = unit && _findById(unit.lectures, req.params.lid);
    if (!lec) return res.status(404).json({ error: "Not found" });
    if (req.body.name) lec.name = req.body.name;
    if (req.body.link !== undefined) lec.link = req.body.link;
    if (req.body.notes !== undefined) lec.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) lec.comingSoon = req.body.comingSoon;
    if (req.body.isDemo !== undefined) lec.isDemo = req.body.isDemo;
    db.batch.upsert(batch);
    if (isMongo()) _mongoBackupBatch(req.params.bid);
    res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Announcements ─────────────────────────────────────────────────────────────

const announcementSchema = new mongoose.Schema({ emoji: { type: String, default: "📢" }, heading: { type: String, required: true }, body: { type: String, required: true }, createdAt: { type: Date, default: Date.now } });
const Announcement = mongoose.model("Announcement", announcementSchema);

router.get("/announcements", (req, res) => {
  try { res.json(db.announcement.getAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/announcements", verifyAdmin, async (req, res) => {
  try {
    const { emoji, heading, body } = req.body;
    if (!heading || !body) return res.status(400).json({ error: "heading and body required" });
    // Write to MongoDB to get _id
    const annId = new (require('mongoose').Types.ObjectId)().toString();
    const annCreatedAt = new Date();
    db.announcement.insert({ id: annId, emoji: emoji||"📢", heading, body, createdAt: annCreatedAt });
    if (isMongo()) Announcement.create({ _id: annId, emoji: emoji||"📢", heading, body, createdAt: annCreatedAt }).catch(() => {});
    res.json({ _id: annId, emoji: emoji||"📢", heading, body, createdAt: annCreatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/announcements/:id", verifyAdmin, async (req, res) => {
  try {
    db.announcement.delete(req.params.id);
    if (isMongo()) Announcement.findByIdAndDelete(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad Token + Access ─────────────────────────────────────────────────────────

const adTokenSchema = new mongoose.Schema({ userId: { type: String, required: true }, token: { type: String, required: true, unique: true }, issuedAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true } });
adTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdToken = mongoose.model("AdToken", adTokenSchema);

const accessSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true }, claimsToday: { type: Number, default: 0 }, claimDay: { type: String, default: '' } });
const Access = mongoose.model("Access", accessSchema);

router.get("/access/:userId", (req, res) => {
  try {
    const record = db.access.findOne(req.params.userId);
    const today = new Date().toISOString().slice(0, 10);
    const claimsToday = (record && record.claimDay === today) ? (record.claimsToday||0) : 0;
    const claimsLeft = Math.max(0, 3 - claimsToday);
    if (!record || record.expiresAt < new Date()) return res.json({ hasAccess: false, expiresAt: null, claimsToday, claimsLeft });
    res.json({ hasAccess: true, expiresAt: record.expiresAt, claimsToday, claimsLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.access.findOne(userId);
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday||0) : 0;
    if (claimsToday >= 3) return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao.", claimsToday: 3, claimsLeft: 0 });

    db.adToken.deleteByUser(userId);
    if (isMongo()) AdToken.deleteMany({ userId }).catch(() => {});

    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiry = new Date(Date.now() + 10 * 60 * 1000);
    const id = db.generateId();
    db.adToken.create({ id, userId, token, issuedAt: new Date(), expiresAt: tokenExpiry });
    // MongoDB backup
    AdToken.create({ userId, token, expiresAt: tokenExpiry }).catch(() => {});
    res.json({ token, claimsToday, claimsLeft: 3 - claimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const record = db.adToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Please watch the ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched. Please wait..." });

    const today = new Date().toISOString().slice(0, 10);
    const existing = db.access.findOne(userId);
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday||0) : 0;
    if (claimsToday >= 3) { db.adToken.deleteById(record.id); return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao." }); }

    db.adToken.deleteById(record.id);
    AdToken.deleteOne({ userId, token }).catch(() => {});

    const baseTime = (existing && existing.expiresAt > new Date()) ? existing.expiresAt : new Date();
    const expiresAt = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
    const newClaimsToday = claimsToday + 1;

    db.access.upsert({ userId, expiresAt, claimsToday: newClaimsToday, claimDay: today });
    // MongoDB backup
    Access.findOneAndUpdate({ userId }, { userId, expiresAt, claimsToday: newClaimsToday, claimDay: today }, { upsert: true }).catch(() => {});
    res.json({ hasAccess: true, expiresAt, claimsToday: newClaimsToday, claimsLeft: 3 - newClaimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Referrals ─────────────────────────────────────────────────────────────────

const referralSchema = new mongoose.Schema({ referrerId: { type: String, required: true }, referredId: { type: String, required: true }, createdAt: { type: Date, default: Date.now } });
referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1 }, { unique: true });
const Referral = mongoose.model('Referral', referralSchema);

router.get('/refer/stats/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const referralCount = db.referral.countByReferrer(userId); // actual number of referrals
    const referralPoints = referralCount * POINTS_PER_REFERRAL; // points from referrals
    const earnedSpinPoints = db.spinPoints ? db.spinPoints.getTotal(userId) : 0;
    const totalPoints = referralPoints + earnedSpinPoints;
    const usedPoints = (db.pointsUsage && db.pointsUsage.getTotalUsed) ? db.pointsUsage.getTotalUsed(userId) : 0;
    const availablePoints = Math.max(0, totalPoints - usedPoints);
    res.json({ referrals: referralCount, referralPoints, spinPoints: earnedSpinPoints, points: availablePoints });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pending referral schema (sirf store karo, confirmed nahi)
const pendingReferralSchema = new mongoose.Schema({
  referrerId: { type: String, required: true },
  referredId: { type: String, required: true, unique: true },
  confirmed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const PendingReferral = mongoose.models.PendingReferral || mongoose.model('PendingReferral', pendingReferralSchema);

router.post('/refer/record', async (req, res) => {
  try {
    const { referrerId, referredId, isNewUser, pending } = req.body;
    if (!referrerId || !referredId) return res.status(400).json({ error: 'Missing fields' });
    if (referrerId === referredId) return res.status(400).json({ error: 'Cannot refer yourself' });
    if (!isNewUser) return res.json({ success: false, isNew: false, reason: 'Not a new user' });

    // Already confirmed referral hai?
    const existingConfirmed = db.referral.findByReferred(referredId);
    if (existingConfirmed) return res.json({ success: false, isNew: false, reason: 'Already referred' });

    if (pending) {
      // Sirf pending store karo — point baad mein milega
      const existingPending = db.pendingReferral.findByReferred(referredId);
      if (!existingPending) {
        db.pendingReferral.upsert({ referredId, referrerId });
        PendingReferral.create({ referrerId, referredId }).catch(() => {});
      }
      return res.json({ success: true, isNew: true, pending: true });
    }

    // Direct confirm (legacy fallback)
    const id = db.generateId();
    db.referral.insert({ id, referrerId, referredId });
    Referral.create({ referrerId, referredId }).catch(() => {});
    res.json({ success: true, isNew: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: false, reason: 'Already referred' });
    res.status(500).json({ error: e.message });
  }
});

// Pehla lecture watch hone pe pending referral confirm karo
router.post('/refer/confirm-first-watch', async (req, res) => {
  try {
    const { referredId, referredName } = req.body;
    if (!referredId) return res.status(400).json({ error: 'referredId required' });

    // Already confirmed?
    const existingConfirmed = db.referral.findByReferred(referredId);
    if (existingConfirmed) return res.json({ confirmed: false, reason: 'Already confirmed' });

    // Pending referral dhundo — SQLite first, MongoDB fallback
    let pendingRef = db.pendingReferral.findByReferred(referredId);
    if (!pendingRef) {
      // MongoDB fallback
      const mongoRef = await PendingReferral.findOne({ referredId, confirmed: false });
      if (!mongoRef) return res.json({ confirmed: false, reason: 'No pending referral' });
      pendingRef = { referrerId: mongoRef.referrerId, referredId };
    }

    // Confirm karo — SQLite + MongoDB
    db.pendingReferral.confirm(referredId);
    PendingReferral.findOneAndUpdate({ referredId }, { confirmed: true }).catch(() => {});

    const id = db.generateId();
    db.referral.insert({ id, referrerId: pendingRef.referrerId, referredId });
    Referral.create({ referrerId: pendingRef.referrerId, referredId }).catch(() => {});

    // Send Telegram notification to referrer
    // Get updated points for display
    const referralPoints = db.referral.countByReferrer(pendingRef.referrerId) * 5;
    const spinPts = db.spinPoints ? db.spinPoints.getTotal(pendingRef.referrerId) : 0;
    const usedPts = db.pointsUsage ? db.pointsUsage.getTotalUsed(pendingRef.referrerId) : 0;
    const availablePts = Math.max(0, referralPoints + spinPts - usedPts);

    // Fire bot message async — don't block the response
    const displayName = referredName || 'Ek naye dost';
    if (global._botInstance) {
      global._botInstance.sendMessage(
        parseInt(pendingRef.referrerId),
        `🎉 <b>Referral Point Mila!</b>\n\n` +
        `👤 <b>${displayName}</b> ne apna pehla lecture dekha!\n\n` +
        `⭐ <b>+5 Points</b> aapke account mein add ho gaye!\n` +
        `💰 <b>Total Points: ${availablePts}</b>\n\n` +
        `🎯 <i>Aur dosto ko refer karo — aur points kamao!</i>`,
        { parse_mode: 'HTML' }
      ).catch(function(e) { console.error('Referral notify failed:', e.message); });
    }

    res.json({ confirmed: true, referrerId: pendingRef.referrerId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Points Redeem ─────────────────────────────────────────────────────────────
// Reward tiers:
//   1 point  → 24h free access (ad-style)
//   5 points → 24h premium access to 1 chosen batch
//  20 points → 7-day premium access to 1 chosen batch

router.post('/refer/redeem', async (req, res) => {
  try {
    const { userId, tier, batchId } = req.body;
    if (!userId || !tier) return res.status(400).json({ error: 'userId aur tier required hai' });

    // Tier validate
    const TIERS = {
      access_24h:   { cost: 1,  label: '24h Free Access' },
      premium_1d:   { cost: 10, label: '1 Batch 1-Day Premium', needsBatch: true },
      premium_7d:   { cost: 50, label: '1 Batch 7-Day Premium', needsBatch: true },
    };
    const tierInfo = TIERS[tier];
    if (!tierInfo) return res.status(400).json({ error: 'Invalid tier' });
    if (tierInfo.needsBatch && !batchId) return res.status(400).json({ error: 'Batch select karo' });

    // Current points check — referral points + spin earned points combined
    const referralPoints = db.referral.countByReferrer(userId) * POINTS_PER_REFERRAL;
    const earnedSpinPoints = db.spinPoints ? db.spinPoints.getTotal(userId) : 0;
    const totalPoints = referralPoints + earnedSpinPoints;
    const usedPoints = (db.pointsUsage && db.pointsUsage.getTotalUsed) ? db.pointsUsage.getTotalUsed(userId) : 0;
    const availablePoints = Math.max(0, totalPoints - usedPoints);
    if (availablePoints < tierInfo.cost) {
      return res.status(400).json({ error: `Insufficient points. ${tierInfo.cost} chahiye, tumhare paas ${availablePoints} hain.` });
    }

    // Record points usage in MongoDB (SQLite fallback)
    const PointsUsage = mongoose.models.PointsUsage || mongoose.model('PointsUsage', new mongoose.Schema({
      userId: { type: String, required: true },
      pointsUsed: { type: Number, required: true },
      tier: String,
      batchId: String,
      createdAt: { type: Date, default: Date.now }
    }));

    const usageId2 = new (require('mongoose').Types.ObjectId)().toString();
    db.pointsUsage.insert({ id: usageId2, userId, pointsUsed: tierInfo.cost, tier, batchId: batchId || null });
    if (isMongo()) PointsUsage.create({ userId, pointsUsed: tierInfo.cost, tier, batchId: batchId || null }).catch(() => {});

    // Helper: get user info from Telegram (best-effort)
    async function getTgUserInfo(uid) {
      try {
        const userRec = db.user.findOne ? db.user.findOne(uid) : null;
        if (userRec) return userRec;
      } catch(_) {}
      return null;
    }

    // Helper: send Telegram message to owner
    async function notifyOwner(text) {
      if (!BOT_TOKEN || !OWNER_ID) return;
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: OWNER_ID, text, parse_mode: 'HTML' })
        });
      } catch(_) {}
    }

    // Format IST time
    const now = new Date();
    const istStr = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19) + ' IST';

    // Apply the reward
    if (tier === 'access_24h') {
      // Extend free access by 24h
      const existing = db.access.findOne(userId);
      const baseTime = (existing && existing.expiresAt > new Date()) ? existing.expiresAt : new Date();
      const expiresAt = new Date(baseTime.getTime() + 24 * 60 * 60 * 1000);
      const today = new Date().toISOString().slice(0, 10);
      const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday || 0) : 0;
      db.access.upsert({ userId, expiresAt, claimsToday, claimDay: today });
      const Access = mongoose.models.Access;
      if (Access) Access.findOneAndUpdate({ userId }, { userId, expiresAt, claimsToday, claimDay: today }, { upsert: true }).catch(() => {});

      // Notify owner
      const userRec = await getTgUserInfo(userId);
      const userName = userRec ? [userRec.firstName, userRec.lastName].filter(Boolean).join(' ') || userRec.username || userId : userId;
      const usernameTag = userRec && userRec.username ? ` (@${userRec.username})` : '';
      const newPts = availablePoints - tierInfo.cost;
      const expStr = new Date(expiresAt.getTime() + 5.5*60*60*1000).toISOString().replace('T',' ').slice(0,19) + ' IST';
      notifyOwner(
        `🎁 <b>Points Redeemed!</b>

` +
        `👤 <b>User:</b> ${userName}${usernameTag}
` +
        `🆔 <b>User ID:</b> <code>${userId}</code>

` +
        `🏆 <b>Reward:</b> ⚡ 24h Free Access
` +
        `🪙 <b>Points Used:</b> 1
` +
        `💰 <b>Points Remaining:</b> ${newPts}

` +
        `⏰ <b>Access Expires:</b> ${expStr}
` +
        `🕐 <b>Redeemed At:</b> ${istStr}`
      ).catch(() => {});

      return res.json({ success: true, reward: '24h_access', expiresAt, newPoints: newPts, points: newPts });
    }

    if (tier === 'premium_1d' || tier === 'premium_7d') {
      const days = tier === 'premium_1d' ? 1 : 7;
      const batch = db.batch.getOne(batchId);
      if (!batch) return res.status(404).json({ error: 'Batch not found' });

      const uid = String(userId);
      const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;

      // Save to premium_access table (source of truth for expiry)
      const accessId = require('crypto').randomBytes(12).toString('hex');
      db.premiumAccess.grant({ id: accessId, userId: uid, batchId, expiresAt });

      // Also add to batch premiumUsers for immediate frontend use
      if (!batch.premiumUsers) batch.premiumUsers = [];
      if (!batch.premiumUsers.includes(uid)) {
        batch.premiumUsers.push(uid);
        db.batch.upsert(batch);
        if (isMongo()) Batch.findByIdAndUpdate(batchId, { $addToSet: { premiumUsers: uid } }).catch(() => {});
      }

      // Notify owner
      const userRec2 = await getTgUserInfo(userId);
      const userName2 = userRec2 ? [userRec2.firstName, userRec2.lastName].filter(Boolean).join(' ') || userRec2.username || userId : userId;
      const usernameTag2 = userRec2 && userRec2.username ? ` (@${userRec2.username})` : '';
      const newPts2 = availablePoints - tierInfo.cost;
      const expStr2 = new Date(expiresAt + 5.5*60*60*1000).toISOString().replace('T',' ').slice(0,19) + ' IST';
      const rewardEmoji = days === 1 ? '🌟' : '👑';
      notifyOwner(
        `🎁 <b>Points Redeemed!</b>

` +
        `👤 <b>User:</b> ${userName2}${usernameTag2}
` +
        `🆔 <b>User ID:</b> <code>${userId}</code>

` +
        `${rewardEmoji} <b>Reward:</b> ${days === 1 ? '1-Din' : '1-Hafta'} Premium Access
` +
        `📚 <b>Batch:</b> ${batch.name}
` +
        `🪙 <b>Points Used:</b> ${tierInfo.cost}
` +
        `💰 <b>Points Remaining:</b> ${newPts2}

` +
        `⏰ <b>Access Expires:</b> ${expStr2}
` +
        `🕐 <b>Redeemed At:</b> ${istStr}`
      ).catch(() => {});

      return res.json({ success: true, reward: `premium_${days}d`, batchId, batchName: batch.name, expiresAt, newPoints: newPts2, points: newPts2 });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get available (unused) points for a user — includes referral + spin earned points
router.get('/refer/points/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const referralPoints = db.referral.countByReferrer(userId) * POINTS_PER_REFERRAL;
    const earnedSpinPoints = db.spinPoints ? db.spinPoints.getTotal(userId) : 0;
    const totalPoints = referralPoints + earnedSpinPoints;
    const usedPoints = db.pointsUsage.getTotalUsed(userId);
    const availablePoints = Math.max(0, totalPoints - usedPoints);

    res.json({ totalPoints, referralPoints, spinPoints: earnedSpinPoints, usedPoints, availablePoints });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Spin Reward ───────────────────────────────────────────────────────────────
// Called from frontend after ad is watched successfully post-spin.
// Validates user via TG initData, then credits spin points to DB.

router.post('/spin-reward', async (req, res) => {
  try {
    // Verify user identity from TG initData header (same as getRequestUserId)
    const verifiedUserId = getRequestUserId(req);
    const { userId, points } = req.body;

    // Accept only if initData userId matches body userId (prevents spoofing)
    if (!verifiedUserId) return res.status(401).json({ error: 'Unauthorized — invalid initData' });
    if (String(verifiedUserId) !== String(userId)) return res.status(403).json({ error: 'userId mismatch' });
    if (!points || typeof points !== 'number' || points < 1 || points > 5) {
      return res.status(400).json({ error: 'Invalid points value (1–5 allowed)' });
    }

    // Rate limit: max 5 spins per day per user using spin_points table
    const today = new Date();
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const dayEnd = dayStart + 86400000;
    const spinsToday = db.getDb().prepare(
      `SELECT COUNT(*) as c FROM spin_points WHERE userId=? AND createdAt >= ? AND createdAt < ?`
    ).get(String(userId), dayStart, dayEnd).c;

    if (spinsToday >= 5) {
      return res.status(429).json({ error: 'Daily spin limit (5) reached. Kal wapas aao!' });
    }

    // Save spin points to DB
    const spinId = require('crypto').randomBytes(12).toString('hex');
    db.spinPoints.add({ id: spinId, userId: String(userId), points });

    // Return updated totals
    const referralPoints = db.referral.countByReferrer(String(userId)) * POINTS_PER_REFERRAL;
    const totalSpinPoints = db.spinPoints.getTotal(String(userId));
    const usedPoints = db.pointsUsage.getTotalUsed(String(userId));
    const availablePoints = Math.max(0, referralPoints + totalSpinPoints - usedPoints);

    res.json({ success: true, pointsAwarded: points, availablePoints, spinsToday: spinsToday + 1 });
  } catch (e) {
    console.error('spin-reward error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Spin Status ───────────────────────────────────────────────────────────────
// Returns how many spins user has done today (from DB, not localStorage)
// Used on page load to restore accurate spin count after redeploy/refresh
router.get('/spin-status/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    // Count spins done today (midnight to midnight, local server time)
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayEnd = dayStart + 86400000;
    const spinsToday = db.getDb().prepare(
      `SELECT COUNT(*) as c FROM spin_points WHERE userId=? AND createdAt >= ? AND createdAt < ?`
    ).get(userId, dayStart, dayEnd).c;

    const totalPoints = db.spinPoints.getTotal(userId);
    res.json({ spinsToday, spinsLeft: Math.max(0, 5 - spinsToday), totalSpinPoints: totalPoints });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Batch Premium Access Check ────────────────────────────────────────────────
// Returns all batches user has active premium access to (from points redeem)
// Frontend uses this to check expiry instead of relying on premiumUsers array
router.get('/batch-access/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const active = db.premiumAccess.getActiveForUser(userId);
    // Return map of batchId -> expiresAt for quick lookup
    const accessMap = {};
    active.forEach(function(row) { accessMap[row.batchId] = row.expiresAt; });
    res.json({ accessMap });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Premium Access Expiry Cleanup (runs every hour) ───────────────────────────
// Removes expired users from batch premiumUsers array so access is truly revoked
setInterval(function _cleanupExpiredPremiumAccess() {
  try {
    const expired = db.premiumAccess.getExpired();
    if (!expired.length) return;
    expired.forEach(function(row) {
      // Remove from SQLite premium_access
      db.premiumAccess.remove(row.id);
      // Remove from batch premiumUsers array
      const batch = db.batch.getOne(row.batchId);
      if (batch && batch.premiumUsers) {
        batch.premiumUsers = batch.premiumUsers.filter(function(u) { return u !== row.userId; });
        db.batch.upsert(batch);
        // Sync to MongoDB
        if (mongoose.connection.readyState === 1) {
          Batch.findByIdAndUpdate(row.batchId, { $pull: { premiumUsers: row.userId } }).catch(() => {});
        }
      }
      console.log(`[PremiumExpiry] Removed userId=${row.userId} from batchId=${row.batchId}`);
    });
  } catch(e) { console.error('[PremiumExpiry] Cleanup error:', e.message); }
}, 60 * 60 * 1000); // Every hour

// ── Force Join ────────────────────────────────────────────────────────────────

function getForceJoinChannels() {
  const ids = (process.env.FORCE_JOIN_CHANNELS||'').split(',').map(s => s.trim()).filter(Boolean);
  const names = (process.env.FORCE_JOIN_CHANNEL_NAMES||'').split(',').map(s => s.trim());
  const links = (process.env.FORCE_JOIN_CHANNEL_LINKS||'').split(',').map(s => s.trim());
  return ids.map((id, i) => ({ id, name: names[i]||('Channel '+(i+1)), link: links[i]||null }));
}

router.get('/force-join/channels', (req, res) => {
  const channels = getForceJoinChannels();
  res.json({ channels, required: channels.length > 0 });
});

const _channelInfoCache = new Map();
async function getChannelInfo(chatId, botToken) {
  const now = Date.now();
  const cached = _channelInfoCache.get(chatId);
  if (cached && now - cached.cachedAt < 10 * 60 * 1000) return cached;
  try {
    const chatRes = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const chatData = await chatRes.json();
    const chat = chatData.ok ? chatData.result : null;
    const title = chat ? (chat.title||chat.first_name||'') : '';
    const username = chat ? (chat.username||'') : '';
    let photoUrl = null;
    if (chat && chat.photo && chat.photo.small_file_id) {
      try {
        const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(chat.photo.small_file_id)}`);
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result && fileData.result.file_path) photoUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
      } catch (_) {}
    }
    const redirectLink = username ? `https://t.me/${username}` : (chat && chat.invite_link ? chat.invite_link : null);
    const info = { title, username, photoUrl, redirectLink, cachedAt: now };
    _channelInfoCache.set(chatId, info);
    return info;
  } catch (e) { return { title: '', username: '', photoUrl: null, redirectLink: null, cachedAt: now }; }
}

router.post('/force-join/check', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const channels = getForceJoinChannels();
  if (!channels.length) return res.json({ allJoined: true, channels: [] });
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  const results = await Promise.all(channels.map(async (ch) => {
    const [memberData, info] = await Promise.all([
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(ch.id)}&user_id=${encodeURIComponent(userId)}`).then(r => r.json()).catch(() => ({})),
      getChannelInfo(ch.id, BOT_TOKEN),
    ]);
    const status = memberData.result && memberData.result.status;
    const joined = ['member','administrator','creator'].includes(status);
    return { id: ch.id, name: ch.name !== ('Channel '+(channels.indexOf(ch)+1)) ? ch.name : (info.title||ch.name), link: ch.link||info.redirectLink||null, photoUrl: info.photoUrl||null, joined, status: status||'not_member' };
  }));
  res.json({ allJoined: results.every(c => c.joined), channels: results });
});

// ── Auto-Lecture ──────────────────────────────────────────────────────────────

router.get('/auto-lecture/status', verifyAdmin, (req, res) => { res.json(autoLectureSession); });

router.post('/auto-lecture/start', verifyAdmin, async (req, res) => {
  const { batchId, subjectId, chapterId, unitId, batchName, subjectName, chapterName, unitName } = req.body;
  if (!batchId || !subjectId || !chapterId) return res.status(400).json({ error: 'batchId, subjectId, chapterId required' });
  try {
    const batchData = db.batch.getOne(batchId);
    const subj = batchData && (batchData.subjects||[]).find(s => String(s._id)===subjectId);
    const chap = subj && (subj.chapters||[]).find(c => String(c._id)===chapterId);
    if (!chap) return res.status(404).json({ error: 'Chapter not found' });
    let existingCount = unitId ? ((chap.units||[]).find(u => String(u._id)===unitId)?.lectures||[]).length : (chap.lectures||[]).length;
    Object.assign(autoLectureSession, { active: true, batchId, subjectId, chapterId, unitId: unitId||null, lectureCount: existingCount, batchName: batchName||'', subjectName: subjectName||'', chapterName: chapterName||'', unitName: unitName||'' });
    await _saveAutoSession();
    res.json({ success: true, session: autoLectureSession });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auto-lecture/stop', verifyAdmin, async (req, res) => {
  const totalAdded = autoLectureSession.lectureCount;
  Object.assign(autoLectureSession, { active: false, batchId: null, subjectId: null, chapterId: null, unitId: null, lectureCount: 0, batchName: '', subjectName: '', chapterName: '', unitName: '' });
  await _saveAutoSession();
  res.json({ success: true, totalAdded });
});

router.autoLectureSession = autoLectureSession;
router.autoAddLecture = autoAddLecture;
router.saveAutoSession = _saveAutoSession;

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  try {
    const batches = db.batch.getAll();
    const totalBatches = batches.length;
    const publicBatches = batches.filter(b => b.isPublic).length;
    let totalSubjects=0, totalChapters=0, totalLectures=0;
    batches.forEach(b => {
      totalSubjects += (b.subjects||[]).length;
      (b.subjects||[]).forEach(s => {
        totalChapters += (s.chapters||[]).length;
        (s.chapters||[]).forEach(c => {
          totalLectures += (c.lectures||[]).length;
          (c.units||[]).forEach(u => { totalLectures += (u.lectures||[]).length; });
        });
      });
    });

    // Total spin points awarded across all users
    const totalSpinPointsRow = db.getDb().prepare(`SELECT SUM(points) as t FROM spin_points`).get();
    const totalSpinPoints = totalSpinPointsRow ? (totalSpinPointsRow.t || 0) : 0;
    const totalSpinners = db.getDb().prepare(`SELECT COUNT(DISTINCT userId) as c FROM spin_points`).get().c || 0;

    // Today's spins
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todaySpins = db.getDb().prepare(`SELECT COUNT(*) as c FROM spin_points WHERE createdAt >= ?`).get(dayStart).c || 0;

    // Points redeemed total
    const totalRedeemedRow = db.getDb().prepare(`SELECT SUM(pointsUsed) as t FROM points_usage`).get();
    const totalRedeemed = totalRedeemedRow ? (totalRedeemedRow.t || 0) : 0;

    // New users today
    const newToday = db.getDb().prepare(`SELECT COUNT(*) as c FROM users WHERE firstSeen >= ?`).get(dayStart).c || 0;

    res.json({
      content: { totalBatches, publicBatches, privateBatches: totalBatches - publicBatches, totalSubjects, totalChapters, totalLectures },
      users: { totalUsers: db.user.count(), recentUsers: db.user.countSince(Date.now() - 7*24*60*60*1000), newToday },
      access: { totalAccess: db.access.count(), activeAccess: db.access.countActive(), grantedToday: db.access.countToday() },
      referrals: { totalReferrals: db.referral.count(), uniqueReferrers: db.referral.distinctReferrers() },
      points: { totalSpinPoints, totalSpinners, todaySpins, totalRedeemed },
      files: { total: db.fileRecord.count(), bulk: db.bulkBatch.count() },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Coupons ───────────────────────────────────────────────────────────────────

const couponSchema = new mongoose.Schema({ code: { type: String, required: true, unique: true, uppercase: true, trim: true }, discountPct: { type: Number, required: true }, expiresAt: { type: Date, required: true }, isActive: { type: Boolean, default: true }, usageCount: { type: Number, default: 0 }, batchIds: [{ type: String }], createdAt: { type: Date, default: Date.now } });
const Coupon = mongoose.model('Coupon', couponSchema);

router.get('/coupons', verifyAdmin, (req, res) => {
  try { res.json(db.coupon.getAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/coupons', verifyAdmin, async (req, res) => {
  try {
    const { code, discountPct, expiresAt, isActive, batchIds } = req.body;
    if (!code || !discountPct || !expiresAt) return res.status(400).json({ error: 'code, discountPct, expiresAt required' });
    const cId = new (require('mongoose').Types.ObjectId)().toString();
    const cCode = code.toUpperCase().trim();
    const cExpiry = new Date(expiresAt);
    const cBatchIds = Array.isArray(batchIds) ? batchIds.filter(Boolean) : [];
    db.coupon.insert({ id: cId, code: cCode, discountPct: Number(discountPct), expiresAt: cExpiry, isActive: isActive!==false, batchIds: cBatchIds, createdAt: new Date() });
    if (isMongo()) Coupon.create({ _id: cId, code: cCode, discountPct: Number(discountPct), expiresAt: cExpiry, isActive: isActive!==false, batchIds: cBatchIds }).catch(() => {});
    res.json(db.coupon.findById(cId));
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Coupon code already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/coupons/:id', verifyAdmin, async (req, res) => {
  try {
    db.coupon.delete(req.params.id);
    if (isMongo()) Coupon.findByIdAndDelete(req.params.id).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/coupons/:id/toggle', verifyAdmin, async (req, res) => {
  try {
    const c = db.coupon.toggle(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    // MongoDB backup
    Coupon.findByIdAndUpdate(req.params.id, { isActive: c.isActive }).catch(() => {});
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/coupons/validate', (req, res) => {
  try {
    const { code, batchId } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const coupon = db.coupon.findByCode(code);
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon code' });
    if (!coupon.isActive) return res.status(400).json({ error: 'Coupon is inactive' });
    if (coupon.expiresAt < new Date()) return res.status(400).json({ error: 'Coupon has expired' });
    if (coupon.batchIds && coupon.batchIds.length > 0) {
      if (!batchId || !coupon.batchIds.includes(String(batchId))) return res.status(400).json({ error: 'This coupon is not valid for this batch' });
    }
    res.json({ valid: true, discountPct: coupon.discountPct, code: coupon.code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
