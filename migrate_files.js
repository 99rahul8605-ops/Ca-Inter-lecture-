/**
 * migrate_files.js
 * ─────────────────────────────────────────────────────────────────
 * Yeh script storage channel ke saare messages scan karke
 * MongoDB mein file_id's update karta hai — bot change ke baad.
 *
 * Usage:
 *   BOT_TOKEN=xxx MONGO_URI=yyy STORAGE_CHANNEL_ID=zzz node migrate_files.js
 *
 * Ya agar .env file hai:
 *   node -r dotenv/config migrate_files.js
 * ─────────────────────────────────────────────────────────────────
 */

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID
  ? parseInt(process.env.STORAGE_CHANNEL_ID)
  : null;

if (!TOKEN || !MONGO_URI || !STORAGE_CHANNEL_ID) {
  console.error("❌ Missing: BOT_TOKEN, MONGO_URI, STORAGE_CHANNEL_ID required.");
  process.exit(1);
}

// ── Schema (same as server.js) ───────────────────────────────────
const fileSchema = new mongoose.Schema({
  code:               { type: String },
  file_id:            { type: String },
  file_type:          { type: String },
  file_name:          { type: String },
  uploaded_by:        { type: Number },
  expires_at:         { type: Date },
  delivered_to:       [{ type: Number }],
  channel_message_id: { type: Number, default: null },
  created_at:         { type: Date },
});
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkFileSchema = new mongoose.Schema({
  batch_code: { type: String },
  user_id:    { type: Number },
  files: [{
    file_id:   { type: String },
    file_type: { type: String },
    file_name: { type: String },
  }],
  created_at: { type: Date },
});
const BulkBatch = mongoose.model("BulkBatch", bulkFileSchema);

// ── Helpers ──────────────────────────────────────────────────────
function extractFileId(msg) {
  if (msg.document)   return { file_id: msg.document.file_id,  file_type: "document" };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length - 1].file_id, file_type: "photo" };
  if (msg.video)      return { file_id: msg.video.file_id,     file_type: "video" };
  if (msg.audio)      return { file_id: msg.audio.file_id,     file_type: "audio" };
  if (msg.voice)      return { file_id: msg.voice.file_id,     file_type: "voice" };
  if (msg.video_note) return { file_id: msg.video_note.file_id,file_type: "video_note" };
  return null;
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Fetch ALL messages from storage channel ──────────────────────
// Telegram Bot API does not have a "getAll" — we use getUpdates trick:
// Forward each message from channel to a temp dummy by message_id range.
// Better approach: use bot.getChat + iterate message IDs.
async function fetchAllChannelMessages(bot) {
  console.log("📡 Fetching channel info...");
  
  // Get latest message_id from channel
  // We send a temp message to get current message_id, then delete it
  const probe = await bot.sendMessage(STORAGE_CHANNEL_ID, "🔄 Migration probe — deleting...");
  const maxId = probe.message_id;
  await bot.deleteMessage(STORAGE_CHANNEL_ID, probe.message_id).catch(() => {});
  
  console.log(`📊 Channel latest message_id: ${maxId}`);
  console.log(`🔍 Scanning ${maxId} message IDs...`);

  const messages = [];
  const BATCH = 25; // forward batch size
  let found = 0, skipped = 0;

  for (let msgId = 1; msgId <= maxId; msgId++) {
    try {
      // Forward from channel to owner's chat to get message object
      // We use copyMessage which gives us file_id without cluttering user chat
      const copied = await bot.forwardMessage(STORAGE_CHANNEL_ID, STORAGE_CHANNEL_ID, msgId);
      const info = extractFileId(copied);
      if (info) {
        messages.push({ message_id: msgId, ...info });
        found++;
        process.stdout.write(`\r✅ Found: ${found} | Skipped: ${skipped} | Progress: ${msgId}/${maxId}`);
      } else {
        skipped++;
      }
      // Delete the forwarded copy
      await bot.deleteMessage(STORAGE_CHANNEL_ID, copied.message_id).catch(() => {});
    } catch (e) {
      // Message deleted or doesn't exist — skip
      skipped++;
    }

    // Rate limit: pause every batch
    if (msgId % BATCH === 0) await wait(1000);
  }

  console.log(`\n\n📦 Total files found in channel: ${found}`);
  return messages;
}

