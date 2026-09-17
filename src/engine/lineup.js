// src/engine/lineup.js — the lineup axis (R3 §c, R4 §2).
// Greedy dedicated-then-FLEX is provably optimal for this slot structure: every dedicated slot's
// eligibility is a subset of FLEX's, so no swap can improve a greedy fill.

import { DEFAULTS, OUT_STATUSES, POSITIONS } from "../config.js";
import { playerOf, rosPoints, rosteredIds, slotEligibility } from "./context.js";
import { marketValue, rosBaselines } from "./values.js";
// Cycle with injuries.js (it imports `isBye` from here). Safe: neither module touches the
// other's bindings while the modules are evaluating — both sides are hoisted function
// declarations, called only after both modules are live.
import { absenceOf, availability } from "./injuries.js";

/** Statuses that zero a player's projection for the CURRENT week only — the floor under the
 *  availability scaling below, kept explicit so a hand-edited injury table cannot start a
 *  Doubtful player. */
export const WEEK_ZERO_STATUSES = Object.freeze([...OUT_STATUSES, "Doubtful", "Suspended", "COV", "Reserve"]);
const ZERO_SET = new Set(WEEK_ZERO_STATUSES);

/** How many free agents per position enter the streamer table (sorted by remaining points, so
 *  the best scorer in any one week is inside this window in every realistic league). */
const STREAM_POOL = 20;
/** How many streamer candidates are kept per position per week, so that a roster already
 *  holding the best one still reads the next body down rather than zero. */
const STREAM_DEPTH = 4;

/**
 * One settings block, merged over its DEFAULTS key by key and memoized per ctx.
 *
 * `mergeSettings` (context.js — not this workstream's file) deep-merges only the blocks it knows
 * about, so a user patch like `{ streaming: { enabled: false } }` would otherwise drop `friction`.
 * @param {object} ctx
 * @param {string} name key in DEFAULTS
 * @returns {object}
 */
export function settingsBlock(ctx, name) {
  if (!ctx.memo) ctx.memo = {};
  if (!ctx.memo.cfgBlocks) ctx.memo.cfgBlocks = {};
  const hit = ctx.memo.cfgBlocks[name];
  if (hit) return hit;
  const base = DEFAULTS[name] || {};
  const patch = ctx.settings ? ctx.settings[name] : null;
  const out = patch && typeof patch === "object" ? { ...base, ...patch } : { ...base };
  ctx.memo.cfgBlocks[name] = out;
  return out;
}

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
 * Has a scenario context already discounted this player's projections for an absence?
 *
 * `withAbsence` (injuries.js) patches `ctx.proj` directly and stamps the id here. Without the
 * stamp the scaling below would apply a second time and square the discount (§13.5 D1).
 * @param {object} ctx
 * @param {string} id
 * @returns {boolean}
 */
function absenceApplied(ctx, id) {
  if (ctx.absenceApplied && ctx.absenceApplied.has(id)) return true;
  const set = ctx.memo && ctx.memo.absenceApplied;
  return !!(set && set.has(id));
}

/**
 * Per-player weekly points with byes, the current-week injury floor and the ABSENCE DISCOUNT
 * already applied, indexed by week (1-based). Memoized: the finder reads this tens of thousands
 * of times, and the absence lookup happens once per player per context.
 *
 * §13.5 D1: weeks from `ctx.week` on are scaled by `availability(ctx, id, w, absenceOf(row))` —
 * the advisor's duration table — because Sleeper's future-week projections do not encode fresh
 * news. Week `ctx.week` is still forced to 0 for WEEK_ZERO_STATUSES whatever the table says, and
 * a scenario ctx built by `withAbsence` is skipped (its projections already carry the discount).
 * `DEFAULTS.availability.scaleFutureWeeks = false` restores the old current-week-only rule.
 * @param {object} ctx
 * @param {string} id
 * @returns {Float64Array} length lastWeek+1
 */
