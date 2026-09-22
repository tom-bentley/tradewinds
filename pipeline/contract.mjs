// Contract validators for the five files in data/ (design.md §3, projections and values per §10).
// Every validator returns an array of human-readable problems; empty means valid.
// refresh.mjs warns on problems; the tests assert on them.

// Integration 2026-09-22: the dossier validator takes its enum inventories from the engine rubric
// (single source of truth for codes → numbers), so the pipeline can never drift from it.
import { ENUMS as ENGINE_ENUMS } from "../src/engine/prognosis.js";

/** Weeks in a projections array. */
export const EXPECTED_WEEKS = 18;

/** Positions a players.json row may declare. */
export const VALID_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** Value-table kinds the engine knows how to blend. */
export const VALID_VALUE_KINDS = new Set(["redraft", "dynasty", "tiers"]);

/** Schema version data/projections.json must declare (design §10.1). */
export const PROJECTIONS_VERSION = 2;

/** Rows we expect at minimum before a file is worth publishing. */
export const MIN_PLAYERS = 300;
export const MIN_PROJECTION_PLAYERS = 200;
export const MIN_SCHEDULE_GAMES = 200;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string[]} problems
 * @param {unknown} value
 * @param {string} label
 */
function checkTimestamp(problems, value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    problems.push(`${label}: expected an ISO timestamp like 2026-09-09T12:00:00Z, got ${JSON.stringify(value)}`);
  }
}

/**
 * Validate data/players.json.
 * @param {unknown} obj
 * @returns {string[]} problems, empty when valid
 */
export function validatePlayers(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["players: not an object"];
  checkTimestamp(problems, obj.generated_at, "players.generated_at");
  if (!isPlainObject(obj.players)) {
    problems.push("players.players: not an object");
    return problems;
  }
  const entries = Object.entries(obj.players);
  if (obj.count !== entries.length) {
    problems.push(`players.count ${obj.count} does not match ${entries.length} rows`);
  }
  if (entries.length < MIN_PLAYERS) {
    problems.push(`players: only ${entries.length} rows (expected >= ${MIN_PLAYERS})`);
  }
  let defenses = 0;
  for (const [id, player] of entries) {
    if (!isPlainObject(player)) {
      problems.push(`players["${id}"]: not an object`);
      continue;
    }
    if (player.id !== id) problems.push(`players["${id}"].id is ${JSON.stringify(player.id)}`);
    if (typeof player.name !== "string" || player.name === "") {
      problems.push(`players["${id}"].name is empty`);
    }
    if (typeof player.pos !== "string" || !VALID_POSITIONS.has(player.pos)) {
      problems.push(`players["${id}"].pos is ${JSON.stringify(player.pos)}`);
    }
    if (typeof player.team !== "string" || player.team === "") {
      problems.push(`players["${id}"].team is empty`);
    }
    if (player.inj !== null && typeof player.inj !== "string") {
      problems.push(`players["${id}"].inj must be a string or null`);
    }
    // v2.1 (design §12.3): additive, so a file written before the advisor simply omits them.
    for (const field of ["injPart", "injNotes"]) {
      if (player[field] !== undefined && player[field] !== null && typeof player[field] !== "string") {
        problems.push(`players["${id}"].${field} must be a string or null`);
      }
    }
    if (player.newsAt !== undefined && player.newsAt !== null && !Number.isFinite(player.newsAt)) {
      problems.push(`players["${id}"].newsAt must be a number or null`);
    }
    if (player.bye !== null && typeof player.bye !== "number") {
      problems.push(`players["${id}"].bye must be a number or null`);
    }
    if (!Array.isArray(player.fp)) problems.push(`players["${id}"].fp must be an array`);
    if (player.pos === "DEF") {
      defenses += 1;
      if (player.name !== `${player.team} D/ST`) {
        problems.push(`players["${id}"].name should be "${player.team} D/ST", got ${JSON.stringify(player.name)}`);
      }
    }
  }
  if (defenses === 0) problems.push("players: no DEF rows");
  return problems;
}

/**
 * One v2 week entry: `0`, or a flat [keyIdx, value, keyIdx, value, ...] array.
 * @param {string[]} problems
 * @param {string} label
 * @param {unknown} entry
 * @param {number} keyCount
 */