// ── Main Migration ───────────────────────────────────────────────
async function migrate() {
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected\n");

  const bot = new TelegramBot(TOKEN, { polling: false });

  // Step 1: Fetch all files from channel
  const channelFiles = await fetchAllChannelMessages(bot);

  if (!channelFiles.length) {
    console.log("⚠️  No files found in storage channel.");
    await mongoose.disconnect();
    return;
  }

  // Step 2: Build a map of file_type → file_ids from channel (ordered by message_id)
  // We'll match DB records by file_type and update file_id
  console.log("\n🗄️  Fetching all FileRecords from MongoDB...");
  const allRecords = await FileRecord.find({}).lean();
  const allBulkBatches = await BulkBatch.find({}).lean();

  console.log(`📋 FileRecords: ${allRecords.length}`);
  console.log(`📋 BulkBatch files: ${allBulkBatches.reduce((a, b) => a + b.files.length, 0)}\n`);

  // Step 3: Match by file_type — since we can't match by content,
  // we use a smarter approach: forward each channel file to a temp location
  // and try to match with DB records that have SAME file_type.
  // 
  // Best match strategy: file_type match + created_at order
  // Channel messages are in chronological order same as DB records.

  let updated = 0, failed = 0;

  // Group channel files by type
  const channelByType = {};
  for (const cf of channelFiles) {
    if (!channelByType[cf.file_type]) channelByType[cf.file_type] = [];
    channelByType[cf.file_type].push(cf);
  }

  // Group DB records by type, sorted by created_at
  const dbByType = {};
  for (const rec of allRecords) {
    if (!dbByType[rec.file_type]) dbByType[rec.file_type] = [];
    dbByType[rec.file_type].push(rec);
  }
  for (const type in dbByType) {
    dbByType[type].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  console.log("🔄 Matching and updating FileRecords...");
  for (const type in channelByType) {
    const chFiles = channelByType[type];
    const dbFiles = dbByType[type] || [];

    console.log(`\n  Type: ${type} — Channel: ${chFiles.length}, DB: ${dbFiles.length}`);

    const count = Math.min(chFiles.length, dbFiles.length);
    for (let i = 0; i < count; i++) {
      try {
        await FileRecord.updateOne(
          { _id: dbFiles[i]._id },
          { $set: {
            file_id: chFiles[i].file_id,
            channel_message_id: chFiles[i].message_id,
          }}
        );
        updated++;
      } catch (e) {
        failed++;
      }
    }
  }

  // Step 4: Update BulkBatch files similarly
  console.log("\n🔄 Updating BulkBatch files...");
  // Flatten all bulk files with their batch reference
  let bulkUpdated = 0;
  for (const batch of allBulkBatches) {
    let changed = false;
    for (let i = 0; i < batch.files.length; i++) {
      const ft = batch.files[i].file_type;
      if (channelByType[ft] && channelByType[ft].length > 0) {
        // Pop first matching channel file
        const cf = channelByType[ft].shift();
        batch.files[i].file_id = cf.file_id;
        changed = true;
        bulkUpdated++;
      }
    }
    if (changed) {
      await BulkBatch.updateOne({ _id: batch._id }, { $set: { files: batch.files } });
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ Migration Complete!`);
  console.log(`📁 FileRecords updated: ${updated}`);
  console.log(`📦 BulkBatch files updated: ${bulkUpdated}`);
  console.log(`❌ Failed: ${failed}`);
  console.log("=".repeat(50));

  await mongoose.disconnect();
  console.log("\n🔌 MongoDB disconnected. Done!");
}

migrate().catch(err => {
  console.error("Migration error:", err.message);
  process.exit(1);
});
