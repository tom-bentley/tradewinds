// Contract validators for the five files in data/ (design.md §3, projections and values per §10).
// Every validator returns an array of human-readable problems; empty means valid.
// refresh.mjs warns on problems; the tests assert on them.

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
    if (entry.lastNotifiedAt !== null && entry.lastNotifiedAt !== undefined) {
      checkTimestamp(problems, entry.lastNotifiedAt, `${label}.lastNotifiedAt`);
    }
    if (entry.expired !== undefined && entry.expired !== true) {
      problems.push(`${label}.expired, when present, must be true`);
    }
  }
  return problems;
}