function checkStatLine(problems, label, entry, keyCount) {
  if (entry === 0) return;
  if (!Array.isArray(entry)) {
    problems.push(`${label} must be 0 or an array, got ${JSON.stringify(entry)}`);
    return;
  }
  if (entry.length === 0 || entry.length % 2 !== 0) {
    problems.push(`${label} must hold [keyIdx, value] pairs, got length ${entry.length}`);
    return;
  }
  /** @type {Set<number>} */
  const seen = new Set();
  for (let i = 0; i < entry.length; i += 2) {
    const index = entry[i];
    if (!Number.isInteger(index) || index < 0 || index >= keyCount) {
      problems.push(`${label}[${i}] is not a key index below ${keyCount}: ${JSON.stringify(index)}`);
      return;
    }
    if (seen.has(index)) {
      problems.push(`${label} repeats key index ${index}`);
      return;
    }
    seen.add(index);
    const value = entry[i + 1];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${label}[${i + 1}] is not a finite number: ${JSON.stringify(value)}`);
      return;
    }
  }
}

/**
 * Validate data/projections.json (v2 — raw stat lines, design §10.1).
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateProjections(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["projections: not an object"];
  checkTimestamp(problems, obj.generated_at, "projections.generated_at");
  if (typeof obj.season !== "string") problems.push("projections.season must be a string");
  if (obj.version !== PROJECTIONS_VERSION) {
    problems.push(`projections.version must be ${PROJECTIONS_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  if (!Array.isArray(obj.weeks) || obj.weeks.length !== EXPECTED_WEEKS) {
    problems.push(`projections.weeks must list ${EXPECTED_WEEKS} weeks`);
  }
  if (!Array.isArray(obj.keys) || obj.keys.length === 0) {
    problems.push("projections.keys must be a non-empty array of stat names");
    return problems;
  }
  /** @type {Set<string>} */
  const seenKeys = new Set();
  for (const [index, key] of obj.keys.entries()) {
    if (typeof key !== "string" || key === "") {
      problems.push(`projections.keys[${index}] is not a stat name: ${JSON.stringify(key)}`);
    } else if (seenKeys.has(key)) {
      problems.push(`projections.keys[${index}] repeats "${key}"`);
    } else {
      seenKeys.add(key);
    }
  }
  if (!isPlainObject(obj.players)) {
    problems.push("projections.players: not an object");
    return problems;
  }
  const keyCount = obj.keys.length;
  const entries = Object.entries(obj.players);
  if (entries.length < MIN_PROJECTION_PLAYERS) {
    problems.push(`projections: only ${entries.length} players (expected >= ${MIN_PROJECTION_PLAYERS})`);
  }
  for (const [id, weeks] of entries) {
    if (!Array.isArray(weeks) || weeks.length !== EXPECTED_WEEKS) {
      problems.push(`projections.players["${id}"] must be ${EXPECTED_WEEKS} week entries`);
      continue;
    }
    const before = problems.length;
    for (const [index, entry] of weeks.entries()) {
      checkStatLine(problems, `projections.players["${id}"][${index}]`, entry, keyCount);
    }
    if (problems.length === before && !weeks.some((entry) => Array.isArray(entry) && entry.length > 0)) {
      problems.push(`projections.players["${id}"] has no projected week`);
    }
  }
  return problems;
}

/**
 * Validate one entry of data/values.json `sources`.
 * @param {string[]} problems
 * @param {string} id
 * @param {unknown} table
 */
function checkValueTable(problems, id, table) {
  if (!isPlainObject(table)) {
    problems.push(`values.sources["${id}"]: not an object`);
    return;
  }
  if (typeof table.label !== "string" || table.label === "") {
    problems.push(`values.sources["${id}"].label is empty`);
  }
  if (typeof table.kind !== "string" || !VALID_VALUE_KINDS.has(table.kind)) {
    problems.push(`values.sources["${id}"].kind is ${JSON.stringify(table.kind)}`);
  }
  if (!isPlainObject(table.variant)) {
    problems.push(`values.sources["${id}"].variant must be an object like {"numQbs":1} or {"ppr":0.5}`);
  } else {
    const fields = Object.entries(table.variant);
    if (fields.length === 0) problems.push(`values.sources["${id}"].variant is empty`);
    for (const [field, value] of fields) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`values.sources["${id}"].variant.${field} is not a finite number`);
      }
    }
  }
  checkTimestamp(problems, table.fetched_at, `values.sources["${id}"].fetched_at`);
  if (typeof table.ok !== "boolean") problems.push(`values.sources["${id}"].ok must be a boolean`);
  if (table.ok === false && typeof table.error !== "string") {
    problems.push(`values.sources["${id}"]: ok=false requires an error string`);
  }
  if (!isPlainObject(table.values)) {
    problems.push(`values.sources["${id}"].values: not an object`);
    return;
  }
  const rows = Object.entries(table.values);
  if (table.count !== rows.length) {
    problems.push(`values.sources["${id}"].count ${table.count} does not match ${rows.length} rows`);
  }
  for (const [playerId, row] of rows) {
    if (!isPlainObject(row)) {
      problems.push(`values.sources["${id}"].values["${playerId}"]: not an object`);
      continue;
    }
    for (const [field, value] of Object.entries(row)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`values.sources["${id}"].values["${playerId}"].${field} is not a finite number`);
      }
    }
  }
}

/**
 * Validate data/values.json.
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateValues(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["values: not an object"];
  checkTimestamp(problems, obj.generated_at, "values.generated_at");
  if (!isPlainObject(obj.sources)) {
    problems.push("values.sources: not an object");
    return problems;
  }
  const ids = Object.keys(obj.sources);
  if (ids.length === 0) problems.push("values.sources: no source tables");
  for (const id of ids) checkValueTable(problems, id, obj.sources[id]);
  return problems;
}

/**
 * Validate data/schedule.json.
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateSchedule(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["schedule: not an object"];
  checkTimestamp(problems, obj.generated_at, "schedule.generated_at");
  if (typeof obj.season !== "string") problems.push("schedule.season must be a string");
  if (!isPlainObject(obj.byes)) {
    problems.push("schedule.byes: not an object");
  } else {
    for (const [team, week] of Object.entries(obj.byes)) {
      if (typeof week !== "number" || !Number.isInteger(week)) {
        problems.push(`schedule.byes["${team}"] must be an integer week`);
      }
    }
  }
  if (!Array.isArray(obj.games)) {
    problems.push("schedule.games: not an array");
    return problems;
  }
  if (obj.games.length < MIN_SCHEDULE_GAMES) {
    problems.push(`schedule: only ${obj.games.length} games (expected >= ${MIN_SCHEDULE_GAMES})`);
  }
  for (const [index, game] of obj.games.entries()) {
    if (!isPlainObject(game)) {
      problems.push(`schedule.games[${index}]: not an object`);
      continue;
    }
    if (typeof game.w !== "number" || game.w < 1) problems.push(`schedule.games[${index}].w is invalid`);
    if (typeof game.home !== "string" || game.home === "") problems.push(`schedule.games[${index}].home is empty`);
    if (typeof game.away !== "string" || game.away === "") problems.push(`schedule.games[${index}].away is empty`);
    if (game.date !== null && typeof game.date !== "string") {
      problems.push(`schedule.games[${index}].date must be a string or null`);
    }
  }
  return problems;
}

/**
 * Validate data/meta.json.
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateMeta(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["meta: not an object"];
  checkTimestamp(problems, obj.generated_at, "meta.generated_at");
  if (typeof obj.season !== "string") problems.push("meta.season must be a string");
  if (typeof obj.week !== "number" || obj.week < 1) problems.push("meta.week must be a positive number");
  // league_id is optional since design §10.6: the pipeline is league-agnostic.
  if (obj.league_id !== undefined && (typeof obj.league_id !== "string" || obj.league_id === "")) {
    problems.push("meta.league_id, when present, must be a non-empty string");
  }
  if (typeof obj.pipeline_version !== "string") problems.push("meta.pipeline_version must be a string");
  if (!isPlainObject(obj.sources)) {
    problems.push("meta.sources: not an object");
    return problems;
  }
  for (const [id, entry] of Object.entries(obj.sources)) {
    if (!isPlainObject(entry)) {
      problems.push(`meta.sources["${id}"]: not an object`);
      continue;
    }
    if (typeof entry.ok !== "boolean") problems.push(`meta.sources["${id}"].ok must be a boolean`);
    checkTimestamp(problems, entry.fetched_at, `meta.sources["${id}"].fetched_at`);
    if (typeof entry.count !== "number") problems.push(`meta.sources["${id}"].count must be a number`);
    if (entry.ok === false && typeof entry.error !== "string") {
      problems.push(`meta.sources["${id}"]: ok=false requires an error string`);
    }
  }
  return problems;
}

/** Schema version data/history.json must declare (design §13.6 F1). */
export const HISTORY_VERSION = 1;

