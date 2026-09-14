/**
 * Dynasty Value Blender - client.
 *
 * All of the league-specific work happens here rather than on the Worker,
 * because Cloudflare's free plan allows 10ms of CPU per Worker invocation. The
 * browser has no such limit, Sleeper's API is CORS-open so we call it directly,
 * and the blended board arrives as one cached JSON file. The Worker only stores
 * and serves that file.
 */

import * as sleeper from './lib/sleeper.js';
import { evaluateTrade, packageValue } from './lib/trade.js';
import { analyzeRoster } from './lib/suggest.js';
import { movers } from './lib/history.js';
import { ageStage } from './lib/agecurve.js';

const LS_KEY = 'dvb.settings.v1';
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
};
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '—');
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : '—');

const state = {
  settings: {}, league: null, format: null, board: null, boardMeta: {},
  rosters: [], users: [], ownedPicks: null, assetsById: new Map(),
  rosterAssets: [], myRosterId: null, analysis: null,
  view: 'roster', trade: { a: [], b: [] },
};

/* ---------------------------------------------------------------- settings */

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  state.settings = { ...state.settings, ...s };
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); } catch { /* private mode */ }
}

/* ------------------------------------------------------------------- setup */

async function showSetup(prefillError) {
  $('#app').hidden = true;
  $('#setup').hidden = false;
  const errBox = $('#setup-error');
  if (prefillError) { errBox.textContent = prefillError; errBox.hidden = false; }
  if (state.settings.username) $('#username').value = state.settings.username;

  $('#find-leagues').onclick = async () => {
    const username = $('#username').value.trim();
    errBox.hidden = true;
    $('#league-list').replaceChildren();
    if (!username) return;
    try {
      const user = await sleeper.getUser(username);
      if (!user?.user_id) throw new Error(`No Sleeper user called "${username}".`);
      const st = await sleeper.getState().catch(() => null);
      const season = st?.league_season || String(new Date().getFullYear());
      let leagues = await sleeper.getLeagues(user.user_id, season) || [];
      if (!leagues.length) {
        leagues = await sleeper.getLeagues(user.user_id, String(Number(season) - 1)) || [];
      }
      if (!leagues.length) throw new Error('That account has no NFL leagues this season or last.');

      $('#league-list').replaceChildren(...leagues.map((lg) => {
        const f = sleeper.detectFormat(lg);
        return el('li', {
          onclick: () => {
            saveSettings({
              username, userId: user.user_id, leagueId: lg.league_id,
              // Cache the list so the header dropdown can switch leagues
              // instantly instead of re-querying Sleeper every time.
              leagues: leagues.map((x) => ({ id: x.league_id, name: x.name })),
            });
            location.reload();
          },
        },
          el('div', {}, el('b', {}, lg.name)),
          el('div', { className: 'faint' },
            `${lg.total_rosters} teams · ${f.superflex ? 'superflex' : '1QB'} · ${f.ppr === 1 ? 'PPR' : f.ppr === 0.5 ? 'half-PPR' : 'standard'}${f.teBonus ? ' · TE premium' : ''}`),
        );
      }));
    } catch (e) {
      errBox.textContent = e.message;
      errBox.hidden = false;
    }
  };
  $('#username').onkeydown = (e) => { if (e.key === 'Enter') $('#find-leagues').click(); };
}

/* -------------------------------------------------------------- data load */

async function fetchBoard(format) {
  const p = new URLSearchParams({
    superflex: String(!!format.superflex), teams: String(format.teams), ppr: String(format.ppr),
  });
  const res = await fetch(`/api/board?${p}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Board unavailable (${res.status})`);
  }
  state.boardMeta = {
    served: res.headers.get('x-board-format'),
    requested: res.headers.get('x-board-requested'),
    fallback: res.headers.get('x-board-fallback') === 'true',
  };
  return res.json();
}

/** Attach board values to a roster's sleeper ids and owned picks. */
function assetsForRoster(roster, ownedPicks) {
  const out = [];
  for (const pid of roster.players || []) {
    const a = state.assetsById.get(String(pid));
    if (a) out.push(a);
  }
  const picks = ownedPicks.get(roster.roster_id);
  if (picks) {
    for (const [name, count] of picks) {
      const a = state.assetsById.get(name);
      if (a) for (let i = 0; i < count; i++) out.push(a);
    }
  }
  return out.sort((x, y) => y.value - x.value);
}

