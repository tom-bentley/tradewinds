// src/engine/seasonmap.js — the season axis (004 design §3.5; contract R9 §Q9.5 verbatim).
//
// Everything before this module answered "is this roster good?". The season map answers the only
// question a manager actually asks: "do I win THIS week, what is stopping me, and what is the
// cheapest thing that changes the answer?" — fifteen times, then once more for the season.
//
// Three honest messages are baked into the shape of this file and must survive into the UI:
//
//  1. P(win) is compressed. σ_margin ≈ 29 dwarfs every realistic weekly edge (R9 §Q9.3), so a
//     per-week percentage always looks like a coin flip. The summary therefore leads with
//     expected wins, bye odds and title odds — never with one week's percentage.
//  2. Nothing the engine can do to a lineup moves P(win) by more than ~10 pp in a single week.
//     The 0.60/0.40 strength band is ±7.4 points — ±0.26 σ_margin — and inside it the projection
//     genuinely cannot tell two teams apart.
//  3. A point in weeks 15-17 is worth 8-11× a point in weeks 3-14 for TITLE odds, and the berth
//     in a 6-of-8 league is very nearly bought already (R9 §4.7). "Bye" and "title" are therefore
//     a labelled choice (`objective`), not a hidden constant.
//
// Purity (I1): no network, no wall clock, no unseeded randomness. The clock is `ctx.now`; every
// random draw comes from a seeded mulberry32, so two runs of the same ctx return the same odds — a
// non-negotiable for a pure engine (R9 §Q9.5). `ctx` is never mutated except through `ctx.memo`,
// which every other engine module already uses as its scratch space.

import { DEFAULTS } from "../config.js";
import { activePlayers, playerOf, rosterById, slotEligibility } from "./context.js";
import { bestLineup, isBye, settingsBlock, streamerFor, weekPoints, weekVector } from "./lineup.js";
import { findTrades } from "./finder.js";
import { findFreeAgents, suggestedBid } from "./waiver.js";
import { surplus } from "./values.js";
import { fmt0, fmt1, nameOf } from "./explain.js";

// --- tunables that are NOT user settings ------------------------------------------------------
// `DEFAULTS.seasonMap` holds the five numbers a manager might reasonably want to move (objective,
// ω, the two strength thresholds, sims/seed/corr). Everything below is a modelling constant with
// a citation, exported so a test can pin it rather than restate it.

/** A slot counts as holed when it loses at least this many points against its own typical week. */
export const HOLE_MIN_PTS = 2;
/** …and at least this share of them. Both gates, so a 3-point K slot is not "holed" by 2 points. */
export const HOLE_MIN_SHARE = 0.25;
/** Horizon → `GapFill.kind` (R9 §4.2 R-5: four horizons, four prices). */
export const HORIZON_KINDS = Object.freeze([
  { maxWeeks: 1, kind: "stream" },
  { maxWeeks: 4, kind: "short-add" },
  { maxWeeks: Infinity, kind: "season-add" },
]);
/** A hole this long is worth a trade conversation, not just a claim (R9 §4.2 R-5). */
export const TRADE_MIN_WEEKS = 3;
/** How many wire bodies per hole survive to the scoring stage. */
export const MAX_FILL_CANDIDATES = 6;
/** How many ranked moves a WeekCard carries. */
export const MAX_MOVES = 4;
/** FAAB: total points that justify the maximum share of the remaining budget.
 *  R9 §4.3 — a genuine league-winner (≈ +3 pts/wk for the rest of a season ≈ 40 points) is the
 *  30-40 % bid; the same Δ over one week is the $1-2 stream. `totalPoints / 120` reproduces that
 *  curve end to end and, unlike `waiver.js`'s phase term, it FALLS as the horizon shortens
 *  (R9 §4.3 R-8: the phase multiplier currently runs the sourced curve backwards). */
export const FAAB_POINTS_FOR_MAX = 120;
/** R5 §2.3 / R9 §4.3: never more than this share of what is left on one claim. */
export const FAAB_MAX_SHARE = 0.35;
/** R9 §4.3 R-7: unspent budget at week 17 is a loss, so the last weeks get a use-it-or-lose-it
 *  bump — the ONLY place a phase term survives. */
export const FAAB_USE_IT_WEEKS = 2;
export const FAAB_USE_IT_BONUS = 0.5;
/** R9 §4.3 / R-7: 25 % of the budget per quarter, 10 % held back for weeks 14-17. */
export const FAAB_QUARTERS = Object.freeze([
  { label: "wk1-4", from: 1, to: 4, share: 0.25 },
  { label: "wk5-9", from: 5, to: 9, share: 0.25 },
  { label: "wk10-13", from: 10, to: 13, share: 0.25 },
  { label: "wk14-17", from: 14, to: 17, share: 0.25 },
]);
export const FAAB_PLAYOFF_RESERVE = 0.1;
/** R5 §2.3 [40a]: buy the bye-week body a week early, not during the bye. */
export const ADD_LEAD_WEEKS = 1;
/** Title equity is a paired simulation per candidate, so it runs at a reduced n over COMMON
 *  RANDOM NUMBERS (same seed for both arms), which kills almost all of the Monte-Carlo noise in
 *  the difference. Only the top few candidates per hole earn one. */
export const EQUITY_SIMS = 3000;
export const EQUITY_CANDIDATES = 4;

const EPS = 1e-9;

// --- small pure helpers -----------------------------------------------------------------------

const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const range = (a, b) => {
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
};
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Namespaced scratch space on ctx.memo — never a new property on ctx itself. */
function memo(ctx, key) {
  if (!ctx.memo) ctx.memo = {};
  if (!ctx.memo.seasonMap) ctx.memo.seasonMap = {};
  if (!ctx.memo.seasonMap[key]) ctx.memo.seasonMap[key] = new Map();
  return ctx.memo.seasonMap[key];
}

/**
 * The `seasonMap` settings block, merged over DEFAULTS and memoized (same helper every other
 * engine module uses, so a partial user patch cannot drop a key).
 * @param {object} ctx
 * @returns {{objective:string, omega:object, strong:number, weak:number, sims:number,
 *            seed:number, corr:number}}
 */
export function seasonMapSettings(ctx) {
  return settingsBlock(ctx, "seasonMap");
}

// --- probability ------------------------------------------------------------------------------

/**
 * Abramowitz & Stegun 7.1.26 — the same rational approximation `lineup_optimizer.py:353` uses, so
 * the JS and Python maps agree to the seventh decimal. Maximum absolute error 1.5e-7, which is
 * four orders of magnitude below the uncertainty in σ itself (R9 §Q9.3 puts the 95 % CI on
 * σ_margin at [21.4, 44.9]).
 * @param {number} x
 * @returns {number}
 */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

/** Standard normal CDF, Φ(z) = ½(1 + erf(z/√2)). */
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * P(team A beats team B) in one week.
 *
 *   P = Φ( (μA − μB) / √(σA² + σB² − 2·ρ·σA·σB) )
 *
 * Modelling the MARGIN rather than the two scores is deliberate (R9 §Q9.3 caveat 2): when the
 * whole league runs hot on a given Sunday both totals rise together and the margin is untouched,
 * so the league-wide correlation cancels. `corr` is left as a dial for the correlation that does
 * NOT cancel — a QB stacked with his own receiver raises a lineup's variance, a QB paired against
 * the opposing defence lowers it — and defaults to 0 because nobody can calibrate it here and a
 * named zero is more honest than an invented matrix.
 *
 * Right skew is real (player scores are gamma-like) but a sum of 11 of them is close enough to
 * normal by CLT for the mean; it mis-prices only the extreme tails, which a season map never
 * depends on.
 * @param {number} muA
 * @param {number} sdA
 * @param {number} muB
 * @param {number} sdB
 * @param {number} [corr] correlation between the two weekly totals, −1..1
 * @returns {number} 0..1
 */
export function pWin(muA, sdA, muB, sdB, corr = 0) {
  const a = finite(muA, 0);
  const b = finite(muB, 0);
  const sa = Math.max(0, finite(sdA, 0));
  const sb = Math.max(0, finite(sdB, 0));
  const rho = clamp(finite(corr, 0), -1, 1);
  const variance = sa * sa + sb * sb - 2 * rho * sa * sb;
  if (!(variance > EPS)) return a > b ? 1 : a < b ? 0 : 0.5;
  return clamp(normalCdf((a - b) / Math.sqrt(variance)), 0, 1);
}

