const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const WEB_URL = process.env.WEB_URL;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID
  ? parseInt(process.env.STORAGE_CHANNEL_ID)
  : null;
const UPI_ID = process.env.UPI_ID || "";
const PAYMENT_GROUP_ID = process.env.PAYMENT_GROUP_ID ? parseInt(process.env.PAYMENT_GROUP_ID) : null;

let BOT_USERNAME = "";
let bot = null; // global bot instance

if (!TOKEN || !MONGO_URI || !WEB_URL || !OWNER_ID) {
  console.error("Missing env: BOT_TOKEN, MONGO_URI, WEB_URL, OWNER_ID are required.");
  process.exit(1);
}

if (!STORAGE_CHANNEL_ID) {
  console.warn("Warning: STORAGE_CHANNEL_ID not set. New files will use direct file_id (not bot-change safe).");
}

// ── Helper: is this user the owner? ─────────────────────────────────────────
function isOwner(userId) {
  return userId === OWNER_ID;
}

// ── Helper: is this message from a group or supergroup? ──────────────────────
function isGroupChat(msg) {
  return msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup");
}

// ── MongoDB connect ──────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected");

    // ── One-time migration: fix old records that had expires_at set ──────────
    // Drop the TTL index so MongoDB stops auto-deleting records.
    try {
      await mongoose.connection.collection("filerecords").dropIndex("expires_at_1");
      console.log("Migration: TTL index dropped from filerecords.");
    } catch (e) {
      if (e.codeName !== "IndexNotFound") console.warn("dropIndex warning:", e.message);
    }

    // Null-out expires_at on any existing records so old links work again.
    try {
      const result = await mongoose.connection.collection("filerecords").updateMany(
        { expires_at: { $ne: null } },
        { $set: { expires_at: null } }
      );
      if (result.modifiedCount > 0)
        console.log(`Migration: Reset expires_at on ${result.modifiedCount} old file record(s). Old links restored.`);
    } catch (e) {
      console.error("Migration error (expires_at reset):", e.message);
    }
  })
  .catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

// ─── Schemas ─────────────────────────────────────────────────────────────────

// File Store schemas
const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  file_id: { type: String, required: true },
  file_type: { type: String, required: true },
  file_name: { type: String, default: "file" },
  uploaded_by: { type: Number },
  expires_at: { type: Date, default: null },
  delivered_to: [{ type: Number }],
  created_at: { type: Date, default: Date.now },
});
// TTL index removed — links are permanent. expires_at field kept for schema compatibility.
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({
  batch_code: { type: String, required: true, unique: true, index: true },
  user_id: { type: Number, required: true },
  files: [
    {
      file_id:   { type: String, required: true },
      file_type: { type: String, required: true },
      file_name: { type: String, default: "file" },
    }
  ],
  created_at: { type: Date, default: Date.now },
});
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({
  chat_id:    { type: Number, required: true },
  message_id: { type: Number, required: true },
  delete_at:  { type: Date,   required: true },
});
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

// User registry — saved on first /start
const userSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  firstName: { type: String, default: "" },
  lastName:  { type: String, default: "" },
  username:  { type: String, default: "" },
  firstSeen: { type: Date,   default: Date.now },
  lastSeen:  { type: Date,   default: Date.now },
});
const User = mongoose.model("User", userSchema);

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.status(200).json({
  status: "ok",
  uptime: process.uptime(),
  mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
}));

