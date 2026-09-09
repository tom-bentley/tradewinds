// src/engine/finder.js — the six-stage trade finder (R3 §f).
// Cheap O(1) filters shed 95%+ of the enumeration before anything touches a lineup, so the whole
// sweep of an 8-team league stays well inside a phone's patience budget.

import { TRADEABLE } from "../config.js";
import { activePlayers, playerOf, rosterById } from "./context.js";
import { marketValue, surplus } from "./values.js";
import { slotDemand } from "./lineup.js";
import { edgePct, evaluateTrade, finalizeExplanation } from "./trade.js";

/** Hard ceiling on enumerated candidates before the sweep bails out (R3 §f stage 1). */
export const MAX_CANDIDATES = 50000;
/** Shapes are "<players I give>-<players I get>". */
export const DEFAULT_SHAPES = Object.freeze(["1-1", "2-1", "1-2", "2-2"]);

/**
 * Tradeable, non-waiver-grade players on a roster (R3 §f stage 0). A player worth no more than
 * the wire contributes nothing to either side's surplus, so proposing him is noise.
 * @param {object} ctx
 * @param {number} rosterId
 * @returns {string[]} ids, best-first by injury-adjusted market value
 */
export function tradePool(ctx, rosterId) {
  if (!ctx.memo.tradePool) ctx.memo.tradePool = new Map();
  const hit = ctx.memo.tradePool.get(rosterId);
  if (hit) return hit;
  const roster = rosterById(ctx, rosterId);
  const ids = roster
    ? activePlayers(roster).filter((id) => {
        const p = playerOf(ctx, id);
        if (!TRADEABLE.includes(p.pos)) return false;
        return surplus(ctx, id) > 0;
      })
    : [];
  ids.sort((a, b) => (marketValue(ctx, b).mAdj || 0) - (marketValue(ctx, a).mAdj || 0) || (a < b ? -1 : 1));
  ctx.memo.tradePool.set(rosterId, ids);
  return ids;
}

/**
 * Per-position startable surplus for a roster: how many above-replacement bodies it holds beyond
 * the slots it must fill (R3 §f stage 3). Negative = a hole worth trading for.
 * @param {object} ctx
 * @param {number} rosterId
 * @returns {Object<string, number>}
 */
export function positionalSurplus(ctx, rosterId) {
  if (!ctx.memo.positionalSurplus) ctx.memo.positionalSurplus = new Map();
  const hit = ctx.memo.positionalSurplus.get(rosterId);
  if (hit) return hit;
  const demand = slotDemand(ctx);
  const counts = {};
  for (const id of tradePool(ctx, rosterId)) {
    const pos = playerOf(ctx, id).pos;
    counts[pos] = (counts[pos] || 0) + 1;
  }
  const out = {};
  for (const pos of TRADEABLE) out[pos] = (counts[pos] || 0) - (demand[pos] || 0);
  ctx.memo.positionalSurplus.set(rosterId, out);
  return out;
}

/** All unordered subsets of `ids` of exactly `size` (size is 1 or 2 in practice). */
function combinations(ids, size) {
  if (size === 1) return ids.map((id) => [id]);
  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) out.push([ids[i], ids[j]]);
  }
  return out;
}

/** Stable dedup key for a proposal: both sides sorted. */
function proposalKey(theirRosterId, give, get) {
  return `${theirRosterId}|${[...give].sort().join(",")}|${[...get].sort().join(",")}`;
}

/**
 * Sweep every rival for trades worth proposing.
 * @param {object} ctx
 * @param {{myRosterId?:number, shapes?:string[], maxResults?:number, perRival?:number}} [opts]
 * @returns {Array<{theirRosterId:number, give:string[], get:string[], shape:string, score:number,
 *   myEdgePct:number, myDeltaPerWeek:number, theirEdgePct:number, theirDeltaPerWeek:number,
 *   why:string[], result:object}>}
 */