/**
 * Which of the three honest buckets a week falls into.
 *
 * The thresholds are derived, not round: 0.60 is where the published variance penalty for a
 * favourite turns material (−5.50 pp at a 5-point spread ≈ P 0.57), and at σ_margin 29 the
 * 0.40/0.60 band is ±7.4 points — ±0.26 σ_margin, ±5.3 % of a typical 140-point lineup. Above the
 * band play the floor; below it chase ceiling, surgically and at QB first; inside it the
 * projection cannot distinguish the two teams and the UI should say so (R9 §Q9.5).
 * @param {number} p
 * @param {{strong?:number, weak?:number}} [thresholds]
 * @returns {"strong"|"even"|"weak"}
 */
export function weekStrength(p, thresholds = {}) {
  const strong = finite(thresholds.strong, DEFAULTS.seasonMap.strong);
  const weak = finite(thresholds.weak, DEFAULTS.seasonMap.weak);
  const v = finite(p, 0.5);
  if (v >= strong) return "strong";
  if (v <= weak) return "weak";
  return "even";
}

// --- seeded PRNG ------------------------------------------------------------------------------

/**
 * mulberry32 — 32 bits of state, period 2³², and reproducible across engines because every step
 * is an integer op. The simulator may not call `Math.random`: a pure engine that returns
 * different odds on two runs of the same ctx is not a pure engine (R9 §Q9.5).
 * @param {number} seed
 * @returns {() => number} uniform [0,1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, no cached spare: the discarded half costs one uniform and buys a draw stream that
 *  depends only on how many normals were asked for, never on where the last call stopped. */
