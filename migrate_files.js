/**
 * migrate_files.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone version of /migrate for bot-token changes.
 *
 * Exact channel_msg_id is always preferred. Legacy rows that lost it are only
 * recovered when the storage-channel match is unambiguous: stable
 * file_unique_id, or a unique non-generic filename+type. It never guesses by
 * file type/order because that can attach the wrong lecture to a code.
 *
 * Usage:
 *   BOT_TOKEN=xxx MONGO_URI=yyy STORAGE_CHANNEL_ID=zzz OWNER_ID=www node migrate_files.js
 */

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID, 10) : null;
const OWNER_ID = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID, 10) : null;

if (!TOKEN || !MONGO_URI || !STORAGE_CHANNEL_ID || !OWNER_ID) {
  console.error("❌ Required: BOT_TOKEN, MONGO_URI, STORAGE_CHANNEL_ID, OWNER_ID");
  process.exit(1);
}

const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  file_id: { type: String, required: true },
  file_unique_id: { type: String, default: "" },
  file_type: { type: String, required: true },
  file_name: { type: String, default: "file" },
  uploaded_by: Number,
  expires_at: { type: Date, default: null },
  delivered_to: [Number],
  created_at: { type: Date, default: Date.now },
  channel_msg_id: { type: Number, default: null },
});
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({
  batch_code: { type: String, required: true, unique: true },
  user_id: Number,
  files: [{
    file_id: String,
    file_unique_id: { type: String, default: "" },
    file_type: String,
    file_name: { type: String, default: "file" },
    channel_msg_id: { type: Number, default: null },
  }],
  created_at: { type: Date, default: Date.now },
});
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

function extractFileInfo(msg) {
  if (msg.document) return { file_id: msg.document.file_id, file_unique_id: msg.document.file_unique_id || "", file_type: "document", file_name: msg.document.file_name || "document" };
  if (msg.photo) { const p = msg.photo[msg.photo.length - 1]; return { file_id: p.file_id, file_unique_id: p.file_unique_id || "", file_type: "photo", file_name: "photo.jpg" }; }
  if (msg.video) return { file_id: msg.video.file_id, file_unique_id: msg.video.file_unique_id || "", file_type: "video", file_name: msg.video.file_name || "video.mp4" };
  if (msg.audio) return { file_id: msg.audio.file_id, file_unique_id: msg.audio.file_unique_id || "", file_type: "audio", file_name: msg.audio.file_name || "audio.mp3" };
  if (msg.voice) return { file_id: msg.voice.file_id, file_unique_id: msg.voice.file_unique_id || "", file_type: "voice", file_name: "voice.ogg" };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_unique_id: msg.video_note.file_unique_id || "", file_type: "video_note", file_name: "video_note.mp4" };
  return null;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
function retryAfterMs(err) {
  const sec = Number(err?.response?.body?.parameters?.retry_after || 0);
  return sec > 0 ? sec * 1000 + 500 : 0;
}
function nameKey(name, type) {
  return `${String(type || "").toLowerCase()}|${String(name || "").toLowerCase().trim().replace(/[\s_.\-:]+/g, " ").trim()}`;
}
function genericName(name) {
  return new Set(["", "file", "document", "photo.jpg", "video.mp4", "audio.mp3", "voice.ogg", "video_note.mp4"]).has(String(name || "").toLowerCase().trim());
}

async function forwardInfo(bot, messageId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let fwd = null;
    try {
      fwd = await bot.forwardMessage(OWNER_ID, STORAGE_CHANNEL_ID, messageId);
      const info = extractFileInfo(fwd);
      if (!info) throw new Error("no file in storage message");
      return info;
    } catch (err) {
      const ms = retryAfterMs(err);
      if (ms && attempt < 3) { await wait(ms); continue; }
      throw err;
    } finally {
      if (fwd?.message_id) await bot.deleteMessage(OWNER_ID, fwd.message_id).catch(() => {});
    }
  }
}