async function loadLeague() {
  const { leagueId, userId } = state.settings;
  const [league, rosters, users] = await Promise.all([
    sleeper.getLeague(leagueId), sleeper.getRosters(leagueId), sleeper.getLeagueUsers(leagueId),
  ]);
  if (!league) throw new Error('That league id no longer resolves on Sleeper.');
  const tradedPicks = await sleeper.getTradedPicks(leagueId).catch(() => []);

  state.league = league;
  state.rosters = rosters || [];
  state.users = users || [];
  state.format = sleeper.detectFormat(league);

  // Refresh the cached league list in the background so leagues joined since
  // setup show up in the switcher without needing a full re-login.
  if (state.settings.userId) {
    sleeper.getState()
      .then((st) => sleeper.getLeagues(state.settings.userId, st?.league_season || league.season))
      .then((lgs) => {
        if (lgs?.length) saveSettings({ leagues: lgs.map((x) => ({ id: x.league_id, name: x.name })) });
      })
      .catch(() => { /* switcher just keeps the cached list */ });
  }

  const board = await fetchBoard(state.format);
  state.board = board;
  state.assetsById = new Map(board.assets.map((a) => [String(a.id), a]));

  const thisYear = Number(league.season) || new Date().getFullYear();
  const seasons = [thisYear + 1, thisYear + 2, thisYear + 3];
  state.ownedPicks = sleeper.resolvePickOwnership(tradedPicks, state.rosters, seasons);

  const userById = new Map(state.users.map((u) => [u.user_id, u]));
  state.rosterAssets = state.rosters.map((r) => ({
    rosterId: r.roster_id,
    owner: userById.get(r.owner_id),
    name: userById.get(r.owner_id)?.metadata?.team_name || userById.get(r.owner_id)?.display_name || `Roster ${r.roster_id}`,
    record: `${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}${r.settings?.ties ? `-${r.settings.ties}` : ''}`,
    roster: r,
    assets: assetsForRoster(r, state.ownedPicks),
    unvalued: (r.players || []).filter((p) => !state.assetsById.has(String(p))).length,
  }));

  const mine = state.rosterAssets.find((r) => r.roster.owner_id === userId)
            || state.rosterAssets.find((r) => (r.roster.co_owners || []).includes(userId));
  state.myRosterId = mine?.rosterId ?? state.rosterAssets[0]?.rosterId ?? null;

  const ownerByAssetId = new Map();
  for (const r of state.rosterAssets) for (const a of r.assets) ownerByAssetId.set(a.id, r.name);

  if (mine) {
    state.analysis = analyzeRoster({
      myAssets: mine.assets,
      rostersAssets: state.rosterAssets,
      allAssets: board.assets,
      ownerByAssetId,
    });
  }
}

/* ------------------------------------------------------------ shared bits */

const posTag = (a) => el('span', { className: `pos ${a.position || 'NA'}` }, a.position || '—');

function nameCell(a, extra = []) {
  return el('td', {},
    posTag(a), ' ',
    el('span', {}, a.name),
    a.age ? el('span', { className: 'faint' }, ` ${a.age}`) : null,
    a.lowConfidence ? el('span', { className: 'badge thin', title: 'Only one source prices this asset' }, '1 src') : null,
    ...extra,
  );
}

function deltaCell(a, key = 'delta30') {
  const d = a[key];
  if (!Number.isFinite(d) || d === 0) return el('td', { className: 'num faint' }, '—');
  return el('td', { className: `num delta ${d > 0 ? 'up' : 'down'}` }, `${d > 0 ? '+' : ''}${fmt(d)}`);
}

function table(headers, rows) {
  return el('div', { className: 'scroll-x' }, el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((h) =>
      el('th', { className: typeof h === 'object' && h.num ? 'num' : '' }, typeof h === 'object' ? h.label : h)))),
    el('tbody', {}, ...rows),
  ));
}

