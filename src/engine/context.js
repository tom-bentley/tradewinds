// src/engine/context.js — build the immutable evaluation context every other engine module reads.
// Pure: no DOM, no fetch, no Date.now(). The current week always comes from the Sleeper state
// payload so the engine is deterministic and testable.

import { DEFAULTS, LAST_SCORING_WEEK, FLEX_ELIGIBLE } from "../config.js";

/** Sleeper roster_positions entries that are not startable lineup slots. */
export const BENCH_SLOTS = Object.freeze(["BN", "IR", "TAXI"]);

/** Which player positions may fill each lineup slot. Single-entry lists are "dedicated" slots. */
export const SLOT_ELIGIBILITY = Object.freeze({
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  DL: ["DL"],
  LB: ["LB"],
  DB: ["DB"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
});

/** Settings keys whose values are objects and must be merged key-by-key, not replaced wholesale. */
const NESTED_SETTING_KEYS = ["weights", "dynastyWeights", "injuryDiscount", "finder"];

/**
 * Merge a user settings patch over DEFAULTS, one level deep for the nested option groups.
 * @param {object} [patch] user overrides (may be partial or undefined)
 * @returns {object} a plain settings object safe to mutate-free read
 */
export function mergeSettings(patch) {
  const out = { ...DEFAULTS, ...(patch || {}) };
  for (const key of NESTED_SETTING_KEYS) {
    out[key] = { ...(DEFAULTS[key] || {}), ...((patch && patch[key]) || {}) };
  }
  // shapes is an array inside finder — a patch replaces it wholesale, but keep it copyable
  out.finder.shapes = [...(out.finder.shapes || DEFAULTS.finder.shapes)];
  return out;
}

/**
 * Positions a lineup slot accepts.
 * @param {string} slot e.g. "FLEX"
 * @returns {string[]} eligible player positions ([] for unknown slots)
 */
export function slotEligibility(slot) {
  return SLOT_ELIGIBILITY[slot] || [];
}

/**
 * Normalize one Sleeper roster row.
 * @param {object} roster raw Sleeper roster
 * @param {Map<string, object>} userById users keyed by user_id
 * @returns {object} ctx-shaped roster
 */
function normalizeRoster(roster, userById) {
  const user = userById.get(roster.owner_id) || null;
  const settings = roster.settings || {};
  const meta = (user && user.metadata) || {};
  return {
    rosterId: roster.roster_id,
    ownerId: roster.owner_id || null,
    displayName: (user && user.display_name) || `Roster ${roster.roster_id}`,
    teamName: meta.team_name || (user && user.display_name) || `Roster ${roster.roster_id}`,
    avatar: meta.avatar || (user && user.avatar) || null,
    players: [...(roster.players || [])],
    starters: [...(roster.starters || [])],
    reserve: [...(roster.reserve || [])],
    taxi: [...(roster.taxi || [])],
    wins: settings.wins || 0,
    losses: settings.losses || 0,
    ties: settings.ties || 0,
    fpts: (settings.fpts || 0) + (settings.fpts_decimal || 0) / 100,
    waiverBudgetUsed: settings.waiver_budget_used || 0,
  };
}

/**
 * Players that occupy a roster spot: rostered minus IR/taxi stashes.
 * @param {object} roster ctx-shaped roster
 * @returns {string[]} active player ids
 */
export function activePlayers(roster) {
  const parked = new Set([...(roster.reserve || []), ...(roster.taxi || [])]);
  return (roster.players || []).filter((id) => !parked.has(id));
}

/**
 * Number of roster spots a team is currently using (players − reserve − taxi).
 * @param {object} roster ctx-shaped roster
 * @returns {number}
 */
export function activeCount(roster) {
  return activePlayers(roster).length;
}

/**
 * Build the engine context from pipeline data + live Sleeper payloads.
 * @param {{league:object, users:object[], rosters:object[], players:object, projections:object,
 *          values:object, schedule:object, state:object}} input
 * @param {object} [settings] user overrides merged over DEFAULTS
 * @returns {object} ctx (see design.md §4)
 */
export function buildContext(input, settings) {
  const merged = mergeSettings(settings);
  const league = input.league || {};
  const leagueSettings = league.settings || {};
  const rosterPositions = [...(league.roster_positions || [])];
  const slots = rosterPositions.filter((s) => !BENCH_SLOTS.includes(s));

  const userById = new Map();
  for (const u of input.users || []) userById.set(u.user_id, u);

  const rosters = (input.rosters || [])
    .map((r) => normalizeRoster(r, userById))
    .sort((a, b) => a.rosterId - b.rosterId);

  const rosterOf = new Map();
  for (const r of rosters) {
    for (const id of [...r.players, ...r.reserve, ...r.taxi]) {
      if (!rosterOf.has(id)) rosterOf.set(id, r.rosterId);
    }
  }

  const players = new Map();
  for (const [id, p] of Object.entries((input.players && input.players.players) || {})) {
    players.set(id, p);
  }
  const proj = new Map();
  for (const [id, vec] of Object.entries((input.projections && input.projections.players) || {})) {
    proj.set(id, vec);
  }

  const state = input.state || {};
  const rawWeek = Number(state.week) || 1;
  const week = state.season_type === "regular" ? clamp(rawWeek, 1, LAST_SCORING_WEEK) : 1;
  const weeksLeft = [];
  for (let w = week; w <= LAST_SCORING_WEEK; w += 1) weeksLeft.push(w);

  const playoffStart = Number(leagueSettings.playoff_week_start) || 15;
  const playoffWeeks = [];
  for (let w = playoffStart; w <= LAST_SCORING_WEEK; w += 1) playoffWeeks.push(w);

  const myRosterId = resolveMyRosterId(rosters, merged.userId);

  return {
    league: {
      id: league.league_id || merged.leagueId,
      name: league.name || "League",
      numTeams: Number(leagueSettings.num_teams) || rosters.length,
      rosterPositions,
      // includes BN, excludes IR/taxi (Sleeper never lists IR in roster_positions)
      maxRoster: rosterPositions.length,
      irSlots: Number(leagueSettings.reserve_slots) || 0,
      // 0 means "no deadline" in Sleeper
      tradeDeadlineWeek: Number(leagueSettings.trade_deadline) || 0,
      vetoVotesNeeded: Number(leagueSettings.veto_votes_needed) || 0,
      tradeReviewDays: Number(leagueSettings.trade_review_days) || 0,
      scoring: league.scoring_settings || {},
    },
    season: String(league.season || state.season || merged.season),
    week,
    lastWeek: LAST_SCORING_WEEK,
    weeksLeft,
    playoffWeeks,
    slots,
    flexEligible: new Set(FLEX_ELIGIBLE),
    players,
    proj,
    values: (input.values && input.values.sources) || {},
    byes: (input.schedule && input.schedule.byes) || {},
    rosters,
    rosterOf,
    myRosterId,
    settings: merged,
    memo: {},
  };
}

/**
 * The roster owned by the configured user, falling back to the first roster.
 * @param {object[]} rosters ctx-shaped rosters
 * @param {string} userId Sleeper user id
 * @returns {number|null} roster id
 */
export function resolveMyRosterId(rosters, userId) {
  if (!rosters.length) return null;
  const mine = rosters.find((r) => r.ownerId && String(r.ownerId) === String(userId));
  return mine ? mine.rosterId : rosters[0].rosterId;
}

/**
 * Look up a ctx roster by id.
 * @param {object} ctx
 * @param {number} rosterId
 * @returns {object|null}
 */
export function rosterById(ctx, rosterId) {
  return ctx.rosters.find((r) => r.rosterId === rosterId) || null;
}

/**
 * Player record or a minimal stub so the engine never throws on an unknown id.
 * @param {object} ctx
 * @param {string} id
 * @returns {object} player-ish record with at least {id, name, pos}
 */
export function playerOf(ctx, id) {
  return ctx.players.get(id) || { id, name: id, pos: null, team: null, inj: null, bye: null };
}

/**
 * Every player id currently on some roster in the league (including IR/taxi stashes).
 * @param {object} ctx
 * @returns {Set<string>}
 */
export function rosteredIds(ctx) {
  if (!ctx.memo.rosteredIds) {
    const set = new Set();
    for (const r of ctx.rosters) {
      for (const id of [...r.players, ...r.reserve, ...r.taxi]) set.add(id);
    }
    ctx.memo.rosteredIds = set;
  }
  return ctx.memo.rosteredIds;
}

/**
 * Remaining-season projected points for a player (sum of ctx.weeksLeft).
 * @param {object} ctx
 * @param {string} id
 * @returns {number}
 */
export function rosPoints(ctx, id) {
  if (!ctx.memo.rosPoints) ctx.memo.rosPoints = new Map();
  const cached = ctx.memo.rosPoints.get(id);
  if (cached !== undefined) return cached;
  const vec = ctx.proj.get(id);
  let total = 0;
  if (vec) {
    for (const w of ctx.weeksLeft) total += Number(vec[w - 1]) || 0;
  }
  ctx.memo.rosPoints.set(id, total);
  return total;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
