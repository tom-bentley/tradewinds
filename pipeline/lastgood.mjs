// Last-good guard for data/values.json.
//
// A value source that failed, or came back suspiciously short, must never overwrite a good table
// (design.md §3). We keep the previous table verbatim — same rows, same `fetched_at` — and only
// flip `ok` to false and attach an `error`, so the browser can show how stale the numbers are.

import { readJsonIfExists } from "./util.mjs";

/** Row-count sanity floors per source id (design.md §3, extended to the §10.2 variants). */
export const ROW_FLOORS = Object.freeze({
  bc_tiers_half: 100,
  bc_tiers_ppr: 100,
  bc_tiers_std: 100,
  dp_dynasty: 300,
  dp_dynasty_2qb: 300,
  fc_dynasty: 300,
  fc_dynasty_2qb: 300,
  fc_redraft: 150,
  fc_redraft_2qb: 150,
});

/**
 * @typedef {{ label: string, kind: string, variant?: Record<string, number>, fetched_at: string,
 *   ok: boolean, count: number, url: string,
 *   values: Record<string, Record<string, number>>, error?: string }} ValueTable
 */

/**
 * @param {string} file path to the existing data/values.json
 * @param {{ keep?: Iterable<string>|null }} [options] when given, only these source ids are
 *   considered — a table id the pipeline no longer publishes (e.g. the pre-§10.2 `bc_tiers`)
 *   must not be carried forward forever.
 * @returns {Record<string, ValueTable>} previous source tables, {} when absent/unreadable
 */
export function loadPreviousValueSources(file, options = {}) {
  const previous = readJsonIfExists(file);
  const sources = previous && typeof previous === "object" ? previous.sources : null;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return {};
  const keep = options.keep ? new Set(options.keep) : null;
  if (!keep) return sources;
  /** @type {Record<string, ValueTable>} */
  const filtered = {};
  for (const [id, table] of Object.entries(sources)) if (keep.has(id)) filtered[id] = table;
  return filtered;
}

/**
 * Number of rows a table actually carries (never trust its own `count`).
 * @param {ValueTable|null|undefined} table
 * @returns {number}
 */
export function rowCount(table) {
  const values = table?.values;
  return values && typeof values === "object" ? Object.keys(values).length : 0;
}

/**
 * Decide the published table for one source.
 * @param {{ id: string, next?: ValueTable|null, error?: string|null,
 *   previous?: ValueTable|null, floor: number }} input
 * @returns {{ table: ValueTable|null, kept: boolean, note: string|null }}
 */
export function resolveSource(input) {
  const { id, next = null, error = null, previous = null, floor } = input;
  const nextRows = rowCount(next);
  const failureReason =
    error !== null && error !== undefined
      ? error
      : !next
        ? "source produced no table"
        : nextRows < floor
          ? `row count ${nextRows} below floor ${floor}`
          : null;

  if (failureReason === null) {
    return { table: /** @type {ValueTable} */ (next), kept: false, note: null };
  }
  if (previous && rowCount(previous) > 0) {
    return {
      table: { ...previous, ok: false, error: failureReason },
      kept: true,
      note: `${id}: kept last good table (${rowCount(previous)} rows from ${previous.fetched_at}) — ${failureReason}`,
    };
  }
  if (next) {
    return {
      table: { ...next, ok: false, error: failureReason },
      kept: false,
      note: `${id}: ${failureReason}; no previous table to fall back on`,
    };
  }
  return { table: null, kept: false, note: `${id}: ${failureReason}; no previous table to fall back on` };
}

/**
 * Apply the last-good guard across every attempted source.
 * @param {{ attempts: Record<string, { table?: ValueTable|null, error?: string|null }>,
 *   previous?: Record<string, ValueTable>, floors?: Record<string, number> }} input
 * @returns {{ sources: Record<string, ValueTable>, notes: string[],
 *   kept: string[], failed: string[] }}
 */