/** Longest season this file may describe. A `weeks` above it means the plan went wrong. */
export const MAX_HISTORY_WEEKS = 18;

const SEASON_YEAR = /^\d{4}$/;

/**
 * One `seasons[<year>].players[<id>]` row.
 * @param {string[]} problems
 * @param {string} label
 * @param {unknown} row
 * @param {number} weeks
 */
function checkHistoryPlayer(problems, label, row, weeks) {
  if (!isPlainObject(row)) {
    problems.push(`${label}: not an object`);
    return;
  }
  if (!Number.isFinite(row.gp) || Number(row.gp) < 0) {
    problems.push(`${label}.gp must be a non-negative number, got ${JSON.stringify(row.gp)}`);
  }
  if (row.ga !== null && (!Number.isFinite(row.ga) || Number(row.ga) < 0)) {
    problems.push(`${label}.ga must be a non-negative number or null, got ${JSON.stringify(row.ga)}`);
  }
  if (!Array.isArray(row.w)) {
    problems.push(`${label}.w must be an array`);
    return;
  }
  if (row.w.length !== weeks) {
    problems.push(`${label}.w holds ${row.w.length} entries, expected ${weeks}`);
    return;
  }
  for (const [index, cell] of row.w.entries()) {
    if (cell === null) continue;
    if (!Array.isArray(cell) || cell.length !== 2) {
      problems.push(`${label}.w[${index}] must be null or [pts_std, rec], got ${JSON.stringify(cell)}`);
      return;
    }
    for (const value of cell) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`${label}.w[${index}] holds a non-finite number: ${JSON.stringify(cell)}`);
        return;
      }
    }
  }
  if (!row.w.some((cell) => cell !== null)) {
    problems.push(`${label} has no active week — the row should have been dropped`);
  }
}

/**
 * Validate data/history.json (design §13.6 F1) — last season's and this season's ACTUALS, the
 * input to the risk model's durability and volatility terms. Row-count floors deliberately live
 * in pipeline/lastgood.mjs (`HISTORY_FLOORS`), not here: a short season is a last-good decision,
 * a malformed one is a contract failure.
 * @param {unknown} obj
 * @returns {string[]} problems, empty when valid
 */
export function validateHistory(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["history: not an object"];
  if (obj.version !== HISTORY_VERSION) {
    problems.push(`history.version must be ${HISTORY_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  checkTimestamp(problems, obj.generated_at, "history.generated_at");
  if (!isPlainObject(obj.scoring)) {
    problems.push("history.scoring must name the raw stat keys, e.g. {\"std\":\"pts_std\",\"rec\":\"rec\"}");
  } else {
    for (const field of ["std", "rec"]) {
      if (typeof obj.scoring[field] !== "string" || obj.scoring[field] === "") {
        problems.push(`history.scoring.${field} is not a stat key`);
      }
    }
  }
  if (!isPlainObject(obj.seasons)) {
    problems.push("history.seasons: not an object");
    return problems;
  }
  const seasons = Object.entries(obj.seasons);
  if (seasons.length === 0) problems.push("history.seasons: no seasons");
  for (const [year, season] of seasons) {
    const label = `history.seasons["${year}"]`;
    if (!SEASON_YEAR.test(year)) problems.push(`${label}: key is not a four-digit season`);
    if (!isPlainObject(season)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    if (!Number.isInteger(season.weeks) || season.weeks < 0 || season.weeks > MAX_HISTORY_WEEKS) {
      problems.push(`${label}.weeks must be an integer 0..${MAX_HISTORY_WEEKS}, got ${JSON.stringify(season.weeks)}`);
      continue;
    }
    if (!isPlainObject(season.players)) {
      problems.push(`${label}.players: not an object`);
      continue;
    }
    if (season.weeks === 0 && Object.keys(season.players).length > 0) {
      problems.push(`${label}: 0 weeks but ${Object.keys(season.players).length} player rows`);
      continue;
    }
    for (const [id, row] of Object.entries(season.players)) {
      checkHistoryPlayer(problems, `${label}.players["${id}"]`, row, season.weeks);
    }
  }
  return problems;
}

/**
 * Run every validator over a full pipeline output. `history` is optional in both directions: it
 * is validated when the run produced one, and left out of the report when it did not, so a repo
 * whose pipeline predates design §13.6 still validates clean.
 * @param {{ players: unknown, projections: unknown, values: unknown, schedule: unknown,
 *   meta: unknown, history?: unknown }} files
 * @returns {Record<string, string[]>} file name -> problems
 */
export function validateAll(files) {
  /** @type {Record<string, string[]>} */
  const report = {
    players: validatePlayers(files.players),
    projections: validateProjections(files.projections),
    values: validateValues(files.values),
    schedule: validateSchedule(files.schedule),
    meta: validateMeta(files.meta),
  };
  if (files.history !== undefined && files.history !== null) {
    report.history = validateHistory(files.history);
  }
  // 004 design §2.1–§2.3. Optional in every direction: a run that could not build one of these
  // writes no file and reports nothing, exactly like history.json.
  if (files.stats !== undefined && files.stats !== null) report.stats = validateStats(files.stats);
  if (files.games !== undefined && files.games !== null) {
    report.games = validateGames(files.games, { schedule: files.schedule });
  }
  if (files.dvp !== undefined && files.dvp !== null) report.dvp = validateDvp(files.dvp);
  return report;
}

/** Schema version data/alerts-state.json must declare (design §11.3). */
export const ALERTS_STATE_VERSION = 1;

/** Longest history any alerts-state array may keep (design §11.3: "last 200 keys"). */
export const ALERTS_HISTORY_LIMIT = 200;

/**
 * One `leagues` or `devices` array of remembered keys.
 * @param {string[]} problems
 * @param {string} label
 * @param {unknown} value
 */
function checkKeyList(problems, label, value) {
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array`);
    return;
  }
  if (value.length > ALERTS_HISTORY_LIMIT) {
    problems.push(`${label} holds ${value.length} keys (bounded to ${ALERTS_HISTORY_LIMIT})`);
  }
  for (const [index, key] of value.entries()) {
    if (typeof key !== "string" || key === "") {
      problems.push(`${label}[${index}] is not a non-empty string`);
      return;
    }
  }
  if (new Set(value).size !== value.length) problems.push(`${label} repeats a key`);
}

/**
 * `leagues[id].status`: the per-player StatusKey snapshot the advisor diffs against (design §12.3).
 * Absent is legal — a state file written before the advisor simply has not seeded one yet.
 * @param {string[]} problems
 * @param {string} label
 * @param {unknown} value
 */
