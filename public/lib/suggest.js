/**
 * Roster analysis and move suggestions.
 *
 * Design rule: EVERY suggestion must be earned by a computation that could have
 * come out the other way. A reason that would fire for most players on most
 * rosters ("he's in his prime", "he's up over 30 days") is noise dressed up as
 * insight, and was deliberately removed from this file.
 *
 * The reasons that survive are ones with a real denominator behind them:
 *
 *   - He cannot crack YOUR starting lineup (needs your league's slot rules).
 *   - You have N players stacked in one value band where only M start.
 *   - His value moved against his age curve over a year (needs real history).
 *   - The market prices him differently from the consensus (needs KTC).
 *   - He sits on a tier cliff (needs the shape of the consensus curve).
 *   - Your starter at this slot is below the league's median starter.
 */

import { ageStage, remainingWindow } from './agecurve.js';
import { buildLineup, startingCounts, deadWeight } from './lineup.js';

const ARBITRAGE_MIN_VALUE = 500;

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctStr = (x) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;

/* ------------------------------------------------------ lineup-aware strength */

/**
 * Compare YOUR starter at each lineup slot against what every other roster puts
 * in the equivalent slot. This is the honest version of "are you good at WR?" -
 * it counts only the players who actually play.
 */
export function slotStrength(myAssets, otherAssetLists, rosterPositions) {
  const mine = buildLineup(myAssets, rosterPositions);
  const others = otherAssetLists.map((a) => buildLineup(a, rosterPositions));

  const out = [];
  mine.lineup.forEach((entry, i) => {
    const peerValues = others
      .map((o) => o.lineup[i]?.player?.value)
      .filter((v) => Number.isFinite(v));
    const mineValue = entry.player?.value ?? 0;
    const better = peerValues.filter((v) => v > mineValue).length;
    out.push({
      slot: entry.slot,
      index: i,
      player: entry.player,
      value: mineValue,
      leagueMedian: Math.round(median(peerValues)),
      rank: better + 1,
      of: peerValues.length + 1,
      percentile: peerValues.length ? (peerValues.length - better) / peerValues.length : 0.5,
    });
  });
  return { mine, others, slots: out };
}

/** Roster-wide position totals, still useful as context alongside the lineup view. */
export function positionalStrength(myAssets, allRosterAssets) {
  const STARTER_SLOTS = { QB: 1, RB: 2, WR: 3, TE: 1 };
  const out = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const totalFor = (assets) => assets
      .filter((a) => a.position === pos)
      .sort((x, y) => y.value - x.value)
      .slice(0, (STARTER_SLOTS[pos] || 1) + 2)
      .reduce((s, a) => s + a.value, 0);
    const mine = totalFor(myAssets);
    const others = allRosterAssets.map(totalFor);
    const below = others.filter((v) => v < mine).length;
    const above = others.filter((v) => v > mine).length;
    const percentile = others.length ? below / others.length : 0.5;
    out[pos] = {
      total: Math.round(mine), leagueMedian: Math.round(median(others)),
      percentile: Number(percentile.toFixed(3)), rank: above + 1, of: others.length + 1,
      label: percentile >= 0.75 ? 'strength' : percentile <= 0.3 ? 'weakness' : 'average',
    };
  }
  return out;
}

export function contenderProfile(myAssets, allRosterAssets) {
  const nowValue = (assets) => assets.filter((a) => a.kind === 'player')
    .reduce((s, a) => s + a.value * (1 - 0.6 * (1 - remainingWindow(a.position, a.age))), 0);
  const total = (assets) => assets.reduce((s, a) => s + a.value, 0);
  const myTotal = total(myAssets);
  const others = allRosterAssets.map(total);
  const rank = others.filter((v) => v > myTotal).length + 1;
  const youthShare = myTotal ? 1 - nowValue(myAssets) / myTotal : 0;
  const topHalf = rank <= Math.ceil((others.length + 1) / 2);
  const stance = topHalf && youthShare < 0.35 ? 'contend'
    : !topHalf && youthShare > 0.4 ? 'rebuild'
    : topHalf ? 'contend-with-youth' : 'retool';
  return { totalValue: Math.round(myTotal), rank, of: others.length + 1,
           youthShare: Number(youthShare.toFixed(3)), stance };
}

/* -------------------------------------------------------------- market edge */

/**
 * KTC versus the average of the OTHER sources. KTC is the board most dynasty
 * players price trades from, so it approximates the price you can transact at,
 * while the blend approximates what the asset is worth. The gap is the edge -
 * and it runs opposite to intuition: you SELL the players your league
 * overrates.
 */
