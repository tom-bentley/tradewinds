// src/engine/trade.js — evaluate one proposed trade from both sides (R3 §b–§e, design.md §4).
// Three numbers are always produced, never one: Edge% (market), ΔL_pw (lineup) and ΔL_po
// (playoff lineup). The verdict is a label over Edge% with ordered overrides on top.

import { TRADEABLE } from "../config.js";
import { activePlayers, playerOf, rosPoints, rosterById, slotEligibility } from "./context.js";
import { marketValue, sideValue, surplus } from "./values.js";
import { backfill, backfillPositions, freeAgentPool, isBye, seasonLineup } from "./lineup.js";
import { explain, flagText, FREE_ELSEWHERE_PCT, TREND_FLAG, UNSETTLED_SHARE } from "./explain.js";

/** Edge% band boundaries (R3 §e). */
export const EDGE_BANDS = Object.freeze({ steal: 25, clearWin: 10, slightWin: 4, fair: -4, slightLoss: -10, clearLoss: -25 });
/** ΔL_pw magnitude at which the lineup overrides the market verdict (R3 §e overrides 3 and 4). */
export const LINEUP_OVERRIDE_PTS = 1.5;
/** |Edge%| at which the league's veto machinery becomes a real risk. */
export const VETO_EDGE = 40;
/** Rival acceptance thresholds (R3 §f stage 5). */
export const ACCEPT_EDGE = -2;
export const ACCEPT_DELTA = 0.75;

/** Human labels for each verdict code. */
export const VERDICT_LABELS = Object.freeze({
  steal: "Steal — accept now",
  clear_win: "Clear win",
  slight_win: "Slight win",
  fair: "Fair",
  slight_loss: "Slight loss",
  clear_loss: "Clear loss — decline",
  fleeced: "Fleeced — decline",
  invalid: "Invalid",
  needs_drop: "Requires a drop",
  lineup_win: "Win — you get better now",
  paper_win: "Fair — you win on paper, lose on the field",
});

/**
 * Edge% band for a surplus edge.
 * @param {number} edge
 * @returns {string} verdict code
 */
export function edgeBand(edge) {
  if (edge >= EDGE_BANDS.steal) return "steal";
  if (edge >= EDGE_BANDS.clearWin) return "clear_win";
  if (edge >= EDGE_BANDS.slightWin) return "slight_win";
  if (edge > EDGE_BANDS.fair) return "fair";
  if (edge > EDGE_BANDS.slightLoss) return "slight_loss";
  if (edge > EDGE_BANDS.clearLoss) return "clear_loss";
  return "fleeced";
}

/**
 * Edge% = 100·(get − give)/max(get, give) — the surplus-based fairness metric (R3 §e).
 * @param {number} getV
 * @param {number} giveV
 * @returns {number}
 */
export function edgePct(getV, giveV) {
  const denom = Math.max(getV, giveV);
  if (!denom) return 0;
  return (100 * (getV - giveV)) / denom;
}

/**
 * seasonLineup memoized on the sorted roster id set — the finder evaluates the same "before"
 * roster thousands of times.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {object} seasonLineup result
 */
export function cachedSeasonLineup(ctx, ids) {
  if (!ctx.memo.seasonLineup) ctx.memo.seasonLineup = new Map();
  const key = [...ids].sort().join("|");
  const hit = ctx.memo.seasonLineup.get(key);
  if (hit) return hit;
  const out = seasonLineup(ctx, ids);
  ctx.memo.seasonLineup.set(key, out);
  return out;
}

/**
 * Starting-slot counts per position, and the flex-eligible total, used by the drop check.
 * @param {object} ctx
 */
function slotCounts(ctx) {
  if (ctx.memo.slotCounts) return ctx.memo.slotCounts;
  const dedicated = {};
  let flexSlots = 0;
  for (const slot of ctx.slots) {
    const elig = slotEligibility(slot);
    if (elig.length === 1) dedicated[elig[0]] = (dedicated[elig[0]] || 0) + 1;
    else flexSlots += 1;
  }
  let flexDedicated = 0;
  for (const pos of ctx.flexEligible) flexDedicated += dedicated[pos] || 0;
  ctx.memo.slotCounts = { dedicated, flexSlots, flexDedicated };
  return ctx.memo.slotCounts;
}

/**
 * Cheapest player this roster can actually afford to cut: lowest surplus, then lowest remaining
 * points, never a player whose removal would leave a lineup slot unfillable.
 * @param {object} ctx
 * @param {string[]} ids roster after the trade
 * @param {Iterable<string>} [protectedIds] players that must not be suggested (e.g. just acquired)
 * @returns {string|null}
 */
