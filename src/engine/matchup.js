// src/engine/matchup.js — 004 design §3.4 (WS-H eng-matchup). Pure; clock-free; memoized on ctx.memo.
//
// THE RULE (R8 §5.4, one sentence): never apply an opponent-defence term to a Sleeper skill-position
// projection — Rotowire's own opponent factor is already in there (±6-8%, proven by a 90% byte-
// identical home/away rematch fingerprint, R8 §2.2) — so QB/RB/WR/TE get NO multiplier here, ever;
// apply matchup only where the projection demonstrably lacks it (Vegas implied totals, wind, roof),
// and only for K/DEF, where a deterministic backtest shows it actually pays (R8 §4).
//
// Double-count exposure by position (R8 §5.3), kept here so nobody re-adds a skill-position DvP
// term later without re-reading this table first:
//   QB   ±2.4 projected pts already applied (rotowire_opp_factor.json SD ±7.90%) — HIGHEST exposure
//   RB   ±1.9 projected pts already applied (SD ±8.43%) — HIGHEST exposure
//   WR   moderate: priced on the generic "is this defence good" axis (SD ±6.71%); position-specific
//        coverage (man/zone, shadow corners) is barely expressed in it
//   TE   moderate, same axis as WR (SD ±5.66%)
//   K    ZERO exposure — Rotowire projects kickers as a flat, matchup-blind number (14/15 future
//        weeks byte-identical per kicker, R8 §2.5); a kicker streaming layer double-counts nothing
//   DST  NEGATIVE exposure — Rotowire under-weights the true matchup effect by roughly 10x (R8 §2.7:
//        its own DEF projection correlates only -0.50 / -0.054 pts-per-opponent-point against a
//        measured reality of -0.472 pts per implied point, R8 §4.1); a Vegas-only DST rule corrects
//        an under-weighting rather than duplicating one — this is why it is the one place a matchup
//        signal beat the incumbent projection (MAE 4.577 vs 4.629, R8 §4.1, SC-105).
//
// Every constant below is read from ctx.settings.streamingModel / ctx.settings.calibration with a
// DEFAULTS fallback (never a bare literal), matching the pattern lineup.js already uses for
// `streaming`/`availability` (settingsBlock). This file intentionally does NOT import lineup.js:
// lineup.js imports this module (the K/DEF hook), so the reverse import would be a cycle. oppFactor
// therefore reads ctx.proj directly instead of going through lineup.js's weekVector/weekPoints.

import { DEFAULTS } from "../config.js";
import { gameFor, playerOf } from "./context.js";

const STREAMING_POS = new Set(["K", "DEF"]);

/** Neutral streamingFactor result: no game, lines missing, streaming disabled, or not K/DEF. */
const NEUTRAL_STREAM = Object.freeze({ f: 1, z: null, conf: "none", indoorPts: 0 });

/**
 * Clip x to [-cap, cap].
 * @param {number} x
 * @param {number} cap non-negative
 * @returns {number}
 */
function clip(x, cap) {
  if (!Number.isFinite(x)) return 0;
  if (x > cap) return cap;
  if (x < -cap) return -cap;
  return x;
}

/**
 * One settings block merged over its DEFAULTS key, memoized per ctx. Deliberately duplicated from
 * lineup.js's `settingsBlock` (same algorithm, same `ctx.memo.cfgBlocks` cache key so the two never
 * disagree) rather than imported, to avoid a lineup.js <-> matchup.js cycle — see header note.
 * @param {object} ctx
 * @param {string} name key in DEFAULTS
 * @returns {object}
 */
