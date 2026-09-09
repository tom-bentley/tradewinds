// Sleeper source: players, league-exact weekly projections, schedule and byes.
//
// Endpoints (R4 §5 — projections live under /projections, NOT /v1):
//   /v1/league/{id}            league (scoring_settings, roster_positions, total_rosters)  ?cb=
//   /v1/state/nfl              season + week                                               ?cb=
//   /v1/players/nfl            ~15 MB player dump                                          no cb
//   /projections/nfl/{season}/{week}?season_type=regular&position[]=...                    no cb
//   /schedule/nfl/regular/{season}                                                         no cb

import {
  POINTS_DECIMALS,
  POLITE_DELAY_MS,
  fetchJson,
  normalizeName,
  numOrNull,
  orderedById,
  orderedByKey,
  round,
  sleep,
} from "../util.mjs";

export const SLEEPER_API = "https://api.sleeper.app";

/** The six fantasy positions this app models. */
export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

const FANTASY_POSITION_SET = new Set(FANTASY_POSITIONS);

/** NFL regular season length; index 0 of a projections array is week 1. */
export const SEASON_WEEKS = 18;

/** Repeatable `position[]=` filter — shrinks a weekly projection call 5.7 MB -> 2.1 MB (R1 §6). */
export const PROJECTION_POSITION_QUERY = FANTASY_POSITIONS.map((p) => `position[]=${p}`).join("&");

/**
 * A filtered week returns ~3,300 rows. Anything far below that means the
 * `position[]=` filter changed meaning, so we refetch unfiltered.
 */
export const MIN_FILTERED_PROJECTION_ROWS = 1500;

/** Weeks a bye can legally fall in — used only to sanity-check, never to impute. */
const BYE_WEEK_RANGE = [4, 15];

/**
 * @typedef {{ id: string, name: string, pos: string, team: string, inj: string|null,
 *   age: number|null, exp: number|null, num: number|null, dc: number|null,
 *   fp: string[], bye: number|null }} ContractPlayer
 */

/**
 * @param {string} leagueId
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchLeague(leagueId) {
  return /** @type {Record<string, any>} */ (
    await fetchJson(`${SLEEPER_API}/v1/league/${leagueId}`, { cacheBust: true })
  );
}

/** @returns {Promise<Record<string, any>>} */
export async function fetchState() {
  return /** @type {Record<string, any>} */ (
    await fetchJson(`${SLEEPER_API}/v1/state/nfl`, { cacheBust: true })
  );
}

/** @returns {Promise<Record<string, any>>} the raw ~15 MB player dump */
export async function fetchPlayersRaw() {
  return /** @type {Record<string, any>} */ (await fetchJson(`${SLEEPER_API}/v1/players/nfl`));
}

/**
 * @param {string|number} season
 * @returns {Promise<any[]>} raw schedule games
 */
export async function fetchScheduleRaw(season) {
  const raw = await fetchJson(`${SLEEPER_API}/schedule/nfl/regular/${season}`);
  if (!Array.isArray(raw)) {
    throw new Error(`unexpected schedule payload from ${SLEEPER_API}/schedule/nfl/regular/${season}`);
  }
  return raw;
}

/**
 * One week of projections, position-filtered, with an unfiltered fallback.
 * @param {string|number} season
 * @param {number} week
 * @returns {Promise<{ rows: any[], url: string, filtered: boolean }>}
 */
export async function fetchProjectionsWeek(season, week) {
  const base = `${SLEEPER_API}/projections/nfl/${season}/${week}?season_type=regular`;
  const filteredUrl = `${base}&${PROJECTION_POSITION_QUERY}`;
  const rows = await fetchJson(filteredUrl);
  if (Array.isArray(rows) && rows.length >= MIN_FILTERED_PROJECTION_ROWS) {
    return { rows, url: filteredUrl, filtered: true };
  }
  await sleep(POLITE_DELAY_MS);
  const fallback = await fetchJson(base);
  if (!Array.isArray(fallback)) {
    throw new Error(`unexpected projections payload from ${base}`);
  }
  return { rows: fallback, url: base, filtered: false };
}