async function mirrorStoredFile(bot, file) {
  const caption = `🔄 Migration backup • ${file.file_name || "file"}`;
  let sent;
  switch (file.file_type) {
    case "photo": sent = await bot.sendPhoto(STORAGE_CHANNEL_ID, file.file_id, { caption }); break;
    case "video": sent = await bot.sendVideo(STORAGE_CHANNEL_ID, file.file_id, { caption }); break;
    case "audio": sent = await bot.sendAudio(STORAGE_CHANNEL_ID, file.file_id, { caption }); break;
    case "voice": sent = await bot.sendVoice(STORAGE_CHANNEL_ID, file.file_id, { caption }); break;
    case "video_note": sent = await bot.sendVideoNote(STORAGE_CHANNEL_ID, file.file_id); break;
    default: sent = await bot.sendDocument(STORAGE_CHANNEL_ID, file.file_id, { caption }); break;
  }
  const info = extractFileInfo(sent);
  if (!info) throw new Error("storage mirror has no file object");
  return { ...info, file_name: file.file_name || info.file_name, channel_msg_id: sent.message_id };
}

async function main() {
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  const bot = new TelegramBot(TOKEN, { polling: false });

  const singles = await FileRecord.find({}).lean();
  const bulkDocs = await BulkBatch.find({});
  const jobs = [];
  const usedChannelIds = new Set();

  for (const rec of singles) {
    const job = { kind: "single", rec, file: rec, label: rec.code };
    jobs.push(job);
    if (rec.channel_msg_id) usedChannelIds.add(Number(rec.channel_msg_id));
  }
  for (const batch of bulkDocs) {
    batch.files.forEach((f, idx) => {
      const job = { kind: "bulk", batch, idx, file: f, label: `${batch.batch_code}#${idx + 1}` };
      jobs.push(job);
      if (f.channel_msg_id) usedChannelIds.add(Number(f.channel_msg_id));
    });
  }

  const known = jobs.filter(j => j.file.channel_msg_id);
  const missing = jobs.filter(j => !j.file.channel_msg_id);
  let refreshed = 0, exactFailed = 0, recovered = 0, ambiguous = 0, notFound = 0;

  async function persist(job, info, channelMsgId) {
    const patch = { file_id: info.file_id, file_unique_id: info.file_unique_id || job.file.file_unique_id || "", channel_msg_id: Number(channelMsgId) };
    if (job.kind === "single") {
      await FileRecord.updateOne({ _id: job.rec._id }, { $set: patch });
      Object.assign(job.rec, patch);
    } else {
      Object.assign(job.batch.files[job.idx], patch);
    }
    Object.assign(job.file, patch);
  }

  console.log(`📦 Exact channel refs: ${known.length} | Missing refs: ${missing.length}`);
  for (let i = 0; i < known.length; i++) {
    const job = known[i];
    try {
      const info = await forwardInfo(bot, job.file.channel_msg_id);
      await persist(job, info, job.file.channel_msg_id);
      refreshed++;
    } catch (err) {
      exactFailed++;
      console.log(`  🚫 ${job.label}: ${err.message}`);
    }
    if ((i + 1) % 20 === 0 || i + 1 === known.length) console.log(`  Exact ${i + 1}/${known.length} | ✅ ${refreshed} 🚫 ${exactFailed}`);
    await wait(180);
  }

  const unresolved = [];
  let remirrored = 0;
  if (missing.length) {
    console.log("🧩 Trying stored file_id re-mirror first (best with OLD bot token)...");
    for (let i = 0; i < missing.length; i++) {
      const job = missing[i];
      try {
        if (!job.file.file_id) throw new Error("missing stored file_id");
        const stored = await mirrorStoredFile(bot, job.file);
        await persist(job, stored, stored.channel_msg_id);
        usedChannelIds.add(Number(stored.channel_msg_id));
        remirrored++;
        console.log(`  🧩 ${job.label} re-mirrored → channel #${stored.channel_msg_id}`);
      } catch (_) {
        unresolved.push(job);
      }
      await wait(160);
    }
  }

  if (unresolved.length) {
    console.log(`🔎 Scanning storage channel for ${unresolved.length} unresolved safe recovery candidates...`);
    const probe = await bot.sendMessage(STORAGE_CHANNEL_ID, "🔄 Migration probe — will be deleted");
    const maxId = probe.message_id;
    await bot.deleteMessage(STORAGE_CHANNEL_ID, probe.message_id).catch(() => {});
    const channelFiles = [];

    for (let id = 1; id <= maxId; id++) {
      if (usedChannelIds.has(id)) continue;
      try {
        const info = await forwardInfo(bot, id);
        channelFiles.push({ ...info, channel_msg_id: id });
      } catch (_) {}
      if (id % 50 === 0 || id === maxId) console.log(`  scanned ${id}/${maxId}, file candidates=${channelFiles.length}`);
      await wait(90);
    }

    const byUnique = new Map(), byName = new Map();
    for (const cf of channelFiles) {
      if (cf.file_unique_id) {
        if (!byUnique.has(cf.file_unique_id)) byUnique.set(cf.file_unique_id, []);
        byUnique.get(cf.file_unique_id).push(cf);
      }
      const k = nameKey(cf.file_name, cf.file_type);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(cf);
    }
    const missingNameCounts = new Map();
    for (const job of unresolved) {
      const k = nameKey(job.file.file_name, job.file.file_type);
      missingNameCounts.set(k, (missingNameCounts.get(k) || 0) + 1);
    }
    const consumed = new Set();

    for (const job of unresolved) {
      let candidates = [], method = "";
      if (job.file.file_unique_id) {
        candidates = (byUnique.get(job.file.file_unique_id) || []).filter(c => !consumed.has(c.channel_msg_id));
        if (candidates.length === 1) method = "file_unique_id";
      }
      const k = nameKey(job.file.file_name, job.file.file_type);
      if (!method && !genericName(job.file.file_name) && missingNameCounts.get(k) === 1) {
        candidates = (byName.get(k) || []).filter(c => !consumed.has(c.channel_msg_id));
        if (candidates.length === 1) method = "unique filename+type";
      }
      if (method) {
        const cf = candidates[0];
        await persist(job, cf, cf.channel_msg_id);
        consumed.add(cf.channel_msg_id);
        recovered++;
        console.log(`  🛠 ${job.label} recovered by ${method} → channel #${cf.channel_msg_id}`);
      } else if (candidates.length > 1 || (!genericName(job.file.file_name) && missingNameCounts.get(k) > 1)) {
        ambiguous++;
        console.log(`  ⚠️ ${job.label}: ambiguous, not guessed`);
      } else {
        notFound++;
        console.log(`  📛 ${job.label}: no safe channel match`);
      }
    }
  }

  // Save modified bulk arrays after exact + recovery phases.
  for (const batch of bulkDocs) await batch.save();

  console.log("\n" + "=".repeat(58));
  console.log("✅ MIGRATION COMPLETE");
  console.log(`🔁 Exact refreshed : ${refreshed}`);
  console.log(`🧩 Re-mirrored      : ${remirrored}`);
  console.log(`🛠 Channel recovered: ${recovered}`);
  console.log(`🚫 Exact failed    : ${exactFailed}`);
  console.log(`⚠️ Ambiguous       : ${ambiguous}`);
  console.log(`📛 No safe match   : ${notFound}`);
  console.log("Fresh file_id + channel_msg_id are persisted in MongoDB.");
  console.log("Best flow for missing channel IDs: run once with OLD bot token, then again with NEW bot token.");
  console.log("=".repeat(58));

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error("❌ Migration error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
