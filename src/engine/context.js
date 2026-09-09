// src/engine/context.js — build the immutable evaluation context every other engine module reads.
// Pure: no DOM, no fetch, no reading of the wall clock. The current week comes from the Sleeper
// payload so the engine is deterministic and testable.
//
// Nothing here is league-specific: scoring, season shape, lineup slots and roster limits are all
// derived from the league payload, so ANY Sleeper league builds a working ctx (design.md §10.3).

import { DEFAULTS, FLEX_ELIGIBLE, IDP_SLOTS, LAST_SCORING_WEEK, MAX_WEEK } from "../config.js";

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

/** roster_positions entries that count as a starting quarterback for value-table selection. */
export const QB_SLOTS = Object.freeze(["QB", "SUPER_FLEX"]);

/** Sleeper's "no trade deadline" sentinel (older leagues use 0 for the same thing). */
export const NO_DEADLINE = 99;

/** Settings keys whose values are objects and must be merged key-by-key, not replaced wholesale. */
const NESTED_SETTING_KEYS = ["weights", "dynastyWeights", "injuryDiscount", "finder", "freeAgents", "alerts"];

/** Sleeper `waiver_type` for a FAAB league (0 = rolling/reverse standings, 1 = reverse, 2 = FAAB). */
export const FAAB_WAIVER_TYPE = 2;

/** Sleeper's default free-agent claim window, in days, when the league does not say. */
export const DEFAULT_WAIVER_CLEAR_DAYS = 1;

/** Sleeper's default FAAB budget when the league does not say. */
export const DEFAULT_WAIVER_BUDGET = 100;

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
    coOwners: [...(roster.co_owners || [])],
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
  const parked = new Set([...((roster && roster.reserve) || []), ...((roster && roster.taxi) || [])]);
  return ((roster && roster.players) || []).filter((id) => !parked.has(id));
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
 * Inclusive week range.
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
function range(from, to) {
  const out = [];
  for (let w = from; w <= to; w += 1) out.push(w);
  return out;
}

/**
 * How long this league's season actually runs, from its own settings (design.md §10.3).
 * A league with no playoffs scores through week 17; a two-week-rounds bracket can run to 18.
 * Everything downstream (weeksLeft, playoff weighting, lineup sweeps) reads these.
 * @param {object} leagueSettings raw Sleeper `league.settings`
 * @returns {{playoffStart:number, rounds:number, roundType:number, playoffWeekCount:number,
 *            lastWeek:number, playoffWeeks:number[]}}
 */
export function seasonShape(leagueSettings = {}) {
  const start = Number(leagueSettings.playoff_week_start);
  if (!Number.isFinite(start) || start <= 0) {
    // 0 means "no playoffs" in Sleeper — the regular season is the whole season.
    return {
      playoffStart: 0,
      rounds: 0,
      roundType: 0,
      playoffWeekCount: 0,
      lastWeek: LAST_SCORING_WEEK,
      playoffWeeks: [],
    };
  }
  const teams = Number(leagueSettings.playoff_teams);
  // byes are allowed: 6 teams is a 3-round bracket with two first-round byes
  const rounds = Number.isFinite(teams) && teams > 1 ? Math.ceil(Math.log2(teams)) : 3;
  const roundType = Number(leagueSettings.playoff_round_type) || 0;
  // 0 = one week per round · 1 = two-week championship · 2 = every round is two weeks
  const playoffWeekCount = roundType === 2 ? rounds * 2 : roundType === 1 ? rounds + 1 : rounds;
  const lastWeek = Math.min(MAX_WEEK, start + playoffWeekCount - 1);
  return {
    playoffStart: start,
    rounds,
    roundType,
    playoffWeekCount,
    lastWeek,
    playoffWeeks: range(Math.min(start, lastWeek), lastWeek),
  };
}

/**
 * Points multiplier per stat key for this league, indexed the way projections v2 indexes them.
 * A key the league does not score is worth 0 (design.md §10.1).
 * @param {string[]} keys the projections file's stat vocabulary
 * @param {object} scoring league `scoring_settings`
 * @returns {number[]}
 */
export function scoringMultipliers(keys, scoring) {
  return (keys || []).map((key) => {
    const v = Number((scoring || {})[key]);
    return Number.isFinite(v) ? v : 0;
  });
}

