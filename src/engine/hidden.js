// src/engine/hidden.js — why a price is wrong, and who fits whom (004 design §3.6, R10 §4 verbatim).
//
// R10 §3 measured the gap: Tradewinds is strong at PRICING A PROPOSAL and at risk, and had nothing
// on *why a price is wrong* or *who fits whom*. This module is those two.
//
// The whole thing rests on one measurement (R10 §1.5, on this league's own data): once you know a
// player's actual points, the market's 30-day move tells you nothing more about whether his usage
// earned them (partial r = −0.044). The usage gap is therefore orthogonal information the market
// has not priced — the only honest reason to publish a model value at all.
//
// Pure, deterministic, memoized on `ctx.memo`; no clock, no network, no mutation of ctx. Every
// weight below is either cited to R10/R5 or labelled ENGINE-CHOSEN, and the labelling survives into
// the sentences (R5 §4's instruction for `lineupConcentration`).
//
// The failure modes are the contract (R10 §4.8) and each one has a test:
//   • a regression flag is SUPPRESSED under `minWeeks` (3) played weeks;
//   • `rosterPct`, `tradeFreq` and Sleeper trending are NEVER scored (R5 §2.4) — screens only;
//   • synergy NEVER runs on K/DEF (R10 §2.6);
//   • with no `ctx.stats` loaded this degrades to a market-gap-only read and says so in `why`.

import { DEFAULTS, TRADEABLE } from "../config.js";
import { activePlayers, gameFor, playerOf, rosterById, rosteredIds } from "./context.js";
import { marketValue, waiverReplacement } from "./values.js";
import { playerRisk } from "./risk.js";
import { usageOf, usageTotals } from "./usage.js";
import { TREND_FLAG, fmt0, fmt1, nameOf } from "./explain.js";

/** R10 §4.4 τ — half-PPR points per PLAYED week before a usage gap is a direction. ENGINE-CHOSEN. */
export const GAP_TAU_PER_WEEK = 2.0;
/** R10 §4.4 — opportunities (targets + carries) that buy full confidence in a gap. ENGINE-CHOSEN. */
export const CONFIDENCE_OPPORTUNITIES = 20;
/** Fraction of `mAdj` that reads as a FULL market-gap signal. ENGINE-CHOSEN. */
export const MARKET_GAP_FULL = 0.3;
/** Half-PPR points per week of usage gap that read as a FULL usage signal. ENGINE-CHOSEN. */
export const USAGE_GAP_FULL = 5;
/** Points per week of synergy that read as a FULL synergy signal. ENGINE-CHOSEN. */
export const SYNERGY_FULL = 1;
/** |score| below this is a hold, not a verdict. ENGINE-CHOSEN. */
export const VERDICT_TAU = 0.08;
/** R10 §4.3 — the usage z is clipped here, within position. */
export const USAGE_Z_CLIP = 2;
/** R10 §4.5 — an over-reaction is only an over-reaction on a short box score. */
export const OVERREACTION_WEEKS = 4;
/** Fallback centre and unit for the risk z when a position has too few priced players to band.
 *  `DEFAULTS.risk.bands` puts the moderate/high boundary at 50, which is the natural centre. */
export const RISK_Z_CENTRE = 50;
export const RISK_Z_UNIT = 25;
/** R10 §2.1 — a stack part is capped at ±1.0 pts/wk whatever the ceiling/floor shift says. */
export const STACK_CAP = 1.0;
/** R10 §2.3 — bye clash, per clashing starter and in total; a passed bye is a small credit. */
export const BYE_PER_PLAYER = 0.5;
export const BYE_CAP = 1.5;
export const BYE_PASSED = 0.3;
/** R10 §2.4 — schedule complementarity is a TIEBREAK, never a multiplier. */
export const SCHEDULE_CAP = 0.3;
/** R10 §2.5 — credit the position the wire cannot replace. */
export const SCARCITY_CAP = 0.5;
/** How many priced candidates the acquire screen considers, best market value first. Bounds the
 *  work on a full wire; the list itself is `n` long. ENGINE-CHOSEN. */
