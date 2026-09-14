/**
 * Rank-normalized blending.
 *
 * THE PROBLEM this solves. Every source publishes values on a 0-10000-ish
 * scale, which makes them look directly comparable. They are not. The *shape*
 * of each curve differs: one source might put its #1 asset 12% above its #5,
 * another 25% above. If you average the raw numbers, the source with the
 * steepest curve quietly dominates the blend at the top of the board and the
 * flattest one dominates in the middle. You would not notice, and every trade
 * involving an elite player would be systematically skewed.
 *
 * THE FIX. Take only the ORDERING from each source, and take the MAGNITUDE from
 * a consensus curve that all sources vote on:
 *
 *   1. Within each source, rank every asset (1 = most valuable).
 *   2. Rescale each source so its top asset is 10000. Now "the value of the Nth
 *      best asset" is expressed comparably across sources.
 *   3. For each rank N, take the MEDIAN of that rescaled value across all
 *      sources that are deep enough to have an Nth asset. That median series is
 *      the consensus curve - one agreed-upon answer to "what is the Nth best
 *      dynasty asset worth?". Median rather than mean so one source with a
 *      weird curve cannot drag it.
 *   4. Re-price every asset as curve(its rank in that source).
 *   5. Blend those re-priced values across sources with configurable weights.
 *
 * A source now influences a player's value only by where it ranks them, which
 * is the thing sources actually disagree about and the thing they each measure
 * meaningfully. Their arbitrary scale choices drop out entirely.
 *
 * As a bonus, step 4 gives us a genuinely useful disagreement signal: the same
 * player's rank across sources, on one comparable footing.
 */

import { pickRoundKey } from './picks.js';

export const DEFAULT_WEIGHTS = { ktc: 1, fantasycalc: 1, dynastyprocess: 1 };
const TOP_VALUE = 10000;

/**
 * Picks are traded at round granularity ("my 2027 1st") because final draft
 * order is unknown, and that is also exactly how Sleeper models traded picks.
 * Collapse tiered pick rows into their round and average, so all three sources
 * describe the same asset.
 */