export function cheapestDroppable(ctx, ids, protectedIds) {
  const guard = new Set(protectedIds || []);
  const { dedicated, flexSlots, flexDedicated } = slotCounts(ctx);
  const counts = {};
  let flexEligibleCount = 0;
  for (const id of ids) {
    const pos = playerOf(ctx, id).pos;
    if (!pos) continue;
    counts[pos] = (counts[pos] || 0) + 1;
    if (ctx.flexEligible.has(pos)) flexEligibleCount += 1;
  }
  let best = null;
  let bestKey = null;
  for (const id of ids) {
    if (guard.has(id)) continue;
    const pos = playerOf(ctx, id).pos;
    const need = dedicated[pos] || 0;
    if (need && (counts[pos] || 0) <= need) continue; // dropping would empty a dedicated slot
    if (ctx.flexEligible.has(pos) && flexEligibleCount <= flexDedicated + flexSlots) continue;
    const key = [surplus(ctx, id), rosPoints(ctx, id), id];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      bestKey = key;
      best = id;
    }
  }
  return best;
}

/**
 * Evaluate one side of the trade from that side's own perspective.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {string[]} give ids this side sends
 * @param {string[]} get ids this side receives
 * @param {Set<string>} involved every id in the trade (never available as a free agent)
 */
function evaluateSide(ctx, rosterId, give, get, involved) {
  const roster = rosterById(ctx, rosterId);
  const before = activePlayers(roster);
  const giveSet = new Set(give);
  let afterIds = before.filter((id) => !giveSet.has(id)).concat(get);
  const tradedCount = afterIds.length;

  const added = [];
  if (afterIds.length < before.length) {
    const filled = backfill(ctx, afterIds, before.length, involved);
    afterIds = filled.ids;
    added.push(...filled.added);
  }

  let afterLineup = cachedSeasonLineup(ctx, afterIds);
  // Repair a lineup that is short a slot. Sleeper forces this move anyway: a legal lineup is not
  // optional, so a full roster cuts its cheapest body to make room rather than being unplayable.
  const forcedDrops = [];
  if (afterLineup.shortWeeks.length) {
    const positions = [];
    for (const { short } of afterLineup.shortWeeks) {
      for (const slot of short) {
        for (const pos of slotEligibility(slot)) {
          if (!positions.includes(pos)) positions.push(pos);
        }
      }
    }
    const pool = freeAgentPool(ctx);
    let working = afterIds;
    for (const pos of positions) {
      const onRoster = new Set(working);
      const available = (pool[pos] || []).some((id) => !onRoster.has(id) && !involved.has(id));
      if (!available) continue; // nothing on the wire covers this slot — the trade stays invalid
      if (working.length >= ctx.league.maxRoster) {
        const cut = cheapestDroppable(ctx, working, get);
        if (!cut) continue;
        working = working.filter((id) => id !== cut);
        forcedDrops.push(cut);
      }
      const repaired = backfillPositions(ctx, working, [pos], involved);
      if (!repaired.added.length) continue;
      working = repaired.ids;
      added.push(...repaired.added);
    }
    if (working !== afterIds) {
      afterIds = working;
      afterLineup = cachedSeasonLineup(ctx, afterIds);
    }
  }

  const beforeLineup = cachedSeasonLineup(ctx, before);
  const valueGive = sideValue(ctx, give);
  const valueGet = sideValue(ctx, get);
  const shortDetail = afterLineup.shortWeeks.length
    ? { week: afterLineup.shortWeeks[0].week, slot: afterLineup.shortWeeks[0].short[0] }
    : null;

  const rosterCount = { before: before.length, after: tradedCount, max: ctx.league.maxRoster };
  const dropSuggestion =
    tradedCount > ctx.league.maxRoster ? cheapestDroppable(ctx, afterIds, get) : forcedDrops[0] || null;

  return {
    valueGive: { raw: valueGive.raw, surplus: valueGive.surplus, best: valueGive.best },
    valueGet: { raw: valueGet.raw, surplus: valueGet.surplus, best: valueGet.best },
    edgePct: edgePct(valueGet.surplus, valueGive.surplus),
    lineup: {
      before: beforeLineup,
      after: afterLineup,
      deltaPerWeek: afterLineup.avgPerWeek - beforeLineup.avgPerWeek,
      deltaPlayoffPerWeek: afterLineup.playoffAvg - beforeLineup.playoffAvg,
    },
    rosterCount,
    backfill: added.map((a) => a.id),
    backfillDetail: added,
    forcedDrops,
    dropSuggestion,
    shortDetail,
    afterIds,
  };
}

