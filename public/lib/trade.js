/**
 * Trade evaluation.
 *
 * Two things this does that a single-source calculator cannot:
 *
 *  1. It reports the verdict SEPARATELY FOR EACH SOURCE as well as for the
 *     blend. When KTC says you win and consensus says you lose, that gap is the
 *     whole reason to build this - a leaguemate pricing off KTC will accept a
 *     deal that the broader market says is good for you.
 *  2. It applies an explicit, adjustable consolidation adjustment rather than
 *     pretending roster spots are free.
 */

/**
 * Consolidation. Three 2000-value players are not worth one 6000-value player,
 * because only so many can start and the roster spots have their own cost.
 * We discount the *receiving* side of a lopsided package by shrinking the
 * contribution of each successive asset beyond the first.
 *
 * decay 0    -> no adjustment, pure sum (what most calculators do)
 * decay 0.08 -> each extra asset counts ~8% less than the one before it
 */
export function packageValue(assets, { decay = 0.08, valueKey = 'value' } = {}) {
  const sorted = [...assets].sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0));
  let total = 0;
  sorted.forEach((a, i) => {
    total += (a[valueKey] || 0) * Math.pow(1 - decay, i);
  });
  return { raw: sorted.reduce((s, a) => s + (a[valueKey] || 0), 0), adjusted: total, sorted };
}

/** Per-source totals, so we can show where the sources disagree about a deal. */
function sourceTotals(assets, decay) {
  const names = new Set();
  for (const a of assets) for (const s of Object.keys(a.sources || {})) names.add(s);
  const out = {};
  for (const src of names) {
    // Only count assets this source actually prices, and note the coverage so
    // a source missing half the deal cannot quietly look decisive.
    const priced = assets.filter((a) => a.sources?.[src]?.normalized > 0)
      .map((a) => ({ value: a.sources[src].normalized }));
    out[src] = {
      total: Math.round(packageValue(priced, { decay }).adjusted),
      covered: priced.length,
      of: assets.length,
    };
  }
  return out;
}

/**
 * @param sideA / sideB arrays of board assets (players and/or picks)
 * @returns verdict object
 */
export function evaluateTrade(sideA, sideB, { decay = 0.08 } = {}) {
  const a = packageValue(sideA, { decay });
  const b = packageValue(sideB, { decay });

  const diff = a.adjusted - b.adjusted;
  const larger = Math.max(a.adjusted, b.adjusted) || 1;
  const gapPct = Math.abs(diff) / larger;

  const perSource = { a: sourceTotals(sideA, decay), b: sourceTotals(sideB, decay) };

  // Which way does each source lean, and by how much?
  const sourceVerdicts = {};
  for (const src of new Set([...Object.keys(perSource.a), ...Object.keys(perSource.b)])) {
    const ta = perSource.a[src]?.total || 0;
    const tb = perSource.b[src]?.total || 0;
    const big = Math.max(ta, tb) || 1;
    sourceVerdicts[src] = {
      aTotal: ta, bTotal: tb,
      diff: ta - tb,
      gapPct: Number((Math.abs(ta - tb) / big).toFixed(4)),
      favors: Math.abs(ta - tb) / big < 0.05 ? 'even' : (ta > tb ? 'a' : 'b'),
    };
  }

  const leanings = Object.values(sourceVerdicts).map((v) => v.favors);
  const contested = new Set(leanings.filter((l) => l !== 'even')).size > 1;

  return {
    a: { raw: Math.round(a.raw), adjusted: Math.round(a.adjusted), count: sideA.length },
    b: { raw: Math.round(b.raw), adjusted: Math.round(b.adjusted), count: sideB.length },
    diff: Math.round(diff),
    gapPct: Number(gapPct.toFixed(4)),
    favors: gapPct < 0.05 ? 'even' : (diff > 0 ? 'a' : 'b'),
    verdict: verdictLabel(gapPct),
    perSource, sourceVerdicts,
    // True when sources genuinely disagree about WHO WINS, not merely by how
    // much. This is the signal worth acting on.
    contested,
    lowConfidence: [...sideA, ...sideB].some((x) => x.lowConfidence),
  };
}

function verdictLabel(gapPct) {
  if (gapPct < 0.05) return 'Even';
  if (gapPct < 0.12) return 'Slight edge';
  if (gapPct < 0.25) return 'Clear edge';
  return 'Lopsided';
}
