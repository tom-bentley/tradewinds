# Tradewinds

On-the-spot trade analyzer for a Sleeper fantasy-football league. Runs entirely in your phone's
browser, installs to the iPhone home screen like an app, costs nothing to host, and refreshes its
market data on a schedule.

- **Advisor** turns news into a decision: when a player you roster changes injury status, your
  phone gets one push that says who starts, whether (and when) he can go to IR, the best add and
  the exact drop with the points math — or "hold". The tab shows the same advice on demand.
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
- `pipeline/refresh.mjs` (Node ≥ 20, no dependencies) regenerates `data/*.json` every three hours
  and the workflow in `.github/workflows/refresh-data.yml` commits the result when it changed.
- `pipeline/alerts.mjs` is scheduled every 10 minutes: it reads live injury statuses for every
  rostered player (one current-week projections call — the rows carry Sleeper's `injury_*` fields
  and fresh points), diffs them against the last run, composes the advice, grades new completed
  trades, re-runs the deal and free-agent finders for each paired phone, sends the push
  notifications, and commits `data/advisor.json` (the feed the Advisor tab shows). GitHub runs
  cron schedules best-effort (gaps of 2–5 hours were measured), so the workflow also accepts
  `workflow_dispatch` and `repository_dispatch` from any external pinger (see News advisor).
- The engine under `src/engine/` is pure and unit-tested against fixtures snapshotted on
  2026-09-09 (`test/fixtures/`).

## Run locally

```bash
node --test "test/*.test.mjs"      # unit tests
node pipeline/refresh.mjs          # rebuild data/*.json from live sources
python -m http.server 8787         # then open http://127.0.0.1:8787/
```

## Alerts on your iPhone

Alerts are real push notifications, and on iOS they only work for a web app that has been added to
the Home Screen (iOS 16.4 or later). There is no server behind this app, so the scheduled GitHub
Action sends the notifications, and your phone's push subscription has to be stored where only that
Action can read it: a repository secret.

1. Install the app (Safari → Share → Add to Home Screen) and open it from the icon.
2. Settings → Alerts → **Enable alerts**, allow notifications, then **Copy** the pairing code.
3. On github.com open the repo → Settings → Secrets and variables → Actions and create (or edit)
   the secret `PUSH_SUBSCRIPTIONS`. Its value is a JSON array: `[<pairing code>]`, or several codes
   separated by commas for more than one phone.
4. Alerts usually begin within 10–30 minutes (GitHub can delay scheduled runs). To test
   immediately, run the **Alerts** workflow from the Actions tab with `test` checked.

You will be alerted when a player you roster changes injury status (with the recommended
course of action), when a trade completes in the league, when a new deal for your team clears
your score threshold, and when a free agent is worth a drop. Thresholds and the switches
(including "Rivals' injury news", off by default) are in Settings → Alerts; after changing them,
copy and paste the code again so the job sees the new preferences. The endpoint and keys in the
pairing code let a sender push to your phone, which is why they live in a secret and never in
the repository.

### If alerts stop

The most common failure is invisible from the sending side. Apple's push service answers `201` even
for a subscription it has already thrown away, so the GitHub job can log `3/3 sent` for days while
the phone shows nothing. Since v1.4 the app keeps its own evidence: the service worker writes a
receipt for every push it handles, and **Settings → Alerts** reads it back.

Open the app and read the status line. It says one of:

| Status line | What it means | What to do |
|---|---|---|
| `On · paired · last alert 8:11 AM` | Working. The phone displayed that one. | nothing |
| `On · paired · nothing sent yet` | Paired, the sender simply has no news. | nothing |
| `This phone's alert address changed … — re-pair` | iOS gave the app a new push address. The sender is pushing to the old one. | **Show pairing code** → paste into `PUSH_SUBSCRIPTIONS` (or set up auto re-pair, below) |
| `Subscribed, but NOT paired with the sender — re-pair` | The sender's device list does not contain this phone. | same |
| `The sender marked this phone dead — re-pair` | A push came back 404/410. | same |
| `Paired · sender delivered N alerts, none shown on this phone — check iOS notification settings` | Delivery is being suppressed on the phone. | tap **Test this phone**; see the checklist below |
| `On · paired · N alerts arrived but could not be shown` | The pushes land but the notification fails. | reopen from the Home Screen icon, then **Test this phone** |
| `On · paired 9/9 · sender not reachable` | The state file could not be read (offline). | try again online |

