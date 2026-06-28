require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./sqlite-manager");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const WEB_URL = process.env.WEB_URL;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID) : null;
const UPI_ID = process.env.UPI_ID || "";
const PAYMENT_GROUP_ID = process.env.PAYMENT_GROUP_ID ? parseInt(process.env.PAYMENT_GROUP_ID) : null;
const CONTACT_LINK = process.env.CONTACT_LINK || "";

let BOT_USERNAME = "";
let bot = null;

if (!TOKEN || !WEB_URL || !OWNER_ID) { console.error("Missing env: BOT_TOKEN, WEB_URL, OWNER_ID are required."); process.exit(1); }
if (!MONGO_URI) console.warn("⚠️  MONGO_URI not set — SQLite-only mode (no Mongo backup).");
if (!STORAGE_CHANNEL_ID) console.warn("Warning: STORAGE_CHANNEL_ID not set.");

function isOwner(userId) { return userId === OWNER_ID; }
function isGroupChat(msg) { return msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup"); }

// ── MongoDB Schemas (for backup writes only) ──────────────────────────────────
const fileSchema = new mongoose.Schema({ code: { type: String, required: true, unique: true }, file_id: { type: String, required: true }, file_type: { type: String, required: true }, file_name: { type: String, default: "file" }, uploaded_by: Number, expires_at: { type: Date, default: null }, delivered_to: [Number], created_at: { type: Date, default: Date.now }, channel_msg_id: { type: Number, default: null } });
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({ batch_code: { type: String, required: true, unique: true }, user_id: Number, files: [{ file_id: String, file_type: String, file_name: { type: String, default: "file" } }], created_at: { type: Date, default: Date.now } });
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({ chat_id: Number, message_id: Number, delete_at: Date });
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

const userSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, firstName: { type: String, default: "" }, lastName: { type: String, default: "" }, username: { type: String, default: "" }, firstSeen: { type: Date, default: Date.now }, lastSeen: { type: Date, default: Date.now } });
const User = mongoose.model("User", userSchema);

const dailyLimitSchema = new mongoose.Schema({ userId: { type: Number, required: true, unique: true }, count: { type: Number, default: 0 }, resetDate: { type: String, required: true } });
const DailyVideoLimit = mongoose.model("DailyVideoLimit", dailyLimitSchema);
const DAILY_VIDEO_LIMIT = 10;