function gaussian(rand, mean, sd) {
  const u1 = Math.max(rand(), Number.MIN_VALUE);
  const u2 = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- schedule ---------------------------------------------------------------------------------

/** Accept a Map, a plain `{week: rows}` object, or the fixture wrapper `{weeks: {…}}`. */
function weekRows(matchupsByWeek) {
  const src =
    matchupsByWeek && !Array.isArray(matchupsByWeek) && matchupsByWeek.weeks && !matchupsByWeek.get
      ? matchupsByWeek.weeks
      : matchupsByWeek;
  const out = new Map();
  if (!src) return out;
  const entries = typeof src.entries === "function" ? src.entries() : Object.entries(src);
  for (const [week, rows] of entries) {
    const w = Number(week);
    if (Number.isFinite(w) && Array.isArray(rows)) out.set(w, rows);
  }
  return out;
}

/** Accept raw bracket rows or the fixture wrapper `{rows: [...]}`. */
function bracketRows(bracket) {
  if (Array.isArray(bracket)) return bracket;
  if (bracket && Array.isArray(bracket.rows)) return bracket.rows;
  return [];
}

/**
 * Turn Sleeper's per-week matchup rows and its winners bracket into the one genuinely new input
 * the season map needs (R9 §Q9.5).
 *
 * Rows are paired by `matchup_id`: two rows sharing one are the week's game, and a roster left
 * unpaired (an odd league, a commissioner edit, a week Sleeper has not built) maps to `null`
 * rather than being dropped, so a week card can say "no opponent" instead of silently vanishing.
 * NOTHING else is read from a future week — `starters`, `players` and `points` there are the
 * CURRENT roster echoed forward (R9 §Q9.2 Finding 1, proved by weeks 3/8/14 being byte-identical
 * while weeks 1-3 differ). `points` IS real for a completed week, so those are kept as `results`:
 * they are the only ground-truth team scores available to a pure engine, and σ calibration needs
 * them.
 *
 * The bracket is PROVISIONAL. Before the playoffs Sleeper seeds it from the standings as they
 * stand today, so weeks 15-17's matchup rows are regular-season filler that the bracket overrides
 * and neither one is a scheduled opponent. `asOfWeek` records when it was read so the UI can say
 * so (R9 §Q9.2 Finding 4).
 * @param {object|Map} matchupsByWeek `{ [week]: rows }`, a Map, or `{ weeks: { … } }`
 * @param {object[]|{rows:object[]}} bracket raw `/winners_bracket` rows
 * @param {object} ctx
 * @returns {{byWeek:Object<number,Object<number,number|null>>, playoffWeeks:number[],
 *   bracket:{provisional:boolean, asOfWeek:number, rounds:Array<{week:number,
 *     games:Array<{m:number,t1:number|null,t2:number|null,t1From:object|null,t2From:object|null,
 *                  placement:number|null}>}>},
 *   results:Object<number,Object<number,number>>, source:string, pulledAt:string|null}}
 */
export function buildSchedule(matchupsByWeek, bracket, ctx) {
  const rowsByWeek = weekRows(matchupsByWeek);
  const byWeek = {};
  const results = {};
  for (const [week, rows] of rowsByWeek) {
    const groups = new Map();
    const week_ = {};
    let scored = false;
    for (const row of rows) {
      const rid = Number(row && row.roster_id);
      if (!Number.isFinite(rid)) continue;
      week_[rid] = null;
      const pts = Number(row.points);
      if (Number.isFinite(pts) && pts > 0) {
        scored = true;
        (results[week] = results[week] || {})[rid] = pts;
      }
      const mid = row.matchup_id;
      if (mid == null) continue;
      const key = String(mid);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rid);
    }
    for (const pair of groups.values()) {
      if (pair.length !== 2) continue; // 1 = bye/unscheduled, >2 = not a head-to-head week
      week_[pair[0]] = pair[1];
      week_[pair[1]] = pair[0];
    }
    byWeek[week] = week_;
    if (!scored) delete results[week];
  }

  const raw = bracketRows(bracket);
  const playoffWeeks = Array.isArray(ctx && ctx.playoffWeeks) ? [...ctx.playoffWeeks] : [];
  const playoffStart = (ctx && ctx.league && ctx.league.playoffStart) || playoffWeeks[0] || 0;
  const byRound = new Map();
  for (const row of raw) {
    const r = Number(row && row.r);
    if (!Number.isFinite(r)) continue;
    if (!byRound.has(r)) byRound.set(r, []);
    // `Number(null)` is 0, not NaN — an unresolved `t2` must stay null or it enters the bracket
    // as a phantom roster 0 and inflates the entrant count.
    const team = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    byRound.get(r).push({
      m: Number(row.m),
      t1: team(row.t1),
      t2: team(row.t2),
      t1From: row.t1_from || null,
      t2From: row.t2_from || null,
      placement: Number.isFinite(Number(row.p)) ? Number(row.p) : null,
    });
  }
  const rounds = [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((r) => ({
      week: playoffWeeks[r - 1] != null ? playoffWeeks[r - 1] : playoffStart ? playoffStart + r - 1 : r,
      games: byRound.get(r).sort((a, b) => a.m - b.m),
    }));

  const wrapper = matchupsByWeek && !Array.isArray(matchupsByWeek) ? matchupsByWeek : null;
  return {
    byWeek,
    playoffWeeks,
    bracket: {
      // Unresolved while any game still has a null winner — which is every game until week 15.
      provisional: !raw.length || raw.some((row) => row && row.w == null),
      asOfWeek: (ctx && ctx.week) || 0,
      rounds,
    },
    results,
    source: "sleeper:/matchups",
    pulledAt: (wrapper && (wrapper.pulled_at || wrapper.pulledAt)) || (ctx && ctx.now) || null,
  };
}

/**
 * Seed positions in a standard single-elimination bracket of `2^rounds` slots:
 * rounds 3 → [1,8,4,5,2,7,3,6]. Seeds above `teams` are absent, which is exactly how a bye works
 * — seed 1's round-1 opponent (8) does not exist, so seed 1 advances.
 *
 * This reproduces Boyball's live `/winners_bracket` exactly: with 6 teams, round 1 is 3v6 and
 * 4v5, and the semis are 1 v winner(4v5) and 2 v winner(3v6). Note that this is the FIXED
 * bracket, not a reseed — verified against the live rows rather than assumed from
 * `playoff_seed_type`.
 * @param {number} rounds
 * @returns {number[]}
 */
export function seedOrder(rounds) {
  let arr = [1];
  for (let r = 0; r < rounds; r += 1) {
    const n = arr.length * 2;
    const next = [];
    for (const s of arr) {
      next.push(s);
      next.push(n + 1 - s);
    }
    arr = next;
  }
  return arr;
}

/**
 * How many teams make the playoffs, how many rounds, and how many first-round byes.
 *
 * `ctx.league` carries `playoffRounds` but not `playoff_teams`, so the entrant count is read off
 * the bracket itself: every literal roster id on the winners path is a team that qualified. For
 * Boyball that is {4,7,8,5} in round 1 plus {2,3} seeded straight into round 2 — six. Falls back
 * to `min(numTeams, 2^rounds)` when there is no bracket, and yields to an explicit
 * `ctx.league.playoffTeams` or `override` if a later context.js starts exposing one.
 * @param {object} ctx
 * @param {{bracket?:object}} schedule
 * @param {number} [override]
 * @returns {{teams:number, rounds:number, byes:number, slots:number, seedType:number}}
 */
export function bracketShape(ctx, schedule, override) {
  const league = (ctx && ctx.league) || {};
  const rows = (schedule && schedule.bracket && schedule.bracket.rounds) || [];
  const seen = new Set();
  for (const round of rows) {
    for (const game of round.games || []) {
      // The placement ladder (5th place, 3rd place) hangs off the winners path and adds no teams.
      if (game.placement != null && game.placement !== 1) continue;
      if (game.t1 != null) seen.add(game.t1);
      if (game.t2 != null) seen.add(game.t2);
    }
  }
  let rounds = Math.max(rows.length, finite(league.playoffRounds, 0));
  const numTeams = finite(league.numTeams, 0);
  let teams = finite(override, 0) || finite(league.playoffTeams, 0) || seen.size;
  if (!teams) teams = numTeams ? Math.min(numTeams, 2 ** Math.max(1, rounds)) : 0;
  if (!rounds) rounds = teams > 1 ? Math.ceil(Math.log2(teams)) : 0;
  const slots = rounds ? 2 ** rounds : 0;
  return {
    teams,
    rounds,
    byes: Math.max(0, slots - teams),
    slots,
    // 0 = the fixed bracket above (Boyball, verified live); 1 = re-seed highest-vs-lowest each
    // round. context.js does not expose it yet, so 0 unless a later one does.
    seedType: finite(league.playoffSeedType, 0),
  };
}

// --- per-week mean and sd ----------------------------------------------------------------------

/** Stable key for a roster's id set (order-independent). */
const idsKey = (ids) => [...ids].sort().join(",");

/** `bestLineup`, memoized per (roster, week): the map and the simulator ask for the same 120
 *  lineups and the finder-grade cost of rebuilding them is the module's whole budget. */
function lineupAt(ctx, ids, week, key) {
  const cache = memo(ctx, "lineups");
  const k = `${key}|${week}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const out = bestLineup(ctx, ids, week);
  cache.set(k, out);
  return out;
}

/** Which position's CV prices a slot: the streamed body when the wire filled it, else the held
 *  body, else the slot's first eligible position. */
function slotPos(ctx, slot) {
  const pid = slot.streamed || slot.id;
  if (pid) return playerOf(ctx, pid).pos || null;
  const elig = slotEligibility(slot.slot);
  return elig && elig.length ? elig[0] : null;
}

/**
 * One roster's weekly total as a distribution.
 *
 *   σ_team(w) = √( Σ_{i ∈ starters} (cv_i · μ_i(w))² )
 *
 * INTERIM (design §3.5, §7): WS-K owns the canonical per-week export
 * `rosterWeekly(ctx, rosterId) → [{week, mean, sd}]`, lifted out of the loop `risk.js` already
 * runs at :573-586. Until that lands this module computes the same quantity locally from the
 * `DEFAULTS.risk.positionCv` PRIOR rather than from `playerRisk().volatility` (the history-shrunk
 * CV), which is the one deliberate difference: with two played weeks the shrunk CV is ~all prior
 * anyway, and a local prior keeps the map independent of a module this workstream may not touch.
 * Pass `opts.rosterWeekly` to override the moment WS-K merges.
 *
 * Independence is assumed and said out loud rather than papered over with a correlation inflation
 * constant (`risk.js:573-575` makes the same call). R9 §Q9.3 measures the consequence: this model
 * implies σ_margin 41.4 where the residuals say 29-32, so it runs ≈40 % hot — a flag to re-fit
 * (E6), not a bug, since n=16 cannot reject it. `sigmaCalibration` in the summary reports it.
 * @param {object} ctx
 * @param {string[]} ids
 * @param {number} week
 * @param {string} key memo key for `ids`
 * @returns {{lineup:object, mean:number, sd:number, short:string[]}}
 */
function meanSdAt(ctx, ids, week, key) {
  const cache = memo(ctx, "meanSd");
  const k = `${key}|${week}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const lineup = lineupAt(ctx, ids, week, key);
  const cv = settingsBlock(ctx, "risk").positionCv || DEFAULTS.risk.positionCv;
  let variance = 0;
  for (const slot of lineup.slots) {
    const pts = Number(slot.pts) || 0;
    if (pts <= 0) continue;
    const pos = slotPos(ctx, slot);
    const c = finite(cv[pos], DEFAULTS.risk.positionCv[pos]);
    if (!Number.isFinite(c)) continue;
    variance += c * pts * (c * pts);
  }
  const out = { lineup, mean: lineup.total, sd: Math.sqrt(variance), short: lineup.short };
  cache.set(k, out);
  return out;
}

/** The lineup a rival has ACTUALLY set, for the live week only. For every future week the
 *  opponent gets fifteen Wednesdays to fix his lineup, so "optimal vs optimal" is the honest
 *  framing and "optimal vs set" would flatter us (R9 §Q9.3 caveat 4). */
function setLineup(ctx, roster, week) {
  const starters = (roster && roster.starters) || [];
  const slots = [];
  let total = 0;
  for (let i = 0; i < ctx.slots.length; i += 1) {
    const id = starters[i] && starters[i] !== "0" ? String(starters[i]) : null;
    const pts = id ? weekPoints(ctx, id, week) : 0;
    slots.push({ slot: ctx.slots[i], id, pts });
    total += pts;
  }
  const cv = settingsBlock(ctx, "risk").positionCv || DEFAULTS.risk.positionCv;
  let variance = 0;
  for (const slot of slots) {
    if (slot.pts <= 0) continue;
    const c = finite(cv[slotPos(ctx, slot)], null);
    if (c != null) variance += c * slot.pts * (c * slot.pts);
  }
  return {
    lineup: { slots, total, short: slots.filter((s) => s.id == null).map((s) => s.slot) },
    mean: total,
    sd: Math.sqrt(variance),
    short: slots.filter((s) => s.id == null).map((s) => s.slot),
  };
}

/** Every roster's `{mean, sd}` for every week in the window — built once, shared by the map and
 *  the simulator, and the single biggest cost in this module (8 rosters × 15 weeks of lineups). */
function grid(ctx, from, to) {
  const cache = memo(ctx, "grid");
  const k = `${from}-${to}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const out = new Map();
  for (const roster of ctx.rosters) {
    const ids = activePlayers(roster);
    const key = idsKey(ids);
    const weeks = new Map();
    for (let w = from; w <= to; w += 1) {
      const cell = meanSdAt(ctx, ids, w, key);
      weeks.set(w, { mean: cell.mean, sd: cell.sd });
    }
    out.set(roster.rosterId, weeks);
  }
  cache.set(k, out);
  return out;
}

// --- holes --------------------------------------------------------------------------------------

/** Why this body is not scoring in this week — cause, in the order the manager cares about. */
function causeOf(ctx, id, week) {
  if (!id) return null;
  if (isBye(ctx, id, week)) return "bye";
  const inj = playerOf(ctx, id).inj;
  if (inj === "Sus" || inj === "Suspended") return "suspension";
  if (inj != null && inj !== "") return "injury";
  return null;
}

/**
 * What a player would be projected for in a week if nothing were wrong with him — the RAW
 * projection, before `weekVector` applies the bye zero and the availability discount.
 *
 * This is the number a hole has to be measured against. `weekVector` has already thrown the
 * reason away (a bye and a torn ACL are both a 0 by the time the lineup sees them) — exactly gap
 * M5 / change E3 in R9 §Q9.1 — so the season map recovers it from `ctx.proj`, `ctx.byes` and the
 * live status row rather than threading a cause channel through `lineup.js`, which this
 * workstream does not own.
 */
function healthyTypical(ctx, id, weeks) {
  const src = ctx.proj.get(id);
  if (!src) return 0;
  const vals = [];
  for (const w of weeks) {
    const pts = Number(src[w - 1]) || 0;
    if (pts > 0) vals.push(pts);
  }
  return median(vals);
}

/**
 * Per-slot holes across the whole window, grouped into horizons.
 *
 * Two sources, because either one alone lies:
 *
 *  A. CAUSAL — a rostered body who cannot play this week (bye, injury, suspension) and who would
 *     otherwise be in the lineup. This is the one that matters and the one a "compare the slot to
 *     its own average" rule silently misses: a player out for the SEASON never starts, so he
 *     never moves the slot's average, so the biggest hole on the roster would read as normal.
 *     Measured against his healthy projection, not against his zeroed week vector.
 *  B. STRUCTURAL — a slot the roster cannot fill at all, or one that falls at least
 *     `HOLE_MIN_PTS` AND `HOLE_MIN_SHARE` below its own typical week. Both gates, so a 7-point
 *     kicker slot is not "holed" by two points of ordinary wobble.
 *
 * A slot flagged by A is not re-flagged by B: the cause is the better answer than "thin".
 * @returns {Map<number, Array<{slot:string, slotIndex:number, cause:string, playerId:string|null,
 *   weeks:number[], lossVsTypical:number, coveredBy:string|null}>>} keyed by week
 */
function holesOverWindow(ctx, ids, weeks, key) {
  const lineups = new Map();
  for (const w of weeks) lineups.set(w, lineupAt(ctx, ids, w, key));

  const slotCount = ctx.slots.length;
  const baseline = [];
  const owner = [];
  for (let i = 0; i < slotCount; i += 1) {
    const pts = [];
    const counts = new Map();
    for (const w of weeks) {
      const slot = lineups.get(w).slots[i];
      pts.push(Number(slot.pts) || 0);
      if (slot.id) counts.set(slot.id, (counts.get(slot.id) || 0) + 1);
    }
    baseline.push(median(pts));
    let best = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN || (n === bestN && best && id < best)) {
        best = id;
        bestN = n;
      }
    }
    owner.push(best);
  }

  const typical = new Map();
  for (const id of ids) typical.set(id, healthyTypical(ctx, id, weeks));

  // Pass 1 — flag the holed (week, slot) cells and name their cause.
  const flagged = new Map(); // slotIndex -> Map<week, {cause, playerId, loss, coveredBy}>
  const put = (i, w, cell) => {
    if (!flagged.has(i)) flagged.set(i, new Map());
    const prev = flagged.get(i).get(w);
    if (!prev || cell.loss > prev.loss) flagged.get(i).set(w, cell);
  };

  for (const w of weeks) {
    const lineup = lineups.get(w);
    const inLineup = new Set(lineup.slots.map((s) => s.id).filter(Boolean));
    // A — an absent body who would otherwise start, and the slot he would have taken.
    for (const id of ids) {
      if (inLineup.has(id)) continue;
      const cause = causeOf(ctx, id, w);
      if (!cause) continue;
      const would = typical.get(id) || 0;
      if (would <= 0) continue;
      const pos = playerOf(ctx, id).pos;
      let target = -1;
      for (let i = 0; i < slotCount; i += 1) {
        if (!slotEligibility(ctx.slots[i]).includes(pos)) continue;
        if (target < 0 || (lineup.slots[i].pts || 0) < (lineup.slots[target].pts || 0)) target = i;
      }
      if (target < 0) continue;
      const held = lineup.slots[target];
      const loss = would - (Number(held.pts) || 0);
      if (loss < HOLE_MIN_PTS) continue;
      put(target, w, {
        cause,
        playerId: id,
        loss,
        coveredBy: held.streamed ? "stream" : held.id ? "bench" : null,
      });
    }
    // B — empty or materially below its own typical week.
    for (let i = 0; i < slotCount; i += 1) {
      if (flagged.has(i) && flagged.get(i).has(w)) continue;
      const slot = lineup.slots[i];
      const pts = Number(slot.pts) || 0;
      const held = slot.id;
      const empty = held == null;
      const loss = Math.max(0, baseline[i] - pts);
      const material = loss >= HOLE_MIN_PTS && loss >= HOLE_MIN_SHARE * Math.max(baseline[i], EPS);
      if (!empty && !material) continue;
      const missing = owner[i] && owner[i] !== held ? owner[i] : null;
      let cause = missing ? causeOf(ctx, missing, w) : causeOf(ctx, held, w);
      if (!cause) cause = empty && !owner[i] ? "empty" : "thin";
      put(i, w, {
        cause,
        playerId: missing || held || null,
        loss,
        coveredBy: slot.streamed ? "stream" : held && held !== owner[i] ? "bench" : null,
      });
    }
  }

  // Pass 2 — a hole's horizon is the run of consecutive holed weeks with the same cause and the
  // same missing body. That run is what `GapFill` is matched against, so it has to be the hole's
  // own length, not the rest of the season.
  const byWeek = new Map();
  for (const w of weeks) byWeek.set(w, []);
  for (const [i, perWeek] of flagged) {
    const holedWeeks = weeks.filter((w) => perWeek.has(w));
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const first = perWeek.get(run[0]);
      const list = [...run];
      for (const w of list) {
        const cell = perWeek.get(w);
        byWeek.get(w).push({
          slot: ctx.slots[i],
          slotIndex: i,
          cause: first.cause,
          playerId: first.playerId,
          weeks: list,
          lossVsTypical: Math.round(cell.loss * 10) / 10,
          coveredBy: cell.coveredBy,
        });
      }
      run = [];
    };
    for (const w of holedWeeks) {
      const cell = perWeek.get(w);
      const prev = run.length ? run[run.length - 1] : null;
      const sameRun =
        prev != null &&
        w === prev + 1 &&
        perWeek.get(prev).cause === cell.cause &&
        perWeek.get(prev).playerId === cell.playerId;
      if (!sameRun) flush();
      run.push(w);
    }
    flush();
  }
  return byWeek;
}

// --- gap fills ------------------------------------------------------------------------------------

/** Horizon → kind (R9 §4.2 R-5). */
export function kindForHorizon(weeksLong) {
  for (const band of HORIZON_KINDS) if (weeksLong <= band.maxWeeks) return band.kind;
  return "season-add";
}

/**
 * Free-agent candidates at one position, computed once per (roster, position) and memoized.
 *
 * `minGainPerWeek` is dropped to 0 deliberately: the default 0.5 is the floor for "worth a roster
 * spot all season", and a body whose entire job is one bye week never clears it. The horizon gate
 * below is what keeps those candidates honest — they are priced at Δ × the weeks they actually
 * cover, so a one-week fill can never out-rank a season-long one on points alone.
 */
function faCandidates(ctx, rosterId, pos) {
  const cache = memo(ctx, "fa");
  const k = `${rosterId}|${pos}`;
  const hit = cache.get(k);
  if (hit) return hit;
  let rows = [];
  try {
    rows = findFreeAgents(ctx, {
      rosterId,
      position: pos,
      minGainPerWeek: 0,
      maxResults: MAX_FILL_CANDIDATES * 2,
    });
  } catch {
    rows = [];
  }
  cache.set(k, rows);
  return rows;
}

/** Trade angles for this roster, computed once and filtered per hole. */
function tradeCandidates(ctx, rosterId) {
  const cache = memo(ctx, "trades");
  const hit = cache.get(rosterId);
  if (hit) return hit;
  let rows = [];
  try {
    rows = findTrades(ctx, { myRosterId: rosterId });
  } catch {
    rows = [];
  }
  cache.set(rosterId, rows);
  return rows;
}

/**
 * FAAB, priced at Δ × the weeks the body will actually START (R9 §4.3 R-8, engine change E7).
 *
 * `waiver.js`'s `suggestedBid` multiplies by a phase term that RISES all season, so the same
 * player is a $10 bid in week 1 and a $27 bid in week 17 — the sourced curve backwards. This
 * prices the claim on what it buys instead: one week of a +3 streamer is 3 points and $1-2, a
 * rest-of-season +3 upgrade is ~40 points and a third of what is left. The phase term survives
 * only as a use-it-or-lose-it bump in the last two weeks, where unspent budget is a pure loss.
 *
 * `suggestedBid` is still called first, read-only, because it owns the question of whether a bid
 * is even a thing that exists here (FAAB league, player actually on waivers, budget left).
 */
function faabFor(ctx, rosterId, addId, gainPerWeek, status, totalPoints, firstWeek) {
  const base = suggestedBid(ctx, rosterId, addId, gainPerWeek, status);
  if (!base) return { faab: null, faabPctRemaining: null, remaining: null };
  const useIt = firstWeek >= ctx.lastWeek - FAAB_USE_IT_WEEKS;
  const faab = horizonBid(base.remaining, totalPoints, useIt);
  return {
    faab,
    faabPctRemaining: base.remaining ? faab / base.remaining : null,
    remaining: base.remaining,
  };
}

/**
 * The horizon-matched bid, split out so the curve can be pinned by a test rather than inferred
 * from whichever free agents a fixture happens to hold. On $94 remaining:
 * a 1-week +3 stream → $2 · a 3-week +4 bridge → $9 · a rest-of-season +3 upgrade → the 35 % cap.
 * @param {number} remaining FAAB left
 * @param {number} totalPoints Δ points/week × weeks the add actually starts
 * @param {boolean} [useItOrLoseIt] inside the last weeks, where unspent budget is a pure loss
 * @returns {number} dollars, at least 1 and never more than `remaining`
 */
export function horizonBid(remaining, totalPoints, useItOrLoseIt = false) {
  const left = Math.max(0, finite(remaining, 0));
  if (left <= 0) return 0;
  const bonus = useItOrLoseIt ? 1 + FAAB_USE_IT_BONUS : 1;
  const share = Math.min(FAAB_MAX_SHARE, (Math.max(0, finite(totalPoints, 0)) / FAAB_POINTS_FOR_MAX) * bonus);
  return clamp(Math.round(left * share), 1, left);
}

/**
 * Build and rank the moves that fill one hole.
 *
 * Ranked by `winEquity` (objective "bye") or `titleEquity` (objective "title") — NEVER by points.
 * That is the whole point of the feature: the same +3 pts/wk is worth 0.028 pp of title in week 6
 * and 0.289 pp in week 16 (R9 §4.7), so a points ranking recommends the wrong move for ten of the
 * fifteen weeks on the map.
 *
 * The horizon gate is a HARD gate, not a tiebreak: a fill whose own useful life runs past the
 * hole is sorted below every fill that matches it, whatever its equity, because the surplus weeks
 * are a roster spot this league charges a startable free agent for (R9 §4.4 R-9).
 */
function movesForHole(ctx, params, hole) {
  const { rosterId, ids, key, from, to, corr, objective, schedule, sched } = params;
  const cache = memo(ctx, "moves");
  const cacheKey = `${rosterId}|${objective}|${hole.slotIndex}|${hole.cause}|${hole.playerId}|${hole.weeks.join(".")}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const holeWeeks = hole.weeks.filter((w) => w >= from && w <= to);
  const horizon = holeWeeks.length;
  const kind = kindForHorizon(horizon);
  const eligible = new Set(slotEligibility(hole.slot));
  const deadline = finite(ctx.league.tradeDeadlineWeek, 0);
  const tradesAllowed = horizon >= TRADE_MIN_WEEKS && deadline > 0 && holeWeeks[0] <= deadline;

  /** One (add, drop) pair scored on every unit the contract names. */
  const score = (addId, dropId, source, row) => {
    const after = ids.filter((id) => id !== dropId).concat(addId);
    const afterKey = idsKey(after);
    const covered = [];
    let deltaSum = 0;
    let winEquity = 0;
    const deltas = {};
    for (const w of holeWeeks) {
      const before = meanSdAt(ctx, ids, w, key);
      const post = meanSdAt(ctx, after, w, afterKey);
      const delta = post.mean - before.mean;
      deltaSum += delta;
      if (weekPoints(ctx, addId, w) > 0) covered.push(w);
      deltas[w] = delta;
      const opp = sched.opponent(w);
      if (!opp) continue;
      winEquity += pWin(post.mean, post.sd, opp.mean, opp.sd, corr) - pWin(before.mean, before.sd, opp.mean, opp.sd, corr);
    }
    const pointsPerWeek = horizon ? deltaSum / horizon : 0;
    const weeksCovered = covered.length ? covered : holeWeeks.filter((w) => deltas[w] > 0);
    const totalPoints = pointsPerWeek * weeksCovered.length;

    // How long we would actually be HOLDING him — the gate's input. A body who scores every week
    // to the end of the window is a season-long commitment even when the hole is one week.
    let useful = 0;
    for (let w = Math.max(from, holeWeeks[0]); w <= to; w += 1) if (weekPoints(ctx, addId, w) > 0) useful += 1;
    const horizonFit = useful <= horizon + 1;

    const status = row ? row.status : null;
    const cost = faabFor(ctx, rosterId, addId, pointsPerWeek, status, totalPoints, holeWeeks[0]);
    const availableFrom = Math.max(ctx.week, holeWeeks[0] - ADD_LEAD_WEEKS);
    const spotEnd = source === "trade" ? to : Math.max(holeWeeks[holeWeeks.length - 1], availableFrom);

    return {
      kind: source === "trade" ? "trade" : kind,
      addId,
      dropId: dropId || null,
      pointsPerWeek: Math.round(pointsPerWeek * 100) / 100,
      weeksCovered,
      totalPoints: Math.round(totalPoints * 100) / 100,
      winEquity: Math.round(winEquity * 10000) / 10000,
      titleEquity: null,
      cost: {
        faab: source === "trade" ? null : cost.faab,
        faabPctRemaining: source === "trade" ? null : cost.faabPctRemaining,
        drop: dropId
          ? { id: dropId, name: nameOf(ctx, dropId), surplus: Math.round(surplus(ctx, dropId)) }
          : null,
        rosterSpotWeeks: Math.max(1, spotEnd - availableFrom + 1),
      },
      window: {
        availableFrom,
        waiverClears: row && row.clearsAt ? row.clearsAt : null,
        tradeDeadlineWeek: deadline || null,
      },
      why: [],
      // internal, stripped before the card is returned
      _fit: horizonFit,
      _useful: useful,
      _source: source,
      _row: row,
    };
  };

  const out = [];
  const seen = new Set();
  for (const pos of eligible) {
    for (const row of faCandidates(ctx, rosterId, pos)) {
      if (!eligible.has(playerOf(ctx, row.add).pos)) continue;
      const dedupe = `${row.add}|${row.drop || ""}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(score(row.add, row.drop || null, "wire", row));
      if (out.length >= MAX_FILL_CANDIDATES * 2) break;
    }
  }
  if (tradesAllowed) {
    for (const trade of tradeCandidates(ctx, rosterId)) {
      const add = (trade.get || []).find((id) => eligible.has(playerOf(ctx, id).pos));
      if (!add) continue;
      const give = (trade.give || [])[0] || null;
      const dedupe = `${add}|${give || ""}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(score(add, give, "trade", null));
      if (out.length >= MAX_FILL_CANDIDATES * 3) break;
    }
  }

  // A "move" that changes nothing is not a recommendation. The commonest case is a hole the wire
  // ALREADY covers — `fillWeek` credits the streaming pickup, so signing that same body outright
  // adds zero — and showing four of those would teach the reader to ignore the list.
  let candidates = out.filter((m) => m.pointsPerWeek > MOVE_EPSILON || m.winEquity > 0);

  if (objective === "title" && candidates.length) {
    // Title equity is a paired simulation, so only the front runners on the (highly correlated)
    // win-equity proxy earn one — and then the ranking happens AMONG THOSE ONLY. Mixing scored
    // and unscored candidates in one sort would compare title points against win points.
    candidates = rankMoves(candidates, "bye").slice(0, EQUITY_CANDIDATES);
    const base = simulateSeason(ctx, schedule, { rosterId, n: EQUITY_SIMS });
    for (const move of candidates) {
      const bump = {};
      for (const w of move.weeksCovered) bump[w] = move.pointsPerWeek;
      // Same seed on both arms: common random numbers, so the DIFFERENCE is far more precise
      // than either level and 4 000 paths are enough to rank moves that differ by ~0.5 pp.
      const withAdd = simulateSeason(ctx, schedule, { rosterId, n: EQUITY_SIMS, bump });
      move.titleEquity = Math.round((withAdd.titleOdds - base.titleOdds) * 10000) / 10000;
    }
  }

  const ranked = rankMoves(candidates, objective).slice(0, MAX_MOVES);
  for (const move of ranked) move.why = whyFor(ctx, move, hole, horizon, objective);
  const clean = ranked.map(({ _source, _row, ...rest }) => rest);
  cache.set(cacheKey, clean);
  return clean;
}

/** Below this the Δ is rounding, not a move (same threshold `advisor.js` uses for advice). */
export const MOVE_EPSILON = 0.05;

/**
 * The ranking rule, exported so it can be pinned by a test rather than inferred from a fixture.
 * Horizon fit first (a hard gate), then the objective's equity, then points as a tiebreak only.
 * @param {object[]} moves
 * @param {"bye"|"title"} objective
 * @returns {object[]} a new, sorted array
 */
export function rankMoves(moves, objective) {
  const equity = (m) => (objective === "title" && m.titleEquity != null ? m.titleEquity : m.winEquity);
  return [...moves].sort((a, b) => {
    const fitA = a._fit === false ? 0 : 1;
    const fitB = b._fit === false ? 0 : 1;
    if (fitA !== fitB) return fitB - fitA;
    const d = equity(b) - equity(a);
    if (Math.abs(d) > 1e-9) return d;
    return b.totalPoints - a.totalPoints || (String(a.addId) < String(b.addId) ? -1 : 1);
  });
}

/** One sentence per driver, numbers inline — `explain.js` voice (design §3.7). */
function whyFor(ctx, move, hole, horizon, objective) {
  const lines = [];
  const weeks = hole.weeks.length === 1 ? `week ${hole.weeks[0]}` : `weeks ${hole.weeks[0]}-${hole.weeks[hole.weeks.length - 1]}`;
  const who = hole.playerId ? nameOf(ctx, hole.playerId) : "nobody";
  const causeText = {
    bye: `${who} is on bye`,
    injury: `${who} is hurt`,
    suspension: `${who} is suspended`,
    empty: `no rostered body is eligible`,
    thin: `${who} is below what the wire pays`,
  };
  lines.push(
    `${causeText[hole.cause] || hole.cause} at ${hole.slot} in ${weeks} — the slot is ${fmt1(hole.lossVsTypical)} pts light.`,
  );
  lines.push(
    `${nameOf(ctx, move.addId)} adds ${fmt1(move.pointsPerWeek)} pts/wk across ${move.weeksCovered.length} ` +
      `${move.weeksCovered.length === 1 ? "week" : "weeks"} (${fmt1(move.totalPoints)} pts total).`,
  );
  const eq = objective === "title" && move.titleEquity != null ? move.titleEquity : move.winEquity;
  const unit = objective === "title" && move.titleEquity != null ? "title odds" : "win probability";
  lines.push(`That is ${fmt1(eq * 100)} pp of ${unit} — which is what this move is ranked on, not points.`);
  if (move.cost.faab != null) {
    lines.push(
      `Bid about $${fmt0(move.cost.faab)} (${fmt0((move.cost.faabPctRemaining || 0) * 100)}% of what is left): ` +
        `the price is ${fmt1(move.pointsPerWeek)} pts/wk × ${move.weeksCovered.length} weeks, not a phase multiplier.`,
    );
  }
  if (move._fit === false) {
    lines.push(
      `Held past this hole he costs a roster spot for ${move._useful - horizon} more weeks, which in an ` +
        `8-team league is a startable free agent — that is why he ranks below a matched fill.`,
    );
  }
  if (move.kind === "trade") {
    lines.push(`A trade only while the deadline is open (week ${move.window.tradeDeadlineWeek}).`);
  }
  if (move.cost.drop) {
    lines.push(`Costs ${move.cost.drop.name}, whose surplus over replacement is ${fmt0(move.cost.drop.surplus)}.`);
  }
  return lines;
}

// --- simulation ------------------------------------------------------------------------------------

/**
 * N seeded seasons from the μ/σ grid: regular season, standings, bracket, trophy.
 *
 * Structure is read, never assumed — the regular season runs `from .. playoff_week_start − 1` over
 * the pairings in `schedule.byWeek`, and the bracket is the standard seeded single-elimination
 * shape on `2^rounds` slots with the top `byes` seeds auto-advancing, which reproduces Boyball's
 * live `/winners_bracket` exactly (1 v winner(4v5), 2 v winner(3v6)).
 *
 * Standings are wins, then points for — Sleeper's own order. Ties in a single game go to the
 * higher roster id's opponent exactly as the R9 prototype resolved them (`a >= b`), which matters
 * only at probability ~0.
 *
 * `bump` is the paired-scenario hook the title-equity calculation needs: `{ [week]: Δmean }`
 * applied to `rosterId` only. Run with the same seed it becomes common random numbers, so the
 * DIFFERENCE between two runs is far more precise than either level.
 * @param {object} ctx
 * @param {object} schedule from `buildSchedule`
 * @param {{n?:number, seed?:number, rosterId?:number, from?:number, bump?:object,
 *          playoffTeams?:number}} [opts]
 * @returns {{playoffOdds:number, firstRoundByeOdds:number, topSeedOdds:number, titleOdds:number,
 *            expectedWins:number, n:number, seed:number}}
 */
export function simulateSeason(ctx, schedule, opts = {}) {
  const cfg = seasonMapSettings(ctx);
  const n = Math.max(1, Math.round(finite(opts.n, cfg.sims)));
  const seed = finite(opts.seed, cfg.seed);
  const rosterId = opts.rosterId != null ? opts.rosterId : ctx.myRosterId;
  const from = finite(opts.from, ctx.week);
  const bump = opts.bump || null;
  // The UNBUMPED run is the baseline every paired title-equity comparison subtracts, so it is
  // asked for once per candidate and computed once per context. A bumped run is scenario-specific
  // and never cached.
  const baseKey = bump ? null : `${rosterId}|${n}|${seed}|${from}|${opts.playoffTeams ?? ""}`;
  if (baseKey) {
    const cached = memo(ctx, "sims").get(baseKey);
    if (cached) return cached;
  }
  const shape = bracketShape(ctx, schedule, opts.playoffTeams);
  const playoffWeeks = (schedule && schedule.playoffWeeks) || ctx.playoffWeeks || [];
  const playoffStart = ctx.league.playoffStart || playoffWeeks[0] || 0;
  const regularEnd = playoffStart ? Math.min(ctx.lastWeek, playoffStart - 1) : ctx.lastWeek;
  const regular = range(from, regularEnd);
  const cells = grid(ctx, from, ctx.lastWeek);

  // Everything below is INDEXED, not keyed: 20 000 seasons × ~50 games is a million inner
  // iterations, and Map lookups there cost more than every lineup in the grid put together.
  // Rosters become 0..T−1, weeks become flat `[weekIndex * T + teamIndex]` lanes of μ and σ.
  const ridList = ctx.rosters.map((r) => r.rosterId);
  const T = ridList.length;
  const indexOfRid = new Map(ridList.map((rid, i) => [rid, i]));
  const meIdx = indexOfRid.has(rosterId) ? indexOfRid.get(rosterId) : -1;
  const allWeeks = range(from, ctx.lastWeek);
  const laneOf = new Map(allWeeks.map((w, i) => [w, i]));
  const mu = new Float64Array(allWeeks.length * T);
  const sigma = new Float64Array(allWeeks.length * T);
  for (let wi = 0; wi < allWeeks.length; wi += 1) {
    const w = allWeeks[wi];
    for (let ti = 0; ti < T; ti += 1) {
      const cell = cells.get(ridList[ti]);
      const at = cell && cell.get(w);
      const extra = ti === meIdx && bump && bump[w] != null ? Number(bump[w]) : 0;
      mu[wi * T + ti] = (at ? at.mean : 0) + extra;
      sigma[wi * T + ti] = at ? at.sd : 0;
    }
  }

  // Pre-flatten the schedule: [weekLane, aIdx, bIdx, …] — each regular-season game listed once.
  const games = [];
  for (const w of regular) {
    const lane = laneOf.get(w);
    if (lane == null) continue;
    const row = (schedule && schedule.byWeek && schedule.byWeek[w]) || {};
    const seen = new Set();
    for (const [a, b] of Object.entries(row)) {
      const ai = indexOfRid.get(Number(a));
      const bi = indexOfRid.get(Number(b));
      if (ai == null || bi == null || seen.has(ai) || seen.has(bi)) continue;
      seen.add(ai);
      seen.add(bi);
      games.push(lane, ai, bi);
    }
  }
  const playoffLane = [];
  for (let r = 1; r <= shape.rounds; r += 1) {
    const w = playoffWeeks[r - 1] != null ? playoffWeeks[r - 1] : playoffStart + r - 1;
    playoffLane.push(laneOf.has(w) ? laneOf.get(w) : laneOf.get(ctx.lastWeek) || 0);
  }

  const wins0 = new Float64Array(T);
  const pf0 = new Float64Array(T);
  for (let ti = 0; ti < T; ti += 1) {
    const roster = ctx.rosters[ti];
    wins0[ti] = (roster.wins || 0) + 0.5 * (roster.ties || 0);
    pf0[ti] = roster.fpts || 0;
  }

  const rand = mulberry32(seed);
  const wins = new Float64Array(T);
  const pf = new Float64Array(T);
  const order = new Int32Array(T);
  const seedAt = new Int32Array(T); // team index → its seed (1-based)
  const slots = seedOrder(shape.rounds);
  const alive = new Int32Array(slots.length);
  const next = new Int32Array(slots.length);
  let made = 0;
  let bye = 0;
  let top = 0;
  let champ = 0;
  let winsAcc = 0;

  const draw = (lane, ti) => gaussian(rand, mu[lane * T + ti], sigma[lane * T + ti]);

  for (let s = 0; s < n; s += 1) {
    wins.set(wins0);
    pf.set(pf0);
    for (let g = 0; g < games.length; g += 3) {
      const lane = games[g];
      const ai = games[g + 1];
      const bi = games[g + 2];
      const sa = draw(lane, ai);
      const sb = draw(lane, bi);
      pf[ai] += sa;
      pf[bi] += sb;
      if (sa >= sb) wins[ai] += 1;
      else wins[bi] += 1;
    }
    // Insertion sort over ≤ 16 teams beats Array#sort with a comparator by a wide margin here.
    for (let i = 0; i < T; i += 1) order[i] = i;
    for (let i = 1; i < T; i += 1) {
      const v = order[i];
      let j = i - 1;
      while (
        j >= 0 &&
        (wins[order[j]] < wins[v] || (wins[order[j]] === wins[v] && pf[order[j]] < pf[v]))
      ) {
        order[j + 1] = order[j];
        j -= 1;
      }
      order[j + 1] = v;
    }
    winsAcc += wins[meIdx];
    let mySeed = 0;
    for (let i = 0; i < T; i += 1) {
      seedAt[order[i]] = i + 1;
      if (order[i] === meIdx) mySeed = i + 1;
    }
    if (mySeed <= shape.teams) made += 1;
    if (mySeed <= shape.byes) bye += 1;
    if (mySeed === 1) top += 1;
    if (!shape.rounds || mySeed > shape.teams) continue;

    // Seed s is present iff s <= teams; an absent slot is a bye for whoever it faced.
    let live = slots.length;
    for (let i = 0; i < slots.length; i += 1) alive[i] = slots[i] <= shape.teams ? order[slots[i] - 1] : -1;
    for (let r = 1; r <= shape.rounds; r += 1) {
      const lane = playoffLane[r - 1];
      if (shape.seedType === 1 && r > 1) {
        // Re-seed: highest remaining plays lowest remaining. Boyball is seedType 0 and never
        // takes this branch, but a league that sets it gets its own bracket rather than ours.
        const present = [];
        for (let i = 0; i < live; i += 1) if (alive[i] >= 0) present.push(alive[i]);
        present.sort((x, y) => seedAt[x] - seedAt[y]);
        for (let i = 0; i < present.length / 2; i += 1) {
          alive[2 * i] = present[i];
          alive[2 * i + 1] = present[present.length - 1 - i];
        }
        live = present.length;
      }
      let k = 0;
      for (let i = 0; i < live; i += 2) {
        const a = alive[i];
        const b = i + 1 < live ? alive[i + 1] : -1;
        if (a < 0) next[k] = b;
        else if (b < 0) next[k] = a;
        else next[k] = draw(lane, a) >= draw(lane, b) ? a : b;
        k += 1;
      }
      for (let i = 0; i < k; i += 1) alive[i] = next[i];
      live = k;
    }
    if (alive[0] === meIdx) champ += 1;
  }

  const out = {
    playoffOdds: made / n,
    firstRoundByeOdds: bye / n,
    topSeedOdds: top / n,
    titleOdds: champ / n,
    expectedWins: winsAcc / n,
    n,
    seed,
  };
  if (baseKey) memo(ctx, "sims").set(baseKey, out);
  return out;
}

// --- calibration, FAAB plan, advice -------------------------------------------------------------

/**
 * What the σ model is worth, said out loud.
 *
 * The positionCv priors imply σ_margin ≈ 41 where R9's measured residuals land at 29-32 — about
 * 40 % hot. With n = 16 team-weeks the χ² CI cannot reject 41, so this is a flag to re-fit (E6),
 * not a bug, and the honest thing is to report both numbers next to their sample size rather than
 * to quietly pick one. Residuals are only computable where `schedule.results` carries a completed
 * week's real team points; with none, `n` is 0 and `ci95` is null rather than invented.
 */
function calibration(ctx, schedule, weeks, rosterId, cells) {
  const mine = cells.get(rosterId);
  const sds = weeks.map((w) => (mine && mine.get(w) ? mine.get(w).sd : 0)).filter((v) => v > 0);
  const sigmaTeam = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : 0;
  const results = (schedule && schedule.results) || {};
  const residuals = [];
  // Completed weeks lie BEFORE the map's window, so they are not in the grid — their projected
  // totals are built here, on demand. Two honest caveats, both inherited from R9's own mae_check:
  // the roster today is not the roster that played week 1, and `weekVector` applies today's injury
  // statuses to a past week. The residual is therefore an estimate of σ, not a measurement of it.
  for (const [week, byRoster] of Object.entries(results)) {
    const w = Number(week);
    if (!(w >= 1)) continue;
    for (const [rid, actual] of Object.entries(byRoster)) {
      const roster = rosterById(ctx, Number(rid));
      if (!roster) continue;
      const cell = cells.get(Number(rid));
      const cached = cell && cell.get(w);
      let projected;
      if (cached) projected = cached.mean;
      else {
        const rosterIds = activePlayers(roster);
        projected = meanSdAt(ctx, rosterIds, w, idsKey(rosterIds)).mean;
      }
      if (!(projected > 0)) continue;
      residuals.push(Number(actual) - projected);
    }
  }
  let measured = null;
  let ci95 = null;
  if (residuals.length >= 2) {
    const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const varr = residuals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (residuals.length - 1);
    measured = Math.sqrt(varr);
    // Normal approximation to the χ² interval on a standard deviation — good enough at n ≥ 10 and
    // labelled as approximate rather than dressed up as exact.
    const se = measured / Math.sqrt(2 * (residuals.length - 1));
    ci95 = [Math.max(0, measured - 1.96 * se), measured + 1.96 * se];
  }
  const completed = Object.keys(results)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    sigmaTeam: Math.round(sigmaTeam * 100) / 100,
    sigmaMargin: Math.round(sigmaTeam * Math.SQRT2 * 100) / 100,
    measuredSigmaTeam: measured == null ? null : Math.round(measured * 100) / 100,
    ci95: ci95 ? [Math.round(ci95[0] * 100) / 100, Math.round(ci95[1] * 100) / 100] : null,
    n: residuals.length,
    source: completed.length
      ? `sleeper:/matchups points, wk${completed[0]}..wk${completed[completed.length - 1]}`
      : "model only — no completed week in this schedule",
    model: "positionCv",
    note:
      "σ here is the positionCv PRIOR under independence, not a fit. R9 §Q9.3 measured " +
      "σ_margin at 29-32 from 16 team-weeks of residuals, 95% CI [21.4, 44.9], and found the " +
      "priors running ~40% hot on a sampled roster-week — so this P(win) is if anything " +
      "conservative. Any residual reported here reprojects a past week with TODAY's roster and " +
      "today's injury statuses, so treat it as an estimate. Re-fit from real team scores once " +
      "~6 weeks are in (engine change E6).",
  };
}

