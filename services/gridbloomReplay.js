"use strict";
/**
 * Re-simulates a submitted Gridbloom run on the server and returns the
 * score the rules produce. The client only sends the seed (for Classic) and
 * the list of actions it took; the server derives everything else, so a
 * tampered score or an impossible move is caught.
 */
const { Game, getDaily, hash } = require("./gridbloomEngine");

const MAX_OPS = 4000;
const TIME_BONUS_SECONDS = 3;
const MIN_MS_PER_MOVE = 180;
const BOOSTER_OPS = new Set(["h", "r", "c", "t", "s", "x"]);

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** `YYYY-MM-DD` plus the week key the app derives from the same date. */
function dayKeyValid(key) {
  return typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(Date.parse(key));
}

/** ISO week key, same scheme as the app (`2026-W44`). */
function weekKey(date = new Date()) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

function configFor({ mode, seed, diff, timeSeconds, dailyKey }) {
  switch (mode) {
    case "classic":
      return { mode, seed: seed >>> 0, diff: Math.min(0.9, Math.max(0.1, Number(diff) || 0.4)), ramp: true };
    case "time":
      return { mode, seed, diff: 0.4, ramp: false, time: timeSeconds };
    case "tour":
      return { mode, seed, diff: 0.4, ramp: true };
    case "daily": {
      const level = getDaily(dailyKey);
      return { mode, seed: level.seed, diff: level.diff, level, fixed: level.fixed, dailyKey };
    }
    default:
      return null;
  }
}

/**
 * @returns {{ok: true, score, moves, lines, won, over, bestCombo} | {ok: false, error}}
 */
function replayRun(run) {
  const { mode, log } = run;
  if (!Array.isArray(log) || log.length === 0 || log.length > MAX_OPS) {
    return { ok: false, error: "Invalid move log" };
  }
  const cfg = configFor(run);
  if (!cfg) return { ok: false, error: "Unknown mode" };
  const boostersAllowed = mode === "classic";
  const g = new Game(cfg);
  let secondChances = 0;
  let timeBonuses = 0;

  for (let i = 0; i < log.length; i++) {
    const op = log[i];
    if (!Array.isArray(op) || typeof op[0] !== "string") return { ok: false, error: `Bad action ${i}` };
    const kind = op[0];
    if (BOOSTER_OPS.has(kind) && !boostersAllowed) {
      return { ok: false, error: "Boosters are not allowed in this mode" };
    }
    if (g.over && kind !== "x") return { ok: false, error: `Action ${i} after the game ended` };

    switch (kind) {
      case "p": {
        const [, slot, r, c] = op;
        if (!isInt(slot, 0, 2) || !isInt(r, 0, 7) || !isInt(c, 0, 7)) return { ok: false, error: `Bad move ${i}` };
        const before = g.timeLeft;
        const res = g.place(slot, r, c);
        if (!res) return { ok: false, error: `Illegal move ${i}` };
        if (cfg.time && g.timeLeft > before) timeBonuses++;
        break;
      }
      case "h": {
        if (!isInt(op[1], 0, 63) || !g.hammer(op[1])) return { ok: false, error: `Illegal hammer ${i}` };
        break;
      }
      case "r":
      case "c": {
        if (!isInt(op[1], 0, 7)) return { ok: false, error: `Bad line ${i}` };
        g.clearLine(kind === "r", op[1]);
        break;
      }
      case "t": {
        if (!isInt(op[1], 0, 2) || !g.rotate(op[1])) return { ok: false, error: `Illegal rotate ${i}` };
        break;
      }
      case "s":
        g.shuffle();
        break;
      case "x": {
        if (!g.over || ++secondChances > 1) return { ok: false, error: `Illegal second chance ${i}` };
        g.secondChance();
        break;
      }
      default:
        return { ok: false, error: `Unknown action ${kind}` };
    }
  }

  if (mode === "time") {
    const allowed = (cfg.time + timeBonuses * TIME_BONUS_SECONDS) * 1000 + 3000;
    const ms = Number(run.durationMs);
    if (!Number.isFinite(ms) || ms > allowed || ms < g.moves * MIN_MS_PER_MOVE) {
      return { ok: false, error: "Run duration does not match the moves played" };
    }
  }
  if (mode === "daily") {
    if (!g.won) return { ok: false, error: "Daily puzzle was not solved" };
    if (g.moves > cfg.level.moves) return { ok: false, error: "Too many moves" };
  }
  return { ok: true, score: g.score, moves: g.moves, lines: g.lines, won: g.won, over: g.over, bestCombo: g.bestCombo };
}

/** Seeds the server dictates for the ranked modes (client sends only the date keys). */
const seeds = {
  time: (seconds, dayKey) => hash(`time-${seconds}-${dayKey}`),
  tour: (wk) => hash(`tour-${wk}`),
};

module.exports = { replayRun, dayKeyValid, weekKey, seeds, MAX_OPS };