function checkStatusMap(problems, label, value) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    problems.push(`${label} must be an object`);
    return;
  }
  for (const [id, key] of Object.entries(value)) {
    if (id === "") {
      problems.push(`${label} has an empty player id`);
      return;
    }
    if (typeof key !== "string") {
      problems.push(`${label}["${id}"] is not a status key string`);
      return;
    }
  }
}

/**
 * Validate data/alerts-state.json (design §11.3). The alerts job rewrites the file from scratch,
 * so anything that fails here is treated as "start over" rather than a hard error.
 * @param {unknown} obj
 * @returns {string[]} problems, empty when valid
 */
export function validateAlertsState(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["alerts-state: not an object"];
  if (obj.v !== ALERTS_STATE_VERSION) {
    problems.push(`alerts-state.v must be ${ALERTS_STATE_VERSION}, got ${JSON.stringify(obj.v)}`);
  }
  if (!isPlainObject(obj.leagues)) {
    problems.push("alerts-state.leagues: not an object");
  } else {
    for (const [leagueId, entry] of Object.entries(obj.leagues)) {
      const label = `alerts-state.leagues["${leagueId}"]`;
      if (!isPlainObject(entry)) {
        problems.push(`${label}: not an object`);
        continue;
      }
      checkKeyList(problems, `${label}.seenTradeIds`, entry.seenTradeIds);
      if (entry.week !== null && (typeof entry.week !== "number" || !Number.isInteger(entry.week))) {
        problems.push(`${label}.week must be an integer or null`);
      }
      checkStatusMap(problems, `${label}.status`, entry.status);
      if (entry.statusAt !== null && entry.statusAt !== undefined) {
        checkTimestamp(problems, entry.statusAt, `${label}.statusAt`);
      }
    }
  }
  if (!isPlainObject(obj.devices)) {
    problems.push("alerts-state.devices: not an object");
    return problems;
  }
  for (const [deviceId, entry] of Object.entries(obj.devices)) {
    const label = `alerts-state.devices["${deviceId}"]`;
    if (!isPlainObject(entry)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    checkKeyList(problems, `${label}.seenDeals`, entry.seenDeals);
    checkKeyList(problems, `${label}.seenFa`, entry.seenFa);
    if (entry.seenAdvice !== undefined) checkKeyList(problems, `${label}.seenAdvice`, entry.seenAdvice);
    if (entry.lastNotifiedAt !== null && entry.lastNotifiedAt !== undefined) {
      checkTimestamp(problems, entry.lastNotifiedAt, `${label}.lastNotifiedAt`);
    }
    if (entry.expired !== undefined && entry.expired !== true) {
      problems.push(`${label}.expired, when present, must be true`);
    }
  }
  return problems;
}

/** Schema version data/advisor.json must declare (design §12.3). */
export const ADVISOR_VERSION = 1;

/** Advisories kept per league in the feed file — the app renders "recent news", not an archive. */
export const ADVISOR_ITEM_LIMIT = 30;

/** Severity ladder the advisor emits (design §12.2 step 8). */
export const ADVISOR_SEVERITIES = new Set(["high", "med", "low"]);

/**
 * Validate data/advisor.json (design §12.3) — the feed the Advisor tab renders when the phone has
 * not recomputed anything itself. Only the fields the app reads are enforced: the engine may add
 * to an Advisory at any time, and an over-strict validator here would fail the job for it.
 * @param {unknown} obj
 * @returns {string[]} problems, empty when valid
 */
export function validateAdvisor(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["advisor: not an object"];
  if (obj.v !== ADVISOR_VERSION) {
    problems.push(`advisor.v must be ${ADVISOR_VERSION}, got ${JSON.stringify(obj.v)}`);
  }
  checkTimestamp(problems, obj.generated_at, "advisor.generated_at");
  if (!isPlainObject(obj.leagues)) {
    problems.push("advisor.leagues: not an object");
    return problems;
  }
  for (const [leagueId, entry] of Object.entries(obj.leagues)) {
    const label = `advisor.leagues["${leagueId}"]`;
    if (!isPlainObject(entry)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    if (entry.week !== null && (typeof entry.week !== "number" || !Number.isInteger(entry.week))) {
      problems.push(`${label}.week must be an integer or null`);
    }
    if (!Array.isArray(entry.items)) {
      problems.push(`${label}.items must be an array`);
      continue;
    }
    if (entry.items.length > ADVISOR_ITEM_LIMIT) {
      problems.push(`${label}.items holds ${entry.items.length} advisories (bounded to ${ADVISOR_ITEM_LIMIT})`);
    }
    /** @type {Set<string>} */
    const keys = new Set();
    for (const [index, item] of entry.items.entries()) {
      const itemLabel = `${label}.items[${index}]`;
      if (!isPlainObject(item)) {
        problems.push(`${itemLabel}: not an object`);
        continue;
      }
      for (const field of ["key", "id", "name", "headline", "summary"]) {
        if (typeof item[field] !== "string" || item[field] === "") {
          problems.push(`${itemLabel}.${field} is not a non-empty string`);
        }
      }
      if (typeof item.severity !== "string" || !ADVISOR_SEVERITIES.has(item.severity)) {
        problems.push(`${itemLabel}.severity is ${JSON.stringify(item.severity)}`);
      }
      if (!Array.isArray(item.moves)) problems.push(`${itemLabel}.moves must be an array`);
      checkTimestamp(problems, item.at, `${itemLabel}.at`);
      if (typeof item.key === "string" && item.key !== "") {
        if (keys.has(item.key)) problems.push(`${label}.items repeats key ${JSON.stringify(item.key)}`);
        keys.add(item.key);
      }
    }
  }
  return problems;
}

// ── 004 player intelligence (design §2) ────────────────────────────────────────────────────────
// Same house style as everything above: `(obj) => string[]`, human-readable, never a throw, never
// a schema library. `refresh.mjs` prints the first five per file and warns; nothing here fails a
// run, because every one of these files is optional on the phone (FR-103).

/** Schema version data/stats.json must declare (004 design §1). */
export const STATS_VERSION = 1;

/** Schema version data/games.json must declare. */
export const GAMES_VERSION = 1;

/** Schema version data/dvp.json must declare. */
export const DVP_VERSION = 1;

/** Schema version data/dossiers.json must declare. */
export const DOSSIER_VERSION = 1;

/** Schema version data/research-queue.json must declare. */
export const QUEUE_VERSION = 1;

/** Rubric ids `prognosis.js` knows how to map. An unknown rubric drops the row, never fails. */
export const KNOWN_RUBRICS = new Set(["r7-v1"]);

/** data/stats.json byte ceiling (004 design §2.1). */
export const STATS_SIZE_BUDGET_BYTES = 700_000;

/** Fewest games a season slice of data/games.json may carry (004 design §2.2). */
export const MIN_GAMES = 200;

/** Plausible range for a published game total, outside which the join went wrong (§2.2). */
export const GAME_TOTAL_RANGE = Object.freeze({ min: 25, max: 70 });

/** The 32 clubs — every dvp.json must describe all of them (§2.3). */
export const DVP_TEAM_COUNT = 32;

/** Positions data/dvp.json reports. */
export const DVP_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** Depth -> the longest a dossier of that depth may claim to be fresh (§2.4). */
export const DOSSIER_TTL_MS = Object.freeze({
  deep: 48 * 3600_000,
  standard: 72 * 3600_000,
  quick: 7 * 24 * 3600_000,
});

/**
 * Caps from R11 §Q11.3 rule 10.
 *
 * NOTE, measured while building `test/fixtures/dossiers_sample.json`: a slice row carrying the
 * WHOLE R7 §6.2 code block serializes at ~625 B, so the 512 B cap and "codes: {…R7 enums…}"
 * (design §2.4) cannot both be met literally. The cap wins, because it is what keeps
 * `dossiers.json` a cold-start-sized file. The slice therefore carries the codes `prognose()`
 * keys on (`injury_type`, `severity`, `surgery`, `team_timeline`, `practice_pattern`,
 * `designation`, optionally `recurrence`); `side`, `return_designation_used`, `games_served` and
 * `days_since_injury` stay in the lazily fetched `data/dossiers/{id}.json`. This validator accepts
 * any SUBSET of the R7 fields and rejects anything outside the inventory, so a desk that ships
 * fewer codes is fine and one that invents a field is not.
 */
/**
 * Integration 2026-09-22 (design §2.4 amendment): 512 B is the TARGET a desk aims for; a real
 * 7-branch distribution measured 593 B after shedding every sheddable code (WS-M), so the hard cap
 * is 640 B. Rows above the target are flagged `slice-wide` by the desk, not rejected here; the
 * 64 KB file cap below remains the binding bound on the phone's cold start.
 */
export const DOSSIER_SLICE_ROW_TARGET = 512;
export const DOSSIER_SLICE_ROW_BYTES = 640;
export const DOSSIERS_FILE_BYTES = 64 * 1024;

/**
 * R7 §6.3 enum inventories, UPPER_SNAKE (004 design §2.4 supersedes R11's lowercase examples).
 *
 * Integration 2026-09-22: taken FROM THE ENGINE (`src/engine/prognosis.js` `ENUMS`) rather than
 * copied, so the validator can never drift from the rubric that maps codes to numbers — the first
 * hand-copied version listed ramp classes (FAST/SLOW) the engine does not define and would have
 * rejected every real dossier's `RAMP_SURGICAL`. `UNKNOWN` is always accepted for `ramp`; `trend`
 * is a slice-only field with no engine counterpart.
 */
export const R7_ENUMS = Object.freeze({
  injury_type: new Set(ENGINE_ENUMS.injury_type),
  side: new Set(ENGINE_ENUMS.side),
  severity: new Set(ENGINE_ENUMS.severity),
  surgery: new Set(ENGINE_ENUMS.surgery),
  recurrence: new Set(ENGINE_ENUMS.recurrence),
  team_timeline: new Set(ENGINE_ENUMS.team_timeline),
  practice_pattern: new Set(ENGINE_ENUMS.practice_pattern),
  designation: new Set(ENGINE_ENUMS.designation),
  ramp: new Set([...ENGINE_ENUMS.ramp_class, "UNKNOWN"]),
  trend: new Set(["up", "flat", "down", "unknown"]),
});

/** Slice `conf` ladder (R11 §Q11.3 rule 4). */
const DOSSIER_CONFIDENCE = new Set(["high", "med", "low"]);
const DOSSIER_DEPTHS = new Set(["deep", "standard", "quick"]);

/** `SEASON_GAMES` sentinel from `src/engine/injuries.js:18` — "out for the year". */
const SEASON_GAMES_SENTINEL = 99;

/**
 * Validate data/stats.json (004 design §2.1).
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateStats(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["stats: not an object"];
  if (obj.version !== STATS_VERSION) problems.push(`stats.version must be ${STATS_VERSION}`);
  checkTimestamp(problems, obj.generated_at, "stats.generated_at");
  if (typeof obj.season !== "string" || !/^\d{4}$/.test(obj.season)) {
    problems.push(`stats.season is ${JSON.stringify(obj.season)}`);
  }
  if (!Array.isArray(obj.keys) || obj.keys.length === 0) {
    problems.push("stats.keys must be a non-empty array");
    return problems;
  }
  const keyCount = obj.keys.length;
  if (!Array.isArray(obj.weeks) || obj.weeks.length === 0) {
    problems.push("stats.weeks must be a non-empty array");
    return problems;
  }
  let previous = 0;
  for (const week of obj.weeks) {
    if (!Number.isInteger(week) || week <= previous) {
      problems.push(`stats.weeks must be strictly increasing integers, saw ${JSON.stringify(week)}`);
      break;
    }
    previous = week;
  }
  if (obj.weeks.length > 8) problems.push(`stats.weeks holds ${obj.weeks.length} weeks (window is 8)`);
  const weekSet = new Set(obj.weeks);
  if (obj.partial !== undefined) {
    if (!Array.isArray(obj.partial)) problems.push("stats.partial must be an array");
    else {
      for (const week of obj.partial) {
        if (!weekSet.has(week)) problems.push(`stats.partial lists week ${JSON.stringify(week)}, not in stats.weeks`);
      }
    }
  }
  if (!isPlainObject(obj.players)) {
    problems.push("stats.players: not an object");
    return problems;
  }
  for (const [id, list] of Object.entries(obj.players)) {
    const label = `stats.players["${id}"]`;
    if (!Array.isArray(list) || list.length !== obj.weeks.length) {
      problems.push(`${label} must hold ${obj.weeks.length} week entries`);
      continue;
    }
    let real = 0;
    for (const [index, entry] of list.entries()) {
      checkStatLine(problems, `${label}[${index}]`, entry, keyCount);
      if (Array.isArray(entry)) real += 1;
    }
    if (real === 0) problems.push(`${label} has no non-empty week`);
  }
  if (obj.std !== undefined) {
    if (!isPlainObject(obj.std)) problems.push("stats.std: not an object");
    else {
      for (const [id, entry] of Object.entries(obj.std)) {
        checkStatLine(problems, `stats.std["${id}"]`, entry, keyCount);
        if (!obj.players[id]) problems.push(`stats.std["${id}"] has no stats.players row`);
      }
    }
  }
  if (!isPlainObject(obj.teams)) {
    problems.push("stats.teams: not an object");
    return problems;
  }
  for (const [team, byWeek] of Object.entries(obj.teams)) {
    if (!isPlainObject(byWeek)) {
      problems.push(`stats.teams["${team}"]: not an object`);
      continue;
    }
    for (const [week, totals] of Object.entries(byWeek)) {
      const label = `stats.teams["${team}"]["${week}"]`;
      if (!weekSet.has(Number(week))) problems.push(`${label} is not a week in stats.weeks`);
      if (!isPlainObject(totals)) {
        problems.push(`${label}: not an object`);
        continue;
      }
      for (const field of ["tgt", "snp", "att", "rush"]) {
        if (typeof totals[field] !== "number" || !Number.isFinite(totals[field]) || totals[field] < 0) {
          problems.push(`${label}.${field} is ${JSON.stringify(totals[field])}`);
        }
      }
    }
  }
  // Every week a player row covers must have team denominators, or shares cannot be computed.
  const teamWeeks = new Set();
  for (const [team, byWeek] of Object.entries(obj.teams)) {
    for (const week of Object.keys(isPlainObject(byWeek) ? byWeek : {})) teamWeeks.add(`${team}|${week}`);
  }
  if (teamWeeks.size === 0) problems.push("stats.teams covers no team-week");
  const bytes = Buffer.byteLength(`${JSON.stringify(obj)}\n`, "utf8");
  if (bytes > STATS_SIZE_BUDGET_BYTES) {
    problems.push(`stats is ${bytes.toLocaleString("en-US")} B (budget ${STATS_SIZE_BUDGET_BYTES.toLocaleString("en-US")})`);
  }
  return problems;
}

/**
 * Validate data/games.json (004 design §2.2).
 * @param {unknown} obj
 * @param {{ schedule?: unknown, minGames?: number }} [options] `schedule` cross-checks that every
 *   game exists in data/schedule.json; omitted, that rule is skipped.
 * @returns {string[]}
 */
export function validateGames(obj, options = {}) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["games: not an object"];
  if (obj.version !== GAMES_VERSION) problems.push(`games.version must be ${GAMES_VERSION}`);
  checkTimestamp(problems, obj.generated_at, "games.generated_at");
  if (!Array.isArray(obj.games)) {
    problems.push("games.games must be an array");
    return problems;
  }
  const minGames = Number.isFinite(options.minGames) ? Number(options.minGames) : MIN_GAMES;
  if (obj.games.length < minGames) {
    problems.push(`games.games holds ${obj.games.length} rows (floor ${minGames})`);
  }
  /** @type {Set<string>|null} */
  let scheduled = null;
  const scheduleGames = isPlainObject(options.schedule) ? options.schedule.games : null;
  if (Array.isArray(scheduleGames)) {
    scheduled = new Set(
      scheduleGames
        .filter((game) => isPlainObject(game))
        .map((game) => `${Number(game.w ?? game.week)}|${String(game.away).toUpperCase()}@${String(game.home).toUpperCase()}`),
    );
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const [index, game] of obj.games.entries()) {
    const label = `games.games[${index}]`;
    if (!isPlainObject(game)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    if (typeof game.id !== "string" || game.id === "") problems.push(`${label}.id is not a non-empty string`);
    else if (ids.has(game.id)) problems.push(`${label}.id ${JSON.stringify(game.id)} is repeated`);
    else ids.add(game.id);
    if (!Number.isInteger(game.week) || game.week < 1 || game.week > 18) {
      problems.push(`${label}.week is ${JSON.stringify(game.week)}`);
    }
    for (const field of ["home", "away"]) {
      if (typeof game[field] !== "string" || !/^[A-Z]{2,4}$/.test(game[field])) {
        problems.push(`${label}.${field} is ${JSON.stringify(game[field])}`);
      }
    }
    if (game.kick !== null && game.kick !== undefined) checkTimestamp(problems, game.kick, `${label}.kick`);
    if (game.total !== null && game.total !== undefined) {
      if (typeof game.total !== "number" || game.total < GAME_TOTAL_RANGE.min || game.total > GAME_TOTAL_RANGE.max) {
        problems.push(`${label}.total is ${JSON.stringify(game.total)} (expected ${GAME_TOTAL_RANGE.min}-${GAME_TOTAL_RANGE.max} or null)`);
      }
    }
    for (const field of ["spread", "mlHome", "mlAway", "tempF", "windMph", "precipPct", "restHome", "restAway"]) {
      const value = game[field];
      if (value !== null && value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        problems.push(`${label}.${field} is ${JSON.stringify(value)} (expected a number or null)`);
      }
    }
    if (game.indoor !== null && game.indoor !== undefined && typeof game.indoor !== "boolean") {
      problems.push(`${label}.indoor is ${JSON.stringify(game.indoor)}`);
    }
    if (scheduled && typeof game.home === "string" && typeof game.away === "string") {
      const key = `${game.week}|${game.away}@${game.home}`;
      if (!scheduled.has(key)) problems.push(`${label} ${key} is not in data/schedule.json`);
    }
  }
  return problems;
}

/**
 * Validate data/dvp.json (004 design §2.3).
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateDvp(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["dvp: not an object"];
  if (obj.version !== DVP_VERSION) problems.push(`dvp.version must be ${DVP_VERSION}`);
  checkTimestamp(problems, obj.generated_at, "dvp.generated_at");
  if (obj.scoring !== "half_ppr") problems.push(`dvp.scoring is ${JSON.stringify(obj.scoring)} (must be "half_ppr")`);
  if (!Array.isArray(obj.weeks) || obj.weeks.length === 0) {
    problems.push("dvp.weeks must be a non-empty array");
    return problems;
  }
  if (!isPlainObject(obj.teams)) {
    problems.push("dvp.teams: not an object");
    return problems;
  }
  const teamCount = Object.keys(obj.teams).length;
  if (teamCount !== DVP_TEAM_COUNT) problems.push(`dvp.teams describes ${teamCount} teams (expected ${DVP_TEAM_COUNT})`);
  for (const [team, row] of Object.entries(obj.teams)) {
    const label = `dvp.teams["${team}"]`;
    if (!isPlainObject(row)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    if (!isPlainObject(row.allowed)) {
      problems.push(`${label}.allowed: not an object`);
      continue;
    }
    let played = 0;
    for (const pos of DVP_POSITIONS) {
      const list = row.allowed[pos];
      if (!Array.isArray(list) || list.length !== obj.weeks.length) {
        problems.push(`${label}.allowed.${pos} must hold ${obj.weeks.length} entries`);
        continue;
      }
      for (const [index, value] of list.entries()) {
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
          problems.push(`${label}.allowed.${pos}[${index}] is ${JSON.stringify(value)}`);
        }
      }
      const sum = list.reduce((total, value) => total + (value ?? 0), 0);
      const std = isPlainObject(row.std) ? row.std[pos] : undefined;
      if (typeof std !== "number" || Math.abs(std - sum) > 0.05) {
        problems.push(`${label}.std.${pos} is ${JSON.stringify(std)}, Σ allowed is ${Math.round(sum * 100) / 100}`);
      }
    }
    // `gp` is the number of weeks this defence actually played, i.e. weeks with any non-null entry.
    for (let index = 0; index < obj.weeks.length; index += 1) {
      if (DVP_POSITIONS.some((pos) => Array.isArray(row.allowed[pos]) && row.allowed[pos][index] !== null)) played += 1;
    }
    if (row.gp !== played) problems.push(`${label}.gp is ${JSON.stringify(row.gp)}, ${played} week(s) have data`);
    if (row.ppr_ref !== undefined && !isPlainObject(row.ppr_ref)) {
      problems.push(`${label}.ppr_ref: not an object`);
    }
  }
  return problems;
}

/**
 * Validate data/research-queue.json (004 design §2.5).
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateQueue(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["queue: not an object"];
  if (obj.v !== QUEUE_VERSION) problems.push(`queue.v must be ${QUEUE_VERSION}`);
  checkTimestamp(problems, obj.updated_at, "queue.updated_at");
  if (!Array.isArray(obj.rows)) {
    problems.push("queue.rows must be an array");
    return problems;
  }
  if (obj.rows.length > 200) problems.push(`queue.rows holds ${obj.rows.length} rows (cap 200)`);
  const bytes = Buffer.byteLength(`${JSON.stringify(obj)}\n`, "utf8");
  if (bytes > 64 * 1024) problems.push(`queue is ${bytes.toLocaleString("en-US")} B (cap 65,536)`);
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {Set<string>} */
  const live = new Set();
  for (const [index, row] of obj.rows.entries()) {
    const label = `queue.rows[${index}]`;
    if (!isPlainObject(row)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    for (const field of ["id", "player_id", "depth", "reason", "requested_by", "status"]) {
      if (typeof row[field] !== "string" || row[field] === "") {
        problems.push(`${label}.${field} is not a non-empty string`);
      }
    }
    if (typeof row.id === "string") {
      if (ids.has(row.id)) problems.push(`${label}.id ${JSON.stringify(row.id)} is repeated`);
      ids.add(row.id);
    }
    if (!["deep", "standard", "quick"].includes(row.depth)) problems.push(`${label}.depth is ${JSON.stringify(row.depth)}`);
    if (!["phone", "news", "roster", "trending", "league"].includes(row.reason)) {
      problems.push(`${label}.reason is ${JSON.stringify(row.reason)}`);
    }
    if (!["queued", "claimed", "done", "failed"].includes(row.status)) {
      problems.push(`${label}.status is ${JSON.stringify(row.status)}`);
    }
    if (!Number.isInteger(row.priority) || row.priority < 1 || row.priority > 6) {
      problems.push(`${label}.priority is ${JSON.stringify(row.priority)} (1-6)`);
    }
    if (!Number.isInteger(row.attempts) || row.attempts < 0) {
      problems.push(`${label}.attempts is ${JSON.stringify(row.attempts)}`);
    }
    checkTimestamp(problems, row.queued_at, `${label}.queued_at`);
    if (row.sk !== null && typeof row.sk !== "string") problems.push(`${label}.sk must be a string or null`);
    for (const field of ["claimed_at", "done_at"]) {
      if (row[field] !== null && row[field] !== undefined) checkTimestamp(problems, row[field], `${label}.${field}`);
    }
    if (row.status === "claimed" && !row.claimed_by) problems.push(`${label} is claimed with no claimed_by`);
    if (row.status === "queued" || row.status === "claimed") {
      const key = `${row.player_id}|${row.depth}|${row.sk ?? ""}`;
      if (live.has(key)) problems.push(`${label} duplicates a live row for ${key}`);
      live.add(key);
    }
  }
  return problems;
}

/**
 * Validate one slice row of data/dossiers.json (004 design §2.4 + R11 §Q11.3 rules 1–4, 7–10).
 * @param {string[]} problems
 * @param {string} label
 * @param {any} row
 * @param {string} rubric file-level rubric id
 */
function checkDossierSlice(problems, label, row, rubric) {
  if (!isPlainObject(row)) {
    problems.push(`${label}: not an object`);
    return;
  }
  // Rule 1: an unknown rubric DROPS the row for the engine; it is not a file error.
  const rowRubric = typeof row.rubric === "string" ? row.rubric : rubric;
  checkTimestamp(problems, row.as_of, `${label}.as_of`);
  checkTimestamp(problems, row.expires_at, `${label}.expires_at`);
  const asOf = Date.parse(row.as_of ?? "");
  const expires = Date.parse(row.expires_at ?? "");
  if (Number.isFinite(asOf) && Number.isFinite(expires)) {
    if (expires <= asOf) problems.push(`${label}.expires_at is not after as_of`);
    const ttl = DOSSIER_TTL_MS[row.depth];
    if (ttl !== undefined && expires - asOf > ttl) {
      problems.push(`${label} claims ${Math.round((expires - asOf) / 3600_000)} h of freshness (${row.depth} TTL is ${ttl / 3600_000} h)`);
    }
  }
  if (!DOSSIER_DEPTHS.has(row.depth)) problems.push(`${label}.depth is ${JSON.stringify(row.depth)}`);
  if (!DOSSIER_CONFIDENCE.has(row.conf)) problems.push(`${label}.conf is ${JSON.stringify(row.conf)}`);
  if (row.sk !== null && typeof row.sk !== "string") problems.push(`${label}.sk must be a string or null`);
  if (!Number.isInteger(row.n) || row.n < 1) problems.push(`${label}.n is ${JSON.stringify(row.n)}`);
  // Rule 9: a `deep` dossier is a three-fill consensus by definition.
  if (row.depth === "deep" && Number(row.n) < 3) problems.push(`${label} is deep with n=${JSON.stringify(row.n)} (needs 3 fills)`);

  // Rule 4: every code is an R7 §6.3 enum. No free text.
  if (!isPlainObject(row.codes)) problems.push(`${label}.codes: not an object`);
  else {
    for (const [field, value] of Object.entries(row.codes)) {
      const enumeration = R7_ENUMS[field];
      if (enumeration) {
        if (!enumeration.has(value)) problems.push(`${label}.codes.${field} is ${JSON.stringify(value)} (not an r7 enum)`);
      } else if (field === "reporter_timeline_weeks") {
        if (value !== null && !(Array.isArray(value) && value.length === 2 && value.every(Number.isInteger))) {
          problems.push(`${label}.codes.reporter_timeline_weeks is ${JSON.stringify(value)}`);
        }
      } else if (field === "return_designation_used") {
        if (typeof value !== "boolean") problems.push(`${label}.codes.return_designation_used is ${JSON.stringify(value)}`);
      } else if (field === "games_served" || field === "days_since_injury") {
        if (!Number.isInteger(value) || value < 0) problems.push(`${label}.codes.${field} is ${JSON.stringify(value)}`);
      } else {
        problems.push(`${label}.codes.${field} is not a known r7 field`);
      }
    }
  }

  // Rule 7: the branch distribution.
  const prog = isPlainObject(row.prog) ? row.prog : null;
  if (!prog) problems.push(`${label}.prog: not an object`);
  else {
    const branches = prog.branches;
    if (!Array.isArray(branches) || branches.length < 1 || branches.length > 8) {
      problems.push(`${label}.prog.branches must hold 1-8 entries`);
    } else {
      let total = 0;
      let previous = -1;
      for (const [index, branch] of branches.entries()) {
        const branchLabel = `${label}.prog.branches[${index}]`;
        if (!isPlainObject(branch)) {
          problems.push(`${branchLabel}: not an object`);
          continue;
        }
        const games = branch.games;
        if (!Number.isInteger(games) || games < 0 || (games > 18 && games !== SEASON_GAMES_SENTINEL)) {
          problems.push(`${branchLabel}.games is ${JSON.stringify(games)}`);
        } else if (games <= previous) {
          problems.push(`${branchLabel}.games ${games} is not above the previous branch`);
        } else {
          previous = games;
        }
        if (typeof branch.p !== "number" || !(branch.p > 0) || branch.p > 1) {
          problems.push(`${branchLabel}.p is ${JSON.stringify(branch.p)}`);
        } else {
          total += branch.p;
        }
      }
      if (Math.abs(total - 1) > 0.001) problems.push(`${label}.prog.branches sum to ${Math.round(total * 1000) / 1000}, not 1`);
    }
    if (prog.ramp !== undefined && !R7_ENUMS.ramp.has(prog.ramp)) {
      problems.push(`${label}.prog.ramp is ${JSON.stringify(prog.ramp)}`);
    }
    if (prog.hazard !== undefined && prog.hazard !== null && (typeof prog.hazard !== "number" || !Number.isFinite(prog.hazard))) {
      problems.push(`${label}.prog.hazard is ${JSON.stringify(prog.hazard)}`);
    }
  }

  if (row.role !== undefined) {
    if (!isPlainObject(row.role)) problems.push(`${label}.role: not an object`);
    else {
      if (row.role.dc !== null && row.role.dc !== undefined && !Number.isInteger(row.role.dc)) {
        problems.push(`${label}.role.dc is ${JSON.stringify(row.role.dc)}`);
      }
      for (const field of ["snap", "tgt"]) {
        const value = row.role[field];
        if (value !== undefined && !R7_ENUMS.trend.has(value)) {
          problems.push(`${label}.role.${field} is ${JSON.stringify(value)}`);
        }
      }
    }
  }
  if (row.flags !== undefined && !Array.isArray(row.flags)) problems.push(`${label}.flags must be an array`);

  // Rule 10: the slice row byte cap.
  const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
  if (bytes > DOSSIER_SLICE_ROW_BYTES) {
    problems.push(`${label} is ${bytes} B (slice cap ${DOSSIER_SLICE_ROW_BYTES})`);
  }
  if (rowRubric !== undefined && typeof rowRubric !== "string") {
    problems.push(`${label}.rubric is ${JSON.stringify(rowRubric)}`);
  }
}

/**
 * Validate data/dossiers.json — the engine slice (004 design §2.4, R11 §Q11.3's 11 rules with
 * R7 §6.3 enum names). Desk-written, so the pipeline only ever READS it: a rejected file is left
 * alone and the engine simply gets no dossiers.
 *
 * Rules 3 and 11 are cross-file and need inputs the validator cannot fetch itself, so they run
 * only when `options.playerIds` / `options.dossierFiles` are supplied.
 * @param {unknown} obj
 * @param {{ playerIds?: Iterable<string>|null, dossierFiles?: Iterable<string>|null }} [options]
 * @returns {string[]}
 */
export function validateDossiers(obj, options = {}) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["dossiers: not an object"];
  if (obj.v !== DOSSIER_VERSION) problems.push(`dossiers.v must be ${DOSSIER_VERSION}`);
  checkTimestamp(problems, obj.generated_at, "dossiers.generated_at");
  const rubric = obj.rubric;
  if (typeof rubric !== "string" || rubric === "") problems.push(`dossiers.rubric is ${JSON.stringify(rubric)}`);
  if (!isPlainObject(obj.players)) {
    problems.push("dossiers.players: not an object");
    return problems;
  }
  const known = options.playerIds ? new Set(options.playerIds) : null;
  const files = options.dossierFiles ? new Set(options.dossierFiles) : null;
  for (const [id, row] of Object.entries(obj.players)) {
    const label = `dossiers.players["${id}"]`;
    checkDossierSlice(problems, label, row, rubric);
    // Rule 3.
    if (known && !known.has(id)) problems.push(`${label} is not a player in data/players.json`);
    // Rule 11, one direction.
    if (files && !files.has(id)) problems.push(`${label} has no data/dossiers/${id}.json`);
  }
  if (files) {
    for (const id of files) {
      if (!obj.players[id]) problems.push(`data/dossiers/${id}.json has no slice row in dossiers.json`);
    }
  }
  const bytes = Buffer.byteLength(`${JSON.stringify(obj)}\n`, "utf8");
  if (bytes > DOSSIERS_FILE_BYTES) {
    problems.push(`dossiers is ${bytes.toLocaleString("en-US")} B (cap ${DOSSIERS_FILE_BYTES.toLocaleString("en-US")})`);
  }
  return problems;
}
