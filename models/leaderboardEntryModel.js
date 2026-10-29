const mongoose = require("mongoose");

/**
 * A player's best verified score on one board. Boards are plain strings:
 *   classic                    all-time Classic
 *   daily:<YYYY-MM-DD>         Daily Challenge of that day
 *   time:<60|120|180>:<day>    Time Challenge of that duration and day
 *   tour:<YYYY-Www>            Weekly Tournament
 * Scores only get here after the server re-played the run (see
 * services/gridbloomReplay.js).
 */
const leaderboardEntrySchema = new mongoose.Schema(
  {
    board: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "users", required: true },
    name: { type: String, default: "Player" },
    score: { type: Number, required: true },
    moves: { type: Number, default: 0 },
    lines: { type: Number, default: 0 },
    // Valid rounds submitted on this board (Tournament participation prize).
    plays: { type: Number, default: 1 },
  },
  { timestamps: true }
);

leaderboardEntrySchema.index({ board: 1, userId: 1 }, { unique: true });
leaderboardEntrySchema.index({ board: 1, score: -1 });

module.exports = mongoose.model("LeaderboardEntry", leaderboardEntrySchema);
