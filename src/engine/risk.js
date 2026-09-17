// src/engine/risk.js — the risk axis (design-v14 §13.5 D4).
//
// Tom's complaint, verbatim: "We need to analyze not just projections, points, and face value
// statistics. We need to look into risk!" — and "a consistently healthy starting line up with
// 90% of the roster's value will likely outperform a roster with more value that is spread out
// and not generating points on the bench."
//
// So this module answers three questions the projection axis cannot:
//   1. playerRisk        — how likely is THIS player to not be there, and how wildly does he swing?
//   2. lineupConcentration — how much of a roster's value actually starts?
//   3. rosterFragility / rosterRisk — what does one absence cost, and what is the lineup worth
//      once you charge for its variance (certainty equivalent = mean − λ·sd)?
//
// Pure like the rest of the engine: no DOM, no fetch, no clock. Everything is memoized on
// `ctx.memo` keyed by the roster it was asked about, because the free-agent finder asks for the
// same roster tens of times per run.
//
// ---------------------------------------------------------------------------------------------
// INPUTS (every one of them, and what happens when it is missing)
// ---------------------------------------------------------------------------------------------
//   ctx.players.get(id).pos / team / bye   position, team, bye week        → missing: no risk row
//   ctx.players.get(id).inj/injPart/injNotes  live status (players.json v2.1) → null: healthy
//   ctx.players.get(id).age                years old                       → null: no age penalty
//   ctx.players.get(id).exp                seasons played                  → null: not a rookie
//   ctx.players.get(id).dc                 depth-chart order, 1 = starter  → null: depthPenalty.unknown
//   ctx.proj (via lineup.weekVector)       weekly points, bye/absence-scaled → absent: zeros
//   ctx.weeksLeft, ctx.week, ctx.slots     season shape                     → from buildContext
//   ctx.league.ppr                         0 / 0.5 / 1 — picks the history scoring (§13.6 F1)
//   ctx.history: Map<id, HistoryRow>       WS-C plumbs it, WS-F generates it (§13.4 C1 / §13.6)
//                                          → ABSENT (the common case today): positional priors
//     HistoryRow is accepted in EITHER shape: the flat last-completed-season row
//     `{ gp, ga, w: [[std, rec] | null × weeks] }`, or the wrapper
//     `{ seasons: { "2025": {…}, "2026": {…} } }` — `historyOf` normalizes both and prefers the
//     newest season that is not `ctx.season`. `ga` is null for team defences (no gms_active),
//     `w[i] = null` means "not active that week" and `[0, 0]` means "played and scored nothing".
//   values.js marketValue(id).mAdj/sd/m/tier/trend   market value, price dispersion
//   injuries.js absenceOf/availability     the duration table               → null inj: available
//
// ---------------------------------------------------------------------------------------------
// DEFAULTS (src/config.js `DEFAULTS.risk`, merged key by key so a partial patch cannot drop one).
// Calibrated from WS-E's research/R5-analyzer-strategies.md — section numbers are the citations.
// ---------------------------------------------------------------------------------------------
//   positionCv   { QB .38, RB .58, WR .62, TE .66, K .50, DEF .85 }      R5 §5.1 (K/DEF derived)
//   cvPriorGames 6 — cv = (n·cv_obs + 6·cv_prior)/(n+6), PLAYED weeks only   R5 §5.1
//   baseMissRate { QB .118, RB .176, WR .130, TE .130, K .02, DEF 0 }    R5 §5.3
//   historyShrinkGames 17 — one season of games-missed is worth ~half    R5 §5.4
//   injuryTypeMultiplier { softTissue 1.30, jointHigh 1.15 }             R5 §5.4
//   ageKnee { QB 32, RB 27, WR 29, TE 30 } / ageCliff { 36, 30, 32, 34 } R5 §5.2
//   ageSlope .03 · ageCvWiden .15 · rookieMissRate .02    direction R5 §5.2, magnitude engine-chosen
//   zFloor .84 — floor/ceiling are p20/p80 under a normal approximation  R5 §3.5
//   bands { low 25, moderate 50, high 75 }                               R5 §5.6
//   depthPenalty / weights / rosterWeights / fragilityScale / cvScale    engine-chosen mixes
//
// λ (lambda 0.25, `certaintyEquivalent = mean − λ·sd`) — R5 §5.6, range 0.15–0.35. Derivation:
// equal-mean consistent rosters beat boom/bust by ≈2.5 pp of matchup win rate; with team SD ≈20
// and margin SD ≈28 that is ≈1.75 pts/wk, and over an ASSUMED 7-point SD gap between the two
// buckets λ = 1.75/7 = 0.25. The 7-point SD gap is the uncertain input — it is an assumption, not
// a measurement, and it is the first number to revisit if the risk axis reads too hot or too cold.
//
// NOT modelled on purpose: `lambdaUnderdogFlip` (R5 §5.6). The right behaviour is λ_eff =
// λ·tanh(projectedMargin/28) — chase ceiling when projected to lose, floor when projected to win —
// but the free-agent path has no opponent projection to read, so v1 ships the constant.

