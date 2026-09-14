/**
 * Player identity crosswalk.
 *
 * Everything in this app is keyed on Sleeper player IDs, because that is the
 * one ID we are guaranteed to have (it comes off the user's league). Each
 * value source speaks a different dialect:
 *
 *   FantasyCalc     -> ships sleeperId directly (easy)
 *   DynastyProcess  -> ships fp_id (FantasyPros)
 *   KeepTradeCut    -> ships its own ktc id, and sometimes only a name
 *
 * DynastyProcess publishes db_playerids.csv, which maps all of these to each
 * other in a single file. That file is the backbone of this module.
 */

const CROSSWALK_URL =
  'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';

const NA = new Set(['', 'NA', 'NULL', 'na', 'null', 'None']);
const clean = (v) => (v == null || NA.has(String(v).trim()) ? null : String(v).trim());

/**
 * Normalize a player name into a match key.
 * Strips punctuation, suffixes and casing so "Marvin Harrison Jr." and
 * "marvin harrison jr" collapse to the same key.
 */
export function nameKey(name) {
  if (!name) return null;
  let s = String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[.'`’]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop generational suffixes; they are inconsistently present across sources.
  s = s.replace(/\s+(jr|sr|ii|iii|iv|v)$/g, '');
  return s || null;
}

/**
 * Minimal RFC4180-ish CSV parser. Handles quoted fields and embedded commas,
 * which db_playerids.csv does contain (college names, etc).
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

/**
 * Fetch and index the crosswalk. Returns lookup tables in every direction we
 * need, plus the raw per-player records (used for age/position fallbacks).
 */
export async function buildCrosswalk(fetchImpl = fetch) {
  const res = await fetchImpl(CROSSWALK_URL);
  if (!res.ok) throw new Error(`crosswalk fetch failed: ${res.status}`);
  const rows = parseCsv(await res.text());

  const bySleeper = new Map();
  const ktcToSleeper = new Map();
  const fpToSleeper = new Map();
  const nameToSleeper = new Map();   // nameKey -> [sleeperId, ...]

  for (const r of rows) {
    const sleeper = clean(r.sleeper_id);
    if (!sleeper) continue;
    const rec = {
      sleeperId: sleeper,
      ktcId: clean(r.ktc_id),
      fpId: clean(r.fantasypros_id),
      mflId: clean(r.mfl_id),
      name: clean(r.name),
      position: clean(r.position),
      team: clean(r.team),
      age: r.age ? Number(r.age) : null,
      draftYear: r.draft_year ? Number(r.draft_year) : null,
    };
    bySleeper.set(sleeper, rec);
    if (rec.ktcId) ktcToSleeper.set(rec.ktcId, sleeper);
    if (rec.fpId) fpToSleeper.set(rec.fpId, sleeper);
    const nk = nameKey(rec.name);
    if (nk) {
      if (!nameToSleeper.has(nk)) nameToSleeper.set(nk, []);
      nameToSleeper.get(nk).push(sleeper);
    }
  }

  return { bySleeper, ktcToSleeper, fpToSleeper, nameToSleeper, rowCount: rows.length };
}

/**
 * Resolve a source's player to a Sleeper ID.
 *
 * Tries the strongest signal first (a direct ID), then falls back to a
 * name+position match. Position is required on the name path because name
 * collisions across positions are common (e.g. two Michael Carters).
 */
export function resolveSleeperId(xw, { sleeperId, ktcId, fpId, name, position } = {}) {
  if (sleeperId && xw.bySleeper.has(String(sleeperId))) return String(sleeperId);
  if (ktcId && xw.ktcToSleeper.has(String(ktcId))) return xw.ktcToSleeper.get(String(ktcId));
  if (fpId && xw.fpToSleeper.has(String(fpId))) return xw.fpToSleeper.get(String(fpId));

  const nk = nameKey(name);
  if (!nk) return null;
  const candidates = xw.nameToSleeper.get(nk);
  if (!candidates || !candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // Ambiguous name: disambiguate on position, then prefer the youngest
  // (rookies share names with retired players surprisingly often).
  if (position) {
    const pos = String(position).toUpperCase();
    const samePos = candidates.filter((id) => (xw.bySleeper.get(id)?.position || '').toUpperCase() === pos);
    if (samePos.length === 1) return samePos[0];
    if (samePos.length > 1) return pickYoungest(xw, samePos);
  }
  return pickYoungest(xw, candidates);
}

function pickYoungest(xw, ids) {
  let best = ids[0], bestAge = Infinity;
  for (const id of ids) {
    const a = xw.bySleeper.get(id)?.age;
    if (a != null && a < bestAge) { bestAge = a; best = id; }
  }
  return best;
}
