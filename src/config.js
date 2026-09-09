// Tradewinds — league + app configuration defaults.
// Everything here can be overridden from the Settings tab (persisted in localStorage under
// the STORAGE_KEY). Nothing in this file is secret: Sleeper league ids and usernames are
// public through Sleeper's read-only API.

export const APP_NAME = "Tradewinds";
export const APP_VERSION = "0.1.0";
export const STORAGE_KEY = "tradewinds.settings.v1";

export const DEFAULTS = Object.freeze({
  // Boyball 🏈 — 8-team half-PPR, 1QB, verified via api.sleeper.app 2026-09-09
  leagueId: "1394476745138147328",
  userId: "1394551386997272576", // tommyteez
  username: "tommyteez",
  season: "2026",

  // Consensus weights (renormalized over the sources present for a player). Redraft-heavy:
  // this is a 1-keeper league, so dynasty value is shown as "keeper value", not blended.
  weights: {
    fc_redraft: 0.5,
    ktc_redraft: 0.3,
    proj: 0.2, // projection-implied value (ROS VORP mapped onto the consensus curve)
  },
  keeperWeight: 0.1, // how much dynasty value nudges the verdict (0 = ignore)
  playoffWeight: 1.5, // weeks 15-17 count this much more in lineup deltas
  riskAversion: 1.0, // >1 penalizes injured/volatile players harder
  finder: {
    shapes: ["1-1", "2-1", "1-2", "2-2"],
    maxPerRival: 5,
    rivalTolerance: 0.04, // rival may lose up to 4% adjusted value and still "plausibly accept"
    minMyGainPts: 1.0, // pts/week in my starting lineup
  },
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
