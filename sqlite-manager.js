/**
 * sqlite-manager.js
 * ─────────────────
 * Single source of truth for ALL SQLite operations.
 * Strategy:
 *   READ  → SQLite (primary, fast)
 *   WRITE → SQLite first, then MongoDB async (backup only)
 *   STARTUP → sync from MongoDB into SQLite
 */

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'bot_cache.db');
let _db = null;

function getDb() {
  if (!_db) {
    _db = new BetterSqlite3(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _setupTables(_db);
  }
  return _db;
}

// ── Table Setup ───────────────────────────────────────────────────────────────

function _setupTables(db) {
  db.exec(`
    -- Batches (full document stored as JSON blob for simplicity)
    CREATE TABLE IF NOT EXISTS batches (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER DEFAULT 0
    );

    -- Users
    CREATE TABLE IF NOT EXISTS users (
      userId    TEXT PRIMARY KEY,
      firstName TEXT DEFAULT '',
      lastName  TEXT DEFAULT '',
      username  TEXT DEFAULT '',
      firstSeen INTEGER DEFAULT 0,
      lastSeen  INTEGER DEFAULT 0
    );

    -- Announcements
    CREATE TABLE IF NOT EXISTS announcements (
      id        TEXT PRIMARY KEY,
      emoji     TEXT DEFAULT '📢',
      heading   TEXT NOT NULL,
      body      TEXT NOT NULL,
      createdAt INTEGER DEFAULT 0
    );

    -- Access tokens (ad-watch access)
    CREATE TABLE IF NOT EXISTS access (
      userId      TEXT PRIMARY KEY,
      expiresAt   INTEGER DEFAULT 0,
      claimsToday INTEGER DEFAULT 0,
      claimDay    TEXT DEFAULT ''
    );

    -- Ad tokens (one-time tokens before ad)
    CREATE TABLE IF NOT EXISTS ad_tokens (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      token     TEXT NOT NULL UNIQUE,
      issuedAt  INTEGER DEFAULT 0,
      expiresAt INTEGER DEFAULT 0
    );

    -- Referrals
    CREATE TABLE IF NOT EXISTS referrals (
      id          TEXT PRIMARY KEY,
      referrerId  TEXT NOT NULL,
      referredId  TEXT NOT NULL UNIQUE,
      createdAt   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrerId);

    -- Coupons
    CREATE TABLE IF NOT EXISTS coupons (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      discountPct REAL NOT NULL,
      expiresAt   INTEGER DEFAULT 0,
      isActive    INTEGER DEFAULT 1,
      usageCount  INTEGER DEFAULT 0,
      batchIds    TEXT DEFAULT '[]',
      createdAt   INTEGER DEFAULT 0
    );

    -- Auto lecture session (singleton)
    CREATE TABLE IF NOT EXISTS auto_lec_session (
      id           TEXT PRIMARY KEY DEFAULT 'singleton',
      active       INTEGER DEFAULT 0,
      batchId      TEXT,
      subjectId    TEXT,
      chapterId    TEXT,
      unitId       TEXT,
      lectureCount INTEGER DEFAULT 0,
      batchName    TEXT DEFAULT '',
      subjectName  TEXT DEFAULT '',
      chapterName  TEXT DEFAULT '',
      unitName     TEXT DEFAULT ''
    );

    -- File records
    CREATE TABLE IF NOT EXISTS file_records (
      id             TEXT PRIMARY KEY,
      code           TEXT NOT NULL UNIQUE,
      file_id        TEXT NOT NULL,
      file_type      TEXT NOT NULL,
      file_name      TEXT DEFAULT 'file',
      uploaded_by    INTEGER,
      expires_at     INTEGER DEFAULT NULL,
      delivered_to   TEXT DEFAULT '[]',
      created_at     INTEGER DEFAULT 0,
      channel_msg_id INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_records_code ON file_records(code);
    CREATE INDEX IF NOT EXISTS idx_file_records_uploader ON file_records(uploaded_by);

    -- Bulk batches
    CREATE TABLE IF NOT EXISTS bulk_batches (
      id          TEXT PRIMARY KEY,
      batch_code  TEXT NOT NULL UNIQUE,
      user_id     INTEGER NOT NULL,
      files       TEXT DEFAULT '[]',
      created_at  INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_batches_code ON bulk_batches(batch_code);
    CREATE INDEX IF NOT EXISTS idx_bulk_batches_user ON bulk_batches(user_id);

    -- Pending deletes
    CREATE TABLE IF NOT EXISTS pending_deletes (
      id         TEXT PRIMARY KEY,
      chat_id    INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      delete_at  INTEGER NOT NULL
    );

    -- Daily video limits
    CREATE TABLE IF NOT EXISTS daily_video_limits (
      userId    INTEGER PRIMARY KEY,
      count     INTEGER DEFAULT 0,
      resetDate TEXT NOT NULL
    );

    -- Pending referrals (confirmed hone se pehle)
    CREATE TABLE IF NOT EXISTS pending_referrals (
      referredId  TEXT PRIMARY KEY,
      referrerId  TEXT NOT NULL,
      confirmed   INTEGER DEFAULT 0,
      createdAt   INTEGER DEFAULT 0
    );

    -- Points usage (redeem history)
    CREATE TABLE IF NOT EXISTS points_usage (
      id          TEXT PRIMARY KEY,
      userId      TEXT NOT NULL,
      pointsUsed  INTEGER NOT NULL,
      tier        TEXT,
      batchId     TEXT,
      createdAt   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_points_usage_user ON points_usage(userId);
  `);
}

// ── Startup Sync from MongoDB ─────────────────────────────────────────────────

async function syncFromMongo(mongoose) {
  const db = getDb();
  console.log('🔄 Syncing from MongoDB to SQLite...');

  try {
    // 1. Batches
    const Batch = mongoose.model('Batch');
    const batches = await Batch.find({}).lean();
    const upsertBatch = db.prepare(`INSERT INTO batches(id,data,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
    const batchTx = db.transaction(() => {
      for (const b of batches) upsertBatch.run(String(b._id), JSON.stringify(b), Date.now());
    });
    batchTx();
    console.log(`  ✅ Batches: ${batches.length}`);
  } catch (e) { console.error('  ❌ Batches sync error:', e.message); }

  try {
    // 2. Users
    const User = mongoose.models.User;
    if (User) {
      const users = await User.find({}).lean();
      const upsertUser = db.prepare(`INSERT INTO users(userId,firstName,lastName,username,firstSeen,lastSeen)
        VALUES(?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET
        firstName=excluded.firstName, lastName=excluded.lastName,
        username=excluded.username, lastSeen=excluded.lastSeen`);
      const userTx = db.transaction(() => {
        for (const u of users) upsertUser.run(
          u.userId, u.firstName||'', u.lastName||'', u.username||'',
          new Date(u.firstSeen||0).getTime(), new Date(u.lastSeen||0).getTime()
        );
      });
      userTx();
      console.log(`  ✅ Users: ${users.length}`);
    }
  } catch (e) { console.error('  ❌ Users sync error:', e.message); }

  try {
    // 3. Announcements
    const Announcement = mongoose.models.Announcement;
    if (Announcement) {
      const anns = await Announcement.find({}).lean();
      const upsertAnn = db.prepare(`INSERT INTO announcements(id,emoji,heading,body,createdAt)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        emoji=excluded.emoji, heading=excluded.heading, body=excluded.body`);
      const annTx = db.transaction(() => {
        for (const a of anns) upsertAnn.run(
          String(a._id), a.emoji||'📢', a.heading, a.body,
          new Date(a.createdAt||0).getTime()
        );
      });
      annTx();
      console.log(`  ✅ Announcements: ${anns.length}`);
    }
  } catch (e) { console.error('  ❌ Announcements sync error:', e.message); }

  try {
    // 4. Access
    const Access = mongoose.models.Access;
    if (Access) {
      const records = await Access.find({}).lean();
      const upsertAccess = db.prepare(`INSERT INTO access(userId,expiresAt,claimsToday,claimDay)
        VALUES(?,?,?,?) ON CONFLICT(userId) DO UPDATE SET
        expiresAt=excluded.expiresAt, claimsToday=excluded.claimsToday, claimDay=excluded.claimDay`);
      const accessTx = db.transaction(() => {
        for (const r of records) upsertAccess.run(
          r.userId, new Date(r.expiresAt||0).getTime(),
          r.claimsToday||0, r.claimDay||''
        );
      });
      accessTx();
      console.log(`  ✅ Access records: ${records.length}`);
    }
  } catch (e) { console.error('  ❌ Access sync error:', e.message); }

  try {
    // 5. Referrals
    const Referral = mongoose.models.Referral;
    if (Referral) {
      const refs = await Referral.find({}).lean();
      const upsertRef = db.prepare(`INSERT INTO referrals(id,referrerId,referredId,createdAt)
        VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const refTx = db.transaction(() => {
        for (const r of refs) upsertRef.run(
          String(r._id), r.referrerId, r.referredId,
          new Date(r.createdAt||0).getTime()
        );
      });
      refTx();
      console.log(`  ✅ Referrals: ${refs.length}`);
    }
  } catch (e) { console.error('  ❌ Referrals sync error:', e.message); }

  try {
    // 6. Coupons
    const Coupon = mongoose.models.Coupon;
    if (Coupon) {
      const coupons = await Coupon.find({}).lean();
      const upsertCoupon = db.prepare(`INSERT INTO coupons(id,code,discountPct,expiresAt,isActive,usageCount,batchIds,createdAt)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        code=excluded.code, discountPct=excluded.discountPct, expiresAt=excluded.expiresAt,
        isActive=excluded.isActive, usageCount=excluded.usageCount, batchIds=excluded.batchIds`);
      const couponTx = db.transaction(() => {
        for (const c of coupons) upsertCoupon.run(
          String(c._id), c.code, c.discountPct,
          new Date(c.expiresAt||0).getTime(),
          c.isActive ? 1 : 0, c.usageCount||0,
          JSON.stringify(c.batchIds||[]),
          new Date(c.createdAt||0).getTime()
        );
      });
      couponTx();
      console.log(`  ✅ Coupons: ${coupons.length}`);
    }
  } catch (e) { console.error('  ❌ Coupons sync error:', e.message); }

  try {
    // 7. AutoLecSession
    const AutoLecSession = mongoose.models.AutoLecSession;
    if (AutoLecSession) {
      const sess = await AutoLecSession.findById('singleton').lean();
      if (sess) {
        db.prepare(`INSERT INTO auto_lec_session(id,active,batchId,subjectId,chapterId,unitId,lectureCount,batchName,subjectName,chapterName,unitName)
          VALUES('singleton',?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET active=excluded.active,batchId=excluded.batchId,
          subjectId=excluded.subjectId,chapterId=excluded.chapterId,unitId=excluded.unitId,
          lectureCount=excluded.lectureCount,batchName=excluded.batchName,
          subjectName=excluded.subjectName,chapterName=excluded.chapterName,unitName=excluded.unitName`
        ).run(
          sess.active?1:0, sess.batchId||null, sess.subjectId||null,
          sess.chapterId||null, sess.unitId||null, sess.lectureCount||0,
          sess.batchName||'', sess.subjectName||'', sess.chapterName||'', sess.unitName||''
        );
        console.log(`  ✅ AutoLecSession synced`);
      }
    }
  } catch (e) { console.error('  ❌ AutoLecSession sync error:', e.message); }

  try {
    // 8. FileRecords
    const FileRecord = mongoose.models.FileRecord;
    if (FileRecord) {
      const files = await FileRecord.find({}).lean();
      const upsertFile = db.prepare(`INSERT INTO file_records(id,code,file_id,file_type,file_name,uploaded_by,expires_at,delivered_to,created_at,channel_msg_id)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        file_id=excluded.file_id,delivered_to=excluded.delivered_to,channel_msg_id=excluded.channel_msg_id`);
      const fileTx = db.transaction(() => {
        for (const f of files) upsertFile.run(
          String(f._id), f.code, f.file_id, f.file_type, f.file_name||'file',
          f.uploaded_by||null,
          f.expires_at ? new Date(f.expires_at).getTime() : null,
          JSON.stringify(f.delivered_to||[]),
          new Date(f.created_at||0).getTime(),
          f.channel_msg_id||null
        );
      });
      fileTx();
      console.log(`  ✅ FileRecords: ${files.length}`);
    }
  } catch (e) { console.error('  ❌ FileRecords sync error:', e.message); }

  try {
    // 9. BulkBatches
    const BulkBatch = mongoose.models.BulkBatch;
    if (BulkBatch) {
      const bulks = await BulkBatch.find({}).lean();
      const upsertBulk = db.prepare(`INSERT INTO bulk_batches(id,batch_code,user_id,files,created_at)
        VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET files=excluded.files`);
      const bulkTx = db.transaction(() => {
        for (const b of bulks) upsertBulk.run(
          String(b._id), b.batch_code, b.user_id,
          JSON.stringify(b.files||[]),
          new Date(b.created_at||0).getTime()
        );
      });
      bulkTx();
      console.log(`  ✅ BulkBatches: ${bulks.length}`);
    }
  } catch (e) { console.error('  ❌ BulkBatches sync error:', e.message); }

  try {
    // 10. PendingDeletes
    const PendingDelete = mongoose.models.PendingDelete;
    if (PendingDelete) {
      const pds = await PendingDelete.find({}).lean();
      const upsertPD = db.prepare(`INSERT INTO pending_deletes(id,chat_id,message_id,delete_at)
        VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      const pdTx = db.transaction(() => {
        for (const p of pds) upsertPD.run(
          String(p._id), p.chat_id, p.message_id,
          new Date(p.delete_at).getTime()
        );
      });
      pdTx();
      console.log(`  ✅ PendingDeletes: ${pds.length}`);
    }
  } catch (e) { console.error('  ❌ PendingDeletes sync error:', e.message); }

  try {
    // 11. DailyVideoLimits
    const DailyVideoLimit = mongoose.models.DailyVideoLimit;
    if (DailyVideoLimit) {
      const limits = await DailyVideoLimit.find({}).lean();
      const upsertLimit = db.prepare(`INSERT INTO daily_video_limits(userId,count,resetDate)
        VALUES(?,?,?) ON CONFLICT(userId) DO UPDATE SET count=excluded.count, resetDate=excluded.resetDate`);
      const limitTx = db.transaction(() => {
        for (const l of limits) upsertLimit.run(l.userId, l.count||0, l.resetDate||'');
      });
      limitTx();
      console.log(`  ✅ DailyVideoLimits: ${limits.length}`);
    }
  } catch (e) { console.error('  ❌ DailyVideoLimits sync error:', e.message); }

  console.log('✅ SQLite sync complete');
}

// ── BATCH Operations ──────────────────────────────────────────────────────────

const batch = {
  getAll() {
    const rows = getDb().prepare(`SELECT data FROM batches ORDER BY json_extract(data,'$.order') ASC`).all();
    return rows.map(r => JSON.parse(r.data));
  },
  getOne(id) {
    const row = getDb().prepare(`SELECT data FROM batches WHERE id=?`).get(id);
    return row ? JSON.parse(row.data) : null;
  },
  upsert(batchObj) {
    getDb().prepare(`INSERT INTO batches(id,data,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
      .run(String(batchObj._id), JSON.stringify(batchObj), Date.now());
  },
  delete(id) {
    getDb().prepare(`DELETE FROM batches WHERE id=?`).run(id);
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM batches`).get().c;
  },
};

// ── USER Operations ───────────────────────────────────────────────────────────

const user = {
  upsert({ userId, firstName, lastName, username, firstSeen, lastSeen }) {
    getDb().prepare(`INSERT INTO users(userId,firstName,lastName,username,firstSeen,lastSeen)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET firstName=excluded.firstName,
      lastName=excluded.lastName, username=excluded.username, lastSeen=excluded.lastSeen`)
      .run(userId, firstName||'', lastName||'', username||'',
        new Date(firstSeen||Date.now()).getTime(),
        new Date(lastSeen||Date.now()).getTime());
  },
  findOne(userId) {
    return getDb().prepare(`SELECT * FROM users WHERE userId=?`).get(userId);
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM users`).get().c;
  },
  countSince(timestamp) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM users WHERE firstSeen >= ?`).get(timestamp).c;
  },
  getAll() {
    return getDb().prepare(`SELECT userId FROM users`).all();
  },
};

// ── ANNOUNCEMENT Operations ───────────────────────────────────────────────────

const announcement = {
  getAll() {
    return getDb().prepare(`SELECT * FROM announcements ORDER BY createdAt DESC LIMIT 20`).all()
      .map(a => ({ ...a, _id: a.id, createdAt: new Date(a.createdAt).toISOString() }));
  },
  insert({ id, emoji, heading, body, createdAt }) {
    getDb().prepare(`INSERT INTO announcements(id,emoji,heading,body,createdAt) VALUES(?,?,?,?,?)`)
      .run(id, emoji||'📢', heading, body, new Date(createdAt||Date.now()).getTime());
  },
  delete(id) {
    getDb().prepare(`DELETE FROM announcements WHERE id=?`).run(id);
  },
};

// ── ACCESS Operations ─────────────────────────────────────────────────────────

const access = {
  findOne(userId) {
    const r = getDb().prepare(`SELECT * FROM access WHERE userId=?`).get(userId);
    if (!r) return null;
    return { ...r, expiresAt: new Date(r.expiresAt), claimsToday: r.claimsToday, claimDay: r.claimDay };
  },
  upsert({ userId, expiresAt, claimsToday, claimDay }) {
    getDb().prepare(`INSERT INTO access(userId,expiresAt,claimsToday,claimDay) VALUES(?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET expiresAt=excluded.expiresAt,
      claimsToday=excluded.claimsToday, claimDay=excluded.claimDay`)
      .run(userId, new Date(expiresAt).getTime(), claimsToday||0, claimDay||'');
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM access`).get().c;
  },
  countActive() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM access WHERE expiresAt > ?`).get(Date.now()).c;
  },
};

// ── AD TOKEN Operations ───────────────────────────────────────────────────────

const adToken = {
  create({ id, userId, token, issuedAt, expiresAt }) {
    getDb().prepare(`INSERT INTO ad_tokens(id,userId,token,issuedAt,expiresAt) VALUES(?,?,?,?,?)`)
      .run(id, userId, token, new Date(issuedAt||Date.now()).getTime(), new Date(expiresAt).getTime());
  },
  findOne({ userId, token }) {
    const r = getDb().prepare(`SELECT * FROM ad_tokens WHERE userId=? AND token=?`).get(userId, token);
    if (!r) return null;
    return { ...r, issuedAt: new Date(r.issuedAt), expiresAt: new Date(r.expiresAt) };
  },
  deleteByUser(userId) {
    getDb().prepare(`DELETE FROM ad_tokens WHERE userId=?`).run(userId);
  },
  deleteById(id) {
    getDb().prepare(`DELETE FROM ad_tokens WHERE id=?`).run(id);
  },
};

// ── REFERRAL Operations ───────────────────────────────────────────────────────

const referral = {
  findByReferred(referredId) {
    return getDb().prepare(`SELECT * FROM referrals WHERE referredId=?`).get(referredId);
  },
  countByReferrer(referrerId) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM referrals WHERE referrerId=?`).get(referrerId).c;
  },
  insert({ id, referrerId, referredId }) {
    getDb().prepare(`INSERT INTO referrals(id,referrerId,referredId,createdAt) VALUES(?,?,?,?)`)
      .run(id, referrerId, referredId, Date.now());
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM referrals`).get().c;
  },
  distinctReferrers() {
    return getDb().prepare(`SELECT COUNT(DISTINCT referrerId) as c FROM referrals`).get().c;
  },
};

// ── COUPON Operations ─────────────────────────────────────────────────────────

const coupon = {
  getAll() {
    return getDb().prepare(`SELECT * FROM coupons ORDER BY createdAt DESC`).all()
      .map(_couponRow);
  },
  findById(id) {
    const r = getDb().prepare(`SELECT * FROM coupons WHERE id=?`).get(id);
    return r ? _couponRow(r) : null;
  },
  findByCode(code) {
    const r = getDb().prepare(`SELECT * FROM coupons WHERE code=?`).get(code.toUpperCase().trim());
    return r ? _couponRow(r) : null;
  },
  insert({ id, code, discountPct, expiresAt, isActive, batchIds, createdAt }) {
    getDb().prepare(`INSERT INTO coupons(id,code,discountPct,expiresAt,isActive,usageCount,batchIds,createdAt)
      VALUES(?,?,?,?,?,0,?,?)`)
      .run(id, code.toUpperCase().trim(), discountPct,
        new Date(expiresAt).getTime(), isActive!==false?1:0,
        JSON.stringify(batchIds||[]), new Date(createdAt||Date.now()).getTime());
  },
  toggle(id) {
    const c = coupon.findById(id);
    if (!c) return null;
    const newVal = c.isActive ? 0 : 1;
    getDb().prepare(`UPDATE coupons SET isActive=? WHERE id=?`).run(newVal, id);
    return coupon.findById(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM coupons WHERE id=?`).run(id);
  },
};

