/**
 * Merging two copies of a player's game data (two devices, or a device that
 * was offline). "Higher progress wins": the copy that is further along is the
 * base, and the parts that only ever grow are combined from both so nothing
 * earned on either side is lost.
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** How far along a progress map is; used to pick the base copy. */
function progressScore(p) {
  if (!isObj(p)) return 0;
  const stars = isObj(p.stars) ? Object.values(p.stars).reduce((a, b) => a + num(b), 0) : 0;
  const daily = isObj(p.daily) ? Object.keys(p.daily).length : 0;
  const games = isObj(p.stats) ? num(p.stats.games) : 0;
  return stars * 1000 + num(p.xp) + games * 5 + daily * 50;
}

function maxMap(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(isObj(b) ? b : {})) {
    out[k] = Math.max(num(out[k]), num(v));
  }
  return out;
}

function union(a, b) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
}

function mergeStats(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(isObj(b) ? b : {})) {
    if (isObj(v)) out[k] = maxMap(out[k], v);
    else if (typeof v === "number") out[k] = Math.max(num(out[k]), v);
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

function mergeProgress(a, b) {
  if (!isObj(a)) return isObj(b) ? b : {};
  if (!isObj(b)) return a;
  const [base, other] = progressScore(a) >= progressScore(b) ? [a, b] : [b, a];
  return {
    ...base,
    xp: Math.max(num(base.xp), num(other.xp)),
    stars: maxMap(base.stars, other.stars),
    advBest: maxMap(base.advBest, other.advBest),
    daily: maxMap(base.daily, other.daily),
    themes: union(base.themes, other.themes),
    achClaimed: union(base.achClaimed, other.achClaimed),
    premium: Boolean(base.premium || other.premium),
    removeAds: Boolean(base.removeAds || other.removeAds),
    stats: mergeStats(base.stats, other.stats),
  };
}

function mergeSave(a, b, newerIsB) {
  if (!isObj(a)) return isObj(b) ? b : {};
  if (!isObj(b)) return a;
  const [newer, older] = newerIsB ? [b, a] : [a, b];
  const out = { ...older, ...newer };
  out.classicBest = Math.max(num(a.classicBest), num(b.classicBest));
  out.tutorialDone = Boolean(a.tutorialDone || b.tutorialDone);
  return out;
}

/** [existing]/[incoming] are { progress, save, clientUpdatedAt } documents. */
function mergeGameData(existing, incoming) {
  const incomingNewer =
    new Date(incoming.clientUpdatedAt || 0).getTime() >=
    new Date(existing.clientUpdatedAt || 0).getTime();
  return {
    progress: mergeProgress(existing.progress, incoming.progress),
    save: mergeSave(existing.save, incoming.save, incomingNewer),
  };
}

module.exports = { progressScore, mergeProgress, mergeSave, mergeGameData };
