const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeProgress, mergeSave, progressScore } = require("../services/gameProgressMerge");

// In-memory stand-in for the Mongoose model: no database needed.
const store = new Map();
const modelPath = require.resolve("../models/gameProgressModel");
function doc(d) {
  return { ...d, toObject: () => ({ ...d }) };
}
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: {
    findOne: (q) => ({ lean: async () => (store.get(String(q.userId)) ? { ...store.get(String(q.userId)) } : null) }),
    create: async (d) => {
      if (store.has(String(d.userId))) throw Object.assign(new Error("dup"), { code: 11000 });
      store.set(String(d.userId), { ...d, updatedAt: new Date() });
      return doc(store.get(String(d.userId)));
    },
    findOneAndUpdate: (q, update) => ({
      lean: async () => {
        const cur = store.get(String(q.userId));
        if (!cur || cur.revision !== q.revision) return null;
        const next = { ...cur, ...update.$set, revision: cur.revision + (update.$inc?.revision || 0), updatedAt: new Date() };
        store.set(String(q.userId), next);
        return { ...next };
      },
    }),
    deleteOne: async (q) => store.delete(String(q.userId)),
  },
};
// Verified purchases decide premium / removeAds (stubbed: no database).
const owned = { premium: false, removeAds: false };
const entPath = require.resolve("../services/entitlementService");
require.cache[entPath] = { id: entPath, filename: entPath, loaded: true, exports: { entitlementsFor: async () => ({ ...owned }) } };
const { getGameProgress, saveGameProgress, deleteGameProgress } = require("../controllers/gameProgressController");

function call(handler, userId, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ authUser: { _id: userId }, body }, res);
  });
}

const base = () => ({
  coins: 500, gems: 10, xp: 0, boosters: { hammer: 2 }, themes: ["classic"], theme: "classic",
  premium: false, removeAds: false, stars: {}, advBest: {}, daily: {}, achClaimed: [],
  stats: { games: 0, best: 0, timeBest: { 60: 0 } },
});

test("first save creates revision 1 and get returns it", async () => {
  store.clear();
  const p = { ...base(), coins: 620 };
  const saved = await call(saveGameProgress, "u1", { progress: p, save: { classicBest: 900 }, baseRevision: 0 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal(saved.body.merged, false);
  const got = await call(getGameProgress, "u1");
  assert.equal(got.body.progress.coins, 620);
  assert.equal(got.body.save.classicBest, 900);
});

test("a fresh user has no data yet", async () => {
  store.clear();
  const got = await call(getGameProgress, "nobody");
  assert.equal(got.body.progress, null);
  assert.equal(got.body.revision, 0);
});

test("in-sync save overwrites, so spending coins is kept", async () => {
  store.clear();
  await call(saveGameProgress, "u1", { progress: { ...base(), coins: 900 }, baseRevision: 0 });
  const r = await call(saveGameProgress, "u1", { progress: { ...base(), coins: 400 }, baseRevision: 1 });
  assert.equal(r.body.revision, 2);
  assert.equal(r.body.merged, false);
  assert.equal(r.body.progress.coins, 400);
});

test("a stale device is merged, never overwriting progress from another", async () => {
  store.clear();
  const deviceA = { ...base(), xp: 500, stars: { 1: 3, 2: 2 }, themes: ["classic", "crystal"], achClaimed: ["a1"], stats: { games: 10, best: 4000, timeBest: { 60: 700 } } };
  await call(saveGameProgress, "u1", { progress: deviceA, save: { classicBest: 4000 }, baseRevision: 0 });
  // Device B never saw revision 1 and plays on from an old copy.
  const deviceB = { ...base(), xp: 100, stars: { 1: 1, 3: 1 }, achClaimed: ["a2"], daily: { "2026-10-29": 300 }, stats: { games: 3, best: 5000, timeBest: { 60: 100 } } };
  const r = await call(saveGameProgress, "u1", { progress: deviceB, save: { classicBest: 1200 }, baseRevision: 0 });
  assert.equal(r.body.merged, true);
  const m = r.body.progress;
  assert.deepEqual(m.stars, { 1: 3, 2: 2, 3: 1 });
  assert.deepEqual(m.themes.sort(), ["classic", "crystal"]);
  assert.deepEqual(m.achClaimed.sort(), ["a1", "a2"]);
  assert.equal(m.daily["2026-10-29"], 300);
  assert.equal(m.stats.best, 5000);
  assert.equal(m.stats.games, 10);
  assert.equal(m.stats.timeBest[60], 700);
  assert.equal(m.xp, 500);
  assert.equal(r.body.save.classicBest, 4000);
});

test("invalid bodies are rejected", async () => {
  store.clear();
  assert.equal((await call(saveGameProgress, "u1", {})).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: [] })).status, 400);
  assert.equal((await call(saveGameProgress, "u1", { progress: {}, save: 5 })).status, 400);
});

test("delete removes the data", async () => {
  store.clear();
  await call(saveGameProgress, "u1", { progress: base(), baseRevision: 0 });
  await call(deleteGameProgress, "u1");
  assert.equal((await call(getGameProgress, "u1")).body.progress, null);
});

test("merge helpers", () => {
  assert.ok(progressScore({ stars: { 1: 3 } }) > progressScore({ xp: 500 }));
  assert.equal(mergeProgress(null, { coins: 5 }).coins, 5);
  assert.equal(mergeSave({ tutorialDone: true }, { tutorialDone: false }, true).tutorialDone, true);
});

test("premium and removeAds come from verified purchases, never from the app", async () => {
  store.clear();
  owned.premium = false;
  owned.removeAds = false;
  const cheat = { ...base(), premium: true, removeAds: true };
  const r = await call(saveGameProgress, "u1", { progress: cheat, baseRevision: 0 });
  assert.equal(r.body.progress.premium, false);
  assert.equal(r.body.progress.removeAds, false);
  assert.equal((await call(getGameProgress, "u1")).body.progress.premium, false);
  owned.premium = true;
  assert.equal((await call(getGameProgress, "u1")).body.progress.premium, true);
  owned.premium = false;
});
