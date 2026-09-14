/**
 * Browser smoke test. Boots the real frontend against mocked Sleeper and board
 * responses, walks every tab, and fails on any console error or unhandled
 * rejection. This is the only way to catch DOM bugs in app.js.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { buildCrosswalk } from '../public/lib/crosswalk.js';
import { blendSources } from '../public/lib/blend.js';
import { annotateTrends } from '../public/lib/history.js';
import { loadDynastyProcess } from '../pipeline/sources/dynastyprocess.js';
import { localFetch, distort, fakeLeague } from './fixtures.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// ---- build a realistic board from real data -------------------------------
const xw = await buildCrosswalk(localFetch);
const dp = await loadDynastyProcess({ superflex: true, teams: 12, ppr: 1 }, xw, localFetch);
const board = blendSources([
  { source: 'dynastyprocess', assets: dp.assets },
  { source: 'fantasycalc', assets: distort(dp.assets, { scale: 8000, exponent: 1.6, swaps: [[3, 30], [12, 55]] }) },
  { source: 'ktc', assets: distort(dp.assets, { scale: 120, exponent: 0.8, swaps: [[7, 44], [2, 60]] }) },
]);
// give FantasyCalc trend data so the movers view has something to show
for (const a of board.assets) {
  if (a.sources.fantasycalc) a.sources.fantasycalc.trend30 = Math.round((Math.random() - 0.45) * a.value * 0.2);
}
annotateTrends(board.assets, []);
const { rosters } = fakeLeague(board);
// Two years of weekly history, shaped like the real DynastyProcess archive.
const dates = [];
for (let i = 103; i >= 0; i--) {
  const d = new Date(Date.now() - i * 7 * 86400000);
  dates.push(d.toISOString().slice(0, 10));
}
const series = {};
for (const a of board.assets.slice(0, 200)) {
  let v = a.value * (0.7 + Math.random() * 0.4);
  series[a.id] = dates.map((_, i) => {
    v += (a.value - v) * 0.06 + (Math.random() - 0.5) * a.value * 0.03;
    // leave occasional gaps, as the real archive has
    return i % 17 === 5 ? null : Math.round(Math.max(1, v));
  });
}
const historyPayload = { dates, series, builtAt: new Date().toISOString(), snapshotCount: dates.length };

// long-horizon deltas, as the pipeline bakes in
for (const a of board.assets) {
  const row = series[a.id];
  if (!row) continue;
  const first = row.find((x) => x != null), last = [...row].reverse().find((x) => x != null);
  if (first && last) { a.delta365 = last - first; a.pct365 = Number(((last - first) / first).toFixed(4)); }
  const q = row[row.length - 13];
  if (q && last) { a.delta90 = last - q; a.pct90 = Number(((last - q) / q).toFixed(4)); }
}

const boardPayload = { format: 'sf-12tm-1ppr', publishedAt: new Date().toISOString(),
  sources: [{ source: 'ktc', assets: 450 }, { source: 'fantasycalc', assets: 460 }, { source: 'dynastyprocess', assets: 439 }],
  curve: board.curve, assets: board.assets };

// ---- static server --------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- drive the browser ----------------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const users = rosters.map((r, i) => ({
  user_id: r.owner_id, display_name: `Manager ${i + 1}`,
  metadata: { team_name: `Team ${i + 1}` },
}));

await page.route('**/*', async (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  if (url.includes('/api/board')) {
    return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'x-board-format': 'sf-12tm-1ppr' }, body: JSON.stringify(boardPayload) });
  }
  if (url.includes('/api/history')) return json(historyPayload);
  if (url.includes('/api/analyze')) {
    return json({ text: 'You sit 4th of 12 by total value.\n\nYour weakest slot is TE.\n\nPackage your benched RBs.', model: '@cf/meta/llama-3.1-8b-instruct' });
  }
  if (url.includes('api.sleeper.app')) {
    if (url.includes('/state/nfl')) return json({ league_season: '2026' });
    if (url.match(/\/user\/[^/]+$/)) return json({ user_id: 'user1', display_name: 'luc' });
    if (url.includes('/leagues/nfl/')) return json([
      { league_id: 'L1', name: 'The Dynasty League', total_rosters: 12,
        season: '2026', roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'SUPER_FLEX'],
        scoring_settings: { rec: 1 } },
      { league_id: 'L2', name: 'Second Account League', total_rosters: 10,
        season: '2026', roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX'],
        scoring_settings: { rec: 0.5 } },
    ]);
    if (url.match(/\/league\/L1$/)) return json({
      league_id: 'L1', name: 'The Dynasty League', total_rosters: 12, season: '2026',
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'SUPER_FLEX'],
      scoring_settings: { rec: 1 },
    });
    if (url.match(/\/league\/L2$/)) return json({
      league_id: 'L2', name: 'Second Account League', total_rosters: 10, season: '2026',
      roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX'], scoring_settings: { rec: 0.5 },
    });
    if (url.includes('/rosters')) return json(rosters);
    if (url.includes('/users')) return json(users);
    if (url.includes('/traded_picks')) return json([{ season: '2027', round: 1, roster_id: 3, owner_id: 1 }]);
    return json({});
  }
  return route.continue();
});