export const ACQUIRE_POOL = 150;

function cfg(ctx) {
  const patch = (ctx && ctx.settings && ctx.settings.hidden) || null;
  return patch ? { ...DEFAULTS.hidden, ...patch } : DEFAULTS.hidden;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Map a raw signal onto (−1, 1) against the value that reads as "full".
 *
 * `tanh`, not a clip: the model's own swing (α and γ against a z clipped at ±2) can move a value by
 * −70 % to +110 %, so a hard clip would flatten the whole top of the list into a tie at 1.0 and the
 * ranking would stop meaning anything. tanh is strictly monotone, so it never reorders two players,
 * and it is ≈ x/full while the signal is small.
 */
function norm(x, full) {
  if (!Number.isFinite(x) || !(full > 0)) return 0;
  return Math.tanh(x / full);
}

/**
 * Per-position distribution of the usage gap per played week, over everybody `ctx.stats` covers.
 *
 * Within-position is MANDATORY (R10 §4.3): with no efficiency term the xFP model pays every carry
 * the league-average rate, so a position-blind gap is RB-biased by construction (R10 §1.4 caveat 1).
 * @param {object} ctx
 * @returns {Map<string, {n:number, mean:number, sd:number}>}
 */
function usageCohort(ctx) {
  if (ctx.memo.hiddenCohort) return ctx.memo.hiddenCohort;
  const byPos = new Map();
  for (const id of (ctx.stats && ctx.stats.keys()) || []) {
    const totals = usageTotals(ctx, id);
    if (!totals || totals.perWeek == null || totals.playedWeeks <= 0) continue;
    const pos = playerOf(ctx, id).pos;
    if (!pos) continue;
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(totals.perWeek);
  }
  const out = new Map();
  for (const [pos, xs] of byPos) {
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
    out.set(pos, { n, mean, sd: Math.sqrt(variance) });
  }
  ctx.memo.hiddenCohort = out;
  return out;
}

/**
 * Per-position distribution of `playerRisk().score` over every PRICED player at that position.
 *
 * Within-position and mean-centred for the same reason the usage z is (R10 §4.3): the risk term is
 * a *relative* adjustment, and a fixed centre would make `modelValue` systematically bigger (or
 * smaller) than `mAdj` for everybody at once — a market gap that is really just an offset, which is
 * the one thing a mispricing screen must never be.
 * @param {object} ctx
 * @returns {Map<string, {n:number, mean:number, sd:number}>}
 */
function riskCohort(ctx) {
  if (ctx.memo.hiddenRiskCohort) return ctx.memo.hiddenRiskCohort;
  const byPos = new Map();
  for (const [id, p] of ctx.players) {
    if (!p || !TRADEABLE.includes(p.pos)) continue;
    if (marketValue(ctx, id).mAdj == null) continue;
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(playerRisk(ctx, id).score);
  }
  const out = new Map();
  for (const [pos, xs] of byPos) {
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
    out.set(pos, { n, mean, sd: Math.sqrt(variance) });
  }
  ctx.memo.hiddenRiskCohort = out;
  return out;
}

// ---------------------------------------------------------------------------------------------
// synergy (R10 §4.6, §2.1–§2.6)
// ---------------------------------------------------------------------------------------------

/** The fraction of the remaining weeks the caller has flagged as underdog weeks (R9 owns P(win)). */
function underdogShare(ctx, weeks) {
  const left = ctx.weeksLeft || [];
  if (!left.length || !Array.isArray(weeks) || !weeks.length) return 0;
  const flagged = new Set(weeks.map(Number));
  let n = 0;
  for (const w of left) if (flagged.has(w)) n += 1;
  return n / left.length;
}

/** Mean defence-vs-position allowed to `pos` across a team's playoff-week opponents, or null. */
function playoffSos(ctx, team, pos) {
  const weeks = ctx.playoffWeeks || [];
  if (!team || !pos || !weeks.length || !ctx.dvp || !ctx.dvp.size) return null;
  let sum = 0;
  let n = 0;
  for (const week of weeks) {
    const game = gameFor(ctx, team, week);
    if (!game) continue;
    const opp = game.home === team ? game.away : game.home;
    const row = ctx.dvp.get(opp);
    const allowed = row && row.std ? Number(row.std[pos]) : NaN;
    if (!Number.isFinite(allowed)) continue;
    sum += allowed;
    n += 1;
  }
  return n ? sum / n : null;
}

/** League mean/sd of playoff-week points allowed to one position, for the tiebreak's z. */
function dvpBand(ctx, pos) {
  if (!ctx.memo.hiddenDvpBand) ctx.memo.hiddenDvpBand = new Map();
  if (ctx.memo.hiddenDvpBand.has(pos)) return ctx.memo.hiddenDvpBand.get(pos);
  const xs = [];
  for (const row of (ctx.dvp && ctx.dvp.values()) || []) {
    const v = row && row.std ? Number(row.std[pos]) : NaN;
    if (Number.isFinite(v)) xs.push(v);
  }
  let band = null;
  if (xs.length > 1) {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (xs.length - 1));
    if (sd > 0) band = { mean, sd };
  }
  ctx.memo.hiddenDvpBand.set(pos, band);
  return band;
}

