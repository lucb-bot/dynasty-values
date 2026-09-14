import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCrosswalk, nameKey, parseCsv } from '../public/lib/crosswalk.js';
import { blendSources, buildConsensusCurve } from '../public/lib/blend.js';
import { canonicalPickName, pickRoundKey } from '../public/lib/picks.js';
import { annotateTrends, pickSnapshot, movers } from '../public/lib/history.js';
import { evaluateTrade, packageValue } from '../public/lib/trade.js';
import { analyzeRoster, positionalStrength, arbitrage, tradeIdeas } from '../public/lib/suggest.js';
import { ageStage } from '../public/lib/agecurve.js';
import { detectFormat, resolvePickOwnership, formatKey } from '../public/lib/sleeper.js';
import { loadDynastyProcess } from '../pipeline/sources/dynastyprocess.js';
import { parseKtcPayload } from '../pipeline/sources/ktc.js';
import { parseKtcHtml } from '../pipeline/ktc-scrape.mjs';
import { localFetch, distort, fakeLeague } from './fixtures.mjs';

const xw = await buildCrosswalk(localFetch);
const dp = await loadDynastyProcess({ superflex: true, teams: 12, ppr: 1 }, xw, localFetch);

test('crosswalk resolves every ID dialect onto sleeper ids', () => {
  assert.ok(xw.bySleeper.size > 5000, 'crosswalk should index thousands of players');
  assert.ok(xw.ktcToSleeper.size > 300);
  assert.ok(xw.fpToSleeper.size > 3000);
  assert.equal(nameKey('Marvin Harrison Jr.'), nameKey('marvin harrison'));
  assert.equal(nameKey("Ja'Marr Chase"), 'jamarr chase');
});

test('DynastyProcess adapter matches >98% of players to sleeper ids', () => {
  const rate = dp.assets.filter(a => a.kind === 'player').length /
    (dp.assets.filter(a => a.kind === 'player').length + dp.unmatched);
  assert.ok(rate > 0.98, `match rate ${rate}`);
  assert.ok(dp.assets.some(a => a.kind === 'pick'), 'picks should be priced');
});

test('pick names canonicalize across every source dialect', () => {
  assert.equal(canonicalPickName('2026 Pick 1.01', 'PICK'), '2026 1st (early)');
  assert.equal(canonicalPickName('2027 Early 1st'), '2027 1st (early)');
  assert.equal(canonicalPickName('2028 Round 2'), '2028 2nd');
  assert.equal(canonicalPickName("Ja'Marr Chase", 'WR'), null);
  assert.equal(pickRoundKey('2027 1st (early)'), '2027 1st');
});

test('BLENDING IGNORES SCALE AND CURVE SHAPE, the whole point of the design', () => {
  const players = dp.assets.filter(a => a.kind === 'player').slice(0, 120);
  // Same ordering, wildly different scales and curve shapes.
  const steep = distort(players, { scale: 99999, exponent: 6 });
  const flat  = distort(players, { scale: 47,    exponent: 0.4 });
  const blended = blendSources([
    { source: 'ktc', assets: steep },
    { source: 'fantasycalc', assets: flat },
  ]);
  const expected = [...players].sort((a, b) => b.rawValue - a.rawValue).map(p => p.id);
  assert.deepEqual(blended.assets.map(a => a.id), expected,
    'identical orderings must produce the source ordering regardless of scale');
  assert.ok(blended.assets.every(a => a.disagreement < 1e-9),
    'identical orderings must show zero disagreement');
  assert.equal(blended.assets[0].value, 10000, 'top asset anchors at 10000');
});

