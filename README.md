# Dynasty Value Blender

A private dynasty fantasy football tool that blends player values from three
sources into one board, wires it to your Sleeper league, and tells you who to
buy and sell. Runs on Cloudflare's free tier plus a nightly job on your Mac
mini. Total cost: **$0/month**, no domain required.

---

## What it does

- **Blended values** from KeepTradeCut, FantasyCalc and DynastyProcess, on one
  scale, with each source's own number shown alongside so you can see the split.
- **Trade calculator** that reports a verdict *per source* as well as for the
  blend. When KTC says you win and the other two say you lose, that gap is the
  point — your leaguemates price off KTC.
- **Your roster**, valued live from Sleeper, with positional strength against
  the league and a contend/rebuild read.
- **Suggested moves** — buy and sell candidates with the reasoning shown, plus
  concrete trade ideas matched against other teams' rosters.
- **Power rankings** for the whole league, picks included.
- **Movers** over 7 and 30 days, and the players your sources most disagree
  about.

---

## Architecture, and why it looks like this

```
  Mac mini (nightly)                Cloudflare (always on)         Browser
  ──────────────────                ──────────────────────         ───────
  scrape KTC ─┐
  fetch FantasyCalc ─┼─> blend ──POST──> Worker ──> KV ──/api/board──> page
  fetch DynastyProcess ┘                    │                          │
  build ID crosswalk                    static assets ────────────────>│
  compute 7/30d trends                                                 │
                                       api.sleeper.app ────────────────┘
                                       (called directly, CORS-open)
```

Two constraints drove this shape:

**Cloudflare's free plan allows 10ms of CPU per Worker invocation**, cron
triggers included. Parsing a 2.6MB player crosswalk and blending 500 assets is
orders of magnitude past that. So the Worker never computes anything: it stores
a finished board and hands it back as raw text, which costs almost no CPU.
Static assets don't invoke the Worker at all and are free and unlimited.

**KTC's terms forbid scraping and forbid republishing their values.** The
collector therefore runs on your machine, on your residential IP, and the result
never leaves your private, login-gated site. Datacenter IP ranges are widely
blocked and shared with other people; yours is not. See *The KTC question*
below.

The browser calls Sleeper directly because Sleeper's API is CORS-open, so your
rosters are live rather than as stale as last night's run.

If the mini is asleep one night, the site stays up and serves the previous
board. Only freshness depends on the mini, never availability.

---

## Setup

Everything runs on free services. You need two free accounts (Cloudflare and
GitHub) and about 20 minutes. **No terminal required** — GitHub Actions does the
deploying and the nightly refresh for you.

### Why GitHub Actions rather than your own machine

The nightly job needs open internet access to reach FantasyCalc, KeepTradeCut
and Cloudflare's API, and it needs to run on a schedule. GitHub's runners give
you both for free and don't require your computer to be awake. They also deploy
the site, so Cloudflare's API token never has to live on your laptop.

### 1. Cloudflare

1. Sign up at <https://dash.cloudflare.com/sign-up> (free, no card).
2. **Workers & Pages** in the sidebar → note your **Account ID** from the right
   panel. You'll need it in step 3.
3. **Storage & Databases → KV → Create a namespace**, name it `VALUES`. Copy the
   namespace ID and paste it into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
4. Create an API token: **My Profile → API Tokens → Create Token → Edit
   Cloudflare Workers** template. Save the token somewhere for step 3.

### 2. GitHub

1. Sign up at <https://github.com/signup> (free).
2. Create a new repository — **public** is recommended, because Actions minutes
   are unlimited on public repos and scheduled workflows are unrestricted there.
   The repo holds only code; no values and no secrets go in it.
3. Push this project to it.

### 3. Repository secrets

