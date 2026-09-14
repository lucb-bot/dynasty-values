/**
 * FantasyCalc adapter.
 *
 * Free, keyless, CORS-enabled. Values are derived from real trades in public
 * leagues, which makes it a genuinely independent signal from consensus-ranking
 * sources like DynastyProcess.
 *
 *   https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1
 *
 * The response has been served in two shapes historically: player fields at the
 * top level, and player fields nested under `.player`. We read both so a shape
 * change upstream degrades into a warning instead of an outage.
 */

import { resolveSleeperId } from '../../public/lib/crosswalk.js';
import { canonicalPickName } from '../../public/lib/picks.js';

const BASE = 'https://api.fantasycalc.com/values/current';

export function fantasycalcUrl({ superflex, teams, ppr }) {
  const p = new URLSearchParams({
    isDynasty: 'true',
    numQbs: superflex ? '2' : '1',
    numTeams: String(teams),
    ppr: String(ppr),
  });
  return `${BASE}?${p}`;
}

/** Pull a field that may live at the top level or under `.player`. */
function pick(row, ...names) {
  for (const n of names) {
    if (row?.[n] != null && row[n] !== '') return row[n];
    if (row?.player?.[n] != null && row.player[n] !== '') return row.player[n];
  }
  return null;
}

export async function loadFantasyCalc(format, xw, fetchImpl = fetch) {
  const url = fantasycalcUrl(format);
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fantasycalc ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('fantasycalc: expected an array');

  const assets = [];
  let unmatched = 0;

  for (const row of rows) {
    const rawValue = Number(pick(row, 'value'));
    if (!Number.isFinite(rawValue) || rawValue <= 0) continue;

    const name = pick(row, 'name', 'playerName', 'fullName');
    const position = pick(row, 'position', 'pos');
    const trend30 = Number(pick(row, 'trend30Day')) || null;

    // Rookie picks come through the same feed, named like "2027 1st".
    const asPick = canonicalPickName(name, position);
    if (asPick) {
      assets.push({
        id: asPick, kind: 'pick', name: asPick, position: 'PICK',
        rawValue, trend30,
      });
      continue;
    }

    const sleeperId = resolveSleeperId(xw, {
      sleeperId: pick(row, 'sleeperId'),
      fpId: pick(row, 'fantasyProsId', 'fantasyprosId'),
      name, position,
    });
    if (!sleeperId) { unmatched++; continue; }

    assets.push({
      id: sleeperId, kind: 'player', name, position,
      team: pick(row, 'team', 'maybeTeam', 'nflTeam'),
      age: Number(pick(row, 'age', 'maybeAge')) || null,
      rawValue, trend30,
      redraftValue: Number(pick(row, 'redraftValue')) || null,
    });
  }

  return { source: 'fantasycalc', assets, unmatched, fetchedAt: new Date().toISOString() };
}
