const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ---- in-memory stand-ins for the Mongoose models -----------------------------
const entries = [];
const friendProfiles = [];
const claims = [];
const users = new Map();

function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const match = (doc, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$gt" in v) return doc[k] > v.$gt;
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(doc[k]));
    return String(doc[k]) === String(v);
  });

stub("../models/leaderboardEntryModel", {
  findOne: async (q) => {
    const d = entries.find((e) => match(e, q));
    return d ? Object.assign(d, { save: async () => d, lean: () => d }) : null;
  },
  find: (q) => {
    let rows = entries.filter((e) => match(e, q));
    const chain = {
      sort: () => { rows = rows.sort((a, b) => b.score - a.score); return chain; },
      limit: (n) => { rows = rows.slice(0, n); return chain; },
      lean: async () => rows.map((r) => ({ ...r })),
    };
    return chain;
  },
  countDocuments: async (q) => entries.filter((e) => match(e, q)).length,
  create: async (d) => { const e = { plays: 1, ...d }; entries.push(e); return e; },
});
// findOne(...).lean() is used too: make the promise carry .lean
const entryModel = require("../models/leaderboardEntryModel");
const origFindOne = entryModel.findOne;
entryModel.findOne = (q) => {
  const p = origFindOne(q);
  p.lean = async () => { const d = await p; return d ? { ...d } : null; };
  return p;
};
stub("../models/tournamentClaimModel", {
  findOne: (q) => { const p = Promise.resolve(claims.find((c) => match(c, q)) || null); p.lean = async () => p; return p; },
  create: async (d) => {
    if (claims.some((c) => match(c, { userId: d.userId, week: d.week }))) throw Object.assign(new Error("dup"), { code: 11000 });
    claims.push(d);
    return d;
  },
});
stub("../models/friendProfileModel", {
  findOne: (q) => { const p = Promise.resolve(friendProfiles.find((f) => match(f, q)) || null); p.lean = async () => p; return p; },
  create: async (d) => { friendProfiles.push({ _id: `fp${friendProfiles.length}`, ...d }); return friendProfiles[friendProfiles.length - 1]; },
  updateOne: async (q, u) => {
    const f = friendProfiles.find((x) => match(x, q));
    if (f && u.$addToSet) f.friends = [...new Set([...f.friends.map(String), String(u.$addToSet.friends)])];
    if (f && u.$pull) f.friends = f.friends.filter((x) => String(x) !== String(u.$pull.friends));
  },
});
stub("../models/usersModel", {
  findById: (id) => { const p = Promise.resolve(users.get(String(id)) || null); p.lean = async () => p; return p; },
  find: (q) => ({ lean: async () => [...users.values()].filter((u) => q._id.$in.map(String).includes(String(u._id))) }),
});

const c = require("../controllers/leaderboardController");
const { replayRun, weekKey } = require("../services/gridbloomReplay");
const svc = require("../services/leaderboardService");

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors", "dart_vectors.json"), "utf8")).vectors;
const classicVec = vectors.filter((v) => v.mode === "classic");

