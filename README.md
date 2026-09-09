# Tradewinds

On-the-spot trade analyzer for a Sleeper fantasy-football league. Runs entirely in your phone's
browser, installs to the iPhone home screen like an app, costs nothing to host, and refreshes its
market data on a schedule.

- **Analyze** any offer in seconds: pick the rival, tap the players on each side, read the
  verdict (Edge %, starting-lineup points per week, playoff-weeks impact, flags, reasons).
- **Deals** ranks the trades worth proposing to every rival right now, filtered to offers the
  rival could plausibly accept.
- **League** shows standings, every roster with values, and grades completed trades.
- **Players** looks up any NFL player: consensus value with the per-source breakdown, trend,
  tier, rest-of-season points, and who owns him in your league.

## Install on iPhone

1. Open the site URL in **Safari** (not Chrome).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch from the icon. It opens full-screen, keeps working offline on the last data it saw,
   and updates itself the next time it is opened after a deploy.

Home-screen web apps are exempt from Safari's 7-day storage cleanup, so installing (rather than
bookmarking) is what makes the offline copy stick.

## How the numbers are built

Two axes, never averaged into one number:

| Axis | What it measures | Inputs |
|---|---|---|
| **Market value** | what the league pays for a player | FantasyCalc redraft (real trade data), a projection-implied value fitted to the same curve, plus a small keeper tilt toward dynasty value (FantasyCalc dynasty, DynastyProcess) |
| **Lineup value** | what a player scores for *your* starting lineup | Sleeper weekly projections through week 17 with league-exact scoring, optimal lineup per week, playoff weeks weighted ×2, bye weeks zeroed, freed roster spots back-filled from the waiver wire |

Each side of a trade is valued as **surplus over live waiver replacement**: for every player,
`max(value − best free agent at his position, 0)`, summed. In a shallow 8-team league the wire
is deep, so bench depth is nearly worthless and a 2-for-1 automatically credits the side that
consolidates. Edge % compares the two surpluses; the verdict scale is ±4 % fair, ±10 % clear,
±25 % steal/fleeced, with redraft overrides (a real lineup gain can beat a small value loss),
hard blocks (a lineup left short, a roster over the limit), and a veto warning at ±40 %.

Full methodology, sources, and citations live in the research notes of the parent project
(`specs/003-trade-analyzer/research/`).

## Data sources and credits

| Source | Used for | Terms |
|---|---|---|
| [Sleeper API](https://docs.sleeper.com/) | league, rosters, transactions, players, weekly projections, schedule | public read-only API |
| [FantasyCalc](https://fantasycalc.com/) | redraft and dynasty trade values | public API |
| [DynastyProcess](https://github.com/dynastyprocess/data) | dynasty values (`values-players.csv`) | GPL-3.0 |
| [Boris Chen](https://www.borischen.co/) | weekly half-PPR tiers | public tier files |

KeepTradeCut is deliberately **not** used: its terms of service prohibit scraping and
derivative works.

## Architecture

```
iPhone (PWA on GitHub Pages) ──live──► api.sleeper.app · api.fantasycalc.com   (both CORS-open)
        └──cached──► data/*.json  ◄── GitHub Actions cron (every 6 h) ── pipeline/refresh.mjs
```

- Static files only: `index.html`, `styles.css`, ES modules under `src/`, `sw.js`. No build step,
  no dependencies.
- `pipeline/refresh.mjs` (Node ≥ 20, no dependencies) regenerates `data/*.json` and the
  workflow in `.github/workflows/refresh-data.yml` commits the result when it changed.
- The engine under `src/engine/` is pure and unit-tested against fixtures snapshotted on
  2026-09-09 (`test/fixtures/`).

## Run locally

```bash
node --test "test/*.test.mjs"      # unit tests
node pipeline/refresh.mjs          # rebuild data/*.json from live sources
python -m http.server 8787         # then open http://127.0.0.1:8787/
```

## Use it for your own league

Open **Settings**, enter your Sleeper username, and pick your league. The league id, user id,
and value weights are stored in the browser. The scheduled pipeline builds projections with one
league's scoring (set by `TRADEWINDS_LEAGUE_ID` in the workflow), so fork the repo and change
that variable for a different league.

## Deploy your own copy (free)

```bash
gh repo create <you>/tradewinds --public --source=. --push
gh api "repos/<you>/tradewinds/pages" -X POST -f "source[branch]=main" -f "source[path]=/" -f "build_type=legacy"
gh workflow run refresh-data.yml
```

The site appears at `https://<you>.github.io/tradewinds/` after the first Pages build. GitHub
Pages on a free plan requires a public repository; nothing in this repo is secret (Sleeper
league ids and usernames are already public through Sleeper's API).