function _couponRow(r) {
  return {
    ...r,
    _id: r.id,
    isActive: r.isActive === 1,
    expiresAt: new Date(r.expiresAt),
    createdAt: new Date(r.createdAt),
    batchIds: JSON.parse(r.batchIds||'[]'),
  };
}

// ── AUTO LEC SESSION Operations ───────────────────────────────────────────────

const autoLec = {
  load() {
    const r = getDb().prepare(`SELECT * FROM auto_lec_session WHERE id='singleton'`).get();
    if (!r) return { active:false, batchId:null, subjectId:null, chapterId:null, unitId:null, lectureCount:0, batchName:'', subjectName:'', chapterName:'', unitName:'' };
    return { ...r, active: r.active===1 };
  },
  save(session) {
    getDb().prepare(`INSERT INTO auto_lec_session(id,active,batchId,subjectId,chapterId,unitId,lectureCount,batchName,subjectName,chapterName,unitName)
      VALUES('singleton',?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET active=excluded.active,batchId=excluded.batchId,
      subjectId=excluded.subjectId,chapterId=excluded.chapterId,unitId=excluded.unitId,
      lectureCount=excluded.lectureCount,batchName=excluded.batchName,
      subjectName=excluded.subjectName,chapterName=excluded.chapterName,unitName=excluded.unitName`)
      .run(session.active?1:0, session.batchId||null, session.subjectId||null,
        session.chapterId||null, session.unitId||null, session.lectureCount||0,
        session.batchName||'', session.subjectName||'', session.chapterName||'', session.unitName||'');
  },
};