export function applyLastGood(input) {
  const { attempts, previous = {}, floors = ROW_FLOORS } = input;
  /** @type {Record<string, ValueTable>} */
  const sources = {};
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const failed = [];

  for (const id of Object.keys(attempts).sort()) {
    const attempt = attempts[id] ?? {};
    const resolved = resolveSource({
      id,
      next: attempt.table ?? null,
      error: attempt.error ?? null,
      previous: previous[id] ?? null,
      floor: floors[id] ?? 0,
    });
    if (resolved.note) notes.push(resolved.note);
    if (resolved.kept) kept.push(id);
    if (resolved.table && resolved.table.ok === false) failed.push(id);
    if (resolved.table) sources[id] = resolved.table;
  }

  // Carry forward any previously published source we did not attempt this run.
  for (const id of Object.keys(previous).sort()) {
    if (sources[id]) continue;
    sources[id] = { ...previous[id], ok: false, error: "source not attempted in this run" };
    kept.push(id);
    notes.push(`${id}: not attempted this run; kept last good table`);
  }

  return { sources, notes, kept, failed };
}

// ── data/history.json (design §13.6 F1) ──────────────────────────────────────────────────────
//
// Same rule as the value tables, one level down: the guard works PER SEASON, because the two
// seasons come from independent fetches and a Sleeper hiccup on last season must not blank out
// this season's actuals (or the other way round). A season that fails, or that comes back
// suspiciously short, keeps the copy the previous run committed; the failure is reported through
// data/meta.json `sources.history`, so the file itself always matches the v1 contract exactly.

/**
 * Player-row floors for one season of data/history.json. A complete 2025 measured 591 rows and a
 * single 2026 week measured 481, so 150 flags a broken transform without ever false-failing a
 * quiet week. A season with no completed week legitimately carries no rows at all.
 */
export const HISTORY_FLOORS = Object.freeze({ played: 150, unplayed: 0 });

/**
 * @typedef {{ weeks: number, players: Record<string, unknown> }} HistorySeason
 * @typedef {{ version: number, generated_at: string, scoring: Record<string, string>,
 *   seasons: Record<string, HistorySeason> }} History
 */

/**
 * Rows a season actually carries.
 * @param {HistorySeason|null|undefined} season
 * @returns {number}
 */
export function historyPlayerCount(season) {
  const players = season?.players;
  return players && typeof players === "object" && !Array.isArray(players) ? Object.keys(players).length : 0;
}

/**
 * The row floor a season has to clear.
 * @param {number} weeks
 * @param {{ played?: number, unplayed?: number }} [floors]
 * @returns {number}
 */
export function historySeasonFloor(weeks, floors = HISTORY_FLOORS) {
  return Number(weeks) > 0 ? (floors.played ?? 0) : (floors.unplayed ?? 0);
}

/**
 * @param {unknown} value
 * @returns {value is History}
 */
function isHistory(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !!(/** @type {any} */ (value).seasons) &&
    typeof (/** @type {any} */ (value).seasons) === "object" &&
    !Array.isArray(/** @type {any} */ (value).seasons)
  );
}

/**
 * @param {string} file path to the existing data/history.json
 * @returns {History|null} the previous file, or null when absent/unreadable/not a history file
 */
export function loadPreviousHistory(file) {
  const previous = readJsonIfExists(file);
  return isHistory(previous) ? previous : null;
}

/**
 * Apply the last-good guard, season by season.
 * @param {{ next?: History|null, errors?: Record<string, string>, previous?: History|null,
 *   floors?: { played?: number, unplayed?: number } }} input `errors` is keyed by season, as
 *   `collectHistory` reports them.
 * @returns {{ history: History|null, kept: string[], failed: string[], notes: string[] }}
 */
