// src/engine/values.js — the market axis (R3 §a, §b, §d).
// Two axes are kept deliberately separate and never averaged: market value M (what the league
// will pay, this file) and lineup value (what it scores for me, lineup.js).

import { TRADEABLE } from "../config.js";
import { playerOf, rosPoints, rosteredIds, slotEligibility } from "./context.js";

/** The source every other source is scale-matched onto (R3 §a). */
export const REFERENCE_SOURCE = "fc_redraft";
/** Synthetic source id for the fitted exponential value curve. */
export const CURVE_SOURCE = "proj";
/** Ranks deeper than this are excluded from the curve regression — the deep tail of the market
 *  is flat noise (values bottom out near 0) and drags the exponent badly (R3 §3). */
export const CURVE_FIT_MAX_RANK = 120;
/**
 * The value tables each blend ROLE can resolve to (design.md §10.2). Settings weights are keyed by
 * role (`fc_redraft`, `dp_dynasty`, …); which physical table a role reads depends on the league:
 * 2QB/superflex leagues price quarterbacks completely differently, and Boris Chen publishes one
 * tier list per PPR setting.
 */
export const ROLE_TABLES = Object.freeze({
  fc_redraft: { kind: "redraft", twoQb: "fc_redraft_2qb" },
  fc_dynasty: { kind: "dynasty", twoQb: "fc_dynasty_2qb" },
  dp_dynasty: { kind: "dynasty", twoQb: "dp_dynasty_2qb" },
  bc_tiers: { kind: "tiers", ppr: true },
});

/** Boris Chen tier tables, by the PPR value each was computed for. */
export const BC_TIER_VARIANTS = Object.freeze([
  [0, "bc_tiers_std"],
  [0.5, "bc_tiers_half"],
  [1, "bc_tiers_ppr"],
]);

/**
 * Table names a role may resolve to, best fit first.
 * @param {object} ctx
 * @param {string} role e.g. "fc_redraft"
 * @returns {string[]}
 */
export function tableCandidates(ctx, role) {
  const spec = ROLE_TABLES[role];
  if (!spec) return [role];
  if (spec.twoQb) {
    const numQbs = Number(ctx.league && ctx.league.numQbs) || 1;
    // a superflex league that only shipped the 1QB table still gets values, just less exact
    return numQbs >= 2 ? [spec.twoQb, role] : [role, spec.twoQb];
  }
  const ppr = Number(ctx.league && ctx.league.ppr) || 0;
  const ordered = [...BC_TIER_VARIANTS].sort(
    (a, b) => Math.abs(a[0] - ppr) - Math.abs(b[0] - ppr) || a[0] - b[0]
  );
  // nearest PPR variant, then the plain table (all a v1 pipeline emits), then the rest
  return [ordered[0][1], role, ...ordered.slice(1).map(([, name]) => name)];
}

/**
 * Resolve a blend role to the value table this league should actually read (design.md §10.2).
 * @param {object} ctx
 * @param {string} role
 * @returns {string|null} table id present in ctx.values, or null when nothing covers the role
 */
export function tableFor(ctx, role) {
  if (!ctx.memo.tableFor) ctx.memo.tableFor = new Map();
  if (ctx.memo.tableFor.has(role)) return ctx.memo.tableFor.get(role);
  let hit = null;
  for (const name of tableCandidates(ctx, role)) {
    const src = ctx.values && ctx.values[name];
    if (src && src.values) {
      hit = name;
      break;
    }
  }
  ctx.memo.tableFor.set(role, hit);
  return hit;
}

/**
 * Rows of the table a role resolves to.
 * @param {object} ctx
 * @param {string} role
 * @returns {object|null}
 */
export function tableRows(ctx, role) {
  const id = tableFor(ctx, role);
  return id ? ctx.values[id].values : null;
}

/**
 * Kind ("redraft" / "dynasty" / "tiers") of the table a role resolves to. Falls back to the role
 * declaration so a variant table that forgot to publish `kind` still blends.
 * @param {object} ctx
 * @param {string} role
 * @returns {string|null}
 */
export function roleKind(ctx, role) {
  const id = tableFor(ctx, role);
  if (!id) return null;
  const declared = ctx.values[id] && ctx.values[id].kind;
  return declared || (ROLE_TABLES[role] ? ROLE_TABLES[role].kind : null);
}

/**
 * Table ids to read display metadata from, in preference order: the table each known role
 * resolves to, then any table that is not a variant of a known role. Variants this league did NOT
 * resolve to are skipped, so a 1QB league never shows a 2QB tier.
 * @param {object} ctx
 * @returns {string[]}
 */
