const User = require("../models/usersModel");
const LunaCycleState = require("../models/lunaCycleStateModel");
const { ensureFirebaseAdmin } = require("../utils/firebaseAdminInit");
const { reminderCopy } = require("./periodReminderMessages");

const LEAD_DAYS = 2;
// Reminders go out between 09:00 and 20:59 local time. The upper bound stops a
// reminder from arriving at night if the server was down at 09:00.
const SEND_HOUR_LOCAL = 9;
const SEND_HOUR_END_LOCAL = 21;
// A reminder is only useful today; don't let the push services deliver it
// days later to a phone that was off.
const PUSH_TTL_MS = 12 * 60 * 60 * 1000;
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE_NAME || "com.speckpro.gridbloomgame.android";
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEBUG_DELAY_SECONDS = 10 * 60;
const MAX_DEBUG_DELAY_SECONDS = 60 * 60;

// ── date helpers (all date-only maths is done on UTC midnights) ─────────────

function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateKey(utcMidnightMs) {
  const d = new Date(utcMidnightMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The user's local "now" expressed as a shifted UTC date (use getUTC*). */
function localNow(nowMs, utcOffsetMinutes) {
  return new Date(nowMs + (Number(utcOffsetMinutes) || 0) * 60 * 1000);
}

function localDayStart(nowMs, utcOffsetMinutes) {
  const d = localNow(nowMs, utcOffsetMinutes);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ── prediction: mirrors LunaCycleState in the app so reminders match what the
// user sees on screen ────────────────────────────────────────────────────────

function periodStartsFromLogs(logs) {
  const starts = [];
  const ordered = Object.entries(logs || {}).sort((a, b) =>
    a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0
  );
  let previousMs = null;
  for (const [key, entry] of ordered) {
    if (!entry || !entry.flow || entry.flow === "none") continue;
    const dateMs = parseDateKey(key);
    if (dateMs === null) continue;
    if (previousMs === null) {
      starts.push(dateMs);
    } else if ((previousMs - dateMs) / DAY_MS > 1) {
      starts.push(dateMs);
    }
    previousMs = dateMs;
  }
  return starts;
}

/** First predicted period start strictly after [todayMs], or null. */
function nextPeriodStart(state, todayMs) {
  const starts = periodStartsFromLogs(state?.logs);
  if (!starts.length) return null;
  const cycleLength = Math.max(1, Number(state?.cycleLength) || 28);
  let next = starts[0];
  while (next <= todayMs) next += cycleLength * DAY_MS;
  return next;
}

/**
 * Decides whether a push is due now for this stored cycle state.
 * Returns `{ key }` (the predicted start date, used for de-duplication) or null.
 */
function reminderDue({ state, utcOffsetMinutes, lastReminderFor, nowMs }) {
  if (!state || state.periodReminders === false) return null;
  const local = localNow(nowMs, utcOffsetMinutes);
  const hour = local.getUTCHours();
  if (hour < SEND_HOUR_LOCAL || hour >= SEND_HOUR_END_LOCAL) return null;

  const todayMs = localDayStart(nowMs, utcOffsetMinutes);
  const next = nextPeriodStart(state, todayMs);
  if (next === null) return null;
  if (Math.round((next - todayMs) / DAY_MS) !== LEAD_DAYS) return null;

  const key = formatDateKey(next);
  if (lastReminderFor === key) return null;
  return { key };
}

function buildReminderMessage(state, { debug = false, languageCode = "en" } = {}) {
  const hideContent = state?.hideNotificationContent !== false;
  const base = reminderCopy(languageCode, { hideContent });
  return debug ? { ...base, body: `${base.body} (debug test)` } : { ...base };
}

// ── sending ─────────────────────────────────────────────────────────────────

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

const REMINDER_APP_NAME = "period-reminders";

function parseServiceAccount(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch (_) {
      return null;
    }
  }
  if (parsed && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

/**
 * FCM messaging for reminders. The app's device tokens belong to the app's own
 * Firebase project, which can differ from the one the shared admin credentials
 * point at, so reminders can use their own credentials:
 * PERIOD_REMINDER_FIREBASE_SERVICE_ACCOUNT (JSON, or base64 of the JSON).
 * Without it, falls back to the server's default Firebase admin.
 */
function getReminderMessaging() {
  const raw =
    process.env.REMINDER_FIREBASE_SERVICE_ACCOUNT || process.env.PERIOD_REMINDER_FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const admin = require("firebase-admin");
    let app = admin.apps.find((a) => a && a.name === REMINDER_APP_NAME);
    if (!app) {
      const serviceAccount = parseServiceAccount(raw);
      if (!serviceAccount) {
        console.error("[period-reminder] PERIOD_REMINDER_FIREBASE_SERVICE_ACCOUNT is not valid JSON/base64");
        return null;
      }
      app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, REMINDER_APP_NAME);
      console.log(`[period-reminder] using Firebase project ${serviceAccount.project_id}`);
    }
    return app.messaging();
  }
  const fallback = ensureFirebaseAdmin();
  return fallback ? fallback.messaging() : null;
}

/** Sends to every device token of a user and prunes dead tokens. */
async function sendPushToUser(userId, { title, body, data = {} }) {
  const messaging = getReminderMessaging();
  if (!messaging) return { sent: 0, reason: "firebase_not_configured" };

  const user = await User.findById(userId).select("deviceTokens isBanned");
  if (!user || user.isBanned) return { sent: 0, reason: "no_user" };
  const tokens = (user.deviceTokens || []).map((d) => d.token).filter(Boolean);
  if (!tokens.length) return { sent: 0, reason: "no_tokens" };

  const expirySeconds = Math.floor((Date.now() + PUSH_TTL_MS) / 1000);
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    android: {
      priority: "high",
      ttl: PUSH_TTL_MS,
      // A repeat send replaces the earlier one in the tray instead of stacking.
      collapseKey: "period_reminder",
      notification: { tag: "period_reminder" },
    },
    apns: {
      headers: { "apns-priority": "10", "apns-expiration": String(expirySeconds) },
      payload: { aps: { sound: "default" } },
    },
    data: Object.fromEntries(
      Object.entries({ targetPackageNames: ANDROID_PACKAGE, ...data }).map(([k, v]) => [String(k), String(v)])
    ),
  });

  const dead = [];
  response.responses.forEach((r, i) => {
    if (!r.success && INVALID_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]);
  });
  if (dead.length) {
    await User.updateOne({ _id: userId }, { $pull: { deviceTokens: { token: { $in: dead } } } });
  }
  return { sent: response.successCount || 0, failed: response.failureCount || 0 };
}