app.get("/api/config", (req, res) => {
  const forceJoinChannels = (process.env.FORCE_JOIN_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  res.json({
    ownerId: OWNER_ID,
    botUsername: BOT_USERNAME || '',
    forceJoinRequired: forceJoinChannels.length > 0,
    upiId: UPI_ID || '',
  });
});

const courseRoutes = require("./routes/course");
app.use("/api", courseRoutes);
const autoLectureSession = courseRoutes.autoLectureSession;
const autoAddLecture     = courseRoutes.autoAddLecture;

// ── Payment Request API ───────────────────────────────────────────────────────
app.post("/api/pay-request", express.json({ limit: "10mb" }), async (req, res) => {
  try {
    const { batchId, userId, firstName, lastName, username, txnId, screenshotBase64 } = req.body;
    if (!batchId || !txnId) return res.status(400).json({ error: "Missing fields" });

    const Batch = require("./models/Course");
    const batch = await Batch.findById(batchId).catch(() => null);
    const batchName = batch ? batch.name : batchId;
    const price = batch?.price ? `₹${batch.price}` : "N/A";

    const caption =
      `💸 <b>New Payment Request!</b>\n\n` +
      `👤 <b>${esc(firstName)}${lastName ? ' ' + esc(lastName) : ''}</b>\n` +
      `🆔 UID: <code>${esc(userId)}</code>\n` +
      `📱 Username: ${username ? '@' + esc(username) : 'N/A'}\n\n` +
      `📚 Batch: <b>${esc(batchName)}</b>\n` +
      `💰 Amount: <b>${esc(price)}</b>\n` +
      `🔖 Txn ID: <code>${esc(txnId)}</code>`;

    if (!PAYMENT_GROUP_ID) return res.status(500).json({ error: "PAYMENT_GROUP_ID not configured" });

    const inlineKeyboard = {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `pay_approve_${batchId}_${userId}` },
        { text: "❌ Reject",  callback_data: `pay_reject_${batchId}_${userId}`  },
      ]]
    };

    // Send screenshot + caption OR just text if no screenshot
    if (screenshotBase64) {
      const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      await bot.sendPhoto(PAYMENT_GROUP_ID, buffer, {
        caption,
        parse_mode: "HTML",
        filename: `payment_${userId}_${Date.now()}.jpg`,
        reply_markup: inlineKeyboard,
      });
    } else {
      await bot.sendMessage(PAYMENT_GROUP_ID, caption, {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Payment request error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Helper: escape HTML ──────────────────────────────────────────────────────
const esc = (s) => String(s||'').replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// ─── File Store Helpers ───────────────────────────────────────────────────────

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function getUniqueCode() {
  let code, exists;
  do {
    code = generateCode();
    exists = await FileRecord.findOne({ code });
  } while (exists);
  return code;
}

async function getUniqueBatchCode() {
  let code, exists;
  do {
    code = "B" + generateCode();
    exists = await BulkBatch.findOne({ batch_code: code });
  } while (exists);
  return code;
}

function extractFileInfo(msg) {
  const caption = msg.caption || null; // preserve original caption if present
  if (msg.document)   return { file_id: msg.document.file_id,  file_type: "document",   file_name: msg.document.file_name || "document", caption };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length - 1].file_id, file_type: "photo", file_name: "photo.jpg", caption };
  if (msg.video)      return { file_id: msg.video.file_id,      file_type: "video",      file_name: msg.video.file_name || "video.mp4",   caption };
  if (msg.audio)      return { file_id: msg.audio.file_id,      file_type: "audio",      file_name: msg.audio.file_name || "audio.mp3",   caption };
  if (msg.voice)      return { file_id: msg.voice.file_id,      file_type: "voice",      file_name: "voice.ogg",                          caption };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4",                     caption: null };
  return null;
}

// Sends a file directly to the storage channel and returns the channel's file_id.
// Sending directly (not forwarding) guarantees the response contains the file object
// with a stable channel-scoped file_id. This file_id works with any bot that is
// an admin of the same storage channel, so bot replacement won't break delivery.
// Falls back to original fileInfo if STORAGE_CHANNEL_ID is not set or send fails.
async function saveToStorageChannel(bot, fileInfo) {
  if (!STORAGE_CHANNEL_ID) return fileInfo;

  try {
    let sentMsg;
    // Send file directly to channel using the current file_id.
    // The API response will contain the new channel-scoped file_id.
    const caption = fileInfo.caption || `📎 ${fileInfo.file_name}`;
    switch (fileInfo.file_type) {
      case "photo":      sentMsg = await bot.sendPhoto(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video":      sentMsg = await bot.sendVideo(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "audio":      sentMsg = await bot.sendAudio(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "voice":      sentMsg = await bot.sendVoice(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video_note": sentMsg = await bot.sendVideoNote(STORAGE_CHANNEL_ID, fileInfo.file_id); break; // video_note does not support caption
      default:           sentMsg = await bot.sendDocument(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
    }

    // Extract the channel file_id from the sent message response
    const channelFileInfo = extractFileInfo(sentMsg);
    if (channelFileInfo) {
      // Keep the original file_name, use channel's file_id and file_type
      return { ...channelFileInfo, file_name: fileInfo.file_name };
    }

    console.warn("saveToStorageChannel: could not extract file_id from channel response, using original.");
    return fileInfo;
  } catch (err) {
    console.error("saveToStorageChannel failed, using original file_id:", err.message);
    return fileInfo;
  }
}

async function sendFile(bot, chatId, record) {
  const caption = `📎 ${record.file_name}`;
  const protect = !isOwner(chatId); // owner ko forward allow, baaki restrict
  switch (record.file_type) {
    case "photo":      return await bot.sendPhoto(chatId, record.file_id, { caption });
    case "video":      return await bot.sendVideo(chatId, record.file_id, { caption, protect_content: protect });
    case "audio":      return await bot.sendAudio(chatId, record.file_id, { caption });
    case "voice":      return await bot.sendVoice(chatId, record.file_id, { caption });
    case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: protect });
    default:           return await bot.sendDocument(chatId, record.file_id, { caption });
  }
}

// In-memory bulk sessions: { userId: { files: [...], chatId, timer } }
const bulkSessions = new Map();
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// ── Words to auto-remove from file names on save ─────────────────────────────
// Stored as lowercase; matching is case-insensitive, whole-word.
let rmWords = [];

async function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ── Apply rmWords: remove each phrase from a file name ───────────────────────
// Normalizes _ and space as equivalent before matching, so:
//   rmword "Ꮓ_𝐕𝐞𝐫𝐭𝐞𝐱"  matches  "Ꮓ 𝐕𝐞𝐫𝐭𝐞𝐱"  and vice versa.
// Uses indexOf (no regex \b) so Unicode/special chars work fine.
function cleanFileName(name) {
  if (!rmWords.length) return name;
  // Strip extension first so it is never accidentally modified
  const extMatch = name.match(/(\.[a-zA-Z0-9]{1,6})$/);
  let result = extMatch ? name.slice(0, -extMatch[1].length) : name;

  for (const w of rmWords) {
    // Normalize: treat _ and space as the same separator
    const wNorm = w.toLowerCase().replace(/_/g, " ");
    let resNorm = result.toLowerCase().replace(/_/g, " ");
    let idx;
    while ((idx = resNorm.indexOf(wNorm)) !== -1) {
      result  = result.slice(0, idx) + result.slice(idx + w.length);
      resNorm = result.toLowerCase().replace(/_/g, " ");
    }
  }
  // Collapse leftover separators (_, space, -, ., :) into single _
  result = result
    .replace(/[_ .\-:]{2,}/g, "_")
    .replace(/^[_ .\-:]+|[_ .\-:]+$/g, "")
    .trim();
  if (extMatch) result = result + extMatch[1];
  return result || name;
}

async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  await PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  const delay = Math.max(0, deleteAt - Date.now());
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
      await PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId });
    } catch (err) {
      console.error("Auto DM deletion error:", err.message);
      await PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
    }
  }, delay);
}

