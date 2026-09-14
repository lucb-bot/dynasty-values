/**
 * Positional aging curves.
 *
 * Dynasty value is mostly a bet on remaining production, so age matters
 * differently by position. These bands are the widely used dynasty consensus
 * shape: running backs fall off a cliff, wide receivers decline gently, tight
 * ends peak late, quarterbacks hold value for a decade.
 *
 * They are heuristics for FLAGGING candidates, not predictions. The UI always
 * shows the age alongside the label so you can disagree with it.
 */
const BANDS = {
  RB: { ascending: 23, peak: 26, declining: 28 },
  WR: { ascending: 24, peak: 28, declining: 30 },
  TE: { ascending: 25, peak: 29, declining: 31 },
  QB: { ascending: 26, peak: 33, declining: 36 },
};

export function ageStage(position, age) {
  if (!Number.isFinite(age)) return 'unknown';
  const b = BANDS[String(position || '').toUpperCase()];
  if (!b) return 'unknown';
  if (age < b.ascending) return 'ascending';
  if (age <= b.peak) return 'peak';
  if (age <= b.declining) return 'declining';
  return 'cliff';
}

/** Rough share of a player's dynasty value still ahead of them. */
export function remainingWindow(position, age) {
  const stage = ageStage(position, age);
  return { ascending: 1, peak: 0.8, declining: 0.5, cliff: 0.28, unknown: 0.7 }[stage];
}

export const AGE_BANDS = BANDS;
