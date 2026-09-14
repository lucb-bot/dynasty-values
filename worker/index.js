/**
 * Dynasty value blender - Cloudflare Worker.
 *
 * DESIGN CONSTRAINT that shapes this whole file: the Workers FREE plan allows
 * 10ms of CPU per invocation (cron triggers included). Parsing a 2.6MB player
 * crosswalk or blending 500 assets takes far longer than that. So this Worker
 * does almost no computing:
 *
 *   - The nightly pipeline runs on your Mac mini, which does all the fetching,
 *     scraping, crosswalking and blending, then POSTs a finished board here.
 *   - This Worker stores that board in KV and hands it back verbatim. Boards are
 *     read with type 'text' and returned unparsed, so serving one costs
 *     essentially zero CPU - no JSON.parse of a 250KB payload.
 *   - The browser fetches the board once, calls Sleeper directly (its API sends
 *     permissive CORS headers), and does the joining, power rankings, trade math
 *     and suggestions locally. That also keeps your league data live rather than
 *     a day stale.
 *
 * Auth is Cloudflare Access sitting in front of the whole hostname, so there is
 * no session handling here. The one exception is /api/ingest/*, which the mini
 * calls with a bearer token because Access would otherwise block a non-browser
 * client.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// Boards are immutable for the day, so let the browser cache briefly while
// still picking up a fresh nightly run without a hard reload.
const BOARD_CACHE = 'public, max-age=300, stale-while-revalidate=86400';

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) },
  });
}

function err(status, message) {
  return json({ error: message }, { status });
}

/** Constant-time-ish token compare, to avoid leaking length via early exit. */
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Format keys identify a board. Normalized here AND in the pipeline so the two
 * always agree on a cache key.
 */
function formatKey({ superflex, teams, ppr }) {
  const sf = superflex ? 'sf' : '1qb';
  const t = Number.isFinite(+teams) ? Math.round(+teams) : 12;
  const p = Number.isFinite(+ppr) ? +ppr : 1;
  return `${sf}-${t}tm-${p}ppr`;
}

function parseFormatParams(url) {
  return formatKey({
    superflex: url.searchParams.get('superflex') === 'true',
    teams: url.searchParams.get('teams') || 12,
    ppr: url.searchParams.get('ppr') ?? 1,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      // Everything else is served by Workers Static Assets, which is free and
      // unlimited and never invokes this script.
      return env.ASSETS.fetch(request);
    }

    try {
      if (pathname === '/api/board' && request.method === 'GET') {
        return await getBoard(url, env);
      }
      if (pathname === '/api/history' && request.method === 'GET') {
        return await getHistory(url, env);
      }
      if (pathname === '/api/ingest/history' && request.method === 'POST') {
        return await ingestHistory(request, env);
      }
      if (pathname === '/api/analyze' && request.method === 'POST') {
        return await analyze(request, env);
      }
      if (pathname === '/api/status' && request.method === 'GET') {
        return await getStatus(env);
      }
      if (pathname === '/api/ingest/board' && request.method === 'POST') {
        return await ingestBoard(request, env, ctx);
      }
      if (pathname === '/api/config' && request.method === 'GET') {
        return json({ defaultLeagueId: env.DEFAULT_LEAGUE_ID || null,
                      defaultUsername: env.DEFAULT_SLEEPER_USER || null });
      }
      return err(404, 'not found');
    } catch (e) {
      return err(500, e?.message || 'worker error');
    }
  },
};

/**
 * Serve a blended board. Returned as raw stored text - deliberately NOT parsed,
 * to keep CPU near zero on the free plan.
 */
async function getBoard(url, env) {
  const key = parseFormatParams(url);
  const text = await env.VALUES.get(`board:${key}`, { type: 'text' });
  if (text) {
    return new Response(text, {
      headers: { ...JSON_HEADERS, 'cache-control': BOARD_CACHE, 'x-board-format': key },
    });
  }

  // No board for this exact format yet. Rather than fail, fall back to the
  // nearest board we do have (same QB rules matter most; team count and PPR
  // shift values only slightly), and say so in a header the UI surfaces.
  const index = await env.VALUES.get('boards:index', { type: 'json' });
  const available = Array.isArray(index?.formats) ? index.formats : [];
  const sf = key.startsWith('sf-');
  const fallback = available.find((f) => f.startsWith(sf ? 'sf-' : '1qb-')) || available[0];
  if (!fallback) {
    return err(503, 'no board has been published yet - run the pipeline on your mini first');
  }
  const fbText = await env.VALUES.get(`board:${fallback}`, { type: 'text' });
  if (!fbText) return err(503, 'board index is stale; re-run the pipeline');
  return new Response(fbText, {
    headers: {
      ...JSON_HEADERS, 'cache-control': BOARD_CACHE,
      'x-board-format': fallback,
      'x-board-requested': key,
      'x-board-fallback': 'true',
    },
  });
}

/**
 * Written roster summary, via Cloudflare Workers AI (free allocation: 10,000
 * neurons/day; one summary costs a small fraction of that).
 *
 * IMPORTANT DESIGN CONSTRAINT. The model available here is a small open model
 * with no knowledge of the current NFL season. Asked for opinions it would
 * invent injuries, depth charts and trades with total confidence. So it is used
 * strictly as a WRITER, never as an analyst: the browser sends facts that were
 * already computed from the value data, and the model's only job is to turn
 * those numbers into readable prose. The system prompt forbids adding anything
 * not present in the input, and the UI labels the output accordingly.
 */