function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(n) { this.statusCode = n; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ query: {}, body: {}, params: {}, ...req }, res)).catch(reject);
  });
}
const user = (id, name, isGuest = false) => {
  const u = { _id: id, name, isGuest };
  users.set(id, u);
  return u;
};
const reset = () => { entries.length = 0; friendProfiles.length = 0; claims.length = 0; users.clear(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

test("pure helpers: boards, windows and prizes", () => {
  const now = new Date(Date.UTC(2026, 9, 29, 12));
  assert.equal(svc.boardFor({ mode: "classic" }, now), "classic");
  assert.equal(svc.boardFor({ mode: "daily", dayKey: "2026-10-29" }, now), "daily:2026-10-29");
  assert.equal(svc.boardFor({ mode: "daily", dayKey: "2026-10-20" }, now), null);
  assert.equal(svc.boardFor({ mode: "time", dayKey: "2026-10-30", timeSeconds: 120 }, now), "time:120:2026-10-30");
  assert.equal(svc.boardFor({ mode: "time", dayKey: "2026-10-29", timeSeconds: 90 }, now), null);
  assert.equal(svc.boardFor({ mode: "tour", weekKey: weekKey(now) }, now), `tour:${weekKey(now)}`);
  assert.equal(svc.boardFor({ mode: "tour", weekKey: "2020-W01" }, now), null);
  assert.ok(svc.isBoardId("tour:2026-W44") && svc.isBoardId("time:60:2026-10-29") && !svc.isBoardId("x"));
  assert.equal(svc.tournamentPrize({ rank: 1, total: 500, plays: 1 }).theme, "space");
  assert.equal(svc.tournamentPrize({ rank: 40, total: 500, plays: 1 }).coins, 200);
  assert.equal(svc.tournamentPrize({ rank: 300, total: 500, plays: 3 }).coins, 50);
  assert.equal(svc.tournamentPrize({ rank: 300, total: 500, plays: 2 }).tier, null);
  assert.equal(svc.displayName({ _id: "abc12345", isGuest: true }), "Player 2345");
  assert.equal(svc.displayName({ _id: "x", isGuest: false, name: "Sam" }), "Sam");
});

test("a verified Classic run is ranked; a tampered one is rejected", async () => {
  reset();
  const a = user("u0000a", "Ayla");
  const b = user("u0000b", "Ben");
  const guest = user("u0000z", "Guest", true);
  const v1 = classicVec[0];
  const v2 = classicVec.find((v) => v.score > v1.score) || classicVec[1];
  const r1 = await call(c.submitRun, { authUser: a, body: { mode: "classic", seed: v1.seed, diff: v1.diff, log: v1.log } });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.score, v1.score);
  assert.equal(r1.body.me.rank, 1);
  await wait(2600);
  const r2 = await call(c.submitRun, { authUser: b, body: { mode: "classic", seed: v2.seed, diff: v2.diff, log: v2.log } });
  assert.equal(r2.status, 200);
  const board = await call(c.getBoard, { query: { board: "classic" }, authUser: a });
  assert.equal(board.body.total, 2);
  assert.equal(board.body.entries[0].score, Math.max(v1.score, v2.score));
  assert.equal(board.body.entries.find((e) => e.isMe).name, "Ayla");
  assert.equal(board.body.entries.find((e) => !e.isMe).name, "Ben");
  // Guests can read boards but not be ranked.
  const g = await call(c.submitRun, { authUser: guest, body: { mode: "classic", seed: v1.seed, diff: v1.diff, log: v1.log } });
  assert.equal(g.status, 403);
  assert.equal(g.body.code, "LINK_ACCOUNT");
  assert.equal(entries.some((e) => e.userId === "u0000z"), false);
  // A score is never taken from the client: a wrong seed replays to another result or fails.
  await wait(2600);
  const bad = await call(c.submitRun, { authUser: a, body: { mode: "classic", seed: v1.seed + 1, diff: v1.diff, log: v1.log } });
  assert.ok(bad.status === 422 || bad.body.score !== v1.score);
});

test("submissions are throttled and need an open board", async () => {
  reset();
  const a = user("u0000c", "Cy");
  const v = classicVec[0];
  const ok = await call(c.submitRun, { authUser: a, body: { mode: "classic", seed: v.seed, diff: v.diff, log: v.log } });
  assert.equal(ok.status, 200);
  const fast = await call(c.submitRun, { authUser: a, body: { mode: "classic", seed: v.seed, diff: v.diff, log: v.log } });
  assert.equal(fast.status, 429);
  await wait(2600);
  const closed = await call(c.submitRun, { authUser: a, body: { mode: "tour", weekKey: "2020-W01", log: [["p", 0, 0, 0]] } });
  assert.equal(closed.status, 400);
});

test("a tournament round is verified with a server-chosen seed and counts plays", async () => {
  reset();
  const a = user("u0000d", "Dee");
  const wk = weekKey(new Date());
  // The Dart vectors used other weeks' seeds, so play a fresh legal game here.
  const { Game } = require("../services/gridbloomEngine");
  const { seeds } = require("../services/gridbloomReplay");
  const g = new Game({ mode: "tour", seed: seeds.tour(wk), diff: 0.4, ramp: true });
  const log = [];
  for (let i = 0; i < 25 && !g.over; i++) {
    let best = null;
    for (let s = 0; s < 3; s++) {
      if (!g.tray[s]) continue;
      const first = [...g.board.placements(g.tray[s].shape)][0];
      if (first && !best) best = [s, first[0], first[1]];
    }
    if (!best) break;
    g.place(...best);
    log.push(["p", ...best]);
  }
  const r = await call(c.submitRun, { authUser: a, body: { mode: "tour", weekKey: wk, log } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.score, g.score);
  assert.equal(r.body.board, `tour:${wk}`);
});

test("daily puzzle endpoint returns the app's level format", async () => {
  const key = todayKey();
  const res = await call(c.getDailyPuzzle, { params: { key } });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, `daily:${key}`);
  assert.equal(res.body.board.rows.length, 8);
  assert.ok(res.body.board.rows.every((r) => /^[.1-7S I#]{8}$/.test(r.replace(" ", ""))));
  assert.equal(res.body.goals[0].type, "lines");
  assert.ok(res.body.goals[0].target >= 8);
  assert.ok(res.body.moveLimit >= 6);
  assert.equal((await call(c.getDailyPuzzle, { params: { key: "nope" } })).status, 400);
  assert.equal((await call(c.getDailyPuzzle, { params: { key: "2099-01-01" } })).status, 404);
});

test("friends: codes, mutual add, guests blocked", async () => {
  reset();
  const a = user("u0000e", "Eli");
  const b = user("u0000f", "Fay");
  const guest = user("u0000g", "Guest", true);
  assert.equal((await call(c.listFriends, { authUser: guest })).status, 403);
  const la = await call(c.listFriends, { authUser: a });
  const lb = await call(c.listFriends, { authUser: b });
  assert.match(la.body.code, /^[2-9A-HJKMNP-Z]{8}$/);
  assert.equal((await call(c.addFriend, { authUser: a, body: { code: la.body.code } })).status, 400);
  assert.equal((await call(c.addFriend, { authUser: a, body: { code: "ZZZZZZZZ" } })).status, 404);
  const added = await call(c.addFriend, { authUser: a, body: { code: lb.body.code } });
  assert.equal(added.status, 200);
  assert.equal(added.body.added.name, "Fay");
  assert.equal((await call(c.listFriends, { authUser: b })).body.friends[0].name, "Eli");
  // Friends board: only me and my friends
  entries.push({ board: "classic", userId: "u0000e", name: "Eli", score: 500, plays: 1 });
  entries.push({ board: "classic", userId: "u0000f", name: "Fay", score: 900, plays: 1 });
  entries.push({ board: "classic", userId: "stranger", name: "Zed", score: 9999, plays: 1 });
  const fb = await call(c.getFriendsBoard, { authUser: a, query: { board: "classic" } });
  assert.deepEqual(fb.body.entries.map((e) => e.name), ["Fay", "Eli"]);
  assert.equal(fb.body.me.rank, 2);
  assert.equal((await call(c.getFriendsBoard, { authUser: guest, query: { board: "classic" } })).status, 403);
});

test("tournament prize is computed from rank, claimed once", async () => {
  reset();
  const a = user("u0000h", "Hal");
  const lastWeek = weekKey(new Date(Date.now() - 7 * 86400000));
  entries.push({ board: `tour:${lastWeek}`, userId: "u0000h", name: "Hal", score: 800, plays: 4 });
  for (let i = 0; i < 20; i++) entries.push({ board: `tour:${lastWeek}`, userId: `o${i}`, name: "x", score: 100 + i, plays: 1 });
  const info = await call(c.getTournamentPrize, { authUser: a, query: { week: lastWeek } });
  assert.equal(info.body.rank, 1);
  assert.equal(info.body.prize.theme, "space");
  const claim = await call(c.claimTournamentPrize, { authUser: a, body: { week: lastWeek } });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.prize.coins, 500);
  assert.equal((await call(c.claimTournamentPrize, { authUser: a, body: { week: lastWeek } })).status, 409);
  // The running week and old weeks are not claimable
  assert.equal((await call(c.getTournamentPrize, { authUser: a, query: { week: weekKey(new Date()) } })).status, 400);
  assert.equal((await call(c.claimTournamentPrize, { authUser: a, body: { week: "2020-W01" } })).status, 400);
});

test("a Daily run is ranked on today's board and the caller sees name and rank", async () => {
  reset();
  const a = user("u0000k", "Kai");
  const key = todayKey();
  const { Game, getDaily } = require("../services/gridbloomEngine");
  const level = getDaily(key);
  const g = new Game({ mode: "daily", seed: level.seed, diff: level.diff, level, fixed: level.fixed, dailyKey: key });
  const log = [];
  let guard = 0;
  while (!g.over && guard++ < 400) {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const p = g.tray[i];
      if (!p) continue;
      for (const [r, c] of g.board.placements(p.shape)) {
        const L = g.board.linesBy(p.shape, r, c);
        const n = L.rows.length + L.cols.length;
        if (!best || n > best[0]) best = [n, i, r, c];
      }
    }
    if (!best) break;
    g.place(best[1], best[2], best[3]);
    log.push(["p", best[1], best[2], best[3]]);
  }
  assert.equal(g.won, true, "test player should solve the puzzle");
  await wait(2600);
  const r = await call(c.submitRun, { authUser: a, body: { mode: "daily", dayKey: key, log } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.board, `daily:${key}`);
  assert.equal(r.body.me.rank, 1);
  assert.equal(r.body.me.name, "Kai");
  const board = await call(c.getBoard, { query: { board: `daily:${key}` }, authUser: a });
  assert.equal(board.body.me.rank, 1);
  assert.equal(board.body.me.name, "Kai");
  assert.equal(board.body.entries[0].name, "Kai");
  assert.equal(board.body.entries[0].isMe, true);
});