// ── FILE RECORD Operations ────────────────────────────────────────────────────

const fileRecord = {
  create({ id, code, file_id, file_type, file_name, uploaded_by, channel_msg_id }) {
    getDb().prepare(`INSERT INTO file_records(id,code,file_id,file_type,file_name,uploaded_by,expires_at,delivered_to,created_at,channel_msg_id)
      VALUES(?,?,?,?,?,?,NULL,'[]',?,?)`)
      .run(id, code, file_id, file_type, file_name||'file', uploaded_by||null, Date.now(), channel_msg_id||null);
  },
  findByCode(code) {
    const r = getDb().prepare(`SELECT * FROM file_records WHERE code=? COLLATE NOCASE`).get(code);
    return r ? _fileRow(r) : null;
  },
  findById(id) {
    const r = getDb().prepare(`SELECT * FROM file_records WHERE id=?`).get(id);
    return r ? _fileRow(r) : null;
  },
  findByUploader(userId) {
    return getDb().prepare(`SELECT * FROM file_records WHERE uploaded_by=?`).all(userId).map(_fileRow);
  },
  countByUploader(userId) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM file_records WHERE uploaded_by=?`).get(userId).c;
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM file_records`).get().c;
  },
  addDeliveredTo(id, chatId) {
    const r = getDb().prepare(`SELECT delivered_to FROM file_records WHERE id=?`).get(id);
    if (!r) return;
    const arr = JSON.parse(r.delivered_to||'[]');
    if (!arr.includes(chatId)) { arr.push(chatId); getDb().prepare(`UPDATE file_records SET delivered_to=? WHERE id=?`).run(JSON.stringify(arr), id); }
  },
  removeDeliveredTo(id, chatId) {
    const r = getDb().prepare(`SELECT delivered_to FROM file_records WHERE id=?`).get(id);
    if (!r) return;
    const arr = JSON.parse(r.delivered_to||'[]').filter(x => x !== chatId);
    getDb().prepare(`UPDATE file_records SET delivered_to=? WHERE id=?`).run(JSON.stringify(arr), id);
  },
  deleteByCode(code, uploadedBy) {
    return getDb().prepare(`DELETE FROM file_records WHERE code=? COLLATE NOCASE AND uploaded_by=?`).run(code, uploadedBy).changes > 0;
  },
};