export function weekVector(ctx, id) {
  if (!ctx.memo.weekVector) ctx.memo.weekVector = new Map();
  const hit = ctx.memo.weekVector.get(id);
  if (hit) return hit;
  const src = ctx.proj.get(id);
  const row = playerOf(ctx, id);
  const inj = row.inj;
  const zeroNow = inj != null && ZERO_SET.has(inj);
  const scaleOn = settingsBlock(ctx, "availability").scaleFutureWeeks !== false;
  const absence = inj != null && scaleOn && !absenceApplied(ctx, id) ? absenceOf(ctx, row) : null;
  const vec = new Float64Array(ctx.lastWeek + 1);
  for (let w = 1; w <= ctx.lastWeek; w += 1) {
    let pts = src ? Number(src[w - 1]) || 0 : 0;
    if (pts && isBye(ctx, id, w)) pts = 0;
    if (pts && absence && w >= ctx.week) pts *= availability(ctx, id, w, absence);
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
 * Best free agents per position per week — the "what the wire is worth" table (§13.5 D2).
 *
 * Built ONCE per context: the finder evaluates tens of thousands of lineups and every one of
 * them would otherwise re-scan the wire. Only the top `STREAM_POOL` free agents per position by
 * remaining-season points are considered (the best single-week scorer is inside that window in
 * any realistic league) and only the top `STREAM_DEPTH` are kept per week, so a roster that
 * already holds the best streamer still reads the next body down rather than zero.
 * @param {object} ctx
 * @returns {Object<string, Array<Array<{id:string, pts:number}>>>} pos → week → best-first list
 */
export function streamerTable(ctx) {
  if (ctx.memo.streamerTable) return ctx.memo.streamerTable;
  const pool = freeAgentPoolByPos(ctx);
  const table = {};
  for (const pos of Object.keys(pool)) {
    const weeks = new Array(ctx.lastWeek + 1);
    for (let w = 0; w <= ctx.lastWeek; w += 1) weeks[w] = [];
    for (const id of pool[pos].slice(0, STREAM_POOL)) {
      const vec = weekVector(ctx, id);
      for (let w = 1; w <= ctx.lastWeek; w += 1) {
        const pts = vec[w];
        if (pts <= 0) continue;
        const list = weeks[w];
        if (list.length < STREAM_DEPTH) list.push({ id, pts });
        else if (pts > list[list.length - 1].pts) list[list.length - 1] = { id, pts };
        else continue;
        list.sort((a, b) => b.pts - a.pts || (a.id < b.id ? -1 : 1));
      }
    }
    table[pos] = weeks;
  }
  ctx.memo.streamerTable = table;
  return table;
}

/**
 * What one empty starting slot is worth off the wire in one week: friction × the best free agent
 * at an eligible, streamable position who is not already on the roster and has not already been
 * signed for another slot this week.
 *
 * Friction is per position (R5 §5.5): a streamed QB lands within 2–3 points of the average QB5
 * while fewer than ~25 quarterbacks are claimed league-wide, and an 8-team league claims 8–12 —
 * so the wire QB is nearly a real starter (0.90) while a mid-week WR add rarely inherits a role
 * at once (0.60).
 * @param {object} ctx
 * @param {string} slot
 * @param {number} week
 * @param {Set<string>|null} taken ids that cannot double as the streamer (the roster itself)
 * @param {Set<string>|null} [used] ids already streamed into another slot this week
 * @returns {{id:string, pts:number, raw:number, pos:string}|null} null when streaming is off or
 *   the wire has nobody left
 */
export function streamerFor(ctx, slot, week, taken, used) {
  const cfg = settingsBlock(ctx, "streaming");
  if (cfg.enabled === false) return null;
  const fallback = Number.isFinite(Number(cfg.friction)) ? Number(cfg.friction) : DEFAULTS.streaming.friction;
  const byPos = cfg.frictionByPos || DEFAULTS.streaming.frictionByPos || {};
  const allowed = Array.isArray(cfg.positions) ? cfg.positions : DEFAULTS.streaming.positions;
  const table = streamerTable(ctx);
  let best = null;
  for (const pos of slotEligibility(slot)) {
    if (!allowed.includes(pos)) continue;
    const list = (table[pos] || [])[week] || [];
    for (const row of list) {
      if (taken && taken.has(row.id)) continue;
      if (used && used.has(row.id)) continue;
      const friction = Number.isFinite(Number(byPos[pos])) ? Number(byPos[pos]) : fallback;
      const pts = row.pts * friction;
      if (!best || pts > best.pts) best = { id: row.id, raw: row.pts, pts, pos };
      break; // the list is best-first, so the first body we may sign is that position's best
    }
  }
  return best;
}

/**
 * How many slots this roster could actually stream in one week (R5 §5.5 rule 2): one waiver run a
 * week, and every claim needs somewhere to put the body. Three free streams in a bye-heavy week
 * is fiction, and it is how a single add "fixes" three holes at once.
 * @param {object} ctx
 * @param {string[]|Set<string>} ids
 * @returns {number}
 */
export function streamBudget(ctx, ids) {
  const cfg = settingsBlock(ctx, "streaming");
  if (cfg.enabled === false) return 0;
  const cap = Number.isFinite(Number(cfg.maxSlotsPerWeek))
    ? Number(cfg.maxSlotsPerWeek)
    : DEFAULTS.streaming.maxSlotsPerWeek;
  const size = Array.isArray(ids) ? ids.length : ids ? ids.size : 0;
  const freeSpots = Math.max(0, (ctx.league ? ctx.league.maxRoster : 0) - size);
  const droppable = Math.max(0, size - ctx.slots.length);
  return Math.max(0, Math.min(cap, freeSpots + droppable));
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
 * Greedy dedicated-then-FLEX fill for one week over a prepared roster, with the streaming credit
 * for empty slots (§13.5 D2).
 *
 * "Empty" is a slot no rostered body can score in: nobody eligible at all, or the best eligible
 * body is on a bye / ruled out / discounted to zero. Those — and only those — are credited with
 * `friction × best free agent`, because that is what the manager would actually do. A slot whose
 * incumbent scores anything at all is NOT topped up: this prices the hole, not the upgrade.
 * @param {object} ctx
 * @param {Map} byPos prepared roster
 * @param {number} week
 * @param {Set<string>|null} [taken] ids that may not double as the streamer (the roster itself)
 * @param {number} [budget] how many slots this roster could actually stream this week
 * @returns {{filled:Array<{id:string, pts:number, streamed?:number}|null>, used:Set<string>,
 *            total:number, streamed:Array<{slot:string, pts:number, id:string}>}}
 */
function fillWeek(ctx, byPos, week, taken, budget = 0) {
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

  const streamed = [];
  const holes = [];
  for (let i = 0; i < filled.length; i += 1) {
    if ((filled[i] ? filled[i].pts : 0) <= 0) holes.push(i);
  }
  if (holes.length && budget > 0) {
    // The k-th stream uses the k-th-best free agent (R5 §5.5 rule 1) and the week's budget is
    // capped (rule 2), so a bye-heavy week is covered twice, not five times, and never by the
    // same body twice. Best hole first: that is the one a manager would actually claim for.
    const signed = new Set();
    const done = new Set();
    let left = budget;
    while (left > 0) {
      let pickIdx = -1;
      let pick = null;
      for (const i of holes) {
        if (done.has(i)) continue;
        const stream = streamerFor(ctx, ctx.slots[i], week, taken, signed);
        if (!stream) continue;
        if (!pick || stream.pts > pick.pts) {
          pick = stream;
          pickIdx = i;
        }
      }
      if (!pick) break;
      const held = filled[pickIdx] ? filled[pickIdx].pts : 0;
      done.add(pickIdx);
      signed.add(pick.id);
      left -= 1;
      if (pick.pts <= held) continue;
      total += pick.pts - held;
      streamed.push({ slot: ctx.slots[pickIdx], pts: pick.pts, id: pick.id });
      // `id` stays what the roster holds (null when it holds nobody) so `short` keeps its meaning:
      // a slot with no legal body is still short, it is simply no longer worth zero.
      filled[pickIdx] = { id: filled[pickIdx] ? filled[pickIdx].id : null, pts: pick.pts, streamed: pick.id };
    }
  }
  return { filled, used, total, streamed };
}

/**
 * Optimal starting lineup for one week. Greedy dedicated-then-FLEX is provably optimal here
 * because every dedicated slot's eligibility is a subset of FLEX's (R4 §2).
 * @param {object} ctx
 * @param {string[]} ids roster player ids
 * @param {number} week 1-based
 * `pts` on a slot is what the slot is WORTH — for an empty slot that is the streaming credit
 * (§13.5 D2), and `streamed` names the free agent it came from. `short` keeps its old meaning:
 * slots the roster itself cannot fill.
 * @returns {{slots:Array<{slot:string,id:string|null,pts:number,streamed?:string}>, total:number,
 *            short:string[], bench:string[], streamed:Array<{slot:string,pts:number,id:string}>}}
 */
export function bestLineup(ctx, ids, week) {
  const byPos = prepareRoster(ctx, ids);
  const taken = new Set(ids);
  const { filled, used, total, streamed } = fillWeek(ctx, byPos, week, taken, streamBudget(ctx, ids));
  const slots = ctx.slots.map((slot, i) => ({
    slot,
    id: filled[i] ? filled[i].id : null,
    pts: filled[i] ? filled[i].pts : 0,
    ...(filled[i] && filled[i].streamed ? { streamed: filled[i].streamed } : {}),
  }));
  const short = slots.filter((s) => s.id == null).map((s) => s.slot);
  const bench = ids
    .filter((id) => !used.has(id))
    .sort((a, b) => weekPoints(ctx, b, week) - weekPoints(ctx, a, week) || (a < b ? -1 : 1));
  return { slots, total, short, bench, streamed };
}

/**
 * Season-long lineup strength over the remaining weeks, with the playoff weeks weighted up.
 * `avgPerWeek` is the ω-weighted mean — the ΔL_pw display unit in R3 §c.
 * @param {object} ctx
 * @param {string[]} ids
 * @param {{weeks?:number[], playoffWeight?:number, exclude?:Iterable<string>}} [opts]
 *   `exclude` adds ids the wire may not supply as streamers (the roster's own ids are already
 *   excluded — a player cannot be both on this roster and a free agent).
 * @returns {{total:number, weighted:number, perWeek:Array<{week:number,total:number,short:string[]}>,
 *            avgPerWeek:number, playoffAvg:number, shortWeeks:Array<{week:number,short:string[]}>,
 *            streamed:Array<{week:number,slot:string,pts:number,id:string}>}}
 */
export function seasonLineup(ctx, ids, opts = {}) {
  const weeks = opts.weeks || ctx.weeksLeft;
  const omega = opts.playoffWeight != null ? opts.playoffWeight : ctx.settings.playoffWeight;
  const playoff = new Set(ctx.playoffWeeks);
  const byPos = prepareRoster(ctx, ids);
  const taken = new Set(ids);
  for (const id of opts.exclude || []) taken.add(id);
  const budget = streamBudget(ctx, ids);
  const perWeek = [];
  const shortWeeks = [];
  const streamed = [];
  let total = 0;
  let weighted = 0;
  let weightSum = 0;
  let playoffTotal = 0;
  let playoffCount = 0;
  for (const w of weeks) {
    const { filled, total: wkTotal, streamed: wkStreamed } = fillWeek(ctx, byPos, w, taken, budget);
    const short = [];
    for (let i = 0; i < filled.length; i += 1) if (!filled[i] || filled[i].id == null) short.push(ctx.slots[i]);
    for (const s of wkStreamed) streamed.push({ week: w, ...s });
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
    streamed,
  };
}

/**
 * Free agents grouped by position, best-first by remaining-season points then market value.
 * The flat, league-facing pool lives in waiver.js as `freeAgentPool` (design.md §11.2); this one
 * is the backfill index — keyed by position because backfill always asks "who is the best X left".
 * @param {object} ctx
 * @returns {Object<string, string[]>}
 */
export function freeAgentPoolByPos(ctx) {
  if (ctx.memo.faPoolByPos) return ctx.memo.faPoolByPos;
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
  ctx.memo.faPoolByPos = byPos;
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

  const pool = freeAgentPoolByPos(ctx);
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
  const pool = freeAgentPoolByPos(ctx);
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
