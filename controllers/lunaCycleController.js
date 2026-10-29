const LunaCycleState = require("../models/lunaCycleStateModel");
const { buildCareLimitConfig } = require("../services/careLimitService");
const {
  buildLogEntitlement,
  incrementLogUsage,
} = require("../services/logLimitService");
const { computeUserIsPro } = require("../services/careLimitService");
const {
  buildInsightsHash,
  buildStandardInsights,
  generateAiInsights,
} = require("../services/lunaInsightsService");

function logKeys(state) {
  const logs = state?.logs;
  return logs && typeof logs === "object" && !Array.isArray(logs)
    ? Object.keys(logs)
    : [];
}

async function getLunaCycleState(req, res) {
  try {
    const record = await LunaCycleState.findOne({ userId: req.authUser._id }).lean();
    return res.json({
      state: record?.state || null,
      schemaVersion: record?.schemaVersion || 1,
      updatedAt: record?.updatedAt || null,
    });
  } catch (error) {
    console.error("[luna-cycle:get]", error);
    return res.status(500).json({ error: "Could not load Luna cycle state" });
  }
}

async function saveLunaCycleState(req, res) {
  try {
    const state = req.body?.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return res.status(400).json({ error: "state object is required" });
    }

    const existing = await LunaCycleState.findOne({
      userId: req.authUser._id,
    }).lean();
    const existingKeys = new Set(logKeys(existing?.state));
    const addedLogs = logKeys(state).filter((key) => !existingKeys.has(key)).length;
    const logEntitlement = await buildLogEntitlement(req.authUser);

    if (
      !logEntitlement.isPro &&
      addedLogs > 0 &&
      logEntitlement.used + addedLogs > logEntitlement.limit
    ) {
      return res.status(402).json({
        code: "LOG_LIMIT_REACHED",
        error: logEntitlement.isGuest
          ? "Guest logging limit reached. Bind your account to continue."
          : "Free logging limit reached. Become Pro to continue.",
        entitlement: {
          isPro: logEntitlement.isPro,
          isGuest: logEntitlement.isGuest,
          limits: buildCareLimitConfig(),
          logs: logEntitlement,
        },
      });
    }

    // Only trust a plausible offset (UTC-14 .. UTC+14); otherwise keep the old one.
    const offset = Number(req.body?.utcOffsetMinutes);
    const offsetUpdate =
      Number.isFinite(offset) && Math.abs(offset) <= 14 * 60
        ? { utcOffsetMinutes: Math.round(offset) }
        : {};

    const language = String(req.body?.languageCode || "").toLowerCase().split(/[-_]/)[0];
    const languageUpdate = /^[a-z]{2}$/.test(language) ? { languageCode: language } : {};

    const record = await LunaCycleState.findOneAndUpdate(
      { userId: req.authUser._id },
      {
        $set: {
          state,
          schemaVersion: Number(req.body.schemaVersion) || 1,
          ...offsetUpdate,
          ...languageUpdate,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    if (addedLogs > 0) await incrementLogUsage(req.authUser, addedLogs);
    const updatedLogs = await buildLogEntitlement(req.authUser);

    return res.json({
      state: record.state,
      schemaVersion: record.schemaVersion,
      updatedAt: record.updatedAt,
      entitlement: {
        isPro: updatedLogs.isPro,
        isGuest: updatedLogs.isGuest,
        limits: buildCareLimitConfig(),
        logs: updatedLogs,
      },
    });
  } catch (error) {
    console.error("[luna-cycle:save]", error);
    return res.status(500).json({ error: "Could not save Luna cycle state" });
  }
}

async function deleteLunaCycleState(req, res) {
  try {
    await LunaCycleState.deleteOne({ userId: req.authUser._id });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[luna-cycle:delete]", error);
    return res.status(500).json({ error: "Could not delete Luna cycle state" });
  }
}

function hasActivePremium(user) {
  if (!computeUserIsPro(user)) return false;
  const expiresAt = user?.subscription?.expiresAt;
  return !expiresAt || new Date(expiresAt).getTime() > Date.now();
}

function insightLanguage(value) {
  const supported = new Set([
    "en", "zh", "es", "fr", "pt", "ja", "ar",
    "de", "id", "ru", "sv", "ur", "hi",
  ]);
  const language = String(value || "en").toLowerCase().split(/[-_]/)[0];
  return supported.has(language) ? language : "en";
}

async function getLunaInsights(req, res) {
  try {
    const record = await LunaCycleState.findOne({ userId: req.authUser._id });
    const state = record?.state || {};
    const standard = buildStandardInsights(state, req.query.range);
    const language = insightLanguage(req.query.language);
    const isPremium = hasActivePremium(req.authUser);
    if (!isPremium) {
      return res.json({ standard, isPremium: false, aiInsights: [] });
    }
    if (!Object.keys(state?.logs || {}).length) {
      return res.json({ standard, isPremium: true, aiInsights: [] });
    }

    const stateHash = buildInsightsHash(state, language);
    const cached = record?.aiInsightsCache;
    if (cached?.stateHash === stateHash && cached.cards?.length) {
      return res.json({
        standard,
        isPremium: true,
        aiInsights: cached.cards,
        generatedAt: cached.generatedAt,
        cached: true,
      });
    }

    // AI cards describe the overall recent pattern and do not change when the
    // user switches the symptom-chart range.
    const aiStandard = buildStandardInsights(state, 365);
    const generated = await generateAiInsights(state, aiStandard, language);
    if (record) {
      record.aiInsightsCache = {
        stateHash,
        cards: generated.cards,
        generatedAt: new Date(),
        model: generated.model,
      };
      await record.save();
    }
    await req.authUser.updateOne({
      $inc: {
        "openAiUsage.promptTokens": generated.usage.promptTokens,
        "openAiUsage.completionTokens": generated.usage.completionTokens,
        "openAiUsage.totalTokens": generated.usage.totalTokens,
        "openAiUsage.requestCount": 1,
      },
      $set: { "openAiUsage.lastUsedAt": new Date() },
    });
    return res.json({
      standard,
      isPremium: true,
      aiInsights: generated.cards,
      generatedAt: new Date(),
      cached: false,
    });
  } catch (error) {
    console.error("[luna-cycle:insights]", error);
    return res.status(error.statusCode || 502).json({
      error: error.statusCode === 503
        ? error.message
        : "Could not generate Luna insights",
    });
  }
}

module.exports = {
  getLunaCycleState,
  saveLunaCycleState,
  deleteLunaCycleState,
  getLunaInsights,
};