/**
 * What this player is worth to THIS roster beyond his price, in projected half-PPR points per
 * remaining week (R10 §4.6). Every part is signed, capped and carries its own sentence.
 *
 * Never runs on K or DEF: a kicker is streamed weekly, so his playoff schedule is worth nothing in
 * September and his correlation with anything is noise (R10 §2.6).
 *
 * @param {object} ctx
 * @param {number} rosterId whose roster the fit is measured against
 * @param {string} id the candidate
 * @param {{underdogWeeks?: number[]}} [opts] weeks this roster is projected to LOSE (R9 supplies
 *   them). A QB–WR stack is a weekly instrument: it buys ceiling and sells floor, so it is only
 *   worth holding in a week you need the ceiling. Default: none, i.e. play the floor.
 * @returns {{score:number, parts:Array<{kind:string, delta:number, reason:string}>}}
 */
export function synergyScore(ctx, rosterId, id, opts = {}) {
  const parts = [];
  const cand = playerOf(ctx, id);
  const pos = cand.pos;
  // R10 §2.6 — never on K/DEF.
  if (!TRADEABLE.includes(pos)) return { score: 0, parts };
  const roster = rosterById(ctx, rosterId);
  if (!roster) return { score: 0, parts };
  const c = cfg(ctx);
  const s = c.synergy;
  const mine = activePlayers(roster).filter((x) => x !== String(id));
  const team = cand.team || null;

  // handcuff — a NAMED backup, not generic absence cover. `rosterFragility` measures the generic
  // kind; the same-team + depth-chart test is what turns it into insurance with a name (R10 §2.2).
  if (pos === "RB" && team && cand.dc != null) {
    let credited = 0;
    for (const mid of mine) {
      const p = playerOf(ctx, mid);
      if (p.pos !== "RB" || !p.team || p.team !== team || p.dc == null) continue;
      if (Number(cand.dc) !== Number(p.dc) + 1) continue;
      const delta = Math.min(s.handcuffPerWeek, s.handcuffCap - credited);
      if (delta <= 0) break;
      credited += delta;
      parts.push({
        kind: "handcuff",
        delta,
        reason:
          `${nameOf(ctx, id)} is ${nameOf(ctx, mid)}'s direct backup in ${team} — R5 §4 prices that ` +
          `insurance at 0.3–0.4 pts/wk, and it is never worth a starter.`,
      });
    }
  }

  // stack — the ONLY same-team pairing with a calibrated number: QB–WR +0.31 over 1 300+ stack
  // seasons. QB–RB (+0.07) and WR–WR (−0.02) are deliberately not credited (R10 §2.1 [S2]).
  if (team && (pos === "QB" || pos === "WR")) {
    const want = pos === "QB" ? "WR" : "QB";
    const mate = mine.find((mid) => {
      const p = playerOf(ctx, mid);
      return p.pos === want && p.team === team;
    });
    if (mate) {
      const u = underdogShare(ctx, opts.underdogWeeks);
      const raw = u * s.stackCeiling - (1 - u) * s.stackFloor;
      const delta = clamp(raw, -STACK_CAP, STACK_CAP);
      parts.push({
        kind: "stack",
        delta,
        reason:
          `A ${team} QB–WR stack with ${nameOf(ctx, mate)} concentrates about ${fmt1(s.stackCeiling)} points onto the ` +
          `pair's ceiling and cuts ${fmt1(s.stackFloor)} off its floor [R10 §2.1]. ` +
          (u > 0
            ? `${Math.round(u * 100)}% of the remaining weeks are flagged underdog, so the ceiling is worth buying.`
            : `No underdog weeks are flagged, and at equal mean the consistent roster wins more (R5 §3.4), so it reads as a cost.`),
      });
    }
  }

  // bye — the cost the correlation literature ignores: a same-team pair is one bye-week hole of
  // double width, guaranteed (R10 §2.3). A bye already behind him is one more usable game [S10].
  const bye = Number(cand.bye);
  if (Number.isFinite(bye) && bye > 0) {
    if (bye < Number(ctx.week)) {
      parts.push({
        kind: "bye",
        delta: BYE_PASSED,
        reason: `His bye (wk ${bye}) has already passed — one more usable game than a comparable player whose has not.`,
      });
    } else {
      const clash = mine.filter((mid) => {
        const p = playerOf(ctx, mid);
        return TRADEABLE.includes(p.pos) && Number(p.bye) === bye;
      }).length;
      if (clash > 0) {
        parts.push({
          kind: "bye",
          delta: -Math.min(BYE_CAP, clash * BYE_PER_PLAYER),
          reason: `Week ${bye} already takes ${clash} of this roster's skill players off the board; he would make it ${clash + 1}.`,
        });
      }
    }
  }

  // schedule — playoff SOS as a TIEBREAK between similarly-priced players, never a multiplier
  // (R10 §2.4, adopting FTA/ETR's framing verbatim). Inert until dvp.json is loaded.
  const sos = playoffSos(ctx, team, pos);
  const band = dvpBand(ctx, pos);
  if (sos != null && band) {
    const z = clamp((sos - band.mean) / band.sd, -2, 2);
    const delta = (z / 2) * SCHEDULE_CAP;
    if (Math.abs(delta) > 1e-9) {
      parts.push({
        kind: "schedule",
        delta,
        reason:
          `His weeks ${(ctx.playoffWeeks || []).join("–")} opponents allow ${fmt1(sos)} to ${pos}s against a league ` +
          `${fmt1(band.mean)} — a tiebreak between similar players, never a reason on its own.`,
      });
    }
  }

  // scarcity — credit the position the wire cannot replace, read LIVE off waiverReplacement. Never
  // hard-coded: R10 §2.5 found the ordering had already flipped since R3 measured it.
  const w = waiverReplacement(ctx);
  if (w.FLEX > 0) {
    const rel = clamp((w.FLEX - (w[pos] || 0)) / w.FLEX, -1, 1);
    const delta = rel * SCARCITY_CAP;
    if (Math.abs(delta) > 1e-9) {
      parts.push({
        kind: "scarcity",
        delta,
        reason:
          `The best free ${pos} on this wire is worth ${fmt0(w[pos] || 0)} against ${fmt0(w.FLEX)} at FLEX — ` +
          (rel > 0 ? `the wire cannot replace him.` : `the wire replaces him cheaply.`),
      });
    }
  }

  parts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.kind < b.kind ? -1 : 1));
  return { score: parts.reduce((a, p) => a + p.delta, 0), parts };
}

