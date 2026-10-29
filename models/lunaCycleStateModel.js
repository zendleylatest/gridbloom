const mongoose = require("mongoose");

const lunaCycleStateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      required: true,
      unique: true,
      index: true,
    },
    state: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    schemaVersion: {
      type: Number,
      default: 1,
    },
    // Minutes ahead of UTC on the user's device (e.g. 300 for UTC+5), sent by
    // the app on save so period reminders go out at 9:00 local time.
    utcOffsetMinutes: {
      type: Number,
      default: 0,
    },
    // App language (2-letter code) sent on save; reminder pushes are written in it.
    languageCode: {
      type: String,
      default: "en",
    },
    // Predicted period start (YYYY-MM-DD) the last reminder was sent for; keeps
    // a reminder from being sent twice.
    lastPeriodReminderFor: {
      type: String,
      default: null,
    },
    aiInsightsCache: {
      stateHash: String,
      cards: [
        {
          title: String,
          body: String,
          category: String,
          _id: false,
        },
      ],
      generatedAt: Date,
      model: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LunaCycleState", lunaCycleStateSchema);