function card(title, sub, ...body) {
  return el('div', { className: 'card' },
    el('h2', {}, title, sub ? el('span', { className: 'sub' }, sub) : null),
    ...body);
}

/* ------------------------------------------------------------- roster view */

function renderRoster() {
  const mine = state.rosterAssets.find((r) => r.rosterId === state.myRosterId);
  if (!mine) return el('div', { className: 'empty' }, 'Could not identify your roster in this league.');
  const an = state.analysis;

  const total = mine.assets.reduce((s, a) => s + a.value, 0);
  const stats = el('div', { className: 'grid4' },
    el('div', { className: 'stat' }, el('div', { className: 'k' }, 'Roster value'),
      el('div', { className: 'v' }, fmt(total)),
      el('div', { className: 'n' }, `#${an?.profile.rank ?? '—'} of ${an?.profile.of ?? '—'}`)),
    el('div', { className: 'stat' }, el('div', { className: 'k' }, 'Stance'),
      el('div', { className: 'v', style: 'font-size:16px' }, ({
        contend: 'Contend', rebuild: 'Rebuild', retool: 'Retool', 'contend-with-youth': 'Contend (young)',
      })[an?.profile.stance] || '—'),
      el('div', { className: 'n' }, `${pct(an?.profile.youthShare)} of value is future`)),
    el('div', { className: 'stat' }, el('div', { className: 'k' }, 'Assets'),
      el('div', { className: 'v' }, mine.assets.length),
      el('div', { className: 'n' }, `${mine.unvalued} unvalued`)),
    el('div', { className: 'stat' }, el('div', { className: 'k' }, 'Record'),
      el('div', { className: 'v', style: 'font-size:16px' }, mine.record),
      el('div', { className: 'n' }, state.league.name)),
  );

  const strengthRows = ['QB', 'RB', 'WR', 'TE'].map((p) => {
    const s = an.strength[p];
    return el('tr', {},
      el('td', {}, el('span', { className: `pos ${p}` }, p)),
      el('td', { className: 'num' }, fmt(s.total)),
      el('td', { className: 'num faint' }, fmt(s.leagueMedian)),
      el('td', { className: 'num' }, `${s.rank} of ${s.of}`),
      el('td', { style: 'width:130px' }, el('div', { className: 'bar' },
        el('i', { style: `width:${Math.max(3, s.percentile * 100)}%` }))),
      el('td', {}, el('span', {
        className: `badge ${s.label === 'strength' ? 'buy' : s.label === 'weakness' ? 'sell' : ''}`,
      }, s.label)),
    );
  });

  const rosterRows = mine.assets.map((a) => el('tr', {},
    nameCell(a),
    el('td', { className: 'faint' }, a.team || (a.kind === 'pick' ? 'pick' : '')),
    el('td', { className: 'faint' }, a.kind === 'player' ? ageStage(a.position, a.age) : ''),
    el('td', { className: 'num' }, fmt(a.value)),
    deltaCell(a),
    el('td', { className: 'num faint' }, a.sources?.ktc ? fmt(a.sources.ktc.normalized) : '—'),
    el('td', { className: 'num faint' }, a.sources?.fantasycalc ? fmt(a.sources.fantasycalc.normalized) : '—'),
    el('td', { className: 'num faint' }, a.sources?.dynastyprocess ? fmt(a.sources.dynastyprocess.normalized) : '—'),
  ));

  const sellRows = an.sells.slice(0, 10).map((a) => el('tr', {},
    nameCell(a, [el('span', { className: 'badge sell' }, 'sell')]),
    el('td', { className: 'num' }, fmt(a.value)),
    el('td', {}, el('ul', { className: 'reasons' }, ...a.reasons.map((r) => el('li', {}, r.text)))),
  ));

  const buyRows = an.buys.slice(0, 10).map((a) => el('tr', {},
    nameCell(a, [el('span', { className: 'badge buy' }, 'buy')]),
    el('td', { className: 'num' }, fmt(a.value)),
    el('td', {}, el('ul', { className: 'reasons' }, ...a.reasons.map((r) => el('li', {}, r.text)))),
  ));

  const ideas = an.ideas.length
    ? an.ideas.map((idea) => el('div', { className: 'idea' },
        el('div', { className: 'hdr' },
          posTag(idea.give), idea.give.name,
          el('span', { className: 'arrow' }, ' ⇄ '),
          posTag(idea.get), idea.get.name,
          idea.withTeam ? el('span', { className: 'badge' }, `from ${idea.withTeam}`) : null,
          el('span', { className: 'badge' }, `${idea.valueGap >= 0 ? '+' : ''}${fmt(idea.valueGap)} for you`),
          idea.edge === 2 ? el('span', { className: 'badge buy' }, 'both sides mispriced') : null),
        el('ul', {}, ...idea.rationale.map((r) => el('li', {}, r))),
        el('div', { style: 'margin-top:8px' },
          el('button', {
            className: 'btn ghost', onclick: () => {
              state.trade = { a: [idea.give], b: [idea.get] };
              switchView('trade');
            },
          }, 'Open in calculator')),
      ))
    : [el('div', { className: 'empty' }, 'No clean one-for-one matches right now. The trade calculator handles bigger packages.')];

  return el('div', {},
    stats,
    el('div', { style: 'height:16px' }),
    card('Positional strength', 'starters plus two, against the rest of the league',
      table(['Pos', { label: 'Your value', num: true }, { label: 'League median', num: true },
             { label: 'Rank', num: true }, 'Percentile', ''], strengthRows)),
    card('Suggested moves', 'heuristics — the reasoning is shown so you can disagree',
      el('div', { className: 'grid2' },
        el('div', {}, el('h3', { style: 'font-size:12px;color:var(--text-dim);margin:0 0 6px' }, 'Consider selling'),
          sellRows.length ? table(['Player', { label: 'Value', num: true }, 'Why'], sellRows) : el('div', { className: 'empty' }, 'Nothing flagged.')),
        el('div', {}, el('h3', { style: 'font-size:12px;color:var(--text-dim);margin:0 0 6px' }, 'Consider buying'),
          buyRows.length ? table(['Player', { label: 'Value', num: true }, 'Why'], buyRows) : el('div', { className: 'empty' }, 'Nothing flagged.')),
      )),
    card('Trade ideas', 'matched on value, ranked by how mispriced both sides are', ...ideas),
    card('Your roster', `${mine.assets.length} valued assets`,
      table(['Player', 'Team', 'Stage', { label: 'Blend', num: true }, { label: '30d', num: true },
             { label: 'KTC', num: true }, { label: 'FCalc', num: true }, { label: 'DynP', num: true }], rosterRows)),
  );
}