**Diagnose** opens the whole picture: this phone's device id, permission, whether it is installed to
the Home Screen, its iOS version, what the sender believes (paired? last sent? how many? last status
code?), when the Alerts workflow last ran, and the last ten pushes this phone actually received.

When notifications are being suppressed rather than lost, work down this list (in order of how
often it is the answer):

1. **Do Not Disturb / a Focus mode** — the single most common cause.
2. iOS Settings → Notifications → Tradewinds: Allow Notifications, Lock Screen, Banners, Sounds.
3. iOS Settings → Notifications → **Scheduled Summary**: Tradewinds must not be in a summary.
4. iOS 18.4+: per-app Apple Intelligence notification settings can delay or summarise them.
5. Re-pair (above).
6. Delete the Home Screen icon and add it again — this recreates the service worker.

`node scripts/alerts-doctor.mjs` prints the same diagnosis from a terminal, using only the public
state file and the Actions API. Add `PUSH_SUBSCRIPTIONS='<the secret>'` to have it cross-check the
paired devices (that is how a rotated endpoint shows up without touching the phone), `--local` to
read this clone's `data/alerts-state.json`, and `--json` for a machine-readable version. It cannot
see the phone, so it always ends by saying what it does **not** know.

### Auto re-pair (optional, no more copying codes)

iOS rotates a push subscription on its own schedule and does not reliably tell the page when it
happens, so a manual re-paste is a chore that recurs. If you give the app a GitHub token, the phone
re-pairs itself:

1. github.com → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
   Repository access: **only** `tom-bentley/tradewinds`. Permissions: **Actions: Read and write**
   (Metadata: Read is added automatically). Nothing else.
2. In the app: Settings → Alerts → **Auto re-pair** → paste the token → **Save**.

From then on, every time the app opens it checks its own subscription, silently re-creates it if iOS
threw it away, and — when the address has changed — sends the new pairing to the Alerts workflow
through a `repository_dispatch`. The pairing is **encrypted to the VAPID public key** before it
leaves the phone (ephemeral ECDH P-256 → HKDF-SHA256 → AES-256-GCM), the workflow opens it with
`VAPID_PRIVATE_KEY`, and only the ciphertext is stored in `data/alerts-state.json`. Nothing readable
ever reaches the public repository, and the token itself never leaves the phone except as the
`Authorization` header on that one request to api.github.com.

The token also powers **Send test alert** without leaving the app. Removing it (the **Remove**
button) puts you back to the manual paste, which never stopped working.

### Fallback channels

Web Push to one phone is a single point of failure that nobody can see fail. The optional repository
secret `ALERT_WEBHOOKS` adds channels that report their own failures — each is treated as another
device, sharing the same composition, the same de-duplication and the same state entry:

```json
["https://ntfy.sh/your-private-topic"]
[{"url":"https://discord.com/api/webhooks/…/…","label":"Discord","prefs":{"deals":false}}]
```

Discord webhooks, Slack incoming webhooks, ntfy topics and any plain JSON endpoint are recognised by
host (a plain endpoint receives `{title, body, url, tag, kind}`). A channel can carry its own
`prefs`, and inherits the league of the first paired phone unless it names `leagueId`/`userId`. No
secret means no channels and no change in behaviour.

### How noisy it is

