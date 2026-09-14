/**
 * Sleeper API client, used directly from the browser.
 *
 * Sleeper's API is read-only, needs no key, and sends permissive CORS headers,
 * so the page calls it itself. That keeps rosters live-to-the-second instead of
 * as stale as last night's pipeline run, and costs the Worker nothing.
 *
 * Note there is no write access anywhere in Sleeper's API - this app can value
 * a trade but can never submit one.
 */

const BASE = 'https://api.sleeper.app/v1';

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sleeper ${res.status} on ${path}`);
  return res.json();
}

export const getUser = (username) => get(`/user/${encodeURIComponent(username)}`);
export const getLeagues = (userId, season) => get(`/user/${userId}/leagues/nfl/${season}`);
export const getLeague = (leagueId) => get(`/league/${leagueId}`);
export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getLeagueUsers = (leagueId) => get(`/league/${leagueId}/users`);
export const getTradedPicks = (leagueId) => get(`/league/${leagueId}/traded_picks`);
export const getState = () => get('/state/nfl');

/**
 * Derive the value format from the league's own settings, so the user never has
 * to tell us whether they play superflex.
 *
 * Superflex detection: a SUPER_FLEX slot, or two or more dedicated QB slots.
 * Both are real ways leagues start multiple QBs, and both change QB values
 * dramatically - getting this wrong is the single biggest way a dynasty value
 * tool can be silently, badly incorrect.
 */
export function detectFormat(league) {
  const slots = league?.roster_positions || [];
  const qbSlots = slots.filter((s) => s === 'QB').length;
  const hasSuperflex = slots.includes('SUPER_FLEX') || slots.includes('SUPERFLEX');
  const superflex = hasSuperflex || qbSlots >= 2;

  const rec = Number(league?.scoring_settings?.rec ?? 1);
  const ppr = rec >= 0.75 ? 1 : rec >= 0.25 ? 0.5 : 0;

  const teams = Number(league?.total_rosters) || 12;

  // TE premium shifts TE values but no source exposes it as a parameter; we
  // surface it so the UI can warn rather than silently mislead.
  const teBonus = Number(league?.scoring_settings?.bonus_rec_te ?? 0);

  return { superflex, teams, ppr, teBonus, qbSlots, hasSuperflex };
}

export function formatKey({ superflex, teams, ppr }) {
  return `${superflex ? 'sf' : '1qb'}-${Math.round(teams)}tm-${ppr}ppr`;
}

/**
 * Turn Sleeper's traded-pick records into the canonical pick names the value
 * board uses ("2027 1st"), grouped by the roster that currently owns them.
 *
 * Sleeper only tracks picks that have CHANGED HANDS. Every roster also owns its
 * own untraded picks for each future season, so we synthesize those and then
 * apply the trades on top.
 */
export function resolvePickOwnership(tradedPicks, rosters, seasons, roundsPerDraft = 4) {
  const owned = new Map();            // rosterId -> Map(canonicalName -> count)
  const add = (rosterId, name, n = 1) => {
    if (!owned.has(rosterId)) owned.set(rosterId, new Map());
    const m = owned.get(rosterId);
    m.set(name, (m.get(name) || 0) + n);
  };
  const remove = (rosterId, name) => {
    const m = owned.get(rosterId);
    if (!m) return;
    const n = (m.get(name) || 0) - 1;
    if (n > 0) m.set(name, n); else m.delete(name);
  };

  const label = (season, round) => {
    const suffix = ['', '1st', '2nd', '3rd', '4th', '5th'][round] || `${round}th`;
    return `${season} ${suffix}`;
  };

  for (const r of rosters) {
    for (const season of seasons) {
      for (let round = 1; round <= roundsPerDraft; round++) {
        add(r.roster_id, label(season, round));
      }
    }
  }

  for (const tp of tradedPicks || []) {
    const season = Number(tp.season);
    const round = Number(tp.round);
    if (!seasons.includes(season) || round > roundsPerDraft) continue;
    const name = label(season, round);
    remove(Number(tp.roster_id), name);         // original owner loses it
    add(Number(tp.owner_id), name);             // current owner gains it
  }

  return owned;
}
