const mongoose = require("mongoose");

/** Private friend code plus the mutual friend list. Accounts only. */
const friendProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "users", required: true, unique: true },
    code: { type: String, required: true, unique: true, index: true },
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "users" }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("FriendProfile", friendProfileSchema);
