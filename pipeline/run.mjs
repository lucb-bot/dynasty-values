#!/usr/bin/env node
/**
 * Nightly pipeline. Runs on the Mac mini.
 *
 * Does every expensive thing - fetching, scraping, crosswalking, blending,
 * trend math - then POSTs finished boards to the Worker, which just stores and
 * serves them. This split exists because Cloudflare's free plan allows only
 * 10ms of CPU per Worker invocation, cron triggers included; none of the work
 * below fits in that budget, and it does not need to.
 *
 * Usage:
 *   node pipeline/run.mjs                 # all configured formats
 *   node pipeline/run.mjs --dry-run       # compute but do not publish
 *   node pipeline/run.mjs --no-ktc        # skip the KTC collector
 *   node pipeline/run.mjs --format sf-12tm-1ppr
 *
 * Config comes from pipeline/config.json (copy config.example.json).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCrosswalk } from '../public/lib/crosswalk.js';
import { blendSources } from '../public/lib/blend.js';
import { annotateTrends } from '../public/lib/history.js';
import { loadFantasyCalc } from './sources/fantasycalc.js';
import { loadDynastyProcess } from './sources/dynastyprocess.js';
import { parseKtcPayload } from './sources/ktc.js';
import { scrapeKtc } from './ktc-scrape.mjs';
import { buildHistory, changeOver } from './backfill-history.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HISTORY_DIR = path.join(ROOT, '.history');
const PIPELINE_VERSION = '1.0.0';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

function parseFormatKey(key) {
  const m = String(key).match(/^(sf|1qb)-(\d+)tm-([\d.]+)ppr$/);
  if (!m) throw new Error(`bad format key: ${key}`);
  return { superflex: m[1] === 'sf', teams: Number(m[2]), ppr: Number(m[3]) };
}
const formatKey = ({ superflex, teams, ppr }) => `${superflex ? 'sf' : '1qb'}-${teams}tm-${ppr}ppr`;

/**
 * Config comes from pipeline/config.json when running locally, or from
 * environment variables when running in CI (GitHub Actions), where the ingest
 * token lives in repository secrets rather than on disk. Env always wins, so a
 * committed config.json can never override a secret.
 */
async function loadConfig() {
  const fromEnv = {
    workerUrl: process.env.WORKER_URL,
    ingestToken: process.env.INGEST_TOKEN,
    formats: process.env.FORMATS ? process.env.FORMATS.split(',').map((x) => x.trim()) : null,
    weights: process.env.WEIGHTS ? JSON.parse(process.env.WEIGHTS) : null,
  };

  let fromFile = {};
  try {
    fromFile = JSON.parse(await fs.readFile(path.join(HERE, 'config.json'), 'utf8'));
  } catch {
    if (!fromEnv.workerUrl || !fromEnv.ingestToken) {
      throw new Error(
        'No config found. Either copy pipeline/config.example.json to pipeline/config.json, ' +
        'or set WORKER_URL and INGEST_TOKEN in the environment.'
      );
    }
  }

  const cfg = {
    ...fromFile,
    ...Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v != null)),
  };
  if (!cfg.workerUrl) throw new Error('config: workerUrl is required');
  if (!cfg.ingestToken) throw new Error('config: ingestToken is required');
  if (!cfg.formats?.length) cfg.formats = ['*-*tm-*ppr'];
  // Strip the documentation keys from config.example.json.
  for (const k of Object.keys(cfg)) if (k.startsWith('_comment')) delete cfg[k];
  return cfg;
}

/** Dated board snapshots on local disk, used for 7/30-day trends. */
async function loadHistory(key) {
  try {
    const files = await fs.readdir(path.join(HISTORY_DIR, key));
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.json')).sort().slice(-45)) {
      const values = JSON.parse(await fs.readFile(path.join(HISTORY_DIR, key, f), 'utf8'));
      out.push({ date: f.replace('.json', ''), values });
    }
    return out;
  } catch { return []; }
}

async function saveHistory(key, assets) {
  const dir = path.join(HISTORY_DIR, key);
  await fs.mkdir(dir, { recursive: true });
  const values = {};
  for (const a of assets) values[a.id] = a.value;
  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(dir, `${today}.json`), JSON.stringify(values));

  // Prune beyond 45 days so this never grows without bound.
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 45))) {
    await fs.unlink(path.join(dir, f)).catch(() => {});
  }
}