function _fileRow(r) {
  return {
    ...r,
    _id: r.id,
    delivered_to: JSON.parse(r.delivered_to||'[]'),
    created_at: new Date(r.created_at),
    expires_at: r.expires_at ? new Date(r.expires_at) : null,
  };
}

// ── BULK BATCH Operations ─────────────────────────────────────────────────────

const bulkBatch = {
  create({ id, batch_code, user_id, files }) {
    getDb().prepare(`INSERT INTO bulk_batches(id,batch_code,user_id,files,created_at) VALUES(?,?,?,?,?)`)
      .run(id, batch_code, user_id, JSON.stringify(files||[]), Date.now());
  },
  findByCode(code) {
    const r = getDb().prepare(`SELECT * FROM bulk_batches WHERE batch_code=? COLLATE NOCASE`).get(code);
    return r ? _bulkRow(r) : null;
  },
  findByUser(userId) {
    return getDb().prepare(`SELECT * FROM bulk_batches WHERE user_id=?`).all(userId).map(_bulkRow);
  },
  countByUser(userId) {
    return getDb().prepare(`SELECT COUNT(*) as c FROM bulk_batches WHERE user_id=?`).get(userId).c;
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM bulk_batches`).get().c;
  },
  deleteByCode(code, userId) {
    return getDb().prepare(`DELETE FROM bulk_batches WHERE batch_code=? COLLATE NOCASE AND user_id=?`).run(code, userId).changes > 0;
  },
};

function _bulkRow(r) {
  return { ...r, _id: r.id, files: JSON.parse(r.files||'[]'), created_at: new Date(r.created_at) };
}

// ── PENDING DELETE Operations ─────────────────────────────────────────────────

const pendingDelete = {
  create({ id, chat_id, message_id, delete_at }) {
    getDb().prepare(`INSERT INTO pending_deletes(id,chat_id,message_id,delete_at) VALUES(?,?,?,?)`)
      .run(id, chat_id, message_id, new Date(delete_at).getTime());
  },
  getAll() {
    return getDb().prepare(`SELECT * FROM pending_deletes`).all()
      .map(r => ({ ...r, _id: r.id, delete_at: new Date(r.delete_at) }));
  },
  deleteById(id) {
    getDb().prepare(`DELETE FROM pending_deletes WHERE id=?`).run(id);
  },
  deleteByChatMsg(chat_id, message_id) {
    getDb().prepare(`DELETE FROM pending_deletes WHERE chat_id=? AND message_id=?`).run(chat_id, message_id);
  },
};

// ── DAILY VIDEO LIMIT Operations ──────────────────────────────────────────────

const dailyVideoLimit = {
  find(userId) {
    return getDb().prepare(`SELECT * FROM daily_video_limits WHERE userId=?`).get(userId);
  },
  upsert({ userId, count, resetDate }) {
    getDb().prepare(`INSERT INTO daily_video_limits(userId,count,resetDate) VALUES(?,?,?)
      ON CONFLICT(userId) DO UPDATE SET count=excluded.count, resetDate=excluded.resetDate`)
      .run(userId, count||0, resetDate);
  },
};

// ── PENDING REFERRAL Operations ──────────────────────────────────────────────

const pendingReferral = {
  upsert({ referredId, referrerId }) {
    getDb().prepare(`INSERT INTO pending_referrals(referredId,referrerId,confirmed,createdAt)
      VALUES(?,?,0,?) ON CONFLICT(referredId) DO NOTHING`)
      .run(referredId, referrerId, Date.now());
  },
  findByReferred(referredId) {
    return getDb().prepare(`SELECT * FROM pending_referrals WHERE referredId=? AND confirmed=0`).get(referredId);
  },
  confirm(referredId) {
    getDb().prepare(`UPDATE pending_referrals SET confirmed=1 WHERE referredId=?`).run(referredId);
  },
};

// ── POINTS USAGE Operations ───────────────────────────────────────────────────

const pointsUsage = {
  insert({ id, userId, pointsUsed, tier, batchId }) {
    getDb().prepare(`INSERT INTO points_usage(id,userId,pointsUsed,tier,batchId,createdAt) VALUES(?,?,?,?,?,?)`)
      .run(id, userId, pointsUsed, tier||null, batchId||null, Date.now());
  },
  getTotalUsed(userId) {
    return getDb().prepare(`SELECT SUM(pointsUsed) as total FROM points_usage WHERE userId=?`).get(userId).total || 0;
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget MongoDB backup.
 * Usage: mongoBackup(() => MyModel.findOneAndUpdate(...))
 */
function mongoBackup(fn) {
  fn().catch(err => console.error('⚠️ Mongo backup failed:', err.message));
}

function generateId() {
  return require('crypto').randomBytes(12).toString('hex');
}

module.exports = {
  getDb,
  syncFromMongo,
  mongoBackup,
  batch,
  user,
  announcement,
  access,
  adToken,
  referral,
  pendingReferral,
  pointsUsage,
  coupon,
  autoLec,
  fileRecord,
  bulkBatch,
  pendingDelete,
  dailyVideoLimit,
  generateId,
};
