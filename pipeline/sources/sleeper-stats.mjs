// Sleeper bulk weekly stat rows -> data/stats.json (004 design §2.1) and data/dvp.json (§2.3).
//
// DEVIATION FROM 004 design §2.1, verified live 2026-09-22 ------------------------------------
// The design names `GET /v1/stats/nfl/regular/{season}/{week}?season_type=regular` as the source.
// That endpoint answers with a DICT keyed by player_id whose rows carry **no `team`, no
// `opponent` and no `game_id`** (measured: 200, 574,220 B, 2,351 keys; row fields for id "19" were
// `gms_active,pos_rank_*,tm_def_snp,tm_off_snp,tm_st_snp` only). Without `team` the per-team
// denominators in §2.1 cannot be summed, and without `opponent` the defence-vs-position table in
// §2.3 cannot be attributed. R6 §(a) makes the same point and names the other shape as the one for
// "everything in this initiative", so this module reads the RICH ARRAY endpoint instead:
//
//   GET https://api.sleeper.app/stats/nfl/{season}/{week}?season_type=regular&position[]=QB&…
//   -> 200, 765,458 B raw (~111 KB gzip), 775 rows, each carrying
//      { player_id, team, opponent, game_id, week, player: { position }, stats: {…} }
//
// The `position[]=` filter is the same trick `sleeper.mjs` already uses for projections and cuts
// the unfiltered 2.1 MB payload by 64 %.

import {
  POLITE_DELAY_MS,
  compareIds,
  fetchJson,
  orderedById,
  orderedByKey,
  round,
  sleep,
} from "../util.mjs";
import {
  FANTASY_POSITIONS,
  SLEEPER_API,
  STAT_DECIMALS,
  projectionRowPosition,
} from "./sleeper.mjs";

/** Schema version of data/stats.json (004 design §1). */
export const STATS_VERSION = 1;

/** Schema version of data/dvp.json (004 design §1). */
export const DVP_VERSION = 1;

/** Completed weeks carried in data/stats.json `players` (004 design §2.1: "last ≤ 8"). */
export const STATS_WINDOW_WEEKS = 8;

/**
 * The 16 usage keys of 004 design §2.1, in the design's order. Unlike projections v2 the
 * vocabulary is FIXED, not grown by first appearance: the design pins the list, so a week with
 * no quarterbacks can never renumber the file. Index into this array is the `keyIdx` of the
 * `[keyIdx, value, …]` pair encoding `src/engine/context.js buildStats` decodes.
 */
export const STAT_KEYS = Object.freeze([
  "off_snp",
  "tm_off_snp",
  "gp",
  "rec_tgt",
  "rec",
  "rec_yd",
  "rec_td",
  "rec_rz_tgt",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rush_rz_att",
  "pass_att",
  "pass_yd",
  "pass_td",
  "pass_rz_att",
]);

/** Positions data/dvp.json reports, in design §2.3 order. */
export const DVP_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** Sleeper's own full-PPR "points allowed" fields, kept only as provenance (R6 §Q6.4). */
const FAN_PTS_ALLOW = Object.freeze({
  QB: "fan_pts_allow_qb",
  RB: "fan_pts_allow_rb",
  WR: "fan_pts_allow_wr",
  TE: "fan_pts_allow_te",
  K: "fan_pts_allow_k",
  DEF: "fan_pts_allow_def",
});

/** Repeatable `position[]=` filter — 2.1 MB unfiltered -> 765 KB (R6 §(a)). */
export const STATS_POSITION_QUERY = FANTASY_POSITIONS.map((p) => `position[]=${p}`).join("&");

/** Below this a filtered week is suspect and the caller should treat it as "no week". */
export const MIN_WEEK_STAT_ROWS = 200;

const KEY_INDEX = new Map(STAT_KEYS.map((key, index) => [key, index]));

/**
 * One completed week of rich stat rows.
 * @param {string|number} season
 * @param {number} week
 * @returns {Promise<any[]>} the raw array (empty when the week has not been played)
 */