export function arbitrage(assets, { minValue = ARBITRAGE_MIN_VALUE, threshold = 0.12 } = {}) {
  const out = [];
  for (const a of assets) {
    const ktc = a.sources?.ktc?.normalized;
    if (!Number.isFinite(ktc) || ktc <= 0 || a.value < minValue) continue;
    const others = Object.entries(a.sources || {})
      .filter(([k, v]) => k !== 'ktc' && Number.isFinite(v?.normalized) && v.normalized > 0)
      .map(([, v]) => v.normalized);
    if (!others.length) continue;
    const fair = others.reduce((s, v) => s + v, 0) / others.length;
    const gap = (ktc - fair) / fair;
    if (Math.abs(gap) < threshold) continue;
    out.push({ ...a, marketValue: Math.round(ktc), fairValue: Math.round(fair),
               gap: Number(gap.toFixed(3)), direction: gap > 0 ? 'sell' : 'buy' });
  }
  return out.sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap));
}

/* ------------------------------------------------------------- tier cliffs */

/**
 * A tier cliff is a place on the board where value drops unusually fast. Owning
 * the last player above one is worth more than his number suggests, because the
 * replacement costs a lot less production.
 */
export function findTierCliffs(assets, { window: w = 6, sensitivity = 1.6 } = {}) {
  const ranked = assets.filter((a) => a.kind === 'player').slice(0, 220);
  const drops = [];
  for (let i = 0; i < ranked.length - w; i++) {
    const here = ranked[i].value, ahead = ranked[i + w].value;
    if (here > 0) drops.push((here - ahead) / here);
  }
  if (!drops.length) return new Map();
  const mean = drops.reduce((a, b) => a + b, 0) / drops.length;
  const cliffs = new Map();
  for (let i = 0; i < drops.length; i++) {
    if (drops[i] > mean * sensitivity) {
      cliffs.set(ranked[i].id, { dropPct: drops[i], nextTierAt: ranked[i + w]?.value });
    }
  }
  return cliffs;
}

/* --------------------------------------------------------------- candidates */

/**
 * Sell candidates. Each reason requires a computation specific to this player
 * on THIS roster in THIS league.
 */
export function sellCandidates(myAssets, { lineupResult, slots, arb, cliffs, profile }) {
  const arbById = new Map(arb.map((a) => [a.id, a]));
  const deadList = deadWeight(lineupResult);
  const dead = new Map(deadList.map((a) => [a.id, a]));

  // Value bands where you are stacked but cannot start everyone.
  const byPos = {};
  for (const a of lineupResult.bench) {
    if (a.value < 1500) continue;
    (byPos[a.position] ||= []).push(a);
  }

  const out = [];
  for (const a of myAssets) {
    if (a.kind !== 'player' || a.value < 600) continue;
    const reasons = [];
    const stage = ageStage(a.position, a.age);

    const blocked = dead.get(a.id)?.blocked;
    if (blocked) {
      const ahead = blocked.ahead.slice(0, 3).join(', ');
      reasons.push({ code: 'dead-weight', weight: 3,
        text: `${a.value.toLocaleString()} of value you cannot start: behind ${blocked.ahead.length} better option${blocked.ahead.length === 1 ? '' : 's'}`
            + `${ahead ? ` (${ahead})` : ''} at ${blocked.slots.join('/')}` });
    }

    const stacked = byPos[a.position] || [];
    if (stacked.length >= 2 && stacked.includes(a)) {
      reasons.push({ code: 'stacked', weight: 2,
        text: `one of ${stacked.length} benched ${a.position}s worth ${Math.min(...stacked.map((x) => x.value)).toLocaleString()}–${Math.max(...stacked.map((x) => x.value)).toLocaleString()} — that value is trapped on your bench` });
    }

    // Real long-horizon trajectory, not a 30-day blip.
    if (Number.isFinite(a.pct365) && a.pct365 < -0.15) {
      reasons.push({ code: 'year-slide', weight: 3,
        text: `${pctStr(a.pct365)} over the past year${stage === 'ascending' ? ' — and he is still young, so this is the market souring, not aging' : ''}` });
    } else if (Number.isFinite(a.pct90) && a.pct90 < -0.12) {
      reasons.push({ code: 'quarter-slide', weight: 2, text: `${pctStr(a.pct90)} over 90 days` });
    }

    if (stage === 'cliff' && a.value > 1500) {
      reasons.push({ code: 'age-cliff', weight: 3,
        text: `${a.age} at ${a.position} — past the point where dynasty value usually falls off a cliff` });
    }

    const m = arbById.get(a.id);
    if (m?.direction === 'sell') {
      reasons.push({ code: 'market-high', weight: 3,
        text: `KTC prices him ${Math.round(m.gap * 100)}% above the other sources — your leaguemates will pay more than he is worth` });
    }

    // Contending with a young asset you will not benefit from in time.
    if (profile.stance === 'contend' && stage === 'ascending' && a.value > 2500 && dead.has(a.id)) {
      reasons.push({ code: 'wrong-timeline', weight: 2,
        text: `${a.value.toLocaleString()} tied up in a ${a.age}-year-old who cannot start, on a roster ranked `
            + `${profile.rank} of ${profile.of} and built to win now` });
    }

    if (reasons.length) {
      out.push({ ...a, reasons, priority: reasons.reduce((s, r) => s + r.weight, 0) });
    }
  }
  return out.filter((x) => x.priority >= 3).sort((p, q) => q.priority - p.priority || q.value - p.value);
}

