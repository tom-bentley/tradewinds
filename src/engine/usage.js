// src/engine/usage.js — shares and trends from `ctx.stats` (004 design §3.2, R10 §1).
//
// This is the opportunity half of the player-intelligence release: what a player was actually GIVEN
// (snaps, targets, carries, red-zone looks) as opposed to what he scored. R10 §1.5 measured, on this
// league's own data, that once you know a player's points the market's 30-day move tells you nothing
// more about whether his usage earned them (partial r = −0.044). Usage is therefore the one signal
// in the app that the price has not already absorbed — and the only reason `hidden.js` exists.
//
// Pure like the rest of the engine: no DOM, no fetch, no clock, no mutation of ctx. Everything is
// memoized on `ctx.memo`. `ctx.stats` is an OPTIONAL input (FR-103) — with nothing loaded every
// function here returns null and the callers degrade to market-only, saying so.
//
// The denominators are the part worth reading twice:
//   snap share   = off_snp / tm_off_snp             both live on the player's own row (R10 §1.1 S1)
//   target share = rec_tgt / Σ_team rec_tgt         NEVER pass_att — a target is not an attempt, and
//                                                   the pipeline ships the team sum for exactly this
//                                                   reason (design §2.1, validated 247/254 vs nflverse)
//   carry share  = rush_att / Σ_team rush_att
//   RZ share     = (rec_rz_tgt + rush_rz_att) / Σ_team (same)   (R10 §1.1 S5)
// `ctx.teamStats` carries {tgt, snp, att, rush} per TEAM|week: `tgt` is the team target sum, `att`
// the team pass attempts, `rush` the team rush attempts. There is no team RZ column, so the RZ
// denominator is derived here by summing every player on that team in that week; when the derivation
// is not possible the share is null and `rzPerGame` carries the raw opportunity count instead.

import { DEFAULTS, POSITIONS } from "../config.js";
import { historyWeekly, playerOf, statsRow } from "./context.js";

/**
 * Minimum |slope| (share per week) for a trend to read as REAL, by position. ENGINE-CHOSEN and
 * labelled: R10 §1.3 searched for a published stabilization curve and found only practitioner
 * folklore (3–4 consecutive games; ≥15 pp of snap-share gain over two weeks). The defensible shape
 * it recommends is `|slope × k| ≥ 0.06` — 6 percentage points of share over the window — which at
 * the default `trendWeeks: 3` is 0.02/week. QB snap share is saturated near 1.0 and barely moves, so
 * a QB's bar is half that; K/DEF have no usage line at all.
 */
export const TREND_SLOPE_MIN = Object.freeze({
  QB: 0.01,
  RB: 0.02,
  WR: 0.02,
  TE: 0.02,
  K: Infinity,
  DEF: Infinity,
});

/** The stats.json keys this module reads (design §2.1). Anything absent reads as 0. */
const KEYS = [
  "off_snp",
  "tm_off_snp",
  "gp",
  "rec_tgt",
  "rec_rz_tgt",
  "rush_att",
  "rush_rz_att",
  "pass_att",
];

function cfg(ctx) {
  const patch = (ctx && ctx.settings && ctx.settings.hidden) || null;
  return patch ? { ...DEFAULTS.hidden, ...patch } : DEFAULTS.hidden;
}

/** A share is only a share when the denominator is a real, positive number. */
function share(num, den) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return n / d;
}

/**
 * Column index for each key this module reads, resolved once per ctx against `ctx.statKeys`.
 * A file that renames or reorders its keys therefore costs nothing here.
 * @param {object} ctx
 * @returns {Object<string, number>} key → index, -1 when the file does not carry it
 */
function keyIndex(ctx) {
  if (ctx.memo.usageKeyIndex) return ctx.memo.usageKeyIndex;
  const keys = Array.isArray(ctx.statKeys) ? ctx.statKeys : [];
  const out = {};
  for (const k of KEYS) out[k] = keys.indexOf(k);
  ctx.memo.usageKeyIndex = out;
  return out;
}

/** One cell out of a decoded week vector, 0 when the file does not carry that key. */
function cell(row, idx) {
  if (!row || idx == null || idx < 0) return 0;
  return Number(row[idx]) || 0;
}

