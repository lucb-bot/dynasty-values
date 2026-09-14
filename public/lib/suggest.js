/**
 * Roster suggestions.
 *
 * Everything here is a HEURISTIC and the UI labels it as such. The goal is to
 * point you at the handful of players worth thinking about, with the reasoning
 * shown, rather than to tell you what to do.
 *
 * The one genuinely non-obvious idea is market arbitrage. Most of your
 * leaguemates price trades off KeepTradeCut, because that is what dynasty
 * players use. So KTC is not just another opinion - it is a good proxy for the
 * PRICE YOU CAN TRANSACT AT, while the blend is a better estimate of true value.
 * Where those two diverge, there is an edge:
 *
 *   KTC well above blend  -> the market overpays for him. Sell.
 *   KTC well below blend  -> the market underrates him. Buy.
 *
 * That logic is inverted from what feels intuitive, so it is worth stating
 * plainly: you sell the guys your league thinks are better than they are.
 */

import { ageStage, remainingWindow } from './agecurve.js';

const STARTER_SLOTS = { QB: 1, RB: 2, WR: 3, TE: 1 };
const ARBITRAGE_MIN_VALUE = 500;

/** Median of a numeric array. */
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Positional strength: your total value at each position against the league.
 * Reported as a percentile so "3rd of 12 at WR" reads the same in any league.
 */
export function positionalStrength(myAssets, allRosterAssets) {
  const positions = ['QB', 'RB', 'WR', 'TE'];
  const out = {};

  for (const pos of positions) {
    const totalFor = (assets) => assets
      .filter((a) => a.position === pos)
      .sort((x, y) => y.value - x.value)
      // Count only realistic contributors: starters plus a couple of backups.
      .slice(0, (STARTER_SLOTS[pos] || 1) + 2)
      .reduce((s, a) => s + a.value, 0);

    const mine = totalFor(myAssets);
    const others = allRosterAssets.map(totalFor);
    const below = others.filter((v) => v < mine).length;
    const above = others.filter((v) => v > mine).length;
    const percentile = others.length ? below / others.length : 0.5;

    out[pos] = {
      total: Math.round(mine),
      leagueMedian: Math.round(median(others)),
      percentile: Number(percentile.toFixed(3)),
      // 1-indexed rank among ALL teams including yours, so the best team at a
      // position reads as 1 of 12 rather than 0 of 12.
      rank: above + 1,
      of: others.length + 1,
      label: percentile >= 0.75 ? 'strength' : percentile <= 0.3 ? 'weakness' : 'average',
    };
  }
  return out;
}

/**
 * Contender score: how much of your value is usable NOW versus later.
 * Drives whether the suggestions lean toward buying win-now or buying youth.
 */
export function contenderProfile(myAssets, allRosterAssets) {
  const nowValue = (assets) => assets
    .filter((a) => a.kind === 'player')
    .reduce((s, a) => s + a.value * (1 - 0.6 * (1 - remainingWindow(a.position, a.age))), 0);
  const total = (assets) => assets.reduce((s, a) => s + a.value, 0);

  const myTotal = total(myAssets);
  const myNow = nowValue(myAssets);
  const others = allRosterAssets.map(total);
  const sorted = [...others].sort((a, b) => b - a);
  const rank = sorted.filter((v) => v > myTotal).length + 1;

  const youthShare = myTotal ? 1 - myNow / myTotal : 0;
  const topHalf = rank <= Math.ceil((others.length + 1) / 2);

  let stance;
  if (topHalf && youthShare < 0.35) stance = 'contend';
  else if (!topHalf && youthShare > 0.4) stance = 'rebuild';
  else if (topHalf) stance = 'contend-with-youth';
  else stance = 'retool';

  return {
    totalValue: Math.round(myTotal),
    rank, of: others.length + 1,
    youthShare: Number(youthShare.toFixed(3)),
    stance,
  };
}

/**
 * Market arbitrage: where does KTC (the price your league trades at) diverge
 * most from the blend (our best estimate of value)?
 */