/**
 * Buy targets from other rosters. A target must either fix something specific
 * about your lineup or be mispriced - "he is good" is not a reason.
 */
export function buyCandidates(othersAssets, { slots, arb, cliffs, profile, lineupResult }) {
  const arbById = new Map(arb.map((a) => [a.id, a]));

  // Which lineup slots are you actually below the league median at?
  const weakSlots = slots.filter((s) => s.player == null || s.value < s.leagueMedian * 0.85);
  const weakPositions = new Map();
  for (const s of weakSlots) {
    const eligible = s.slot === 'SUPER_FLEX' || s.slot === 'SUPERFLEX' ? ['QB', 'RB', 'WR', 'TE']
      : s.slot === 'FLEX' ? ['RB', 'WR', 'TE'] : [s.slot];
    for (const p of eligible) {
      if (!weakPositions.has(p) || weakPositions.get(p).value > s.value) weakPositions.set(p, s);
    }
  }
  const starterFloor = Math.min(...lineupResult.starters.map((s) => s.value), Infinity);

  const out = [];
  for (const a of othersAssets) {
    if (a.kind !== 'player' || a.value < 800) continue;
    const reasons = [];
    const stage = ageStage(a.position, a.age);

    const weak = weakPositions.get(a.position);
    if (weak && a.value > weak.value * 1.15) {
      reasons.push({ code: 'upgrades-slot', weight: 3,
        text: weak.player
          ? `would upgrade your ${weak.slot} — you start ${weak.player.name} (${weak.value.toLocaleString()}) there, the league median is ${weak.leagueMedian.toLocaleString()}`
          : `you have nothing to start at ${weak.slot}` });
    }

    const m = arbById.get(a.id);
    if (m?.direction === 'buy') {
      reasons.push({ code: 'market-low', weight: 3,
        text: `KTC prices him ${Math.round(Math.abs(m.gap) * 100)}% below the other sources — his owner will let him go cheap` });
    }

    const cliff = cliffs.get(a.id);
    if (cliff) {
      reasons.push({ code: 'tier-cliff', weight: 2,
        text: `last man above a tier break — value drops ${Math.round(cliff.dropPct * 100)}% just below him` });
    }

    // Trajectory against the age curve, from real history.
    if (Number.isFinite(a.pct365) && a.pct365 > 0.2 && (stage === 'ascending' || stage === 'peak')) {
      reasons.push({ code: 'year-riser', weight: 2, text: `${pctStr(a.pct365)} over the past year at ${a.age}` });
    } else if (Number.isFinite(a.pct365) && a.pct365 < -0.2 && stage === 'ascending' && a.value > 2000) {
      reasons.push({ code: 'buy-low-young', weight: 3,
        text: `${pctStr(a.pct365)} over the year but only ${a.age} — the discount is on the market's patience, not his age` });
    }

    if (profile.stance === 'rebuild' && stage === 'ascending' && a.value >= starterFloor) {
      reasons.push({ code: 'fits-rebuild', weight: 1,
        text: `${a.age} and still ascending, and at ${a.value.toLocaleString()} he would start for you immediately` });
    }

    if (reasons.length) out.push({ ...a, reasons, priority: reasons.reduce((s, r) => s + r.weight, 0) });
  }
  return out.filter((x) => x.priority >= 3).sort((p, q) => q.priority - p.priority || q.value - p.value);
}

/**
 * Consolidation: several benched players who together outvalue one starter you
 * do not have. This is the move most rosters actually need and no single-player
 * recommendation surfaces.
 */
