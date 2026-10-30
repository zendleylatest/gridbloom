const User = require("../models/usersModel");
const PushDeviceToken = require("../models/pushDeviceTokenModel");
const ReminderRun = require("../models/reminderRunModel");
const { getReminderMessaging } = require("./periodReminderPushService");

// Everyone gets the same push at the same moment, so the times are plain UTC
// and local time zones are ignored on purpose. Change them with
// DAILY_REMINDER_TIMES_UTC="HH:MM,HH:MM".
const DEFAULT_TIMES = "09:00,18:00";
const SWEEP_INTERVAL_MS = 60 * 1000;
// A slot still counts for this long after its time, so a restart or a short
// outage does not skip it. Later than that it is dropped rather than sent late.
const CATCH_UP_MS = 60 * 60 * 1000;
const PUSH_TTL_MS = 6 * 60 * 60 * 1000;
const CHUNK_SIZE = 500;
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE_NAME || "com.speckpro.gridbloomgame.android";

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

// One list per slot, rotated by day of year so the push is not identical daily.
const COPY = [
  [
    { title: "Your daily puzzle is ready 🌸", body: "A fresh Daily board is waiting. Keep your streak going!" },
    { title: "Good morning from Gridbloom", body: "Clear a few lines and claim today's rewards." },
    { title: "New day, new board 🧩", body: "Today's Daily puzzle and your free rewards are ready." },
  ],
  [
    { title: "Still time for today's puzzle 🌷", body: "Finish your Daily before the day ends and keep your streak." },
    { title: "Evening wind-down?", body: "A few relaxing rounds of Gridbloom are waiting for you." },
    { title: "Don't lose your streak 🔥", body: "Play today's Daily and collect your reward." },
  ],
];

/** Parses "09:00,18:00" into sorted [{ hour, minute }]; bad entries are skipped. */
function parseTimes(raw = process.env.DAILY_REMINDER_TIMES_UTC || DEFAULT_TIMES) {
  const times = [];
  for (const part of String(raw).split(",")) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) continue;
    times.push({ hour, minute });
  }
  times.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  return times.length ? times : parseTimes(DEFAULT_TIMES);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * The slots that are due right now: today's slot times that have already
 * passed but are within the catch-up window. Returns [{ slot, index }] where
 * `slot` is the de-duplication key and `index` picks the message set.
 */
function dueSlots(nowMs = Date.now(), times = parseTimes()) {
  const now = new Date(nowMs);
  const day = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const due = [];
  times.forEach(({ hour, minute }, index) => {
    const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
    const age = nowMs - at;
    if (age >= 0 && age < CATCH_UP_MS) due.push({ slot: `${day}T${pad(hour)}:${pad(minute)}`, index });
  });
  return due;
}

function messageFor(index, nowMs = Date.now()) {
  const set = COPY[Math.min(index, COPY.length - 1)];
  const dayOfYear = Math.floor((nowMs - Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 0)) / 86400000);
  return set[dayOfYear % set.length];
}

/** Every unique device token: logged-in users (not banned) plus standalone installs. */
async function collectTokens() {
  const tokens = new Set();
  const users = await User.find({ "deviceTokens.0": { $exists: true }, isBanned: { $ne: true } })
    .select("deviceTokens")
    .lean();
  for (const u of users) for (const d of u.deviceTokens || []) if (d?.token) tokens.add(d.token);
  const standalone = await PushDeviceToken.find({ isActive: true }).select("token").lean();
  for (const row of standalone) if (row?.token) tokens.add(row.token);
  return [...tokens];
}

async function removeDeadTokens(dead) {
  if (!dead.length) return;
  await User.updateMany({ "deviceTokens.token": { $in: dead } }, { $pull: { deviceTokens: { token: { $in: dead } } } });
  await PushDeviceToken.deleteMany({ token: { $in: dead } });
}

async function sendToAll(tokens, { title, body }, data, messaging = getReminderMessaging()) {
  if (!messaging) return { sent: 0, failed: 0, reason: "firebase_not_configured" };
  const expirySeconds = Math.floor((Date.now() + PUSH_TTL_MS) / 1000);
  let sent = 0;
  let failed = 0;
  const dead = [];
  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    const response = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      android: {
        priority: "high",
        ttl: PUSH_TTL_MS,
        // A second reminder replaces an unread first one instead of stacking.
        collapseKey: "daily_reminder",
        notification: { tag: "daily_reminder" },
      },
      apns: {
        headers: { "apns-priority": "10", "apns-expiration": String(expirySeconds) },
        payload: { aps: { sound: "default" } },
      },
      data: Object.fromEntries(
        Object.entries({ targetPackageNames: ANDROID_PACKAGE, ...data }).map(([k, v]) => [String(k), String(v)])
      ),
    });
    sent += response.successCount || 0;
    failed += response.failureCount || 0;
    response.responses.forEach((r, j) => {
      if (!r.success && INVALID_TOKEN_CODES.has(r.error?.code)) dead.push(chunk[j]);
    });
  }
  await removeDeadTokens(dead);
  return { sent, failed };
}

/** Claims a slot. False when another run (or instance) already did. */
async function claimSlot(slot) {
  try {
    await ReminderRun.create({ slot });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

/**
 * One pass: sends every due slot that has not been sent yet. If nothing could
 * be delivered (Firebase down, no tokens reachable) the claim is released so
 * the next pass inside the catch-up window retries.
 */
async function sweepDailyReminders({
  nowMs = Date.now(),
  times = parseTimes(),
  claim = claimSlot,
  release = (slot) => ReminderRun.deleteOne({ slot }),
  record = (slot, result) => ReminderRun.updateOne({ slot }, { $set: result }),
  tokensFn = collectTokens,
  send = sendToAll,
} = {}) {
  const summary = { due: 0, sent: 0, failed: 0 };
  for (const { slot, index } of dueSlots(nowMs, times)) {
    if (!(await claim(slot))) continue;
    summary.due += 1;
    try {
      const tokens = await tokensFn();
      if (!tokens.length) continue; // nobody to tell; keep the slot claimed
      const result = await send(tokens, messageFor(index, nowMs), { type: "daily_reminder", slot });
      if (!result.sent) {
        await release(slot);
        continue;
      }
      summary.sent += result.sent;
      summary.failed += result.failed;
      await record(slot, { totalTokens: tokens.length, sent: result.sent, failed: result.failed });
    } catch (err) {
      console.error("[daily-reminder] send failed:", err.message);
      await release(slot);
    }
  }
  return summary;
}

function remindersEnabled() {
  return String(process.env.DAILY_REMINDERS_ENABLED || "").toLowerCase() === "true";
}

let timer = null;

/** Starts the once-a-minute check (no-op unless DAILY_REMINDERS_ENABLED=true). */
function startDailyReminderScheduler() {
  if (!remindersEnabled()) {
    console.log("[daily-reminder] disabled (set DAILY_REMINDERS_ENABLED=true)");
    return;
  }
  if (timer) return;
  const run = async () => {
    try {
      const summary = await sweepDailyReminders();
      if (summary.due) console.log("[daily-reminder] sweep:", JSON.stringify(summary));
    } catch (err) {
      console.error("[daily-reminder] sweep failed:", err.message);
    }
  };
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
  run();
  const at = parseTimes().map((t) => `${pad(t.hour)}:${pad(t.minute)}`).join(", ");
  console.log(`[daily-reminder] scheduler started (UTC ${at})`);
}

module.exports = {
  parseTimes,
  dueSlots,
  messageFor,
  sweepDailyReminders,
  startDailyReminderScheduler,
  CATCH_UP_MS,
};
