// Sleeper source: players, projected STAT LINES (projections v2), schedule and byes.
//
// Endpoints (R4 §5 — projections live under /projections, NOT /v1):
//   /v1/state/nfl              season + week                                               ?cb=
//   /v1/players/nfl            ~15 MB player dump                                          no cb
//   /projections/nfl/{season}/{week}?season_type=regular&position[]=...                    no cb
//   /schedule/nfl/regular/{season}                                                         no cb
//
// The league endpoint is deliberately NOT used: since design §10.1/§10.6 the pipeline is
// league-agnostic. We ship raw stat lines and every league's scoring is applied on the phone.

import {
  POLITE_DELAY_MS,
  compareIds,
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

/** Schema version stamped into data/projections.json (design §10.1). */
export const PROJECTIONS_VERSION = 2;

/** Decimals kept on a projected stat value. Sleeper already publishes 2. */
export const STAT_DECIMALS = 2;

/**
 * Derived / meta keys that no `scoring_settings` ever references, so shipping them
 * would only cost bytes (design §10.1). Everything else is kept — some leagues score
 * `pass_att`, `rec_40p`, `bonus_rec_te`, `yds_allow_*`, ...
 */
export const PROJECTION_EXCLUDED_KEYS = new Set([
  "adp_dd_ppr",
  "pos_adp_dd_ppr",
  "gp",
  "pts_std",
  "pts_half_ppr",
  "pts_ppr",
  "cmp_pct",
]);

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
 * players.json v2.1 (design §12.3). `injPart`/`injNotes`/`newsAt` were added for the advisor:
 * "Doubtful" alone cannot say how long a player is out, but "Knee - Meniscus" + "Surgery" can,
 * and `newsAt` is what the phone shows as "news 3 h ago". Additive — older files simply omit them.
 * @typedef {{ id: string, name: string, pos: string, team: string, inj: string|null,
 *   injPart: string|null, injNotes: string|null, newsAt: number|null,
 *   age: number|null, exp: number|null, num: number|null, dc: number|null,
 *   fp: string[], bye: number|null }} ContractPlayer
 */

/**
 * A non-empty trimmed string, or null. Sleeper writes "" as often as it writes null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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
 * League-exact weekly points: sum over the stat keys present in BOTH the projection's
 * `stats` and a league's `scoring_settings` (R4 §1.1). The pipeline no longer needs this
 * — points are computed on the phone from the v2 stat lines — but it stays exported as
 * the reference implementation the projections-v2 anchor test is measured against.
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
 * One week of raw `stats` as ordered [key, value] pairs: nonzero, non-excluded, finite,
 * rounded to STAT_DECIMALS and sorted by key name so encoding is deterministic.
 * @param {Record<string, unknown>|null|undefined} stats
 * @returns {[string, number][]|null} null when the week carries nothing worth shipping
 */
export function statPairs(stats) {
  if (!stats || typeof stats !== "object") return null;
  /** @type {[string, number][]} */
  const pairs = [];
  for (const key of Object.keys(stats).sort()) {
    if (PROJECTION_EXCLUDED_KEYS.has(key)) continue;
    const raw = stats[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const value = round(raw, STAT_DECIMALS);
    if (value === 0) continue;
    pairs.push([key, value]);
  }
  return pairs.length > 0 ? pairs : null;
}

/**
 * Decode one v2 week entry back to `{ stat: value }` — the inverse of the encoding,
 * used by the tests and by the run report.
 * @param {number[]|0|null|undefined} entry
 * @param {string[]} keys
 * @returns {Record<string, number>}
 */
export function decodeStatLine(entry, keys) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!Array.isArray(entry)) return out;
  for (let i = 0; i + 1 < entry.length; i += 2) {
    const name = keys[entry[i]];
    if (typeof name === "string") out[name] = entry[i + 1];
  }
  return out;
}

/**
 * The client-side scoring formula of design §10.1:
 * `pts(w) = Σ value × (scoring_settings[keys[idx]] ?? 0)`.
 * @param {number[]|0|null|undefined} entry
 * @param {string[]} keys
 * @param {Record<string, number>|null|undefined} scoring
 * @returns {number}
 */
export function statLinePoints(entry, keys, scoring) {
  if (!Array.isArray(entry) || !scoring) return 0;
  let total = 0;
  for (let i = 0; i + 1 < entry.length; i += 2) {
    const weight = scoring[keys[entry[i]]];
    if (typeof weight !== "number") continue;
    total += entry[i + 1] * weight;
  }
  return total;
}

/**
 * Fold one week of raw projection rows into `target` (id -> [key, value][] per week).
 * Rows outside the six fantasy positions, or outside `allowedIds`, are ignored.
 * @param {Map<string, ([string, number][]|null)[]>} target mutated in place
 * @param {number} week 1-based
 * @param {any[]} rows raw Sleeper projection rows
 * @param {{ allowedIds?: Set<string>|null }} [options]
 * @returns {{ kept: number, skippedPosition: number, skippedUnknown: number, skippedEmpty: number }}
 */
