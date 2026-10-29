"use strict";
const LeaderboardEntry = require("../models/leaderboardEntryModel");
const FriendProfile = require("../models/friendProfileModel");
const TournamentClaim = require("../models/tournamentClaimModel");
const User = require("../models/usersModel");
const { replayRun, seeds, weekKey } = require("../services/gridbloomReplay");
const { getDaily } = require("../services/gridbloomEngine");
const {
  displayName,
  boardFor,
  isBoardId,
  boardView,
  rankOf,
  tournamentPrize,
  liveWeekKey,
  dayOffset,
} = require("../services/leaderboardService");
const { dayKeyValid } = require("../services/gridbloomReplay");

const lastSubmit = new Map(); // userId -> ms; blunts spamming the replay engine
const MIN_SUBMIT_GAP_MS = 2500;

/**
 * POST /api/leaderboard/submit
 * Body: { mode, log, dayKey?, weekKey?, timeSeconds?, seed?, diff?, durationMs? }
 * The server re-plays the run; the score on the board is the one the rules
 * produce, never one the client claims.
 */
async function submitRun(req, res) {
  try {
    const user = req.authUser;
    // Competing needs an account: guest profiles can play but not be ranked.
    if (user.isGuest) {
      return res.status(403).json({
        code: "LINK_ACCOUNT",
        error: "Link an account to compete on leaderboards.",
      });
    }
    const now = Date.now();
    const key = String(user._id);
    if (now - (lastSubmit.get(key) || 0) < MIN_SUBMIT_GAP_MS) {
      return res.status(429).json({ error: "Please wait a moment before submitting again." });
    }
    lastSubmit.set(key, now);

    const { mode, log, dayKey, timeSeconds, durationMs } = req.body || {};
    const wk = req.body?.weekKey;
    const board = boardFor({ mode, dayKey, weekKey: wk, timeSeconds });
    if (!board) return res.status(400).json({ error: "This board is not open for submissions." });

    const run = { mode, log, durationMs, dailyKey: dayKey, timeSeconds };
    if (mode === "classic") {
      const seed = Number(req.body?.seed);
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        return res.status(400).json({ error: "A valid seed is required for Classic." });
      }
      run.seed = seed;
      run.diff = req.body?.diff;
    } else if (mode === "time") {
      run.seed = seeds.time(timeSeconds, dayKey);
    } else if (mode === "tour") {
      run.seed = seeds.tour(wk);
    }

    const result = replayRun(run);
    if (!result.ok) {
      console.warn(`[leaderboard] rejected ${board} for ${key}: ${result.error}`);
      return res.status(422).json({ error: "This run could not be verified.", detail: result.error });
    }

    const name = displayName(user);
    const existing = await LeaderboardEntry.findOne({ board, userId: user._id });
    let best = result.score;
    let improved = true;
    if (existing) {
      improved = result.score > existing.score;
      best = Math.max(existing.score, result.score);
      existing.plays += 1;
      existing.name = name;
      if (improved) {
        existing.score = result.score;
        existing.moves = result.moves;
        existing.lines = result.lines;
      }
      await existing.save();
    } else {
      await LeaderboardEntry.create({
        board,
        userId: user._id,
        name,
        score: result.score,
        moves: result.moves,
        lines: result.lines,
      });
    }
    const view = await boardView(board, { userId: user._id, limit: 5 });
    return res.json({ accepted: true, board, score: result.score, best, improved, ...view });
  } catch (error) {
    console.error("[leaderboard:submit]", error);
    return res.status(500).json({ error: "Could not submit your score." });
  }
}

/** GET /api/leaderboard/board?board=<id>&limit=20 (auth optional for "me"). */
async function getBoard(req, res) {
  try {
    const board = String(req.query.board || "");
    if (!isBoardId(board)) return res.status(400).json({ error: "Unknown board." });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    return res.json(await boardView(board, { limit, userId: req.authUser?._id || null }));
  } catch (error) {
    console.error("[leaderboard:board]", error);
    return res.status(500).json({ error: "Could not load the leaderboard." });
  }
}