import { POSITIONS, DEFAULTS } from "../config.js";
import { playerOf, rosterById, activePlayers, slotEligibility } from "./context.js";
import { bestLineup, seasonLineup, settingsBlock, streamerFor, weekPoints, weekVector } from "./lineup.js";
import { absenceOf, availability } from "./injuries.js";
import { marketValue } from "./values.js";

/** A cache key for one roster: order must not matter, identity must. */
function rosterKey(ids) {
  return [...ids].sort().join("|");
}

/** Per-ctx, per-key memo for one of this module's roster-level answers. */
function memoized(ctx, bucket, key, build) {
  if (!ctx.memo) ctx.memo = {};
  if (!ctx.memo[bucket]) ctx.memo[bucket] = new Map();
  const hit = ctx.memo[bucket].get(key);
  if (hit !== undefined) return hit;
  const out = build();
  ctx.memo[bucket].set(key, out);
  return out;
}

/** The risk settings block, merged over DEFAULTS.risk key by key. */
function cfg(ctx) {
  return settingsBlock(ctx, "risk");
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function finite(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * One player's history row, whatever shape the pipeline lands it in.
 *
 * §13.6 F1 writes `history.seasons[year].players[id] = { gp, ga, w: [[std, rec]|null, …] }`, and
 * §13.4 C1 hands the engine a `Map<id, row>`. Whether that row is one season or the per-season
 * wrapper is WS-C's call, so BOTH are accepted here and the most recent COMPLETE season wins
 * (this season's six games say much less about durability than last season's seventeen).
 * @param {object} ctx
 * @param {string} id
 * @returns {{gp:number|null, ga:number|null, w:Array<Array<number>|null>, season:string|null}|null}
 */
export function historyOf(ctx, id) {
  const raw = ctx.history && typeof ctx.history.get === "function" ? ctx.history.get(id) : null;
  if (!raw || typeof raw !== "object") return null;
  // `ga` is legitimately null for team-defence rows (Sleeper publishes no gms_active for them),
  // and Number(null) is 0, so the null check has to come first or every DEF reads "0 games".
  const count = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const asRow = (row, season) =>
    row && typeof row === "object"
      ? {
          gp: count(row.gp),
          ga: count(row.ga),
          w: Array.isArray(row.w) ? row.w : [],
          season: season == null ? null : String(season),
        }
      : null;
  if (Array.isArray(raw.w) || raw.gp !== undefined) return asRow(raw, raw.season);
  const seasons = raw.seasons && typeof raw.seasons === "object" ? raw.seasons : raw;
  const years = Object.keys(seasons)
    .filter((k) => /^\d{4}$/.test(k))
    .sort();
  if (!years.length) return null;
  // prefer the newest season that is actually finished; fall back to the newest we have
  const current = String(ctx.season || "");
  const past = years.filter((y) => y !== current);
  const pick = past.length ? past[past.length - 1] : years[years.length - 1];
  return asRow(seasons[pick], pick);
}

/**
 * Weekly fantasy points from a history row, in THIS league's scoring (§13.6 F1: half-PPR =
 * std + 0.5·rec, PPR = std + rec; other reception bonuses are not modelled).
 * @param {object} ctx
 * @param {{w:Array<Array<number>|null>}} row
 * @returns {number[]} one entry per game he actually played
 */
export function historyWeekly(ctx, row) {
  const ppr = finite(ctx.league && ctx.league.ppr, 0);
  const out = [];
  for (const week of (row && row.w) || []) {
    if (!Array.isArray(week)) continue;
    const std = finite(week[0]);
    const rec = finite(week[1]);
    out.push(std + ppr * rec);
  }
  return out;
}

/** mean and (sample) standard deviation of a list. */
function moments(xs) {
  if (!xs.length) return { mean: 0, sd: 0 };
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  if (xs.length < 2) return { mean, sd: 0 };
  let acc = 0;
  for (const x of xs) acc += (x - mean) * (x - mean);
  return { mean, sd: Math.sqrt(acc / (xs.length - 1)) };
}

/**
 * How far past his positional age knee a player is, on a 0-at-the-knee, 1-at-the-cliff scale
 * (R5 §5.2). Used twice: it raises the miss rate AND widens the outcome band. It never shaves
 * the projected mean — Sleeper's projections already price age, and doing it here would
 * double-count.
 */
function ageProgress(ctx, p) {
  const c = cfg(ctx);
  const pos = p.pos || "WR";
  const knee = finite((c.ageKnee || {})[pos], 99);
  const cliff = finite((c.ageCliff || {})[pos], knee + 4);
  const age = Number(p.age);
  if (!Number.isFinite(age) || age <= knee) return 0;
  return (age - knee) / Math.max(1, cliff - knee);
}

/** The injury-TYPE multiplier on a live status (R5 §5.4): the type is the real predictor. */
function injuryTypeMultiplier(ctx, p) {
  if (p.inj == null || p.inj === "") return { value: 1, label: null };
  const c = cfg(ctx);
  const text = `${p.injPart || ""} ${p.injNotes || ""}`.toLowerCase();
  const mult = c.injuryTypeMultiplier || DEFAULTS.risk.injuryTypeMultiplier;
  const soft = c.softTissueTokens || DEFAULTS.risk.softTissueTokens;
  const joint = c.jointHighTokens || DEFAULTS.risk.jointHighTokens;
  if (soft.some((t) => text.includes(t))) return { value: finite(mult.softTissue, 1.3), label: "soft tissue" };
  if (joint.some((t) => text.includes(t))) return { value: finite(mult.jointHigh, 1.15), label: "high ankle / shoulder" };
  return { value: 1, label: null };
}

/**
 * P(this player misses any given remaining game) for STRUCTURAL reasons — not the injury he is
 * carrying right now, which `availability` already prices from the duration table.
 *
 * R5 §5.4, verbatim: individual games-missed history is a weak predictor (team AGL year over
 * year r = 0.33, no individual games-missed/ΔPPG association), so one season of history is
 * shrunk ~50/50 toward the positional base rate with k = 17. The type of the most recent injury
 * is what actually carries signal — hamstring reinjury runs 33% — so it multiplies.
 *
 *   pMiss = (gamesMissed + k·base[pos]) / (gamesPossible + k)  ×  typeMultiplier  + age + rookie
 * @param {object} ctx
 * @param {string} id
 * @returns {{value:number, missRate:number, source:"history"|"prior", reason:string}}
 */
export function durabilityOf(ctx, id) {
  const c = cfg(ctx);
  const p = playerOf(ctx, id);
  const pos = p.pos || "WR";
  const base = finite((c.baseMissRate || {})[pos], finite(DEFAULTS.risk.baseMissRate[pos], 0.13));

  const row = historyOf(ctx, id);
  const ga = row && Number.isFinite(row.ga) ? row.ga : null;
  const gp = row && Number.isFinite(row.gp) ? row.gp : null;
  let miss = base;
  let source = "prior";
  let reason = `${pos} base miss rate ${(base * 100).toFixed(1)}%`;
  if (ga != null && gp != null && ga > 0) {
    const k = finite(c.historyShrinkGames, 17);
    miss = (Math.max(0, ga - gp) + k * base) / (ga + k);
    source = "history";
    reason = `played ${gp} of ${ga} games in ${row.season || "the last full season"}, shrunk to the ${pos} base rate`;
  }

  const type = injuryTypeMultiplier(ctx, p);
  if (type.value !== 1) {
    miss *= type.value;
    reason += `; ×${type.value} for a ${type.label} injury`;
  }
  const t = ageProgress(ctx, p);
  if (t > 0) {
    // "penalty starts at the knee, doubles at the cliff" (R5 §5.2)
    miss += finite(c.ageSlope, 0.03) * t * (1 + t);
    reason += `; age ${p.age} is past the ${pos} knee`;
  }
  const exp = Number(p.exp);
  if (Number.isFinite(exp) && exp <= 0) {
    miss += finite(c.rookieMissRate, 0.02);
    reason += "; rookie, no NFL durability record";
  }
  const capped = clamp(miss, 0, 0.6);
  return { value: 1 - capped, missRate: capped, source, reason };
}

/** Depth-chart risk from players.json `dc` (1 = starter). Unknown is not "safe". */
function depthRiskOf(ctx, id) {
  const table = cfg(ctx).depthPenalty || DEFAULTS.risk.depthPenalty;
  const dc = Number(playerOf(ctx, id).dc);
  if (!Number.isFinite(dc)) return finite(table.unknown, 0.25);
  if (dc <= 1) return finite(table.starter, 0);
  if (dc === 2) return finite(table.backup, 0.5);
  return finite(table.deep, 0.8);
}

/** Which band a 0..100 score falls in. */
function bandOf(ctx, score) {
  const b = cfg(ctx).bands || DEFAULTS.risk.bands;
  if (score < finite(b.low, 20)) return "low";
  if (score < finite(b.moderate, 40)) return "moderate";
  if (score < finite(b.high, 65)) return "high";
  return "severe";
}

/** Weighted mean over the components that are actually knowable, renormalized. */
function blend(weights, parts) {
  let num = 0;
  let den = 0;
  for (const [key, value] of Object.entries(parts)) {
    if (value == null || !Number.isFinite(value)) continue;
    const w = finite(weights[key], 0);
    if (w <= 0) continue;
    num += w * clamp(value, 0, 1);
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Everything the engine knows about one player's downside, on one row.
 *
 * `score` is 0 (bankable) to 100 (do not rely on him). It is the weighted blend above, floored by
 * the chance he simply is not there: nothing can be low-risk when he is unavailable, so an ACL in
 * week 2 reads 100 / "severe" however durable his history says he is.
 * @param {object} ctx
 * @param {string} id
 * @returns {{id:string, pos:string|null, availabilityNow:number, rosAvailability:number,
 *   inj:string|null, absence:object|null, durability:number, volatility:number, mean:number,
 *   floor:number, ceiling:number, depthRisk:number, valueVolatility:number|null,
 *   trend:number|null, score:number, band:string, reasons:string[]}}
 */
export function playerRisk(ctx, id) {
  return memoized(ctx, "playerRisk", String(id), () => {
    const c = cfg(ctx);
    const p = playerOf(ctx, id);
    const pos = p.pos || null;
    const weeks = ctx.weeksLeft || [];
    const inj = p.inj == null || p.inj === "" ? null : String(p.inj);
    const absence = inj ? absenceOf(ctx, p) : null;

    const availabilityNow = absence ? availability(ctx, id, ctx.week, absence) : 1;
    let availSum = 0;
    for (const w of weeks) availSum += absence ? availability(ctx, id, w, absence) : 1;
    const rosAvailability = weeks.length ? availSum / weeks.length : 1;

    const dur = durabilityOf(ctx, id);

    // Weekly volatility, R5 §5.1: shrink the measured CV toward the positional prior with
    // `cv = (n·cv_obs + 6·cv_prior)/(n + 6)`, and measure on PLAYED weeks only (a null week in
    // history.json means he was not active — counting it as a zero would charge the availability
    // axis twice). With no history at all the formula collapses to the prior exactly.
    const row = historyOf(ctx, id);
    const weekly = row ? historyWeekly(ctx, row) : [];
    const priorCv = finite((c.positionCv || {})[pos], finite(DEFAULTS.risk.positionCv[pos], 0.6));
    const priorGames = finite(c.cvPriorGames, 6);
    let volatility = priorCv;
    let cvSource = "prior";
    if (weekly.length) {
      const { mean: hMean, sd: hSd } = moments(weekly);
      if (hMean > 0) {
        const observed = clamp(hSd / hMean, 0.05, 2);
        volatility = (weekly.length * observed + priorGames * priorCv) / (weekly.length + priorGames);
        if (weekly.length >= finite(c.minHistoryGames, 6)) cvSource = "history";
      }
    }
    // Age widens the band as well as the miss rate (R5 §5.2, mortality-table framing).
    volatility *= 1 + finite(c.ageCvWiden, 0.15) * ageProgress(ctx, p);

    // mean weekly projection over the weeks that are left (bye- and absence-scaled, §13.5 D1)
    const vec = weekVector(ctx, id);
    let ptsSum = 0;
    for (const w of weeks) ptsSum += vec[w] || 0;
    const mean = weeks.length ? ptsSum / weeks.length : 0;
    const z = finite(c.zFloor, 0.84);
    const floor = Math.max(0, mean * (1 - z * volatility));
    const ceiling = mean * (1 + z * volatility);

    const depthRisk = depthRiskOf(ctx, id);
    const mv = marketValue(ctx, id);
    const valueVolatility =
      mv && mv.sd != null && mv.m ? clamp(Number(mv.sd) / Number(mv.m), 0, 1) : null;

    const weights = c.weights || DEFAULTS.risk.weights;
    const blended = blend(weights, {
      availability: 1 - rosAvailability,
      durability: 1 - dur.value,
      volatility: Math.min(1, volatility),
      depth: depthRisk,
      value: valueVolatility,
    });
    const score = clamp(Math.max(blended, 1 - rosAvailability) * 100, 0, 100);

    const reasons = [];
    if (inj) {
      reasons.push(
        rosAvailability < 0.05
          ? `${inj} — not expected back this season`
          : `${inj} — available for about ${Math.round(rosAvailability * 100)}% of the remaining weeks`
      );
    }
    reasons.push(
      dur.source === "history"
        ? `durability ${(dur.value * 100).toFixed(0)}% — ${dur.reason}`
        : `durability ${(dur.value * 100).toFixed(0)}% from the positional prior (${dur.reason})`
    );
    reasons.push(
      cvSource === "history"
        ? `weekly swing ±${(volatility * 100).toFixed(0)}% — ${weekly.length} played games, shrunk toward the ${pos} prior`
        : `weekly swing ±${(volatility * 100).toFixed(0)}% — ${pos || "positional"} prior (R5 §5.1), little or no history loaded`
    );
    if (depthRisk >= 0.5) reasons.push(`depth chart ${playerOf(ctx, id).dc ?? "unknown"} — one snap from irrelevant`);
    if (valueVolatility != null && valueVolatility > 0.25) {
      reasons.push(`the market disagrees with itself about him (±${(valueVolatility * 100).toFixed(0)}%)`);
    }

    return {
      id: String(id),
      pos,
      availabilityNow,
      rosAvailability,
      inj,
      absence,
      durability: dur.value,
      volatility,
      mean,
      floor,
      ceiling,
      depthRisk,
      valueVolatility,
      trend: mv ? mv.trend : null,
      score,
      band: bandOf(ctx, score),
      reasons,
    };
  });
}

/**
 * Per-player share of the remaining weeks spent in the optimal starting lineup. The engine sweep
 * every other answer in this module is built on, memoized per roster.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {{weeks:number[], lineups:object[], share:Map<string, number>}}
 */
function startShare(ctx, ids) {
  return memoized(ctx, "startShare", rosterKey(ids), () => {
    const weeks = ctx.weeksLeft || [];
    const lineups = weeks.map((w) => bestLineup(ctx, ids, w));
    const counts = new Map();
    for (const lu of lineups) {
      for (const slot of lu.slots) {
        if (!slot.id) continue;
        counts.set(slot.id, (counts.get(slot.id) || 0) + 1);
      }
    }
    const share = new Map();
    for (const id of ids) share.set(id, weeks.length ? (counts.get(id) || 0) / weeks.length : 0);
    return { weeks, lineups, share };
  });
}

/**
 * How much of a roster's market value actually starts (§13.5 D4, Tom's ask #6).
 *
 * A player's weight is the fraction of the remaining weeks he is in the optimal lineup, so a bye
 * or an injury moves value onto the bench rather than off the roster. `starterValue + benchValue`
 * is therefore exactly Σ mAdj — the split is a partition of the same money.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {{starterValue:number, benchValue:number, totalValue:number, starterShare:number,
 *   starters:Array<{id:string, weeks:number, value:number}>,
 *   bench:Array<{id:string, weeks:number, value:number}>}}
 */
export function lineupConcentration(ctx, ids) {
  return memoized(ctx, "lineupConcentration", rosterKey(ids), () => {
    const { share } = startShare(ctx, ids);
    let starterValue = 0;
    let benchValue = 0;
    const rows = [];
    for (const id of ids) {
      const weeks = share.get(id) || 0;
      const value = finite(marketValue(ctx, id).mAdj, 0);
      starterValue += value * weeks;
      benchValue += value * (1 - weeks);
      rows.push({ id, weeks, value });
    }
    const totalValue = starterValue + benchValue;
    const byValue = (a, b) => b.value - a.value || (a.id < b.id ? -1 : 1);
    return {
      starterValue,
      benchValue,
      totalValue,
      starterShare: totalValue > 0 ? starterValue / totalValue : 0,
      // "a starter" is a player in the lineup at least half the remaining weeks (R4 §4 CORE_FRAC)
      starters: rows.filter((r) => r.weeks >= 0.5).sort(byValue),
      bench: rows.filter((r) => r.weeks < 0.5).sort(byValue),
    };
  });
}

/**
 * The best body this roster could put in one slot in one week if the named starter were out —
 * the best eligible bench player, and failing that the wire (§13.5 D2's streamer).
 */
function coverFor(ctx, ids, lu, slot, week, missing) {
  let best = null;
  const eligible = slotEligibility(slot);
  for (const id of lu.bench) {
    if (id === missing) continue;
    if (!eligible.includes(playerOf(ctx, id).pos)) continue;
    const pts = weekPoints(ctx, id, week);
    if (!best || pts > best.pts) best = { id, pts };
  }
  const stream = streamerFor(ctx, slot, week, new Set(ids));
  if (stream && (!best || stream.pts > best.pts)) return { id: stream.id, pts: stream.pts, stream: true };
  return best || { id: null, pts: 0, stream: false };
}

/**
 * What one absence costs this roster, per week, in expectation (§13.5 D4).
 *
 * For every starter in every remaining week: how likely he is to miss it (his durability, not
 * the injury he is already carrying — that is already priced into his projection by D1), times
 * what the roster loses when he does. A deep roster with a real backup at every slot has a small
 * expected loss even when its starters are fragile; a top-heavy roster does not.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {{expectedLossPerWeek:number, coverQuality:number,
 *   worst:Array<{id:string, pMiss:number, lossPerWeek:number, cover:string|null, streamed:boolean}>}}
 */
export function rosterFragility(ctx, ids) {
  return memoized(ctx, "rosterFragility", rosterKey(ids), () => {
    const { weeks, lineups } = startShare(ctx, ids);
    const acc = new Map();
    let starterPtsTotal = 0;
    let coverPtsTotal = 0;
    for (let i = 0; i < weeks.length; i += 1) {
      const week = weeks[i];
      const lu = lineups[i];
      for (const slot of lu.slots) {
        if (!slot.id) continue;
        const starterPts = weekPoints(ctx, slot.id, week);
        if (starterPts <= 0) continue; // already absent this week: D1 priced it, do not charge twice
        const cover = coverFor(ctx, ids, lu, slot.slot, week, slot.id);
        const loss = Math.max(0, starterPts - cover.pts);
        starterPtsTotal += starterPts;
        coverPtsTotal += Math.min(cover.pts, starterPts);
        const pMiss = clamp(1 - playerRisk(ctx, slot.id).durability, 0, 1);
        const row = acc.get(slot.id) || { loss: 0, pMiss, covers: new Map(), streamed: 0 };
        row.loss += pMiss * loss;
        if (cover.id) row.covers.set(cover.id, (row.covers.get(cover.id) || 0) + 1);
        if (cover.stream) row.streamed += 1;
        acc.set(slot.id, row);
      }
    }
    const n = Math.max(1, weeks.length);
    const worst = [...acc.entries()]
      .map(([id, row]) => {
        let cover = null;
        let best = 0;
        for (const [coverId, count] of row.covers) if (count > best) [cover, best] = [coverId, count];
        return {
          id,
          pMiss: row.pMiss,
          lossPerWeek: row.loss / n,
          cover,
          streamed: row.streamed > row.covers.size / 2,
        };
      })
      .sort((a, b) => b.lossPerWeek - a.lossPerWeek || (a.id < b.id ? -1 : 1));
    let expectedLossPerWeek = 0;
    for (const row of worst) expectedLossPerWeek += row.lossPerWeek;
    return {
      expectedLossPerWeek,
      coverQuality: starterPtsTotal > 0 ? clamp(coverPtsTotal / starterPtsTotal, 0, 1) : 0,
      worst: worst.slice(0, finite(cfg(ctx).worst, 5)),
    };
  });
}

/**
 * The whole roster on one risk row: how concentrated it is, how fragile it is, how much its
 * weekly total swings, and what it is worth to a manager who would rather not lose (§13.5 D4).
 *
 * `certaintyEquivalent = weekly.mean − λ·weekly.sd` is the number to compare rosters on: two
 * lineups that project the same are not worth the same if one of them is a coin flip.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {{concentration:object, fragility:object,
 *   weekly:{mean:number, sd:number, cv:number}, certaintyEquivalent:number, score:number,
 *   band:string, notes:string[]}}
 */
export function rosterRisk(ctx, ids) {
  return memoized(ctx, "rosterRisk", rosterKey(ids), () => {
    const c = cfg(ctx);
    const concentration = lineupConcentration(ctx, ids);
    const fragility = rosterFragility(ctx, ids);
    const { weeks, lineups } = startShare(ctx, ids);
    const season = seasonLineup(ctx, ids);

    // weekly sd under independence: √Σ (cv_i · pts_i)² over the starters, averaged over weeks.
    // Starters correlate a little (same game script, stacked QB/WR) — assume independence and say
    // so, rather than invent a correlation matrix nobody can calibrate.
    let sdSum = 0;
    for (let i = 0; i < weeks.length; i += 1) {
      let variance = 0;
      for (const slot of lineups[i].slots) {
        if (!slot.id) continue;
        const pts = weekPoints(ctx, slot.id, weeks[i]);
        if (pts <= 0) continue;
        const cv = playerRisk(ctx, slot.id).volatility;
        variance += (cv * pts) * (cv * pts);
      }
      sdSum += Math.sqrt(variance);
    }
    const sd = weeks.length ? sdSum / weeks.length : 0;
    const mean = season.avgPerWeek;
    const cv = mean > 0 ? sd / mean : 0;
    const lambda = finite(c.lambda, 0.25);

    const weights = c.rosterWeights || DEFAULTS.risk.rosterWeights;
    const score = clamp(
      blend(weights, {
        fragility: Math.min(1, fragility.expectedLossPerWeek / Math.max(1e-9, finite(c.fragilityScale, 8))),
        volatility: Math.min(1, cv / Math.max(1e-9, finite(c.cvScale, 0.3))),
        cover: 1 - fragility.coverQuality,
      }) * 100,
      0,
      100
    );

    const notes = [];
    notes.push(
      `${(concentration.starterShare * 100).toFixed(0)}% of this roster's value starts; ` +
        `${Math.round(concentration.benchValue)} sits on the bench`
    );
    notes.push(
      `one absence costs about ${fragility.expectedLossPerWeek.toFixed(1)} pts/wk in expectation ` +
        `(bench and wire cover ${(fragility.coverQuality * 100).toFixed(0)}% of a starter's points)`
    );
    notes.push(
      `weekly total ${mean.toFixed(1)} ± ${sd.toFixed(1)} — worth ${(mean - lambda * sd).toFixed(1)} ` +
        `to a manager who prices variance (λ ${lambda})`
    );
    if (fragility.worst.length) {
      const top = fragility.worst[0];
      notes.push(
        `most exposed: ${playerOf(ctx, top.id).name || top.id} (${top.lossPerWeek.toFixed(1)} pts/wk at risk` +
          `${top.cover ? `, covered by ${playerOf(ctx, top.cover).name || top.cover}` : ", uncovered"})`
      );
    }

    return {
      concentration,
      fragility,
      weekly: { mean, sd, cv },
      certaintyEquivalent: mean - lambda * sd,
      score,
      band: bandOf(ctx, score),
      notes,
    };
  });
}

/**
 * The risk half of a trade verdict (§13.5 D4; the orchestrator wires this into trade.js at
 * integration, §13.8): both sides' rosters before and after, and the three numbers that say
 * whether the deal made the team safer or just bigger.
 *
 * Reads only what `evaluateTrade` already returns — `result.me.afterIds` / `result.them.afterIds`
 * are the post-trade, post-backfill rosters, so the deltas include the wire the trade forces you
 * to sign.
 * @param {object} ctx
 * @param {object} result an evaluateTrade result
 * @returns {{me:{before:object, after:object}, them:{before:object, after:object},
 *   deltaCertaintyEquivalent:number, deltaStarterShare:number, deltaFragility:number}|null}
 */
export function tradeRisk(ctx, result) {
  if (!result || !result.me || !result.them) return null;
  const sideOf = (rosterId, side) => {
    const roster = rosterById(ctx, rosterId);
    // trade.js evaluates lineups over roster spots + IR (never taxi) on BOTH sides and reports
    // that pool as `beforeIds`; use it so before/after are measured on the same bodies. Older
    // results without it fall back to the roster-spot occupants.
    const beforeIds =
      Array.isArray(side && side.beforeIds) && side.beforeIds.length
        ? side.beforeIds
        : roster
          ? activePlayers(roster)
          : [];
    const afterIds = side && side.afterIds;
    const after = Array.isArray(afterIds) && afterIds.length ? afterIds : beforeIds;
    return { before: rosterRisk(ctx, beforeIds), after: rosterRisk(ctx, after) };
  };
  const me = sideOf(result.myRosterId, result.me);
  const them = sideOf(result.theirRosterId, result.them);
  return {
    me,
    them,
    // every delta is from MY side of the table, like every other number on a TradeResult
    deltaCertaintyEquivalent: me.after.certaintyEquivalent - me.before.certaintyEquivalent,
    deltaStarterShare: me.after.concentration.starterShare - me.before.concentration.starterShare,
    deltaFragility: me.after.fragility.expectedLossPerWeek - me.before.fragility.expectedLossPerWeek,
  };
}

/**
 * Positional projection rank → the Boris Chen tier a consensus reader would expect, and the gap
 * to the tier he actually has (§13.5 D3 `consensusGap`).
 *
 * Built once per context: for each position the players who HAVE a tier are ranked by remaining
 * projected points, so "the tier implied by his projection rank" is simply the tier of the player
 * sitting at that rank. A gap of two or more tiers means our projections and the crowd are
 * reading different players — worth saying out loud, in either direction.
 * @param {object} ctx
 * @returns {Map<string, {tier:number, implied:number, gap:number}>}
 */
export function consensusGaps(ctx) {
  if (ctx.memo.consensusGaps) return ctx.memo.consensusGaps;
  const out = new Map();
  const byPos = new Map();
  for (const [id, p] of ctx.players) {
    if (!p || !POSITIONS.includes(p.pos)) continue;
    const mv = marketValue(ctx, id);
    const tier = Number(mv.tier);
    // 0 is values.js's "no tier on file", not "tier zero" — a player the tier sheet never ranked
    // has no consensus to disagree with.
    if (!Number.isFinite(tier) || tier <= 0) continue;
    const vec = weekVector(ctx, id);
    let pts = 0;
    for (const w of ctx.weeksLeft || []) pts += vec[w] || 0;
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push({ id, tier, pts });
  }
  for (const rows of byPos.values()) {
    rows.sort((a, b) => b.pts - a.pts || (a.id < b.id ? -1 : 1));
    // the tier ladder as the projections order it: rank r implies the r-th tiered player's tier
    const ladder = rows.map((r) => r.tier).sort((a, b) => a - b);
    for (let i = 0; i < rows.length; i += 1) {
      const implied = ladder[i];
      out.set(rows[i].id, { tier: rows[i].tier, implied, gap: rows[i].tier - implied });
    }
  }
  ctx.memo.consensusGaps = out;
  return out;
}
