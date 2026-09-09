// src/engine/lineup.js — the lineup axis (R3 §c, R4 §2).
// Greedy dedicated-then-FLEX is provably optimal for this slot structure: every dedicated slot's
// eligibility is a subset of FLEX's, so no swap can improve a greedy fill.

import { OUT_STATUSES, POSITIONS } from "../config.js";
import { playerOf, rosPoints, rosteredIds, slotEligibility } from "./context.js";
import { marketValue, rosBaselines } from "./values.js";

/** Statuses that zero a player's projection for the CURRENT week only. Future weeks rely on
 *  Sleeper's projections, which already encode known absences. */
export const WEEK_ZERO_STATUSES = Object.freeze([...OUT_STATUSES, "Doubtful", "Suspended", "COV", "Reserve"]);
const ZERO_SET = new Set(WEEK_ZERO_STATUSES);

/**
 * Is this player on a bye in the given week?
 * @param {object} ctx
 * @param {string} id
 * @param {number} week
 * @returns {boolean}
 */
export function isBye(ctx, id, week) {
  const p = playerOf(ctx, id);
  if (p.bye != null) return Number(p.bye) === week;
  const teamBye = p.team ? ctx.byes[p.team] : null;
  return teamBye != null && Number(teamBye) === week;
}

/**
 * Per-player weekly points with bye and current-week injury zeroing already applied, indexed
 * by week (1-based). Memoized: the finder reads this tens of thousands of times.
 * @param {object} ctx
 * @param {string} id
 * @returns {Float64Array} length lastWeek+1
 */
export function weekVector(ctx, id) {
  if (!ctx.memo.weekVector) ctx.memo.weekVector = new Map();
  const hit = ctx.memo.weekVector.get(id);
  if (hit) return hit;
  const src = ctx.proj.get(id);
  const inj = playerOf(ctx, id).inj;
  const zeroNow = inj != null && ZERO_SET.has(inj);
  const vec = new Float64Array(ctx.lastWeek + 1);
  for (let w = 1; w <= ctx.lastWeek; w += 1) {
    let pts = src ? Number(src[w - 1]) || 0 : 0;
    if (pts && isBye(ctx, id, w)) pts = 0;
    if (pts && zeroNow && w === ctx.week) pts = 0;
    vec[w] = pts;
  }
  ctx.memo.weekVector.set(id, vec);
  return vec;
}

/**
 * Projected points for one player in one week, after bye and current-week injury zeroing.
 * @param {object} ctx
 * @param {string} id
 * @param {number} week 1-based
 * @returns {number}
 */
export function weekPoints(ctx, id, week) {
  if (!(week >= 1) || week > ctx.lastWeek) return 0;
  return weekVector(ctx, id)[week];
}

/**
 * Slot fill order: every single-eligibility ("dedicated") slot first in declaration order, then
 * the flexible slots narrowest-first.
 * @param {object} ctx
 * @returns {number[]} indices into ctx.slots
 */
function fillOrder(ctx) {
  if (ctx.memo.fillOrder) return ctx.memo.fillOrder;
  const order = ctx.slots.map((slot, i) => [i, slotEligibility(slot).length || 99]);
  order.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  ctx.memo.fillOrder = order.map(([i]) => i);
  return ctx.memo.fillOrder;
}

/**
 * Group a roster's players by position once so a 17-week sweep does not regroup 17 times.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {Map<string, Array<{id:string, vec:Float64Array, ros:number}>>}
 */
function prepareRoster(ctx, ids) {
  const byPos = new Map();
  for (const id of ids) {
    const pos = playerOf(ctx, id).pos;
    if (!pos) continue;
    let arr = byPos.get(pos);
    if (!arr) {
      arr = [];
      byPos.set(pos, arr);
    }
    arr.push({ id, vec: weekVector(ctx, id), ros: rosPoints(ctx, id) });
  }
  return byPos;
}

/**
 * Greedy dedicated-then-FLEX fill for one week over a prepared roster.
 * @returns {{filled:Array<{id:string, pts:number}|null>, used:Set<string>, total:number}}
 */
function fillWeek(ctx, byPos, week) {
  for (const arr of byPos.values()) {
    arr.sort((a, b) => b.vec[week] - a.vec[week] || b.ros - a.ros || (a.id < b.id ? -1 : 1));
  }
  const used = new Set();
  const filled = new Array(ctx.slots.length).fill(null);
  let total = 0;
  for (const idx of fillOrder(ctx)) {
    const eligible = slotEligibility(ctx.slots[idx]);
    let pick = null;
    let pickPts = -Infinity;
    for (const pos of eligible) {
      const arr = byPos.get(pos);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 1) {
        const cand = arr[i];
        if (used.has(cand.id)) continue;
        const pts = cand.vec[week];
        // pools are sorted, so the first unused entry is that position's best
        if (pts > pickPts || (pts === pickPts && pick && cand.id < pick.id)) {
          pick = cand;
          pickPts = pts;
        }
        break;
      }
    }
    if (pick) {
      used.add(pick.id);
      filled[idx] = { id: pick.id, pts: pickPts };
      total += pickPts;
    }
  }
  return { filled, used, total };
}