export async function fetchWeekStatsRich(season, week) {
  const url =
    `${SLEEPER_API}/stats/nfl/${season}/${week}?season_type=regular&${STATS_POSITION_QUERY}`;
  const rows = await fetchJson(url, { cacheBust: true });
  // An unplayed week answers `[]` with HTTP 200, never a 404 (R6 §(a)).
  return Array.isArray(rows) ? rows : [];
}

/**
 * Team code as the rest of the app spells it. DEF rows use the team code as the player id too.
 * @param {unknown} value
 * @returns {string|null}
 */
export function teamCode(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed === "" ? null : trimmed;
}

/**
 * Encode one raw `stats` object into the `[keyIdx, value, …]` pair line of design §2.1.
 * Zero and absent are the same thing (a QB row simply has no `rec_tgt`), so both are dropped;
 * a line with nothing in it encodes as the scalar `0`, matching projections v2 (`contract.mjs`
 * `checkStatLine`) and `buildStats`'s "0 = no game/DNP".
 * @param {Record<string, unknown>|null|undefined} stats
 * @returns {number[]|0}
 */
export function encodeStatLine(stats) {
  if (!stats || typeof stats !== "object") return 0;
  /** @type {number[]} */
  const flat = [];
  for (let index = 0; index < STAT_KEYS.length; index += 1) {
    const raw = stats[STAT_KEYS[index]];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const value = round(raw, STAT_DECIMALS);
    if (value === 0) continue;
    flat.push(index, value);
  }
  return flat.length > 0 ? flat : 0;
}

/**
 * Decode a pair line back to `{ key: value }` — the inverse, for tests and the run report.
 * @param {number[]|0|null|undefined} entry
 * @returns {Record<string, number>}
 */
export function decodeStatLine(entry) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!Array.isArray(entry)) return out;
  for (let i = 0; i + 1 < entry.length; i += 2) {
    const name = STAT_KEYS[entry[i]];
    if (typeof name === "string") out[name] = entry[i + 1];
  }
  return out;
}

/**
 * Per-team denominators for one week (004 design §2.1). `tgt` is `Σ rec_tgt`, NOT `Σ pass_att`:
 * R6 §Q6.3 measured the two differing on 24 of 32 teams (throwaways and spikes carry no target)
 * and `Σ rec_tgt` is the denominator nflverse's `target_share` uses, matching on 247/254 players.
 * `snp` is the team's offensive snap count, which Sleeper repeats identically on every row of the
 * team, so `max` picks it up whichever rows are present.
 * @param {any[]} rows one week of rich rows
 * @returns {Record<string, {tgt:number, snp:number, att:number, rush:number}>}
 */
export function teamTotalsFromRows(rows) {
  /** @type {Record<string, {tgt:number, snp:number, att:number, rush:number}>} */
  const totals = {};
  for (const row of rows) {
    const team = teamCode(row?.team);
    if (!team) continue;
    const stats = row?.stats && typeof row.stats === "object" ? row.stats : {};
    const entry = totals[team] || (totals[team] = { tgt: 0, snp: 0, att: 0, rush: 0 });
    const num = (key) => (typeof stats[key] === "number" && Number.isFinite(stats[key]) ? stats[key] : 0);
    entry.tgt += num("rec_tgt");
    entry.att += num("pass_att");
    entry.rush += num("rush_att");
    entry.snp = Math.max(entry.snp, num("tm_off_snp"));
  }
  for (const entry of Object.values(totals)) {
    entry.tgt = round(entry.tgt, STAT_DECIMALS);
    entry.att = round(entry.att, STAT_DECIMALS);
    entry.rush = round(entry.rush, STAT_DECIMALS);
    entry.snp = round(entry.snp, STAT_DECIMALS);
  }
  return totals;
}

/**
 * Is this week's snap feed still incomplete? R6 §Q6.3 measured the Monday-night game arriving
 * with `off_snp`/`tm_off_snp` entirely absent for both teams ~5 h after the final whistle, while
 * every other team had them — so "a team played this week but has no offensive snap count" is the
 * lag, and the week is flagged `partial` until Sportradar's snap feed lands.
 * @param {any[]} rows one week of rich rows
 * @returns {boolean}
 */