function metaOrder(ctx) {
  if (ctx.memo.metaOrder) return ctx.memo.metaOrder;
  const roles = [REFERENCE_SOURCE, ...Object.keys(ROLE_TABLES).filter((r) => r !== REFERENCE_SOURCE)];
  const aliases = new Set();
  const order = [];
  for (const role of roles) {
    for (const name of tableCandidates(ctx, role)) aliases.add(name);
    const id = tableFor(ctx, role);
    if (id && !order.includes(id)) order.push(id);
  }
  for (const id of Object.keys(ctx.values || {})) {
    if (!aliases.has(id) && !order.includes(id)) order.push(id);
  }
  ctx.memo.metaOrder = order;
  return order;
}

/** Injury labels Sleeper spells differently from our discount table. */
const INJURY_ALIASES = Object.freeze({
  Suspended: "Sus",
  Suspension: "Sus",
  COV: "NA",
  Reserve: "IR",
  "Injured Reserve": "IR",
  "Non Football Injury": "NA",
});

/**
 * Median of a numeric array (lower median for even lengths so the result is always a datum).
 * @param {number[]} xs
 * @returns {number|null}
 */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Remaining-season replacement baselines per position (R4 §1.2): the points of the last player
 * the league can start at that position, with the FLEX allocation *derived* from who actually
 * wins the flex spots rather than assumed.
 * @param {object} ctx
 * @returns {{baseline:Object<string,number>, consumed:Object<string,number>,
 *            byPos:Object<string,Array<[string,number]>>}}
 */
export function rosBaselines(ctx) {
  if (ctx.memo.rosBaselines) return ctx.memo.rosBaselines;
  const byPos = {};
  for (const [id, p] of ctx.players) {
    if (!p || !TRADEABLE.includes(p.pos)) continue;
    const pts = rosPoints(ctx, id);
    if (pts <= 0) continue;
    (byPos[p.pos] = byPos[p.pos] || []).push([id, pts]);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }

  const teams = ctx.league.numTeams || 1;
  const dedicated = {};
  let flexSlots = 0;
  // any multi-position slot is a flex slot: FLEX, WRRB_FLEX, REC_FLEX, SUPER_FLEX
  for (const slot of ctx.slots) {
    const elig = slotEligibility(slot);
    if (elig.length > 1) flexSlots += 1;
    else if (elig.length === 1 && TRADEABLE.includes(elig[0])) {
      dedicated[elig[0]] = (dedicated[elig[0]] || 0) + 1;
    }
  }

  const flexPool = [];
  for (const pos of Object.keys(byPos)) {
    if (!ctx.flexEligible.has(pos)) continue;
    flexPool.push(...byPos[pos].slice((dedicated[pos] || 0) * teams));
  }
  flexPool.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const alloc = {};
  for (const [id] of flexPool.slice(0, flexSlots * teams)) {
    const pos = ctx.players.get(id).pos;
    alloc[pos] = (alloc[pos] || 0) + 1;
  }

  const consumed = {};
  const baseline = {};
  for (const pos of TRADEABLE) {
    const arr = byPos[pos] || [];
    consumed[pos] = (dedicated[pos] || 0) * teams + (alloc[pos] || 0);
    const idx = Math.min(Math.max(consumed[pos], 1), arr.length) - 1;
    baseline[pos] = arr.length ? arr[idx][1] : 0;
  }
  const out = { baseline, consumed, byPos };
  ctx.memo.rosBaselines = out;
  return out;
}

/**
 * Remaining-season value rank (1 = best) across tradeable positions, ranked by points **over
 * positional replacement**. Ranking by raw points would sort every QB above every RB in a
 * 1QB half-PPR league and destroy the market correlation the curve fit depends on.
 * @param {object} ctx
 * @returns {Map<string, number>} player id → rank
 */
export function rosRanks(ctx) {
  if (ctx.memo.rosRanks) return ctx.memo.rosRanks;
  const { baseline } = rosBaselines(ctx);
  const rows = [];
  for (const [id, p] of ctx.players) {
    if (!p || !TRADEABLE.includes(p.pos)) continue;
    const pts = rosPoints(ctx, id);
    if (pts <= 0) continue;
    rows.push([id, pts - (baseline[p.pos] || 0)]);
  }
  rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ranks = new Map();
  rows.forEach(([id], i) => ranks.set(id, i + 1));
  ctx.memo.rosRanks = ranks;
  return ranks;
}

/**
 * Fit value = A·exp(−k·rank) by log-linear (ordinary least squares on ln v) regression over the
 * players that have both a remaining-season rank and a FantasyCalc redraft price (R3 §a step 2).
 * @param {object} ctx
 * @returns {{A:number, k:number, n:number}} A = value at rank 0, k = decay per rank
 */