// ── sweep ───────────────────────────────────────────────────────────────────

/**
 * One pass over every stored cycle state. Safe to run on several instances:
 * a reminder is claimed atomically (per user and predicted date) before it is
 * sent, and released again if no device received it so a later pass retries.
 */
async function sweepPeriodReminders({
  nowMs = Date.now(),
  cursor = () =>
    LunaCycleState.find({ "state.periodReminders": { $ne: false } })
      .select("-aiInsightsCache")
      .lean()
      .cursor(),
  claim = async (doc, key) =>
    LunaCycleState.findOneAndUpdate(
      { _id: doc._id, lastPeriodReminderFor: { $ne: key } },
      { $set: { lastPeriodReminderFor: key } },
      { new: false }
    ).lean(),
  release = async (doc, previous) =>
    LunaCycleState.updateOne({ _id: doc._id }, { $set: { lastPeriodReminderFor: previous ?? null } }),
  send = sendPushToUser,
} = {}) {
  const summary = { checked: 0, due: 0, sent: 0 };
  for await (const doc of cursor()) {
    summary.checked += 1;
    const due = reminderDue({
      state: doc.state,
      utcOffsetMinutes: doc.utcOffsetMinutes,
      lastReminderFor: doc.lastPeriodReminderFor,
      nowMs,
    });
    if (!due) continue;
    summary.due += 1;

    const claimed = await claim(doc, due.key);
    if (!claimed) continue; // another instance got it

    try {
      const message = buildReminderMessage(doc.state, { languageCode: doc.languageCode });
      const result = await send(doc.userId, {
        ...message,
        data: { type: "period_reminder", periodStart: due.key },
      });
      if (result.sent > 0) {
        summary.sent += 1;
      } else {
        await release(doc, doc.lastPeriodReminderFor);
      }
    } catch (err) {
      console.error("[period-reminder] send failed:", err.message);
      await release(doc, doc.lastPeriodReminderFor);
    }
  }
  return summary;
}

function pushRemindersEnabled() {
  return String(process.env.PERIOD_REMINDER_PUSH_ENABLED || "").toLowerCase() === "true";
}

let schedulerTimer = null;

/** Starts the periodic sweep (no-op unless PERIOD_REMINDER_PUSH_ENABLED=true). */
function startPeriodReminderScheduler() {
  if (!pushRemindersEnabled()) {
    console.log("[period-reminder] push reminders disabled (set PERIOD_REMINDER_PUSH_ENABLED=true)");
    return;
  }
  if (schedulerTimer) return;
  const run = async () => {
    try {
      const summary = await sweepPeriodReminders();
      if (summary.due) console.log("[period-reminder] sweep:", JSON.stringify(summary));
    } catch (err) {
      console.error("[period-reminder] sweep failed:", err.message);
    }
  };
  schedulerTimer = setInterval(run, SWEEP_INTERVAL_MS);
  schedulerTimer.unref?.();
  console.log("[period-reminder] push reminder scheduler started");
}

// ── debug: push a test reminder after a delay ───────────────────────────────

const debugTimers = new Map();

function debugRemindersEnabled() {
  return String(process.env.PERIOD_REMINDER_DEBUG_ENABLED || "").toLowerCase() === "true";
}

/**
 * Schedules a test push for one user. A new request replaces the previous
 * pending one, so the push always lands [delaySeconds] after the latest call.
 * In-memory only: lost on server restart, which is fine for debugging.
 */
function scheduleDebugReminder(userId, delaySeconds, state, languageCode = "en") {
  const seconds = Math.min(
    Math.max(Number(delaySeconds) || DEFAULT_DEBUG_DELAY_SECONDS, 1),
    MAX_DEBUG_DELAY_SECONDS
  );
  const key = String(userId);
  clearTimeout(debugTimers.get(key));
  const timer = setTimeout(async () => {
    debugTimers.delete(key);
    try {
      const message = buildReminderMessage(state, { debug: true, languageCode });
      const result = await sendPushToUser(userId, {
        ...message,
        data: { type: "period_reminder_debug" },
      });
      console.log(`[period-reminder] debug push for ${key}:`, JSON.stringify(result));
    } catch (err) {
      console.error("[period-reminder] debug push failed:", err.message);
    }
  }, seconds * 1000);
  timer.unref?.();
  debugTimers.set(key, timer);
  return { delaySeconds: seconds, fireAt: new Date(Date.now() + seconds * 1000).toISOString() };
}

module.exports = {
  periodStartsFromLogs,
  nextPeriodStart,
  reminderDue,
  buildReminderMessage,
  sendPushToUser,
  getReminderMessaging,
  sweepPeriodReminders,
  startPeriodReminderScheduler,
  debugRemindersEnabled,
  scheduleDebugReminder,
  LEAD_DAYS,
  SEND_HOUR_LOCAL,
  SEND_HOUR_END_LOCAL,
};