/**
 * Turn a projections payload into weekly fantasy points for THIS league.
 * v2 ships raw stat lines (`{version: 2, keys, players: {id: [weekEntry × 18]}}`) where a week
 * entry is `0` or a flat `[keyIdx, value, …]` pair list; points are Σ value × scoring[key].
 * v1 (`players: {id: [number × 18]}`) is already league points and passes straight through, so
 * the old fixtures keep working.
 * @param {object} projections
 * @param {object} scoring league `scoring_settings`
 * @returns {Map<string, number[]>} id → weekly points, index 0 = week 1
 */
export function projectionPoints(projections, scoring) {
  const proj = new Map();
  const rows = (projections && projections.players) || {};
  const keys = projections && Array.isArray(projections.keys) ? projections.keys : null;
  const isV2 = Number(projections && projections.version) >= 2 || !!keys;
  if (!isV2) {
    for (const [id, vec] of Object.entries(rows)) {
      proj.set(id, (vec || []).map((n) => Number(n) || 0));
    }
    return proj;
  }
  const mult = scoringMultipliers(keys, scoring);
  for (const [id, weeks] of Object.entries(rows)) {
    const list = weeks || [];
    const out = new Array(list.length);
    for (let w = 0; w < list.length; w += 1) {
      const entry = list[w];
      let pts = 0;
      if (Array.isArray(entry)) {
        for (let i = 0; i + 1 < entry.length; i += 2) {
          const m = mult[entry[i]];
          if (m) pts += Number(entry[i + 1]) * m;
        }
      }
      out[w] = pts;
    }
    proj.set(id, out);
  }
  return proj;
}

/**
 * Split a league's roster_positions into the slots the engine can score and the ones it cannot.
 * IDP slots have no projections in any free feed, so they are ignored rather than guessed at, and
 * named in `ctx.unsupported` for the UI (design.md §10.3).
 * @param {string[]} rosterPositions
 * @returns {{slots:string[], unsupported:string[], flexEligible:string[]}}
 */
export function resolveSlots(rosterPositions) {
  const slots = [];
  const unsupported = [];
  let idp = false;
  for (const slot of rosterPositions || []) {
    if (BENCH_SLOTS.includes(slot)) continue;
    if (IDP_SLOTS.includes(slot)) {
      idp = true;
      continue;
    }
    if (!slotEligibility(slot).length) {
      const label = `${slot} slots`;
      if (!unsupported.includes(label)) unsupported.push(label);
      continue;
    }
    slots.push(slot);
  }
  if (idp) unsupported.unshift("IDP slots");

  // Flex eligibility is whatever this league's multi-position slots actually accept: a SUPER_FLEX
  // league flexes quarterbacks, a WRRB_FLEX league does not flex tight ends.
  const flex = new Set();
  for (const slot of slots) {
    const elig = slotEligibility(slot);
    if (elig.length > 1) for (const pos of elig) flex.add(pos);
  }
  return { slots, unsupported, flexEligible: flex.size ? [...flex] : [...FLEX_ELIGIBLE] };
}

/**
 * Build the engine context from pipeline data + live Sleeper payloads.
 * @param {{league:object, users:object[], rosters:object[], players:object, projections:object,
 *          values:object, schedule:object, state:object, transactions?:object[],
 *          trending?:object[], now?:number}} input `transactions`, `trending` and `now` are
 *   optional (design.md §11.2): absent → [], [] and null.
 * @param {object} [settings] user overrides merged over DEFAULTS
 * @returns {object} ctx (see design.md §4 and §10.3)
 */