// ── MongoDB connect (optional — SQLite is primary) ────────────────────────────
let mongoConnected = false;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(async () => {
    mongoConnected = true;
    console.log("✅ MongoDB connected (backup mode)");
    try { await mongoose.connection.collection("filerecords").dropIndex("expires_at_1"); } catch (e) {}
    try { await mongoose.connection.collection("filerecords").updateMany({ expires_at: { $ne: null } }, { $set: { expires_at: null } }); } catch (e) {}
    // Sync MongoDB → SQLite on startup
    await db.syncFromMongo(mongoose);

    // Periodic re-sync every 5 minutes — catches any drift between MongoDB and SQLite
    // Only syncs batches (most critical) to keep it lightweight
    setInterval(async () => {
      if (!mongoConnected) return;
      try {
        const Batch = mongoose.model('Batch');
        const batches = await Batch.find({}).lean();
        const upsertBatch = db.getDb().prepare(`INSERT INTO batches(id,data,updated_at) VALUES(?,?,?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
        const tx = db.getDb().transaction(() => {
          for (const b of batches) upsertBatch.run(String(b._id), JSON.stringify(b), Date.now());
        });
        tx();
        console.log(`[AutoSync] Batches re-synced: ${batches.length}`);
      } catch(e) { console.warn('[AutoSync] Error:', e.message); }
    }, 5 * 60 * 1000); // Every 5 minutes
  }).catch((err) => {
    console.warn("⚠️  MongoDB connection failed:", err.message, "— running SQLite-only.");
  });
} else {
  console.log("ℹ️  No MONGO_URI — SQLite-only mode.");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTodayIST() { const now = new Date(); return new Date(now.getTime() + 5.5*60*60*1000).toISOString().slice(0,10); }

function checkAndIncrementVideoLimit(userId) {
  const today = getTodayIST();
  let rec = db.dailyVideoLimit.find(userId);
  if (!rec || rec.resetDate !== today) { db.dailyVideoLimit.upsert({ userId, count: 0, resetDate: today }); rec = { count: 0 }; }
  if (rec.count >= DAILY_VIDEO_LIMIT) return { allowed: false, used: rec.count, remaining: 0 };
  const newCount = rec.count + 1;
  db.dailyVideoLimit.upsert({ userId, count: newCount, resetDate: today });
  if (mongoConnected) DailyVideoLimit.findOneAndUpdate({ userId }, { userId, count: newCount, resetDate: today }, { upsert: true }).catch(() => {});
  return { allowed: true, used: newCount, remaining: DAILY_VIDEO_LIMIT - newCount };
}

function generateCode() { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; let c=""; for(let i=0;i<6;i++) c+=chars[Math.floor(Math.random()*chars.length)]; return c; }
function getUniqueCode() { let c; do { c = generateCode(); } while (db.fileRecord.findByCode(c)); return c; }
function getUniqueBatchCode() { let c; do { c = "B"+generateCode(); } while (db.bulkBatch.findByCode(c)); return c; }

function extractFileInfo(msg) {
  const caption = msg.caption || null;
  if (msg.document)   return { file_id: msg.document.file_id, file_type: "document", file_name: msg.document.file_name||"document", caption };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg", caption };
  if (msg.video)      return { file_id: msg.video.file_id, file_type: "video", file_name: msg.video.file_name||"video.mp4", caption };
  if (msg.audio)      return { file_id: msg.audio.file_id, file_type: "audio", file_name: msg.audio.file_name||"audio.mp3", caption };
  if (msg.voice)      return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg", caption };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4", caption: null };
  return null;
}

async function saveToStorageChannel(bot, fileInfo) {
  if (!STORAGE_CHANNEL_ID) return fileInfo;
  try {
    let sentMsg;
    // Caption is just the plain file_name — same name as stored/shown in DB,
    // no emoji prefix, no original Telegram caption.
    const caption = fileInfo.file_name;
    switch(fileInfo.file_type) {
      case "photo":      sentMsg = await bot.sendPhoto(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video":      sentMsg = await bot.sendVideo(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "audio":      sentMsg = await bot.sendAudio(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "voice":      sentMsg = await bot.sendVoice(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video_note": sentMsg = await bot.sendVideoNote(STORAGE_CHANNEL_ID, fileInfo.file_id); break;
      default:           sentMsg = await bot.sendDocument(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
    }
    const channelFileInfo = extractFileInfo(sentMsg);
    if (channelFileInfo) return { ...channelFileInfo, file_name: fileInfo.file_name, channel_msg_id: sentMsg.message_id };
    return { ...fileInfo, channel_msg_id: sentMsg.message_id };
  } catch (err) { console.error("saveToStorageChannel failed:", err.message); return fileInfo; }
}

async function sendFile(bot, chatId, record) {
  const caption = record.file_name;
  const protect = !isOwner(chatId);
  try {
    switch(record.file_type) {
      case "photo":      return await bot.sendPhoto(chatId, record.file_id, { caption });
      case "video":      return await bot.sendVideo(chatId, record.file_id, { caption, protect_content: protect });
      case "audio":      return await bot.sendAudio(chatId, record.file_id, { caption });
      case "voice":      return await bot.sendVoice(chatId, record.file_id, { caption });
      case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: protect });
      default:           return await bot.sendDocument(chatId, record.file_id, { caption, filename: record.file_name });
    }
  } catch (err) {
    if (STORAGE_CHANNEL_ID && record.channel_msg_id) {
      // Use copyMessage, NOT forwardMessage — forwardMessage shows a
      // "Forwarded from <Storage Channel>" header to the user, leaking
      // the storage channel's name/identity. copyMessage delivers the
      // same content with no forward attribution.
      // IMPORTANT: explicitly pass caption here too — without it,
      // copyMessage just copies whatever caption is currently sitting
      // on the storage channel message (which may be stale/original
      // if that message was saved before the caption fix), instead of
      // using record.file_name like the direct-send path above.
      try { return await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, record.channel_msg_id, { caption, protect_content: protect }); } catch (_) {}
    }
    throw err;
  }
}

let rmWords = [];
function cleanFileName(name) {
  if (!rmWords.length) return name;
  const extMatch = name.match(/(\.[a-zA-Z0-9]{1,6})$/);
  let result = extMatch ? name.slice(0,-extMatch[1].length) : name;
  for (const w of rmWords) { const wN=w.toLowerCase().replace(/_/g," "); let rN=result.toLowerCase().replace(/_/g," "); let idx; while((idx=rN.indexOf(wN))!==-1){result=result.slice(0,idx)+result.slice(idx+w.length);rN=result.toLowerCase().replace(/_/g," ");} }
  result = result.replace(/[_ .\-:]{2,}/g,"_").replace(/^[_ .\-:]+|[_ .\-:]+$/g,"").trim();
  return (extMatch ? result+extMatch[1] : result) || name;
}

async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  const id = db.generateId();
  db.pendingDelete.create({ id, chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  if (mongoConnected) PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt }).catch(() => {});
  const delay = Math.max(0, new Date(deleteAt) - Date.now());
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, messageId); } catch (err) { if (!err.message?.includes("message to delete not found")) console.error("Auto DM deletion error:", err.message); }
    db.pendingDelete.deleteByChatMsg(chatId, messageId);
    if (mongoConnected) PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }, delay);
}

async function recoverPendingDeletes(bot) {
  const pending = db.pendingDelete.getAll();
  console.log(`Recovering ${pending.length} pending DM deletions...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try { await bot.deleteMessage(p.chat_id, p.message_id); } catch (err) { console.error("Recovered deletion error:", err.message); }
      db.pendingDelete.deleteById(p._id);
      if (mongoConnected) PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), mongo: mongoose.connection.readyState===1?"connected":"disconnected", sqlite: "active" }));
app.get("/api/config", (req, res) => {
  const fj = (process.env.FORCE_JOIN_CHANNELS||"").split(",").map(s=>s.trim()).filter(Boolean);
  res.json({ ownerId: OWNER_ID, botUsername: BOT_USERNAME||"", forceJoinRequired: fj.length>0, upiId: UPI_ID||"", contactLink: CONTACT_LINK||`https://t.me/${BOT_USERNAME}` });
});

const courseRoutes = require("./routes/course");
app.use("/api", courseRoutes);
const autoLectureSession = courseRoutes.autoLectureSession;
const autoAddLecture = courseRoutes.autoAddLecture;

app.post("/api/pay-request", async (req, res) => {
  try {
    const { batchId, userId, firstName, lastName, username, txnId, screenshotBase64, couponCode, discountPct, finalAmount } = req.body;
    if (!batchId || !txnId) return res.status(400).json({ error: "Missing fields" });
    const batchData = db.batch.getOne(batchId);
    const batchName = batchData ? batchData.name : batchId;
    const origPrice = batchData?.price ? `₹${batchData.price}` : "N/A";
    let priceLine = `💰 Amount: <b>${esc(origPrice)}</b>`;
    if (couponCode && discountPct && finalAmount!=null) priceLine = `💰 Original: <b>${esc(origPrice)}</b>\n🎟 Coupon: <code>${esc(couponCode)}</code> (${esc(String(discountPct))}% off)\n✅ Final: <b>₹${esc(String(finalAmount))}</b>`;
    const caption = `💸 <b>New Payment Request!</b>\n\n👤 <b>${esc(firstName)}${lastName?" "+esc(lastName):""}</b>\n🆔 UID: <code>${esc(userId)}</code>\n📱 @${username||"N/A"}\n\n📚 Batch: <b>${esc(batchName)}</b>\n${priceLine}\n🔖 UTR: <code>${esc(txnId)}</code>`;
    if (!PAYMENT_GROUP_ID) return res.status(500).json({ error: "PAYMENT_GROUP_ID not configured" });
    const kb = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `pay_approve_${batchId}_${userId}` },{ text: "❌ Reject", callback_data: `pay_reject_${batchId}_${userId}` }]] };
    if (screenshotBase64) { const buf = Buffer.from(screenshotBase64.replace(/^data:image\/\w+;base64,/,""),"base64"); await bot.sendPhoto(PAYMENT_GROUP_ID, buf, { caption, parse_mode:"HTML", filename:`payment_${userId}.jpg`, reply_markup: kb }); }
    else await bot.sendMessage(PAYMENT_GROUP_ID, caption, { parse_mode:"HTML", reply_markup: kb });
    res.json({ success: true });
  } catch (err) { console.error("Payment request error:", err.message); res.status(500).json({ error: err.message }); }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Bulk sessions ─────────────────────────────────────────────────────────────