/**
 * Team red-zone opportunities per TEAM|week, derived by summing `rec_rz_tgt + rush_rz_att` over
 * every player `ctx.stats` lists for that team. `ctx.teamStats` has no RZ column (design §2.1 ships
 * tgt/snp/att/rush only), and this sum is the honest reconstruction: the player set is the
 * projections universe, so it covers the touches that matter and under-counts nobody who scores.
 * @param {object} ctx
 * @returns {Map<string, number>} key `${TEAM}|${week}`
 */
function teamRedZone(ctx) {
  if (ctx.memo.usageTeamRz) return ctx.memo.usageTeamRz;
  const idx = keyIndex(ctx);
  const out = new Map();
  for (const [id, row] of ctx.stats || []) {
    const team = (playerOf(ctx, id).team || "").toUpperCase();
    if (!team || !row || !Array.isArray(row.rows)) continue;
    for (let i = 0; i < row.rows.length; i += 1) {
      const vec = row.rows[i];
      if (!vec) continue;
      const opp = cell(vec, idx.rec_rz_tgt) + cell(vec, idx.rush_rz_att);
      if (opp <= 0) continue;
      const key = `${team}|${row.weeks[i]}`;
      out.set(key, (out.get(key) || 0) + opp);
    }
  }
  ctx.memo.usageTeamRz = out;
  return out;
}

/**
 * Ordinary least squares slope of `ys` on `xs`, or null when there is nothing to fit. Both arrays
 * are already filtered to the played, non-partial weeks by the caller.
 * @param {number[]} xs week indices
 * @param {number[]} ys the metric
 * @returns {number|null} units of metric per week
 */
export function olsSlope(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  if (den <= 0) return null;
  return num / den;
}

/**
 * Fit one share series over the last `trendWeeks` PLAYED, NON-PARTIAL weeks.
 *
 * Partial weeks (`ctx.statsPartial` — Monday games whose `tm_off_snp` has not landed yet, R6 §Q6.2)
 * are excluded on purpose: a half-counted denominator invents a share collapse that is an artefact
 * of the clock, and a trend line is exactly where that artefact would do the most damage.
 * @param {number[]} weeks the week numbers, aligned with `series`
 * @param {Array<number|null>} series the share per week (null = no game / no denominator)
 * @param {Set<number>} partial weeks to exclude
 * @param {number} k window length
 * @param {number} floor |slope| threshold for this position
 * @returns {{slope:number|null, weeks:number, real:boolean}}
 */
function trendOf(weeks, series, partial, k, floor) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < series.length; i += 1) {
    if (series[i] == null || partial.has(weeks[i])) continue;
    xs.push(weeks[i]);
    ys.push(series[i]);
  }
  const used = Math.min(k, xs.length);
  const wx = xs.slice(xs.length - used);
  const wy = ys.slice(ys.length - used);
  const slope = olsSlope(wx, wy);
  // R10 §1.3: a trend is real at ≥3 played weeks AND a slope above the position's bar. Both
  // conditions are engine-chosen; the sentence that renders this must say so.
  const real = slope != null && wx.length >= 3 && Math.abs(slope) >= floor;
  return { slope, weeks: wx.length, real };
}

/**
 * One player's usage lines: what he was given, week by week, and where it is heading.
 *
 * Every array is aligned with `weeks` (= `ctx.statWeeks`). A week he did not play is `null` in the
 * share arrays and `false` in `played`, so a caller can always tell "0% of snaps" from "no game".
 *
 * `actual` is this season's ACTUAL points from `ctx.history`, scored this league's way
 * (`pts_std + ppr·rec`, §13.6 F1) — points are deliberately not shipped in stats.json — and `gap`
 * is R10 §1.4's `xFP − actual`: positive means he scored LESS than his opportunity implies.
 *
 * @param {object} ctx
 * @param {string} id
 * @returns {{weeks:number[], played:boolean[], snapShare:Array<number|null>,
 *   targetShare:Array<number|null>, carryShare:Array<number|null>, rzShare:Array<number|null>,
 *   rzPerGame:Array<number|null>, rzBasis:"team"|"perGame"|null, touches:Array<number|null>,
 *   xfp:Array<number|null>, actual:Array<number|null>, gap:Array<number|null>,
 *   trend:{snap:{slope:number|null, weeks:number, real:boolean},
 *          tgt:{slope:number|null, weeks:number, real:boolean}},
 *   playedWeeks:number, opportunities:number, pos:string|null, team:string|null}|null}
 *   null when `ctx.stats` is empty or does not list this player.
 */
