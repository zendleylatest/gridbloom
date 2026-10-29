const LunaCycleState = require("../models/lunaCycleStateModel");
const {
  debugRemindersEnabled,
  scheduleDebugReminder,
} = require("../services/periodReminderPushService");

/**
 * Debug only (PERIOD_REMINDER_DEBUG_ENABLED=true): pushes a test period
 * reminder to the caller's devices after `delaySeconds` (default 600).
 * A new call replaces the pending one.
 */
async function handleDebugPeriodReminder(req, res) {
  try {
    if (!debugRemindersEnabled()) {
      return res.status(404).json({ error: "Not found" });
    }
    const record = await LunaCycleState.findOne({ userId: req.authUser._id }).lean();
    const scheduled = scheduleDebugReminder(
      req.authUser._id,
      req.body?.delaySeconds,
      record?.state || {},
      record?.languageCode
    );
    return res.status(202).json({ success: true, ...scheduled });
  } catch (err) {
    console.error("[period-reminder] debug endpoint error:", err);
    return res.status(500).json({ error: "Could not schedule the debug reminder" });
  }
}

module.exports = { handleDebugPeriodReminder };