/**
 * League-exact weekly points: sum over the stat keys present in BOTH the
 * projection's `stats` and the league's `scoring_settings` (R4 §1.1).
 * `pts_half_ppr` is deliberately never an input.
 * @param {Record<string, number>|null|undefined} stats
 * @param {Record<string, number>|null|undefined} scoring
 * @returns {number}
 */
export function weeklyPoints(stats, scoring) {
  if (!stats || !scoring) return 0;
  let total = 0;
  for (const key of Object.keys(stats)) {
    const weight = scoring[key];
    if (typeof weight !== "number" || weight === 0) continue;
    const value = stats[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value * weight;
  }
  return total;
}

/**
 * The fantasy position of a raw projection row.
 * @param {any} row
 * @returns {string|null}
 */
export function projectionRowPosition(row) {
  const direct = row?.player?.position;
  if (typeof direct === "string") return direct;
  const list = row?.player?.fantasy_positions;
  return Array.isArray(list) && typeof list[0] === "string" ? list[0] : null;
}

/**
 * Fold one week of raw projection rows into `target` (id -> number[SEASON_WEEKS]).
 * Rows outside the six fantasy positions, or outside `allowedIds`, are ignored.
 * @param {Map<string, number[]>} target mutated in place
 * @param {number} week 1-based
 * @param {any[]} rows raw Sleeper projection rows
 * @param {Record<string, number>} scoring league scoring_settings
 * @param {{ allowedIds?: Set<string>|null }} [options]
 * @returns {{ kept: number, skippedPosition: number, skippedUnknown: number, halfPprDiffs: number[] }}
 */
export function accumulateProjectionWeek(target, week, rows, scoring, options = {}) {
  const { allowedIds = null } = options;
  let kept = 0;
  let skippedPosition = 0;
  let skippedUnknown = 0;
  /** @type {number[]} */
  const halfPprDiffs = [];

  for (const row of rows) {
    const id = row?.player_id;
    if (typeof id !== "string") continue;
    const pos = projectionRowPosition(row);
    if (!pos || !FANTASY_POSITION_SET.has(pos)) {
      skippedPosition += 1;
      continue;
    }
    if (allowedIds && !allowedIds.has(id)) {
      skippedUnknown += 1;
      continue;
    }
    const points = weeklyPoints(row.stats, scoring);
    if (points === 0) continue;
    let weeks = target.get(id);
    if (!weeks) {
      weeks = new Array(SEASON_WEEKS).fill(0);
      target.set(id, weeks);
    }
    weeks[week - 1] = round(points, POINTS_DECIMALS);
    kept += 1;
    const half = row?.stats?.pts_half_ppr;
    if (typeof half === "number" && Number.isFinite(half)) halfPprDiffs.push(points - half);
  }
  return { kept, skippedPosition, skippedUnknown, halfPprDiffs };
}

/**
 * Wrap an accumulator into data/projections.json shape. Players whose every
 * week is 0 are dropped.
 * @param {Map<string, number[]>} accumulated
 * @param {{ season: string, leagueId: string, generatedAt: string, weeks?: number[] }} meta
 * @returns {{ generated_at: string, season: string, scoring: string, weeks: number[],
 *   players: Record<string, number[]> }}
 */
export function finalizeProjections(accumulated, meta) {
  const weeks = meta.weeks ?? Array.from({ length: SEASON_WEEKS }, (_, i) => i + 1);
  /** @type {Record<string, number[]>} */
  const players = {};
  for (const [id, values] of accumulated) {
    if (!values.some((v) => v !== 0)) continue;
    players[id] = values;
  }
  return {
    generated_at: meta.generatedAt,
    season: String(meta.season),
    scoring: `league:${meta.leagueId}`,
    weeks,
    players: orderedById(players),
  };
}

/**
 * Bye week per team = the single scheduled week in which the team has no game.
 * Canceled games stay in the schedule on purpose: removing them would invent
 * a second bye for the affected teams.
 * @param {any[]} rawGames
 * @returns {Record<string, number>} team code -> bye week (teams sorted)
 */
export function computeByes(rawGames) {
  /** @type {Map<string, Set<number>>} */
  const played = new Map();
  /** @type {Set<number>} */
  const weeks = new Set();
  for (const game of rawGames) {
    const week = numOrNull(game?.week);
    if (week === null) continue;
    weeks.add(week);
    for (const team of [game.home, game.away]) {
      if (typeof team !== "string" || team === "") continue;
      if (!played.has(team)) played.set(team, new Set());
      played.get(team).add(week);
    }
  }
  const allWeeks = [...weeks].sort((a, b) => a - b);
  /** @type {Record<string, number>} */
  const byes = {};
  for (const team of [...played.keys()].sort()) {
    const seen = played.get(team);
    const missing = allWeeks.filter((w) => !seen.has(w));
    // Exactly one missing week is the normal case. If the schedule is partial we
    // take the first plausible bye week rather than guessing.
    const candidate =
      missing.length === 1
        ? missing[0]
        : missing.find((w) => w >= BYE_WEEK_RANGE[0] && w <= BYE_WEEK_RANGE[1]);
    if (candidate !== undefined) byes[team] = candidate;
  }
  return byes;
}

/**
 * @param {any[]} rawGames
 * @param {{ season: string, generatedAt: string }} meta
 * @returns {{ generated_at: string, season: string, byes: Record<string, number>,
 *   games: { w: number, home: string, away: string, date: string|null }[] }}
 */
export function buildSchedule(rawGames, meta) {
  const games = rawGames
    .filter((g) => g && typeof g.home === "string" && typeof g.away === "string")
    .map((g) => ({
      w: numOrNull(g.week) ?? 0,
      home: g.home,
      away: g.away,
      date: typeof g.date === "string" ? g.date : null,
    }))
    .sort((a, b) => a.w - b.w || a.home.localeCompare(b.home) || a.away.localeCompare(b.away));
  return {
    generated_at: meta.generatedAt,
    season: String(meta.season),
    byes: computeByes(rawGames),
    games,
  };
}

/**
 * Display name for a raw Sleeper player row (DEF rows have no `full_name`).
 * @param {any} raw
 * @param {string} teamCode
 * @returns {string}
 */
export function playerDisplayName(raw, teamCode) {
  if (raw?.position === "DEF") return `${teamCode} D/ST`;
  if (typeof raw?.full_name === "string" && raw.full_name.trim() !== "") return raw.full_name;
  return [raw?.first_name, raw?.last_name].filter(Boolean).join(" ").trim();
}

/**
 * data/players.json: the six fantasy positions, active and on a team.
 * Team defenses are always kept — their id is the team code.
 * @param {Record<string, any>} rawPlayers
 * @param {Record<string, number>} byes
 * @param {{ generatedAt: string }} meta
 * @returns {{ generated_at: string, count: number, players: Record<string, ContractPlayer> }}
 */
export function buildPlayers(rawPlayers, byes, meta) {
  /** @type {Record<string, ContractPlayer>} */
  const players = {};
  for (const [id, raw] of Object.entries(rawPlayers)) {
    if (!raw || !FANTASY_POSITION_SET.has(raw.position)) continue;
    const isDefense = raw.position === "DEF";
    if (!isDefense && (raw.active !== true || !raw.team)) continue;
    const team = isDefense ? raw.team || id : raw.team;
    if (typeof team !== "string" || team === "") continue;
    players[id] = {
      id,
      name: playerDisplayName(raw, team),
      pos: raw.position,
      team,
      inj: typeof raw.injury_status === "string" && raw.injury_status !== "" ? raw.injury_status : null,
      age: numOrNull(raw.age),
      exp: numOrNull(raw.years_exp),
      num: numOrNull(raw.number),
      dc: numOrNull(raw.depth_chart_order),
      fp: Array.isArray(raw.fantasy_positions) ? raw.fantasy_positions.filter((p) => typeof p === "string") : [],
      bye: Object.prototype.hasOwnProperty.call(byes, team) ? byes[team] : null,
    };
  }
  const ordered = orderedById(players);
  return { generated_at: meta.generatedAt, count: Object.keys(ordered).length, players: ordered };
}

/**
 * `${normalizeName(name)}|${pos}` -> sleeper id. Ambiguous keys map to null so a
 * name-only source can never silently pick the wrong player.
 * @param {Record<string, ContractPlayer>} players
 * @returns {Map<string, string|null>}
 */
export function buildNameIndex(players) {
  /** @type {Map<string, string|null>} */
  const index = new Map();
  for (const player of Object.values(players)) {
    const key = `${normalizeName(player.name)}|${player.pos}`;
    if (index.has(key)) index.set(key, null);
    else index.set(key, player.id);
  }
  return index;
}

/**
 * Full team name -> team code, derived from the DEF rows of the player dump
 * ("Kansas City" + "Chiefs" -> "KC"). Short forms are registered too.
 * @param {Record<string, any>} rawPlayers
 * @returns {Map<string, string>}
 */
export function buildTeamNameIndex(rawPlayers) {
  /** @type {Map<string, string>} */
  const index = new Map();
  for (const [id, raw] of Object.entries(rawPlayers)) {
    if (!raw || raw.position !== "DEF") continue;
    const code = typeof raw.team === "string" && raw.team !== "" ? raw.team : id;
    const full = `${raw.first_name ?? ""} ${raw.last_name ?? ""}`.trim();
    if (full) index.set(normalizeName(full), code);
    if (raw.last_name) index.set(normalizeName(raw.last_name), code);
    index.set(normalizeName(code), code);
  }
  return index;
}

/**
 * Median of a numeric array (used for the pts_half_ppr cross-check).
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Fetch and normalize everything Sleeper contributes. Requests are sequential
 * with POLITE_DELAY_MS between them.
 * @param {{ leagueId: string, season: string, scoring: Record<string, number>,
 *   generatedAt: string, log?: (message: string) => void }} options
 * @returns {Promise<{ players: any, projections: any, schedule: any,
 *   teamNameIndex: Map<string, string>, stats: Record<string, any> }>}
 */
export async function collectSleeper(options) {
  const { leagueId, season, scoring, generatedAt, log = () => {} } = options;

  const rawGames = await fetchScheduleRaw(season);
  const schedule = buildSchedule(rawGames, { season, generatedAt });
  log(`schedule: ${schedule.games.length} games, ${Object.keys(schedule.byes).length} byes`);
  await sleep(POLITE_DELAY_MS);

  const rawPlayers = await fetchPlayersRaw();
  const players = buildPlayers(rawPlayers, schedule.byes, { generatedAt });
  log(`players: ${players.count} of ${Object.keys(rawPlayers).length} raw entries`);
  await sleep(POLITE_DELAY_MS);

  const allowedIds = new Set(Object.keys(players.players));
  /** @type {Map<string, number[]>} */
  const accumulated = new Map();
  /** @type {number[]} */
  const halfPprDiffs = [];
  let unfilteredWeeks = 0;
  let skippedUnknown = 0;

  for (let week = 1; week <= SEASON_WEEKS; week += 1) {
    const { rows, filtered } = await fetchProjectionsWeek(season, week);
    if (!filtered) unfilteredWeeks += 1;
    const result = accumulateProjectionWeek(accumulated, week, rows, scoring, { allowedIds });
    skippedUnknown += result.skippedUnknown;
    halfPprDiffs.push(...result.halfPprDiffs);
    if (week < SEASON_WEEKS) await sleep(POLITE_DELAY_MS);
  }

  const projections = finalizeProjections(accumulated, { season, leagueId, generatedAt });
  log(`projections: ${Object.keys(projections.players).length} players over ${SEASON_WEEKS} weeks`);

  const teamNameIndex = buildTeamNameIndex(rawPlayers);
  const rawPlayerCount = Object.keys(rawPlayers).length;

  return {
    players,
    projections,
    schedule,
    teamNameIndex,
    stats: {
      rawPlayerCount,
      unfilteredWeeks,
      skippedUnknownProjectionRows: skippedUnknown,
      medianHalfPprDiff: median(halfPprDiffs.map((d) => Math.abs(d))),
      byes: orderedByKey(schedule.byes),
    },
  };
}