export function usageOf(ctx, id) {
  if (!ctx || !ctx.stats || ctx.stats.size === 0) return null;
  if (!ctx.memo.usageOf) ctx.memo.usageOf = new Map();
  const key = String(id);
  if (ctx.memo.usageOf.has(key)) return ctx.memo.usageOf.get(key);

  const row = statsRow(ctx, key);
  if (!row || !Array.isArray(row.rows)) {
    ctx.memo.usageOf.set(key, null);
    return null;
  }

  const c = cfg(ctx);
  const idx = keyIndex(ctx);
  const player = playerOf(ctx, key);
  const team = (player.team || "").toUpperCase();
  const pos = POSITIONS.includes(player.pos) ? player.pos : null;
  const weeks = row.weeks.slice();
  const partial = ctx.statsPartial instanceof Set ? ctx.statsPartial : new Set();
  const teamRz = teamRedZone(ctx);
  // history is keyed by season and returns week 1..N, so index i of `weeks` is week weeks[i] − 1
  const actualSeason = historyWeekly(ctx, key, ctx.season);

  const played = [];
  const snapShare = [];
  const targetShare = [];
  const carryShare = [];
  const rzShare = [];
  const rzPerGame = [];
  const touches = [];
  const xfp = [];
  const actual = [];
  const gap = [];
  let playedWeeks = 0;
  let opportunities = 0;
  let sawTeamRz = false;

  for (let i = 0; i < weeks.length; i += 1) {
    const week = weeks[i];
    const vec = row.rows[i];
    const tm = ctx.teamStats && team ? ctx.teamStats.get(`${team}|${week}`) : null;
    if (!vec) {
      played.push(false);
      snapShare.push(null);
      targetShare.push(null);
      carryShare.push(null);
      rzShare.push(null);
      rzPerGame.push(null);
      touches.push(null);
      xfp.push(null);
      actual.push(null);
      gap.push(null);
      continue;
    }
    played.push(true);
    playedWeeks += 1;

    // S1 — both halves live on the player's own row; the team-week snap total is the fallback for
    // a file (or a week) where `tm_off_snp` has not been filled in yet.
    const teamSnaps = cell(vec, idx.tm_off_snp) || (tm ? tm.snp : 0);
    snapShare.push(share(cell(vec, idx.off_snp), teamSnaps));

    // S2 — the denominator is the TEAM TARGET SUM. `pass_att` is on the row and is the wrong
    // number: sacks, throwaways and scrambles make attempts and targets different populations.
    targetShare.push(share(cell(vec, idx.rec_tgt), tm ? tm.tgt : 0));
    carryShare.push(share(cell(vec, idx.rush_att), tm ? tm.rush : 0));

    const rzOpp = cell(vec, idx.rec_rz_tgt) + cell(vec, idx.rush_rz_att);
    const teamRzOpp = teamRz.get(`${team}|${week}`) || 0;
    const rz = share(rzOpp, teamRzOpp);
    if (rz != null) sawTeamRz = true;
    rzShare.push(rz);
    rzPerGame.push(rzOpp);

    const opp = cell(vec, idx.rec_tgt) + cell(vec, idx.rush_att);
    touches.push(opp);
    opportunities += opp;

    // R10 §4.4 / §1.4, minus the air-yards term (`rec_air_yd` is not in the design §2.1 key set).
    // The RZ coefficients are MARGINAL — they sit on top of the plain target/carry terms, which is
    // how the §1.4 OLS was fitted and why §1.1 S5 quotes 2.49 vs 0.44 (≈5.7×).
    const x =
      c.xfp.tgt * cell(vec, idx.rec_tgt) +
      c.xfp.rzTgt * cell(vec, idx.rec_rz_tgt) +
      c.xfp.carry * cell(vec, idx.rush_att) +
      c.xfp.rzCarry * cell(vec, idx.rush_rz_att);
    xfp.push(x);

    const act = actualSeason.length >= week ? actualSeason[week - 1] : null;
    actual.push(act);
    gap.push(act == null ? null : x - act);
  }

  const floor = TREND_SLOPE_MIN[pos] != null ? TREND_SLOPE_MIN[pos] : TREND_SLOPE_MIN.WR;
  const out = {
    weeks,
    played,
    snapShare,
    targetShare,
    carryShare,
    rzShare,
    rzPerGame,
    // "team" when at least one week had a derivable team RZ denominator, "perGame" when the shares
    // are all null and only `rzPerGame` carries information, null when he never played.
    rzBasis: sawTeamRz ? "team" : playedWeeks > 0 ? "perGame" : null,
    touches,
    xfp,
    actual,
    gap,
    trend: {
      snap: trendOf(weeks, snapShare, partial, c.trendWeeks, floor),
      tgt: trendOf(weeks, targetShare, partial, c.trendWeeks, floor),
    },
    playedWeeks,
    opportunities,
    pos,
    team: team || null,
  };
  ctx.memo.usageOf.set(key, out);
  return out;
}

