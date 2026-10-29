const AndroidDeviceUsage = require("../models/androidDeviceUsageModel");
const LunaCycleState = require("../models/lunaCycleStateModel");
const User = require("../models/usersModel");
const {
  computeUserIsPro,
  getCareLogLimitForUser,
  isGuestUser,
} = require("./careLimitService");

function logCount(state) {
  const logs = state?.logs;
  return logs && typeof logs === "object" && !Array.isArray(logs)
    ? Object.keys(logs).length
    : 0;
}

async function ensureLogUsageCounter(user) {
  const userStored = Number(user?.careUsage?.logsUsed || 0);
  const ownRecord = await LunaCycleState.findOne({ userId: user._id })
    .select("state.logs")
    .lean();
  const ownCount = logCount(ownRecord?.state);
  const ownTotal = Math.max(userStored, ownCount);

  if (ownTotal > userStored) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          "careUsage.logsUsed": ownTotal,
          "careUsage.logsUpdatedAt": new Date(),
        },
      }
    );
    if (user.careUsage) user.careUsage.logsUsed = ownTotal;
  }

  if (!isGuestUser(user) || !user.androidIdHash) return ownTotal;

  const device = await AndroidDeviceUsage.findOne({
    androidIdHash: user.androidIdHash,
  });
  if (!device) return ownTotal;

  const guestUserIds = [...(device.guestUserIds || []), user._id];
  const records = await LunaCycleState.find({ userId: { $in: guestUserIds } })
    .select("state.logs")
    .lean();
  const countedForDevice = records.reduce(
    (total, record) => total + logCount(record?.state),
    0
  );
  const storedForDevice = Number(device?.careUsage?.logsUsed || 0);
  const deviceTotal = Math.max(storedForDevice, countedForDevice, ownTotal);

  await AndroidDeviceUsage.updateOne(
    { _id: device._id },
    {
      $set: {
        "careUsage.logsUsed": deviceTotal,
        "careUsage.logsUpdatedAt": new Date(),
        lastSeenAt: new Date(),
      },
      $addToSet: { guestUserIds: user._id },
    }
  );
  return deviceTotal;
}

async function buildLogEntitlement(user) {
  const used = await ensureLogUsageCounter(user);
  const isPro = computeUserIsPro(user);
  const isGuest = isGuestUser(user);
  const limit = getCareLogLimitForUser(user);
  return {
    used,
    limit,
    remaining: isPro ? null : Math.max(0, limit - used),
    hardLocked: !isPro && used >= limit,
    isPro,
    isGuest,
  };
}

async function incrementLogUsage(user, amount) {
  if (!amount || amount < 1) return;
  const now = new Date();
  await User.updateOne(
    { _id: user._id },
    {
      $inc: { "careUsage.logsUsed": amount },
      $set: { "careUsage.logsUpdatedAt": now },
    }
  );
  if (user.careUsage) {
    user.careUsage.logsUsed = Number(user.careUsage.logsUsed || 0) + amount;
  }
  if (isGuestUser(user) && user.androidIdHash) {
    await AndroidDeviceUsage.updateOne(
      { androidIdHash: user.androidIdHash },
      {
        $inc: { "careUsage.logsUsed": amount },
        $set: { "careUsage.logsUpdatedAt": now, lastSeenAt: now },
        $addToSet: { guestUserIds: user._id },
      }
    );
  }
}

module.exports = {
  buildLogEntitlement,
  incrementLogUsage,
  logCount,
};