/**
 * Collect the flags for both sides. Types match design.md §4.
 */
function buildFlags(ctx, me, them, give, get) {
  const flags = [];
  const deadline = ctx.league.tradeDeadlineWeek;
  if (deadline > 0 && ctx.week > deadline) {
    flags.push({ type: "deadline", severity: "block", week: deadline, now: ctx.week });
  }
  for (const side of [
    { key: "me", data: me, mine: give, theirs: get },
    { key: "them", data: them, mine: get, theirs: give },
  ]) {
    if (side.data.shortDetail) {
      flags.push({ type: "short", severity: "block", side: side.key, ...side.data.shortDetail });
    }
    if (side.data.rosterCount.after > side.data.rosterCount.max) {
      flags.push({
        type: "roster_size",
        severity: "warn",
        side: side.key,
        count: side.data.rosterCount.after,
        max: side.data.rosterCount.max,
        drop: side.data.dropSuggestion,
      });
    }
    let sd = 0;
    for (const id of side.theirs) {
      const mv = marketValue(ctx, id);
      if (mv.sd != null) sd += Math.abs(mv.sd);
    }
    if (sd > 0 && sd > UNSETTLED_SHARE * side.data.valueGet.raw) {
      flags.push({ type: "unsettled", severity: "info", side: side.key });
    }
  }
  for (const id of [...give, ...get]) {
    const mv = marketValue(ctx, id);
    const p = playerOf(ctx, id);
    if (p.inj) flags.push({ type: "injury", severity: "warn", id, status: p.inj });
    if (isBye(ctx, id, ctx.week)) flags.push({ type: "bye", severity: "info", id, week: ctx.week });
    if (mv.fallback === "curve") flags.push({ type: "coverage", severity: "warn", id });
    if (mv.rosterPct != null && mv.rosterPct < FREE_ELSEWHERE_PCT) {
      flags.push({ type: "free_elsewhere", severity: "warn", id, rosterPct: mv.rosterPct });
    }
    if (mv.trend != null && Math.abs(mv.trend) >= TREND_FLAG) {
      flags.push({ type: "trend", severity: "info", id, trend: mv.trend });
    }
  }
  return flags;
}

/**
 * Evaluate a proposed trade. Both sides are scored from their own perspective, so the rival's
 * acceptance model is the same engine, not a heuristic.
 * @param {object} ctx
 * @param {{myRosterId:number, theirRosterId:number, give:string[], get:string[]}} proposal
 * @param {{withExplain?:boolean}} [opts] withExplain=false skips text building (finder hot path)
 * @returns {object} TradeResult (design.md §4)
 */
