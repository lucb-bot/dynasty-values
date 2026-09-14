/**
 * Offline fixtures. Real DynastyProcess data is checked against locally; the
 * other two sources are synthesized from it with deliberate, known distortions
 * so tests can assert that the blend corrects for them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEVDATA = path.join(ROOT, '.devdata');

export const localFetch = async (url) => {
  const p = path.join(DEVDATA, url.split('/').pop().split('?')[0]);
  if (!fs.existsSync(p)) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => fs.readFileSync(p, 'utf8'),
           json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
};

/**
 * Build a fake source from a real one by (a) rescaling onto a totally different
 * numeric range and (b) applying a much steeper or flatter curve shape, then
 * (c) shuffling a few players' ranks. If blending is working, (a) and (b) must
 * have NO effect on the output and only (c) should move anything.
 */
export function distort(assets, { scale = 1, exponent = 1, swaps = [], seed = 1 } = {}) {
  const sorted = [...assets].sort((a, b) => b.rawValue - a.rawValue);
  const out = sorted.map((a, i) => ({
    ...a,
    rawValue: scale * Math.pow((sorted.length - i) / sorted.length, exponent),
  }));
  for (const [i, j] of swaps) {
    if (out[i] && out[j]) {
      const t = out[i].rawValue; out[i].rawValue = out[j].rawValue; out[j].rawValue = t;
    }
  }
  return out;
}

/** A synthetic 12-team league whose rosters are a snake draft of the board. */
export function fakeLeague(board, teams = 12, rosterSize = 22) {
  const players = board.assets.filter((a) => a.kind === 'player');
  const picks = board.assets.filter((a) => a.kind === 'pick');
  const rosters = Array.from({ length: teams }, (_, i) => ({
    roster_id: i + 1, owner_id: `user${i + 1}`, players: [],
    settings: { wins: (i * 3) % 14, losses: 13 - ((i * 3) % 14), ties: 0 },
  }));
  players.slice(0, teams * rosterSize).forEach((p, idx) => {
    const round = Math.floor(idx / teams);
    const slot = round % 2 === 0 ? idx % teams : teams - 1 - (idx % teams);
    rosters[slot].players.push(p.id);
  });
  return { rosters, picks };
}