export function weekIsPartial(rows) {
  const totals = teamTotalsFromRows(rows);
  const teams = Object.keys(totals);
  if (teams.length === 0) return true;
  return teams.some((team) => totals[team].snp <= 0);
}

/**
 * Fold every fetched week into data/stats.json (004 design §2.1).
 * @param {{ weeks: {week:number, rows:any[]}[], allowedIds: Set<string>|null,
 *           season: string|number, generatedAt: string, window?: number }} input
 *   `weeks` must be ascending and hold COMPLETED weeks only.
 * @returns {{ version:number, generated_at:string, season:string, weeks:number[],
 *   partial:number[], keys:string[], players:Record<string,(number[]|0)[]>,
 *   std:Record<string, number[]|0>, teams:Record<string, Record<string, object>> }}
 */
export function buildStats(input) {
  const { weeks: fetched, allowedIds = null, season, generatedAt } = input;
  const window = Number.isInteger(input.window) && input.window > 0 ? input.window : STATS_WINDOW_WEEKS;
  const ordered = [...fetched].sort((a, b) => a.week - b.week);
  const windowWeeks = ordered.slice(-window);
  const weekNumbers = windowWeeks.map((entry) => entry.week);

  const keep = (id) => typeof id === "string" && id !== "" && (!allowedIds || allowedIds.has(id));

  // Season-to-date sums run over EVERY completed week, not just the trailing window, so `std`
  // stays a true season line once the window starts sliding (design §2.1 "season-to-date sums").
  /** @type {Map<string, Record<string, number>>} */
  const seasonTotals = new Map();
  for (const { rows } of ordered) {
    for (const row of rows) {
      const id = row?.player_id;
      if (!keep(id)) continue;
      const stats = row?.stats && typeof row.stats === "object" ? row.stats : null;
      if (!stats) continue;
      let acc = seasonTotals.get(id);
      if (!acc) seasonTotals.set(id, (acc = {}));
      for (const key of STAT_KEYS) {
        const raw = stats[key];
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
        acc[key] = (acc[key] ?? 0) + raw;
      }
    }
  }

  /** @type {Map<string, (number[]|0)[]>} */
  const lines = new Map();
  windowWeeks.forEach(({ rows }, index) => {
    for (const row of rows) {
      const id = row?.player_id;
      if (!keep(id)) continue;
      const entry = encodeStatLine(row?.stats);
      if (entry === 0) continue;
      let list = lines.get(id);
      if (!list) lines.set(id, (list = new Array(windowWeeks.length).fill(0)));
      list[index] = entry;
    }
  });

  /** @type {Record<string, (number[]|0)[]>} */
  const players = {};
  /** @type {Record<string, number[]|0>} */
  const std = {};
  for (const id of [...lines.keys()].sort(compareIds)) {
    const list = lines.get(id) ?? [];
    // `buildStats` in the engine drops a player whose every week decodes to nothing, so a row
    // that would be all-zero is never written in the first place.
    if (!list.some((entry) => Array.isArray(entry))) continue;
    players[id] = list;
    const totals = seasonTotals.get(id);
    const line = totals ? encodeStatLine(totals) : 0;
    if (line !== 0) std[id] = line;
  }

  /** @type {Record<string, Record<string, object>>} */
  const teams = {};
  windowWeeks.forEach(({ week, rows }) => {
    for (const [team, totals] of Object.entries(teamTotalsFromRows(rows))) {
      (teams[team] || (teams[team] = {}))[String(week)] = totals;
    }
  });

  return {
    version: STATS_VERSION,
    generated_at: generatedAt,
    season: String(season),
    weeks: weekNumbers,
    partial: windowWeeks.filter(({ rows }) => weekIsPartial(rows)).map(({ week }) => week),
    keys: [...STAT_KEYS],
    players: orderedById(players),
    std: orderedById(std),
    teams: orderedByKey(
      Object.fromEntries(Object.entries(teams).map(([team, byWeek]) => [team, orderedByKey(byWeek)])),
    ),
  };
}