export function evaluateTrade(ctx, proposal, opts = {}) {
  const withExplain = opts.withExplain !== false;
  const myRosterId = proposal.myRosterId != null ? proposal.myRosterId : ctx.myRosterId;
  const theirRosterId = proposal.theirRosterId;
  const give = [...(proposal.give || [])];
  const get = [...(proposal.get || [])];

  const mine = rosterById(ctx, myRosterId);
  const theirs = rosterById(ctx, theirRosterId);
  const problems = [];
  if (!mine || !theirs || myRosterId === theirRosterId) problems.push("Both sides must be different rosters in this league.");
  if (!give.length && !get.length) problems.push("Nothing is being traded.");
  if (mine) {
    const own = new Set(activePlayers(mine));
    for (const id of give) if (!own.has(id)) problems.push(`${playerOf(ctx, id).name} is not on your active roster.`);
  }
  if (theirs) {
    const own = new Set(activePlayers(theirs));
    for (const id of get) if (!own.has(id)) problems.push(`${playerOf(ctx, id).name} is not on their active roster.`);
  }
  for (const id of [...give, ...get]) {
    if (!TRADEABLE.includes(playerOf(ctx, id).pos)) problems.push(`${playerOf(ctx, id).name} (K/DEF) cannot be traded.`);
  }

  if (problems.length) {
    return invalidResult(ctx, { myRosterId, theirRosterId, give, get }, problems);
  }

  const involved = new Set([...give, ...get]);
  const me = evaluateSide(ctx, myRosterId, give, get, involved);
  const them = evaluateSide(ctx, theirRosterId, get, give, involved);
  const flags = buildFlags(ctx, me, them, give, get);

  const edge = me.edgePct;
  const dpw = me.lineup.deltaPerWeek;
  const dpo = me.lineup.deltaPlayoffPerWeek;
  let code = edgeBand(edge);
  let override = null;
  let label = VERDICT_LABELS[code];

  if (me.shortDetail || them.shortDetail) {
    code = "invalid";
    label = `Invalid — leaves ${me.shortDetail ? "you" : "them"} short at ${
      (me.shortDetail || them.shortDetail).slot
    } in week ${(me.shortDetail || them.shortDetail).week}.`;
  } else if (me.rosterCount.after > me.rosterCount.max || them.rosterCount.after > them.rosterCount.max) {
    code = "needs_drop";
    const mineOver = me.rosterCount.after > me.rosterCount.max;
    const dropper = mineOver ? me : them;
    const who = mineOver ? "Requires dropping" : "They must drop";
    label = dropper.dropSuggestion
      ? `${who} ${playerOf(ctx, dropper.dropSuggestion).name}`
      : mineOver
        ? VERDICT_LABELS.needs_drop
        : "They need a drop";
  } else if (edge >= EDGE_BANDS.slightLoss && edge <= EDGE_BANDS.slightWin && dpw >= LINEUP_OVERRIDE_PTS) {
    override = "lineup_win";
    label = VERDICT_LABELS.lineup_win;
  } else if (edge >= EDGE_BANDS.clearWin && dpw <= -LINEUP_OVERRIDE_PTS) {
    override = "paper_win";
    label = VERDICT_LABELS.paper_win;
  }

  const acceptLikely = them.edgePct >= ACCEPT_EDGE || them.lineup.deltaPerWeek >= ACCEPT_DELTA;
  const bestId = pickBest(ctx, give, get);

  const result = {
    give,
    get,
    myRosterId,
    theirRosterId,
    me,
    them,
    verdict: {
      code,
      label,
      edgePct: edge,
      deltaPerWeek: dpw,
      deltaPlayoffPerWeek: dpo,
      override,
      veto: Math.abs(edge) >= VETO_EDGE,
      acceptLikely,
    },
    flags,
    reasons: [],
    best: bestId ? { id: bestId, side: get.includes(bestId) ? "me" : "them" } : { id: null, side: null },
  };

  if (withExplain) finalizeExplanation(ctx, result);
  return result;
}

/**
 * Fill `reasons` and every flag's `text` from the R3 §g templates. evaluateTrade calls this
 * unless the caller opted out for speed; the finder calls it on its final shortlist.
 * @param {object} ctx
 * @param {object} result TradeResult (mutated in place)
 * @returns {object} the same result
 */
export function finalizeExplanation(ctx, result) {
  for (const flag of result.flags) {
    if (!flag.text) flag.text = flagText(ctx, flag);
  }
  const rendered = explain(ctx, result);
  result.reasons = rendered.lines;
  result.headline = rendered.headline;
  return result;
}

/**
 * The best player in the deal, by injury-adjusted market value (ties by id).
 */
function pickBest(ctx, give, get) {
  let best = null;
  let bestM = -Infinity;
  for (const id of [...give, ...get]) {
    const m = marketValue(ctx, id).mAdj;
    if (m == null) continue;
    if (m > bestM || (m === bestM && best != null && id < best)) {
      bestM = m;
      best = id;
    }
  }
  return best;
}

/**
 * A structurally impossible trade — still shaped like a TradeResult so the UI never branches.
 */
function invalidResult(ctx, proposal, problems) {
  const zero = { raw: 0, surplus: 0, best: null };
  const emptyLineup = { total: 0, weighted: 0, perWeek: [], avgPerWeek: 0, playoffAvg: 0, shortWeeks: [] };
  const side = () => ({
    valueGive: { ...zero },
    valueGet: { ...zero },
    edgePct: 0,
    lineup: { before: emptyLineup, after: emptyLineup, deltaPerWeek: 0, deltaPlayoffPerWeek: 0 },
    rosterCount: { before: 0, after: 0, max: ctx.league.maxRoster },
    backfill: [],
    backfillDetail: [],
    dropSuggestion: null,
    shortDetail: null,
    afterIds: [],
  });
  const result = {
    give: proposal.give,
    get: proposal.get,
    myRosterId: proposal.myRosterId,
    theirRosterId: proposal.theirRosterId,
    me: side(),
    them: side(),
    verdict: {
      code: "invalid",
      label: `Invalid — ${problems[0]}`,
      edgePct: 0,
      deltaPerWeek: 0,
      deltaPlayoffPerWeek: 0,
      override: null,
      veto: false,
      acceptLikely: false,
    },
    flags: problems.map((text) => ({ type: "coverage", severity: "block", text })),
    reasons: problems.map((text) => ({ kind: "block", text })),
    best: { id: null, side: null },
    headline: `Invalid — ${problems[0]}`,
  };
  return result;
}