/**
 * Season-to-date totals over the played weeks: the numbers a sentence quotes ("18 targets and 4
 * red-zone looks in two weeks"). Shares are opportunity-weighted, not the mean of weekly shares,
 * so one snap in a blowout cannot swing the line.
 *
 * The gap is computed on the MATCHED window only. `stats.json` ships a trailing window of completed
 * weeks and `history.json` is regenerated on its own cadence, so the two can disagree by a week —
 * and an xFP summed over two weeks against points summed over one is not a regression signal, it is
 * a lag artefact that would read as a huge buy on everybody at once. `xfp` is therefore the whole
 * played window (what his usage was worth) and `xfpMatched` is the part that has an actual beside
 * it; only the second one is ever differenced.
 * @param {object} ctx
 * @param {string} id
 * @returns {{playedWeeks:number, opportunities:number, xfp:number, xfpMatched:number,
 *   actual:number|null, gap:number|null, gapWeeks:number, perWeek:number|null,
 *   snapShare:number|null, targetShare:number|null}|null}
 */
export function usageTotals(ctx, id) {
  const u = usageOf(ctx, id);
  if (!u) return null;
  let xfpSum = 0;
  let xfpMatched = 0;
  let actSum = 0;
  let actWeeks = 0;
  let snapNum = 0;
  let snapDen = 0;
  let tgtNum = 0;
  let tgtDen = 0;
  const idx = keyIndex(ctx);
  const row = statsRow(ctx, String(id));
  const team = u.team;
  for (let i = 0; i < u.weeks.length; i += 1) {
    if (!u.played[i]) continue;
    xfpSum += u.xfp[i] || 0;
    if (u.actual[i] != null) {
      xfpMatched += u.xfp[i] || 0;
      actSum += u.actual[i];
      actWeeks += 1;
    }
    const vec = row.rows[i];
    const tm = ctx.teamStats && team ? ctx.teamStats.get(`${team}|${u.weeks[i]}`) : null;
    const teamSnaps = cell(vec, idx.tm_off_snp) || (tm ? tm.snp : 0);
    if (teamSnaps > 0) {
      snapNum += cell(vec, idx.off_snp);
      snapDen += teamSnaps;
    }
    if (tm && tm.tgt > 0) {
      tgtNum += cell(vec, idx.rec_tgt);
      tgtDen += tm.tgt;
    }
  }
  const gap = actWeeks > 0 ? xfpMatched - actSum : null;
  return {
    playedWeeks: u.playedWeeks,
    opportunities: u.opportunities,
    xfp: xfpSum,
    xfpMatched,
    actual: actWeeks > 0 ? actSum : null,
    gap,
    gapWeeks: actWeeks,
    perWeek: gap != null && actWeeks > 0 ? gap / actWeeks : null,
    snapShare: share(snapNum, snapDen),
    targetShare: share(tgtNum, tgtDen),
  };
}
