// Contract validators for the five files in data/ (design.md §3).
// Every validator returns an array of human-readable problems; empty means valid.
// refresh.mjs warns on problems; the tests assert on them.

/** Weeks in a projections array. */
export const EXPECTED_WEEKS = 18;

/** Positions a players.json row may declare. */
export const VALID_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** Value-table kinds the engine knows how to blend. */
export const VALID_VALUE_KINDS = new Set(["redraft", "dynasty", "tiers"]);

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
 * Validate data/projections.json.
 * @param {unknown} obj
 * @returns {string[]}
 */
export function validateProjections(obj) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(obj)) return ["projections: not an object"];
  checkTimestamp(problems, obj.generated_at, "projections.generated_at");
  if (typeof obj.season !== "string") problems.push("projections.season must be a string");
  if (typeof obj.scoring !== "string" || !obj.scoring.startsWith("league:")) {
    problems.push(`projections.scoring must be "league:<id>", got ${JSON.stringify(obj.scoring)}`);
  }
  if (!Array.isArray(obj.weeks) || obj.weeks.length !== EXPECTED_WEEKS) {
    problems.push(`projections.weeks must list ${EXPECTED_WEEKS} weeks`);
  }
  if (!isPlainObject(obj.players)) {
    problems.push("projections.players: not an object");
    return problems;
  }
  const entries = Object.entries(obj.players);
  if (entries.length < MIN_PROJECTION_PLAYERS) {
    problems.push(`projections: only ${entries.length} players (expected >= ${MIN_PROJECTION_PLAYERS})`);
  }
  for (const [id, weeks] of entries) {
    if (!Array.isArray(weeks) || weeks.length !== EXPECTED_WEEKS) {
      problems.push(`projections.players["${id}"] must be ${EXPECTED_WEEKS} numbers`);
      continue;
    }
    if (weeks.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      problems.push(`projections.players["${id}"] contains a non-finite value`);
      continue;
    }
    if (!weeks.some((value) => value !== 0)) {
      problems.push(`projections.players["${id}"] is all zero`);
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
  if (typeof obj.league_id !== "string" || obj.league_id === "") problems.push("meta.league_id is empty");
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

/**
 * Run every validator over a full pipeline output.
 * @param {{ players: unknown, projections: unknown, values: unknown, schedule: unknown,
 *   meta: unknown }} files
 * @returns {Record<string, string[]>} file name -> problems
 */
export function validateAll(files) {
  return {
    players: validatePlayers(files.players),
    projections: validateProjections(files.projections),
    values: validateValues(files.values),
    schedule: validateSchedule(files.schedule),
    meta: validateMeta(files.meta),
  };
}
