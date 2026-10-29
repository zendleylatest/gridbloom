"use strict";
/**
 * Gridbloom rules engine for the server, copied from the reviewed prototype
 * (gridbloom-prototype.html, sections 1-2) so the backend can replay a
 * submitted run from its seed and check the score. Ruleset v1.
 *
 * Keep this file identical in behaviour to the Dart core in the app: the
 * test vectors in test/vectors are produced by the Dart engine and replayed
 * here, and both must agree on every score.
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hash(s) { let h = 0x811C9DC5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  u32() { this.s = (this.s + 0x6D2B79F5) >>> 0; let t = this.s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) >>> 0; }
  dbl() { return this.u32() / 4294967296; }
  int(n) { return Math.floor(this.dbl() * n); }
}
const N = 8, NN = 64;
const SHAPE_DEFS = [
  ["single", 2.0, ["X"]], ["line2", 4.0, ["XX"]], ["line3", 4.0, ["XXX"]], ["line4", 3.0, ["XXXX"]], ["line5", 1.5, ["XXXXX"]],
  ["square2", 4.0, ["XX", "XX"]], ["square3", 1.2, ["XXX", "XXX", "XXX"]], ["rect23", 1.8, ["XXX", "XXX"]],
  ["corner3", 4.0, ["XX", "X."]], ["corner5", 1.8, ["XXX", "X..", "X.."]], ["ell4", 2.5, ["X.", "X.", "XX"]],
  ["jay4", 2.5, [".X", ".X", "XX"]], ["tee4", 3.0, ["XXX", ".X."]], ["zed4", 1.5, ["XX.", ".XX"]], ["ess4", 1.5, [".XX", "XX."]],
];
const norm = cells => { const mr = Math.min(...cells.map(c => c[0])), mc = Math.min(...cells.map(c => c[1])); return cells.map(([r, c]) => [r - mr, c - mc]); };
const sig = cells => [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(c => c.join(".")).join("|");
const rot = cells => { const rows = Math.max(...cells.map(c => c[0])) + 1; return norm(cells.map(([r, c]) => [c, rows - 1 - r])); };
const LIB = [], BY_ID = {}, GROUPS = {};
for (const [group, w, pat] of SHAPE_DEFS) {
  const base = []; pat.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === "X") base.push([r, c]); }));
  const variants = [norm(base)], seen = new Set([sig(variants[0])]); let cur = variants[0];
  for (let i = 0; i < 3; i++) { cur = rot(cur); if (!seen.has(sig(cur))) { seen.add(sig(cur)); variants.push(cur); } }
  GROUPS[group] = [];
  variants.forEach((cells, i) => {
    const s = { id: `${group}_${i}`, group, cells, weight: w / variants.length, size: cells.length,
      rows: Math.max(...cells.map(c => c[0])) + 1, cols: Math.max(...cells.map(c => c[1])) + 1 };
    LIB.push(s); BY_ID[s.id] = s; GROUPS[group].push(s);
  });
}
const nextRotation = s => { const g = GROUPS[s.group]; return g[(g.indexOf(s) + 1) % g.length]; };

/* Board cell values: 0 empty, 1-7 colours, 8 stone, 9 ice (hp 2 then 1). Extra layers: pearl, region, hole. */
class Board {
  constructor(src) {
    if (src) { this.c = Int8Array.from(src.c); this.hp = Uint8Array.from(src.hp); this.pearl = Uint8Array.from(src.pearl); this.region = Uint8Array.from(src.region); this.hole = Uint8Array.from(src.hole); }
    else { this.c = new Int8Array(NN); this.hp = new Uint8Array(NN); this.pearl = new Uint8Array(NN); this.region = new Uint8Array(NN); this.hole = new Uint8Array(NN); }
  }
  copy() { return new Board(this); }
  can(s, r, c) {
    if (r < 0 || c < 0 || r + s.rows > N || c + s.cols > N) return false;
    for (const [a, b] of s.cells) { const i = (r + a) * N + c + b; if (this.hole[i] || this.c[i]) return false; }
    return true;
  }
  place(s, r, c, col) { for (const [a, b] of s.cells) this.c[(r + a) * N + c + b] = col; }
  lineFull(isRow, k, cov) {
    let any = false;
    for (let x = 0; x < N; x++) { const i = isRow ? k * N + x : x * N + k; if (this.hole[i]) continue; any = true; if (!this.c[i] && !(cov && cov.has(i))) return false; }
    return any;
  }
  lines() { const rows = [], cols = []; for (let k = 0; k < N; k++) { if (this.lineFull(true, k)) rows.push(k); if (this.lineFull(false, k)) cols.push(k); } return { rows, cols }; }
  linesBy(s, r, c) {
    const cov = new Set(s.cells.map(([a, b]) => (r + a) * N + c + b)), rows = [], cols = [];
    for (let k = r; k < r + s.rows; k++) if (this.lineFull(true, k, cov)) rows.push(k);
    for (let k = c; k < c + s.cols; k++) if (this.lineFull(false, k, cov)) cols.push(k);
    return { rows, cols };
  }
  /* Clears whole lines or explicit cell indices; returns what was removed for scoring/goals/animation. */
  clearCells(indices) {
    const out = { cells: [], cracked: [], pearls: 0, region: 0, ice: 0, stones: 0 };
    for (const i of indices) {
      if (this.hole[i] || !this.c[i]) continue;
      const r = (i / N) | 0, c = i % N;
      if (this.c[i] === 9) { this.hp[i]--; if (this.hp[i] > 0) { out.cracked.push({ r, c }); continue; } out.ice++; }
      if (this.c[i] === 8) out.stones++;
      if (this.pearl[i]) { out.pearls++; this.pearl[i] = 0; }
      if (this.region[i]) { out.region++; this.region[i] = 0; }
      out.cells.push({ r, c, col: this.c[i] }); this.c[i] = 0; this.hp[i] = 0;
    }
    return out;
  }
  lineIndices(L) { const set = new Set(); for (const r of L.rows) for (let x = 0; x < N; x++) set.add(r * N + x); for (const c of L.cols) for (let x = 0; x < N; x++) set.add(x * N + c); return [...set]; }
  clear(L) { return this.clearCells(this.lineIndices(L)); }
  *placements(s) { for (let r = 0; r <= N - s.rows; r++) for (let c = 0; c <= N - s.cols; c++) if (this.can(s, r, c)) yield [r, c]; }
  fits(s) { for (let r = 0; r <= N - s.rows; r++) for (let c = 0; c <= N - s.cols; c++) if (this.can(s, r, c)) return true; return false; }
  filled() { let n = 0; for (let i = 0; i < NN; i++) if (!this.hole[i] && this.c[i]) n++; return n; }
  playable() { let n = 0; for (let i = 0; i < NN; i++) if (!this.hole[i]) n++; return n; }
  count(layer) { let n = 0; for (let i = 0; i < NN; i++) if (layer === "ice" ? this.c[i] === 9 : layer === "stone" ? this.c[i] === 8 : this[layer][i]) n++; return n; }
  toJSON() { return { c: [...this.c], hp: [...this.hp], pearl: [...this.pearl], region: [...this.region], hole: [...this.hole] }; }
}
const lc = L => L.rows.length + L.cols.length;