test('consensus curve is monotonic and median-based', () => {
  const players = dp.assets.filter(a => a.kind === 'player').slice(0, 60);
  const ranked = [
    { ranked: distort(players, { scale: 10000, exponent: 4 }).map((a, i) => ({ ...a, rank: i + 1, scaled: a.rawValue })) },
    { ranked: distort(players, { scale: 10000, exponent: 1 }).map((a, i) => ({ ...a, rank: i + 1, scaled: a.rawValue })) },
    { ranked: distort(players, { scale: 10000, exponent: 2 }).map((a, i) => ({ ...a, rank: i + 1, scaled: a.rawValue })) },
  ];
  const curve = buildConsensusCurve(ranked);
  assert.equal(curve.length, 60);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] <= curve[i - 1], `curve must not increase at rank ${i + 1}`);
  }
});

test('disagreement surfaces exactly the players the sources rank differently', () => {
  const players = dp.assets.filter(a => a.kind === 'player').slice(0, 80);
  const base = distort(players, { scale: 10000, exponent: 2 });
  // Swap ranks 5<->40 and 10<->60 in the second source only.
  const swapped = distort(players, { scale: 500, exponent: 1, swaps: [[5, 40], [10, 60]] });
  const blended = blendSources([
    { source: 'ktc', assets: base },
    { source: 'fantasycalc', assets: swapped },
  ]);
  const top = [...blended.assets].sort((a, b) => b.rankSpread - a.rankSpread).slice(0, 4).map(a => a.id);
  const expectSwapped = [base[5].id, base[40].id, base[10].id, base[60].id];
  for (const id of expectSwapped) {
    assert.ok(top.includes(id), `swapped player ${id} should rank among the biggest disagreements`);
  }
  assert.ok(blended.assets.filter(a => a.rankSpread === 0).length > 70,
    'unswapped players should show no disagreement');
});

test('a source missing a player does not penalize that player', () => {
  const players = dp.assets.filter(a => a.kind === 'player').slice(0, 50);
  const full = distort(players, { scale: 10000, exponent: 2 });
  const partial = full.slice(0, 25);
  const b = blendSources([
    { source: 'ktc', assets: full },
    { source: 'fantasycalc', assets: partial },
  ]);
  const covered = b.assets.filter(a => a.sourceCount === 2);
  const single = b.assets.filter(a => a.sourceCount === 1);
  assert.equal(covered.length, 25);
  assert.ok(single.every(a => a.lowConfidence), 'single-source assets must be flagged');
  // Ordering must still be the shared ordering, not jumbled by coverage.
  assert.deepEqual(b.assets.slice(0, 25).map(a => a.id), full.slice(0, 25).map(a => a.id));
});

test('KTC payload parses and matches against the crosswalk', () => {
  const payload = [
    { ktcId: null, name: "Ja'Marr Chase", position: 'WR', value: 9500 },
    { ktcId: null, name: 'Josh Allen', position: 'QB', value: 9900 },
    { ktcId: null, name: '2027 1st', position: 'PICK', value: 4000 },
    { ktcId: null, name: 'Definitely Not A Real Person', position: 'WR', value: 100 },
  ];
  const r = parseKtcPayload(payload, xw);
  assert.equal(r.assets.length, 3, 'three of four resolve');
  assert.equal(r.unmatched, 1);
  assert.ok(r.assets.some(a => a.kind === 'pick' && a.id === '2027 1st'));
});

test('KTC HTML extractor survives brackets and quotes inside strings', () => {
  const html = `<script>var decoy=[1,[2]]; var playersArray = [{"playerName":"O'Brien [x]","playerID":7,"position":"WR","superflexValues":{"value":100}}]; </script>`;
  const { data } = parseKtcHtml(html);
  assert.equal(data.length, 1);
  assert.equal(data[0].playerName, "O'Brien [x]");
});

