const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { replayRun, seeds, weekKey } = require("../services/gridbloomReplay");
const { Game, getDaily } = require("../services/gridbloomEngine");

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors", "dart_vectors.json"), "utf8")).vectors;

test("the server engine reproduces every score from the Dart engine", () => {
  assert.ok(vectors.length >= 15);
  for (const [i, v] of vectors.entries()) {
    const res = replayRun({
      mode: v.mode,
      seed: v.seed,
      diff: v.diff,
      timeSeconds: 120,
      // Time runs need a plausible duration: generous but within the clock.
      durationMs: v.mode === "time" ? Math.max(v.moves * 200, 1000) : undefined,
      log: v.log,
    });
    assert.equal(res.ok, true, `vector ${i} (${v.mode}) rejected: ${res.error}`);
    assert.equal(res.score, v.score, `vector ${i} (${v.mode}, seed ${v.seed}) score`);
    assert.equal(res.moves, v.moves, `vector ${i} moves`);
    assert.equal(res.lines, v.lines, `vector ${i} lines`);
  }
});

test("ranked seeds are derived on the server", () => {
  const v = vectors.find((x) => x.mode === "time");
  assert.ok(typeof seeds.time(120, "2026-10-20") === "number");
  assert.match(weekKey(new Date(2026, 9, 29)), /^2026-W44$/);
  assert.ok(v);
});

function playDaily(key) {
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
  return { g, log };
}

test("a daily puzzle replays on the server", () => {
  const key = "2026-10-29";
  const { g, log } = playDaily(key);
  const res = replayRun({ mode: "daily", dailyKey: key, log });
  if (g.won) {
    assert.equal(res.ok, true, res.error);
    assert.equal(res.score, g.score);
  } else {
    assert.equal(res.ok, false); // an unsolved puzzle is never accepted
  }
});

test("cheating is rejected", () => {
  const v = vectors.find((x) => x.mode === "tour" && x.moves > 20);
  const base = { mode: "tour", seed: v.seed, log: v.log };
  assert.equal(replayRun(base).ok, true);
  // An illegal placement (off the board)
  assert.equal(replayRun({ ...base, log: [["p", 0, 9, 9]] }).ok, false);
  // Boosters in a ranked mode
  assert.equal(replayRun({ ...base, log: [["h", 3]] }).ok, false);
  // Moves after the game ended
  const over = vectors.find((x) => x.mode === "tour" && x.over);
  assert.equal(replayRun({ mode: "tour", seed: over.seed, log: [...over.log, ["p", 0, 0, 0]] }).ok, false);
  // Empty / huge logs
  assert.equal(replayRun({ ...base, log: [] }).ok, false);
  assert.equal(replayRun({ ...base, log: Array(5000).fill(["p", 0, 0, 0]) }).ok, false);
  // Time runs: duration must fit the clock
  const t = vectors.find((x) => x.mode === "time");
  assert.equal(replayRun({ mode: "time", seed: t.seed, timeSeconds: 120, durationMs: 999999, log: t.log }).ok, false);
  assert.equal(replayRun({ mode: "time", seed: t.seed, timeSeconds: 120, durationMs: 100, log: t.log }).ok, false);
});

test("the server replays Daily runs played in the app on the server's own puzzle", () => {
  const dailyVectors = JSON.parse(
    fs.readFileSync(path.join(__dirname, "vectors", "dart_daily_vectors.json"), "utf8")
  ).vectors;
  assert.ok(dailyVectors.length >= 3);
  for (const v of dailyVectors) {
    assert.equal(v.won, true);
    const res = replayRun({ mode: "daily", dailyKey: v.dayKey, log: v.log });
    assert.equal(res.ok, true, `${v.dayKey}: ${res.error}`);
    assert.equal(res.score, v.score, `${v.dayKey} score`);
    assert.equal(res.moves, v.moves, `${v.dayKey} moves`);
  }
});
