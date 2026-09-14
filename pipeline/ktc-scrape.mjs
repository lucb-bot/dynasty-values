/**
 * KeepTradeCut collector - runs on YOUR machine, never on Cloudflare.
 *
 * Why it lives here and not in the Worker:
 *   - KTC's terms forbid scraping and forbid republishing their values. Running
 *     this on your own machine, behind your own login-gated site, for your own
 *     league keeps the blast radius to you. Nothing is ever redistributed.
 *   - Datacenter IP ranges (Cloudflare's, GitHub Actions') are widely blocked
 *     and shared with other people. A residential IP is both likelier to work
 *     and the version of this tradeoff you actually chose.
 *
 * KTC embeds its board as a JavaScript array in the rankings page HTML. There is
 * no documented shape and it has changed before, so we try several extraction
 * strategies and fail loudly with a diagnostic rather than silently returning
 * garbage. If this breaks, it is the first place to look.
 */

const RANKINGS_URL = 'https://keeptradecut.com/dynasty-rankings';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Pull the first balanced JS array literal following a marker. */
function extractArrayAfter(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const open = html.indexOf('[', start);
  if (open === -1) return null;
  let depth = 0, inStr = null, esc = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  return null;
}

const MARKERS = ['playersArray', 'var players =', 'window.playersArray', 'playerDataArray'];

export function parseKtcHtml(html) {
  let raw = null, usedMarker = null;
  for (const m of MARKERS) {
    raw = extractArrayAfter(html, m);
    if (raw) { usedMarker = m; break; }
  }
  if (!raw) {
    throw new Error(
      'Could not find the player array in KTC HTML. Their page structure likely changed. ' +
      'Markers tried: ' + MARKERS.join(', ')
    );
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // The embedded literal is JS, not strict JSON (unquoted keys, single quotes).
    // eslint-disable-next-line no-new-func
    data = Function(`"use strict"; return (${raw});`)();
  }
  if (!Array.isArray(data) || !data.length) throw new Error('KTC array parsed but empty');
  return { data, usedMarker };
}

/** Normalize one KTC record into the ingest contract, for a given QB format. */
function toAsset(row, superflex) {
  const bucket = superflex
    ? (row.superflexValues || row.sfValues || row.superflex || null)
    : (row.oneQBValues || row.qbValues || row.onequb || null);

  const value = Number(
    bucket?.value ?? bucket?.val ?? (superflex ? row.sfValue : row.value)
  );
  if (!Number.isFinite(value) || value <= 0) return null;

  return {
    ktcId: row.playerID != null ? String(row.playerID) : (row.id != null ? String(row.id) : null),
    name: row.playerName || row.name || row.player || null,
    position: (row.position || row.pos || '').toUpperCase() || null,
    team: row.team || null,
    value,
  };
}

/**
 * Describe what we actually got, so a partial parse is diagnosable without
 * being able to reach the site directly. A silent partial parse is the
 * dangerous failure here: a source contributing three assets still looks like
 * a working source, and its top asset would be normalized as if it were the
 * best player in dynasty football.
 */
export function diagnose(data, superflex) {
  const keys = new Map();
  for (const row of data.slice(0, 200)) {
    for (const k of Object.keys(row || {})) keys.set(k, (keys.get(k) || 0) + 1);
  }
  const probe = (fn) => data.filter((r) => { try { return Number.isFinite(Number(fn(r))); } catch { return false; } }).length;
  return {
    rows: data.length,
    topLevelKeys: [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k}(${n})`),
    sampleRow: JSON.stringify(data[0] ?? null).slice(0, 400),
    valuePathHits: {
      'superflexValues.value': probe((r) => r.superflexValues?.value),
      'oneQBValues.value': probe((r) => r.oneQBValues?.value),
      'sfValues.value': probe((r) => r.sfValues?.value),
      'qbValues.value': probe((r) => r.qbValues?.value),
      'value': probe((r) => r.value),
      'sfValue': probe((r) => r.sfValue),
    },
    namePathHits: {
      playerName: data.filter((r) => r?.playerName).length,
      name: data.filter((r) => r?.name).length,
      player: data.filter((r) => r?.player).length,
    },
  };
}

export async function scrapeKtc({ superflex, fetchImpl = fetch, minAssets = 50 } = {}) {
  const res = await fetchImpl(RANKINGS_URL, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) throw new Error(`KTC returned ${res.status} (body ${(await res.text()).length} bytes)`);
  const html = await res.text();
  const { data, usedMarker } = parseKtcHtml(html);
  const diag = diagnose(data, superflex);

  const assets = data.map((r) => toAsset(r, superflex)).filter(Boolean);

  // A parse that yields a handful of assets is a FAILURE, not a thin result.
  // Blending ranks each source independently, so a three-asset source would
  // have its best asset priced as the best asset in the game.
  if (assets.length < minAssets) {
    const e = new Error(
      `KTC yielded only ${assets.length} usable ${superflex ? 'superflex' : '1QB'} assets ` +
      `from ${data.length} parsed rows (minimum ${minAssets}). Refusing to use a partial board.`
    );
    e.diagnostics = { ...diag, htmlBytes: html.length, usedMarker, usableAssets: assets.length };
    throw e;
  }
  return { assets, rowCount: data.length, usedMarker, diagnostics: diag };
}