test('trade math: consolidation discount and per-source verdicts', () => {
  const mk = (n, v, srcs) => ({ id: n, name: n, value: v, position: 'WR', sources: srcs });
  const even = { ktc: { normalized: 3000 }, fantasycalc: { normalized: 3000 } };
  const three = [mk('a', 3000, even), mk('b', 3000, even), mk('c', 3000, even)];
  const one = [mk('z', 9000, { ktc: { normalized: 9000 }, fantasycalc: { normalized: 9000 } })];

  assert.equal(evaluateTrade(three, one, { decay: 0 }).favors, 'even',
    'without a consolidation discount, 3x3000 equals 1x9000');
  assert.equal(evaluateTrade(three, one).favors, 'b',
    'with the default discount, the single stud side wins');

  // Contested: KTC likes side A, the others like side B.
  const contested = evaluateTrade(
    [mk('mine', 5000, { ktc: { normalized: 7000 }, fantasycalc: { normalized: 4000 }, dynastyprocess: { normalized: 4000 } })],
    [mk('theirs', 5000, { ktc: { normalized: 4200 }, fantasycalc: { normalized: 6000 }, dynastyprocess: { normalized: 5800 } })],
  );
  assert.equal(contested.contested, true, 'sources disagreeing on the winner must be flagged');
  assert.equal(contested.sourceVerdicts.ktc.favors, 'a');
  assert.equal(contested.sourceVerdicts.fantasycalc.favors, 'b');
});

test('arbitrage compares KTC against the OTHER sources, not against itself', () => {
  const assets = [{
    id: 'x', name: 'Overpriced', position: 'WR', kind: 'player', value: 5000,
    sources: { ktc: { normalized: 8000 }, fantasycalc: { normalized: 5000 }, dynastyprocess: { normalized: 5000 } },
  }, {
    id: 'y', name: 'Underpriced', position: 'RB', kind: 'player', value: 5000,
    sources: { ktc: { normalized: 3000 }, fantasycalc: { normalized: 5000 }, dynastyprocess: { normalized: 5000 } },
  }, {
    id: 'z', name: 'Agreed', position: 'TE', kind: 'player', value: 5000,
    sources: { ktc: { normalized: 5000 }, fantasycalc: { normalized: 5000 }, dynastyprocess: { normalized: 5000 } },
  }];
  const a = arbitrage(assets);
  assert.equal(a.length, 2, 'only the two mispriced players should surface');
  assert.equal(a.find(x => x.id === 'x').direction, 'sell');
  assert.equal(a.find(x => x.id === 'y').direction, 'buy');
});

test('age stages follow positional curves', () => {
  assert.equal(ageStage('RB', 22), 'ascending');
  assert.equal(ageStage('RB', 29), 'cliff');
  assert.equal(ageStage('QB', 29), 'peak');
  assert.equal(ageStage('WR', 29), 'declining');
  assert.equal(ageStage('TE', 40), 'cliff');
  assert.equal(ageStage('WR', undefined), 'unknown');
});

test('superflex detection catches both league shapes', () => {
  assert.equal(detectFormat({ roster_positions: ['QB', 'RB', 'WR', 'SUPER_FLEX'], total_rosters: 12 }).superflex, true);
  assert.equal(detectFormat({ roster_positions: ['QB', 'QB', 'RB', 'WR'], total_rosters: 12 }).superflex, true);
  assert.equal(detectFormat({ roster_positions: ['QB', 'RB', 'WR', 'FLEX'], total_rosters: 12 }).superflex, false);
  assert.equal(detectFormat({ roster_positions: [], total_rosters: 10, scoring_settings: { rec: 0.5 } }).ppr, 0.5);
  assert.equal(formatKey({ superflex: true, teams: 12, ppr: 1 }), 'sf-12tm-1ppr');
});

test('traded picks change ownership correctly', () => {
  const rosters = [{ roster_id: 1 }, { roster_id: 2 }];
  const traded = [{ season: '2027', round: 1, roster_id: 1, owner_id: 2 }];
  const owned = resolvePickOwnership(traded, rosters, [2027], 2);
  assert.equal(owned.get(1).get('2027 1st'), undefined, 'roster 1 gave away its 1st');
  assert.equal(owned.get(2).get('2027 1st'), 2, 'roster 2 now holds two 2027 1sts');
  assert.equal(owned.get(1).get('2027 2nd'), 1, 'untraded picks are untouched');
});

