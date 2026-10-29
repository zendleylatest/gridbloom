const mongoose = require("mongoose");

/**
 * One document per user holding everything the Gridbloom app keeps on the
 * device: the progress map (wallet, boosters, themes, Adventure stars, Daily
 * results, missions, achievements, stats, skill, settings) and the save slot
 * (Classic best score, the in-progress Classic game, tutorial flag, feel
 * settings). Guests and bound accounts share the same user id, so linking an
 * account keeps all of it.
 */
const gameProgressSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      required: true,
      unique: true,
      index: true,
    },
    progress: { type: mongoose.Schema.Types.Mixed, default: {} },
    save: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Bumped on every successful write; clients send the revision they last
    // saw so concurrent devices can be told apart and merged.
    revision: { type: Number, default: 0 },
    schemaVersion: { type: Number, default: 1 },
    clientUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model("GameProgress", gameProgressSchema);
