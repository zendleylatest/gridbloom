const mongoose = require("mongoose");

/** One prize claim per player per finished tournament week. */
const tournamentClaimSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "users", required: true },
    week: { type: String, required: true },
    prize: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

tournamentClaimSchema.index({ userId: 1, week: 1 }, { unique: true });

module.exports = mongoose.model("TournamentClaim", tournamentClaimSchema);