export function curveFit(ctx) {
  if (ctx.memo.curveFit) return ctx.memo.curveFit;
  const ranks = rosRanks(ctx);
  const ref = tableRows(ctx, REFERENCE_SOURCE);
  const xs = [];
  const ys = [];
  for (const [id, rank] of ranks) {
    if (rank > CURVE_FIT_MAX_RANK) continue;
    const row = ref && ref[id];
    const v = row && Number(row.v);
    if (!v || v <= 0) continue;
    xs.push(rank);
    ys.push(Math.log(v));
  }
  let fit = { A: 0, k: 0, n: xs.length };
  if (xs.length >= 2) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i += 1) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) * (xs[i] - mx);
    }
    const slope = sxx === 0 ? 0 : sxy / sxx; // slope = −k
    fit = { A: Math.exp(my - slope * mx), k: -slope, n };
  }
  ctx.memo.curveFit = fit;
  return fit;
}

/**
 * The synthetic "proj" source value for a player: A·exp(−k·rank).
 * @param {object} ctx
 * @param {string} id
 * @returns {number|null} null when the player has no remaining-season projection
 */
export function curveValue(ctx, id) {
  const rank = rosRanks(ctx).get(id);
  if (!rank) return null;
  const { A, k } = curveFit(ctx);
  if (!A) return null;
  return A * Math.exp(-k * rank);
}

/**
 * Raw per-player rows of one value source, or null when the source is absent/empty.
 * @param {object} ctx
 * @param {string} sourceId
 * @returns {object|null}
 */
function sourceValues(ctx, sourceId) {
  const src = ctx.values && ctx.values[sourceId];
  if (!src || !src.values) return null;
  return src.values;
}

/**
 * Source ids present in ctx.values of a given kind, in the order their weights are declared.
 * @param {object} ctx
 * @param {"redraft"|"dynasty"} kind
 * @returns {string[]}
 */
function presentSources(ctx, kind) {
  const weights = kind === "dynasty" ? ctx.settings.dynastyWeights : ctx.settings.weights;
  const out = [];
  for (const role of Object.keys(weights || {})) {
    if (!(weights[role] > 0)) continue;
    if (role === CURVE_SOURCE) {
      if (kind === "redraft") out.push(role);
      continue;
    }
    if (roleKind(ctx, role) === kind) out.push(role);
  }
  return out;
}

/**
 * Median-of-ratios scale factors mapping every source onto the reference source's scale.
 * @param {object} ctx
 * @returns {Object<string, number>} source id → multiplier
 */
export function scaleFactors(ctx) {
  if (ctx.memo.scaleFactors) return ctx.memo.scaleFactors;
  const refId = tableFor(ctx, REFERENCE_SOURCE);
  const ref = refId ? ctx.values[refId].values : null;
  const factors = { [REFERENCE_SOURCE]: 1, [CURVE_SOURCE]: 1 };
  if (refId) factors[refId] = 1;
  for (const [id, src] of Object.entries(ctx.values || {})) {
    if (id === refId) continue;
    if (!src || !src.values || (src.kind !== "redraft" && src.kind !== "dynasty")) continue;
    if (!ref) {
      factors[id] = 1;
      continue;
    }
    const ratios = [];
    for (const [pid, row] of Object.entries(src.values)) {
      const mine = Number(row && row.v);
      const theirs = Number(ref[pid] && ref[pid].v);
      if (mine > 0 && theirs > 0) ratios.push(theirs / mine);
    }
    factors[id] = median(ratios) || 1;
  }
  ctx.memo.scaleFactors = factors;
  return factors;
}

/**
 * Blend the scale-matched values of the sources that actually price this player, renormalizing
 * the weights over exactly those sources (R3 §a).
 * @returns {{value:number|null, parts:Object<string,number>, weight:number, realWeight:number,
 *            realTotal:number}}
 */
function blend(ctx, id, kind, matched) {
  const weights = kind === "dynasty" ? ctx.settings.dynastyWeights : ctx.settings.weights;
  const parts = {};
  let num = 0;
  let den = 0;
  let realWeight = 0;
  let realTotal = 0;
  for (const sid of presentSources(ctx, kind)) {
    const w = Number(weights[sid]) || 0;
    if (sid !== CURVE_SOURCE) realTotal += w;
    const v = matched[sid];
    if (v == null || !Number.isFinite(v)) continue;
    parts[sid] = v;
    num += w * v;
    den += w;
    if (sid !== CURVE_SOURCE) realWeight += w;
  }
  return { value: den > 0 ? num / den : null, parts, weight: den, realWeight, realTotal };
}