const shots = path.join(ROOT, '.shots');
fs.mkdirSync(shots, { recursive: true });
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };

await page.goto(origin, { waitUntil: 'networkidle' });

// --- setup flow
await page.fill('#username', 'luc');
await page.click('#find-leagues');
await page.waitForSelector('.leagues li', { timeout: 5000 });
console.log('setup: league list rendered');
await page.click('.leagues li');
await page.waitForSelector('#app:not([hidden])', { timeout: 8000 });
await page.waitForSelector('.stat', { timeout: 8000 });
console.log('app booted, roster view rendered');

const chip = await page.textContent('#league-chip');
if (!chip.includes('SF')) fail(`superflex not detected in chip: ${chip}`);
console.log('league chip:', chip.trim());

// --- walk every tab
for (const view of ['roster', 'trade', 'league', 'movers', 'board']) {
  await page.click(`nav.tabs button[data-view="${view}"]`);
  await page.waitForTimeout(400);
  const cards = await page.locator('#view .card, #view .empty').count();
  if (!cards) fail(`${view} view rendered nothing`);
  const notice = await page.locator('#view .notice').allTextContents();
  if (notice.some((n) => n.startsWith('Render failed'))) fail(`${view}: ${notice.join(' ')}`);
  await page.screenshot({ path: path.join(shots, `${view}.png`), fullPage: view !== 'board' });
  console.log(`  ${view}: ${cards} blocks rendered`);
}

// --- exercise the trade calculator for real
await page.click('nav.tabs button[data-view="trade"]');
await page.waitForTimeout(250);
const inputs = page.locator('.side input[type=search]');
await inputs.nth(0).fill('Chase');
await page.waitForSelector('.search-results li', { timeout: 3000 });
await page.locator('.search-results li').first().click();
await page.waitForTimeout(200);
await inputs.nth(1).fill('Allen');
await page.waitForSelector('.search-results li', { timeout: 3000 });
await page.locator('.search-results li').first().click();
await page.waitForTimeout(300);
const verdictText = await page.textContent('.verdict');
if (!/win|lose|Even/i.test(verdictText)) fail(`no verdict produced: ${verdictText}`);
const srcTable = await page.locator('.card', { hasText: 'How each source sees it' }).count();
if (!srcTable) fail('per-source breakdown missing');
console.log('trade calculator: verdict =', verdictText.replace(/\s+/g, ' ').trim().slice(0, 80));
await page.screenshot({ path: path.join(shots, 'trade-filled.png'), fullPage: true });

// --- roster suggestions must actually appear with reasoning
await page.click('nav.tabs button[data-view="roster"]');
await page.waitForTimeout(400);
const reasons = await page.locator('.reasons li').count();
const ideas = await page.locator('.idea').count();
console.log(`roster suggestions: ${reasons} reasons, ${ideas} trade ideas`);
if (reasons === 0) fail('no suggestion reasoning rendered');

// --- player detail modal: chart, per-source table, long-horizon trends
await page.click('nav.tabs button[data-view="roster"]');
await page.waitForTimeout(400);
const slotRows = await page.locator('.card', { hasText: 'Your starting lineup' }).locator('tbody tr').count();
if (!slotRows) fail('starting lineup table did not render');
console.log(`starting lineup: ${slotRows} slots analysed`);

await page.locator('.card', { hasText: 'Your roster' }).locator('tbody tr').first().click();
await page.waitForSelector('.modal', { timeout: 5000 });
await page.waitForSelector('.vchart, .modal .empty', { timeout: 8000 });
const hasChart = await page.locator('.modal .vchart').count();
if (!hasChart) fail('player modal rendered no history chart');
const pathLen = await page.locator('.modal .vchart-line').getAttribute('d');
if (!pathLen || pathLen.length < 50) fail('history chart path looks empty');
const srcRows = await page.locator('.modal tbody tr').count();
if (srcRows !== 3) fail(`expected 3 source rows in the modal, got ${srcRows}`);
console.log('player modal: chart + per-source breakdown rendered');