export function accumulateStatWeek(target, week, rows, options = {}) {
  const { allowedIds = null } = options;
  let kept = 0;
  let skippedPosition = 0;
  let skippedUnknown = 0;
  let skippedEmpty = 0;

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
    const pairs = statPairs(row.stats);
    if (!pairs) {
      skippedEmpty += 1;
      continue;
    }
    let weeks = target.get(id);
    if (!weeks) {
      weeks = new Array(SEASON_WEEKS).fill(null);
      target.set(id, weeks);
    }
    weeks[week - 1] = pairs;
    kept += 1;
  }
  return { kept, skippedPosition, skippedUnknown, skippedEmpty };
}

/**
 * Wrap an accumulator into data/projections.json v2 shape. Players with no projected
 * week at all are dropped. Determinism: players ascend by id (numeric-aware), the stat
 * vocabulary grows by first appearance in that same walk, and each week entry lists its
 * stats alphabetically — so a rerun on identical input is byte-identical, and a new stat
 * key appends to `keys` instead of renumbering the file.
 * @param {Map<string, ([string, number][]|null)[]>} accumulated
 * @param {{ season: string|number, generatedAt: string, weeks?: number[] }} meta
 * @returns {{ generated_at: string, season: string, version: number, weeks: number[],
 *   keys: string[], players: Record<string, (number[]|0)[]> }}
 */