test('trend annotation falls back honestly when history is thin', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const assets = [
    { id: 'a', value: 5000, sources: { fantasycalc: { trend30: 250 } } },
    { id: 'b', value: 3000, sources: {} },
  ];
  annotateTrends(assets, [], now);
  assert.equal(assets[0].delta30, 250);
  assert.equal(assets[0].trendBasis30, 'fantasycalc30d', 'labels the fallback honestly');
  assert.equal(assets[1].delta30, null, 'no history and no fallback means no number invented');

  const history = [
    { date: '2026-08-15', values: { a: 4000, b: 3300 } },
    { date: '2026-09-07', values: { a: 4800, b: 3100 } },
  ];
  annotateTrends(assets, history, now);
  assert.equal(assets[0].delta7, 200, '7d delta uses the 2026-09-07 snapshot');
  assert.equal(assets[0].delta30, 1000, '30d delta uses the 2026-08-15 snapshot');
  assert.ok(assets[0].trendBasis30.startsWith('blended:'));
  assert.equal(assets[1].delta30, -300);

  const m = movers(assets, { window: 30, minValue: 0 });
  assert.equal(m.risers[0].id, 'a');
  assert.equal(m.fallers[0].id, 'b');
});

test('pickSnapshot refuses to call a 2-day-old snapshot a 30-day trend', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  assert.equal(pickSnapshot([{ date: '2026-09-12', values: {} }], 30, now), null);
  assert.ok(pickSnapshot([{ date: '2026-08-16', values: {} }], 30, now));
});

test('END TO END: real data -> three sources -> board -> league -> suggestions', () => {
  const players = dp.assets;
  const board = blendSources([
    { source: 'dynastyprocess', assets: players },
    { source: 'fantasycalc', assets: distort(players, { scale: 8000, exponent: 1.6, swaps: [[3, 30], [12, 55]] }) },
    { source: 'ktc', assets: distort(players, { scale: 120, exponent: 0.8, swaps: [[7, 44]] }) },
  ]);
  annotateTrends(board.assets, []);
  assert.ok(board.assets.length > 400, 'board should carry the full asset universe');
  assert.equal(board.assets[0].value, 10000);
  assert.ok(board.assets.every((a, i, arr) => i === 0 || a.value <= arr[i - 1].value), 'board is sorted');
  assert.ok(board.assets.every(a => Number.isFinite(a.value) && a.value >= 0), 'no NaN values');
  assert.ok(board.assets.some(a => a.kind === 'pick'), 'picks survive the blend');

  const byId = new Map(board.assets.map(a => [a.id, a]));
  const { rosters } = fakeLeague(board);
  const rosterAssets = rosters.map(r => ({
    rosterId: r.roster_id,
    assets: r.players.map(p => byId.get(p)).filter(Boolean).sort((a, b) => b.value - a.value),
  }));
  const mine = rosterAssets[0];
  const ownerByAssetId = new Map();
  for (const r of rosterAssets) for (const a of r.assets) ownerByAssetId.set(a.id, `Team ${r.rosterId}`);

  const an = analyzeRoster({
    myAssets: mine.assets, rostersAssets: rosterAssets,
    allAssets: board.assets, ownerByAssetId,
  });

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    assert.ok(an.strength[pos], `strength computed for ${pos}`);
    assert.ok(an.strength[pos].percentile >= 0 && an.strength[pos].percentile <= 1);
  }
  assert.ok(['contend', 'rebuild', 'retool', 'contend-with-youth'].includes(an.profile.stance));
  assert.ok(an.profile.rank >= 1 && an.profile.rank <= 12);
  assert.ok(Array.isArray(an.sells) && Array.isArray(an.buys) && Array.isArray(an.ideas));
  // Every suggestion must carry its reasoning - the UI promises this.
  for (const s of [...an.sells, ...an.buys]) {
    assert.ok(s.reasons?.length >= 1, `${s.name} must explain itself`);
  }
  // Buy targets must never already be on my roster.
  const myIds = new Set(mine.assets.map(a => a.id));
  for (const b of an.buys) assert.ok(!myIds.has(b.id), `${b.name} is already mine`);
  for (const idea of an.ideas) {
    assert.ok(myIds.has(idea.give.id), 'you can only give players you own');
    assert.ok(!myIds.has(idea.get.id), 'you can only get players you do not own');
  }

  // Payload size matters: the browser fetches this whole board.
  const bytes = Buffer.byteLength(JSON.stringify({ assets: board.assets, curve: board.curve }));
  assert.ok(bytes < 3_000_000, `board payload ${(bytes / 1024).toFixed(0)}KB should stay small`);
  console.log(`      board payload: ${(bytes / 1024).toFixed(0)}KB, ${board.assets.length} assets`);
});