export function findTrades(ctx, opts = {}) {
  const cfg = ctx.settings.finder || {};
  const myRosterId = opts.myRosterId != null ? opts.myRosterId : ctx.myRosterId;
  const shapes = opts.shapes || cfg.shapes || DEFAULT_SHAPES;
  const maxResults = opts.maxResults != null ? opts.maxResults : cfg.maxResults != null ? cfg.maxResults : 10;
  const perRival = opts.perRival != null ? opts.perRival : cfg.perRival != null ? cfg.perRival : 2;
  const maxCandidates = cfg.maxCandidates || MAX_CANDIDATES;
  const minMyEdge = cfg.minMyEdgePct != null ? cfg.minMyEdgePct : -10;
  const rivalTol = cfg.rivalSurplusTolerance != null ? cfg.rivalSurplusTolerance : 0.03;
  const kappa = cfg.valueWeight != null ? cfg.valueWeight : 0.05;
  const likelyBonus = cfg.likelyBonus != null ? cfg.likelyBonus : 0.5;

  const myPool = tradePool(ctx, myRosterId);
  if (!myPool.length) return [];
  const mySurplus = positionalSurplus(ctx, myRosterId);
  // memoize per-player surplus once: the inner loops read it ~10^5 times
  const surplusOf = new Map();
  const posOf = new Map();
  const noteIds = (ids) => {
    for (const id of ids) {
      if (!surplusOf.has(id)) {
        surplusOf.set(id, surplus(ctx, id));
        posOf.set(id, playerOf(ctx, id).pos);
      }
    }
  };
  noteIds(myPool);

  const scored = [];
  const seen = new Set();
  let enumerated = 0;

  outer: for (const rival of ctx.rosters) {
    if (rival.rosterId === myRosterId) continue;
    const theirPool = tradePool(ctx, rival.rosterId);
    if (!theirPool.length) continue;
    noteIds(theirPool);

    for (const shape of shapes) {
      const [nGive, nGet] = String(shape).split("-").map(Number);
      if (!nGive || !nGet) continue;
      const gives = combinations(myPool, nGive);
      const gets = combinations(theirPool, nGet);

      for (const give of gives) {
        let giveS = 0;
        for (const id of give) giveS += surplusOf.get(id);
        for (const get of gets) {
          enumerated += 1;
          if (enumerated > maxCandidates) break outer;

          let getS = 0;
          for (const id of get) getS += surplusOf.get(id);

          // stage 2 — O(1) value filter, both directions. The rival receives what I give and
          // sends what I get, so their surplus gain is giveS − getS measured against getS.
          const myEdge = edgePct(getS, giveS);
          if (myEdge < minMyEdge) continue;
          if (giveS - getS < -rivalTol * getS) continue;

          // stage 3 — O(1) positional fit: fill one of my holes, or sell from a surplus
          let fits = false;
          for (const id of get) {
            if ((mySurplus[posOf.get(id)] || 0) < 0) {
              fits = true;
              break;
            }
          }
          if (!fits) {
            for (const id of give) {
              if ((mySurplus[posOf.get(id)] || 0) > 0) {
                fits = true;
                break;
              }
            }
          }
          if (!fits) continue;

          const key = proposalKey(rival.rosterId, give, get);
          if (seen.has(key)) continue;
          seen.add(key);

          // stage 4 — full two-sided lineup evaluation
          const result = evaluateTrade(
            ctx,
            { myRosterId, theirRosterId: rival.rosterId, give, get },
            { withExplain: false }
          );
          if (result.verdict.code === "invalid") continue;

          // stage 5 — rival acceptance model: keep "likely" and "possible", drop "unlikely"
          if (result.verdict.acceptance === "unlikely") continue;

          // stage 6 — score: lineup first, value second, with a nudge for offers they will
          // actually want rather than merely tolerate
          const score =
            result.verdict.deltaPerWeek +
            kappa * result.verdict.edgePct +
            (result.verdict.acceptance === "likely" ? likelyBonus : 0);
          scored.push({
            theirRosterId: rival.rosterId,
            give: [...give],
            get: [...get],
            shape,
            score,
            myEdgePct: result.verdict.edgePct,
            myDeltaPerWeek: result.verdict.deltaPerWeek,
            theirEdgePct: result.them.edgePct,
            theirDeltaPerWeek: result.them.lineup.deltaPerWeek,
            acceptance: result.verdict.acceptance,
            why: [],
            result,
          });
        }
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || (proposalKey(a.theirRosterId, a.give, a.get) < proposalKey(b.theirRosterId, b.give, b.get) ? -1 : 1));

  const perRivalCount = new Map();
  const usedGivers = new Set();
  const out = [];
  for (const cand of scored) {
    if (out.length >= maxResults) break;
    const rivalCount = perRivalCount.get(cand.theirRosterId) || 0;
    if (rivalCount >= perRival) continue;
    if (cand.give.some((id) => usedGivers.has(id))) continue;
    perRivalCount.set(cand.theirRosterId, rivalCount + 1);
    for (const id of cand.give) usedGivers.add(id);
    finalizeExplanation(ctx, cand.result);
    cand.why = cand.result.reasons.map((r) => r.text);
    out.push(cand);
  }
  return out;
}