export function finalizeProjections(accumulated, meta) {
  const weeks = meta.weeks ?? Array.from({ length: SEASON_WEEKS }, (_, i) => i + 1);
  /** @type {string[]} */
  const keys = [];
  /** @type {Map<string, number>} */
  const keyIndex = new Map();
  /** @type {Record<string, (number[]|0)[]>} */
  const players = {};

  const ids = [...accumulated.keys()]
    .filter((id) => (accumulated.get(id) ?? []).some((week) => week && week.length > 0))
    .sort(compareIds);

  for (const id of ids) {
    players[id] = (accumulated.get(id) ?? []).map((pairs) => {
      if (!pairs || pairs.length === 0) return 0;
      /** @type {number[]} */
      const flat = [];
      for (const [key, value] of pairs) {
        let index = keyIndex.get(key);
        if (index === undefined) {
          index = keys.length;
          keys.push(key);
          keyIndex.set(key, index);
        }
        flat.push(index, value);
      }
      return flat;
    });
  }

  return {
    generated_at: meta.generatedAt,
    season: String(meta.season),
    version: PROJECTIONS_VERSION,
    weeks,
    keys,
    players,
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
 * data/players.json (v2.1): the six fantasy positions, active and on a team.
 * Team defenses are always kept — their id is the team code.
 * Key order is fixed here, not sorted, so a rerun on identical input is byte-identical.
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
      inj: textOrNull(raw.injury_status),
      injPart: textOrNull(raw.injury_body_part),
      injNotes: textOrNull(raw.injury_notes),
      newsAt: numOrNull(raw.news_updated),
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
 * Median of a numeric array.
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
 * with POLITE_DELAY_MS between them. No league is involved.
 * @param {{ season: string, generatedAt: string, log?: (message: string) => void }} options
 * @returns {Promise<{ players: any, projections: any, schedule: any,
 *   teamNameIndex: Map<string, string>, stats: Record<string, any> }>}
 */
export async function collectSleeper(options) {
  const { season, generatedAt, log = () => {} } = options;

  const rawGames = await fetchScheduleRaw(season);
  const schedule = buildSchedule(rawGames, { season, generatedAt });
  log(`schedule: ${schedule.games.length} games, ${Object.keys(schedule.byes).length} byes`);
  await sleep(POLITE_DELAY_MS);

  const rawPlayers = await fetchPlayersRaw();
  const players = buildPlayers(rawPlayers, schedule.byes, { generatedAt });
  log(`players: ${players.count} of ${Object.keys(rawPlayers).length} raw entries`);
  await sleep(POLITE_DELAY_MS);

  const allowedIds = new Set(Object.keys(players.players));
  /** @type {Map<string, ([string, number][]|null)[]>} */
  const accumulated = new Map();
  let unfilteredWeeks = 0;
  let skippedUnknown = 0;
  let weekEntries = 0;

  for (let week = 1; week <= SEASON_WEEKS; week += 1) {
    const { rows, filtered } = await fetchProjectionsWeek(season, week);
    if (!filtered) unfilteredWeeks += 1;
    const result = accumulateStatWeek(accumulated, week, rows, { allowedIds });
    skippedUnknown += result.skippedUnknown;
    weekEntries += result.kept;
    if (week < SEASON_WEEKS) await sleep(POLITE_DELAY_MS);
  }

  const projections = finalizeProjections(accumulated, { season, generatedAt });
  log(
    `projections: ${Object.keys(projections.players).length} players, ${projections.keys.length} stat keys, ` +
      `${weekEntries} week entries over ${SEASON_WEEKS} weeks`,
  );

  const teamNameIndex = buildTeamNameIndex(rawPlayers);

  return {
    players,
    projections,
    schedule,
    teamNameIndex,
    stats: {
      rawPlayerCount: Object.keys(rawPlayers).length,
      unfilteredWeeks,
      skippedUnknownProjectionRows: skippedUnknown,
      weekEntries,
      statKeys: projections.keys.length,
      byes: orderedByKey(schedule.byes),
    },
  };
}

// ── Season history (data/history.json v1, design §13.6 F1) ───────────────────────────────────
//
// Endpoints (verified live 2026-09-17):
//   /v1/stats/nfl/regular/{season}           season totals, ~8,200 rows: gp, gms_active, pts_std, rec
//   /v1/stats/nfl/regular/{season}/{week}    one week, same row shape, gp === 1 when the player played
//
// Both are cache-busted. The file exists so the risk model can measure what a player ACTUALLY did
// (durability, weekly variance) — it is not a scoring source: only `pts_std` and `rec` are kept, so
// half-PPR = std + 0.5*rec and PPR = std + rec. Other reception bonuses (bonus_rec_te, rec_40p, …)
// are deliberately ignored; league-exact points are projections.json v2's job (§10.1).

/** Schema version stamped into data/history.json (design §13.6 F1). */
export const HISTORY_VERSION = 1;

/** Decimals kept on a weekly point total — one is plenty for a CV / floor-ceiling model. */
export const HISTORY_DECIMALS = 1;

/** Which raw Sleeper keys the two numbers of a `w` cell come from. Shipped inside the file. */
export const HISTORY_SCORING = Object.freeze({ std: "pts_std", rec: "rec" });

/**
 * @typedef {{ gp: number, ga: number|null, w: ([number, number]|null)[] }} HistoryPlayer
 * @typedef {{ weeks: number, players: Record<string, HistoryPlayer> }} HistorySeason
 * @typedef {{ version: number, generated_at: string, scoring: { std: string, rec: string },
 *   seasons: Record<string, HistorySeason> }} History
 */

/**
 * Season totals for every NFL player. Dict of player_id -> row (DEF rows are keyed by team code).
 * @param {string|number} season
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchSeasonStats(season) {
  const url = `${SLEEPER_API}/v1/stats/nfl/regular/${season}`;
  const raw = await fetchJson(url, { cacheBust: true });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`unexpected season stats payload from ${url}`);
  }
  return /** @type {Record<string, any>} */ (raw);
}

/**
 * One week of actuals, same row shape as the season totals. A week that has not been played yet
 * answers `{}` — that is data, not an error, and becomes a column of nulls.
 * @param {string|number} season
 * @param {number} week
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchWeekStats(season, week) {
  const url = `${SLEEPER_API}/v1/stats/nfl/regular/${season}/${week}`;
  const raw = await fetchJson(url, { cacheBust: true });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`unexpected week stats payload from ${url}`);
  }
  return /** @type {Record<string, any>} */ (raw);
}

/**
 * One `w` cell from a raw weekly row: `[pts_std, rec]` when the player was active that week,
 * else null. `gp === 1` is the activity test — a player who dressed but recorded nothing carries
 * no `pts_std` key at all and must still read as ACTIVE with 0 points (that zero is exactly the
 * kind of week a variance model has to see), so a missing number becomes 0.
 * @param {unknown} row
 * @returns {[number, number]|null}
 */
export function historyCell(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const played = numOrNull(/** @type {any} */ (row).gp);
  if (played !== 1) return null;
  return [
    round(numOrNull(/** @type {any} */ (row).pts_std) ?? 0, HISTORY_DECIMALS),
    round(numOrNull(/** @type {any} */ (row).rec) ?? 0, HISTORY_DECIMALS),
  ];
}

/**
 * Fold one season's raw payloads into a `seasons[<year>]` entry. Players with no active week at
 * all are dropped (a 2026 rookie has no 2025 row to ship). `gp`/`ga` come from the season totals,
 * the only place `gms_active` exists; a DEF row carries no `gms_active`, so its `ga` is null.
 * @param {{ totals?: Record<string, any>|null, weekly?: (Record<string, any>|null)[],
 *   allowedIds?: Iterable<string>|null }} input `weekly[0]` is week 1
 * @returns {HistorySeason}
 */