export function buildContext(input, settings) {
  const merged = mergeSettings(settings);
  const league = input.league || {};
  const leagueSettings = league.settings || {};
  const scoring = league.scoring_settings || {};
  const rosterPositions = [...(league.roster_positions || [])];
  const { slots, unsupported, flexEligible } = resolveSlots(rosterPositions);

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
  const proj = projectionPoints(input.projections, scoring);

  const season = seasonShape(leagueSettings);
  const lastWeek = season.lastWeek;

  const state = input.state || {};
  const rawWeek = Number(state.week) || 1;
  const inSeason = state.season_type == null || state.season_type === "regular" || state.season_type === "post";
  const week = inSeason ? clamp(rawWeek, 1, lastWeek) : 1;

  const rawDeadline = Number(leagueSettings.trade_deadline);
  // Sleeper writes 99 (and older leagues 0) for "trades never close"
  const tradeDeadlineWeek =
    Number.isFinite(rawDeadline) && rawDeadline > 0 && rawDeadline < NO_DEADLINE ? rawDeadline : 0;

  return {
    league: {
      id: league.league_id || merged.leagueId || null,
      name: league.name || "League",
      numTeams: Number(leagueSettings.num_teams) || rosters.length,
      rosterPositions,
      // includes BN, excludes IR/taxi (Sleeper usually omits both from roster_positions)
      maxRoster: rosterPositions.filter((s) => s !== "IR" && s !== "TAXI").length,
      irSlots: Number(leagueSettings.reserve_slots) || 0,
      taxiSlots: Number(leagueSettings.taxi_slots) || 0,
      tradeDeadlineWeek,
      // 0 means the commissioner reviews trades instead of the league voting on them
      vetoVotesNeeded: Number(leagueSettings.veto_votes_needed) || 0,
      tradeReviewDays: Number(leagueSettings.trade_review_days) || 0,
      scoring,
      // Waiver rules, normalized off `league.settings` for waiver.js (design.md §11.2):
      // waiverType 2 = FAAB (the only mode with a bid to suggest), waiverClearDays = how long a
      // dropped player sits on waivers before he is a $0 instant add.
      waiverType: Number(leagueSettings.waiver_type) || 0,
      waiverBudget: numberOr(leagueSettings.waiver_budget, DEFAULT_WAIVER_BUDGET),
      waiverClearDays: numberOr(leagueSettings.waiver_clear_days, DEFAULT_WAIVER_CLEAR_DAYS),
      // QB + SUPER_FLEX: what FantasyCalc calls numQbs, and what picks the value tables (§10.2)
      numQbs: rosterPositions.filter((s) => QB_SLOTS.includes(s)).length,
      ppr: Number(scoring.rec) || 0,
      playoffStart: season.playoffStart,
      playoffRounds: season.rounds,
      playoffRoundType: season.roundType,
    },
    season: String(league.season || state.season || merged.season || ""),
    week,
    lastWeek,
    weeksLeft: range(week, lastWeek),
    playoffWeeks: season.playoffWeeks,
    slots,
    flexEligible: new Set(flexEligible),
    unsupported,
    players,
    proj,
    values: (input.values && input.values.sources) || {},
    byes: (input.schedule && input.schedule.byes) || {},
    rosters,
    rosterOf,
    // null when the configured user does not play in this league — viewer mode (§10.3)
    myRosterId: resolveMyRosterId(rosters, merged.userId),
    // League moves, normalized by data.js `getTransactions` (design.md §11.2). Absent → [], and
    // every waiver read degrades to "free, status unknown" rather than throwing.
    transactions: Array.isArray(input.transactions) ? input.transactions : [],
    // Sleeper trending adds: [{ player_id, count }] over the last 24 h. Absent → [].
    trending: Array.isArray(input.trending) ? input.trending : [],
    // Injected wall clock (ms). The engine never reads the clock itself — the caller owns it, so
    // every waiver window is reproducible in a test. null = no clock, nothing is on waivers.
    now: resolveNow(merged.now, input.now),
    settings: merged,
    memo: {},
  };
}

/**
 * The clock the waiver window is measured against: an explicit settings override first, then the
 * input payload, then nothing (design.md §11.2).
 * @param {number|null|undefined} fromSettings
 * @param {number|null|undefined} fromInput
 * @returns {number|null} epoch milliseconds
 */
export function resolveNow(fromSettings, fromInput) {
  for (const candidate of [fromSettings, fromInput]) {
    if (candidate == null) continue;
    const ms = Number(candidate instanceof Date ? candidate.getTime() : candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Numeric league setting with a fallback for absent/garbage values (0 is a legal answer, so `||`
 * is not good enough: `waiver_clear_days: 0` means "no waiver window at all").
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The roster owned (or co-owned) by the configured user.
 * @param {object[]} rosters ctx-shaped rosters
 * @param {string|null} userId Sleeper user id
 * @returns {number|null} roster id, or null when the user is not in this league (viewer mode)
 */
export function resolveMyRosterId(rosters, userId) {
  if (!rosters || !rosters.length || userId == null || userId === "") return null;
  const uid = String(userId);
  const mine = rosters.find(
    (r) =>
      (r.ownerId != null && String(r.ownerId) === uid) ||
      (r.coOwners || []).some((co) => String(co) === uid)
  );
  return mine ? mine.rosterId : null;
}

/**
 * Look up a ctx roster by id.
 * @param {object} ctx
 * @param {number|null} rosterId
 * @returns {object|null}
 */
export function rosterById(ctx, rosterId) {
  if (rosterId == null) return null;
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