async function recoverPendingDeletes(bot) {
  const pending = await PendingDelete.find({});
  console.log(`Recovering ${pending.length} pending DM deletions...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try {
        await bot.deleteMessage(p.chat_id, p.message_id);
      } catch (err) {
        console.error("Recovered deletion error:", err.message);
      }
      await PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
      await FileRecord.updateMany({}, { $pull: { delivered_to: p.chat_id } }).catch(() => {});
    }, delay);
  }
}

// ─── Bot startup ──────────────────────────────────────────────────────────────

async function startBot() {
  // Clear old polling
  try {
    console.log("Clearing old polling...");
    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) console.warn("getUpdates response:", res.status);
  } catch (err) {
    console.warn("getUpdates skip (network issue):", err.message);
  }

  // Bot init with retry
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      bot = new TelegramBot(TOKEN, {
        polling: { interval: 2000, autoStart: false, params: { timeout: 30 } },
      });
      await bot.getMe();
      break;
    } catch (err) {
      console.error(`Bot init attempt ${attempt} failed: ${err.message}`);
      if (attempt === 5) throw err;
      await wait(5000 * attempt);
    }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);

  // ── Set Web App menu button ────────────────────────────────────────────────
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        menu_button: {
          type: "web_app",
          text: "Open EduBot",
          web_app: { url: WEB_URL },
        },
      }),
    });
    console.log("Menu button set:", WEB_URL);
  } catch (err) {
    console.warn("Failed to set menu button:", err.message);
  }

  await recoverPendingDeletes(bot);

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return; // Ignore all group messages
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = match[1].trim();

    // Check if user is brand new BEFORE saving them (used for referral validation)
    const isNewUser = userId ? !(await User.findOne({ userId: String(userId) }).catch(() => null)) : false;

    // Save/update user info
    if (userId) {
      User.findOneAndUpdate(
        { userId: String(userId) },
        {
          userId:    String(userId),
          firstName: msg.from.first_name || "",
          lastName:  msg.from.last_name  || "",
          username:  msg.from.username   || "",
          lastSeen:  new Date(),
        },
        { upsert: true, new: true }
      ).catch(() => {});
    }

    // File/batch link delivery — works for everyone
    if (param) {
      // ref_ param — record referral then show Web App button
      if (param.startsWith("ref_")) {
        const referrerId = param.replace("ref_", "");
        const referredId = String(msg.from?.id || "");
        // referral recording handled below with isNew check
        // Notify the referred user
        bot.sendMessage(chatId,
          `👋 Hello ${msg.from.first_name}!\n\nTap the button below to browse all lectures! 📚`,
          { reply_markup: { inline_keyboard: [[{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }]] } }
        );

        // Notify referrer ONLY if this was a brand new referral
        if (referrerId && referrerId !== String(userId)) {
          try {
            const recordRes = await fetch(`http://localhost:${PORT}/api/refer/record`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ referrerId, referredId, isNewUser }),
            });
            const recordData = await recordRes.json();
            if (recordData.isNew) {
              const statsRes = await fetch(`http://localhost:${PORT}/api/refer/stats/${referrerId}`);
              const stats = await statsRes.json();
              const firstName = msg.from.first_name || "Someone";
              const lastName = msg.from.last_name ? ' ' + msg.from.last_name : '';
              bot.sendMessage(parseInt(referrerId),
                `🎉 <b>New Referral!</b>\n\n${firstName}${lastName} joined using your referral link!\n\n⭐ <b>+1 Point earned!</b>\nYour Total Points: <b>${stats.points}</b>`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } catch (_) {}
        }

        return;
      }

      // buy_ param — redirect to web app (payment handled in web app)
      if (param.startsWith("buy_")) {
        bot.sendMessage(chatId,
          `💳 <b>Complete your payment in the app!</b>\n\nTap below to open and complete your purchase.`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "💳 Pay Now", web_app: { url: WEB_URL } }]] }
          }
        );
        return;
      }

      if (param.startsWith("B")) {
        // Bulk batch
        try {
          const batch = await BulkBatch.findOne({ batch_code: param });
          if (!batch) return bot.sendMessage(chatId, `File not found. Link may be invalid or expired.`);
          let hasVideo = false;
          for (const f of batch.files) {
            const sentMsg = await sendFile(bot, chatId, f);
            const isVideo = f.file_type === "video" || f.file_type === "video_note";
            if (isVideo && sentMsg) {
              hasVideo = true;
              const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
              await scheduleDelete(bot, chatId, sentMsg.message_id, deleteAt);
            }
          }
          if (hasVideo) {
            await bot.sendMessage(chatId, `⚠️ Videos in this batch will be automatically deleted from your DM after 24 hours.`);
          }
          return;
        } catch (err) {
          console.error("Batch deep link error:", err.message);
          return bot.sendMessage(chatId, `Error occurred. Please try again.`);
        }
      }

      // Single file
      try {
        const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${param}$`, "i") } });
        if (!record) return bot.sendMessage(chatId, `File not found. Link may be invalid or expired.`);

        const isVideo = record.file_type === "video" || record.file_type === "video_note";

        if (isVideo && record.delivered_to.includes(chatId)) {
          return bot.sendMessage(chatId, `⚠️ This video has already been delivered to you. It will be auto-deleted from your DM within 24 hours of first delivery.`);
        }

        const sentMsg = await sendFile(bot, chatId, record);

        if (isVideo) {
          const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await scheduleDelete(bot, chatId, sentMsg.message_id, deleteAt);
          await FileRecord.updateOne({ _id: record._id }, { $addToSet: { delivered_to: chatId } });
          setTimeout(async () => {
            await FileRecord.updateOne({ _id: record._id }, { $pull: { delivered_to: chatId } }).catch(() => {});
          }, 24 * 60 * 60 * 1000);
          await bot.sendMessage(chatId, `⚠️ This video will be automatically deleted from your DM after 24 hours.`);
        }
      } catch (err) {
        console.error("Deep link error:", err.message);
        bot.sendMessage(chatId, `Error occurred. Please try again.`);
      }
      return;
    }

    // No param — Web App button for everyone
    const welcomeText = isOwner(userId)
      ? `👋 Hello Admin!\n\nTap the button below to browse all lectures! 📚\n\n` +
        `📁 File Store Commands:\n` +
        `/bulk — start bulk upload mode\n` +
        `/myfiles — view your saved files\n` +
        `/delete <code> — delete a file\n` +
        `/rmword '<word>' — auto-remove word from file names\n` +
        `/cancel — cancel bulk mode\n\n` +
        `📡 Broadcast:\n` +
        `/broadcast <text> — text to all users\n` +
        `/broadcast --pin <text> — text + pin\n` +
        `Reply to any media + /broadcast to send media`
      : `👋 Hello ${msg.from.first_name}!\n\nTap the button below to browse all lectures! 📚`;

    bot.sendMessage(chatId, welcomeText, {
      reply_markup: {
        inline_keyboard: [[
          { text: "📚 Browse Lectures", web_app: { url: WEB_URL } }
        ]]
      }
    });
  });

  // ─── File Store Commands (Owner Only — silent ignore for others) ─────────────

  // ── /bulk ────────────────────────────────────────────────────────────────────
  bot.onText(/\/bulk/, async (msg) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return; // Silent ignore

    const chatId = msg.chat.id;

    if (bulkSessions.has(userId)) {
      return bot.sendMessage(chatId,
        `⚠️ Bulk mode is already active!\nSend files or use /done to complete.\nTo cancel use /cancel.`
      );
    }

    const timer = setTimeout(async () => {
      if (bulkSessions.has(userId)) {
        bulkSessions.delete(userId);
        try {
          await bot.sendMessage(chatId, `⏰ Bulk session timed out (5 min). Start again with /bulk.`);
        } catch (_) {}
      }
    }, BULK_TIMEOUT_MS);

    bulkSessions.set(userId, { files: [], chatId, timer });

    bot.sendMessage(chatId,
      `📦 Bulk mode ON!\n\nSend files one by one.\nWhen done, type /done — you will get a single shareable link!\n\n❌ Cancel: /cancel`
    );
  });

  // ── /done — saves all bulk session files to storage channel then creates a batch ──
  bot.onText(/\/done/, async (msg) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return; // Silent ignore

    const chatId = msg.chat.id;
    const session = bulkSessions.get(userId);

    if (!session) {
      return bot.sendMessage(chatId, `No active bulk session. Start one with /bulk.`);
    }
    if (session.files.length === 0) {
      return bot.sendMessage(chatId, `⚠️ No files sent yet! Send files first, then use /done.`);
    }

    clearTimeout(session.timer);
    bulkSessions.delete(userId);

    const processing = await bot.sendMessage(chatId, `⏳ Saving batch...`);
    try {
      const batchCode = await getUniqueBatchCode();

      // Send each bulk file to storage channel to get stable channel-scoped file_ids.
      const storedFiles = [];
      for (const f of session.files) {
        const storedInfo = await saveToStorageChannel(bot, f);
        storedFiles.push(storedInfo);
      }

      await BulkBatch.create({ batch_code: batchCode, user_id: userId, files: storedFiles });

      const link = `https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId, processing.message_id);

      const fileList = session.files.map((f, i) => `${i + 1}. ${f.file_name}`).join("\n");
      await bot.sendMessage(chatId,
        `✅ Batch ready! ${session.files.length} files saved.\n\n📋 Files:\n${fileList}\n\n🔗 Link:\n<code>${link}</code>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "📥 Saari Files Lo", url: link }]] } }
      );
    } catch (err) {
      console.error("Batch save error:", err.message);
      try {
        await bot.editMessageText(`Batch could not be saved. Please try again.`, {
          chat_id: chatId, message_id: processing.message_id
        });
      } catch (_) {
        bot.sendMessage(chatId, `Batch could not be saved. Please try again.`);
      }
    }
  });

  // ── /cancel ──────────────────────────────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return; // Silent ignore

    const chatId = msg.chat.id;
    const session = bulkSessions.get(userId);

    if (!session) {
      return bot.sendMessage(chatId, `No active bulk session.`);
    }
    clearTimeout(session.timer);
    bulkSessions.delete(userId);
    bot.sendMessage(chatId,
      `❌ Bulk session cancelled.${session.files.length > 0 ? ` (${session.files.length} files discarded)` : ""}`
    );
  });

  // ── /myfiles — paginated 10 per page with inline Next/Prev buttons ───────────
  const PAGE_SIZE = 10;

  async function sendMyFilesPage(chatId, userId, page, editMsgId = null) {
    try {
      const totalFiles   = await FileRecord.countDocuments({ uploaded_by: userId });
      const totalBatches = await BulkBatch.countDocuments({ user_id: userId });
      const totalItems   = totalFiles + totalBatches;

      if (totalItems === 0) {
        return bot.sendMessage(chatId, `No files or batches uploaded yet.`);
      }

      const totalPages = Math.ceil(totalItems / PAGE_SIZE);
      page = Math.max(0, Math.min(page, totalPages - 1));
      const skip = page * PAGE_SIZE;

      // Fetch combined page: files first, then batches (sorted by date desc)
      const allFiles   = await FileRecord.find({ uploaded_by: userId });
      const allBatches = await BulkBatch.find({ user_id: userId });

      // Merge and sort by created_at descending (newest first)
      const combined = [
        ...allFiles.map(f => ({ type: "file", data: f, created_at: f.created_at })),
        ...allBatches.map(b => ({ type: "batch", data: b, created_at: b.created_at })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const pageItems = combined.slice(skip, skip + PAGE_SIZE);

      const emoji = { document: "📄", photo: "🖼️", video: "🎬", audio: "🎵", voice: "🎤", video_note: "📹" };
      let text = `📂 My Files — Page ${page + 1} of ${totalPages} (${totalItems} total)\n\n`;

      pageItems.forEach((item, i) => {
        const n = skip + i + 1;
        if (item.type === "file") {
          const f = item.data;
          text += `${n}. ${emoji[f.file_type] || "📎"} ${f.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;
        } else {
          const b = item.data;
          text += `${n}. 📦 Batch (${b.files.length} files) — ${b.created_at.toLocaleDateString("en-IN")}\nhttps://t.me/${BOT_USERNAME}?start=${b.batch_code}\n\n`;
        }
      });

      // Build Prev / Next inline keyboard
      const buttons = [];
      if (page > 0)            buttons.push({ text: "⬅️ Previous", callback_data: `myfiles_page_${page - 1}` });
      if (page < totalPages-1) buttons.push({ text: "Next ➡️",     callback_data: `myfiles_page_${page + 1}` });

      const reply_markup = buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined;

      if (editMsgId) {
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: editMsgId,
          disable_web_page_preview: true,
          reply_markup,
        });
      } else {
        await bot.sendMessage(chatId, text, { disable_web_page_preview: true, reply_markup });
      }
    } catch (err) {
      console.error("myfiles error:", err.message);
      bot.sendMessage(chatId, `An error occurred. Please try again.`);
    }
  }

  bot.onText(/\/myfiles/, async (msg) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return; // Silent ignore
    await sendMyFilesPage(msg.chat.id, userId, 0);
  });

  // ── Inline button callback for pagination ────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const userId = query.from?.id;
    const data = query.data || '';
    const chatId = query.message?.chat?.id;
    const msgId = query.message?.message_id;

    // ── Payment Approve/Reject (only owner, works in group too) ──────────────
    if (data.startsWith("pay_approve_") || data.startsWith("pay_reject_")) {
      if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: "❌ Not authorized" });

      const isApprove = data.startsWith("pay_approve_");
      const parts = data.replace("pay_approve_", "").replace("pay_reject_", "").split("_");
      const batchId = parts[0];
      const targetUserId = parts[1];

      if (isApprove) {
        try {
          const Batch = require("./models/Course");
          const batch = await Batch.findById(batchId);
          if (batch) {
            if (!batch.premiumUsers) batch.premiumUsers = [];
            if (!batch.premiumUsers.includes(String(targetUserId))) {
              batch.premiumUsers.push(String(targetUserId));
              await batch.save();
            }
          }
          // Notify user
          bot.sendMessage(parseInt(targetUserId),
            `✅ <b>Payment Approved!</b>\n\nYour access to <b>${esc(batch?.name || 'the batch')}</b> has been unlocked. Open the app to start learning! 🚀`,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📚 Open App", web_app: { url: WEB_URL } }]] } }
          ).catch(() => {});
          // Update group message
          await bot.editMessageCaption(
            `${query.message.caption || ''}\n\n✅ <b>APPROVED</b> by ${esc(query.from.first_name || 'Admin')}`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
          ).catch(() => bot.editMessageText(
            `${query.message.text || ''}\n\n✅ <b>APPROVED</b> by ${esc(query.from.first_name || 'Admin')}`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
          ).catch(() => {}));
          await bot.answerCallbackQuery(query.id, { text: "✅ Approved & unlocked!" });
        } catch (err) {
          console.error("Approve error:", err.message);
          await bot.answerCallbackQuery(query.id, { text: "❌ Error: " + err.message });
        }
      } else {
        // Reject — notify user and update message
        bot.sendMessage(parseInt(targetUserId),
          `❌ <b>Payment Rejected</b>\n\nYour payment could not be verified. Please contact support or try again.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        await bot.editMessageCaption(
          `${query.message.caption || ''}\n\n❌ <b>REJECTED</b> by ${esc(query.from.first_name || 'Admin')}`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
        ).catch(() => bot.editMessageText(
          `${query.message.text || ''}\n\n❌ <b>REJECTED</b> by ${esc(query.from.first_name || 'Admin')}`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
        ).catch(() => {}));
        await bot.answerCallbackQuery(query.id, { text: "❌ Rejected" });
      }
      return;
    }

    // ── Other callbacks (owner only, DM only) ────────────────────────────────
    if (query.message && isGroupChat(query.message)) return bot.answerCallbackQuery(query.id);
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id);

    if (data && data.startsWith("myfiles_page_")) {
      const page = parseInt(data.replace("myfiles_page_", ""), 10);
      await sendMyFilesPage(query.message.chat.id, userId, page, query.message.message_id);
      await bot.answerCallbackQuery(query.id);
    }
  });

  // ── /delete <code> ───────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return; // Silent ignore

    const chatId = msg.chat.id;
    const code = match[1].trim();
    try {
      const record = await FileRecord.findOneAndDelete({
        code: { $regex: new RegExp(`^${code}$`, "i") },
        uploaded_by: userId,
      });
      if (record) return bot.sendMessage(chatId, `✅ File deleted successfully!`);

      const batch = await BulkBatch.findOneAndDelete({
        batch_code: { $regex: new RegExp(`^${code}$`, "i") },
        user_id: userId,
      });
      if (batch) return bot.sendMessage(chatId, `✅ Batch deleted! (${batch.files.length} files)`);

      bot.sendMessage(chatId, `Code not found or it does not belong to you.`);
    } catch (err) {
      bot.sendMessage(chatId, `Deletion failed. Please try again.`);
    }
  });

  // ── /rmword — manage words auto-removed from file names on save ──────────────
  // Usage:
  //   /rmword '<word>'   — add a word to the remove list
  //   /rmword list       — show current list
  //   /rmword clear      — clear all words
  bot.onText(/\/rmword(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return;

    const chatId = msg.chat.id;
    const arg = (match[1] || "").trim();

    // /rmword list
    if (arg.toLowerCase() === "list") {
      if (!rmWords.length) return bot.sendMessage(chatId, `📋 No words in the remove list.`);
      return bot.sendMessage(chatId,
        `📋 <b>Words removed from file names:</b>\n${rmWords.map((w, i) => `${i + 1}. <code>${esc(w)}</code>`).join("\n")}`,
        { parse_mode: "HTML" }
      );
    }

    // /rmword clear
    if (arg.toLowerCase() === "clear") {
      const count = rmWords.length;
      rmWords = [];
      return bot.sendMessage(chatId, `🗑️ Cleared ${count} word(s) from the remove list.`);
    }

    // /rmword '<word>' — extract word from quotes or plain arg
    const quoted = arg.match(/^['"](.+?)['"]$/) || arg.match(/^'(.+?)'$/) || arg.match(/^"(.+?)"$/);
    const word = quoted ? quoted[1].trim() : arg.replace(/^['"]|['"]$/g, "").trim();

    if (!word) {
      return bot.sendMessage(chatId,
        `ℹ️ <b>Usage:</b>\n` +
        `• <code>/rmword 'word'</code> — add word to auto-remove list\n` +
        `• <code>/rmword list</code> — show current list\n` +
        `• <code>/rmword clear</code> — clear all words\n\n` +
        `<i>Words are removed from file names whenever you save a file.</i>`,
        { parse_mode: "HTML" }
      );
    }

    const wordLower = word.toLowerCase();
    if (rmWords.includes(wordLower)) {
      return bot.sendMessage(chatId, `⚠️ <code>${esc(word)}</code> is already in the list.`, { parse_mode: "HTML" });
    }

    rmWords.push(wordLower);
    return bot.sendMessage(chatId,
      `✅ Added <code>${esc(word)}</code> to remove list.\n` +
      `📋 Total words: ${rmWords.length}\n\n` +
      `<i>This word will be stripped from all file names on save.</i>`,
      { parse_mode: "HTML" }
    );
  });

  // ── Telegram message link fetch (Owner only) ─────────────────────────────────
  const TG_LINK_RE = /https?:\/\/t\.me\/(c\/(\d+)|([a-zA-Z][a-zA-Z0-9_]{3,}))\/(\d+)/;

  bot.onText(TG_LINK_RE, (msg, match) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return; // Silent ignore

    enqueueFile(userId, async () => {

    const chatId = msg.chat.id;
    const isPrivate = !!match[2];
    const rawId     = match[2];
    const username  = match[3];
    const messageId = parseInt(match[4], 10);
    const fromChatId = isPrivate ? parseInt(`-100${rawId}`, 10) : `@${username}`;

    const processing = await bot.sendMessage(chatId, `⏳ Fetching file from link...`);
    try {
      const forwarded = await bot.forwardMessage(chatId, fromChatId, messageId);
      const fileInfo  = extractFileInfo(forwarded);

      if (!fileInfo) {
        await bot.deleteMessage(chatId, forwarded.message_id).catch(() => {});
        return bot.editMessageText(
          `⚠️ No file found in that message.\n(Only documents, photos, videos, and audio are supported)`,
          { chat_id: chatId, message_id: processing.message_id }
        );
      }

      // Delete the forwarded message from owner chat — we have the file_id now
      await bot.deleteMessage(chatId, forwarded.message_id).catch(() => {});

      const session = bulkSessions.get(userId);
      if (session) {
        // In bulk mode — store file_id as-is in session, will be forwarded to channel on /done
        session.files.push(fileInfo);
        const count = session.files.length;
        return bot.editMessageText(
          `✅ File ${count} added to bulk: ${fileInfo.file_name}\n📦 Total: ${count} file(s)\n\nSend more files/links or type /done to get the link.`,
          { chat_id: chatId, message_id: processing.message_id }
        );
      }

      // Non-bulk: send to storage channel to get a stable channel file_id
      const storedFileInfo = await saveToStorageChannel(bot, fileInfo);
      storedFileInfo.file_name = cleanFileName(storedFileInfo.file_name);

      const code = await getUniqueCode();
      await FileRecord.create({
        code,
        file_id: storedFileInfo.file_id,
        file_type: storedFileInfo.file_type,
        file_name: storedFileInfo.file_name,
        uploaded_by: userId,
        expires_at: null,
      });
      const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
      await bot.deleteMessage(chatId, processing.message_id);

      // ── Auto-lecture mode: auto-add lecture to selected chapter/unit ──────
      if (autoLectureSession && autoLectureSession.active) {
        try {
          const lectureNum = autoLectureSession.lectureCount + 1;
          const lectureName = `Lecture ${lectureNum}`;
          await autoAddLecture({
            batchId:   autoLectureSession.batchId,
            subjectId: autoLectureSession.subjectId,
            chapterId: autoLectureSession.chapterId,
            unitId:    autoLectureSession.unitId,
            name: lectureName,
            link,
          });
          autoLectureSession.lectureCount = lectureNum;
          // Persist to DB so server restart keeps count
          courseRoutes.saveAutoSession && courseRoutes.saveAutoSession();
          const loc = autoLectureSession.unitName
            ? `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`
            : `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
          await bot.sendMessage(chatId,
            `✅ <b>Auto-Saved!</b>\n` +
            `📖 <b>${lectureName}</b>\n` +
            `📁 ${storedFileInfo.file_name}\n` +
            `📍 ${loc}\n` +
            `🔗 <code>${link}</code>\n\n` +
            `📨 Send next video for <b>Lecture ${lectureNum + 1}</b>`,
            { parse_mode: 'HTML' }
          );
        } catch (autoErr) {
          console.error("Auto-lecture error:", autoErr.message);
          await bot.sendMessage(chatId,
            `⚠️ File saved but auto-lecture failed: ${autoErr.message}\n🔗 <code>${link}</code>`,
            { parse_mode: 'HTML' }
          );
        }
      } else {
        await bot.sendMessage(chatId, `✅ ${storedFileInfo.file_name}\n\n🔗 Link:\n<code>${link}</code>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "📥 File Lo", url: link }]] } }
        );
      }

    } catch (err) {
      console.error("Link fetch error:", err.message);
      const errText =
        err.message.includes("chat not found") || err.message.includes("CHAT_ADMIN_REQUIRED")
          ? `❌ Bot is not a member of that group/channel.\nPlease add the bot there first.`
        : err.message.includes("MESSAGE_ID_INVALID") || err.message.includes("not found")
          ? `❌ Message not found. Is the link correct?`
        : err.message.includes("PEER_ID_INVALID")
          ? `❌ Cannot access this group/channel.\nPlease make the bot a member there.`
        : `❌ Error: ${err.message}`;
      try {
        await bot.editMessageText(errText, { chat_id: chatId, message_id: processing.message_id });
      } catch (_) { bot.sendMessage(chatId, errText); }
    }
    }); // end enqueueFile
  });

  // ── Per-user file queue — ensures files are saved one by one in order ─────────
  const fileQueues = new Map(); // userId -> Promise chain

  function enqueueFile(userId, task) {
    const prev = fileQueues.get(userId) || Promise.resolve();
    const next = prev.then(task).catch(() => {});
    fileQueues.set(userId, next);
    // Clean up after done so map doesn't grow forever
    next.finally(() => { if (fileQueues.get(userId) === next) fileQueues.delete(userId); });
  }

  // ── File upload handler (Owner only) ────────────────────────────────────────
  bot.on("message", (msg) => {
    if (isGroupChat(msg)) return; // Ignore all group messages
    if (msg.text && TG_LINK_RE.test(msg.text)) return; // Already handled above
    if (msg.text) return; // Text messages ignore
    if (!isOwner(msg.from?.id)) return; // Silent ignore for non-owner

    const chatId  = msg.chat.id;
    const userId  = msg.from?.id;
    const fileInfo = extractFileInfo(msg);
    if (!fileInfo) return;

    const session = bulkSessions.get(userId);
    if (session) {
      // Bulk mode — enqueue each file so they are added one by one in order.
      // Sending multiple files at once causes simultaneous delivery; without queuing
      // they get pushed to session.files in a random order.
      enqueueFile(userId, async () => {
        session.files.push(fileInfo);
        const count = session.files.length;
        await bot.sendMessage(chatId,
          `✅ File ${count} added: ${fileInfo.file_name}\n📦 Total: ${count} file(s)\n\nSend more files or type /done to get the link.`,
          { reply_to_message_id: msg.message_id }
        );
      });
      return;
    }

    // Non-bulk: queue each file so they save one by one in order
    enqueueFile(userId, async () => {
      const processing = await bot.sendMessage(chatId, `⏳ Saving: ${fileInfo.file_name}...`);
      try {
        // Send file to storage channel to get a stable channel-scoped file_id.
        // This way even if this bot is replaced, the new bot can serve files
        // as long as it is an admin of the same storage channel.
        const storedFileInfo = await saveToStorageChannel(bot, fileInfo);
        storedFileInfo.file_name = cleanFileName(storedFileInfo.file_name);

        const code = await getUniqueCode();
        await FileRecord.create({
          code,
          file_id: storedFileInfo.file_id,
          file_type: storedFileInfo.file_type,
          file_name: storedFileInfo.file_name,
          uploaded_by: userId,
          expires_at: null,
        });
        const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId, processing.message_id);

        // ── Auto-lecture mode: auto-add lecture to selected chapter/unit ──────
        if (autoLectureSession && autoLectureSession.active) {
          try {
            const lectureNum = autoLectureSession.lectureCount + 1;
            const lectureName = `Lecture ${lectureNum}`;
            await autoAddLecture({
              batchId:   autoLectureSession.batchId,
              subjectId: autoLectureSession.subjectId,
              chapterId: autoLectureSession.chapterId,
              unitId:    autoLectureSession.unitId,
              name: lectureName,
              link,
            });
            autoLectureSession.lectureCount = lectureNum;
          // Persist to DB so server restart keeps count
          courseRoutes.saveAutoSession && courseRoutes.saveAutoSession();
            const loc = autoLectureSession.unitName
              ? `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`
              : `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,
              `✅ <b>Auto-Saved!</b>\n` +
              `📖 <b>${lectureName}</b>\n` +
              `📁 ${storedFileInfo.file_name}\n` +
              `📍 ${loc}\n` +
              `🔗 <code>${link}</code>\n\n` +
              `📨 Send next video for <b>Lecture ${lectureNum + 1}</b>`,
              { parse_mode: 'HTML' }
            );
          } catch (autoErr) {
            console.error("Auto-lecture error:", autoErr.message);
            await bot.sendMessage(chatId,
              `⚠️ File saved but auto-lecture failed: ${autoErr.message}\n🔗 <code>${link}</code>`,
              { parse_mode: 'HTML' }
            );
          }
        } else {
          await bot.sendMessage(chatId, `✅ ${storedFileInfo.file_name}\n\n🔗 Link:\n<code>${link}</code>`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "📥 Get File", url: link }]] } }
          );
        }
      } catch (err) {
        console.error("Save error:", err.message);
        try {
          await bot.editMessageText(`❌ Could not save: ${fileInfo.file_name}. Try again.`, {
            chat_id: chatId, message_id: processing.message_id
          });
        } catch (_) { bot.sendMessage(chatId, `❌ Could not save: ${fileInfo.file_name}. Try again.`); }
      }
    });
  });


  // ── /broadcast (Owner only) ──────────────────────────────────────────────────
  // Usage:
  //   Reply to any message (text / photo / video / audio / document /
  //   voice / video_note / sticker / animation) with /broadcast [--pin] [--f]
  //   • --pin  → pin the broadcast message in every recipient's DM
  //   • --f    → forward mode: use Telegram forwardMessage (preserves original sender,
  //               works for ALL media types including stickers; no file_id extraction needed)
  //
  // Flags are combinable:  /broadcast --pin --f
  //
  // The command also accepts inline text:
  //   /broadcast Hello everyone!           (plain text, no flags)
  //   /broadcast --pin Hello everyone!     (plain text + pin)
  //   NOTE: --f has no effect for inline text (nothing to forward).
  //
  // Progress is reported live; a final summary is sent when done.

  bot.onText(/\/broadcast(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return;

    const chatId = msg.chat.id;
    const argRaw     = (match[1] || "").trim();
    const pinFlag    = argRaw.includes("--pin");
    const forwardFlag = argRaw.includes("--f");
    const inlineText = argRaw.replace("--pin", "").replace("--f", "").trim();

    // ── Resolve what to broadcast ────────────────────────────────────────────
    const reply = msg.reply_to_message;

    // Determine broadcast type + payload from replied-to message (if any)
    let broadcastType = null; // "text" | "photo" | "video" | "audio" | "document" |
                               // "voice" | "video_note" | "sticker" | "animation"
    let broadcastPayload = {}; // { file_id?, caption?, text? }

    if (reply) {
      if (reply.sticker) {
        broadcastType = "sticker";
        broadcastPayload = { file_id: reply.sticker.file_id };
      } else if (reply.animation) {
        broadcastType = "animation";
        broadcastPayload = { file_id: reply.animation.file_id, caption: reply.caption || "" };
      } else if (reply.video_note) {
        broadcastType = "video_note";
        broadcastPayload = { file_id: reply.video_note.file_id };
      } else if (reply.voice) {
        broadcastType = "voice";
        broadcastPayload = { file_id: reply.voice.file_id, caption: reply.caption || "" };
      } else if (reply.audio) {
        broadcastType = "audio";
        broadcastPayload = { file_id: reply.audio.file_id, caption: reply.caption || "" };
      } else if (reply.document) {
        broadcastType = "document";
        broadcastPayload = { file_id: reply.document.file_id, caption: reply.caption || "" };
      } else if (reply.video) {
        broadcastType = "video";
        broadcastPayload = { file_id: reply.video.file_id, caption: reply.caption || "" };
      } else if (reply.photo) {
        broadcastType = "photo";
        broadcastPayload = {
          file_id: reply.photo[reply.photo.length - 1].file_id,
          caption: reply.caption || "",
        };
      } else if (reply.text) {
        broadcastType = "text";
        broadcastPayload = { text: reply.text };
      }
    }

    // Fallback: inline text after command
    if (!broadcastType && inlineText) {
      broadcastType = "text";
      broadcastPayload = { text: inlineText };
    }

    if (!broadcastType) {
      return bot.sendMessage(
        chatId,
        `❌ Nothing to broadcast.\n\nUsage:\n` +
        `• Reply to a message with <code>/broadcast</code>\n` +
        `• Or: <code>/broadcast Your message here</code>\n\n` +
        `Flags (combinable):\n` +
        `• <code>--pin</code> → pin message in each DM\n` +
        `• <code>--f</code>   → forward mode (preserves sender info)`,
        { parse_mode: "HTML" }
      );
    }

    // ── Helper: send one message to a single user ────────────────────────────
    // Forward mode: use Telegram's forwardMessage — preserves original sender,
    // works for every content type without needing to extract file_id.
    async function sendBroadcastToUser(targetId) {
      if (forwardFlag && reply) {
        return bot.forwardMessage(targetId, reply.chat.id, reply.message_id);
      }
      const opts = { parse_mode: "HTML" };
      switch (broadcastType) {
        case "text":
          return bot.sendMessage(targetId, broadcastPayload.text, opts);
        case "photo":
          return bot.sendPhoto(targetId, broadcastPayload.file_id,
            broadcastPayload.caption ? { caption: broadcastPayload.caption, ...opts } : {});
        case "video":
          return bot.sendVideo(targetId, broadcastPayload.file_id,
            broadcastPayload.caption ? { caption: broadcastPayload.caption, ...opts } : {});
        case "audio":
          return bot.sendAudio(targetId, broadcastPayload.file_id,
            broadcastPayload.caption ? { caption: broadcastPayload.caption, ...opts } : {});
        case "document":
          return bot.sendDocument(targetId, broadcastPayload.file_id,
            broadcastPayload.caption ? { caption: broadcastPayload.caption, ...opts } : {});
        case "voice":
          return bot.sendVoice(targetId, broadcastPayload.file_id,
            broadcastPayload.caption ? { caption: broadcastPayload.caption, ...opts } : {});
        case "video_note":
          return bot.sendVideoNote(targetId, broadcastPayload.file_id);
        case "sticker":
          return bot.sendSticker(targetId, broadcastPayload.file_id);
        case "animation":
          return bot.sendAnimation(targetId, broadcastPayload.file_id,
            broadcastPayload.caption ? { caption: broadcastPayload.caption, ...opts } : {});
        default:
          throw new Error(`Unknown broadcast type: ${broadcastType}`);
      }
    }

    // ── Fetch all registered users ───────────────────────────────────────────
    let allUsers;
    try {
      allUsers = await User.find({}, { userId: 1 }).lean();
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Failed to fetch users: ${err.message}`);
    }

    if (!allUsers.length) {
      return bot.sendMessage(chatId, `⚠️ No users found in the database.`);
    }

    const typeLabel = {
      text: "📝 Text", photo: "🖼️ Photo", video: "🎬 Video",
      audio: "🎵 Audio", document: "📄 Document", voice: "🎤 Voice",
      video_note: "📹 Video Note", sticker: "🎭 Sticker", animation: "🎞️ Animation",
    }[broadcastType] || broadcastType;

    const modeLabel = forwardFlag ? " ↪️ Forward" : "";
    const progress = await bot.sendMessage(
      chatId,
      `📡 Starting broadcast...\n` +
      `👥 Total users: ${allUsers.length}\n` +
      `📦 Type: ${typeLabel}${modeLabel}${pinFlag ? " + 📌 Pin" : ""}`
    );

    let sent = 0, failed = 0, blocked = 0;
    const BATCH = 25; // messages per batch before a short pause (Telegram rate limit ~30/s)

    for (let i = 0; i < allUsers.length; i++) {
      const targetId = parseInt(allUsers[i].userId, 10);
      if (!targetId) { failed++; continue; }

      try {
        const sentMsg = await sendBroadcastToUser(targetId);

        // Pin the message if --pin flag is set
        if (pinFlag && sentMsg && sentMsg.message_id) {
          try {
            await bot.pinChatMessage(targetId, sentMsg.message_id, { disable_notification: true });
          } catch (_) {
            // Pinning may fail if user revoked pin permissions — non-fatal
          }
        }
        sent++;
      } catch (err) {
        const errMsg = err.message || "";
        if (
          errMsg.includes("blocked") ||
          errMsg.includes("user is deactivated") ||
          errMsg.includes("bot was blocked") ||
          errMsg.includes("Forbidden")
        ) {
          blocked++;
        } else {
          failed++;
        }
      }

      // Live progress every 20 users
      if ((i + 1) % 20 === 0 || i === allUsers.length - 1) {
        try {
          await bot.editMessageText(
            `📡 Broadcasting...\n` +
            `👥 Total: ${allUsers.length}\n` +
            `📦 Type: ${typeLabel}${modeLabel}${pinFlag ? " + 📌 Pin" : ""}\n\n` +
            `✅ Sent: ${sent}\n` +
            `🚫 Blocked: ${blocked}\n` +
            `❌ Failed: ${failed}\n` +
            `⏳ Progress: ${i + 1}/${allUsers.length}`,
            { chat_id: chatId, message_id: progress.message_id }
          );
        } catch (_) {}
      }

      // Throttle: pause briefly after each batch to avoid hitting Telegram limits
      if ((i + 1) % BATCH === 0 && i < allUsers.length - 1) {
        await wait(1000);
      }
    }

    // ── Final summary ────────────────────────────────────────────────────────
    try {
      await bot.editMessageText(
        `✅ <b>Broadcast Complete!</b>\n\n` +
        `📦 Type: ${typeLabel}${modeLabel}${pinFlag ? " + 📌 Pinned" : ""}\n` +
        `👥 Total users: ${allUsers.length}\n\n` +
        `✅ Delivered: ${sent}\n` +
        `🚫 Blocked/Deactivated: ${blocked}\n` +
        `❌ Failed: ${failed}`,
        { chat_id: chatId, message_id: progress.message_id, parse_mode: "HTML" }
      );
    } catch (_) {
      bot.sendMessage(
        chatId,
        `✅ Broadcast done — Sent: ${sent} | Blocked: ${blocked} | Failed: ${failed}`
      );
    }
  });

  // ── /stats (Owner only) ──────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!isOwner(userId)) return;

    const chatId = msg.chat.id;
    const processing = await bot.sendMessage(chatId, '⏳ Fetching stats...');

    try {
      const [statsRes, filesRes, bulkRes] = await Promise.all([
        fetch(`http://localhost:${PORT}/api/stats`),
        FileRecord.countDocuments({}),
        BulkBatch.countDocuments({}),
      ]);

      const s = await statsRes.json();

      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);

      const text =