const bulkSessions = new Map();
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// ── Bot startup ───────────────────────────────────────────────────────────────
async function startBot() {
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(10000) }); } catch (_) {}
  console.log("Clearing old polling...");

  for (let attempt=1; attempt<=5; attempt++) {
    try { bot = new TelegramBot(TOKEN, { polling: { interval:2000, autoStart:false, params:{ timeout:30 } } }); await bot.getMe(); break; }
    catch (err) { console.error(`Bot init attempt ${attempt} failed`); if(attempt===5) throw err; await wait(5000*attempt); }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);

  // Expose bot globally so course.js routes can send notifications
  global._botInstance = bot;

  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ menu_button:{ type:"web_app", text:"Open EduBot", web_app:{ url:WEB_URL } } }) });
    console.log("Menu button set:", WEB_URL);
  } catch (_) {}

  await recoverPendingDeletes(bot);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = match[1].trim();
    const isNewUser = userId ? !db.user.findOne(String(userId)) : false;

    if (userId) {
      db.user.upsert({ userId: String(userId), firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", firstSeen: new Date(), lastSeen: new Date() });
      if (mongoConnected) User.findOneAndUpdate({ userId: String(userId) }, { userId: String(userId), firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", lastSeen: new Date() }, { upsert: true }).catch(() => {});
    }

    if (param) {
      if (param.startsWith("ref_")) {
        const referrerId = param.replace("ref_","");
        bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚`, { reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } });
        // Sirf pending referral store karo — point milega pehla lecture dekhne ke baad
        if (referrerId && referrerId !== String(userId) && isNewUser) {
          try {
            await fetch(`http://localhost:${PORT}/api/refer/record`, {
              method:"POST", headers:{"Content-Type":"application/json"},
              body: JSON.stringify({ referrerId, referredId: String(userId), isNewUser, pending: true })
            });
          } catch (_) {}
        }
        return;
      }

      if (param.startsWith("buy_")) {
        bot.sendMessage(chatId, `💳 <b>Complete your payment in the app!</b>`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"💳 Pay Now", web_app:{ url:WEB_URL } }]] } });
        return;
      }

      if (param.startsWith("B")) {
        try {
          const batch = db.bulkBatch.findByCode(param);
          if (!batch) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
          let hasVideo = false;
          for (const f of batch.files) {
            const sentMsg = await sendFile(bot, chatId, f);
            if ((f.file_type==="video"||f.file_type==="video_note") && sentMsg) { hasVideo=true; await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000)); }
          }
          if (hasVideo) await bot.sendMessage(chatId, `⚠️ Videos will auto-delete after 6 hours.`);
          return;
        } catch (err) { return bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      }

      // Single file
      try {
        const record = db.fileRecord.findByCode(param);
        if (!record) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
        const isVideo = record.file_type==="video"||record.file_type==="video_note";

        // Check if video was recently delivered (within last 6 hours)
        // After 6hr, Telegram deletes it so we allow re-delivery
        const SIX_HOURS = 6 * 60 * 60 * 1000;
        const deliveryEntry = record.delivered_to.find(x =>
          (typeof x === 'object' ? x.chatId : x) === chatId
        );
        const deliveredAt = deliveryEntry ? (typeof deliveryEntry === 'object' ? deliveryEntry.deliveredAt : 0) : null;
        const recentlyDelivered = deliveredAt && (Date.now() - deliveredAt) < SIX_HOURS;

        if (isVideo && recentlyDelivered) {
          const remaining = Math.ceil((SIX_HOURS - (Date.now() - deliveredAt)) / 60000);
          return bot.sendMessage(chatId, `⚠️ This video was already delivered and will auto-delete in <b>${remaining} min</b>. After deletion, you can request it again.`, { parse_mode:"HTML" });
        }
        if (isVideo && !isOwner(userId)) {
          const lim = checkAndIncrementVideoLimit(userId);
          if (!lim.allowed) return bot.sendMessage(chatId, `🚫 <b>Daily limit reached!</b>\n\nYou've watched <b>${DAILY_VIDEO_LIMIT} videos</b> today.\n📅 Resets at midnight.`, { parse_mode:"HTML" });
          const sentMsg = await sendFile(bot, chatId, record);
          await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          db.fileRecord.addDeliveredTo(record.id,chatId);
          if (mongoConnected) FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});

          // Pehla lecture watch hone pe referral confirm karo aur referrer ko +5 points do
          (async () => {
            try {
              const r = await fetch(`http://localhost:${PORT}/api/refer/confirm-first-watch`, {
                method:"POST", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ referredId: String(userId) })
              });
              const d = await r.json();
              if (d.confirmed && d.referrerId) {
                // Fetch updated stats to show correct total
                let totalPts = '?';
                try {
                  const s = await (await fetch(`http://localhost:${PORT}/api/refer/stats/${d.referrerId}`)).json();
                  // +5 points per referral — stats API returns referrals*5 equivalent via spinPoints now
                  // Show raw referral count * 5 as earned points
                  totalPts = s.points !== undefined ? s.points : '?';
                } catch(_) {}

                try {
                  await bot.sendMessage(
                    parseInt(d.referrerId),
                    `🎉 <b>Referral Point Mila!</b>\n\n` +
                    `👤 <b>${msg.from.first_name}</b> ne apna pehla lecture dekha!\n\n` +
                    `⭐ <b>+5 Points</b> aapke account mein add ho gaye!\n` +
                    `💰 <b>Total Points: ${totalPts}</b>`,
                    { parse_mode:"HTML" }
                  );
                } catch(msgErr) {
                  console.error("Referral message send failed:", msgErr.message);
                }
              }
            } catch (err) {
              console.error("Referral confirm error:", err.message);
            }
          })();

          const lines=[`⚠️ This video auto-deletes in 6 hours.`,``,`📊 <b>Today:</b> ${lim.used}/${DAILY_VIDEO_LIMIT} videos`];
          if(lim.remaining===0) lines.push(`🚫 Limit reached for today!`);
          else if(lim.remaining<=3) lines.push(`⚠️ Only <b>${lim.remaining}</b> left today!`);
          await bot.sendMessage(chatId, lines.join("\n"), { parse_mode:"HTML" });
          return;
        }
        const sentMsg = await sendFile(bot, chatId, record);
        if (isVideo) {
          await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          db.fileRecord.addDeliveredTo(record.id,chatId);
          if (mongoConnected) FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          await bot.sendMessage(chatId, `⚠️ This video auto-deletes in 6 hours.`);
        }
      } catch (err) { console.error("Deep link error:", err.message); bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      return;
    }

    if (isOwner(userId)) {
      const adminText = `👋 Hello Admin!\n\nTap below to browse lectures! 📚\n\n📁 File Store:\n/bulk — bulk upload\n/myfiles — view files\n/delete <code> — delete file\n/rmword 'word' — remove word from names\n/cancel — cancel bulk\n\n📡 Broadcast:\n/broadcast <text> or reply to media`;
      return bot.sendMessage(chatId, adminText, { reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } });
    }

    // Normal user — welcome + invite link
    const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Join aur free lectures dekho! 📚')}`;
    const welcomeText = `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚\n\n🔗 <b>Tera Invite Link:</b>\n<code>${refLink}</code>\n\nFriends ko share karo — jab wo pehla video dekhe, tujhe <b>+1 Point</b> milega! 🎉`;
    bot.sendMessage(chatId, welcomeText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }],
          [{ text: "🔗 Invite Friends", url: shareUrl }]
        ]
      }
    });
  });

  // ── /bulk ─────────────────────────────────────────────────────────────────
  bot.onText(/\/bulk/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    if (bulkSessions.has(userId)) return bot.sendMessage(chatId, `⚠️ Bulk mode already active! Use /done or /cancel.`);
    const timer = setTimeout(async () => { if(bulkSessions.has(userId)){bulkSessions.delete(userId);try{await bot.sendMessage(chatId,`⏰ Bulk session timed out. Use /bulk to start again.`);}catch(_){}} }, BULK_TIMEOUT_MS);
    bulkSessions.set(userId, { files:[], chatId, timer });
    bot.sendMessage(chatId, `📦 Bulk mode ON!\n\nSend files one by one, then /done for a single link!\n\n❌ Cancel: /cancel`);
  });

  // ── /done ─────────────────────────────────────────────────────────────────
  bot.onText(/\/done/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const session=bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId, `No active bulk session. Use /bulk to start.`);
    if (session.files.length===0) return bot.sendMessage(chatId, `⚠️ No files yet! Send files first.`);
    clearTimeout(session.timer); bulkSessions.delete(userId);
    const processing=await bot.sendMessage(chatId,`⏳ Saving batch...`);
    try {
      const batchCode=getUniqueBatchCode();
      const storedFiles=[];
      for (const f of session.files) storedFiles.push(await saveToStorageChannel(bot,f));
      const id=db.generateId();
      db.bulkBatch.create({ id, batch_code:batchCode, user_id:userId, files:storedFiles });
      if (mongoConnected) BulkBatch.create({ batch_code:batchCode, user_id:userId, files:storedFiles }).catch(() => {});
      const link=`https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId,processing.message_id);
      const fileList=session.files.map((f,i)=>`${i+1}. ${f.file_name}`).join("\n");
      await bot.sendMessage(chatId, `✅ Batch ready! ${session.files.length} files.\n\n📋 Files:\n${fileList}\n\n🔗 Link:\n<code>${link}</code>`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"📥 Get Files", url:link }]] } });
    } catch (err) { console.error("Batch save error:",err.message); try{await bot.editMessageText(`Batch save failed. Try again.`,{chat_id:chatId,message_id:processing.message_id});}catch(_){} }
  });

  // ── /cancel ───────────────────────────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const session=bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId,`No active bulk session.`);
    clearTimeout(session.timer); bulkSessions.delete(userId);
    bot.sendMessage(chatId,`❌ Bulk session cancelled.${session.files.length>0?` (${session.files.length} files discarded)`:""}`);
  });

  // ── /myfiles ──────────────────────────────────────────────────────────────
  const PAGE_SIZE=10;
  async function sendMyFilesPage(chatId,userId,page,editMsgId=null) {
    try {
      const allFiles=db.fileRecord.findByUploader(userId);
      const allBatches=db.bulkBatch.findByUser(userId);
      const totalItems=allFiles.length+allBatches.length;
      if (!totalItems) return bot.sendMessage(chatId,`No files or batches uploaded yet.`);
      const totalPages=Math.ceil(totalItems/PAGE_SIZE);
      page=Math.max(0,Math.min(page,totalPages-1));
      const combined=[...allFiles.map(f=>({type:"file",data:f,created_at:f.created_at})),...allBatches.map(b=>({type:"batch",data:b,created_at:b.created_at}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
      const items=combined.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
      const emoji={document:"📄",photo:"🖼️",video:"🎬",audio:"🎵",voice:"🎤",video_note:"📹"};
      let text=`📂 My Files — Page ${page+1}/${totalPages} (${totalItems} total)\n\n`;
      items.forEach((item,i) => {
        const n=page*PAGE_SIZE+i+1;
        if(item.type==="file"){const f=item.data;text+=`${n}. ${emoji[f.file_type]||"📎"} ${f.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;}
        else{const b=item.data;text+=`${n}. 📦 Batch (${b.files.length} files)\nhttps://t.me/${BOT_USERNAME}?start=${b.batch_code}\n\n`;}
      });
      const buttons=[];
      if(page>0) buttons.push({text:"⬅️ Prev",callback_data:`myfiles_page_${page-1}`});
      if(page<totalPages-1) buttons.push({text:"Next ➡️",callback_data:`myfiles_page_${page+1}`});
      const rm=buttons.length?{inline_keyboard:[buttons]}:undefined;
      if(editMsgId) await bot.editMessageText(text,{chat_id:chatId,message_id:editMsgId,disable_web_page_preview:true,reply_markup:rm});
      else await bot.sendMessage(chatId,text,{disable_web_page_preview:true,reply_markup:rm});
    } catch(err){console.error("myfiles error:",err.message);bot.sendMessage(chatId,`Error occurred.`);}
  }
  bot.onText(/\/myfiles/, async (msg) => { if(isGroupChat(msg)||!isOwner(msg.from?.id)) return; await sendMyFilesPage(msg.chat.id,msg.from.id,0); });

  // ── Callback queries ──────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const userId=query.from?.id; const data=query.data||""; const chatId=query.message?.chat?.id; const msgId=query.message?.message_id;
    if (data.startsWith("pay_approve_")||data.startsWith("pay_reject_")) {
      if (!isOwner(userId)) return bot.answerCallbackQuery(query.id,{text:"❌ Not authorized"});
      const isApprove=data.startsWith("pay_approve_");
      const parts=data.replace("pay_approve_","").replace("pay_reject_","").split("_");
      const batchId=parts[0]; const targetUserId=parts[1];
      if (isApprove) {
        try {
          const Batch=require("./models/Course");
          const batch=await Batch.findById(batchId);
          if(batch){if(!batch.premiumUsers)batch.premiumUsers=[];if(!batch.premiumUsers.includes(String(targetUserId))){batch.premiumUsers.push(String(targetUserId));await batch.save();}db.batch.upsert(batch.toObject());}
          bot.sendMessage(parseInt(targetUserId),`✅ <b>Payment Approved!</b>\n\nAccess to <b>${esc(batch?.name||"the batch")}</b> unlocked! 🚀`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]]}}).catch(()=>{});
          await bot.editMessageCaption(`${query.message.caption||""}\n\n✅ <b>APPROVED</b> by ${esc(query.from.first_name||"Admin")}`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>bot.editMessageText(`${query.message.text||""}\n\n✅ <b>APPROVED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
          await bot.answerCallbackQuery(query.id,{text:"✅ Approved!"});
        } catch(err){await bot.answerCallbackQuery(query.id,{text:"❌ Error: "+err.message});}
      } else {
        bot.sendMessage(parseInt(targetUserId),`❌ <b>Payment Rejected</b>\n\nPlease contact support.`,{parse_mode:"HTML"}).catch(()=>{});
        await bot.editMessageCaption(`${query.message.caption||""}\n\n❌ <b>REJECTED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>bot.editMessageText(`${query.message.text||""}\n\n❌ <b>REJECTED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
        await bot.answerCallbackQuery(query.id,{text:"❌ Rejected"});
      }
      return;
    }
    if(query.message&&isGroupChat(query.message)) return bot.answerCallbackQuery(query.id);
    if(!isOwner(userId)) return bot.answerCallbackQuery(query.id);
    if(data.startsWith("myfiles_page_")){const page=parseInt(data.replace("myfiles_page_",""),10);await sendMyFilesPage(query.message.chat.id,userId,page,msgId);await bot.answerCallbackQuery(query.id);}
  });

  // ── /delete ───────────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const code=match[1].trim();
    try {
      if(db.fileRecord.deleteByCode(code,msg.from.id)){if (mongoConnected) FileRecord.deleteOne({code:{$regex:new RegExp(`^${code}$`,"i")},uploaded_by:msg.from.id}).catch(()=>{});return bot.sendMessage(chatId,`✅ File deleted!`);}
      if(db.bulkBatch.deleteByCode(code,msg.from.id)){if (mongoConnected) BulkBatch.deleteOne({batch_code:{$regex:new RegExp(`^${code}$`,"i")},user_id:msg.from.id}).catch(()=>{});return bot.sendMessage(chatId,`✅ Batch deleted!`);}
      bot.sendMessage(chatId,`Code not found.`);
    } catch(_){bot.sendMessage(chatId,`Deletion failed.`);}
  });

  // ── /rmword ───────────────────────────────────────────────────────────────
  bot.onText(/\/rmword(.*)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const arg=(match[1]||"").trim();
    if(arg.toLowerCase()==="list") return bot.sendMessage(chatId,rmWords.length?`📋 Words:\n${rmWords.map((w,i)=>`${i+1}. <code>${esc(w)}</code>`).join("\n")}`:`No words in list.`,{parse_mode:"HTML"});
    if(arg.toLowerCase()==="clear"){const c=rmWords.length;rmWords=[];return bot.sendMessage(chatId,`🗑️ Cleared ${c} word(s).`);}
    const quoted=arg.match(/^['"'](.+?)['"']$/)||arg.match(/^'(.+?)'$/)||arg.match(/^"(.+?)"$/);
    const word=quoted?quoted[1].trim():arg.replace(/^['"']|['"']$/g,"").trim();
    if(!word) return bot.sendMessage(chatId,`Usage: /rmword 'word' | list | clear`,{parse_mode:"HTML"});
    const wl=word.toLowerCase();
    if(rmWords.includes(wl)) return bot.sendMessage(chatId,`⚠️ Already in list.`);
    rmWords.push(wl);
    bot.sendMessage(chatId,`✅ Added <code>${esc(word)}</code>. Total: ${rmWords.length}`,{parse_mode:"HTML"});
  });

  // ── Telegram link fetch ───────────────────────────────────────────────────
  const TG_LINK_RE=/https?:\/\/t\.me\/(c\/(\d+)|([a-zA-Z][a-zA-Z0-9_]{3,}))\/(\d+)/;
  const fileQueues=new Map();
  function enqueueFile(userId,task){const prev=fileQueues.get(userId)||Promise.resolve();const next=prev.then(task).catch(()=>{});fileQueues.set(userId,next);next.finally(()=>{if(fileQueues.get(userId)===next)fileQueues.delete(userId);});}

  bot.onText(TG_LINK_RE, (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    enqueueFile(msg.from.id, async () => {
      const chatId=msg.chat.id; const userId=msg.from.id;
      const isPrivate=!!match[2]; const rawId=match[2]; const username=match[3]; const messageId=parseInt(match[4],10);
      const fromChatId=isPrivate?parseInt(`-100${rawId}`,10):`@${username}`;
      const processing=await bot.sendMessage(chatId,`⏳ Fetching file...`);
      try {
        const forwarded=await bot.forwardMessage(chatId,fromChatId,messageId);
        const fileInfo=extractFileInfo(forwarded);
        if(!fileInfo){await bot.deleteMessage(chatId,forwarded.message_id).catch(()=>{});return bot.editMessageText(`⚠️ No file found in that message.`,{chat_id:chatId,message_id:processing.message_id});}
        await bot.deleteMessage(chatId,forwarded.message_id).catch(()=>{});
        const session=bulkSessions.get(userId);
        if(session){session.files.push(fileInfo);return bot.editMessageText(`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{chat_id:chatId,message_id:processing.message_id});}
        fileInfo.file_name=cleanFileName(fileInfo.file_name); const stored=await saveToStorageChannel(bot,fileInfo);
        const code=getUniqueCode(); const id=db.generateId();
        db.fileRecord.create({id,code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,channel_msg_id:stored.channel_msg_id||null});
        if (mongoConnected) FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null}).catch(()=>{});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            const lNum=autoLectureSession.lectureCount+1; const lName=`Lecture ${lNum}`;
            await autoAddLecture({batchId:autoLectureSession.batchId,subjectId:autoLectureSession.subjectId,chapterId:autoLectureSession.chapterId,unitId:autoLectureSession.unitId,name:lName,link:code});
            autoLectureSession.lectureCount=lNum; courseRoutes.saveAutoSession&&courseRoutes.saveAutoSession();
            const loc=autoLectureSession.unitName?`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`:`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,`✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send next video for <b>Lecture ${lNum+1}</b>`,{parse_mode:"HTML"});
          }catch(err){await bot.sendMessage(chatId,`⚠️ File saved but auto-lecture failed: ${err.message}\n🔗 <code>${link}</code>`,{parse_mode:"HTML"});}
        } else {
          await bot.sendMessage(chatId,`✅ ${stored.file_name}\n\n🔗 Link:\n<code>${link}</code>`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📥 File Lo",url:link}]]}});
        }
      } catch(err){
        const errText=err.message.includes("chat not found")||err.message.includes("CHAT_ADMIN_REQUIRED")?`❌ Bot is not a member of that group/channel.`:err.message.includes("MESSAGE_ID_INVALID")?`❌ Message not found.`:err.message.includes("PEER_ID_INVALID")?`❌ Cannot access this channel.`:`❌ Error: ${err.message}`;
        try{await bot.editMessageText(errText,{chat_id:chatId,message_id:processing.message_id});}catch(_){bot.sendMessage(chatId,errText);}
      }
    });
  });

  // ── File upload handler ───────────────────────────────────────────────────
  bot.on("message", (msg) => {
    if(isGroupChat(msg)||msg.text||!isOwner(msg.from?.id)) return;
    if(msg.text&&TG_LINK_RE.test(msg.text)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const fileInfo=extractFileInfo(msg);
    if(!fileInfo) return;
    const session=bulkSessions.get(userId);
    if(session){enqueueFile(userId,async()=>{session.files.push(fileInfo);await bot.sendMessage(chatId,`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{reply_to_message_id:msg.message_id});});return;}
    enqueueFile(userId, async () => {
      const processing=await bot.sendMessage(chatId,`⏳ Saving: ${fileInfo.file_name}...`);
      try {
        fileInfo.file_name=cleanFileName(fileInfo.file_name); const stored=await saveToStorageChannel(bot,fileInfo);
        const code=getUniqueCode(); const id=db.generateId();
        db.fileRecord.create({id,code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,channel_msg_id:stored.channel_msg_id||null});
        if (mongoConnected) FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null}).catch(()=>{});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            const lNum=autoLectureSession.lectureCount+1; const lName=`Lecture ${lNum}`;
            await autoAddLecture({batchId:autoLectureSession.batchId,subjectId:autoLectureSession.subjectId,chapterId:autoLectureSession.chapterId,unitId:autoLectureSession.unitId,name:lName,link:code});
            autoLectureSession.lectureCount=lNum; courseRoutes.saveAutoSession&&courseRoutes.saveAutoSession();
            const loc=autoLectureSession.unitName?`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`:`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,`✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send next video for <b>Lecture ${lNum+1}</b>`,{parse_mode:"HTML"});
          }catch(err){await bot.sendMessage(chatId,`⚠️ Saved but auto-lecture failed: ${err.message}\n🔗 <code>${link}</code>`,{parse_mode:"HTML"});}
        } else {
          await bot.sendMessage(chatId,`✅ ${stored.file_name}\n\n🔗 Link:\n<code>${link}</code>`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📥 Get File",url:link}]]}});
        }
      } catch(err){console.error("Save error:",err.message);try{await bot.editMessageText(`❌ Could not save. Try again.`,{chat_id:chatId,message_id:processing.message_id});}catch(_){}}
    });
  });

  // ── /broadcast ────────────────────────────────────────────────────────────
  bot.onText(/\/broadcast(.*)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const argRaw=(match[1]||"").trim();
    const pinFlag=argRaw.includes("--pin"); const forwardFlag=argRaw.includes("--f");
    const inlineText=argRaw.replace("--pin","").replace("--f","").trim();
    const reply=msg.reply_to_message;
    let bType=null, bPayload={};
    if(reply){
      if(reply.sticker){bType="sticker";bPayload={file_id:reply.sticker.file_id};}
      else if(reply.animation){bType="animation";bPayload={file_id:reply.animation.file_id,caption:reply.caption||""};}
      else if(reply.video_note){bType="video_note";bPayload={file_id:reply.video_note.file_id};}
      else if(reply.voice){bType="voice";bPayload={file_id:reply.voice.file_id,caption:reply.caption||""};}
      else if(reply.audio){bType="audio";bPayload={file_id:reply.audio.file_id,caption:reply.caption||""};}
      else if(reply.document){bType="document";bPayload={file_id:reply.document.file_id,caption:reply.caption||""};}
      else if(reply.video){bType="video";bPayload={file_id:reply.video.file_id,caption:reply.caption||""};}
      else if(reply.photo){bType="photo";bPayload={file_id:reply.photo[reply.photo.length-1].file_id,caption:reply.caption||""};}
      else if(reply.text){bType="text";bPayload={text:reply.text};}
    }
    if(!bType&&inlineText){bType="text";bPayload={text:inlineText};}
    if(!bType) return bot.sendMessage(chatId,`❌ Nothing to broadcast.\n\nReply to a message with /broadcast or /broadcast Your text here`);

    async function sendToUser(tid){
      if(forwardFlag&&reply) return bot.forwardMessage(tid,reply.chat.id,reply.message_id);
      const o={parse_mode:"HTML"};
      switch(bType){
        case"text": return bot.sendMessage(tid,bPayload.text,o);
        case"photo": return bot.sendPhoto(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"video": return bot.sendVideo(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"audio": return bot.sendAudio(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"document": return bot.sendDocument(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"voice": return bot.sendVoice(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"video_note": return bot.sendVideoNote(tid,bPayload.file_id);
        case"sticker": return bot.sendSticker(tid,bPayload.file_id);
        case"animation": return bot.sendAnimation(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
      }
    }

    const allUsers=db.user.getAll();
    if(!allUsers.length) return bot.sendMessage(chatId,`⚠️ No users found.`);
    const progress=await bot.sendMessage(chatId,`📡 Broadcasting to ${allUsers.length} users...`);
    let sent=0,failed=0,blocked=0;
    for(let i=0;i<allUsers.length;i++){
      const tid=parseInt(allUsers[i].userId,10);
      if(!tid){failed++;continue;}
      try{const sm=await sendToUser(tid);if(pinFlag&&sm?.message_id){try{await bot.pinChatMessage(tid,sm.message_id,{disable_notification:true});}catch(_){}}sent++;}
      catch(err){if((err.message||"").match(/blocked|deactivated|Forbidden/))blocked++;else failed++;}
      if((i+1)%20===0||i===allUsers.length-1){try{await bot.editMessageText(`📡 Broadcasting...\n✅ ${sent} | 🚫 ${blocked} | ❌ ${failed} | ⏳ ${i+1}/${allUsers.length}`,{chat_id:chatId,message_id:progress.message_id});}catch(_){}}
      if((i+1)%25===0&&i<allUsers.length-1) await wait(1000);
    }
    try{await bot.editMessageText(`✅ <b>Broadcast Complete!</b>\n\n✅ Delivered: ${sent}\n🚫 Blocked: ${blocked}\n❌ Failed: ${failed}`,{chat_id:chatId,message_id:progress.message_id,parse_mode:"HTML"});}catch(_){}
  });

  // ── /stats ────────────────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const processing=await bot.sendMessage(chatId,"⏳ Gathering stats...");
    try {
      const s=await (await fetch(`http://localhost:${PORT}/api/stats`)).json();

      // Uptime formatting
      const uptime=process.uptime();
      const ud=Math.floor(uptime/86400), uh=Math.floor((uptime%86400)/3600), um=Math.floor((uptime%3600)/60);
      const uptimeStr = ud>0 ? `${ud}d ${uh}h ${um}m` : uh>0 ? `${uh}h ${um}m` : `${um}m`;

      // DB status
      const mongoStatus = mongoose.connection.readyState===1 ? "🟢 Online" : "🔴 Offline";

      // Build message
      const text = [
        `╔═══════════════════════╗`,
        `      📊 <b>BOT DASHBOARD</b>`,
        `╚═══════════════════════╝`,
        ``,
        `👥 <b>USERS</b>`,
        `┣ Total Users: <b>${s.users.totalUsers.toLocaleString()}</b>`,
        `┣ New Today: <b>+${s.users.newToday}</b>`,
        `┗ This Week: <b>+${s.users.recentUsers}</b>`,
        ``,
        `📚 <b>CONTENT</b>`,
        `┣ Batches: <b>${s.content.totalBatches}</b> (🟢 ${s.content.publicBatches} Public · 🔒 ${s.content.privateBatches} Private)`,
        `┣ Subjects: <b>${s.content.totalSubjects}</b>  |  Chapters: <b>${s.content.totalChapters}</b>`,
        `┗ Lectures: <b>${s.content.totalLectures}</b>`,
        ``,
        `🔑 <b>ACCESS</b>`,
        `┣ Total Granted: <b>${s.access.totalAccess}</b>`,
        `┣ Granted Today: <b>+${s.access.grantedToday}</b>`,
        `┗ Currently Active: <b>${s.access.activeAccess}</b>`,
        ``,
        `👫 <b>REFERRALS</b>`,
        `┣ Total Referrals: <b>${s.referrals.totalReferrals}</b>`,
        `┗ Unique Referrers: <b>${s.referrals.uniqueReferrers}</b>`,
        ``,
        `🎰 <b>SPIN WHEEL</b>`,
        `┣ Spins Today: <b>${s.points.todaySpins}</b>`,
        `┣ Total Spinners: <b>${s.points.totalSpinners}</b>`,
        `┣ Total Pts Earned: <b>${s.points.totalSpinPoints}</b>`,
        `┗ Total Pts Redeemed: <b>${s.points.totalRedeemed}</b>`,
        ``,
        `📁 <b>FILE STORE</b>`,
        `┣ Files: <b>${s.files.total}</b>`,
        `┗ Bulk Batches: <b>${s.files.bulk}</b>`,
        ``,
        `⚙️ <b>SERVER</b>`,
        `┣ Uptime: <b>${uptimeStr}</b>`,
        `┣ MongoDB: ${mongoStatus}`,
        `┗ SQLite: ✅ Active`,
        ``,
        `<i>🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}</i>`,
      ].join('\n');

      await bot.editMessageText(text,{chat_id:chatId,message_id:processing.message_id,parse_mode:"HTML"});
    } catch(err){
      console.error('Stats error:', err.message);
      bot.editMessageText("❌ Could not fetch stats. Check logs.",{chat_id:chatId,message_id:processing.message_id});
    }
  });

  bot.on("polling_error",(err)=>console.error("Polling error:",err.message));
  process.on("SIGTERM",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
  process.on("SIGINT",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
}

startBot().catch((err)=>{console.error("Bot startup error:",err.message);process.exit(1);});
