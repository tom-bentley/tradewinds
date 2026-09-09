// Tradewinds — league + app configuration defaults.
// Everything here can be overridden from the Settings tab (persisted in localStorage under
// the STORAGE_KEY). Nothing in this file is secret: Sleeper league ids and usernames are
// public through Sleeper's read-only API.

export const APP_NAME = "Tradewinds";
export const APP_VERSION = "0.1.0";
export const STORAGE_KEY = "tradewinds.settings.v1";

/**
 * Engine + app defaults. Shape matches design.md §4 `ctx.settings`; `buildContext` deep-merges
 * the user's saved settings over this object, so a partial patch never drops a nested key.
 */
export const DEFAULTS = Object.freeze({
  // Boyball 🏈 — 8-team half-PPR, 1QB, verified via api.sleeper.app 2026-09-09
  leagueId: "1394476745138147328",
  userId: "1394551386997272576", // tommyteez
  username: "tommyteez",
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
});

export const SLEEPER = Object.freeze({
  base: "https://api.sleeper.app",
  v1: "https://api.sleeper.app/v1",
  cdn: "https://sleepercdn.com",
  playerThumb: (id) => `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`,
  teamLogo: (team) => `https://sleepercdn.com/images/team_logos/nfl/${String(team).toLowerCase()}.png`,
  avatar: (id) => `https://sleepercdn.com/avatars/thumbs/${id}`,
  trendingLookbackHours: 24,
});

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

export const LAST_SCORING_WEEK = 17; // week 18 never scores in this league (playoffs 15-17)
