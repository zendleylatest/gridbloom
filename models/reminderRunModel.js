const mongoose = require("mongoose");

/**
 * One row per reminder slot that has been sent (e.g. "2026-10-30T09:00").
 * The unique `slot` is the lock that keeps a restart or a second server
 * instance from sending the same reminder twice.
 */
const reminderRunSchema = new mongoose.Schema(
  {
    slot: { type: String, required: true, unique: true },
    totalTokens: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    // Old rows clean themselves up after 30 days.
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
  },
  { versionKey: false }
);

module.exports = mongoose.model("ReminderRun", reminderRunSchema);