test('positional rank is 1-indexed and includes your own team', () => {
  // Three rival rosters plus mine; mine is the strongest at WR.
  const wr = (v) => ({ id: `w${v}`, kind: 'player', position: 'WR', value: v, name: `WR${v}`, sources: {} });
  const mine = [wr(9000), wr(8000), wr(7000)];
  const others = [[wr(1000), wr(900), wr(800)], [wr(2000), wr(1900), wr(1800)], [wr(3000), wr(2900), wr(2800)]];
  const best = positionalStrength(mine, others);
  assert.equal(best.WR.rank, 1, 'the strongest team must be rank 1, never 0');
  assert.equal(best.WR.of, 4, 'the count includes your own team');
  assert.equal(best.WR.label, 'strength');

  // And the weakest team is last, not zeroth.
  const weakest = positionalStrength([wr(100), wr(90), wr(80)], others);
  assert.equal(weakest.WR.rank, 4);
  assert.equal(weakest.WR.label, 'weakness');
});

test('trade ideas do not repeat the same player endlessly', () => {
  const mk = (id, v, pos) => ({ id, name: id, value: v, position: pos, kind: 'player', sources: {}, reasons: [{ code: 'x', text: 'because' }] });
  const sells = [mk('sellA', 5000, 'RB'), mk('sellB', 5000, 'TE')];
  const buys = Array.from({ length: 12 }, (_, i) => mk(`buy${i}`, 5000 + i * 10, 'WR'));
  const ideas = tradeIdeas(sells, buys, new Map(), { limit: 8 });
  const counts = {};
  for (const i of ideas) counts[i.give.id] = (counts[i.give.id] || 0) + 1;
  for (const [id, n] of Object.entries(counts)) {
    assert.ok(n <= 2, `${id} appears ${n} times; should be capped at 2`);
  }
  const gets = ideas.map(i => i.get.id);
  assert.equal(new Set(gets).size, gets.length, 'each target appears at most once');
});

test('valueSpread ranks disagreement sensibly where CV does not', () => {
  // Two assets: a stud the sources split on, and a deep flyer one rank apart.
  // CV says the flyer disagrees more; point spread correctly says the stud does.
  const mkSrc = (ids) => ids.map((id, i) => ({ id, kind: 'player', name: id, position: 'WR', rawValue: 10000 - i * 30 }));
  const order1 = ['stud', ...Array.from({ length: 300 }, (_, i) => `f${i}`)];
  const order2 = [...Array.from({ length: 60 }, (_, i) => `f${i}`), 'stud',
                  ...Array.from({ length: 240 }, (_, i) => `f${i + 60}`)];
  const b = blendSources([
    { source: 'ktc', assets: mkSrc(order1) },
    { source: 'fantasycalc', assets: mkSrc(order2) },
  ]);
  const stud = b.assets.find(a => a.id === 'stud');
  assert.ok(stud.valueSpread > 1000, `stud point gap ${stud.valueSpread} should be large`);
  const deepOnes = b.assets.filter(a => a.id.startsWith('f') && a.overallRank > 250);
  for (const d of deepOnes) {
    assert.ok(d.valueSpread < stud.valueSpread,
      `deep asset ${d.id} (gap ${d.valueSpread}) must not out-disagree the stud (${stud.valueSpread})`);
  }
  // Sorting by valueSpread must put the stud first; sorting by CV would not.
  const byPoints = [...b.assets].sort((p, q) => q.valueSpread - p.valueSpread);
  assert.equal(byPoints[0].id, 'stud');
});