/* -------------------------------------------------------------- trade view */

function assetSearch(onPick) {
  const input = el('input', { type: 'search', placeholder: 'Add a player or pick…' });
  const list = el('ul', { hidden: true });
  const box = el('div', { className: 'search-results' }, input, list);

  const close = () => { list.hidden = true; list.replaceChildren(); };
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return close();
    const hits = state.board.assets
      .filter((a) => a.name.toLowerCase().includes(q)).slice(0, 12);
    list.replaceChildren(...hits.map((a) => el('li', {
      onclick: () => { onPick(a); input.value = ''; close(); },
    }, posTag(a), el('span', {}, a.name), el('span', { className: 'faint', style: 'margin-left:auto' }, fmt(a.value)))));
    list.hidden = !hits.length;
  };
  input.onblur = () => setTimeout(close, 160);
  return box;
}

function sideColumn(which) {
  const items = state.trade[which];
  return el('div', { className: 'side' },
    el('h3', {}, which === 'a' ? 'You give' : 'You get'),
    assetSearch((a) => { state.trade[which].push(a); rerender(); }),
    el('div', { style: 'margin-top:9px' },
      ...items.map((a, i) => el('div', { className: 'chip' },
        posTag(a), el('span', {}, a.name),
        el('span', { className: 'faint mono' }, fmt(a.value)),
        el('button', {
          className: 'x', title: 'remove',
          onclick: () => { state.trade[which].splice(i, 1); rerender(); },
        }, '×'))),
      items.length ? el('div', { className: 'faint', style: 'margin-top:8px' },
        `raw ${fmt(packageValue(items).raw)} → adjusted ${fmt(packageValue(items).adjusted)}`) : null),
  );
}