Advice about your own players and completed trades are never throttled — they expire at kickoff.
Deal and free-agent suggestions are: at most one push per kind per 6 hours per device, and more than
one new deal in a run becomes a single digest ("3 new deals — best: …"). Those defaults
(`dealsCooldownHours`, `faCooldownHours`, `maxDealsPerPush`) are applied by the job, so a phone
paired before v1.4 is throttled without re-pasting anything.

*Future option:* Safari 18.4 / iOS 18.4 added **Declarative Web Push**, where the payload itself
describes the notification and the browser shows it with no service worker involved — which makes
the silent-push penalty structurally impossible. Tradewinds does not emit it yet.

## News advisor

The Sleeper app tells you *what happened*; the advisor tells you *what to do*. It is deterministic
— no language model, no API key — and every number comes from the same engine the trade verdicts
use:

1. **Statuses** come from Sleeper's current-week projections rows (the job) and from
   `GET /v1/players/nfl/{id}` for your own roster (the phone), never from a 15 MB dump on a timer.
2. **How long is he out** is an editable table keyed on the status, body part and notes Sleeper
   publishes ("Doubtful · Knee - Meniscus · Surgery" → likely 1–2 games with a tail to 4+). The
   injured player's future weeks are scaled by that probability when moves are graded, because
   Sleeper's own projections lag fresh news by days.
3. **Moves** are ranked: who starts in his place this week → whether he can go to IR *now* under
   your league's `reserve_allow_*` settings (and if not, which status opens the window) → the best
   free agent to add and the exact drop, or the freed IR spot → a trade angle when the hole lasts
   → "hold" when nothing on the wire beats your roster.
4. **Delivery**: one push per status transition (title = what happened, body = the moves, tap →
   Advisor tab). The Advisor tab recomputes the same advice on open, so a late push never means a
   wrong decision.

Dry run without any secret, printing what the job would send for one league and user:

```bash
ALERT_DRY=1 ALERT_DRY_LEAGUE=<leagueId> ALERT_DRY_USER=<userId> node pipeline/alerts.mjs
node scripts/alerts-doctor.mjs              # is the sender healthy, and who does it think it knows?
```

**Faster than GitHub's cron.** Any machine that is awake can fire the job to the minute:
`gh workflow run alerts.yml -R <you>/tradewinds` from a scheduled task, or from a free pinger
(cron-job.org, a Cloudflare Worker) with
`POST https://api.github.com/repos/<you>/tradewinds/dispatches` and body
`{"event_type":"alerts"}` using a fine-grained token (Contents: read, Actions: write). The job is
state-diffed, so extra runs never double-notify.

## Use it for your own league

On first launch, enter your Sleeper username and pick your league; the app remembers it. Settings
lets you switch leagues later, and a link of the form `…/tradewinds/?league=<id>&user=<username>`
opens a league directly. The scheduled pipeline is league-agnostic: it ships raw projected stat
lines, and your phone applies your league's own scoring settings, roster slots (including
superflex), playoff weeks, and trade deadline.

## Deploy your own copy (free)

```bash
gh repo create <you>/tradewinds --public --source=. --push
gh api "repos/<you>/tradewinds/pages" -X POST -f "source[branch]=main" -f "source[path]=/" -f "build_type=legacy"
gh workflow run refresh-data.yml
gh secret set VAPID_PRIVATE_KEY   # paste the private half of your VAPID key pair (never commit it)
```

Generate your own VAPID key pair with `node scripts/vapid.mjs` (or `npx web-push generate-vapid-keys`)
and put the public half in `src/config.js`.

The site appears at `https://<you>.github.io/tradewinds/` after the first Pages build.

**Releasing app changes:** bump `APP_VERSION` in `src/config.js` and the matching `CACHE` name in
`sw.js` (a unit test enforces they agree), then push. Installed phones fetch the new service
worker on their next launch and show an "Update available" toast; the scheduled data refresh
needs no release, the app fetches `data/*.json` network-first. GitHub
Pages on a free plan requires a public repository; nothing in this repo is secret (Sleeper
league ids and usernames are already public through Sleeper's API).