`📊 <b>Bot Stats</b>

👤 <b>Users</b>
• Total Users: ${s.users.totalUsers}
• New This Week: ${s.users.recentUsers}

📚 <b>Content</b>
• Batches: ${s.content.totalBatches} (🟢 ${s.content.publicBatches} public · 🔒 ${s.content.privateBatches} private)
• Subjects: ${s.content.totalSubjects}
• Chapters: ${s.content.totalChapters}
• Lectures: ${s.content.totalLectures}

📁 <b>File Store</b>
• Single Files: ${filesRes}
• Bulk Batches: ${bulkRes}

🔑 <b>Access</b>
• Total Issued: ${s.access.totalAccess}
• Currently Active: ${s.access.activeAccess}

👥 <b>Referrals</b>
• Total Referrals: ${s.referrals.totalReferrals}
• Unique Referrers: ${s.referrals.uniqueReferrers}

⚙️ <b>Server</b>
• Uptime: ${h}h ${m}m
• Node: ${process.version}
• DB: ${require('mongoose').connection.readyState === 1 ? '🟢 Connected' : '🔴 Disconnected'}`;

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: processing.message_id,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('Stats error:', err.message);
      bot.editMessageText('❌ Could not fetch stats. Try again.', {
        chat_id: chatId, message_id: processing.message_id,
      });
    }
  });

  // ── Polling error ────────────────────────────────────────────────────────────
  bot.on("polling_error", (err) => console.error("Polling error:", err.message));

  process.on("SIGTERM", () => { bot.stopPolling(); mongoose.connection.close(); process.exit(0); });
  process.on("SIGINT",  () => { bot.stopPolling(); mongoose.connection.close(); process.exit(0); });
}

startBot().catch((err) => {
  console.error("Bot startup error:", err.message);
  process.exit(1);
});
