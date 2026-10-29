const mongoose = require("mongoose");

const androidDeviceUsageSchema = new mongoose.Schema(
  {
    androidIdHash: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-f0-9]{64}$/,
    },
    androidId: {
      type: String,
      trim: true,
      index: true,
    },
    activeGuestUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    guestUserIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    careUsage: {
      totalMessagesUsed: {
        type: Number,
        default: 0,
        min: 0,
      },
      updatedAt: Date,
      logsUsed: {
        type: Number,
        default: 0,
        min: 0,
      },
      logsUpdatedAt: Date,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AndroidDeviceUsage", androidDeviceUsageSchema);