// ---------------------------------------------------------------------------------------------
// the per-player row (R10 §4.2–§4.5)
// ---------------------------------------------------------------------------------------------

/**
 * Everything the engine knows about whether one player's price is wrong, on one row.
 *
 * `modelValue = mAdj · (1 + α·usageZ) · (1 + β·matchupZ) · (1 − γ·riskZ)` (R10 §4.3). β ships at
 * **0**: R8 §5.4 established that a Sleeper skill-position projection already embeds the opponent
 * (±6–8 %), so an opponent term here would double count. The term stays in the formula rather than
 * being deleted, so turning it on is a config change and not a rewrite.
 *
 * @param {object} ctx
 * @param {string} id
 * @param {{rosterId?: number, underdogWeeks?: number[]}} [opts] whose roster synergy is measured
 *   against; defaults to `ctx.myRosterId` (null in viewer mode ⇒ no synergy).
 * @returns {{id:string, pos:string|null, modelValue:number|null, marketGap:number,
 *   usage:{xfp:number|null, actual:number|null, gap:number|null, perWeek:number|null,
 *          direction:"positive"|"negative"|"neutral", confidence:number, playedWeeks:number,
 *          opportunities:number, z:number},
 *   trend:{market30:number|null, snapSlope:number|null, targetSlope:number|null, weeks:number,
 *          real:boolean, overreaction:number},
 *   synergy:{score:number, parts:Array<{kind:string, delta:number, reason:string}>},
 *   verdict:"acquire"|"sell"|"hold", confidence:"provisional"|"supported",
 *   acquireScore:number, sellScore:number, why:string[]}}
 */