/**
 * Injury haircut δ for a Sleeper injury_status.
 * @param {object} ctx
 * @param {string|null} inj
 * @returns {number} 0..1
 */
export function injuryDiscount(ctx, inj) {
  if (!inj) return 0;
  const key = INJURY_ALIASES[inj] || inj;
  const d = Number(ctx.settings.injuryDiscount[key]);
  return Number.isFinite(d) ? d : 0;
}

/** Fields copied off a source row for display, in preference order. */
const META_FIELDS = Object.freeze(["r", "pr", "tier", "t", "rp", "tf", "sd", "ecr"]);

/**
 * Multiplier that puts a source's roster share on a 0-100 percentage scale. Sources publish it
 * either way (the committed FantasyCalc tables use 0-100, an older snapshot used 0-1), and the
 * two are only distinguishable per SOURCE, never per player: a legitimate 0.59% would otherwise
 * be misread as 59%.
 * @param {object} ctx
 * @param {string} sourceId
 * @returns {number} 1 or 100
 */
export function rosterPctScale(ctx, sourceId) {
  if (!ctx.memo.rosterPctScale) ctx.memo.rosterPctScale = {};
  const hit = ctx.memo.rosterPctScale[sourceId];
  if (hit) return hit;
  let max = 0;
  const rows = sourceValues(ctx, sourceId);
  if (rows) {
    for (const row of Object.values(rows)) {
      const rp = Number(row && row.rp);
      if (Number.isFinite(rp) && rp > max) max = rp;
    }
  }
  const scale = max > 1 ? 1 : 100;
  ctx.memo.rosterPctScale[sourceId] = scale;
  return scale;
}

/**
 * Consensus market value for one player, memoized per ctx.
 * K and DEF are lineup slots but never trade pieces, so their `m` is null and all trade math
 * skips them (R3 assumption 2).
 * @param {object} ctx
 * @param {string} id Sleeper player id
 * @returns {{m:number|null, mAdj:number|null, redraft:number|null, dynasty:number|null,
 *            projV:number|null, sources:Object<string,number>, sourcesRaw:Object<string,number>,
 *            coverage:number, fallback:"blend"|"curve"|null, rank:number|null,
 *            posRank:number|null, tier:number|null, trend:number|null, rosterPct:number|null,
 *            tradeFreq:number|null, sd:number|null, ecr:number|null, pos:string|null,
 *            inj:string|null, discount:number}}
 */
export function marketValue(ctx, id) {
  if (!ctx.memo.marketValue) ctx.memo.marketValue = new Map();
  const hit = ctx.memo.marketValue.get(id);
  if (hit) return hit;

  const player = playerOf(ctx, id);
  const pos = player.pos || null;
  const inj = player.inj || null;
  const out = {
    m: null,
    mAdj: null,
    redraft: null,
    dynasty: null,
    projV: null,
    sources: {},
    sourcesRaw: {},
    coverage: 0,
    fallback: null,
    rank: null,
    posRank: null,
    tier: null,
    trend: null,
    rosterPct: null,
    tradeFreq: null,
    sd: null,
    ecr: null,
    pos,
    inj,
    discount: 0,
  };

  if (!TRADEABLE.includes(pos)) {
    ctx.memo.marketValue.set(id, out);
    return out;
  }

  const factors = scaleFactors(ctx);
  const scaled = {};
  for (const [sid, src] of Object.entries(ctx.values || {})) {
    if (!src || !src.values) continue;
    const row = src.values[id];
    const v = Number(row && row.v);
    if (!(v > 0)) continue;
    out.sourcesRaw[sid] = v;
    scaled[sid] = v * (factors[sid] || 1);
  }
  // blend weights are keyed by ROLE; each role reads the table this league resolves to (§10.2)
  const matched = {};
  const roles = new Set([
    ...Object.keys(ROLE_TABLES),
    ...Object.keys(ctx.settings.weights || {}),
    ...Object.keys(ctx.settings.dynastyWeights || {}),
  ]);
  for (const role of roles) {
    if (role === CURVE_SOURCE) continue;
    const tid = tableFor(ctx, role);
    if (tid && scaled[tid] != null) matched[role] = scaled[tid];
  }
  out.projV = curveValue(ctx, id);
  if (out.projV != null) matched[CURVE_SOURCE] = out.projV;

  const rd = blend(ctx, id, "redraft", matched);
  const dyn = blend(ctx, id, "dynasty", matched);
  out.redraft = rd.value;
  out.dynasty = dyn.value;
  out.sources = { ...rd.parts, ...dyn.parts };

  const phi = Number(ctx.settings.keeperTilt) || 0;
  if (rd.value != null && dyn.value != null) out.m = (1 - phi) * rd.value + phi * dyn.value;
  else if (rd.value != null) out.m = rd.value;
  else if (dyn.value != null) out.m = dyn.value;

  const realWeight = rd.realWeight + dyn.realWeight;
  const realTotal = rd.realTotal + dyn.realTotal;
  out.coverage = realTotal > 0 ? realWeight / realTotal : 0;
  if (out.m == null) out.fallback = null;
  else if (realWeight > 0) out.fallback = "blend";
  else out.fallback = "curve";

  // display metadata: prefer the resolved reference table, then the others this league reads
  const order = metaOrder(ctx);
  const meta = {};
  for (const sid of order) {
    const row = (ctx.values[sid] && ctx.values[sid].values && ctx.values[sid].values[id]) || null;
    if (!row) continue;
    for (const f of META_FIELDS) {
      if (meta[f] != null || row[f] == null) continue;
      meta[f] = Number(row[f]) * (f === "rp" ? rosterPctScale(ctx, sid) : 1);
    }
  }
  out.rank = meta.r ?? null;
  out.posRank = meta.pr ?? null;
  out.tier = meta.tier ?? null;
  out.trend = meta.t ?? null;
  out.rosterPct = meta.rp ?? null; // always 0-100, whichever scale the source published
  out.tradeFreq = meta.tf ?? null;
  out.sd = meta.sd ?? null; // signed: sources report direction as well as magnitude
  out.ecr = meta.ecr ?? null;

  out.discount = injuryDiscount(ctx, inj);
  out.mAdj = out.m == null ? null : out.m * (1 - out.discount);

  ctx.memo.marketValue.set(id, out);
  return out;
}

