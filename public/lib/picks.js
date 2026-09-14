/**
 * Rookie-pick naming is the messiest part of cross-source matching. The same
 * asset shows up as "2027 1st", "2027 Round 1", "2027 Early 1st",
 * "2027 Pick 1.01" and "2027 mid 1st" depending on who you ask.
 *
 * We canonicalize to one of two forms:
 *   "2027 1st"            - a whole round, no slot information
 *   "2027 1st (early)"    - a round plus a tier: early / mid / late
 *
 * Sources that publish exact slots (DynastyProcess ships "2026 Pick 1.01")
 * collapse into tiers, because a specific slot is not a tradeable asset in a
 * league whose draft order is not yet known. Slots 1-4 are early, 5-8 mid,
 * 9+ late in a 12-team round.
 */

const ROUND_WORDS = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };
const TIERS = ['early', 'mid', 'late'];

export function slotToTier(slot, teams = 12) {
  if (!Number.isFinite(slot)) return null;
  const third = Math.max(1, Math.round(teams / 3));
  if (slot <= third) return 'early';
  if (slot <= third * 2) return 'mid';
  return 'late';
}

export function formatPick(year, round, tier) {
  const suffix = ['', '1st', '2nd', '3rd', '4th', '5th'][round] || `${round}th`;
  return tier ? `${year} ${suffix} (${tier})` : `${year} ${suffix}`;
}

/**
 * Recognize a pick from a source's free-text name. Returns a canonical name,
 * or null if this does not look like a draft pick.
 */
export function canonicalPickName(rawName, position, teams = 12) {
  if (!rawName) return null;
  const s = String(rawName).toLowerCase().trim();
  const isPickish = position === 'PICK' || position === 'PI' ||
    /\b(pick|round|1st|2nd|3rd|4th|5th)\b/.test(s);
  if (!isPickish) return null;

  const yearMatch = s.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);

  // "2026 pick 1.01" / "2026 1.01"
  const dotted = s.match(/\b(\d)\.(\d{1,2})\b/);
  if (dotted) {
    const round = Number(dotted[1]);
    const tier = slotToTier(Number(dotted[2]), teams);
    return formatPick(year, round, tier);
  }

  let round = null;
  for (const [word, n] of Object.entries(ROUND_WORDS)) {
    if (s.includes(word)) { round = n; break; }
  }
  if (round == null) {
    const r = s.match(/round\s*(\d)/) || s.match(/\br(\d)\b/);
    if (r) round = Number(r[1]);
  }
  if (round == null) return null;

  const tier = TIERS.find((t) => s.includes(t)) || null;
  return formatPick(year, round, tier);
}

/**
 * Picks described with a tier and picks described without one are the same
 * market. When blending we want them comparable, so we expose the "round-level"
 * key for a canonical pick name.
 */
export function pickRoundKey(canonical) {
  const m = String(canonical).match(/^(20\d{2})\s+(\d(?:st|nd|rd|th))/);
  return m ? `${m[1]} ${m[2]}` : canonical;
}