export function hiddenValue(ctx, id, opts = {}) {
  const c = cfg(ctx);
  const rosterId = opts.rosterId != null ? opts.rosterId : ctx.myRosterId;
  const underdog = Array.isArray(opts.underdogWeeks) ? opts.underdogWeeks.map(Number).sort((a, b) => a - b) : [];
  const key = `${id}|${rosterId == null ? "-" : rosterId}|${underdog.join(",")}`;
  if (!ctx.memo.hiddenValue) ctx.memo.hiddenValue = new Map();
  const hit = ctx.memo.hiddenValue.get(key);
  if (hit) return hit;

  const player = playerOf(ctx, id);
  const pos = player.pos || null;
  const mv = marketValue(ctx, id);
  const usage = usageOf(ctx, id);
  const totals = usageTotals(ctx, id);
  const risk = playerRisk(ctx, id);
  const why = [];

  const playedWeeks = totals ? totals.playedWeeks : 0;
  const opportunities = totals ? totals.opportunities : 0;
  const perWeek = totals ? totals.perWeek : null;
  // R10 §4.4 — both halves ENGINE-CHOSEN: weeks buy confidence, and so does raw volume.
  const numericConfidence =
    Math.min(1, playedWeeks / Math.max(1, c.provisionalWeeks)) *
    Math.min(1, opportunities / CONFIDENCE_OPPORTUNITIES);

  // R10 §4.8 — a regression flag under `minWeeks` played weeks is SUPPRESSED, not shown quietly.
  let direction = "neutral";
  const flagged = perWeek != null && playedWeeks >= c.minWeeks;
  if (flagged) {
    if (perWeek > GAP_TAU_PER_WEEK) direction = "positive";
    else if (perWeek < -GAP_TAU_PER_WEEK) direction = "negative";
  }

  const band = pos ? usageCohort(ctx).get(pos) : null;
  const usageZ =
    perWeek != null && band && band.n >= 2 && band.sd > 0
      ? clamp((perWeek - band.mean) / band.sd, -USAGE_Z_CLIP, USAGE_Z_CLIP)
      : 0;
  const matchupZ = 0; // β = 0 (R8 §5.4): the projection already priced the opponent
  const rBand = pos ? riskCohort(ctx).get(pos) : null;
  const riskZ =
    rBand && rBand.n >= 2 && rBand.sd > 0
      ? clamp((risk.score - rBand.mean) / rBand.sd, -USAGE_Z_CLIP, USAGE_Z_CLIP)
      : clamp((risk.score - RISK_Z_CENTRE) / RISK_Z_UNIT, -USAGE_Z_CLIP, USAGE_Z_CLIP);

  const modelValue =
    mv.mAdj == null ? null : mv.mAdj * (1 + c.alpha * usageZ) * (1 + c.beta * matchupZ) * (1 - c.gamma * riskZ);
  const marketGap = modelValue == null ? 0 : modelValue - mv.mAdj;

  // R10 §4.5 — the flag that pays for the module: the market moved ≥ TREND_FLAG on ≤4 weeks of box
  // score, in the OPPOSITE direction to the usage. +1 = it fell while the usage held (buy the
  // panic), −1 = it rose on points the usage did not earn (sell the spike).
  const market30 = mv.trend;
  let overreaction = 0;
  if (
    market30 != null &&
    Math.abs(market30) >= TREND_FLAG &&
    perWeek != null &&
    playedWeeks > 0 &&
    playedWeeks <= OVERREACTION_WEEKS &&
    Math.sign(market30) === -Math.sign(perWeek)
  ) {
    overreaction = market30 < 0 ? 1 : -1;
  }

  const synergy = rosterId == null ? { score: 0, parts: [] } : synergyScore(ctx, rosterId, id, { underdogWeeks: underdog });

  // R10 §4.7 — w_m · w_u · w_s · w_t, ENGINE-CHOSEN and labelled as such wherever this renders.
  // `w_c · acquisitionCost` and `w_f · rivalFit` from §4.7 are NOT scored: neither has a weight in
  // `DEFAULTS.hidden.weights`, and cost is already the market gap's denominator.
  const base =
    c.weights.m * norm(mv.mAdj ? marketGap / mv.mAdj : 0, MARKET_GAP_FULL) +
    c.weights.u * norm(perWeek == null ? 0 : perWeek, USAGE_GAP_FULL) * numericConfidence +
    c.weights.s * norm(synergy.score, SYNERGY_FULL);
  const acquireScore = base + c.weights.t * Math.max(0, overreaction);
  const sellScore = -base + c.weights.t * Math.max(0, -overreaction);
  const verdict =
    acquireScore >= VERDICT_TAU && acquireScore >= sellScore
      ? "acquire"
      : sellScore >= VERDICT_TAU
        ? "sell"
        : "hold";

  // ---- the sentences, in explain.js's voice: one per driver, numbers inline, qualifier at the end
  if (mv.mAdj == null) {
    why.push(`${nameOf(ctx, id)} carries no market price, so there is nothing to find a gap against.`);
  } else {
    why.push(
      `The market prices him at ${fmt0(mv.mAdj)}; on usage and risk the model says ${fmt0(modelValue)} ` +
        `(${marketGap >= 0 ? "+" : ""}${fmt0(marketGap)}).`
    );
  }
  if (!usage) {
    // R10 §4.8 — degrade to market-gap-only, and SAY SO.
    why.push(
      ctx.stats && ctx.stats.size
        ? `No usage lines are loaded for him, so this is a market-price and risk comparison only.`
        : `No usage data is loaded at all, so this is a market-price and risk comparison only.`
    );
  } else if (totals && totals.gap != null) {
    why.push(
      `His usage is worth about ${fmt1(totals.xfpMatched)} points over ${totals.gapWeeks} scored ` +
        `week${totals.gapWeeks === 1 ? "" : "s"} and he scored ${fmt1(totals.actual)} — a gap of ` +
        `${totals.gap >= 0 ? "+" : ""}${fmt1(totals.gap)} (${fmt1(perWeek)}/wk) on ${opportunities} opportunities.`
    );
    if (direction === "positive") {
      why.push(`He scored under his opportunity, which is the buy side of the regression flag.`);
    } else if (direction === "negative") {
      why.push(`He scored over his opportunity, which is the sell side of the regression flag.`);
    } else if (!flagged && perWeek != null) {
      why.push(
        `Under ${c.minWeeks} played weeks the regression flag is suppressed — two weeks of scoring explain about ` +
          `4–13% of the rest of the season [R10 §1.3].`
      );
    }
  } else if (usage) {
    why.push(`His usage is on file but this season's actual points are not, so the gap is unknown rather than zero.`);
  }
  if (usage && usage.trend.tgt.real && usage.trend.tgt.slope != null) {
    why.push(
      `Target share is ${usage.trend.tgt.slope > 0 ? "climbing" : "falling"} about ` +
        `${fmt1(Math.abs(usage.trend.tgt.slope) * 100)} points a week over ${usage.trend.tgt.weeks} weeks ` +
        `(engine-chosen threshold).`
    );
  } else if (usage && usage.trend.snap.real && usage.trend.snap.slope != null) {
    why.push(
      `Snap share is ${usage.trend.snap.slope > 0 ? "climbing" : "falling"} about ` +
        `${fmt1(Math.abs(usage.trend.snap.slope) * 100)} points a week over ${usage.trend.snap.weeks} weeks ` +
        `(engine-chosen threshold).`
    );
  }
  if (overreaction !== 0) {
    why.push(
      `The market moved ${market30 >= 0 ? "+" : ""}${fmt0(market30)} over 30 days on ${playedWeeks} week` +
        `${playedWeeks === 1 ? "" : "s"} of box score, against his usage — and the 30-day move tracks points, not ` +
        `opportunity [R10 §1.5].`
    );
  }
  for (const part of synergy.parts) why.push(part.reason);
  if (playedWeeks > 0 && playedWeeks < c.provisionalWeeks) {
    why.push(`Provisional — ${playedWeeks} of ${c.provisionalWeeks} weeks.`);
  }

  const out = {
    id: String(id),
    pos,
    modelValue,
    marketGap,
    usage: {
      // the MATCHED window, so `xfp − actual === gap` holds on the row the UI renders
      xfp: totals ? totals.xfpMatched : null,
      actual: totals ? totals.actual : null,
      gap: totals ? totals.gap : null,
      perWeek,
      direction,
      confidence: numericConfidence,
      playedWeeks,
      opportunities,
      z: usageZ,
    },
    trend: {
      market30,
      snapSlope: usage ? usage.trend.snap.slope : null,
      targetSlope: usage ? usage.trend.tgt.slope : null,
      weeks: playedWeeks,
      real: !!(usage && (usage.trend.snap.real || usage.trend.tgt.real)),
      overreaction,
    },
    synergy,
    verdict,
    confidence: playedWeeks >= c.provisionalWeeks ? "supported" : "provisional",
    acquireScore,
    sellScore,
    why,
  };
  ctx.memo.hiddenValue.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// the two lists (R10 §4.7)
// ---------------------------------------------------------------------------------------------

/** One list row: the ranked score, the verdict row it came from, and the sentences. */
function listRow(ctx, id, hidden, score) {
  return { id: String(id), name: nameOf(ctx, id), pos: hidden.pos, score, hidden, why: hidden.why };
}

function rank(rows, n) {
  // primary: the weighted blend. The blend reads the market gap as a FRACTION of the price, so it
  // is scale-free and two identically-mispriced players tie; the size of the opportunity breaks
  // that tie, and the id breaks the rest. Deterministic all the way down.
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(b.hidden.marketGap) - Math.abs(a.hidden.marketGap) ||
      (a.id < b.id ? -1 : 1)
  );
  const take = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : rows.length;
  return rows.slice(0, take);
}