/** Read back the history we published last night, so runs are incremental. */
async function fetchPublishedHistory(cfg, key) {
  try {
    const res = await fetch(new URL(`/api/history?qb=${key}`, cfg.workerUrl), {
      headers: { authorization: `Bearer ${cfg.ingestToken}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.dates?.length ? j : null;
  } catch { return null; }
}

async function publishHistory(cfg, key, history) {
  const res = await fetch(new URL('/api/ingest/history', cfg.workerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.ingestToken}` },
    body: JSON.stringify({ qb: key, history }),
  });
  if (!res.ok) throw new Error(`history publish ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function publish(cfg, key, board, sources) {
  const res = await fetch(new URL('/api/ingest/board', cfg.workerUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.ingestToken}`,
    },
    body: JSON.stringify({ format: key, board, sources, pipelineVersion: PIPELINE_VERSION }),
  });
  if (!res.ok) throw new Error(`publish failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const dpCache = new Map();
async function cachedDp(format, xw) {
  const k = format.superflex ? 'sf' : '1qb';
  if (!dpCache.has(k)) dpCache.set(k, loadDynastyProcess(format, xw));
  return dpCache.get(k);
}

/** Expand a config entry like "sf-*tm-*ppr" into every common league shape. */
function expandFormats(entries) {
  const TEAMS = [8, 10, 12, 14, 16];
  const PPR = [0, 0.5, 1];
  const out = new Set();
  for (const e of entries) {
    if (!e.includes('*')) { out.add(e); continue; }
    const m = String(e).match(/^(sf|1qb|\*)-(\d+|\*)tm-([\d.]+|\*)ppr$/);
    if (!m) throw new Error(`bad format pattern: ${e}`);
    const qbs = m[1] === '*' ? ['1qb', 'sf'] : [m[1]];
    const teams = m[2] === '*' ? TEAMS : [Number(m[2])];
    const pprs = m[3] === '*' ? PPR : [Number(m[3])];
    for (const q of qbs) for (const t of teams) for (const p of pprs) out.add(`${q}-${t}tm-${p}ppr`);
  }
  return [...out];
}

async function main() {
  const cfg = await loadConfig();
  const dryRun = has('--dry-run');
  const skipKtc = has('--no-ktc');
  const only = argOf('--format');
  const formats = expandFormats(only ? [only] : cfg.formats).map(parseFormatKey);

  console.log(`[pipeline] ${new Date().toISOString()}  v${PIPELINE_VERSION}`);
  console.log(`[pipeline] ${formats.length} format${formats.length === 1 ? '' : 's'} to publish`);
  console.log('[crosswalk] fetching db_playerids.csv ...');
  const xw = await buildCrosswalk();
  console.log(`[crosswalk] ${xw.bySleeper.size} sleeper ids, ${xw.ktcToSleeper.size} ktc ids`);

  // KTC is scraped once per QB format, not once per full format key - it has no
  // team-count or PPR dimension.
  const ktcByQb = new Map();
  if (!skipKtc) {
    for (const sf of new Set(formats.map((f) => f.superflex))) {
      try {
        const { assets, rowCount, usedMarker } = await scrapeKtc({ superflex: sf });
        console.log(`[ktc] ${sf ? 'superflex' : '1QB'}: ${assets.length} assets from ${rowCount} rows (marker: ${usedMarker})`);
        ktcByQb.set(sf, assets);
      } catch (e) {
        console.warn(`[ktc] FAILED (${sf ? 'sf' : '1qb'}): ${e.message}`);
        if (e.diagnostics) {
          console.warn('[ktc] diagnostics:');
          for (const [k, v] of Object.entries(e.diagnostics)) {
            console.warn(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
          }
        }
        console.warn('[ktc] continuing without KTC - the blend will use the remaining sources');
      }
    }
  }

  // Long-horizon history, once per QB type (DynastyProcess has no team/PPR
  // dimension). This is what powers the player charts and the 90-day and
  // one-year trajectory reasoning.
  const historyByQb = new Map();
  for (const sf of new Set(formats.map((f) => f.superflex))) {
    const key = sf ? 'sf' : '1qb';
    try {
      const existing = await fetchPublishedHistory(cfg, key);
      console.log(`[history] ${key}:`);
      const built = await buildHistory(sf, xw, { existing, log: console.log });
      console.log(`[history] ${key}: ${built.dates.length} weekly points, ` +
                  `${Object.keys(built.series).length} players, ` +
                  `${built.dates[0] ?? '-'} -> ${built.dates[built.dates.length - 1] ?? '-'}`);
      historyByQb.set(sf, built);
      if (!dryRun) await publishHistory(cfg, key, built);
    } catch (e) {
      console.warn(`[history] ${key} FAILED: ${e.message}`);
    }
  }

  const published = [];
  for (const format of formats) {
    const key = formatKey(format);
    console.log(`\n[format] ${key}`);
    const results = [];
    const sourceMeta = [];

    for (const [name, loader] of [
      ['fantasycalc', () => loadFantasyCalc(format, xw)],
      // DynastyProcess has no team-count or PPR dimension, so its CSVs are
      // fetched once per QB-type and reused across every format that shares it.
      ['dynastyprocess', () => cachedDp(format, xw)],
    ]) {
      try {
        const r = await loader();
        console.log(`  [${name}] ${r.assets.length} assets, ${r.unmatched} unmatched`);
        results.push(r);
        sourceMeta.push({ source: name, assets: r.assets.length, unmatched: r.unmatched,
                          fetchedAt: r.fetchedAt, scrapeDate: r.scrapeDate ?? null });
      } catch (e) {
        console.warn(`  [${name}] FAILED: ${e.message}`);
        sourceMeta.push({ source: name, error: e.message });
      }
    }

    const ktcRaw = ktcByQb.get(format.superflex);
    if (ktcRaw) {
      const r = parseKtcPayload(ktcRaw, xw);
      console.log(`  [ktc] ${r.assets.length} assets, ${r.unmatched} unmatched`);
      if (r.unmatched) console.log(`        unmatched sample: ${r.unmatchedNames.slice(0, 6).join(', ')}`);
      results.push(r);
      sourceMeta.push({ source: 'ktc', assets: r.assets.length, unmatched: r.unmatched,
                        fetchedAt: new Date().toISOString() });
    }

    // A source that returns a handful of assets must not reach the blend.
    // Ranks are assigned within each source, so a 3-asset source would have its
    // best asset priced as the most valuable asset in dynasty football.
    const MIN_ASSETS = 50;
    const usable = results.filter((r) => {
      if (r.assets.length >= MIN_ASSETS) return true;
      console.warn(`  [${r.source}] EXCLUDED: only ${r.assets.length} assets (minimum ${MIN_ASSETS})`);
      const meta = sourceMeta.find((m) => m.source === r.source);
      if (meta) meta.excluded = `only ${r.assets.length} assets`;
      return false;
    });
    if (!usable.length) { console.warn('  no usable sources; skipping'); continue; }
    const results_ = usable;

    const board = blendSources(results_, { weights: cfg.weights });
    const history = await loadHistory(key);
    annotateTrends(board.assets, history);

    // Real long-horizon moves, from DynastyProcess's weekly archive.
    const long = historyByQb.get(format.superflex);
    if (long) {
      let covered = 0;
      for (const a of board.assets) {
        const row = long.series[a.id];
        if (!row) continue;
        const d90 = changeOver(long.dates, row, 90);
        const d365 = changeOver(long.dates, row, 365);
        if (d90) { a.delta90 = d90.delta; a.pct90 = Number(d90.pct?.toFixed(4)); }
        if (d365) { a.delta365 = d365.delta; a.pct365 = Number(d365.pct?.toFixed(4)); }

        // The archive is weekly, so it also gives a real 30-day number. Prefer
        // it over FantasyCalc's own trend field, which measures a different
        // thing from the blend shown everywhere else on the page. Our nightly
        // snapshots still win once they are deep enough, since they track the
        // blend exactly.
        if (!a.trendBasis30 || a.trendBasis30 === 'fantasycalc30d') {
          const d30 = changeOver(long.dates, row, 30);
          if (d30) {
            a.delta30 = d30.delta;
            a.pct30 = Number(d30.pct?.toFixed(4));
            a.trendBasis30 = `archive:${d30.days}d`;
          }
        }
        if (d90 || d365) covered++;
      }
      console.log(`  [history] ${covered} assets carry long-horizon trend`);
    }

    const withTrend = board.assets.filter((a) => a.delta30 != null).length;
    console.log(`  [blend] ${board.assets.length} assets from ${results_.length} sources; ` +
                `${withTrend} with 30d trend; history depth ${history.length}d`);
    console.log('  [top5] ' + board.assets.slice(0, 5).map((a) => `${a.name} ${a.value}`).join(' | '));

    await saveHistory(key, board.assets);

    if (dryRun) {
      const out = path.join(ROOT, `.dryrun-${key}.json`);
      await fs.writeFile(out, JSON.stringify(board, null, 2));
      console.log(`  [dry-run] wrote ${out}`);
    } else {
      const r = await publish(cfg, key, board, sourceMeta);
      console.log(`  [publish] ok - ${r.assetCount} assets live`);
      published.push(key);
    }
  }

  console.log(`\n[pipeline] done. ${dryRun ? 'dry run' : `published: ${published.join(', ') || 'nothing'}`}`);
}

main().catch((e) => { console.error('[pipeline] fatal:', e); process.exit(1); });
