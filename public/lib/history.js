/**
 * Value trends.
 *
 * Movers are computed from our OWN dated board snapshots, not from any single
 * source's trend field - otherwise the "risers" list would describe
 * FantasyCalc's opinion rather than the blend the rest of the app runs on.
 *
 * The pipeline keeps dated boards on the mini's disk, computes deltas here, and
 * bakes delta7/delta30 into each asset before publishing. That means the browser
 * and the Worker do no trend work at all.
 *
 * Before 7 or 30 days of history exist, deltas fall back to FantasyCalc's
 * trend30Day, flagged with basis:'fantasycalc30d' so the UI can label it.
 */

/** Choose the snapshot closest to `days` ago, tolerating missed nightly runs. */
export function pickSnapshot(snapshots, days, now = Date.now()) {
  if (!snapshots?.length) return null;
  const target = now - days * 86400000;
  // Ignore anything newer than 12h old - that is today's run, not history.
  const eligible = snapshots.filter((s) => {
    const t = Date.parse(s.date + 'T00:00:00Z');
    return Number.isFinite(t) && t <= now - 43200000;
  });
  if (!eligible.length) return null;
  let best = null, bestGap = Infinity;
  for (const s of eligible) {
    const gap = Math.abs(Date.parse(s.date + 'T00:00:00Z') - target);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  // Too far off to honestly call it a `days`-day trend.
  const actualDays = Math.round((now - Date.parse(best.date + 'T00:00:00Z')) / 86400000);
  if (actualDays < days * 0.5) return null;
  return { ...best, actualDays };
}

/**
 * Annotate assets in place with delta7 / delta30 (absolute blended-value change)
 * and the basis used. Returns the assets for chaining.
 */
export function annotateTrends(assets, snapshots, now = Date.now()) {
  const s7 = pickSnapshot(snapshots, 7, now);
  const s30 = pickSnapshot(snapshots, 30, now);

  for (const a of assets) {
    const then7 = s7?.values?.[a.id];
    const then30 = s30?.values?.[a.id];

    if (Number.isFinite(then7) && then7 > 0) {
      a.delta7 = Math.round(a.value - then7);
      a.pct7 = Number(((a.value - then7) / then7).toFixed(4));
      a.trendBasis7 = `blended:${s7.actualDays}d`;
    } else {
      a.delta7 = null; a.pct7 = null; a.trendBasis7 = null;
    }

    if (Number.isFinite(then30) && then30 > 0) {
      a.delta30 = Math.round(a.value - then30);
      a.pct30 = Number(((a.value - then30) / then30).toFixed(4));
      a.trendBasis30 = `blended:${s30.actualDays}d`;
    } else if (Number.isFinite(a.sources?.fantasycalc?.trend30)) {
      a.delta30 = Math.round(a.sources.fantasycalc.trend30);
      a.pct30 = null;
      a.trendBasis30 = 'fantasycalc30d';
    } else {
      a.delta30 = null; a.pct30 = null; a.trendBasis30 = null;
    }
  }
  return assets;
}

/** Split annotated assets into risers and fallers for the movers view. */
export function movers(assets, { window = 30, limit = 20, minValue = 300 } = {}) {
  const key = window === 7 ? 'delta7' : 'delta30';
  const eligible = assets.filter((a) => Number.isFinite(a[key]) && a.value >= minValue);
  return {
    risers: [...eligible].filter((a) => a[key] > 0).sort((p, q) => q[key] - p[key]).slice(0, limit),
    fallers: [...eligible].filter((a) => a[key] < 0).sort((p, q) => p[key] - q[key]).slice(0, limit),
    covered: eligible.length,
  };
}
