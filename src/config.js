// Tradewinds — league + app configuration defaults.
// Everything here can be overridden from the Settings tab (persisted in localStorage under
// the STORAGE_KEY). Nothing in this file is secret: Sleeper league ids and usernames are
// public through Sleeper's read-only API.

export const APP_NAME = "Tradewinds";
export const APP_VERSION = "0.3.0";
export const STORAGE_KEY = "tradewinds.settings.v1";

/**
 * Engine + app defaults. Shape matches design.md §4 `ctx.settings`; `buildContext` deep-merges
 * the user's saved settings over this object, so a partial patch never drops a nested key.
 */
export const DEFAULTS = Object.freeze({
  // No league is baked in: Tradewinds works for ANY Sleeper league, so the id and user stay null
  // until onboarding stores them (design.md section 10.4). null is what makes data.js raise
  // SetupRequiredError and the UI show the league picker.
  leagueId: null,
  userId: null,
  username: null,
  season: "2026",

  // --- Market value blend (R3 §a) -------------------------------------------------------
  // Weights over REDRAFT-kind sources, renormalized over the sources that actually price a
  // given player. `proj` is the synthetic curve source A·exp(-k·rank) fitted each run.
  // KTC is excluded from v1 (no CORS-friendly, license-clean feed), so its 0.25 is folded
  // into FantasyCalc, the only source measured on real redraft-shaped trades.
  weights: Object.freeze({ fc_redraft: 0.8, proj: 0.2 }),
  // Weights over DYNASTY-kind sources (used for the keeper tilt only).
  dynastyWeights: Object.freeze({ fc_dynasty: 0.7, dp_dynasty: 0.3 }),
  keeperTilt: 0.15, // φ — how much dynasty value nudges market value (1 keeper of 17 spots)
  rho: 1.0, // ρ — how much of the waiver replacement value is subtracted from each player
  playoffWeight: 2.0, // ω — weeks 15-17 count this much more in lineup deltas

  // Market-axis injury haircut (R3 §d). The lineup axis already handles absences via wk[].
  injuryDiscount: Object.freeze({
    Questionable: 0.03,
    Doubtful: 0.1,
    Out: 0.15,
    IR: 0.35,
    PUP: 0.4,
    NA: 0.4,
    Sus: 0.25,
    DNR: 0.4,
  }),
  // Share of the haircut the MARKET legs (FantasyCalc, DynastyProcess) still take. Real-trade
  // prices re-price an injury within days, so the full δ applies only to the projection-curve leg
  // (design §13.9); 1.0 restores the R3 rule of haircutting the whole blend.
  injuryMarketShare: 0.35,

  // --- Free agents (design.md §11.2) ------------------------------------------------------
  // The wire is the cheapest trade there is: every add is measured on the same lineup axis as a
  // trade, so "worth dropping someone for" is one number, not a vibe.
  freeAgents: Object.freeze({
    maxResults: 12,
    minGainPerWeek: 0.5, // below half a point per week an add is not worth a roster spot
    valueWeight: 0.05, // κ_v in FaScore = ΔL_pw + κ_v · valueDelta/100
    // §13.5 D3. The lineup gain alone made every 1QB wire read "add a quarterback": a QB2 filled
    // the QB1's bye against an EMPTY slot. Streaming (below) fixes the gain; these two weights
    // price the other half of the question — what the add covers, and how likely he is to break.
    insuranceWeight: 0.4, // κ_i (R5 §5.6, range 0.30–0.60): handcuff EV is only ~0.3–0.4 pts/wk
    insuranceCap: 1, // R5 §4: 42% of round-1/2 RB handcuffs make ZERO starts — cap the credit
    riskWeight: 0.4, // κ_r (R5 §5.6, range 0.33–0.50): SD coefficients run ⅓–½ of points coefficients
    consensusTierGap: 2, // |Boris Chen tier − projection-implied tier| that earns a "why" line
    // R5 §5.8 check 7: when the wire's best body at a position is this close to the roster's own
    // starter, depth at that position is not worth paying for — say so instead of ranking it.
    streamableShare: 0.8,
  }),

  // --- iOS alerts (design.md §11.3) -------------------------------------------------------
  // Defaults for the pairing payload src/push.js ships to the alerts job; the thresholds keep a
  // 30-minute cron from pushing noise.
  alerts: Object.freeze({
    trades: true,
    deals: true,
    freeAgents: true,
    // v1.3 (design §12.5). Advice on MY players is the whole point of the release, so it ships
    // on; a rival's injury is interesting, not actionable, so it ships off and is opt-in.
    advice: true,
    rivalNews: false,
    minDealScore: 2, // FinderScore floor for "a new deal worth proposing"
    minFaGain: 1, // pts/week floor for "a free agent worth a drop"
  }),

  // --- Injury duration table (design §12.2) -------------------------------------------------
  // How long a player is out is the one judgement call in the advisor, so it is a setting rather
  // than a constant. `null` means "use the engine's built-in INJURY_RULES" (src/engine/
  // injuries.js) — a future Settings screen can write a replacement table here without any
  // change to the engine.
  injuryTable: null,

  // --- Trade finder (R3 §f) --------------------------------------------------------------
  finder: Object.freeze({
    shapes: Object.freeze(["1-1", "2-1", "1-2", "2-2"]), // "<#I give>-<#I get>"
    maxResults: 10,
    perRival: 2,
    maxCandidates: 50000,
    minMyEdgePct: -10, // stage 2: reject offers that are already a clear loss for me
    rivalSurplusTolerance: 0.03, // stage 2: rival may lose 3% of what they send
    rivalMinEdgePct: -2, // stage 5: value floor for a "likely" acceptance
    rivalMinDeltaPerWeek: 0.75, // stage 5: lineup gain that buys a "possible" acceptance
    // A rival reads two numbers too. Fair value alone is not enough if their own starting
    // lineup collapses, so acceptance is tiered rather than boolean.
    acceptLikelyMaxLineupLoss: 1.5, // likely: they may lose at most this many pts/week
    acceptPossibleMaxLineupLoss: 6, // possible: a fair-value deal survives a loss this deep
    acceptPossibleMinEdge: -6, // possible: a lineup-driven deal survives a value loss this deep
    likelyBonus: 0.5, // FinderScore bonus for an offer they are likely (not merely able) to take
    valueWeight: 0.05, // κ_v in FinderScore = ΔL_pw + κ_v · Edge%
  }),

  // --- Availability-scaled lineup axis (§13.5 D1) -------------------------------------------
  // Sleeper's future-week projections do not encode fresh news: the morning after meniscus
  // surgery Bowers still projected 13.07 for week 2. The advisor already knew how to discount a
  // scenario (injuries.js `absenceOf` + `availability`); D1 moves that discount into the lineup
  // axis itself, so every consumer — trades, the wire, the finder — sees the same expected
  // points. `false` restores the old "zero the current week only" rule.
  availability: Object.freeze({
    scaleFutureWeeks: true,
  }),

  // --- Streaming credit for empty starting slots (§13.5 D2, calibrated by R5 §5.5) ------------
  // The wire is never empty. An open QB/K/DEF slot in a bye week is worth what the best free
  // agent at that position scores that week, times a friction factor for the roster spot, the
  // claim and the guess — NOT zero. Without this a QB2 in a 1QB league is credited ~18 points
  // for the QB1's bye and out-ranks every real starter upgrade.
  streaming: Object.freeze({
    enabled: true,
    friction: 0.85, // fallback for a position the table below does not name (design §13.5 D2)
    // R5 §5.5: friction is POSITIONAL. A streamed QB lands within 2–3 pts of the average QB5
    // while fewer than ~25 QBs are claimed league-wide, and Boyball claims 8–12 — so the wire
    // QB is nearly a real QB1 here. A mid-week RB/WR add rarely inherits a role at once.
    frictionByPos: Object.freeze({ QB: 0.9, TE: 0.8, DEF: 0.75, K: 0.7, RB: 0.6, WR: 0.6 }),
    positions: Object.freeze(["QB", "TE", "K", "DEF", "RB", "WR"]),
    // R5 §5.5 rule 2: one waiver run a week and a full roster make three free streams fiction.
    maxSlotsPerWeek: 2,
  }),

  // --- Risk model (§13.5 D4, src/engine/risk.js) ---------------------------------------------
  // Calibrated from WS-E's research/R5-analyzer-strategies.md §5 — every value below cites the
  // subsection it came from. Replace values, not the shape: risk.js reads this block key by key.
  risk: Object.freeze({
    // λ in certaintyEquivalent = weekly.mean − λ · weekly.sd. R5 §5.6 (range 0.15–0.35): equal-mean
    // consistent rosters win ~2.5 pp more matchups ⇒ ≈1.75 pts/wk over an ASSUMED 7-pt roster-SD
    // gap. That SD gap is the uncertain input — see the derivation note in risk.js.
    lambda: 0.25,
    zFloor: 0.84, // floor/ceiling = p20/p80 ≈ mean × (1 ∓ z·cv) (R5 §3.5, normal approximation)
    // R5 §5.1: weekly coefficient of variation, prior. K and DEF are derived, not published.
    positionCv: Object.freeze({ QB: 0.38, RB: 0.58, WR: 0.62, TE: 0.66, K: 0.5, DEF: 0.85 }),
    cvPriorGames: 6, // R5 §5.1 shrinkage: cv = (n·cv_obs + 6·cv_prior)/(n + 6), played weeks only
    minHistoryGames: 6, // below this the row is labelled "prior" even though the blend still runs
    // R5 §5.3: weekly P(miss) for a healthy player with no active status. K/DEF are derived.
    baseMissRate: Object.freeze({ QB: 0.118, RB: 0.176, WR: 0.13, TE: 0.13, K: 0.02, DEF: 0 }),
    // R5 §5.4: individual games-missed history is a WEAK predictor (team AGL year-over-year
    // r = 0.33, no individual games-missed/ΔPPG association), so one season shrinks ~50/50.
    historyShrinkGames: 17,
    // R5 §5.4: the real signal is the injury TYPE. Hamstring reinjury runs 33% (27% same season).
    injuryTypeMultiplier: Object.freeze({ softTissue: 1.3, jointHigh: 1.15 }),
    softTissueTokens: Object.freeze(["hamstring", "groin", "calf", "quad"]),
    jointHighTokens: Object.freeze(["high ankle", "shoulder", "ac joint"]),
    // R5 §5.2: the durability curve bends at the knee and the penalty doubles at the cliff.
    // QB 32 is the pocket-passer number; players.json cannot see rush share, so we use it for all.
    ageKnee: Object.freeze({ QB: 32, RB: 27, WR: 29, TE: 30, K: 99, DEF: 99 }),
    ageCliff: Object.freeze({ QB: 36, RB: 30, WR: 32, TE: 34, K: 99, DEF: 99 }),
    ageSlope: 0.03, // miss rate added at the knee (engine-chosen magnitude; R5 §5.2 gives direction)
    ageCvWiden: 0.15, // R5 §5.2 says age WIDENS the band as well; the size is engine-chosen
    rookieMissRate: 0.02, // engine-chosen: a first-year body has no NFL durability record at all
    // Depth-chart order (players.json `dc`): a backup is one snap from relevance and one from zero.
    depthPenalty: Object.freeze({ starter: 0, backup: 0.5, deep: 0.8, unknown: 0.25 }),
    // How playerRisk.score mixes its components, renormalized over the ones that are knowable for
    // a given player. Engine-chosen mix; R5 §5.6 pins the BANDS and the anchors it must satisfy.
    weights: Object.freeze({ availability: 0.4, durability: 0.2, volatility: 0.2, depth: 0.1, value: 0.1 }),
    rosterWeights: Object.freeze({ fragility: 0.45, volatility: 0.35, cover: 0.2 }),
    fragilityScale: 8, // engine-chosen: expectedLossPerWeek that reads as "fully exposed"
    cvScale: 0.3, // engine-chosen: weekly lineup CV that reads as "fully volatile"
    // R5 §5.6: low <25, moderate 25–50, high 50–75, severe ≥75. Anchors — a season-ending status
    // must land ≥90, a healthy 17-game WR1 under 29 with cv ≤0.55 must land <25.
    bands: Object.freeze({ low: 25, moderate: 50, high: 75 }),
    worst: 5, // how many players rosterFragility names
  }),
});