/** R9 §4.3: 25 % of the budget a quarter, 5-10 % held into weeks 14-17, and any balance left at
 *  week 17 is a loss. `plannedByQuarter` is what is left to spend, not a retrospective. */
function faabPlan(ctx, rosterId) {
  const roster = rosterById(ctx, rosterId);
  const budget = finite(ctx.league.waiverBudget, 0);
  const remaining = Math.max(0, budget - finite(roster && roster.waiverBudgetUsed, 0));
  const reserved = Math.round(remaining * FAAB_PLAYOFF_RESERVE);
  const ahead = FAAB_QUARTERS.filter((q) => q.to >= ctx.week);
  const weight = ahead.reduce((a, q) => a + q.share, 0) || 1;
  const spendable = remaining - reserved;
  return {
    remaining,
    plannedByQuarter: ahead.map((q) => ({
      label: q.label,
      from: q.from,
      to: q.to,
      budget: Math.round((spendable * q.share) / weight),
    })),
    reservedForPlayoffs: reserved,
  };
}

/** The one line the summary leads with. R-15: the berth is bought; present the BYE as the
 *  regular-season scoreboard, and only switch the objective when the bye is out of reach. */
function objectiveAdvice(odds, objective, shape) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  if (!shape.rounds) return `No playoff bracket in this league — every week is the scoreboard.`;
  if (objective === "title") {
    return (
      `Playing for the trophy: ${pct(odds.titleOdds)} title odds, ${pct(odds.firstRoundByeOdds)} for a bye. ` +
      `A point in the playoff weeks is worth roughly 8-11× a point now, so spend on weeks ` +
      `${shape.rounds >= 1 ? "15-17" : "the bracket"} and hold the roster spot.`
    );
  }
  if (odds.playoffOdds >= 0.9 && odds.firstRoundByeOdds < 0.9) {
    return (
      `Your berth is ${pct(odds.playoffOdds)} safe — stop optimizing for it. The live number is the ` +
      `first-round bye at ${pct(odds.firstRoundByeOdds)}: play for the bye.`
    );
  }
  if (odds.playoffOdds < 0.6) {
    return `The berth is not bought (${pct(odds.playoffOdds)}) — every regular-season week still moves it. Play for the berth.`;
  }
  return `Berth ${pct(odds.playoffOdds)}, bye ${pct(odds.firstRoundByeOdds)}, title ${pct(odds.titleOdds)}: play for the bye, and switch to "title" once the bye is settled.`;
}

