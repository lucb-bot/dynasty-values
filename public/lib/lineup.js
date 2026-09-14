/**
 * Starting-lineup modelling.
 *
 * Most dynasty tools value a roster by summing everything on it. That is
 * misleading: in a league that starts 2 RBs, your RB5 contributes nothing to
 * any given week no matter what a value chart says about him. Splitting a
 * roster into STARTERS and BENCH is what makes "you have dead weight" and
 * "consolidate these three into one" computable instead of vibes.
 */

const FLEX_ELIGIBLE = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
};
const IGNORED_SLOTS = new Set(['BN', 'IR', 'TAXI', 'K', 'DEF', 'DL', 'LB', 'DB', 'IDP_FLEX']);

/**
 * Fill the league's starting slots greedily from the most valuable eligible
 * player. Dedicated positions are filled before flex slots, so a flex is
 * assigned the best player left over rather than stealing a starter.
 */
/**
 * A conventional dynasty lineup, used when a league's slots are unavailable.
 * Without this, an empty slot list yields an empty lineup, which would make
 * every bench player look like dead weight - a silent, confident wrong answer.
 */
export const DEFAULT_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX'];

export function buildLineup(assets, rosterPositions = []) {
  const filtered = (rosterPositions || []).filter((s) => !IGNORED_SLOTS.has(s));
  const slots = filtered.length ? filtered : DEFAULT_SLOTS;
  const pool = assets.filter((a) => a.kind === 'player').sort((x, y) => y.value - x.value);
  const used = new Set();
  const lineup = [];

  const fill = (slot, eligible) => {
    const pick = pool.find((a) => !used.has(a) && eligible.includes(a.position));
    if (pick) used.add(pick);
    lineup.push({ slot, player: pick || null });
  };

  for (const slot of slots) if (!FLEX_ELIGIBLE[slot]) fill(slot, [slot]);
  for (const slot of slots) if (FLEX_ELIGIBLE[slot]) fill(slot, FLEX_ELIGIBLE[slot]);

  const bench = pool.filter((a) => !used.has(a));
  const starterValue = lineup.reduce((s, x) => s + (x.player?.value || 0), 0);

  return {
    lineup,
    starters: lineup.map((x) => x.player).filter(Boolean),
    bench,
    starterValue,
    benchValue: bench.reduce((s, a) => s + a.value, 0),
    holes: lineup.filter((x) => !x.player).map((x) => x.slot),
  };
}

/** How many of each position actually start in this league. */
export function startingCounts(rosterPositions = []) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  let flex = 0, superflex = 0;
  for (const s of rosterPositions) {
    if (counts[s] != null) counts[s]++;
    else if (s === 'SUPER_FLEX' || s === 'SUPERFLEX') superflex++;
    else if (FLEX_ELIGIBLE[s]) flex++;
  }
  return { ...counts, flex, superflex };
}

/**
 * Players whose value cannot reach your starting lineup - the ones a trade
 * should be converting into something that can.
 */
/**
 * Bench players who cannot reach the lineup.
 *
 * The test is POSITIONAL, not a single value floor. Comparing against the
 * weakest starter overall gets this wrong whenever one slot is bad: if your
 * starting TE is worth 900, a 5,000 RB buried behind three better RBs looks
 * "above the floor" and escapes the filter, even though he is exactly the
 * trapped value you want to trade. A player is dead weight when he cannot beat
 * the worst starter at any slot he is ELIGIBLE for.
 */
export function deadWeight(lineupResult, { minValue = 800 } = {}) {
  if (!lineupResult.starters?.length) return [];

  // Worst starter currently occupying each slot type.
  const worstBySlot = new Map();
  for (const { slot, player } of lineupResult.lineup || []) {
    if (!player) continue;
    const cur = worstBySlot.get(slot);
    if (cur == null || player.value < cur) worstBySlot.set(slot, player.value);
  }

  const canReachLineup = (a) => {
    for (const [slot, worst] of worstBySlot) {
      const eligible = FLEX_ELIGIBLE[slot] || [slot];
      if (eligible.includes(a.position) && a.value > worst) return true;
    }
    return false;
  };

  // Who is blocking him, so the UI can say something specific rather than
  // quoting a floor number that no longer explains the decision.
  const blockersFor = (a) => {
    const slots = [...worstBySlot.keys()]
      .filter((slot) => (FLEX_ELIGIBLE[slot] || [slot]).includes(a.position));
    const names = [];
    for (const { slot, player } of lineupResult.lineup || []) {
      if (!player || !slots.includes(slot)) continue;
      if (player.value > a.value) names.push(player.name);
    }
    return { slots: [...new Set(slots)], ahead: names };
  };

  return lineupResult.bench
    .filter((a) => a.value >= minValue && !canReachLineup(a))
    .map((a) => ({ ...a, blocked: blockersFor(a) }))
    .sort((a, b) => b.value - a.value);
}