/** GET /api/leaderboard/friends?board=<id> — the caller and their friends. */
async function getFriendsBoard(req, res) {
  try {
    const board = String(req.query.board || "classic");
    if (!isBoardId(board)) return res.status(400).json({ error: "Unknown board." });
    if (req.authUser.isGuest) {
      return res.status(403).json({ code: "LINK_ACCOUNT", error: "Link an account to see friends." });
    }
    const profile = await FriendProfile.findOne({ userId: req.authUser._id }).lean();
    const ids = [req.authUser._id, ...(profile?.friends || [])];
    return res.json(await boardView(board, { limit: 50, userId: req.authUser._id, onlyUsers: ids }));
  } catch (error) {
    console.error("[leaderboard:friends-board]", error);
    return res.status(500).json({ error: "Could not load friends." });
  }
}

// ---- friends -------------------------------------------------------------

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
function newCode() {
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

async function ensureProfile(userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await FriendProfile.findOne({ userId });
    if (existing) return existing;
    try {
      return await FriendProfile.create({ userId, code: newCode(), friends: [] });
    } catch (err) {
      if (err?.code !== 11000) throw err; // code or user collision: retry
    }
  }
  throw new Error("Could not create a friend code");
}

function requireAccount(req, res) {
  if (req.authUser.isGuest) {
    res.status(403).json({ code: "LINK_ACCOUNT", error: "Link an account to add friends." });
    return false;
  }
  return true;
}

async function listFriends(req, res) {
  try {
    if (!requireAccount(req, res)) return;
    const profile = await ensureProfile(req.authUser._id);
    const users = await User.find({ _id: { $in: profile.friends } }, "name isGuest").lean();
    return res.json({
      code: profile.code,
      friends: users.map((u) => ({ userId: String(u._id), name: displayName(u) })),
    });
  } catch (error) {
    console.error("[friends:list]", error);
    return res.status(500).json({ error: "Could not load friends." });
  }
}

async function addFriend(req, res) {
  try {
    if (!requireAccount(req, res)) return;
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) return res.status(400).json({ error: "That friend code looks wrong." });
    const mine = await ensureProfile(req.authUser._id);
    if (mine.code === code) return res.status(400).json({ error: "That is your own code." });
    const theirs = await FriendProfile.findOne({ code });
    if (!theirs) return res.status(404).json({ error: "No player has that code." });
    const friend = await User.findById(theirs.userId, "name isGuest isBanned").lean();
    if (!friend || friend.isBanned) return res.status(404).json({ error: "No player has that code." });
    await FriendProfile.updateOne({ _id: mine._id }, { $addToSet: { friends: theirs.userId } });
    await FriendProfile.updateOne({ _id: theirs._id }, { $addToSet: { friends: mine.userId } });
    return res.json({ added: { userId: String(theirs.userId), name: displayName(friend) } });
  } catch (error) {
    console.error("[friends:add]", error);
    return res.status(500).json({ error: "Could not add that friend." });
  }
}

async function removeFriend(req, res) {
  try {
    if (!requireAccount(req, res)) return;
    const friendId = req.params.userId;
    const mine = await ensureProfile(req.authUser._id);
    await FriendProfile.updateOne({ _id: mine._id }, { $pull: { friends: friendId } });
    await FriendProfile.updateOne({ userId: friendId }, { $pull: { friends: req.authUser._id } });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[friends:remove]", error);
    return res.status(500).json({ error: "Could not remove that friend." });
  }
}

// ---- tournament prizes ---------------------------------------------------

const PRIZE_LOOKBACK_WEEKS = 4;

/** The finished week (`YYYY-Www`) must be one of the last few completed weeks. */
function claimableWeek(week, now = new Date()) {
  if (typeof week !== "string" || !/^\d{4}-W\d{2}$/.test(week)) return false;
  for (let i = 1; i <= PRIZE_LOOKBACK_WEEKS; i++) {
    if (weekKey(new Date(now.getTime() - i * 7 * 86400000)) === week) return true;
  }
  return false;
}