function cfgBlock(ctx, name) {
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
 * A team code for `id`: DEF ids ARE team codes (players.json), everyone else carries `.team`.
 * @param {object} ctx
 * @param {string} id
 * @returns {string|null}
 */
function teamOf(ctx, id) {
  const row = playerOf(ctx, id);
  if (row.team) return String(row.team).toUpperCase();
  return row.pos === "DEF" ? String(id).toUpperCase() : null;
}

/**
 * Indoor flag: explicit `game.indoor` wins; otherwise derived from `roof ∈ {dome, closed}` (design
 * §3.4 data contract note — games.json does not always carry both fields).
 * @param {object} game
 * @returns {boolean}
 */
function resolveIndoor(game) {
  if (typeof game.indoor === "boolean") return game.indoor;
  return game.roof === "dome" || game.roof === "closed";
}

/**
 * Implied team/opponent totals for `team` in `week`, from `ctx.games` via `gameFor` (design §2.2:
 * `spread` is the HOME team's own line, negative = home favoured). Memoized per ctx.
 * @param {object} ctx
 * @param {string} team upper-case team code
 * @param {number} week
 * @returns {{team:number, opp:number, oppTeam:string, game:object}|null} null when the game or its
 *   lines (`total`/`spread`) are missing
 */
function impliedTotals(ctx, team, week) {
  if (!team) return null;
  if (!ctx.memo) ctx.memo = {};
  if (!ctx.memo.matchupImplied) ctx.memo.matchupImplied = new Map();
  const key = `${team}|${week}`;
  if (ctx.memo.matchupImplied.has(key)) return ctx.memo.matchupImplied.get(key);

  let result = null;
  const game = gameFor(ctx, team, week);
  if (game) {
    const total = Number(game.total);
    const spread = Number(game.spread);
    if (Number.isFinite(total) && Number.isFinite(spread)) {
      const isHome = String(game.home).toUpperCase() === team;
      const spreadForTeam = isHome ? spread : -spread;
      const teamImp = (total - spreadForTeam) / 2;
      const oppImp = (total + spreadForTeam) / 2;
      const oppTeam = isHome ? game.away : game.home;
      result = { team: teamImp, opp: oppImp, oppTeam, game };
    }
  }
  ctx.memo.matchupImplied.set(key, result);
  return result;
}

/**
 * Vegas-implied points for `team` in `week`: `(total − spreadForTeam) / 2`, home spread sign per
 * design §2.2. Display + the streaming model's own input.
 * @param {object} ctx
 * @param {string} team
 * @param {number} week
 * @returns {number|null}
 */
export function teamImplied(ctx, team, week) {
  const t = team ? String(team).toUpperCase() : null;
  const r = impliedTotals(ctx, t, week);
  return r ? r.team : null;
}

/**
 * Vegas-implied points for `team`'s OPPONENT in `week` — symmetric to `teamImplied`.
 * @param {object} ctx
 * @param {string} team
 * @param {number} week
 * @returns {number|null}
 */
export function oppImplied(ctx, team, week) {
  const t = team ? String(team).toUpperCase() : null;
  const r = impliedTotals(ctx, t, week);
  return r ? r.opp : null;
}

/**
 * Rotowire's own embedded opponent factor for one week, reverse-engineered the way R8 §2.3 did:
 * that week's projected points ÷ the mean of the player's own non-zero LOOK-AHEAD weeks (weeks
 * `ctx.week..ctx.lastWeek`, i.e. not-yet-played — R8 §8 item 2 flags the current week as modelled
 * on a different, sharper pipeline, so the look-ahead population is the stable, comparable one).
 * DISPLAY ONLY — never multiplies a projection (that is precisely the double-count the R8 rule
 * forbids). Reads `ctx.proj` directly, never `lineup.js`, to avoid an import cycle (header note).
 * @param {object} ctx
 * @param {string} id
 * @param {number} week 1-based
 * @returns {{f:number, n:number}|null} null under 4 non-zero look-ahead weeks or no projection
 */
export function oppFactor(ctx, id, week) {
  if (!ctx.memo) ctx.memo = {};
  if (!ctx.memo.oppFactor) ctx.memo.oppFactor = new Map();
  const key = `${id}|${week}`;
  if (ctx.memo.oppFactor.has(key)) return ctx.memo.oppFactor.get(key);

  let result = null;
  const proj = ctx.proj ? ctx.proj.get(id) : null;
  if (proj && proj.length) {
    const lastWeek = Number.isFinite(ctx.lastWeek) && ctx.lastWeek > 0 ? ctx.lastWeek : proj.length;
    const startWeek = Number.isFinite(ctx.week) && ctx.week > 0 ? ctx.week : 1;
    let sum = 0;
    let n = 0;
    for (let w = startWeek; w <= lastWeek && w <= proj.length; w += 1) {
      const v = Number(proj[w - 1]);
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        n += 1;
      }
    }
    if (n >= 4) {
      const mean = sum / n;
      const target = week >= 1 && week <= proj.length ? Number(proj[week - 1]) : NaN;
      if (mean > 0 && Number.isFinite(target)) result = { f: target / mean, n };
    }
  }
  ctx.memo.oppFactor.set(key, result);
  return result;
}

