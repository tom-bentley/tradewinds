// Last-good guard for data/values.json.
//
// A value source that failed, or came back suspiciously short, must never overwrite a good table
// (design.md §3). We keep the previous table verbatim — same rows, same `fetched_at` — and only
// flip `ok` to false and attach an `error`, so the browser can show how stale the numbers are.

import { readJsonIfExists } from "./util.mjs";

/** Row-count sanity floors per source id (design.md §3). */
export const ROW_FLOORS = Object.freeze({
  fc_redraft: 150,
  fc_dynasty: 300,
  dp_dynasty: 300,
  bc_tiers: 100,
});

/**
 * @typedef {{ label: string, kind: string, fetched_at: string, ok: boolean, count: number,
 *   url: string, values: Record<string, Record<string, number>>, error?: string }} ValueTable
 */

/**
 * @param {string} file path to the existing data/values.json
 * @returns {Record<string, ValueTable>} previous source tables, {} when absent/unreadable
 */
export function loadPreviousValueSources(file) {
  const previous = readJsonIfExists(file);
  const sources = previous && typeof previous === "object" ? previous.sources : null;
  return sources && typeof sources === "object" && !Array.isArray(sources) ? sources : {};
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
