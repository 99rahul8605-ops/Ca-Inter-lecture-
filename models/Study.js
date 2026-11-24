/**
 * models/Study.js
 * Mongoose models for the Study tab: profile/target, subjects, to-do tasks,
 * finished focus sessions, study groups and group chat.
 *
 * Live timers are NOT stored here (they live in memory in routes/study.js and
 * are written to StudySession only when a timer stops).
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

// Indexes must be declared on the schema BEFORE the model is compiled,
// otherwise Mongoose never builds them.
function getModel(name, schema, indexes) {
  if (mongoose.models[name]) return mongoose.models[name];
  (indexes || []).forEach(([fields, opts]) => schema.index(fields, opts || {}));
  return mongoose.model(name, schema);
}

// ── Per-user settings ───────────────────────────────────────────────────────
const StudyProfile = getModel("StudyProfile", new Schema({
  userId: { type: String, required: true, unique: true },
  name: { type: String, default: "" },            // Telegram first name (refreshed on every app open)
  dailyTargetMin: { type: Number, default: 240, min: 10, max: 1440 },
  anonymous: { type: Boolean, default: false },   // hide name in Global Room
  pomodoro: {
    focus: { type: Number, default: 25, min: 1, max: 180 },
    shortBreak: { type: Number, default: 5, min: 1, max: 60 },
    longBreak: { type: Number, default: 15, min: 1, max: 90 },
    rounds: { type: Number, default: 4, min: 1, max: 12 },
  },
}, { timestamps: true }));

// ── Subjects the user studies ───────────────────────────────────────────────
const StudySubject = getModel("StudySubject", new Schema({
  userId: { type: String, required: true, index: true },
  name: { type: String, required: true, maxlength: 40 },
  color: { type: String, default: "#FFB38A" },
  archived: { type: Boolean, default: false },
}, { timestamps: true }));

// ── To-do tasks (one day each; `day` = YYYY-MM-DD in IST) ───────────────────
const StudyTask = getModel("StudyTask", new Schema({
  userId: { type: String, required: true },
  day: { type: String, required: true },
  text: { type: String, required: true, maxlength: 120 },
  subjectId: { type: Schema.Types.ObjectId, default: null },
  done: { type: Boolean, default: false },
  doneAt: { type: Date, default: null },
}, { timestamps: true }), [[{ userId: 1, day: 1 }]]);

// ── Finished focus sessions (what the stats are built from) ─────────────────
const StudySession = getModel("StudySession", new Schema({
  userId: { type: String, required: true },
  day: { type: String, required: true },          // IST day the session started
  subjectId: { type: Schema.Types.ObjectId, default: null },
  subjectName: { type: String, default: "" },     // snapshot, survives subject delete
  subjectColor: { type: String, default: "#B8B2A3" },
  taskId: { type: Schema.Types.ObjectId, default: null },
  mode: { type: String, enum: ["pomodoro", "stopwatch", "custom"], default: "stopwatch" },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, required: true },
  durationSec: { type: Number, required: true, min: 0 },
}), [[{ userId: 1, day: 1 }], [{ day: 1, userId: 1 }]]);

// ── Groups ──────────────────────────────────────────────────────────────────
const StudyGroup = getModel("StudyGroup", new Schema({
  name: { type: String, required: true, maxlength: 40 },
  color: { type: String, default: "#FFD9C2" },
  code: { type: String, required: true, unique: true },   // invite code
  ownerId: { type: String, required: true, index: true },  // the "Admin"
  coAdmins: { type: [String], default: [] },               // max 3
  members: [{
    _id: false,
    userId: { type: String, required: true },
    joinedAt: { type: Date, default: Date.now },
    mutedUntil: { type: Date, default: null },
  }],
  joinType: { type: String, enum: ["invite", "link"], default: "invite" },
  dailyGoalMin: { type: Number, default: 180, min: 0, max: 100000 },
  showTimers: { type: Boolean, default: true },
  chatMode: { type: String, enum: ["everyone", "admins"], default: "everyone" },
  slowSec: { type: Number, default: 0, min: 0, max: 600 },
  pinned: {
    messageId: { type: Schema.Types.ObjectId, default: null },
    text: { type: String, default: "" },
  },
}, { timestamps: true }), [[{ "members.userId": 1 }]]);

// ── Group chat (auto-deleted after 30 days) ─────────────────────────────────
const StudyMessage = getModel("StudyMessage", new Schema({
  groupId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: String, required: true },
  name: { type: String, default: "" },
  text: { type: String, required: true, maxlength: 500 },
  kind: { type: String, enum: ["text", "system"], default: "text" },
  // Reply: a snapshot (name + first 100 chars) of the message being answered, so it still shows if that one is deleted
  reply: {
    id: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, default: "" },
    text: { type: String, default: "", maxlength: 100 },
  },
  deleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
}), [[{ groupId: 1, _id: 1 }]]);

module.exports = { StudyProfile, StudySubject, StudyTask, StudySession, StudyGroup, StudyMessage };