/**
 * Optimal starting lineup for one week. Greedy dedicated-then-FLEX is provably optimal here
 * because every dedicated slot's eligibility is a subset of FLEX's (R4 §2).
 * @param {object} ctx
 * @param {string[]} ids roster player ids
 * @param {number} week 1-based
 * @returns {{slots:Array<{slot:string,id:string|null,pts:number}>, total:number,
 *            short:string[], bench:string[]}}
 */
export function bestLineup(ctx, ids, week) {
  const byPos = prepareRoster(ctx, ids);
  const { filled, used, total } = fillWeek(ctx, byPos, week);
  const slots = ctx.slots.map((slot, i) => ({
    slot,
    id: filled[i] ? filled[i].id : null,
    pts: filled[i] ? filled[i].pts : 0,
  }));
  const short = slots.filter((s) => s.id == null).map((s) => s.slot);
  const bench = ids
    .filter((id) => !used.has(id))
    .sort((a, b) => weekPoints(ctx, b, week) - weekPoints(ctx, a, week) || (a < b ? -1 : 1));
  return { slots, total, short, bench };
}

/**
 * Season-long lineup strength over the remaining weeks, with the playoff weeks weighted up.
 * `avgPerWeek` is the ω-weighted mean — the ΔL_pw display unit in R3 §c.
 * @param {object} ctx
 * @param {string[]} ids
 * @param {{weeks?:number[], playoffWeight?:number}} [opts]
 * @returns {{total:number, weighted:number, perWeek:Array<{week:number,total:number,short:string[]}>,
 *            avgPerWeek:number, playoffAvg:number, shortWeeks:Array<{week:number,short:string[]}>}}
 */
export function seasonLineup(ctx, ids, opts = {}) {
  const weeks = opts.weeks || ctx.weeksLeft;
  const omega = opts.playoffWeight != null ? opts.playoffWeight : ctx.settings.playoffWeight;
  const playoff = new Set(ctx.playoffWeeks);
  const byPos = prepareRoster(ctx, ids);
  const perWeek = [];
  const shortWeeks = [];
  let total = 0;
  let weighted = 0;
  let weightSum = 0;
  let playoffTotal = 0;
  let playoffCount = 0;
  for (const w of weeks) {
    const { filled, total: wkTotal } = fillWeek(ctx, byPos, w);
    const short = [];
    for (let i = 0; i < filled.length; i += 1) if (!filled[i]) short.push(ctx.slots[i]);
    const weight = playoff.has(w) ? omega : 1;
    perWeek.push({ week: w, total: wkTotal, short });
    if (short.length) shortWeeks.push({ week: w, short });
    total += wkTotal;
    weighted += weight * wkTotal;
    weightSum += weight;
    if (playoff.has(w)) {
      playoffTotal += wkTotal;
      playoffCount += 1;
    }
  }
  return {
    total,
    weighted,
    perWeek,
    avgPerWeek: weightSum ? weighted / weightSum : 0,
    playoffAvg: playoffCount ? playoffTotal / playoffCount : 0,
    shortWeeks,
  };
}

/**
 * Free agents grouped by position, best-first by remaining-season points then market value.
 * @param {object} ctx
 * @returns {Object<string, string[]>}
 */
export function freeAgentPool(ctx) {
  if (ctx.memo.freeAgentPool) return ctx.memo.freeAgentPool;
  const taken = rosteredIds(ctx);
  const byPos = {};
  for (const [id, p] of ctx.players) {
    if (!p || !POSITIONS.includes(p.pos) || taken.has(id)) continue;
    (byPos[p.pos] = byPos[p.pos] || []).push(id);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => {
      const d = rosPoints(ctx, b) - rosPoints(ctx, a);
      if (d) return d;
      const ma = marketValue(ctx, a).mAdj || 0;
      const mb = marketValue(ctx, b).mAdj || 0;
      return mb - ma || (a < b ? -1 : 1);
    });
  }
  ctx.memo.freeAgentPool = byPos;
  return byPos;
}

/**
 * Starting-slot demand per position, spreading the FLEX slots proportionally across the
 * FLEX-eligible positions.
 * @param {object} ctx
 * @returns {Object<string, number>}
 */