export function arbitrage(assets, { minValue = ARBITRAGE_MIN_VALUE, threshold = 0.12 } = {}) {
  const out = [];
  for (const a of assets) {
    const ktc = a.sources?.ktc?.normalized;
    if (!Number.isFinite(ktc) || ktc <= 0 || a.value < minValue) continue;
    // Compare KTC against the blend of the OTHER sources, so KTC is not being
    // compared against a number it helped produce.
    const others = Object.entries(a.sources || {})
      .filter(([k, v]) => k !== 'ktc' && Number.isFinite(v?.normalized) && v.normalized > 0)
      .map(([, v]) => v.normalized);
    if (!others.length) continue;
    const fair = others.reduce((s, v) => s + v, 0) / others.length;
    const gap = (ktc - fair) / fair;
    if (Math.abs(gap) < threshold) continue;
    out.push({
      ...a,
      marketValue: Math.round(ktc),
      fairValue: Math.round(fair),
      gap: Number(gap.toFixed(3)),
      direction: gap > 0 ? 'sell' : 'buy',
    });
  }
  return out.sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap));
}

/**
 * Sell candidates on your roster: aging, blocked by your own depth, trending
 * down, or overpriced by the market. Each carries the reasons that flagged it.
 */
export function sellCandidates(myAssets, strength, arb) {
  const arbById = new Map(arb.map((a) => [a.id, a]));
  const depthRank = {};
  for (const a of [...myAssets].sort((x, y) => y.value - x.value)) {
    if (a.kind !== 'player') continue;
    depthRank[a.position] = (depthRank[a.position] || 0) + 1;
    a._depthRank = depthRank[a.position];
  }

  const out = [];
  for (const a of myAssets) {
    if (a.kind !== 'player' || a.value < 300) continue;
    const reasons = [];
    const stage = ageStage(a.position, a.age);

    if (stage === 'cliff') reasons.push({ code: 'age-cliff', text: `${a.age} at ${a.position} - past the typical value cliff` });
    else if (stage === 'declining') reasons.push({ code: 'age-declining', text: `${a.age} at ${a.position} - entering decline` });

    const slots = STARTER_SLOTS[a.position] || 1;
    const posStrength = strength[a.position];
    if (a._depthRank > slots && posStrength?.label === 'strength') {
      reasons.push({ code: 'blocked', text: `your ${a.position}${a._depthRank} behind a position you are already strong at` });
    }

    if (Number.isFinite(a.delta30) && a.delta30 < 0 && a.value > 0 && Math.abs(a.delta30) / a.value > 0.08) {
      reasons.push({ code: 'trending-down', text: `down ${Math.abs(a.delta30)} over 30 days` });
    }

    const m = arbById.get(a.id);
    if (m && m.direction === 'sell') {
      reasons.push({ code: 'market-high', text: `KTC prices him ${Math.round(m.gap * 100)}% above the other sources` });
    }

    if (reasons.length >= 2 || reasons.some((r) => r.code === 'market-high' || r.code === 'age-cliff')) {
      out.push({ ...a, reasons, priority: reasons.length + (m?.direction === 'sell' ? 1 : 0) });
    }
  }
  return out.sort((p, q) => q.priority - p.priority || q.value - p.value);
}

/**
 * Buy targets from the rest of the league: young, rising, underpriced by the
 * market, and ideally at a position where you are thin.
 */