/**
 * The K/DEF streaming model (design §3.4, R8 §4-§5): the one place matchup actually pays. `f = 1`
 * for every other position, when `DEFAULTS.streamingModel.enabled` is off, or when the game/its
 * lines are missing — always the SAME shape so a caller never has to branch on presence.
 * - DST: `f = 1 + clip(wImp · z_impOpp, ±cap)`, `z_impOpp = (oppImplied − meanImplied) / zUnit`. No
 *   spread/wind/roof term (both ns once implied total is in, R8 §4.1/§5.3).
 * - K: `f = 1 + clip(wImp · z_impK + wWind · windTerm, ±cap)`, `z_impK` uses the OWN implied total
 *   capped at `impliedPeak` (kicker points peak at 21-24, R8 §4.2), `windTerm = −max(0, wind−10)/10`
 *   (0 indoors or when wind is unknown — but unknown wind also lowers `conf` to "low", since we are
 *   guessing calm rather than knowing it). `indoorPts` is an ADDITIVE bonus applied after `f`
 *   scales the base points (never folded into `f` itself) — lineup.js's hook adds it separately.
 * @param {object} ctx
 * @param {string} id
 * @param {number} week
 * @returns {{f:number, z:{imp:number,wind:number,indoor:boolean}|null, conf:"high"|"low"|"none",
 *   indoorPts:number}}
 */
export function streamingFactor(ctx, id, week) {
  const pos = playerOf(ctx, id).pos;
  if (!STREAMING_POS.has(pos)) return NEUTRAL_STREAM;

  const cfg = cfgBlock(ctx, "streamingModel");
  if (cfg.enabled === false) return NEUTRAL_STREAM;

  const team = teamOf(ctx, id);
  const imp = team ? impliedTotals(ctx, team, week) : null;
  if (!imp) return NEUTRAL_STREAM;

  const D = DEFAULTS.streamingModel;
  const meanImplied = Number.isFinite(cfg.meanImplied) ? cfg.meanImplied : D.meanImplied;
  const zUnit = Number.isFinite(cfg.zUnit) && cfg.zUnit !== 0 ? cfg.zUnit : D.zUnit;
  const indoor = resolveIndoor(imp.game);

  if (pos === "DEF") {
    const dst = cfg.dst && typeof cfg.dst === "object" ? cfg.dst : D.dst;
    const wImp = Number.isFinite(dst.wImp) ? dst.wImp : D.dst.wImp;
    const cap = Number.isFinite(dst.cap) ? dst.cap : D.dst.cap;
    const zImpOpp = (imp.opp - meanImplied) / zUnit;
    const f = 1 + clip(wImp * zImpOpp, cap);
    return { f, z: { imp: zImpOpp, wind: 0, indoor }, conf: "high", indoorPts: 0 };
  }

  // K
  const k = cfg.k && typeof cfg.k === "object" ? cfg.k : D.k;
  const wImp = Number.isFinite(k.wImp) ? k.wImp : D.k.wImp;
  const wWind = Number.isFinite(k.wWind) ? k.wWind : D.k.wWind;
  const cap = Number.isFinite(k.cap) ? k.cap : D.k.cap;
  const impliedPeak = Number.isFinite(k.impliedPeak) ? k.impliedPeak : D.k.impliedPeak;
  const indoorPtsCfg = Number.isFinite(k.indoorPts) ? k.indoorPts : D.k.indoorPts;

  const cappedImplied = Math.min(imp.team, impliedPeak);
  const zImpK = (cappedImplied - meanImplied) / zUnit;
  const rawWind = imp.game.windMph;
  const windKnown = indoor || Number.isFinite(rawWind);
  const windTerm = indoor ? 0 : -Math.max(0, (Number.isFinite(rawWind) ? rawWind : 0) - 10) / 10;
  const f = 1 + clip(wImp * zImpK + wWind * windTerm, cap);
  const indoorPts = indoor ? indoorPtsCfg : 0;
  return { f, z: { imp: zImpK, wind: windTerm, indoor }, conf: windKnown ? "high" : "low", indoorPts };
}