function renderTrade() {
  const { a, b } = state.trade;
  const hasDeal = a.length && b.length;
  const r = hasDeal ? evaluateTrade(a, b) : null;

  const verdict = hasDeal
    ? el('div', { className: `verdict ${r.contested ? 'contested' : ''}` },
        el('div', { className: 'big' }, r.favors === 'even' ? 'Even' : (r.favors === 'a' ? 'You lose' : 'You win')),
        el('div', { className: 'muted' }, `${r.verdict} · ${pct(r.gapPct)} gap`),
        el('div', { className: 'faint', style: 'margin-top:6px' },
          `${fmt(r.a.adjusted)} out vs ${fmt(r.b.adjusted)} in`),
        r.contested ? el('div', { style: 'margin-top:8px;font-weight:600' },
          'Sources disagree on who wins — see the breakdown') : null,
        r.lowConfidence ? el('div', { className: 'badge thin', style: 'margin-top:6px' },
          'a piece is priced by only one source') : null)
    : el('div', { className: 'verdict' }, el('div', { className: 'muted' }, 'Add players to both sides'));

  const srcRows = hasDeal ? Object.entries(r.sourceVerdicts).map(([src, v]) => el('tr', {},
    el('td', {}, src),
    el('td', { className: 'num' }, fmt(v.aTotal)),
    el('td', { className: 'num' }, fmt(v.bTotal)),
    el('td', { className: `num delta ${v.diff < 0 ? 'up' : v.diff > 0 ? 'down' : ''}` },
      `${v.diff > 0 ? '+' : ''}${fmt(v.diff)}`),
    el('td', {}, el('span', {
      className: `badge ${v.favors === 'b' ? 'buy' : v.favors === 'a' ? 'sell' : ''}`,
    }, v.favors === 'even' ? 'even' : v.favors === 'b' ? 'you win' : 'you lose')),
  )) : [];

  return el('div', {},
    card('Build a trade', 'values from the blend; each side adjusted for roster-spot cost',
      el('div', { className: 'trade-cols' },
        sideColumn('a'),
        el('div', { className: 'vs' }, 'for'),
        sideColumn('b')),
      el('div', { style: 'margin-top:16px' }, verdict),
      hasDeal ? el('div', { style: 'margin-top:8px;text-align:center' },
        el('button', { className: 'btn ghost', onclick: () => { state.trade = { a: [], b: [] }; rerender(); } }, 'Clear')) : null),
    hasDeal ? card('How each source sees it',
      'the gap between these is the whole point — a leaguemate pricing off KTC will accept what KTC likes',
      table(['Source', { label: 'You give', num: true }, { label: 'You get', num: true },
             { label: 'Net', num: true }, 'Verdict'], srcRows)) : null,
  );
}

/* ------------------------------------------------------------- league view */

function renderLeague() {
  const rows = [...state.rosterAssets]
    .map((r) => {
      const total = r.assets.reduce((s, a) => s + a.value, 0);
      const players = r.assets.filter((x) => x.kind === 'player');
      const picks = r.assets.filter((x) => x.kind === 'pick');
      const ages = players.filter((p) => Number.isFinite(p.age));
      const wAge = ages.length
        ? ages.reduce((s, p) => s + p.age * p.value, 0) / ages.reduce((s, p) => s + p.value, 0)
        : null;
      return { ...r, total, pickValue: picks.reduce((s, a) => s + a.value, 0), wAge, playerCount: players.length };
    })
    .sort((x, y) => y.total - x.total)
    .map((r, i) => el('tr', { style: r.rosterId === state.myRosterId ? 'background:var(--accent-soft)' : '' },
      el('td', { className: 'num' }, i + 1),
      el('td', {}, el('b', {}, r.name), r.rosterId === state.myRosterId ? el('span', { className: 'badge buy' }, 'you') : null),
      el('td', { className: 'faint' }, r.record),
      el('td', { className: 'num' }, fmt(r.total)),
      el('td', { className: 'num faint' }, fmt(r.pickValue)),
      el('td', { className: 'num faint' }, r.wAge ? r.wAge.toFixed(1) : '—'),
      el('td', { style: 'width:150px' }, el('div', { className: 'bar' },
        el('i', { style: `width:${(r.total / Math.max(...state.rosterAssets.map((x) => x.assets.reduce((s, a) => s + a.value, 0)))) * 100}%` }))),
    ));

  return card('Power rankings', 'total blended value of every asset, picks included',
    table([{ label: '#', num: true }, 'Team', 'Record', { label: 'Total value', num: true },
           { label: 'Pick value', num: true }, { label: 'Avg age', num: true }, ''], rows));
}