// --- the map ---------------------------------------------------------------------------------------

/**
 * The season map: one card per week from `from` to `to`, plus the summary the UI leads with.
 *
 * @param {object} ctx
 * @param {{rosterId?:number, from?:number, to?:number, schedule:object,
 *          objective?:"bye"|"title", rosterWeekly?:Function}} opts
 *   `rosterWeekly` is the seam for WS-K's `rosterWeekly(ctx, rosterId) → [{week, mean, sd}]`; until
 *   that module merges the map computes the same quantity locally (see `meanSdAt`).
 * @returns {{weeks:object[], summary:object}}
 */
export function seasonMap(ctx, opts = {}) {
  const cfg = seasonMapSettings(ctx);
  const rosterId = opts.rosterId != null ? opts.rosterId : ctx.myRosterId;
  const from = Math.max(1, finite(opts.from, ctx.week));
  const to = Math.min(ctx.lastWeek, finite(opts.to, ctx.lastWeek));
  const objective = opts.objective || cfg.objective || "bye";
  const corr = finite(cfg.corr, 0);
  const schedule = opts.schedule || { byWeek: {}, playoffWeeks: ctx.playoffWeeks, bracket: { provisional: true, asOfWeek: ctx.week, rounds: [] }, results: {} };
  const roster = rosterById(ctx, rosterId);
  if (!roster || !(to >= from)) {
    return { weeks: [], summary: emptySummary(ctx, rosterId, objective) };
  }

  const cacheKey = `${rosterId}|${from}|${to}|${objective}|${schedule.pulledAt || ""}`;
  const cache = memo(ctx, "map");
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const ids = activePlayers(roster);
  const key = idsKey(ids);
  const weeks = range(from, to);
  const cells = grid(ctx, from, ctx.lastWeek);
  const playoffSet = new Set(ctx.playoffWeeks || []);
  const provisional = !!(schedule.bracket && schedule.bracket.provisional);
  const external = typeof opts.rosterWeekly === "function" ? opts.rosterWeekly(ctx, rosterId) : null;
  const externalBy = new Map();
  for (const row of external || []) externalBy.set(Number(row.week), row);

  /** My week: WS-K's export when it is wired, this module's local computation otherwise. */
  const mine = (w) => {
    const local = meanSdAt(ctx, ids, w, key);
    const ext = externalBy.get(w);
    return ext ? { ...local, mean: finite(ext.mean, local.mean), sd: finite(ext.sd, local.sd) } : local;
  };

  const oppOf = (w) => {
    const oppId = schedule.byWeek && schedule.byWeek[w] ? schedule.byWeek[w][rosterId] : null;
    if (oppId == null) return null;
    const oppRoster = rosterById(ctx, oppId);
    if (!oppRoster) return null;
    const oppIds = activePlayers(oppRoster);
    const useSet = w === ctx.week && (oppRoster.starters || []).some((s) => s && s !== "0");
    const cell = useSet ? setLineup(ctx, oppRoster, w) : meanSdAt(ctx, oppIds, w, idsKey(oppIds));
    return {
      rosterId: oppId,
      teamName: oppRoster.teamName || oppRoster.displayName || `Roster ${oppId}`,
      lineup: cell.lineup.slots,
      mean: cell.mean,
      sd: cell.sd,
      basis: useSet ? "set" : "optimal",
    };
  };
  const oppCache = new Map();
  const sched = {
    opponent: (w) => {
      if (!oppCache.has(w)) oppCache.set(w, oppOf(w));
      return oppCache.get(w);
    },
  };

  const holesByWeek = holesOverWindow(ctx, ids, weeks, key);
  const params = { rosterId, ids, key, from, to, corr, objective, schedule, sched };

  const cards = [];
  for (const w of weeks) {
    const me = mine(w);
    const opp = sched.opponent(w);
    const margin = opp ? me.mean - opp.mean : 0;
    const p = opp ? pWin(me.mean, me.sd, opp.mean, opp.sd, corr) : 0.5;
    const holes = holesByWeek.get(w) || [];
    const moves = [];
    const seenMoves = new Set();
    for (const hole of holes) {
      for (const move of movesForHole(ctx, params, hole)) {
        const k = `${move.addId}|${move.dropId || ""}`;
        if (seenMoves.has(k)) continue;
        seenMoves.add(k);
        moves.push(move);
      }
    }
    cards.push({
      week: w,
      isPlayoffWeek: playoffSet.has(w),
      // Weeks 15-17 have matchup rows, but they are regular-season filler: the bracket overrides
      // them and the seeds it shows are "if the season ended today" (R9 §Q9.2 Findings 2 and 4).
      scheduleIsProvisional: playoffSet.has(w) && provisional,
      me: { lineup: me.lineup.slots, mean: round1(me.mean), sd: round1(me.sd), short: me.short },
      opp: opp
        ? { ...opp, mean: round1(opp.mean), sd: round1(opp.sd) }
        : { rosterId: null, teamName: null, lineup: [], mean: 0, sd: 0, basis: "optimal" },
      margin: round1(margin),
      pWin: Math.round(p * 10000) / 10000,
      strength: weekStrength(p, cfg),
      holes: holes.map(({ slotIndex, ...rest }) => rest),
      // Ranked once more across the card's holes together (the gate still applies), then the
      // internal horizon-fit fields are dropped — they live in `why[]` for the reader.
      moves: rankMoves(moves, objective)
        .slice(0, MAX_MOVES)
        .map(({ _fit, _useful, ...rest }) => rest),
    });
  }

  const summary = summarize(ctx, {
    cards,
    schedule,
    rosterId,
    roster,
    objective,
    from,
    to,
    cells,
    cfg,
  });
  const out = { weeks: cards, summary };
  cache.set(cacheKey, out);
  return out;
}

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