export function buildHistorySeason(input) {
  const { totals = {}, weekly = [], allowedIds = null } = input;
  const ids = allowedIds
    ? [...new Set(allowedIds)]
    : [...new Set(weekly.flatMap((rows) => (rows ? Object.keys(rows) : [])))];
  /** @type {Record<string, HistoryPlayer>} */
  const players = {};
  for (const id of ids.sort(compareIds)) {
    const w = weekly.map((rows) => historyCell(rows?.[id]));
    if (!w.some((cell) => cell !== null)) continue;
    const row = totals?.[id] ?? {};
    players[id] = {
      gp: numOrNull(row.gp) ?? w.filter((cell) => cell !== null).length,
      ga: numOrNull(row.gms_active),
      w,
    };
  }
  return { weeks: weekly.length, players };
}

/**
 * Wrap season entries into the data/history.json v1 envelope.
 * @param {{ seasons: Record<string, HistorySeason>, generatedAt: string }} input
 * @returns {History}
 */
export function finalizeHistory(input) {
  const { seasons, generatedAt } = input;
  return {
    version: HISTORY_VERSION,
    generated_at: generatedAt,
    scoring: { ...HISTORY_SCORING },
    seasons: orderedByKey(seasons),
  };
}

/**
 * Which seasons the file covers and how many weeks of each: last season complete, this season up
 * to the week before the current one (week N is still being played, so its rows are partial and
 * its endpoint answers `{}` until the games are in).
 * @param {{ season: string|number, week: number }} input `week` as data/meta.json reports it
 * @returns {{ season: string, weeks: number }[]}
 */
export function historySeasonPlan(input) {
  const current = Number(input.season);
  const week = Math.max(1, Number(input.week) || 1);
  const played = Math.min(SEASON_WEEKS, Math.max(0, week - 1));
  return [
    { season: String(current - 1), weeks: SEASON_WEEKS },
    { season: String(current), weeks: played },
  ];
}

/**
 * Every player id on a league's rosters, in any list. Rostered players must keep their history
 * even when they fall out of data/players.json (Sleeper flips a released or long-term-injured
 * player to `active: false`, which is exactly the player a buy-low trade is about).
 * @param {unknown} rosters raw Sleeper `/league/{id}/rosters` payload
 * @returns {string[]}
 */
export function rosterPlayerIds(rosters) {
  if (!Array.isArray(rosters)) return [];
  /** @type {Set<string>} */
  const ids = new Set();
  for (const roster of rosters) {
    for (const list of [roster?.players, roster?.reserve, roster?.taxi, roster?.starters]) {
      if (!Array.isArray(list)) continue;
      for (const id of list) if (typeof id === "string" && id !== "" && id !== "0") ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Fetch and transform every season in the plan. Sequential with POLITE_DELAY_MS between calls
 * (~20 requests, ~10 s). A season that fails is recorded in `errors` and left out of `seasons`,
 * so the last-good guard can carry the previous run's copy forward instead of shipping a hole.
 * @param {{ season: string|number, week: number, allowedIds: Iterable<string>,
 *   generatedAt: string, log?: (message: string) => void, delayMs?: number }} options
 *   `delayMs` exists so the tests do not sit through 20 polite pauses; the pipeline never sets it.
 * @returns {Promise<{ history: History, errors: Record<string, string>,
 *   stats: Record<string, { weeks: number, players: number }> }>}
 */
export async function collectHistory(options) {
  const { season, week, allowedIds, generatedAt, log = () => {}, delayMs = POLITE_DELAY_MS } = options;
  const allowed = new Set(allowedIds);
  /** @type {Record<string, HistorySeason>} */
  const seasons = {};
  /** @type {Record<string, string>} */
  const errors = {};
  /** @type {Record<string, { weeks: number, players: number }>} */
  const stats = {};

  for (const plan of historySeasonPlan({ season, week })) {
    if (plan.weeks === 0) {
      seasons[plan.season] = { weeks: 0, players: {} };
      stats[plan.season] = { weeks: 0, players: 0 };
      log(`history: ${plan.season} has no completed week yet`);
      continue;
    }
    try {
      const totals = await fetchSeasonStats(plan.season);
      await sleep(delayMs);
      /** @type {Record<string, any>[]} */
      const weekly = [];
      for (let w = 1; w <= plan.weeks; w += 1) {
        weekly.push(await fetchWeekStats(plan.season, w));
        await sleep(delayMs);
      }
      const built = buildHistorySeason({ totals, weekly, allowedIds: allowed });
      seasons[plan.season] = built;
      stats[plan.season] = { weeks: built.weeks, players: Object.keys(built.players).length };
      log(`history: ${plan.season} ${Object.keys(built.players).length} players over ${built.weeks} week(s)`);
    } catch (error) {
      errors[plan.season] = error.message;
    }
  }

  return { history: finalizeHistory({ seasons, generatedAt }), errors, stats };
}