class Generator {
  constructor(rng) { this.rng = rng; this.d = 0.4; this.budget = 20000; }
  weights(b) {
    const d = clamp(this.d, 0, 1), bias = (d - 0.5) * 2, crowded = b.filled() / Math.max(1, b.playable()) > 0.55;
    return LIB.map(s => {
      let w = s.weight * Math.exp(bias * (s.size - 4) * 0.18);
      if (crowded) w *= Math.exp(-(s.size - 3) * 0.25);
      for (const [r, c] of b.placements(s)) { if (lc(b.linesBy(s, r, c))) { w *= 1 + 0.6 * (1 - d); break; } }
      return w;
    });
  }
  pick(shapes, ws) {
    const total = ws.reduce((a, b) => a + b, 0); if (total <= 0) return shapes[this.rng.int(shapes.length)];
    let x = this.rng.dbl() * total; for (let i = 0; i < shapes.length; i++) { x -= ws[i]; if (x < 0) return shapes[i]; } return shapes[shapes.length - 1];
  }
  solvable(b, tray) { this.nodes = 0; return this.search(b, tray) !== false; }
  search(b, rem) {
    if (!rem.length) return true; if (rem.length === 1) return b.fits(rem[0]);
    const tried = new Set();
    for (let i = 0; i < rem.length; i++) {
      const s = rem[i]; if (tried.has(s.id)) continue; tried.add(s.id);
      const rest = rem.filter((_, j) => j !== i);
      for (const [r, c] of b.placements(s)) {
        if (++this.nodes > this.budget) return null;
        const n = b.copy(); n.place(s, r, c, 1); n.clear(n.lines());
        const res = this.search(n, rest); if (res === null) return null; if (res) return true;
      }
    }
    return false;
  }
  tray(b) {
    const ws = this.weights(b); let first = null, last = null;
    for (let a = 0; a < 12; a++) { const t = [0, 1, 2].map(() => this.pick(LIB, ws)); last = t; if (this.solvable(b, t)) return t; if (!first && t.some(s => b.fits(s))) first = t; }
    const fit = [], fw = []; LIB.forEach((s, i) => { if (b.fits(s)) { fit.push(s); fw.push(ws[i] * Math.exp(-0.4 * (s.size - 1))); } });
    if (fit.length) { let f0 = null; for (let a = 0; a < 6; a++) { const t = [0, 1, 2].map(() => this.pick(fit, fw)); f0 = f0 || t; if (this.solvable(b, t)) return t; } return f0; }
    return first || last;
  }
}
const LINE_PTS = [0, 10, 30, 60, 100, 150, 210];
const linePts = n => n <= 0 ? 0 : n < LINE_PTS.length ? LINE_PTS[n] : 210 + (n - 6) * 70;