function collapsePicks(assets) {
  const byKey = new Map();
  const out = [];
  for (const a of assets) {
    if (a.kind !== 'pick') { out.push(a); continue; }
    const key = pickRoundKey(a.id);
    if (!byKey.has(key)) byKey.set(key, { ...a, id: key, name: key, sum: a.rawValue, n: 1 });
    else {
      const p = byKey.get(key);
      p.sum += a.rawValue; p.n++;
    }
  }
  for (const p of byKey.values()) {
    const { sum, n, ...rest } = p;
    out.push({ ...rest, rawValue: sum / n });
  }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Rank a source's assets and rescale so the top asset is TOP_VALUE.
 * Returns { ranked: [{id, rank, scaled, ...}], byId: Map }
 */
function rankSource(assets) {
  const list = collapsePicks(assets)
    .filter((a) => Number.isFinite(a.rawValue) && a.rawValue > 0)
    .sort((a, b) => b.rawValue - a.rawValue);
  if (!list.length) return { ranked: [], byId: new Map() };
  const top = list[0].rawValue;
  const ranked = list.map((a, i) => ({
    ...a,
    rank: i + 1,
    scaled: (a.rawValue / top) * TOP_VALUE,
  }));
  return { ranked, byId: new Map(ranked.map((a) => [a.id, a])) };
}

/**
 * Build the consensus curve: index i holds the agreed value of rank i+1.
 * Enforced monotonically non-increasing, because a lower rank being worth more
 * than a higher one is always an artifact of thin sampling at that depth.
 */
export function buildConsensusCurve(rankedSources) {
  const maxLen = Math.max(0, ...rankedSources.map((s) => s.ranked.length));
  const curve = [];
  for (let i = 0; i < maxLen; i++) {
    const votes = [];
    for (const s of rankedSources) {
      if (s.ranked.length > i) votes.push(s.ranked[i].scaled);
    }
    const m = median(votes);
    curve.push(m == null ? 0 : m);
  }
  for (let i = 1; i < curve.length; i++) {
    if (curve[i] > curve[i - 1]) curve[i] = curve[i - 1];
  }
  return curve;
}

function curveValue(curve, rank) {
  if (!curve.length) return 0;
  const i = Math.min(curve.length, Math.max(1, Math.round(rank))) - 1;
  return curve[i];
}

/**
 * Blend an array of source results into one value board.
 *
 * @param sourceResults [{source, assets:[{id, kind, name, position, rawValue, ...}]}]
 * @param options.weights per-source weight, defaults to equal
 * @returns { assets: [...], curve, sourceStats }
 */
export function blendSources(sourceResults, options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
  const usable = sourceResults.filter((s) => s && Array.isArray(s.assets) && s.assets.length);
  if (!usable.length) return { assets: [], curve: [], sourceStats: [] };

  const ranked = usable.map((s) => ({ source: s.source, ...rankSource(s.assets) }));
  const curve = buildConsensusCurve(ranked);

  // Union of every asset id any source knows about.
  const ids = new Set();
  for (const s of ranked) for (const a of s.ranked) ids.add(a.id);

  const assets = [];
  for (const id of ids) {
    const perSource = {};
    let wSum = 0, vSum = 0;
    const normValues = [];
    const ranks = [];
    let meta = null;

    for (const s of ranked) {
      const hit = s.byId.get(id);
      if (!hit) continue;
      const norm = curveValue(curve, hit.rank);
      const w = weights[s.source] ?? 1;
      perSource[s.source] = {
        rank: hit.rank,
        raw: Math.round(hit.rawValue),
        normalized: Math.round(norm),
        trend30: hit.trend30 ?? null,
      };
      normValues.push(norm);
      ranks.push(hit.rank);
      wSum += w;
      vSum += w * norm;
      // Prefer the richest metadata available across sources.
      if (!meta || (hit.age && !meta.age) || (hit.team && !meta.team)) {
        meta = { name: hit.name, position: hit.position, team: hit.team ?? meta?.team ?? null,
                 age: hit.age ?? meta?.age ?? null, kind: hit.kind };
      }
    }
    if (!wSum || !meta) continue;

    const blended = vSum / wSum;
    const mean = normValues.reduce((a, b) => a + b, 0) / normValues.length;
    const variance = normValues.reduce((a, b) => a + (b - mean) ** 2, 0) / normValues.length;
    const stdev = Math.sqrt(variance);

    assets.push({
      id,
      kind: meta.kind,
      name: meta.name,
      position: meta.position,
      team: meta.team,
      age: meta.age,
      value: Math.round(blended),
      sources: perSource,
      sourceCount: normValues.length,
      // --- disagreement, measured three ways ---
      // How many places apart do sources rank this asset?
      rankSpread: ranks.length > 1 ? Math.max(...ranks) - Math.min(...ranks) : 0,
      // How many BLENDED POINTS apart are they? This is the one to sort by.
      // Coefficient of variation (below) is unstable at the deep end of the
      // board, where values are tiny and nearly flat: a one-rank gap between
      // two 300-value assets produces a bigger CV than a #3-vs-#59 split on a
      // stud, which is exactly backwards. Point spread has no such problem,
      // because it is denominated in the same units as the value itself.
      valueSpread: normValues.length > 1
        ? Math.round(Math.max(...normValues) - Math.min(...normValues)) : 0,
      // Relative dispersion. Useful for comparing similar-valued players, but
      // meaningless near zero - treat it as a tiebreaker, never a sort key.
      disagreement: mean > 0 ? Number((stdev / mean).toFixed(4)) : 0,
      lowConfidence: normValues.length < 2,
    });
  }

  assets.sort((a, b) => b.value - a.value);

  // Re-anchor so the best asset reads as a round 10000.
  if (assets.length && assets[0].value > 0) {
    const f = TOP_VALUE / assets[0].value;
    for (const a of assets) a.value = Math.round(a.value * f);
  }
  assets.forEach((a, i) => { a.overallRank = i + 1; });

  // Positional ranks.
  const posCount = {};
  for (const a of assets) {
    const p = a.position || 'NA';
    posCount[p] = (posCount[p] || 0) + 1;
    a.positionRank = posCount[p];
  }

  const sourceStats = ranked.map((s) => ({
    source: s.source,
    assetCount: s.ranked.length,
    weight: weights[s.source] ?? 1,
  }));

  return { assets, curve, sourceStats };
}