// ---------------------------------------------------------------------------------------------
// matchupGrade / matchupFlags — display layer (R8 §5.5)
// ---------------------------------------------------------------------------------------------

/** DST buckets by OPPONENT implied total (R8 §4.1 measured means: 9.78, 8.22, 6.50, 4.94, 4.62 for
 *  <18, 18-21, 21-24, 24-27, 27+ — monotone decreasing, so bin = 5 - bucket index). */
const IMPLIED_BUCKET_EDGES = Object.freeze([18, 21, 24, 27]);
const DST_BUCKET_MEAN = Object.freeze([9.78, 8.22, 6.5, 4.94, 4.62]);
const DST_BUCKET_BIN = Object.freeze([5, 4, 3, 2, 1]);
/** K buckets by OWN implied total (R8 §4.2 measured means: 4.95, 7.23, 7.80, 7.42, 7.52 — peaks at
 *  21-24, so bins are ranked by measured points, NOT by distance from the peak bucket index). */
const K_BUCKET_MEAN = Object.freeze([4.95, 7.23, 7.8, 7.42, 7.52]);
const K_BUCKET_BIN = Object.freeze([1, 2, 5, 3, 4]);

function bucketIndex(v) {
  let i = 0;
  for (const edge of IMPLIED_BUCKET_EDGES) {
    if (v >= edge) i += 1;
    else break;
  }
  return i; // 0..4
}

/** R8 §2.3 opponent-factor SD by position — the population `oppFactor` quintiles are drawn from. */
const OPP_FACTOR_SD = Object.freeze({ QB: 0.079, RB: 0.0843, WR: 0.0671, TE: 0.0566 });
/** Φ⁻¹(.2, .4, .6, .8): standard-normal quintile cut points. */
const QUINTILE_Z = Object.freeze([-0.8416, -0.2533, 0.2533, 0.8416]);
const PRICED_IN_WHY = "already priced in — matchup context moves scoring by under 1 %";

function quintileBin(z) {
  let bin = 1;
  for (const cut of QUINTILE_Z) if (z >= cut) bin += 1;
  return bin; // 1..5
}

/**
 * Wind/roof flags cheap enough and clean enough to ship (R8 §5.5): wind ≥ `windFlagMph` outdoors
 * downgrades K and flags WR; indoor upgrades K. Only K and WR ever carry a flag — RB's wind effect
 * is positive/ns and is explicitly NOT flagged (R8 §5.5).
 * @param {object} ctx
 * @param {string} id
 * @param {number} week
 * @returns {Array<{code:string, pos:string, text:string}>}
 */
