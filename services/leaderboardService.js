"use strict";
const LeaderboardEntry = require("../models/leaderboardEntryModel");
const { dayKeyValid, weekKey } = require("./gridbloomReplay");

const DAY_MS = 86400000;
const TIME_DURATIONS = new Set([60, 120, 180]);

/** Player name shown on boards: account name, or a short id for guests. */
function displayName(user) {
  if (user && !user.isGuest && user.name && user.name.trim()) return user.name.trim().slice(0, 24);
  const id = String(user?._id || "0000");
  return `Player ${id.slice(-4).toUpperCase()}`;
}

/** Days between a YYYY-MM-DD key and the server's UTC date. */
function dayOffset(key, now = new Date()) {
  const [y, m, d] = key.split("-").map(Number);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(y, m - 1, d) - todayUtc) / DAY_MS);
}

/**
 * Players live in every time zone, so a day key from the app is accepted if
 * it is within a day of the server's UTC date.
 */
function liveDayKey(key, now = new Date()) {
  return dayKeyValid(key) && Math.abs(dayOffset(key, now)) <= 1;
}

function liveWeekKey(wk, now = new Date()) {
  if (typeof wk !== "string" || !/^\d{4}-W\d{2}$/.test(wk)) return false;
  const offsets = [-7, 0, 7].map((d) => weekKey(new Date(now.getTime() + d * DAY_MS)));
  return offsets.includes(wk);
}

/** Builds the board id for a run, or null if the date/duration is not live. */
function boardFor({ mode, dayKey, weekKey: wk, timeSeconds }, now = new Date()) {
  switch (mode) {
    case "classic":
      return "classic";
    case "daily":
      return liveDayKey(dayKey, now) ? `daily:${dayKey}` : null;
    case "time":
      return TIME_DURATIONS.has(timeSeconds) && liveDayKey(dayKey, now) ? `time:${timeSeconds}:${dayKey}` : null;
    case "tour":
      return liveWeekKey(wk, now) ? `tour:${wk}` : null;
    default:
      return null;
  }
}

const BOARD_PATTERN = /^(classic|daily:\d{4}-\d{2}-\d{2}|time:(60|120|180):\d{4}-\d{2}-\d{2}|tour:\d{4}-W\d{2})$/;
const isBoardId = (b) => typeof b === "string" && BOARD_PATTERN.test(b);

async function rankOf(board, score) {
  return (await LeaderboardEntry.countDocuments({ board, score: { $gt: score } })) + 1;
}

/** Top entries plus the caller's own row, for one board (optionally limited to a user set). */
async function boardView(board, { limit = 20, userId = null, onlyUsers = null } = {}) {
  const filter = { board };
  if (onlyUsers) filter.userId = { $in: onlyUsers };
  const [top, total] = await Promise.all([
    LeaderboardEntry.find(filter).sort({ score: -1, updatedAt: 1 }).limit(limit).lean(),
    LeaderboardEntry.countDocuments(filter),
  ]);
  let me = null;
  if (userId) {
    const mine = await LeaderboardEntry.findOne({ board, userId }).lean();
    if (mine) {
      const rank =
        (await LeaderboardEntry.countDocuments({ ...filter, score: { $gt: mine.score } })) + 1;
      me = { rank, score: mine.score, plays: mine.plays, name: mine.name };
    }
  }
  return {
    board,
    total,
    me,
    entries: top.map((e, i) => ({
      rank: i + 1,
      name: e.name,
      score: e.score,
      isMe: userId ? String(e.userId) === String(userId) : false,
    })),
  };
}

/** Prize rules for a finished tournament week. */
function tournamentPrize({ rank, total, plays }) {
  const prize = { coins: 0, theme: null, badge: null, tier: null };
  if (rank && total) {
    if (rank <= Math.max(1, Math.ceil(total * 0.01))) {
      Object.assign(prize, { coins: 500, theme: "space", tier: "top1" });
    } else if (rank <= Math.max(1, Math.ceil(total * 0.1))) {
      Object.assign(prize, { coins: 200, badge: "tournament-top10", tier: "top10" });
    }
  }
  if (!prize.tier && plays >= 3) Object.assign(prize, { coins: 50, tier: "played3" });
  return prize;
}

module.exports = {
  displayName,
  dayOffset,
  liveDayKey,
  liveWeekKey,
  boardFor,
  isBoardId,
  rankOf,
  boardView,
  tournamentPrize,
};