/**
 * Who to go and get: every priced player this roster does NOT hold, ranked by the same weighted
 * blend the verdict uses (R10 §4.7). Free agents and rival-rostered players compete on one list —
 * the wire is the cheapest trade there is, and a screen that hides it lies about the price.
 *
 * Never ranks on `rosterPct`, `tradeFreq` or Sleeper trending adds (R5 §2.4, R10 §4.8): those are
 * screens and sentences, not scores.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {number} [n]
 * @param {{underdogWeeks?: number[]}} [opts]
 * @returns {Array<{id:string, name:string, pos:string|null, score:number, hidden:object, why:string[]}>}
 */
export function acquireList(ctx, rosterId, n = 10, opts = {}) {
  const roster = rosterById(ctx, rosterId);
  const mine = new Set(roster ? [...roster.players, ...roster.reserve, ...roster.taxi] : []);
  const priced = [];
  for (const [id, p] of ctx.players) {
    if (!p || !TRADEABLE.includes(p.pos) || mine.has(id)) continue;
    const m = marketValue(ctx, id).mAdj;
    if (m == null) continue;
    priced.push([id, m]);
  }
  priced.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const rows = [];
  for (const [id] of priced.slice(0, ACQUIRE_POOL)) {
    const hidden = hiddenValue(ctx, id, { rosterId, underdogWeeks: opts.underdogWeeks });
    rows.push(listRow(ctx, id, hidden, hidden.acquireScore));
  }
  return rank(rows, n);
}