const AI_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.2-1b-instruct',
];

const AI_SYSTEM = [
  'You are writing a short dynasty fantasy football roster summary.',
  '',
  'ABSOLUTE RULES:',
  '- Use ONLY the facts in the user message. Every number you write must appear there.',
  '- You do NOT know anything about the current NFL season: no injuries, depth charts,',
  '  coaching changes, or recent games. Never mention any of these. Never invent a reason',
  '  a player rose or fell.',
  '- Do not add players who are not listed. Do not guess at ages or teams.',
  '- If the facts are thin, write less. Never pad.',
  '',
  'STYLE: 3 short paragraphs, plain prose, no headers, no bullet points, no emoji.',
  'Address the manager as "you". Be direct and concrete, citing the given numbers.',
  'End with the single most important move the facts point to.',
].join('\n');

async function analyze(request, env) {
  if (!env.AI) return err(503, 'Workers AI is not bound to this Worker');
  let facts;
  try {
    facts = await request.json();
  } catch { return err(400, 'invalid JSON'); }
  if (!facts || typeof facts !== 'object') return err(400, 'expected a facts object');

  // Keep the prompt small: this is a summarization job, not a data dump, and
  // the free-tier budget is per-token.
  const prompt = JSON.stringify(facts).slice(0, 6000);

  let lastError = null;
  for (const model of AI_MODELS) {
    try {
      const res = await env.AI.run(model, {
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: prompt },
        ],
        max_tokens: 420,
        temperature: 0.3,
      });
      const text = (res?.response || '').trim();
      if (text) return json({ text, model });
      lastError = 'empty response';
    } catch (e) {
      lastError = e?.message || String(e);
    }
  }
  return err(502, `Workers AI failed: ${lastError}`);
}

/**
 * Weekly value history, used by the player detail charts. Served as stored text
 * for the same reason boards are: parsing it here would blow the CPU budget.
 */
async function getHistory(url, env) {
  const qb = url.searchParams.get('qb') === 'sf' ? 'sf' : '1qb';
  const text = await env.VALUES.get(`history:${qb}`, { type: 'text' });
  if (!text) return err(404, 'no history published yet');
  return new Response(text, {
    headers: { ...JSON_HEADERS, 'cache-control': BOARD_CACHE },
  });
}

async function ingestHistory(request, env) {
  if (!tokenMatches(bearer(request), env.INGEST_TOKEN)) return err(401, 'bad or missing ingest token');
  const body = await request.json();
  const qb = body.qb === 'sf' ? 'sf' : '1qb';
  if (!body.history?.dates?.length) return err(400, 'history.dates is required');
  await env.VALUES.put(`history:${qb}`, JSON.stringify(body.history));
  return json({ ok: true, qb, points: body.history.dates.length,
                players: Object.keys(body.history.series || {}).length });
}

/** Freshness and coverage, so the UI can show when each source last updated. */
async function getStatus(env) {
  const index = await env.VALUES.get('boards:index', { type: 'json' });
  return json({
    formats: index?.formats || [],
    publishedAt: index?.publishedAt || null,
    sources: index?.sources || [],
    pipelineVersion: index?.pipelineVersion || null,
    now: new Date().toISOString(),
  }, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Receive a finished board from the pipeline.
 *
 * Body: { format: {...}|string, board: {...}, sources: [...], pipelineVersion }
 * The board is stored as a string exactly as received so reads stay cheap.
 */
async function ingestBoard(request, env, ctx) {
  if (!tokenMatches(bearer(request), env.INGEST_TOKEN)) {
    return err(401, 'bad or missing ingest token');
  }
  const body = await request.json();
  const key = typeof body.format === 'string' ? body.format : formatKey(body.format || {});
  if (!body.board || !Array.isArray(body.board.assets)) {
    return err(400, 'body.board.assets is required');
  }

  const stored = JSON.stringify({
    format: key,
    publishedAt: new Date().toISOString(),
    sources: body.sources || [],
    curve: body.board.curve || [],
    assets: body.board.assets,
  });
  await env.VALUES.put(`board:${key}`, stored);

  // Keep a dated snapshot so the UI can compute 7- and 30-day movers from our
  // own blended values rather than trusting one source's trend field.
  const today = new Date().toISOString().slice(0, 10);
  const snapshot = {};
  for (const a of body.board.assets) snapshot[a.id] = a.value;
  await env.VALUES.put(`hist:${key}:${today}`, JSON.stringify(snapshot),
    { expirationTtl: 60 * 60 * 24 * 45 });

  // Maintain the format index.
  const index = (await env.VALUES.get('boards:index', { type: 'json' })) || { formats: [] };
  const formats = new Set(index.formats || []);
  formats.add(key);
  await env.VALUES.put('boards:index', JSON.stringify({
    formats: [...formats].sort(),
    publishedAt: new Date().toISOString(),
    sources: body.sources || [],
    pipelineVersion: body.pipelineVersion || null,
  }));

  return json({ ok: true, format: key, assetCount: body.board.assets.length });
}