export function resolveHistory(input) {
  const { next = null, errors = {}, previous = null, floors = HISTORY_FLOORS } = input;
  const nextSeasons = isHistory(next) ? next.seasons : {};
  const previousSeasons = isHistory(previous) ? previous.seasons : {};
  /** @type {Record<string, HistorySeason>} */
  const seasons = {};
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const failed = [];
  /** @type {string[]} */
  const notes = [];

  const years = [...new Set([...Object.keys(nextSeasons), ...Object.keys(previousSeasons), ...Object.keys(errors)])];
  for (const year of years.sort()) {
    const candidate = nextSeasons[year] ?? null;
    const rows = historyPlayerCount(candidate);
    const floor = historySeasonFloor(candidate?.weeks ?? 0, floors);
    const reason =
      errors[year] ??
      (!candidate ? "season not fetched" : rows < floor ? `player count ${rows} below floor ${floor}` : null);

    if (reason === null) {
      seasons[year] = /** @type {HistorySeason} */ (candidate);
      continue;
    }
    failed.push(year);
    const fallback = previousSeasons[year];
    if (fallback && historyPlayerCount(fallback) > 0) {
      seasons[year] = fallback;
      kept.push(year);
      notes.push(
        `history ${year}: kept last good season (${historyPlayerCount(fallback)} players over ` +
          `${fallback.weeks} week(s)) — ${reason}`,
      );
      continue;
    }
    if (candidate) seasons[year] = candidate;
    notes.push(`history ${year}: ${reason}; no previous season to fall back on`);
  }

  const envelope = isHistory(next) ? next : isHistory(previous) ? previous : null;
  if (!envelope) return { history: null, kept, failed, notes };
  return { history: { ...envelope, seasons }, kept, failed, notes };
}

// ── 004 player intelligence (design §2.1–§2.3) ─────────────────────────────────────────────────
//
// Third level of the same rule. data/stats.json, data/games.json and data/dvp.json are each built
// from a fan-out of per-week calls, so a half-successful run produces a file that is *valid* and
// *much smaller* than the one it would replace — the failure mode the value tables' row floors
// exist for, one step further out. Two guards, both from design §2.1:
//   * never overwrite a good file with an empty one, and
//   * keep the previous file when the new one loses more than 20 % of its rows.
// A file that has no previous copy is always published: the first run has to start somewhere.

/** Share of rows a rebuild may lose before the previous file is kept instead (design §2.1). */
export const LOSS_RATIO = 0.2;

/**
 * Rows a 004 file carries, by file name. Kept in one place so the guard, the log line and
 * meta.json all count the same thing.
 * @param {string} name "stats" | "games" | "dvp"
 * @param {any} file
 * @returns {number}
 */
export function optionalRowCount(name, file) {
  if (!file || typeof file !== "object") return 0;
  if (name === "games") return Array.isArray(file.games) ? file.games.length : 0;
  if (name === "dvp") return file.teams && typeof file.teams === "object" ? Object.keys(file.teams).length : 0;
  return file.players && typeof file.players === "object" ? Object.keys(file.players).length : 0;
}

/**
 * Apply the guard to one optional 004 file.
 * @param {{ name: string, next?: object|null, previous?: object|null, error?: string|null,
 *   lossRatio?: number }} input
 * @returns {{ file: object|null, kept: boolean, count: number, note: string|null }}
 *   `kept` means the previous file was published instead of the new one.
 */
export function resolveOptional(input) {
  const { name, next = null, previous = null, error = null } = input;
  const lossRatio = Number.isFinite(input.lossRatio) ? Number(input.lossRatio) : LOSS_RATIO;
  const nextCount = optionalRowCount(name, next);
  const previousCount = optionalRowCount(name, previous);

  if (nextCount === 0) {
    if (previousCount === 0) {
      return { file: null, kept: false, count: 0, note: error ? `${name}: ${error}` : null };
    }
    return {
      file: previous,
      kept: true,
      count: previousCount,
      note: `${name}: rebuilt empty${error ? ` (${error})` : ""} — kept the committed ${previousCount} row(s)`,
    };
  }
  if (previousCount > 0 && nextCount < previousCount * (1 - lossRatio)) {
    return {
      file: previous,
      kept: true,
      count: previousCount,
      note:
        `${name}: rebuilt with ${nextCount} row(s), down from ${previousCount} ` +
        `(> ${Math.round(lossRatio * 100)} % lost) — kept the committed file`,
    };
  }
  return { file: next, kept: false, count: nextCount, note: null };
}

/**
 * The previous copy of an optional 004 file, or null.
 * @param {string} file
 * @param {number} version the `version` the file must declare
 * @returns {object|null}
 */
export function loadPreviousOptional(file, version) {
  const previous = readJsonIfExists(file);
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return null;
  return Number(/** @type {any} */ (previous).version) === version ? previous : null;
}