/**
 * Fold every fetched week into data/dvp.json (004 design §2.3) — defence vs position, recomputed
 * in HALF-PPR by summing each opponent's `pts_half_ppr` by position. Sleeper's own
 * `fan_pts_allow_*` is FULL PPR (R6 §Q6.4 measured 160/160 matches against Σ `pts_ppr` and only
 * 64/160 against half-PPR), so it rides along as `ppr_ref` for provenance and is never presented
 * as the half-PPR number.
 *
 * `opponent` comes off the rich row itself (measured present on every row, 2026-09-22), so no
 * schedule join is needed; `schedule` is accepted only as a fallback for rows that lack it.
 * @param {{ weeks:{week:number, rows:any[]}[], season:string|number, generatedAt:string,
 *           schedule?: {games?: {w:number, home:string, away:string}[]}|null }} input
 * @returns {object} data/dvp.json
 */
export function buildDvp(input) {
  const { weeks: fetched, season, generatedAt, schedule = null } = input;
  const ordered = [...fetched].sort((a, b) => a.week - b.week);
  const weekNumbers = ordered.map((entry) => entry.week);

  /** `${week}|${TEAM}` -> opponent, from data/schedule.json, for rows with no `opponent`. */
  const scheduleOpponent = new Map();
  for (const game of schedule?.games ?? []) {
    const week = Number(game?.w ?? game?.week);
    const home = teamCode(game?.home);
    const away = teamCode(game?.away);
    if (!Number.isInteger(week) || !home || !away) continue;
    scheduleOpponent.set(`${week}|${home}`, away);
    scheduleOpponent.set(`${week}|${away}`, home);
  }

  /** team -> { allowed: {pos: (number|null)[]}, ppr: {pos: number}, played: boolean[] } */
  const byTeam = new Map();
  const ensure = (team) => {
    let entry = byTeam.get(team);
    if (!entry) {
      entry = {
        allowed: Object.fromEntries(DVP_POSITIONS.map((pos) => [pos, new Array(ordered.length).fill(null)])),
        ppr: Object.fromEntries(DVP_POSITIONS.map((pos) => [pos, null])),
        played: new Array(ordered.length).fill(false),
      };
      byTeam.set(team, entry);
    }
    return entry;
  };

  ordered.forEach(({ week, rows }, index) => {
    for (const row of rows) {
      const offense = teamCode(row?.team);
      const defense =
        teamCode(row?.opponent) ?? (offense ? scheduleOpponent.get(`${week}|${offense}`) ?? null : null);
      if (!defense) continue;
      const pos = projectionRowPosition(row);
      if (!pos || !DVP_POSITIONS.includes(pos)) continue;
      const stats = row?.stats && typeof row.stats === "object" ? row.stats : {};
      const entry = ensure(defense);
      entry.played[index] = true;
      const points = stats.pts_half_ppr;
      if (typeof points === "number" && Number.isFinite(points)) {
        entry.allowed[pos][index] = round((entry.allowed[pos][index] ?? 0) + points, STAT_DECIMALS);
      } else if (entry.allowed[pos][index] === null) {
        entry.allowed[pos][index] = 0;
      }
    }
    // Provenance: read `fan_pts_allow_*` off each team's OWN defence row for this week.
    for (const row of rows) {
      const team = teamCode(row?.team);
      if (!team || projectionRowPosition(row) !== "DEF") continue;
      const stats = row?.stats && typeof row.stats === "object" ? row.stats : {};
      const entry = ensure(team);
      for (const [pos, field] of Object.entries(FAN_PTS_ALLOW)) {
        const raw = stats[field];
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
        entry.ppr[pos] = round((entry.ppr[pos] ?? 0) + raw, STAT_DECIMALS);
      }
    }
  });

  /** @type {Record<string, object>} */
  const teams = {};
  for (const [team, entry] of byTeam) {
    /** @type {Record<string, (number|null)[]>} */
    const allowed = {};
    /** @type {Record<string, number>} */
    const std = {};
    for (const pos of DVP_POSITIONS) {
      allowed[pos] = entry.allowed[pos];
      std[pos] = round(
        entry.allowed[pos].reduce((total, value) => total + (value ?? 0), 0),
        STAT_DECIMALS,
      );
    }
    /** @type {Record<string, number>} */
    const pprRef = {};
    for (const pos of DVP_POSITIONS) {
      if (entry.ppr[pos] !== null) pprRef[pos] = entry.ppr[pos];
    }
    teams[team] = {
      gp: entry.played.filter(Boolean).length,
      allowed,
      std,
      ...(Object.keys(pprRef).length > 0 ? { ppr_ref: pprRef } : {}),
    };
  }

  return {
    version: DVP_VERSION,
    generated_at: generatedAt,
    season: String(season),
    scoring: "half_ppr",
    weeks: weekNumbers,
    teams: orderedByKey(teams),
  };
}

