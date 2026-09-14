/**
 * Historical value series.
 *
 * DynastyProcess commits values-players.csv to GitHub once a week and has done
 * since 2024, so their git history IS a two-year weekly archive of dynasty
 * values. We read it through the GitHub API and assemble a per-player series,
 * which means player history charts work on day one rather than after a month
 * of our own nightly snapshots.
 *
 * Incremental by design: the built series is published alongside the board, and
 * each run only fetches commits it has not already seen. The first run pulls
 * ~100 weekly snapshots; every run after that pulls one.
 */

import { parseCsv, resolveSleeperId } from '../public/lib/crosswalk.js';

const REPO = 'dynastyprocess/data';
const FILE = 'files/values-players.csv';
const RAW = (sha) => `https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`;

/** Weekly commit list, newest first. */
export async function listSnapshots(fetchImpl = fetch, pages = 2) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.github.com/repos/${REPO}/commits` +
      `?path=${encodeURIComponent(FILE)}&per_page=100&page=${page}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) {
      if (page === 1) throw new Error(`github commits ${res.status}`);
      break;
    }
    const commits = await res.json();
    if (!Array.isArray(commits) || !commits.length) break;
    for (const c of commits) {
      out.push({ sha: c.sha, date: (c.commit?.author?.date || '').slice(0, 10) });
    }
    if (commits.length < 100) break;
  }
  // One snapshot per date, newest sha wins.
  const byDate = new Map();
  for (const s of out) if (s.date && !byDate.has(s.date)) byDate.set(s.date, s);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Read one dated snapshot into { sleeperId: value } for a QB format. */
export async function loadSnapshot(sha, superflex, xw, fetchImpl = fetch) {
  const res = await fetchImpl(RAW(sha));
  if (!res.ok) throw new Error(`snapshot ${sha.slice(0, 8)} -> ${res.status}`);
  const rows = parseCsv(await res.text());
  const col = superflex ? 'value_2qb' : 'value_1qb';
  const out = {};
  for (const r of rows) {
    const v = Number(r[col]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const id = resolveSleeperId(xw, { fpId: r.fp_id, name: r.player, position: r.pos });
    if (id) out[id] = Math.round(v);
  }
  return out;
}

/**
 * Build or extend the series.
 *
 * @param existing previously published { dates: [...], series: { id: [...] } }
 * @param options.maxSnapshots cap on how many dates to keep
 * @param options.maxNewPerRun cap on fetches per run, so a cold start cannot
 *        run forever inside a CI job
 */
export async function buildHistory(superflex, xw, {
  existing = null, fetchImpl = fetch, maxSnapshots = 110, maxNewPerRun = 120, log = () => {},
} = {}) {
  const snapshots = await listSnapshots(fetchImpl);
  const have = new Set(existing?.dates || []);
  const missing = snapshots.filter((s) => !have.has(s.date)).slice(-maxNewPerRun);

  log(`  ${snapshots.length} weekly snapshots upstream, ${have.size} already stored, fetching ${missing.length}`);

  const fetched = [];
  for (const snap of missing) {
    try {
      fetched.push({ date: snap.date, values: await loadSnapshot(snap.sha, superflex, xw, fetchImpl) });
    } catch (e) {
      log(`  snapshot ${snap.date} failed: ${e.message}`);
    }
  }

  // Merge old and new into one date-ordered table.
  const byDate = new Map();
  for (const d of existing?.dates || []) byDate.set(d, null);
  const merged = new Map();
  const allDates = [...new Set([...(existing?.dates || []), ...fetched.map((f) => f.date)])].sort();
  const keep = allDates.slice(-maxSnapshots);
  const keepIndex = new Map(keep.map((d, i) => [d, i]));

  const oldIndex = new Map((existing?.dates || []).map((d, i) => [d, i]));
  const ids = new Set([
    ...Object.keys(existing?.series || {}),
    ...fetched.flatMap((f) => Object.keys(f.values)),
  ]);

  for (const id of ids) {
    const row = new Array(keep.length).fill(null);
    const prior = existing?.series?.[id];
    if (prior) {
      for (const [d, i] of oldIndex) {
        const k = keepIndex.get(d);
        if (k != null && Number.isFinite(prior[i])) row[k] = prior[i];
      }
    }
    for (const f of fetched) {
      const k = keepIndex.get(f.date);
      if (k != null && Number.isFinite(f.values[id])) row[k] = f.values[id];
    }
    if (row.some((v) => v != null)) merged.set(id, row);
  }

  return {
    dates: keep,
    series: Object.fromEntries(merged),
    builtAt: new Date().toISOString(),
    snapshotCount: keep.length,
  };
}

/** Derive a value change over approximately `days`, from a series row. */
export function changeOver(dates, row, days, now = Date.now()) {
  if (!row?.length) return null;
  const targetTs = now - days * 86400000;
  let bestI = -1, bestGap = Infinity;
  for (let i = 0; i < dates.length; i++) {
    if (row[i] == null) continue;
    const gap = Math.abs(Date.parse(dates[i] + 'T00:00:00Z') - targetTs);
    if (gap < bestGap) { bestGap = gap; bestI = i; }
  }
  if (bestI < 0) return null;
  // Refuse to label a snapshot a `days` trend if it is less than half that old.
  const actualDays = Math.round((now - Date.parse(dates[bestI] + 'T00:00:00Z')) / 86400000);
  if (actualDays < days * 0.5) return null;
  let latest = null;
  for (let i = dates.length - 1; i >= 0; i--) if (row[i] != null) { latest = row[i]; break; }
  if (latest == null) return null;
  return { from: row[bestI], to: latest, delta: latest - row[bestI],
           pct: row[bestI] ? (latest - row[bestI]) / row[bestI] : null, days: actualDays };
}