function emptySummary(ctx, rosterId, objective) {
  return {
    expectedWins: { regular: 0, total: 0, record: "0.0-0.0" },
    playoffOdds: 0,
    firstRoundByeOdds: 0,
    topSeedOdds: 0,
    titleOdds: 0,
    weakest: [],
    strongest: [],
    faab: faabPlan(ctx, rosterId),
    sigmaCalibration: null,
    objective,
    objectiveAdvice: "No schedule for this roster — nothing to map.",
  };
}

function summarize(ctx, { cards, schedule, rosterId, roster, objective, from, to, cells, cfg }) {
  const playoffStart = ctx.league.playoffStart || 0;
  const regularCards = cards.filter((c) => !c.isPlayoffWeek && c.opp.rosterId != null);
  const expectedRegular = regularCards.reduce((a, c) => a + c.pWin, 0);
  const played = (roster.wins || 0) + (roster.losses || 0) + (roster.ties || 0);
  const totalWins = (roster.wins || 0) + 0.5 * (roster.ties || 0) + expectedRegular;
  const totalGames = played + regularCards.length;

  const odds = simulateSeason(ctx, schedule, { rosterId, from });
  const shape = bracketShape(ctx, schedule);
  const ranked = cards.filter((c) => c.opp.rosterId != null).map((c) => ({ week: c.week, pWin: c.pWin }));
  const byOdds = [...ranked].sort((a, b) => a.pWin - b.pWin || a.week - b.week);

  return {
    expectedWins: {
      regular: Math.round(expectedRegular * 100) / 100,
      total: Math.round(totalWins * 100) / 100,
      record: `${totalWins.toFixed(1)}-${Math.max(0, totalGames - totalWins).toFixed(1)}`,
    },
    playoffOdds: Math.round(odds.playoffOdds * 10000) / 10000,
    firstRoundByeOdds: Math.round(odds.firstRoundByeOdds * 10000) / 10000,
    topSeedOdds: Math.round(odds.topSeedOdds * 10000) / 10000,
    titleOdds: Math.round(odds.titleOdds * 10000) / 10000,
    weakest: byOdds.slice(0, 3),
    strongest: [...byOdds].reverse().slice(0, 3),
    faab: faabPlan(ctx, rosterId),
    sigmaCalibration: calibration(ctx, schedule, range(from, to), rosterId, cells),
    objective,
    // ω is a LABELLED choice here and nowhere else: `lineup.js`'s `playoffWeight` is untouched,
    // because it prices seeding for every other consumer in the engine (design §3.5).
    omega: finite((cfg.omega || DEFAULTS.seasonMap.omega)[objective], DEFAULTS.seasonMap.omega.bye),
    playoffWeeks: [...(ctx.playoffWeeks || [])],
    playoffStart,
    objectiveAdvice: objectiveAdvice(odds, objective, shape),
  };
}