/**
 * `${week}|${TEAM}` -> Sleeper `game_id` ("202610204"), harvested from the rich rows. The bulk
 * array has no `is_away_team`, so the key is per TEAM rather than per matchup; games.mjs uses it
 * to stamp the same id the per-player stat rows use onto a games.json row.
 * @param {{week:number, rows:any[]}[]} weeks
 * @returns {Map<string, string>}
 */
export function gameIdsFromRows(weeks) {
  const out = new Map();
  for (const { week, rows } of weeks) {
    for (const row of rows) {
      const team = teamCode(row?.team);
      const id = typeof row?.game_id === "string" && row.game_id !== "" ? row.game_id : null;
      if (team && id) out.set(`${week}|${team}`, id);
    }
  }
  return out;
}

/**
 * Which regular-season weeks are complete? A week is complete once Sleeper's state week is past
 * it (design §2.1). `partial` — the snap feed still landing — is a separate flag, not an
 * exclusion: the box score itself is usable within ~1 h of the final whistle (R6 §Q6.2).
 * @param {number} stateWeek Sleeper `/v1/state/nfl` `week`
 * @returns {number[]} ascending, possibly empty
 */
export function completedWeeks(stateWeek) {
  const last = Math.min(Math.max(0, Math.floor(Number(stateWeek) || 0) - 1), 18);
  return Array.from({ length: last }, (_, i) => i + 1);
}

/**
 * Fetch every completed week and assemble both files. Optional in the refresh run: any throw is
 * the caller's to catch, and a week that answers `[]` or too few rows is simply skipped.
 * @param {{ season:string|number, stateWeek:number, allowedIds?:Set<string>|null,
 *           generatedAt:string, schedule?:object|null, log?:(m:string)=>void }} options
 * @returns {Promise<{ stats:object|null, dvp:object|null, weeks:{week:number,rows:any[]}[],
 *   gameIds:Map<string,string>, errors:Record<string,string> }>}
 */
export async function collectStats(options) {
  const { season, stateWeek, allowedIds = null, generatedAt, schedule = null, log = () => {} } = options;
  /** @type {{week:number, rows:any[]}[]} */
  const weeks = [];
  /** @type {Record<string, string>} */
  const errors = {};

  for (const week of completedWeeks(stateWeek)) {
    try {
      const rows = await fetchWeekStatsRich(season, week);
      if (rows.length < MIN_WEEK_STAT_ROWS) {
        errors[`week${week}`] = `${rows.length} rows (floor ${MIN_WEEK_STAT_ROWS}) — week skipped`;
        log(`week ${week}: ${rows.length} rows — skipped`);
      } else {
        weeks.push({ week, rows });
        log(`week ${week}: ${rows.length} rows`);
      }
    } catch (error) {
      errors[`week${week}`] = error.message;
      log(`week ${week}: ${error.message}`);
    }
    await sleep(POLITE_DELAY_MS);
  }

  if (weeks.length === 0) {
    return { stats: null, dvp: null, weeks, gameIds: new Map(), errors };
  }
  return {
    stats: buildStats({ weeks, allowedIds, season, generatedAt }),
    dvp: buildDvp({ weeks, season, generatedAt, schedule }),
    weeks,
    gameIds: gameIdsFromRows(weeks),
    errors,
  };
}
