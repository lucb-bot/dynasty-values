/**
 * DynastyProcess adapter.
 *
 * Open data, published as CSVs on GitHub and refreshed weekly by a GitHub
 * Action. Values are derived from FantasyPros expert consensus rankings, so it
 * is a "what the analysts think" signal rather than a "what the market does"
 * signal - complementary to FantasyCalc and KTC.
 *
 * Two quirks worth knowing:
 *  1. Players carry explicit values (value_1qb / value_2qb) but PICKS DO NOT -
 *     values-picks.csv ships only consensus ranks. We convert a pick's rank
 *     into a value by interpolating the player rank->value curve from the same
 *     file, which keeps picks on DynastyProcess's own scale.
 *  2. It is 1QB or 2QB only; there is no team-count or PPR dimension.
 */

import { parseCsv, resolveSleeperId } from '../../public/lib/crosswalk.js';
import { canonicalPickName } from '../../public/lib/picks.js';

const FILES = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files';

export async function loadDynastyProcess(format, xw, fetchImpl = fetch) {
  const sf = !!format.superflex;
  const valueCol = sf ? 'value_2qb' : 'value_1qb';
  const ecrCol = sf ? 'ecr_2qb' : 'ecr_1qb';

  const [playersRes, picksRes] = await Promise.all([
    fetchImpl(`${FILES}/values-players.csv`),
    fetchImpl(`${FILES}/values-picks.csv`),
  ]);
  if (!playersRes.ok) throw new Error(`dynastyprocess players ${playersRes.status}`);

  const playerRows = parseCsv(await playersRes.text());
  const assets = [];
  let unmatched = 0;
  let scrapeDate = null;

  // (rank, value) pairs, used to price picks on this source's own curve.
  const curve = [];

  for (const r of playerRows) {
    const value = Number(r[valueCol]);
    const ecr = Number(r[ecrCol]);
    if (!Number.isFinite(value) || value <= 0) continue;
    scrapeDate = scrapeDate || r.scrape_date || null;
    if (Number.isFinite(ecr)) curve.push([ecr, value]);

    const sleeperId = resolveSleeperId(xw, {
      fpId: r.fp_id, name: r.player, position: r.pos,
    });
    if (!sleeperId) { unmatched++; continue; }

    assets.push({
      id: sleeperId, kind: 'player', name: r.player, position: r.pos,
      team: r.team || null,
      age: Number(r.age) || null,
      rawValue: value,
    });
  }

  curve.sort((a, b) => a[0] - b[0]);

  if (picksRes.ok) {
    const pickRows = parseCsv(await picksRes.text());
    for (const r of pickRows) {
      const ecr = Number(r[ecrCol]);
      if (!Number.isFinite(ecr)) continue;
      const canonical = canonicalPickName(r.player, 'PICK');
      if (!canonical) continue;
      const value = interpolateCurve(curve, ecr);
      if (value == null) continue;
      // A round can map to several slots; keep the best (lowest-rank) estimate
      // per canonical name and average duplicates.
      assets.push({
        id: canonical, kind: 'pick', name: canonical, position: 'PICK',
        rawValue: value,
      });
    }
  }

  return {
    source: 'dynastyprocess',
    assets: mergeDuplicatePicks(assets),
    unmatched,
    scrapeDate,
    fetchedAt: new Date().toISOString(),
  };
}

/** Linear interpolation of value at a fractional consensus rank. */
export function interpolateCurve(curve, rank) {
  if (!curve.length) return null;
  if (rank <= curve[0][0]) return curve[0][1];
  if (rank >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 1; i < curve.length; i++) {
    const [r0, v0] = curve[i - 1];
    const [r1, v1] = curve[i];
    if (rank <= r1) {
      if (r1 === r0) return (v0 + v1) / 2;
      const t = (rank - r0) / (r1 - r0);
      return v0 + t * (v1 - v0);
    }
  }
  return curve[curve.length - 1][1];
}

/** Several draft slots collapse to one canonical pick; average their values. */
function mergeDuplicatePicks(assets) {
  const picks = new Map();
  const out = [];
  for (const a of assets) {
    if (a.kind !== 'pick') { out.push(a); continue; }
    if (!picks.has(a.id)) picks.set(a.id, { ...a, _n: 1 });
    else {
      const p = picks.get(a.id);
      p.rawValue += a.rawValue;
      p._n++;
    }
  }
  for (const p of picks.values()) {
    out.push({ ...p, rawValue: p.rawValue / p._n, _n: undefined });
  }
  return out;
}