In the repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add four:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 1.2 |
| `WORKER_URL` | `https://dynasty-values.<your-subdomain>.workers.dev` (you'll know this after the first deploy — add it then) |
| `INGEST_TOKEN` | any long random string; also set it on the Worker, see below |

The ingest token is the shared password the pipeline uses to publish boards. It
has to match on both sides. Generate one at
<https://www.random.org/strings/?num=1&len=32&digits=on&loweralpha=on&format=plain>
or any password generator.

### 4. First deploy

**Actions** tab → **Deploy site** → **Run workflow**. It runs the tests, then
deploys. When it finishes, the log prints your URL — something like
`https://dynasty-values.yourname.workers.dev`. Add that as the `WORKER_URL`
secret now.

Then set the ingest token on the Worker side. In the Cloudflare dashboard:
**Workers & Pages → dynasty-values → Settings → Variables and Secrets → Add** a
secret named `INGEST_TOKEN` with the same value you used in the GitHub secret.

### 5. First value refresh

**Actions** tab → **Refresh values** → **Run workflow**. Takes a few minutes; it
fetches every source and publishes 30 boards covering every common league shape.

After this it runs itself every night at 5:20am Eastern.

### 6. Open the site

Visit your Worker URL, type in your Sleeper username, pick your league. Done.

> **Optional — lock it down.** By default the URL is public to anyone who has
> it. To require a login (free, 50 users): Cloudflare dashboard → **Zero Trust**
> → choose the **Free** plan → **Access → Applications → Add an application →
> Self-hosted** → set the domain to your `workers.dev` hostname → add a policy
> allowing your email. Then add a second policy with action **Bypass** for the
> path `/api/ingest/*` so the nightly job can still publish.

### Running the pipeline locally instead (optional)

If you'd rather refresh values from your own machine — which scrapes KTC from
your residential IP rather than GitHub's — install Node 20+, then:

```bash
cp pipeline/config.example.json pipeline/config.json   # fill in workerUrl + ingestToken
npm install
npm run pipeline:dry     # compute everything, publish nothing
npm run pipeline         # for real
```

`scripts/com.dynastyvalues.pipeline.plist` schedules that nightly on macOS; see
the comments inside it. Note this only works from a real Terminal on macOS, not
from a sandboxed shell.

## How the blending works

This is the part most multi-source tools get wrong, so it's worth understanding.

Every source publishes on a 0–10000-ish scale, which makes the numbers look
directly comparable. **They are not.** The *shape* of each curve differs — one
source might put its #1 asset 12% above its #5, another 25% above. Average the
raw numbers and the source with the steepest curve quietly dominates the blend
at the top of the board, while the flattest one dominates the middle. You would
never notice, and every trade involving an elite player would be skewed.

So we take only the **ordering** from each source and the **magnitude** from a
consensus curve all sources vote on:

1. Rank every asset within each source.
2. Rescale each source so its top asset is 10000.
3. For each rank N, take the **median** across sources of that rescaled value.
   That series is the consensus curve — one answer to "what is the Nth best
   dynasty asset worth?". Median, not mean, so one weird source can't drag it.
4. Re-price every asset as `curve(its rank in that source)`.
5. Blend those re-priced values with your configured weights.

A source now influences a player only through where it ranks them — the thing
sources actually measure — and their arbitrary scale choices drop out entirely.

**Tuning weights.** `weights` in `config.json` scales each source's vote. If you
think FantasyCalc's real-trade data beats expert consensus, try
`{"ktc": 1, "fantasycalc": 1.5, "dynastyprocess": 0.75}`. Re-run the pipeline to
apply. Weights never affect the consensus curve, only the blend.

**Picks** are collapsed to round level (`2027 1st`) rather than kept at
early/mid/late, because final draft order is unknown and that's also exactly how
Sleeper models traded picks.

---

## The KTC question

KeepTradeCut has no API and their FAQ states plainly that scraping is
"expressly forbidden by our Terms and Conditions", as is "using full KTC values
in tools/resources, or reproducing our rankings and player values in their
entirety."

This tool is built so that running it is a decision you make knowingly:

- The collector runs **only** on your machine, never on Cloudflare.
- Values are stored in your private KV and served **only** behind Cloudflare
  Access. Nothing is redistributed or made public.
- `--no-ktc` skips it entirely, and the blend degrades gracefully to the two
  fully-open sources.

Realistically the worst case is that your IP gets blocked. But it is against
their terms, not a gray area, and the honest framing is that this is a tradeoff
you're choosing rather than one the tool hides from you.

If you'd rather not, run `npm run pipeline -- --no-ktc` and set
`"weights": {"fantasycalc": 1, "dynastyprocess": 1}`. Everything still works;
you lose the market-arbitrage signal, which specifically depends on KTC being a
proxy for the price your leaguemates will transact at.

---

## Suggestions: what the heuristics actually do

Nothing here is a model. Each suggestion shows its reasoning in the UI.

- **Age stages** per position (RBs cliff early, QBs hold value for a decade).
- **Positional strength** — your top starters-plus-two at each position against
  every other roster, as a percentile.
- **Contend / rebuild** — total value rank plus how much of it is young.
- **Market arbitrage** — KTC versus the average of the *other* sources. This is
  the non-obvious one, and it runs opposite to intuition: **you sell the players
  your league thinks are better than they are.** KTC well above the others means
  the market overpays; KTC well below means it underrates.
- **Trade ideas** — sell candidates matched to buy targets of similar blended
  value, ranked by how mispriced both sides are, capped at two ideas per player
  so one guy can't monopolise the list.

---

## Cost

| Thing | Free tier | What this uses |
|---|---|---|
| Workers requests | 100,000/day | a few hundred |
| Workers static assets | free, unlimited | all page loads |
| Workers CPU | 10ms/invocation | near zero — boards served unparsed |
| KV reads | 100,000/day | a few hundred |
| KV writes | 1,000/day | ~3 per nightly run |
| Zero Trust (Access) | 50 users | 1 |
| **Total** | | **$0/month** |

A custom domain, if you ever want one, is about $10/year and purely cosmetic.

---

## Troubleshooting

**"no board has been published yet"** — run `npm run pipeline` on the mini.

**Banner says the format doesn't match** — add your league's format key to
`formats` in `config.json` and re-run.

**KTC collector fails.** Most likely cause by far; their page structure has
changed before. The scraper tries several extraction markers and fails loudly
rather than returning garbage. Look at
`pipeline/ktc-scrape.mjs` → `MARKERS`, open
`view-source:https://keeptradecut.com/dynasty-rankings`, find the JS array of
players, and add its variable name to that list. The rest of the pipeline keeps
working without KTC in the meantime.

**Pipeline can't publish (401)** — the `INGEST_TOKEN` GitHub secret and the
`INGEST_TOKEN` Worker secret must be byte-identical. Watch for a trailing
newline or space when pasting.

**"Refresh values" workflow stopped running on its own** — GitHub disables
scheduled workflows in repositories with no activity for 60 days. Push any
commit, or open the Actions tab and re-enable it.

**Deploy fails with an authentication error** — the `CLOUDFLARE_API_TOKEN`
secret is wrong or lacks Workers permission. Recreate it with the "Edit
Cloudflare Workers" template.

**Pipeline can't publish (403 / HTML login page)** — Cloudflare Access is
intercepting the ingest path. Add a Bypass policy for `/api/ingest/*`.

**TE premium warning** — no source prices TE premium, so in those leagues tight
ends are worth more than any number here says. The banner is the honest version
of that limitation.

**Movers show "fantasycalc30d"** — normal for the first month. Blended trends
need history; the pipeline builds it one nightly run at a time in `.history/`.

---

## Tests

```bash
npm test                      # 20 unit + integration tests
node test/browser.smoke.mjs   # boots the real UI in Chromium, walks every tab
```

The suite runs against real DynastyProcess data checked into `.devdata/`, with
the other two sources synthesized from it with known distortions — so the tests
can assert that scale and curve-shape differences produce *no* change in output
and only genuine rank disagreements move anything.

The browser test mocks Sleeper and the board API, clicks through setup, every
tab, and a real trade, and fails on any console error or horizontal overflow at
390px.

---

## Limitations, stated plainly

- **No trade submission.** Sleeper's API is read-only. This values trades; you
  still execute them in the app.
- **TE premium and other exotic scoring** aren't priced by any source.
- **IDP and deep bench players** often aren't in any source; they show as
  "unvalued" and count as zero.
- **Suggestions are heuristics.** They're a shortlist to think about, not
  advice.
- **Single-source assets** are flagged `1 src` — one opinion, not a consensus.