export function buyCandidates(othersAssets, strength, arb, profile) {
  const arbById = new Map(arb.map((a) => [a.id, a]));
  const weakPositions = new Set(
    Object.entries(strength).filter(([, s]) => s.label === 'weakness').map(([p]) => p)
  );

  const out = [];
  for (const a of othersAssets) {
    if (a.kind !== 'player' || a.value < 400) continue;
    const reasons = [];
    const stage = ageStage(a.position, a.age);

    if (weakPositions.has(a.position)) reasons.push({ code: 'fills-need', text: `you are bottom-third at ${a.position}` });

    const m = arbById.get(a.id);
    if (m && m.direction === 'buy') {
      reasons.push({ code: 'market-low', text: `KTC prices him ${Math.round(Math.abs(m.gap) * 100)}% below the other sources` });
    }

    if (Number.isFinite(a.delta30) && a.delta30 > 0 && a.value > 0 && a.delta30 / a.value > 0.08) {
      reasons.push({ code: 'trending-up', text: `up ${a.delta30} over 30 days` });
    }

    if (profile.stance === 'rebuild' || profile.stance === 'retool') {
      if (stage === 'ascending') reasons.push({ code: 'fits-rebuild', text: `${a.age} and still ascending - fits your rebuild` });
    } else if (stage === 'peak') {
      reasons.push({ code: 'fits-contend', text: `in his prime window - fits your push` });
    }

    if (reasons.length >= 2) {
      out.push({ ...a, reasons, priority: reasons.length + (m?.direction === 'buy' ? 1 : 0) });
    }
  }
  return out.sort((p, q) => q.priority - p.priority || q.value - p.value);
}

/**
 * Concrete trade ideas: pair each sell candidate with a buy target of similar
 * blended value that is owned by someone else, preferring deals where the
 * sources disagree in your favor (you pay market price, you get real value).
 */
export function tradeIdeas(sells, buys, ownerByAssetId, { band = 0.18, limit = 8 } = {}) {
  const ideas = [];
  for (const sell of sells.slice(0, 8)) {
    for (const buy of buys) {
      if (buy.value <= 0) continue;
      const ratio = Math.abs(buy.value - sell.value) / Math.max(buy.value, sell.value);
      if (ratio > band) continue;

      // The edge: what you give is priced high by the market, what you get is
      // priced low. Both halves working at once is the ideal case.
      const sellGap = sell.reasons.some((r) => r.code === 'market-high');
      const buyGap = buy.reasons.some((r) => r.code === 'market-low');

      ideas.push({
        give: sell, get: buy,
        withTeam: ownerByAssetId.get(buy.id) || null,
        valueGap: Math.round(buy.value - sell.value),
        edge: (sellGap ? 1 : 0) + (buyGap ? 1 : 0),
        rationale: [
          ...sell.reasons.map((r) => `Give ${sell.name}: ${r.text}`),
          ...buy.reasons.map((r) => `Get ${buy.name}: ${r.text}`),
        ],
      });
    }
  }
  // Cap how many ideas any single player can appear in, so the list shows a
  // spread of options rather than eight variations on trading one guy.
  const perGive = {}, perGet = {};
  const spread = [];
  for (const idea of ideas.sort((a, b) => b.edge - a.edge || Math.abs(a.valueGap) - Math.abs(b.valueGap))) {
    perGive[idea.give.id] = (perGive[idea.give.id] || 0) + 1;
    perGet[idea.get.id] = (perGet[idea.get.id] || 0) + 1;
    if (perGive[idea.give.id] > 2 || perGet[idea.get.id] > 1) continue;
    spread.push(idea);
    if (spread.length >= limit) break;
  }
  return spread;
}

/** Top-level entry: everything the roster view needs. */
export function analyzeRoster({ myAssets, rostersAssets, allAssets, ownerByAssetId }) {
  const others = rostersAssets.filter((r) => r.assets !== myAssets);
  const otherAssetLists = others.map((r) => r.assets);
  const strength = positionalStrength(myAssets, otherAssetLists);
  const profile = contenderProfile(myAssets, otherAssetLists);
  const arb = arbitrage(allAssets);

  const myIds = new Set(myAssets.map((a) => a.id));
  const othersFlat = others.flatMap((r) => r.assets).filter((a) => !myIds.has(a.id));

  const sells = sellCandidates(myAssets, strength, arb);
  const buys = buyCandidates(othersFlat, strength, arb, profile);
  const ideas = tradeIdeas(sells, buys, ownerByAssetId);

  return { strength, profile, arbitrage: arb.slice(0, 20), sells, buys: buys.slice(0, 15), ideas };
}