/* A game of any mode. cfg: {mode, seed, diff, ramp, boosters, time, level(def), fixed} */
class Game {
  constructor(cfg, saved) {
    this.cfg = cfg; this.rng = new Rng(cfg.seed); this.gen = new Generator(this.rng); this.gen.d = cfg.diff;
    this.board = cfg.level ? buildBoard(cfg.level) : new Board();
    this.tray = [null, null, null]; this.queue = [];
    this.score = 0; this.moves = 0; this.lines = 0; this.streak = 0; this.since = 0; this.bestCombo = 0; this.combosMade = 0; this.perfects = 0;
    this.got = { pearls: 0, region: 0, ice: 0, stones: 0 }; this.extraMoves = 0; this.timeLeft = cfg.time || 0;
    this.over = false; this.won = false; this.timeUp = false; this.secondUsed = false; this.undoSnap = null;
    this.need = cfg.level ? { pearls: this.board.count("pearl"), region: this.board.count("region"), ice: this.board.count("ice"), stones: this.board.count("stone") } : {};
    if (saved) this.load(saved); else this.refill();
    this.check();
  }
  get movesLimit() { return this.cfg.level ? this.cfg.level.moves + this.extraMoves : Infinity; }
  get movesLeft() { return this.movesLimit - this.moves; }
  refill() {
    if (this.cfg.ramp) this.gen.d = Math.min(0.9, this.cfg.diff + Math.min(0.4, this.score / 25000));
    if (this.cfg.fixed) {
      while (this.queue.length < 6) { const s = this.gen.pick(LIB, LIB.map(x => x.weight * Math.exp(-0.35 * (x.size - 3)))); this.queue.push({ shape: s, col: 1 + this.rng.int(7) }); }
      this.tray = this.queue.splice(0, 3);
    } else {
      const t = this.gen.tray(this.board); this.tray = t.map(s => ({ shape: s, col: 1 + this.rng.int(7) }));
    }
  }
  placeable(i) { const p = this.tray[i]; return !!p && this.board.fits(p.shape); }
  canPlace(i, r, c) { const p = this.tray[i]; return !this.over && !!p && this.board.can(p.shape, r, c); }
  goals() {
    const L = this.cfg.level; if (!L) return [];
    return L.goals.map(g => {
      const have = g.type === "score" ? this.score : g.type === "lines" ? this.lines : g.type === "combos" ? this.combosMade : this.got[g.type];
      const need = g.n != null ? g.n : this.need[g.type];
      return { type: g.type, have: Math.min(have, need), need, done: have >= need, label: GOAL_LABEL[g.type] };
    });
  }
  allGoals() { const gs = this.goals(); return gs.length > 0 && gs.every(g => g.done); }
  absorb(out) { for (const k of ["pearls", "region", "ice", "stones"]) this.got[k] += out[k]; }
  place(i, r, c) {
    if (!this.canPlace(i, r, c)) return null;
    this.undoSnap = JSON.stringify(this.toJSON());
    const p = this.tray[i]; this.board.place(p.shape, r, c, p.col);
    const L = this.board.lines(), n = lc(L), out = this.board.clear(L); this.absorb(out);
    if (n) { this.streak++; this.since = 0; } else { this.since++; if (this.since > 2) this.streak = 0; }
    const perfect = n > 0 && this.board.filled() === 0;
    const pts = { placement: p.shape.size, line: linePts(n), combo: n && this.streak >= 2 ? 10 * (this.streak - 1) * n : 0, perfect: perfect ? 300 : 0 };
    const total = pts.placement + pts.line + pts.combo + pts.perfect;
    this.score += total; this.moves++; this.lines += n; this.bestCombo = Math.max(this.bestCombo, this.streak);
    if (n && this.streak >= 2) this.combosMade++;
    if (perfect) this.perfects++;
    if (this.cfg.time && n >= 2) this.timeLeft += 3;
    this.tray[i] = null; let refilled = false;
    if (this.tray.every(x => !x)) { this.refill(); refilled = true; }
    this.check();
    return { slot: i, r, c, shape: p.shape, col: p.col, L, n, out, pts, total, streak: this.streak, refilled, over: this.over, won: this.won };
  }
  check() {
    if (this.cfg.level && this.allGoals()) { this.won = true; this.over = true; return; }
    if (this.cfg.level && this.moves >= this.movesLimit) { this.over = true; this.outOfMoves = true; return; }
    this.outOfMoves = false;
    this.over = this.timeUp || ![0, 1, 2].some(i => this.placeable(i));
  }
  /* Boosters */
  snapshotForUndo() { this.undoSnap = JSON.stringify(this.toJSON()); }
  hammer(i) { if (this.board.hole[i] || !this.board.c[i]) return false; this.snapshotForUndo(); this.absorb(this.board.clearCells([i])); this.check(); return true; }
  clearLine(isRow, k) { this.snapshotForUndo(); const L = isRow ? { rows: [k], cols: [] } : { rows: [], cols: [k] }; const out = this.board.clear(L); this.absorb(out); this.check(); return out; }
  rotate(i) { const p = this.tray[i]; if (!p) return false; const ns = nextRotation(p.shape); if (ns === p.shape) return false; this.tray[i] = { shape: ns, col: p.col }; this.check(); return true; }
  shuffle() { this.snapshotForUndo(); this.refill(); this.check(); }
  undo() { if (!this.undoSnap) return false; const j = JSON.parse(this.undoSnap); this.load(j); this.undoSnap = null; this.over = false; this.won = false; this.check(); return true; }
  secondChance() {
    const rows = [...Array(N).keys()].map(r => { let f = 0; for (let x = 0; x < N; x++) if (this.board.c[r * N + x]) f++; return [r, f]; }).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    const idx = []; for (const r of rows) for (let x = 0; x < N; x++) idx.push(r * N + x);
    for (const i of idx) { if (this.board.c[i] === 9) this.board.hp[i] = 1; }
    this.absorb(this.board.clearCells(idx)); this.refill(); this.secondUsed = true; this.over = false; this.check();
  }
  toJSON() {
    return { cfg: this.cfg, rng: this.rng.s, gd: this.gen.d, board: this.board.toJSON(), tray: this.tray.map(p => p ? [p.shape.id, p.col] : null),
      queue: this.queue.map(p => [p.shape.id, p.col]), score: this.score, moves: this.moves, lines: this.lines, streak: this.streak, since: this.since,
      bestCombo: this.bestCombo, combosMade: this.combosMade, perfects: this.perfects, got: this.got, need: this.need, extraMoves: this.extraMoves,
      timeLeft: this.timeLeft, secondUsed: this.secondUsed };
  }
  load(j) {
    this.rng.s = j.rng >>> 0; this.gen.d = j.gd; this.board = new Board(j.board);
    this.tray = j.tray.map(p => p ? { shape: BY_ID[p[0]], col: p[1] } : null); this.queue = (j.queue || []).map(p => ({ shape: BY_ID[p[0]], col: p[1] }));
    for (const k of ["score", "moves", "lines", "streak", "since", "bestCombo", "combosMade", "perfects", "extraMoves", "timeLeft", "secondUsed"]) this[k] = j[k];
    this.got = { ...j.got }; this.need = { ...j.need };
  }
}

