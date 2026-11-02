"use strict";
/**
 * Sends the reminder push right now to ONE player, so you can check the whole
 * chain (token, Firebase project, phone) without waiting for 09:00 / 18:00.
 *
 *   node scripts/send-reminder-now.js player@example.com
 *
 * It never touches anyone else and does not use the twice-a-day schedule.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/usersModel");
const { sendToAll, messageFor } = require("../services/dailyReminderService");

(async () => {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    console.error("Usage: node scripts/send-reminder-now.js player@example.com");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || "ai_prompt_generator" });
  const user = await User.findOne({ email }).select("deviceTokens dailyReminders");
  if (!user) throw new Error("No user with that email.");
  const tokens = (user.deviceTokens || []).map((d) => d.token).filter(Boolean);
  console.log(`${tokens.length} device(s) registered, dailyReminders=${user.dailyReminders !== false}`);
  if (!tokens.length) throw new Error("This player has no registered device. Open the app once and allow notifications.");
  const result = await sendToAll(tokens, messageFor(0), { type: "daily_reminder", slot: "manual" });
  console.log("result:", result);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