export function consolidationIdeas(lineupResult, slots, allAssets, ownerByAssetId, { limit = 4 } = {}) {
  const ideas = [];
  const dead = deadWeight(lineupResult);
  if (dead.length < 2) return ideas;

  const weakSlots = [...slots].filter((s) => s.player).sort((a, b) => a.percentile - b.percentile).slice(0, 3);
  const myIds = new Set([...lineupResult.starters, ...lineupResult.bench].map((a) => a.id));

  for (const slot of weakSlots) {
    for (let n = 2; n <= Math.min(3, dead.length); n++) {
      const package_ = dead.slice(0, n);
      // A consolidation discount is what the other side charges for the squeeze.
      const buying = package_.reduce((s, a) => s + a.value, 0) * 0.85;
      if (buying < slot.value * 1.25) continue;

      const target = allAssets.find((a) => a.kind === 'player' && !myIds.has(a.id)
        && a.value <= buying && a.value > slot.value * 1.25
        && (slot.slot === 'FLEX' ? ['RB', 'WR', 'TE'] : slot.slot.includes('FLEX') ? ['QB', 'RB', 'WR', 'TE'] : [slot.slot]).includes(a.position));
      if (!target) continue;

      ideas.push({
        type: 'consolidation',
        give: package_,          // always an array; see tradeIdeas
        get: target,
        withTeam: ownerByAssetId.get(target.id) || null,
        slot: slot.slot,
        rationale:
          `${package_.map((p) => p.name).join(' + ')} are worth ${package_.reduce((s, a) => s + a.value, 0).toLocaleString()} ` +
          `combined but none of them start for you. ${target.name} (${target.value.toLocaleString()}) would replace ` +
          `${slot.player.name} (${slot.value.toLocaleString()}) at ${slot.slot}, where you currently rank ` +
          `${slot.rank} of ${slot.of}.`,
      });
      break;
    }
  }
  return ideas.slice(0, limit);
}

/** One-for-one swaps matched on value, ranked by how mispriced both sides are. */
export function tradeIdeas(sells, buys, ownerByAssetId, { band = 0.18, limit = 6 } = {}) {
  const ideas = [];
  for (const sell of sells.slice(0, 8)) {
    for (const buy of buys) {
      if (buy.value <= 0) continue;
      if (Math.abs(buy.value - sell.value) / Math.max(buy.value, sell.value) > band) continue;
      const edge = (sell.reasons.some((r) => r.code === 'market-high') ? 1 : 0)
                 + (buy.reasons.some((r) => r.code === 'market-low') ? 1 : 0);
      ideas.push({
        // `give` is always an array so consumers never have to branch on the
        // idea type to read it. A swap is simply a one-item package.
        type: 'swap', give: [sell], get: buy,
        withTeam: ownerByAssetId.get(buy.id) || null,
        valueGap: Math.round(buy.value - sell.value), edge,
        rationale: [...sell.reasons.map((r) => `Give ${sell.name}: ${r.text}`),
                    ...buy.reasons.map((r) => `Get ${buy.name}: ${r.text}`)],
      });
    }
  }
  const perGive = {}, perGet = {}, spread = [];
  for (const idea of ideas.sort((a, b) => b.edge - a.edge || Math.abs(a.valueGap) - Math.abs(b.valueGap))) {
    const giveId = idea.give[0].id;
    perGive[giveId] = (perGive[giveId] || 0) + 1;
    perGet[idea.get.id] = (perGet[idea.get.id] || 0) + 1;
    if (perGive[giveId] > 2 || perGet[idea.get.id] > 1) continue;
    spread.push(idea);
    if (spread.length >= limit) break;
  }
  return spread;
}

/* ------------------------------------------------------------------- entry */

export function analyzeRoster({ myAssets, rostersAssets, allAssets, ownerByAssetId, rosterPositions = [] }) {
  const others = rostersAssets.filter((r) => r.assets !== myAssets);
  const otherAssetLists = others.map((r) => r.assets);

  const { mine: lineupResult, slots } = slotStrength(myAssets, otherAssetLists, rosterPositions);
  const strength = positionalStrength(myAssets, otherAssetLists);
  const profile = contenderProfile(myAssets, otherAssetLists);
  const arb = arbitrage(allAssets);
  const cliffs = findTierCliffs(allAssets);

  const myIds = new Set(myAssets.map((a) => a.id));
  const othersFlat = others.flatMap((r) => r.assets).filter((a) => !myIds.has(a.id));

  const sells = sellCandidates(myAssets, { lineupResult, slots, arb, cliffs, profile });
  const buys = buyCandidates(othersFlat, { slots, arb, cliffs, profile, lineupResult });
  const swaps = tradeIdeas(sells, buys, ownerByAssetId);
  const consolidations = consolidationIdeas(lineupResult, slots, allAssets, ownerByAssetId);

  return {
    strength, profile, slots, lineup: lineupResult,
    usedDefaultLineup: !(rosterPositions || []).some((x) => !['BN', 'IR', 'TAXI'].includes(x)),
    arbitrage: arb.slice(0, 20),
    sells: sells.slice(0, 12),
    buys: buys.slice(0, 12),
    ideas: [...consolidations, ...swaps],
    startingCounts: startingCounts(rosterPositions),
  };
}
