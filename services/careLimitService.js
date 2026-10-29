function parseLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const GUEST_CHAT_LIMIT = parseLimit(process.env.CARE_FREE_CHAT_LIMIT, 5);
const REGISTERED_CHAT_LIMIT = parseLimit(
  process.env.CARE_REGISTERED_CHAT_LIMIT,
  10
);
const GUEST_LOG_LIMIT = parseLimit(process.env.CARE_GUEST_LOG_LIMIT, 3);
const REGISTERED_LOG_LIMIT = parseLimit(
  process.env.CARE_REGISTERED_LOG_LIMIT,
  5
);

function computeUserIsPro(user) {
  if (user?.isPro) return true;
  return user?.subscriptionPlan === "Premium";
}

function isGuestUser(user) {
  if (user?.isGuest === true) return true;
  return /^guest_[^@]+@(wellorahealth\.app|luna\.invalid)$/i.test(
    String(user?.email || "")
  );
}

function getCareChatLimitForUser(user) {
  if (computeUserIsPro(user)) return null;
  return isGuestUser(user) ? GUEST_CHAT_LIMIT : REGISTERED_CHAT_LIMIT;
}

function getCareLogLimitForUser(user) {
  if (computeUserIsPro(user)) return null;
  return isGuestUser(user) ? GUEST_LOG_LIMIT : REGISTERED_LOG_LIMIT;
}

function buildCareLimitConfig() {
  return {
    guest: GUEST_CHAT_LIMIT,
    registered: REGISTERED_CHAT_LIMIT,
    logs: {
      guest: GUEST_LOG_LIMIT,
      registered: REGISTERED_LOG_LIMIT,
      pro: null,
    },
    pro: null,
    proLabel: "unlimited",
  };
}

module.exports = {
  GUEST_CHAT_LIMIT,
  GUEST_LOG_LIMIT,
  REGISTERED_CHAT_LIMIT,
  REGISTERED_LOG_LIMIT,
  buildCareLimitConfig,
  computeUserIsPro,
  getCareChatLimitForUser,
  getCareLogLimitForUser,
  isGuestUser,
};