/* ------------------------------------------------------------- movers view */

function renderMovers() {
  const m = movers(state.board.assets, { window: 30, limit: 15 });
  const basis = state.board.assets.find((a) => a.trendBasis30)?.trendBasis30 || 'none';

  const row = (a) => el('tr', {},
    nameCell(a), el('td', { className: 'num' }, fmt(a.value)), deltaCell(a),
    el('td', { className: 'num faint' }, a.pct30 != null ? pct(a.pct30) : '—'));

  // Sorted by POINT spread, not by coefficient of variation - see blend.js for
  // why CV misleads at the bottom of the board.
  const disagree = [...state.board.assets]
    .filter((a) => a.sourceCount > 1 && a.value >= 500)
    .sort((p, q) => q.valueSpread - p.valueSpread).slice(0, 20)
    .map((a) => el('tr', {},
      nameCell(a),
      el('td', { className: 'num' }, fmt(a.value)),
      ...['ktc', 'fantasycalc', 'dynastyprocess'].map((s) =>
        el('td', { className: 'num faint' }, a.sources?.[s] ? `#${a.sources[s].rank}` : '—')),
      el('td', { className: 'num' }, a.rankSpread),
      el('td', { className: 'num' }, fmt(a.valueSpread)),
    ));

  return el('div', {},
    m.covered === 0
      ? el('div', { className: 'notice' },
          'No trend data yet. The pipeline needs a few nightly runs before it can compare boards over time; until then it falls back to FantasyCalc’s own 30-day trend where available.')
      : null,
    el('div', { className: 'grid2' },
      card('Risers', `30 days · ${basis}`, m.risers.length
        ? table(['Player', { label: 'Value', num: true }, { label: 'Δ', num: true }, { label: '%', num: true }], m.risers.map(row))
        : el('div', { className: 'empty' }, 'None yet.')),
      card('Fallers', `30 days · ${basis}`, m.fallers.length
        ? table(['Player', { label: 'Value', num: true }, { label: 'Δ', num: true }, { label: '%', num: true }], m.fallers.map(row))
        : el('div', { className: 'empty' }, 'None yet.'))),
    card('Biggest source disagreement',
      'where the sources rank a player most differently — often where the edge is',
      table(['Player', { label: 'Blend', num: true }, { label: 'KTC', num: true },
             { label: 'FCalc', num: true }, { label: 'DynP', num: true },
             { label: 'Rank gap', num: true }, { label: 'Point gap', num: true }], disagree)),
  );
}

/* -------------------------------------------------------------- board view */

let boardFilter = { q: '', pos: '' };
function renderBoard() {
  const input = el('input', { type: 'search', placeholder: 'Filter by name…', value: boardFilter.q });
  const sel = el('select', {}, ...['', 'QB', 'RB', 'WR', 'TE', 'PICK'].map((p) =>
    el('option', { value: p, selected: boardFilter.pos === p }, p || 'All positions')));
  input.oninput = () => { boardFilter.q = input.value; redrawBoardRows(); };
  sel.onchange = () => { boardFilter.pos = sel.value; redrawBoardRows(); };

  const tbody = el('tbody');
  function redrawBoardRows() {
    const q = boardFilter.q.trim().toLowerCase();
    const rows = state.board.assets
      .filter((a) => (!q || a.name.toLowerCase().includes(q)) && (!boardFilter.pos || a.position === boardFilter.pos))
      .slice(0, 300)
      .map((a) => el('tr', {},
        el('td', { className: 'num faint' }, a.overallRank),
        nameCell(a),
        el('td', { className: 'faint' }, a.team || ''),
        el('td', { className: 'num' }, fmt(a.value)),
        deltaCell(a),
        ...['ktc', 'fantasycalc', 'dynastyprocess'].map((s) =>
          el('td', { className: 'num faint' }, a.sources?.[s] ? fmt(a.sources[s].normalized) : '—')),
        el('td', { className: 'num faint' }, fmt(a.valueSpread)),
      ));
    tbody.replaceChildren(...rows);
  }
  redrawBoardRows();

  return card('Full board', `${state.board.assets.length} assets`,
    el('div', { style: 'display:flex;gap:10px;margin-bottom:12px;max-width:460px' }, input, sel),
    el('div', { className: 'scroll-x' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { className: 'num' }, '#'), el('th', {}, 'Player'), el('th', {}, 'Team'),
        el('th', { className: 'num' }, 'Blend'), el('th', { className: 'num' }, '30d'),
        el('th', { className: 'num' }, 'KTC'), el('th', { className: 'num' }, 'FCalc'),
        el('th', { className: 'num' }, 'DynP'), el('th', { className: 'num' }, 'Point gap'))),
      tbody)));
}

