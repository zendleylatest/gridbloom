const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
    },
    email: {
      type: String,
      unique: true,
      trim: true,
      lowercase: true,
    },
    profession: {
      type: String,
    },
    password: {
      type: String,
    },
    image: {
      type: String,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
    },
    otp: {
      type: String,
    },
    // When the signup verification code was last sent (resend cooldown).
    otpSentAt: {
      type: Date,
    },
    // Wrong guesses against the current signup / guest-binding code. Reset
    // whenever a fresh code is issued.
    otpAttempts: {
      type: Number,
      default: 0,
    },
    // Resend rate limit window, shared by signup and guest-binding codes.
    otpResend: {
      count: { type: Number, default: 0 },
      windowStart: { type: Date },
    },
    emailVerified: {
      type: Boolean,
    },
    isGuest: {
      type: Boolean,
      default: false,
      index: true,
    },
    guestKey: {
      type: String,
      unique: true,
      sparse: true,
    },
    androidIdHash: {
      type: String,
      lowercase: true,
      trim: true,
      index: true,
      match: /^[a-f0-9]{64}$/,
    },
    androidId: {
      type: String,
      trim: true,
      index: true,
    },
    pendingBinding: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      password: { type: String },
      otp: { type: String },
      requestedAt: { type: Date },
    },
    googleId: {
      type: String,
    },
    appleId: {
      type: String,
      index: true,
      sparse: true,
    },
    resetOTP: {
      type: String,
    },
    resetOtpSentAt: {
      type: Date,
    },
    resetOtpAttempts: {
      type: Number,
      default: 0,
    },
    resetOtpResend: {
      count: { type: Number, default: 0 },
      windowStart: { type: Date },
    },
    isBanned: {
      type: Boolean,
      default: false,
      index: true,
    },
    bannedAt: {
      type: Date,
      default: null,
    },
    bannedReason: {
      type: String,
      default: "",
      trim: true,
    },
    // Turned off in Settings to stop the twice-a-day reminder push.
    dailyReminders: { type: Boolean, default: true },
    deviceTokens: [
      {
        token: {
          type: String,
          required: true,
        },
        deviceType: {
          type: String,
          default: "unknown",
        },
        deviceInfo: {
          os: { type: String, default: "" },
          appVersion: { type: String, default: "" },
        },
        registeredAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

module.exports = User;