export function matchupFlags(ctx, id, week) {
  const pos = playerOf(ctx, id).pos;
  if (pos !== "K" && pos !== "WR") return [];
  const team = teamOf(ctx, id);
  const imp = team ? impliedTotals(ctx, team, week) : null;
  if (!imp) return [];

  const cfg = cfgBlock(ctx, "streamingModel");
  const windFlagMph = Number.isFinite(cfg.windFlagMph) ? cfg.windFlagMph : DEFAULTS.streamingModel.windFlagMph;
  const indoor = resolveIndoor(imp.game);
  const wind = Number(imp.game.windMph);
  const windy = !indoor && Number.isFinite(wind) && wind >= windFlagMph;

  const flags = [];
  if (pos === "K") {
    if (windy) {
      flags.push({
        code: "wind_k_downgrade",
        pos: "K",
        text: `Wind ${wind} mph outdoors downgrades the kicker matchup (R8 §4.2).`,
      });
    }
    if (indoor) {
      flags.push({
        code: "indoor_k_bonus",
        pos: "K",
        text: "Indoor game — kicker matchup gets a small scoring bonus (R8 §4.2).",
      });
    }
  } else if (windy) {
    flags.push({
      code: "wind_wr",
      pos: "WR",
      text: `Wind ${wind} mph outdoors — WR production drops sharply in this bucket (R8 §1.1).`,
    });
  }
  return flags;
}

/**
 * A 5-bin matchup grade with an honest confidence qualifier (R8 §5.5). K/DEF are graded off the
 * measured Vegas buckets (`conf: "high"`, `adjusted: true`) because that is a real, applied
 * adjustment. QB/RB/WR/TE are graded off `oppFactor` quintiles (`conf: "low"`, `adjusted: false`)
 * because the projection already prices the matchup in — this NEVER changes displayed points, only
 * the badge, and `why[]` says so explicitly.
 * @param {object} ctx
 * @param {string} id
 * @param {number} week
 * @returns {{bin:1|2|3|4|5, conf:"high"|"low", adjusted:boolean, why:string[]}}
 */
export function matchupGrade(ctx, id, week) {
  const row = playerOf(ctx, id);
  const pos = row.pos;

  if (pos === "K" || pos === "DEF") {
    const team = teamOf(ctx, id);
    const imp = team ? impliedTotals(ctx, team, week) : null;
    if (!imp) {
      return { bin: 3, conf: "low", adjusted: false, why: ["No game odds for this week — matchup unknown."] };
    }
    const flags = matchupFlags(ctx, id, week);
    if (pos === "DEF") {
      const idx = bucketIndex(imp.opp);
      const bin = DST_BUCKET_BIN[idx];
      const why = [
        `Opponent implied total ${imp.opp.toFixed(1)} pts — that bucket has averaged ` +
          `${DST_BUCKET_MEAN[idx].toFixed(2)} DST pts in 2025 (R8 §4.1).`,
      ];
      return { bin, conf: "high", adjusted: true, why };
    }
    const idx = bucketIndex(imp.team);
    let bin = K_BUCKET_BIN[idx];
    const windDowngrade = flags.some((fl) => fl.code === "wind_k_downgrade");
    if (windDowngrade) bin = Math.max(1, bin - 1);
    const why = [
      `Own implied total ${imp.team.toFixed(1)} pts — that bucket has averaged ` +
        `${K_BUCKET_MEAN[idx].toFixed(2)} K pts in 2025, peak is 21-24 (R8 §4.2).`,
      ...flags.map((fl) => fl.text),
    ];
    return { bin, conf: "high", adjusted: true, why };
  }

  // Skill positions: context only, never a number change.
  const why = [PRICED_IN_WHY];
  const of = oppFactor(ctx, id, week);
  const team = teamOf(ctx, id);
  const imp = team ? impliedTotals(ctx, team, week) : null;
  if (imp) why.push(`Team implied total ${imp.team.toFixed(1)} pts this week.`);
  for (const fl of matchupFlags(ctx, id, week)) why.push(fl.text);

  if (!of) {
    why.push("Fewer than 4 look-ahead projected weeks — no opponent-factor context available.");
    return { bin: 3, conf: "low", adjusted: false, why };
  }
  why.push(`This week is ${Math.round(of.f * 100)}% of ${row.name || id}'s look-ahead mean (n=${of.n}).`);
  const sd = OPP_FACTOR_SD[pos] || 0.08;
  const z = (of.f - 1) / sd;
  return { bin: quintileBin(z), conf: "low", adjusted: false, why };
}