/* ------------------------------------------------------------------- shell */

const VIEWS = { roster: renderRoster, trade: renderTrade, league: renderLeague, movers: renderMovers, board: renderBoard };

function switchView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === v));
  }
  rerender();
}

function rerender() {
  try {
    $('#view').replaceChildren(VIEWS[state.view]());
  } catch (e) {
    $('#view').replaceChildren(el('div', { className: 'notice' }, `Render failed: ${e.message}`));
    console.error(e);
  }
}

function renderChrome() {
  const f = state.format;
  const fmtLabel = `${f.teams}tm · ${f.superflex ? 'SF' : '1QB'} · ${f.ppr === 1 ? 'PPR' : f.ppr === 0.5 ? 'half' : 'std'}`;
  const known = state.settings.leagues || [];

  // With more than one league on the account, the chip becomes a switcher.
  if (known.length > 1) {
    const sel = el('select', { className: 'league-select' },
      ...known.map((lg) => el('option', {
        value: lg.id, selected: lg.id === state.settings.leagueId,
      }, lg.name)));
    sel.onchange = () => { saveSettings({ leagueId: sel.value }); location.reload(); };
    $('#league-chip').replaceChildren(sel, ` ${fmtLabel}`);
  } else {
    $('#league-chip').replaceChildren(el('b', {}, state.league.name), ` · ${fmtLabel}`);
  }

  const notices = [];
  if (state.boardMeta.fallback) {
    notices.push(`No board published for ${state.boardMeta.requested} yet — showing ${state.boardMeta.served} instead. Add that format to pipeline/config.json and re-run the pipeline.`);
  }
  if (f.teBonus) {
    notices.push(`This league has TE premium (${f.teBonus}/rec). No source prices that, so tight ends are undervalued here by roughly that bonus.`);
  }
  if (notices.length) {
    $('#global-notice').replaceChildren(...notices.map((n) => el('div', {}, n)));
    $('#global-notice').hidden = false;
  }

  const srcs = (state.board.sources || []).map((s) =>
    s.error ? `${s.source}: failed` : `${s.source}: ${s.assets}`).join(' · ');
  $('#footer-meta').replaceChildren(
    `Board ${state.boardMeta.served} published ${state.board.publishedAt ? new Date(state.board.publishedAt).toLocaleString() : 'unknown'}. `,
    srcs ? `Sources — ${srcs}. ` : '',
    'Rosters are live from Sleeper. Suggestions are heuristics, not advice.');

  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.onclick = () => switchView(b.dataset.view);
  }
  $('#switch-league').onclick = () => {
    // Full reset back to the username prompt, for a different Sleeper account.
    saveSettings({ leagueId: null, userId: null, leagues: null });
    location.reload();
  };
}

async function boot() {
  state.settings = loadSettings();
  if (!state.settings.leagueId || !state.settings.userId) return showSetup();

  $('#setup').hidden = true;
  $('#app').hidden = false;
  try {
    await loadLeague();
  } catch (e) {
    $('#app').hidden = true;
    return showSetup(e.message);
  }
  renderChrome();
  rerender();
}

boot();