export const SLEEPER = Object.freeze({
  base: "https://api.sleeper.app",
  v1: "https://api.sleeper.app/v1",
  cdn: "https://sleepercdn.com",
  playerThumb: (id) => `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`,
  teamLogo: (team) => `https://sleepercdn.com/images/team_logos/nfl/${String(team).toLowerCase()}.png`,
  // Sleeper stores either an avatar hash or (for custom uploads) a full URL in `avatar`.
  avatar: (id) => (/^https?:\/\//.test(String(id)) ? String(id) : `https://sleepercdn.com/avatars/thumbs/${id}`),
  trendingLookbackHours: 24,
});

/**
 * VAPID public key for Web Push (design.md §11.1). Public by design: it is handed to the browser
 * as `applicationServerKey` and travels in every subscription, so it is not a secret. The private
 * half never enters this repo — it lives in the GitHub secret `VAPID_PRIVATE_KEY`, which is what
 * the alerts workflow signs with. Generated 2026-09-09.
 */
export const VAPID_PUBLIC_KEY =
  "BHRrun9caaSWpO0KOYVBrEHU7lo0SJ2qNQ203fkbMP24VIyZTa1Rssxk2XpiFekMscVSUBlj6TakzQ8Xu0l5CQo";

export const FANTASYCALC = Object.freeze({
  // params are derived from league settings at runtime (numTeams, ppr, numQbs)
  base: "https://api.fantasycalc.com/values/current",
});

// Fantasy-relevant positions. K/DEF are lineup slots but never trade pieces.
export const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DEF"]);
export const TRADEABLE = Object.freeze(["QB", "RB", "WR", "TE"]);
export const FLEX_ELIGIBLE = Object.freeze(["RB", "WR", "TE"]);

// Injury statuses that zero a player's weekly projection until Sleeper clears them.
export const OUT_STATUSES = Object.freeze(["Out", "IR", "PUP", "Sus", "DNR", "NA"]);

/**
 * @deprecated Season shape is derived per league in buildContext (playoff_week_start,
 * playoff_teams, playoff_round_type) - read `ctx.lastWeek` instead. Kept as the fallback for
 * leagues that run no playoffs at all, and exported for backwards compatibility.
 */
export const LAST_SCORING_WEEK = 17;

/** Sleeper's season never runs past week 18. */
export const MAX_WEEK = 18;

/** Lineup slots the engine cannot score (no IDP projections): ignored in lineup math and
 *  reported in `ctx.unsupported` so the UI can say so. */
export const IDP_SLOTS = Object.freeze(["DL", "LB", "DB", "IDP_FLEX"]);

/** A sample league for scripts and manual runs (8-team half-PPR, 1QB), verified via
 *  api.sleeper.app 2026-09-09. Not a default: DEFAULTS ships empty so any league can load. */
export const SAMPLE_LEAGUE = Object.freeze({
  leagueId: "1394476745138147328",
  userId: "1394551386997272576", // tommyteez
  username: "tommyteez",
  season: "2026",
});