// hovering must produce a tooltip
const chartBox = await page.locator('.modal .vchart').boundingBox();
await page.mouse.move(chartBox.x + chartBox.width * 0.5, chartBox.y + chartBox.height * 0.5);
await page.waitForTimeout(250);
const tipVisible = await page.locator('.modal .chart-tip').isVisible();
if (!tipVisible) fail('chart tooltip did not appear on hover');
console.log('chart hover tooltip works');
await page.screenshot({ path: path.join(shots, 'player-modal.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
if (await page.locator('.modal').count()) fail('Escape did not close the modal');

// --- suggestion quality: every reason must carry a figure
const reasonTexts = await page.locator('.card', { hasText: 'Suggested moves' }).locator('.reasons li').allTextContents();
console.log(`suggestions: ${reasonTexts.length} reasons`);
for (const t of reasonTexts) {
  if (!/\d/.test(t)) fail(`reason has no number in it: "${t}"`);
  if (/in his prime window|bottom-third at/i.test(t)) fail(`blanket reasoning came back: "${t}"`);
}
if (reasonTexts.length) console.log('  sample:', reasonTexts[0].slice(0, 110));

// --- AI summary panel
await page.locator('.card', { hasText: 'Written summary' }).getByRole('button', { name: /write a summary/i }).click();
await page.waitForSelector('.ai-body', { timeout: 8000 });
const aiText = await page.locator('.ai-body').textContent();
if (!aiText || aiText.length < 20) fail('AI summary did not render');
const aiNote = await page.locator('.ai-note').textContent();
if (!/knows nothing about the current/i.test(aiNote)) fail('AI limitations note missing');
console.log('AI panel rendered with its limitations disclosed');

// --- multi-league switcher: the header must offer both leagues and switch cleanly
const sel = page.locator('.league-select');
if (await sel.count() !== 1) fail('league switcher not rendered for a 2-league account');
const options = await sel.locator('option').allTextContents();
if (options.length !== 2) fail(`switcher shows ${options.length} leagues, expected 2`);
console.log('league switcher offers:', options.join(' | '));
await sel.selectOption('L2');
await page.waitForSelector('.stat', { timeout: 8000 });
const chip2 = await page.textContent('#league-chip');
if (!chip2.includes('10tm') || !chip2.includes('1QB') || !chip2.includes('half')) {
  fail(`switching leagues did not re-detect the format: ${chip2}`);
}
console.log('after switch, format re-detected:', chip2.replace(/\s+/g, ' ').trim());

// --- mobile layout
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
if (scrollW > 400) fail(`horizontal overflow at 390px: scrollWidth=${scrollW}`);
await page.screenshot({ path: path.join(shots, 'mobile-roster.png'), fullPage: true });
console.log('mobile 390px: no horizontal overflow');

// --- dark mode render
await ctx.close();
const dark = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 900 } });
const dpage = await dark.newPage();
dpage.on('pageerror', (e) => errors.push(`dark pageerror: ${e.message}`));
await dpage.route('**/*', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('/api/board')) return json(boardPayload);
  if (url.includes('api.sleeper.app')) {
    if (url.match(/\/league\/L1$/)) return json({ league_id: 'L1', name: 'The Dynasty League', total_rosters: 12, season: '2026', roster_positions: ['QB','RB','WR','SUPER_FLEX'], scoring_settings: { rec: 1 } });
    if (url.includes('/rosters')) return json(rosters);
    if (url.includes('/users')) return json(users);
    if (url.includes('/traded_picks')) return json([]);
    return json({});
  }
  return route.continue();
});
await dpage.addInitScript(() => localStorage.setItem('dvb.settings.v1', JSON.stringify({ username: 'luc', userId: 'user1', leagueId: 'L1' })));
await dpage.goto(origin, { waitUntil: 'networkidle' });
await dpage.waitForSelector('.stat', { timeout: 8000 });
await dpage.screenshot({ path: path.join(shots, 'dark-roster.png'), fullPage: true });
console.log('dark mode rendered');

await browser.close();
server.close();

if (errors.length) {
  console.error('\nCONSOLE/PAGE ERRORS:');
  for (const e of errors) console.error('  ' + e);
  process.exitCode = 1;
} else {
  console.log('\nno console or page errors');
}
console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