/**
 * Best free agent per position, by injury-adjusted market value — this league's live replacement
 * level (R3 §b). An 8-team league leaves genuinely startable players on the wire, and this is the
 * one number that encodes it.
 * @param {object} ctx
 * @returns {{QB:number, RB:number, WR:number, TE:number, FLEX:number,
 *            best:Object<string,{id:string, m:number}>}}
 */
export function waiverReplacement(ctx) {
  if (ctx.memo.waiverReplacement) return ctx.memo.waiverReplacement;
  const taken = rosteredIds(ctx);
  const best = {};
  for (const [id, p] of ctx.players) {
    if (!p || !TRADEABLE.includes(p.pos) || taken.has(id)) continue;
    const mv = marketValue(ctx, id);
    if (mv.mAdj == null) continue;
    const cur = best[p.pos];
    if (!cur || mv.mAdj > cur.m || (mv.mAdj === cur.m && id < cur.id)) {
      best[p.pos] = { id, m: mv.mAdj };
    }
  }
  const val = (pos) => (best[pos] ? best[pos].m : 0);
  const out = {
    QB: val("QB"),
    RB: val("RB"),
    WR: val("WR"),
    TE: val("TE"),
    FLEX: Math.max(val("RB"), val("WR"), val("TE")),
    best,
  };
  ctx.memo.waiverReplacement = out;
  return out;
}

/**
 * Value a player adds above what the wire would give you for free (R3 §b). This single line is
 * the whole consolidation model: every player you receive occupies a spot you could otherwise
 * have filled for nothing, so a 2-for-1 automatically credits one W back to the side sending two.
 * @param {object} ctx
 * @param {string} id
 * @returns {number} max(mAdj − ρ·W[pos], 0)
 */
export function surplus(ctx, id) {
  const mv = marketValue(ctx, id);
  if (mv.mAdj == null) return 0;
  const w = waiverReplacement(ctx);
  const rho = Number(ctx.settings.rho);
  const replacement = (w[mv.pos] || 0) * (Number.isFinite(rho) ? rho : 1);
  return Math.max(mv.mAdj - replacement, 0);
}

/**
 * Aggregate one side of a trade.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {{raw:number, surplus:number, best:string|null}}
 */
export function sideValue(ctx, ids) {
  let raw = 0;
  let surp = 0;
  let best = null;
  let bestM = -Infinity;
  for (const id of ids || []) {
    const mv = marketValue(ctx, id);
    if (mv.mAdj != null) {
      raw += mv.mAdj;
      if (mv.mAdj > bestM || (mv.mAdj === bestM && best != null && id < best)) {
        bestM = mv.mAdj;
        best = id;
      }
    }
    surp += surplus(ctx, id);
  }
  return { raw, surplus: surp, best };
}