export function slotDemand(ctx) {
  if (ctx.memo.slotDemand) return ctx.memo.slotDemand;
  const dedicated = {};
  let flexSlots = 0;
  for (const slot of ctx.slots) {
    const elig = slotEligibility(slot);
    if (elig.length === 1) dedicated[elig[0]] = (dedicated[elig[0]] || 0) + 1;
    else flexSlots += 1;
  }
  let flexBase = 0;
  for (const pos of ctx.flexEligible) flexBase += dedicated[pos] || 0;
  const demand = { ...dedicated };
  if (flexSlots && flexBase) {
    for (const pos of ctx.flexEligible) demand[pos] = (demand[pos] || 0) + (flexSlots * (dedicated[pos] || 0)) / flexBase;
  }
  ctx.memo.slotDemand = demand;
  return demand;
}

/**
 * Fill freed roster spots from the wire. Required, or every 2-for-1 scores wrong: the side that
 * ends with fewer players would otherwise be evaluated a body short (R3 §c).
 * Picks at the position of greatest shortfall vs starting slots; when no position is actually
 * short (the usual case on a 17-man roster with 11 slots) it takes the best free agent outright.
 * @param {object} ctx
 * @param {string[]} ids roster after the trade
 * @param {number} targetCount roster size to restore
 * @param {Iterable<string>} [exclude] ids that must not be signed (e.g. players in the trade)
 * @returns {{ids:string[], added:Array<{id:string,pos:string,m:number|null}>}}
 */
export function backfill(ctx, ids, targetCount, exclude) {
  const roster = [...ids];
  const added = [];
  const cap = Math.min(targetCount, ctx.league.maxRoster);
  if (roster.length >= cap) return { ids: roster, added };

  const pool = freeAgentPool(ctx);
  const blocked = new Set(exclude || []);
  for (const id of roster) blocked.add(id);
  const cursor = {};
  const demand = slotDemand(ctx);
  const have = {};
  for (const id of roster) {
    const pos = playerOf(ctx, id).pos;
    if (pos) have[pos] = (have[pos] || 0) + 1;
  }

  const nextAt = (pos) => {
    const arr = pool[pos] || [];
    let i = cursor[pos] || 0;
    while (i < arr.length && blocked.has(arr[i])) i += 1;
    cursor[pos] = i;
    return i < arr.length ? arr[i] : null;
  };

  while (roster.length < cap) {
    let choice = null;
    let bestDeficit = -Infinity;
    let bestPts = -Infinity;
    for (const pos of POSITIONS) {
      const cand = nextAt(pos);
      if (!cand) continue;
      const deficit = (demand[pos] || 0) - (have[pos] || 0);
      const pts = rosPoints(ctx, cand);
      if (deficit > bestDeficit || (deficit === bestDeficit && pts > bestPts)) {
        bestDeficit = deficit;
        bestPts = pts;
        choice = { id: cand, pos };
      }
    }
    if (bestDeficit <= 0) {
      // No position is genuinely short — take the best free agent anywhere, ranked by points
      // OVER that position's replacement level. Raw points would sign a third QB every time,
      // because a 1QB league's quarterbacks out-score every flex body (R3 §c "by tilt").
      const { baseline } = rosBaselines(ctx);
      choice = null;
      let bestVorp = -Infinity;
      for (const pos of POSITIONS) {
        // K and DEF have no replacement baseline (they are never valued), and a spare one is
        // never the best use of an open spot — the deficit branch above covers a genuine hole.
        if (baseline[pos] == null) continue;
        const cand = nextAt(pos);
        if (!cand) continue;
        const vorp = rosPoints(ctx, cand) - baseline[pos];
        if (vorp > bestVorp) {
          bestVorp = vorp;
          choice = { id: cand, pos };
        }
      }
    }
    if (!choice) break;
    roster.push(choice.id);
    blocked.add(choice.id);
    have[choice.pos] = (have[choice.pos] || 0) + 1;
    added.push({ id: choice.id, pos: choice.pos, m: marketValue(ctx, choice.id).mAdj });
  }
  return { ids: roster, added };
}

/**
 * Sign the best available free agent at each named position (used to repair a lineup that is
 * short a slot after a trade).
 * @param {object} ctx
 * @param {string[]} ids
 * @param {string[]} positions positions to cover, best-effort in order
 * @param {Iterable<string>} [exclude]
 * @returns {{ids:string[], added:Array<{id:string,pos:string,m:number|null}>}}
 */
export function backfillPositions(ctx, ids, positions, exclude) {
  const roster = [...ids];
  const added = [];
  const pool = freeAgentPool(ctx);
  const blocked = new Set(exclude || []);
  for (const id of roster) blocked.add(id);
  for (const pos of positions) {
    if (roster.length >= ctx.league.maxRoster) break;
    const arr = pool[pos] || [];
    const pick = arr.find((id) => !blocked.has(id));
    if (!pick) continue;
    roster.push(pick);
    blocked.add(pick);
    added.push({ id: pick, pos, m: marketValue(ctx, pick).mAdj });
  }
  return { ids: roster, added };
}