/** GET /api/leaderboard/tournament/prize?week=<finished week> */
async function getTournamentPrize(req, res) {
  try {
    const week = String(req.query.week || "");
    if (!claimableWeek(week)) return res.status(400).json({ error: "That tournament is not claimable." });
    const board = `tour:${week}`;
    const [mine, claim] = await Promise.all([
      LeaderboardEntry.findOne({ board, userId: req.authUser._id }).lean(),
      TournamentClaim.findOne({ userId: req.authUser._id, week }).lean(),
    ]);
    if (!mine) return res.json({ week, played: false, claimed: false, prize: null });
    const rank = await rankOf(board, mine.score);
    const total = await LeaderboardEntry.countDocuments({ board });
    const prize = tournamentPrize({ rank, total, plays: mine.plays });
    return res.json({ week, played: true, claimed: Boolean(claim), rank, total, plays: mine.plays, prize: prize.tier ? prize : null });
  } catch (error) {
    console.error("[tournament:prize]", error);
    return res.status(500).json({ error: "Could not check the prize." });
  }
}

/** POST /api/leaderboard/tournament/claim { week } — once per week. */
async function claimTournamentPrize(req, res) {
  try {
    const week = String(req.body?.week || "");
    if (!claimableWeek(week)) return res.status(400).json({ error: "That tournament is not claimable." });
    const board = `tour:${week}`;
    const mine = await LeaderboardEntry.findOne({ board, userId: req.authUser._id }).lean();
    if (!mine) return res.status(404).json({ error: "You did not play that week." });
    const rank = await rankOf(board, mine.score);
    const total = await LeaderboardEntry.countDocuments({ board });
    const prize = tournamentPrize({ rank, total, plays: mine.plays });
    if (!prize.tier) return res.status(404).json({ error: "No prize for that week." });
    try {
      await TournamentClaim.create({ userId: req.authUser._id, week, prize });
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: "Already claimed." });
      throw err;
    }
    return res.json({ week, rank, total, prize });
  } catch (error) {
    console.error("[tournament:claim]", error);
    return res.status(500).json({ error: "Could not claim the prize." });
  }
}

// ---- daily puzzle --------------------------------------------------------

/** The Daily puzzle as the app's level format. Same for every player. */
function dailyAsLevel(key) {
  const def = getDaily(key);
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = "";
    for (let c = 0; c < 8; c++) {
      const i = r * 8 + c;
      const v = def.board.c[i];
      row += def.board.hole[i] ? "#" : !v ? "." : v === 8 ? "S" : v === 9 ? "I" : String(v);
    }
    rows.push(row);
  }
  return {
    id: `daily:${key}`,
    level: def.n,
    chapter: def.ch,
    indexInChapter: def.k,
    ruleset: 1,
    seed: def.seed,
    difficulty: def.diff,
    peak: def.peak,
    boss: def.boss,
    knownPieceOrder: Boolean(def.fixed),
    board: { rows, pearls: [], region: [] },
    goals: def.goals.map((g) => ({ type: g.type, target: g.n })),
    moveLimit: def.moves,
    stars: { one: "complete", two: { movesLeftAtLeast: def.s2 }, three: { scoreAtLeast: def.s3 } },
    validation: { solver: def.validated?.bot || "greedy-v1", won: true, solution: [] },
  };
}

const dailyCache = new Map();

/** GET /api/game/daily/:key — public. Past days (practice) and today ±1. */
function getDailyPuzzle(req, res) {
  try {
    const key = req.params.key;
    if (!dayKeyValid(key)) return res.status(400).json({ error: "Invalid date." });
    const off = dayOffset(key);
    if (off > 1 || off < -366) return res.status(404).json({ error: "No puzzle for that date." });
    if (!dailyCache.has(key)) {
      dailyCache.set(key, dailyAsLevel(key));
      if (dailyCache.size > 200) dailyCache.delete(dailyCache.keys().next().value);
    }
    return res.json(dailyCache.get(key));
  } catch (error) {
    console.error("[daily]", error);
    return res.status(500).json({ error: "Could not build the puzzle." });
  }
}

module.exports = {
  submitRun,
  getBoard,
  getFriendsBoard,
  listFriends,
  addFriend,
  removeFriend,
  getTournamentPrize,
  claimTournamentPrize,
  getDailyPuzzle,
  dailyAsLevel,
  claimableWeek,
};