const GOAL_LABEL = { score: "Points", lines: "Lines", combos: "Combos", pearls: "Pearls", region: "Garden bed", ice: "Ice", stones: "Stones" };
function genLevel(n, key, fillScale = 1) {
  const ch = Math.ceil(n / 50), k = (n - 1) % 50 + 1, rng = new Rng(hash((key || "gridbloom-level-") + n));
  const peak = k % 5 === 0, boss = k === 25 || k === 50;
  const diff = clamp(0.18 + 0.05 * (ch - 1) + 0.12 * (k / 50) + (peak ? 0.08 : 0) + (boss ? 0.08 : 0) - (k % 5 === 1 && k > 1 ? 0.04 : 0), 0.1, 0.85);
  const def = { n, ch, k, peak, boss, seed: hash((key || "seed-") + n), diff, goals: [], fixed: ch === 7 || (ch === 10 && k % 7 === 0), cells: [], moves: 40 };
  const hole = new Uint8Array(NN);
  if (ch === 8 || (ch === 10 && k % 4 === 0)) {
    const pattern = rng.int(4);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const i = r * N + c;
      if (pattern === 0 && (r === 0 || r === 7) && (c === 0 || c === 7)) hole[i] = 1;
      if (pattern === 1 && (r === 3 || r === 4) && (c === 3 || c === 4)) hole[i] = 1;
      if (pattern === 2 && ((r < 2 && c < 2) || (r > 5 && c > 5))) hole[i] = 1;
      if (pattern === 3 && (r + c === 7) && (r === 0 || r === 7 || r === 3 || r === 4)) hole[i] = 1;
    }
  }
  const b = new Board(); b.hole = hole;
  const frac = (0.06 + 0.015 * Math.min(ch, 6) + rng.dbl() * 0.06 + (peak ? 0.03 : 0) + (boss ? 0.03 : 0)) * fillScale;
  // Prefill with whole pieces so the board looks hand-built and stays playable (no scattered single cells).
  for (let tries = 0; tries < 200 && b.filled() < frac * b.playable(); tries++) {
    const s = LIB[rng.int(LIB.length)]; if (s.size > 4) continue;
    const r = rng.int(N - s.rows + 1), c = rng.int(N - s.cols + 1);
    if (b.can(s, r, c)) { const t = b.copy(); t.place(s, r, c, 1); if (!t.lines().rows.length && !t.lines().cols.length) b.place(s, r, c, 1 + rng.int(7)); }
  }
  const fixLines = () => { for (let k2 = 0; k2 < N; k2++) { if (b.lineFull(true, k2)) b.c[k2 * N + rng.int(N)] = 0; if (b.lineFull(false, k2)) b.c[rng.int(N) * N + k2] = 0; } };
  const filledIdx = () => [...Array(NN).keys()].filter(i => !hole[i] && b.c[i]);
  const emptyIdx = () => [...Array(NN).keys()].filter(i => !hole[i] && !b.c[i]);
  const take = (arr, m) => { const out = []; const a = [...arr]; while (out.length < m && a.length) out.push(a.splice(rng.int(a.length), 1)[0]); return out; };
  const ensureFilled = m => { const f = filledIdx(); if (f.length < m) for (const i of take(emptyIdx(), m - f.length)) b.c[i] = 1 + rng.int(7); };
  const addPearls = m => { ensureFilled(m); for (const i of take(filledIdx().filter(i => b.c[i] <= 7), m)) b.pearl[i] = 1; };
  const addStones = m => { for (const i of take(emptyIdx(), m)) b.c[i] = 8; };
  const addIce = m => { for (const i of take(emptyIdx(), m)) { b.c[i] = 9; b.hp[i] = 2; } };
  const addRegion = () => { const h = 2 + rng.int(2), w = 2 + rng.int(3), r0 = rng.int(N - h + 1), c0 = rng.int(N - w + 1); for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) { const i = r * N + c; if (hole[i]) continue; if (!b.c[i]) b.c[i] = 1 + rng.int(7); b.region[i] = 1; } };
  const lv = Math.floor(k / 10);
  const G = (type, nn) => def.goals.push(nn == null ? { type } : { type, n: nn });
  switch (ch) {
    case 1: { const m = k % 3; if (m === 0) G("score", 300 + k * 25); else if (m === 1) G("lines", 3 + Math.floor(k / 6)); else { G("score", 250 + k * 15); G("lines", 2 + Math.floor(k / 8)); } break; }
    case 2: addPearls(2 + lv); G("pearls"); break;
    case 3: addStones(3 + Math.floor(k / 8)); G("stones"); break;
    case 4: addIce(2 + lv); G("ice"); break;
    case 5: G("combos", 1 + Math.floor(k / 12)); G("score", 400 + k * 20); break;
    case 6: addRegion(); G("region"); break;
    case 7: G("lines", 4 + Math.floor(k / 8)); break;
    case 8: if (k % 2) G("lines", 4 + Math.floor(k / 8)); else G("score", 500 + k * 20); break;
    case 9: if (k % 2) { addPearls(2 + lv); G("pearls"); G("lines", 4 + lv); } else { addIce(2 + lv); G("ice"); G("score", 500 + k * 15); } break;
    default: { const m = k % 3; if (m === 0) { addPearls(2 + lv); addIce(1 + lv); G("pearls"); G("ice"); } else if (m === 1) { addStones(3 + lv); G("stones"); G("combos", 1 + Math.floor(k / 20)); } else { addRegion(); G("region"); G("score", 600 + k * 20); } }
  }
  fixLines();
  def.board = b.toJSON();
  return def;
}
function buildBoard(def) { return new Board(def.board); }
/* Greedy solver bot: used to validate every level before it is offered. */
function evalBoard(n, gained) {
  let holes = 0;
  for (let x = 0; x < NN; x++) { if (n.hole[x] || n.c[x]) continue; const rr = (x / N) | 0, cc = x % N; let closed = 0;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = rr + dr, b2 = cc + dc; if (a < 0 || b2 < 0 || a >= N || b2 >= N || n.hole[a * N + b2] || n.c[a * N + b2]) closed++; } if (closed === 4) holes++; }
  let fitCount = 0; for (const s of PROBE) if (n.fits(s)) fitCount++;
  return gained - holes * 4 - n.filled() * 0.15 + fitCount * 1.5;
}
const PROBE = ["square3_0", "line5_0", "line5_1", "corner5_0", "rect23_0", "rect23_1", "square2_0", "line4_0", "line4_1"].map(id => BY_ID[id]);
function placeGain(n, s, r, c) { n.place(s, r, c, 1); const L = n.lines(), out = n.clear(L); return lc(L) * 10 + (out.pearls + out.region + out.ice + out.stones) * 18 + out.cracked.length * 8; }
/* Plans the whole remaining tray: tries every order, greedily, and plays the first move of the best plan. */
function botMove(g) {
  const items = [0, 1, 2].filter(i => g.tray[i]);
  if (!items.length) return null;
  const orders = items.length === 3 ? [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(o => o.map(k => items[k])) : items.length === 2 ? [[items[0], items[1]], [items[1], items[0]]] : [items];
  let best = null;
  for (const order of orders) {
    let board = g.board, total = 0, first = null, failed = false;
    for (const i of order) {
      const s = g.tray[i].shape; let pick = null;
      for (const [r, c] of board.placements(s)) { const n = board.copy(), gain = placeGain(n, s, r, c), v = evalBoard(n, gain); if (!pick || v > pick[0]) pick = [v, r, c, n, gain]; }
      if (!pick) { failed = true; break; }
      if (!first) first = [i, pick[1], pick[2]];
      total += pick[4]; board = pick[3];
    }
    if (!first) continue;
    const score = failed ? -1000 + total : evalBoard(board, total);
    if (!best || score > best[0]) best = [score, ...first];
  }
  return best;
}
function botMoveOld(g) {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const p = g.tray[i]; if (!p) continue;
    for (const [r, c] of g.board.placements(p.shape)) {
      const n = g.board.copy(); n.place(p.shape, r, c, 1); const L = n.lines(), out = n.clear(L);
      let holes = 0; for (let x = 0; x < NN; x++) { if (n.hole[x] || n.c[x]) continue; const rr = (x / N) | 0, cc = x % N; let closed = 0, tot = 0;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = rr + dr, b2 = cc + dc; tot++; if (a < 0 || b2 < 0 || a >= N || b2 >= N || n.hole[a * N + b2] || n.c[a * N + b2]) closed++; } if (closed === tot) holes++; }
      const v = lc(L) * 10 + (out.pearls + out.region + out.ice + out.stones) * 18 + out.cracked.length * 8 - holes * 3 - n.filled() * 0.1;
      if (!best || v > best[0]) best = [v, i, r, c];
    }
  }
  return best;
}
function botRun(def, cap) {
  const g = new Game({ mode: "adv", seed: def.seed, diff: def.diff, level: { ...def, moves: 999 }, fixed: def.fixed });
  while (!g.over && g.moves < cap) { const m = botMove(g); if (!m) break; g.place(m[1], m[2], m[3]); }
  return { won: g.won, moves: g.moves, score: g.score };
}
const LEVEL_CACHE = {};
function validate(def, regen) {
  const scales = [1, 1, 0.55, 0.25, 0];
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt >= 2 && regen) { const keepGoals = def.goals; def = Object.assign(regen(scales[attempt]), { goals: keepGoals.map(g => g.n != null ? g : g) }); }
    const r = botRun(def, 220);
    if (r.won) {
      const slack = def.peak || def.boss ? 1.12 : 1.3 - 0.1 * (def.k / 50);
      def.moves = Math.max(6, Math.ceil(r.moves * slack) + 2);
      def.s2 = Math.max(2, Math.round(def.moves * 0.2));
      def.s3 = Math.max(Math.round(r.score * 1.15 / 50) * 50, ...def.goals.filter(g => g.type === "score").map(g => Math.round(g.n * 1.3 / 50) * 50));
      def.validated = { bot: "greedy-v1", botMoves: r.moves, botScore: r.score, attempts: attempt + 1 };
      return def;
    }
    if (attempt === 1 || attempt === 3) def.goals = def.goals.map(g => g.n != null ? { ...g, n: Math.max(1, Math.floor(g.n * 0.8)) } : g);   // relax numeric goals
  }
  if (regen) def = regen(0);
  def.goals = [{ type: "lines", n: 3 }]; def.moves = 30; def.s2 = 6; def.s3 = 800; def.validated = { bot: "fallback", botMoves: null }; return def;
}
function getLevel(n) { if (!LEVEL_CACHE[n]) LEVEL_CACHE[n] = validate(genLevel(n), sc => genLevel(n, null, sc)); return LEVEL_CACHE[n]; }
function getDaily(key) {
  const id = "daily:" + key; if (LEVEL_CACHE[id]) return LEVEL_CACHE[id];
  const h = hash(id), mk = sc => { const d = genLevel(5 + (h % 40), "daily-" + key, sc); d.goals = [{ type: "lines", n: 8 + (h % 5) }]; d.daily = key; return d; };
  return (LEVEL_CACHE[id] = validate(mk(1), mk));
}

module.exports = { Rng, Board, Generator, Game, LIB, BY_ID, hash, clamp, genLevel, validate, getDaily, N, NN };