/**
 * Who to move on from: this roster's own priced players, ranked by the mirror of the acquire
 * blend. A high score here means the market is paying more than the usage, the risk and the fit
 * say he is worth — not that he is a bad player.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {number} [n]
 * @param {{underdogWeeks?: number[]}} [opts]
 * @returns {Array<{id:string, name:string, pos:string|null, score:number, hidden:object, why:string[]}>}
 */
export function sellList(ctx, rosterId, n = 10, opts = {}) {
  const roster = rosterById(ctx, rosterId);
  if (!roster) return [];
  const rows = [];
  for (const id of activePlayers(roster)) {
    const p = playerOf(ctx, id);
    if (!TRADEABLE.includes(p.pos)) continue;
    if (marketValue(ctx, id).mAdj == null) continue;
    const hidden = hiddenValue(ctx, id, { rosterId, underdogWeeks: opts.underdogWeeks });
    rows.push(listRow(ctx, id, hidden, hidden.sellScore));
  }
  return rank(rows, n);
}

/**
 * Both screens at once, plus the one line that says how much of this to believe.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {{n?: number, underdogWeeks?: number[]}} [opts]
 * @returns {{acquire:object[], sell:object[], basis:"usage"|"market", note:string}}
 */
export function hiddenLists(ctx, rosterId, opts = {}) {
  const n = opts.n != null ? opts.n : 10;
  const loaded = !!(ctx.stats && ctx.stats.size);
  const weeks = (ctx.statWeeks || []).filter((w) => !(ctx.statsPartial || new Set()).has(w)).length;
  const c = cfg(ctx);
  return {
    acquire: acquireList(ctx, rosterId, n, opts),
    sell: sellList(ctx, rosterId, n, opts),
    basis: loaded ? "usage" : "market",
    note: loaded
      ? `Ranked on market gap, usage gap, roster fit and market over-reaction (weights 0.35 / 0.35 / 0.20 / 0.10 — ` +
        `engine-chosen), over ${weeks} complete week${weeks === 1 ? "" : "s"} of usage. ` +
        (weeks < c.provisionalWeeks ? `Provisional — ${weeks} of ${c.provisionalWeeks} weeks.` : "")
      : `No usage data is loaded, so this is a market-price and risk comparison only.`,
  };
}

/** Everybody this roster could go and get — exported for screens that want the pool, not the rank. */
export function unrosteredPriced(ctx) {
  const taken = rosteredIds(ctx);
  const out = [];
  for (const [id, p] of ctx.players) {
    if (!p || !TRADEABLE.includes(p.pos) || taken.has(id)) continue;
    if (marketValue(ctx, id).mAdj == null) continue;
    out.push(id);
  }
  return out;
}
