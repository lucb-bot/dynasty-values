/**
 * KeepTradeCut adapter.
 *
 * KTC has no API and their terms forbid scraping, so nothing here reaches out
 * to their site. Instead this module parses a payload that is POSTed to the
 * Worker's ingest endpoint by a script running on your own machine (see
 * scripts/ktc-scrape.mjs). Two reasons that split exists:
 *
 *   - The scrape runs on a residential IP rather than a datacenter range that
 *     is likely blocked already and shared with other people.
 *   - Nothing is ever redistributed: the values land in your private KV and are
 *     served only behind Cloudflare Access.
 *
 * Ingest contract (array):
 *   { ktcId?: string, name: string, position: string, value: number }
 */

import { resolveSleeperId } from '../../public/lib/crosswalk.js';
import { canonicalPickName } from '../../public/lib/picks.js';

export function parseKtcPayload(rows, xw) {
  if (!Array.isArray(rows)) throw new Error('ktc payload must be an array');
  const assets = [];
  let unmatched = 0;
  const unmatchedNames = [];

  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value) || value <= 0) continue;

    const asPick = canonicalPickName(row.name, row.position);
    if (asPick) {
      assets.push({ id: asPick, kind: 'pick', name: asPick, position: 'PICK', rawValue: value });
      continue;
    }

    const sleeperId = resolveSleeperId(xw, {
      ktcId: row.ktcId, name: row.name, position: row.position,
    });
    if (!sleeperId) {
      unmatched++;
      if (unmatchedNames.length < 25) unmatchedNames.push(row.name);
      continue;
    }

    assets.push({
      id: sleeperId, kind: 'player', name: row.name,
      position: row.position || null, rawValue: value,
    });
  }

  return { source: 'ktc', assets, unmatched, unmatchedNames };
}