test('a source with too few assets is refused, not silently blended', async () => {
  const { scrapeKtc } = await import('../pipeline/ktc-scrape.mjs');
  // A page that parses fine but only yields a few usable rows - the exact
  // failure seen in production, where KTC returned 3 assets out of ~500.
  const thinHtml = `<script>var playersArray = ${JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({
      playerName: `P${i}`, playerID: i, position: 'WR', superflexValues: { value: 9000 - i },
    })),
  )};</script>`;
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => thinHtml });
  await assert.rejects(
    () => scrapeKtc({ superflex: true, fetchImpl: fakeFetch }),
    (e) => {
      assert.match(e.message, /only 5 usable/);
      assert.ok(e.diagnostics, 'the error must carry diagnostics for remote debugging');
      assert.equal(e.diagnostics.rows, 5);
      assert.ok(e.diagnostics.valuePathHits['superflexValues.value'] === 5);
      return true;
    },
  );
  // And a full board still passes.
  const fullHtml = `<script>var playersArray = ${JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({
      playerName: `P${i}`, playerID: i, position: 'WR', superflexValues: { value: 9000 - i },
    })),
  )};</script>`;
  const ok = await scrapeKtc({ superflex: true, fetchImpl: async () => ({ ok: true, status: 200, text: async () => fullHtml }) });
  assert.equal(ok.assets.length, 300);
});

test('blending three assets from one source cannot inflate them to elite value', () => {
  // Demonstrates WHY the guard above exists: rank-normalization prices the top
  // asset of every source at the top of the consensus curve.
  const big = Array.from({ length: 300 }, (_, i) => ({
    id: `p${i}`, kind: 'player', name: `P${i}`, position: 'WR', rawValue: 10000 - i * 30,
  }));
  const tiny = [
    { id: 'p250', kind: 'player', name: 'P250', position: 'WR', rawValue: 500 },
    { id: 'p260', kind: 'player', name: 'P260', position: 'WR', rawValue: 400 },
    { id: 'p270', kind: 'player', name: 'P270', position: 'WR', rawValue: 300 },
  ];
  const bad = blendSources([{ source: 'fantasycalc', assets: big }, { source: 'ktc', assets: tiny }]);
  const good = blendSources([{ source: 'fantasycalc', assets: big }]);

  const cleanRank = good.assets.find((a) => a.id === 'p250').overallRank;
  const inflated = bad.assets.find((a) => a.id === 'p250');

  // A deep bench player is dragged a hundred-plus places up the board purely
  // because he happened to be ranked first within a three-asset source.
  assert.ok(cleanRank > 200, `sanity: p250 should sit deep when blended alone, got ${cleanRank}`);
  assert.ok(cleanRank - inflated.overallRank > 100,
    `p250 moves from ${cleanRank} to ${inflated.overallRank} with a 3-asset source in the blend - ` +
    'this distortion is what the MIN_ASSETS guard prevents');

  // All three of the thin source's assets are inflated, not just the first.
  for (const id of ['p250', 'p260', 'p270']) {
    const dirty = bad.assets.find((a) => a.id === id).overallRank;
    const clean = good.assets.find((a) => a.id === id).overallRank;
    assert.ok(clean - dirty > 90, `${id}: ${clean} -> ${dirty}`);
  }
});
