#!/usr/bin/env node
// Tradewinds data pipeline entry point.
//
//   node pipeline/refresh.mjs
//
// Writes data/{players,projections,values,schedule,history,meta}.json.
// League-agnostic since design §10.6: nothing here reads a league. projections.json ships raw
// stat lines (v2) and values.json ships one table per league shape, so the phone can score any
// Sleeper league from the same committed files.
//
// Exit 0 when the Sleeper core (players + projections + schedule) succeeded, 1 when it did not.
// FantasyCalc / DynastyProcess / Boris Chen are optional: a failure there keeps the last good
// table and never fails the run.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PIPELINE_VERSION,
  compareIds,
  POLITE_DELAY_MS,
  formatSize,
  isoTimestamp,
  orderedByKey,
  readJsonIfExists,
  readTextIfExists,
  round,
  sleep,
  writeJsonFile,
  writeTextFile,
} from "./util.mjs";
import { validateAll } from "./contract.mjs";
import {
  HISTORY_FLOORS,
  ROW_FLOORS,
  applyLastGood,
  historyPlayerCount,
  loadPreviousHistory,
  loadPreviousOptional,
  loadPreviousValueSources,
  optionalRowCount,
  resolveHistory,
  resolveOptional,
} from "./lastgood.mjs";
import {
  buildNameIndex,
  collectHistory,
  collectSleeper,
  fetchState,
  rosterPlayerIds,
} from "./sources/sleeper.mjs";
import {
  DVP_VERSION,
  STATS_VERSION,
  collectStats,
} from "./sources/sleeper-stats.mjs";
import { GAMES_VERSION, collectGames } from "./sources/games.mjs";
import { FC_NUM_TEAMS, FC_PPR, FC_TABLES, fetchFantasyCalcTable } from "./sources/fantasycalc.mjs";
import { DP_TABLES, fetchDynastyProcessTables } from "./sources/dynastyprocess.mjs";
import { BC_FORMATS, fetchBorisChenTables } from "./sources/borischen.mjs";

/**
 * Total data/ budget; the run warns (does not fail) above it. Stat lines dominate it; raised from
 * 1.6 MB when data/history.json (design §13.6) joined the set, and from 1 800 000 to 2 500 000 for
 * 004 §2 (stats.json + dvp.json + games.json). Measured at the raise: the committed set was
 * 1 649 858 B, the three new files add 106 418 B and the job-written advisor/alerts/queue files
 * 76 043 B, for 1 832 319 B against the new budget. `test/pipeline.budget.test.mjs` sums every
 * committed data/** file, job-written ones included, and fails above this number.
 */
export const SIZE_BUDGET_BYTES = 2_500_000;

/**
 * data/values-history.csv alone (design §2.6). Warn only in 0.5.0: the monthly gzip roll-off is
 * deferred, so exceeding this is a prompt to implement it, not a failure.
 */
export const VALUES_HISTORY_SIZE_BUDGET_BYTES = 600_000;

/** The value table data/values-history.csv snapshots, one row per player per UTC day (§2.6). */
export const VALUES_HISTORY_TABLE = "fc_redraft";

/** Per-file budget for data/history.json alone (design §13.6 F1: "≤ 220 KB raw"). Warns only. */
const HISTORY_SIZE_BUDGET_BYTES = 220_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(REPO_ROOT, "data");

/**
 * The fixture league's roster snapshot. The pipeline is league-agnostic (design §10.6) so it
 * never fetches a league, yet history.json must not lose the one set of players the app is
 * certain to ask about: Sleeper flips a released or long-term-injured player to `active: false`,
 * which drops him out of data/players.json while he is still on somebody's roster (and is exactly
 * the player an IR buy-low trade is about). Absent or unreadable, this simply adds nothing.
 */
const ROSTER_SNAPSHOT_FILE = join(REPO_ROOT, "test", "fixtures", "rosters.json");

/**
 * Every value table this pipeline publishes -> its `variant` (design §10.2). Also the whitelist
 * of ids the last-good guard may carry forward, so a retired table id disappears on the next run.
 * @type {Readonly<Record<string, Record<string, number>>>}
 */
export const PUBLISHED_TABLES = Object.freeze({
  ...Object.fromEntries(FC_TABLES.map((spec) => [spec.id, { numQbs: spec.numQbs }])),
  ...Object.fromEntries(DP_TABLES.map((spec) => [spec.id, { numQbs: spec.numQbs }])),
  ...Object.fromEntries(BC_FORMATS.map((spec) => [spec.id, { ppr: spec.ppr }])),
});

/**
 * Only the contract fields reach data/values.json — diagnostics stay in meta/stdout.
 * @param {Record<string, any>} table
 * @returns {Record<string, any>}
 */
function toContractTable(table) {
  /** @type {Record<string, any>} */
  const out = {
    label: table.label,
    kind: table.kind,
    variant: table.variant,
    fetched_at: table.fetched_at,
    ok: table.ok,
    count: table.count,
    url: table.url,
  };
  if (table.license !== undefined) out.license = table.license;
  if (table.week !== undefined) out.week = table.week;
  if (table.error !== undefined) out.error = table.error;
  out.values = table.values;
  return out;
}

/**
 * Run one optional source, converting any throw into a recorded failure.
 * @template T
 * @param {string} id
 * @param {() => Promise<T>} run
 * @returns {Promise<{ table: T|null, error: string|null }>}
 */
async function attempt(id, run) {
  try {
    return { table: await run(), error: null };
  } catch (error) {
    return { table: null, error: `${id} failed: ${error.message}` };
  }
}

/**
 * Run a source that produces several tables at once, spreading a failure across all of them.
 * @param {string} id
 * @param {string[]} ids table ids the group publishes
 * @param {() => Promise<Record<string, any>>} run
 * @returns {Promise<Record<string, { table: any, error: string|null }>>}
 */
async function attemptGroup(id, ids, run) {
  const { table: tables, error } = await attempt(id, run);
  return Object.fromEntries(
    ids.map((tableId) => [tableId, { table: tables?.[tableId] ?? null, error }]),
  );
}

/**
 * Append one UTC-day snapshot of the FantasyCalc redraft table to data/values-history.csv
 * (design §2.6). Header `date,id,v,t`: `v` is the market value, `t` FantasyCalc's own 30-day
 * trend, both verbatim off the table this run published. Idempotent within a day — a second run
 * on the same date finds the date already present and writes nothing, so the 3-hourly cron adds
 * one snapshot a day and the file is a clean append in every diff.
 *
 * Six weeks of this is what R10 §1.5 needs; nothing reads it yet, and the phone never loads it.
 * @param {string|null} previousText current file contents, or null
 * @param {{ values?: Record<string, {v?: number, t?: number}> }|null|undefined} table
 * @param {string} date `YYYY-MM-DD` (UTC)
 * @returns {{ text: string, rows: number, appended: boolean }}
 */
export function appendValuesHistory(previousText, table, date) {
  const NL = "\n";
  const header = "date,id,v,t";
  const existing =
    typeof previousText === "string" && previousText.trim() !== ""
      ? previousText.trimEnd().split(NL)
      : [];
  const body = existing.length > 0 && existing[0].startsWith("date,") ? existing.slice(1) : existing;
  if (body.some((line) => line.startsWith(`${date},`))) {
    return { text: `${[header, ...body].join(NL)}${NL}`, rows: 0, appended: false };
  }
  /** @type {string[]} */
  const rows = [];
  for (const id of Object.keys(table?.values ?? {}).sort(compareIds)) {
    const row = table.values[id];
    const value = typeof row?.v === "number" && Number.isFinite(row.v) ? round(row.v, 2) : null;
    if (value === null) continue;
    const trend = typeof row?.t === "number" && Number.isFinite(row.t) ? round(row.t, 2) : "";
    rows.push(`${date},${id},${value},${trend}`);
  }
  return {
    text: `${[header, ...body, ...rows].join(NL)}${NL}`,
    rows: rows.length,
    appended: rows.length > 0,
  };
}

/**
 * @param {string} status_ "ok" | "warn" | "fail"
 * @param {string} id
 * @param {string} detail
 */
function status(status_, id, detail) {
  const tag = status_ === "ok" ? "ok  " : status_ === "warn" ? "warn" : "FAIL";
  process.stdout.write(`[${tag}] ${id.padEnd(20)} ${detail}\n`);
}

/**
 * @returns {Promise<number>} process exit code
 */
export async function main() {
  const generatedAt = isoTimestamp();
  process.stdout.write(`tradewinds pipeline ${PIPELINE_VERSION} — league-agnostic — ${generatedAt}\n`);

  // --- season + week --------------------------------------------------------
  /** @type {Record<string, any>} */
  let state;
  try {
    state = await fetchState();
    await sleep(POLITE_DELAY_MS);
  } catch (error) {
    status("fail", "sleeper_state", error.message);
    return 1;
  }
  if (!state || typeof state !== "object") {
    status("fail", "sleeper_state", "https://api.sleeper.app/v1/state/nfl returned no state object");
    return 1;
  }
  const season = String(state.league_season ?? state.season ?? new Date().getUTCFullYear());
  const week = Math.max(1, Number(state.week) || 1);
  status("ok", "sleeper_state", `season ${season} · week ${week} · leg ${state.leg ?? "?"}`);

  // --- Sleeper core (required) ---------------------------------------------
  /** @type {Awaited<ReturnType<typeof collectSleeper>>} */
  let core;
  try {
    core = await collectSleeper({
      season,
      generatedAt,
      log: (message) => status("ok", `sleeper_${message.split(":")[0]}`, message.split(": ").slice(1).join(": ")),
    });
  } catch (error) {
    status("fail", "sleeper_core", error.message);
    process.stderr.write("Sleeper core failed — data/ left untouched.\n");
    return 1;
  }
  if (core.stats.unfilteredWeeks > 0) {
    status("warn", "sleeper_projections", `${core.stats.unfilteredWeeks} week(s) fell back to the unfiltered endpoint`);
  }
  const projectionCount = Object.keys(core.projections.players).length;
  const nameIndex = buildNameIndex(core.players.players);

  // --- season history (design §13.6) ---------------------------------------
  // ~20 sequential calls. Optional like the value tables: a failure keeps the committed season.
  const historyIds = new Set(Object.keys(core.players.players));
  for (const id of rosterPlayerIds(readJsonIfExists(ROSTER_SNAPSHOT_FILE))) historyIds.add(id);
  await sleep(POLITE_DELAY_MS);
  let historyRun = { history: null, errors: { history: "not attempted" }, stats: {} };
  try {
    historyRun = await collectHistory({
      season,
      week,
      allowedIds: historyIds,
      generatedAt,
      log: (message) => status("ok", "sleeper_history", message.split(": ").slice(1).join(": ")),
    });
  } catch (error) {
    status("warn", "sleeper_history", error.message);
    historyRun = { history: null, errors: { [String(season)]: error.message }, stats: {} };
  }
  const guardedHistory = resolveHistory({
    next: historyRun.history,
    errors: historyRun.errors,
    previous: loadPreviousHistory(join(DATA_DIR, "history.json")),
    floors: HISTORY_FLOORS,
  });
  for (const note of guardedHistory.notes) status("warn", "lastgood", note);
  const history = guardedHistory.history;
  const historyRows = Object.values(history?.seasons ?? {}).reduce(
    (total, entry) => total + historyPlayerCount(entry),
    0,
  );

  // --- optional value sources ----------------------------------------------
  status("ok", "fantasycalc_params", `numTeams=${FC_NUM_TEAMS} ppr=${FC_PPR} · numQbs 1 and 2`);

  /** @type {Record<string, { table: any, error: string|null }>} */
  const attempts = {};
  for (const spec of FC_TABLES) {
    attempts[spec.id] = await attempt(spec.id, () => fetchFantasyCalcTable(spec));
    await sleep(POLITE_DELAY_MS);
  }
  Object.assign(
    attempts,
    await attemptGroup("dp_dynasty", DP_TABLES.map((spec) => spec.id), () =>
      fetchDynastyProcessTables({ nameIndex }),
    ),
  );
  await sleep(POLITE_DELAY_MS);
  Object.assign(
    attempts,
    await attemptGroup("bc_tiers", BC_FORMATS.map((spec) => spec.id), () =>
      fetchBorisChenTables({ week, nameIndex, teamNameIndex: core.teamNameIndex }),
    ),
  );

  // --- last-good guard ------------------------------------------------------
  const valuesFile = join(DATA_DIR, "values.json");
  const previous = loadPreviousValueSources(valuesFile, { keep: Object.keys(PUBLISHED_TABLES) });
  const guarded = applyLastGood({
    attempts: Object.fromEntries(
      Object.entries(attempts).map(([id, result]) => [
        id,
        { table: result.table ? toContractTable(result.table) : null, error: result.error },
      ]),
    ),
    previous,
    floors: ROW_FLOORS,
  });
  // A table carried over from an older schema predates `variant`; stamp the current one on.
  for (const [id, variant] of Object.entries(PUBLISHED_TABLES)) {
    const table = guarded.sources[id];
    if (table && table.variant === undefined) table.variant = variant;
  }
  for (const note of guarded.notes) status("warn", "lastgood", note);

  for (const id of Object.keys(PUBLISHED_TABLES).sort()) {
    const result = attempts[id] ?? { table: null, error: "not attempted" };
    const published = guarded.sources[id];
    if (result.error) {
      status("fail", id, `${result.error}${guarded.kept.includes(id) ? " — kept last good" : ""}`);
    } else if (published?.ok === false) {
      status("warn", id, `${published.count} rows published (${published.error})`);
    } else {
      const extra = [];
      if (typeof result.table?.unmatched === "number") extra.push(`${result.table.unmatched} unmatched`);
      if (typeof result.table?.dropped === "number" && result.table.dropped > 0) {
        extra.push(`${result.table.dropped} without sleeperId`);
      }
      if (Array.isArray(result.table?.missingFiles) && result.table.missingFiles.length > 0) {
        extra.push(`${result.table.missingFiles.length} file(s) unavailable`);
      }
      status("ok", id, `${published?.count ?? 0} rows${extra.length ? ` (${extra.join(", ")})` : ""}`);
    }
  }

  // --- 004 player intelligence: stats, dvp, games (design §2.1–§2.3) --------
  // All three are OPTIONAL in every direction: a failure here keeps the committed copy and never
  // fails the run, exactly like history.json and the value tables. The player set is lean — the
  // ids data/projections.json already carries this season (design §2.1) — so the file stays a
  // league-agnostic usage table rather than a second copy of the player dump.
  const projectionIds = new Set(Object.keys(core.projections.players));
  let statsRun = { stats: null, dvp: null, weeks: [], gameIds: new Map(), errors: { stats: "not attempted" } };
  try {
    statsRun = await collectStats({
      season,
      stateWeek: week,
      allowedIds: projectionIds,
      generatedAt,
      schedule: core.schedule,
      log: (message) => status("ok", "sleeper_stats", message),
    });
  } catch (error) {
    status("warn", "sleeper_stats", error.message);
    statsRun = { stats: null, dvp: null, weeks: [], gameIds: new Map(), errors: { stats: error.message } };
  }
  await sleep(POLITE_DELAY_MS);

  let gamesRun = { games: null, errors: { games: "not attempted" }, weatherCalls: 0 };
  try {
    gamesRun = await collectGames({
      season,
      week,
      generatedAt,
      log: (message) => status("ok", "games", message),
    });
  } catch (error) {
    status("warn", "games", error.message);
    gamesRun = { games: null, errors: { games: error.message }, weatherCalls: 0 };
  }

  const statsErrors = Object.values(statsRun.errors ?? {});
  const gamesErrors = Object.values(gamesRun.errors ?? {});
  const guardedStats = resolveOptional({
    name: "stats",
    next: statsRun.stats,
    previous: loadPreviousOptional(join(DATA_DIR, "stats.json"), STATS_VERSION),
    error: statsErrors[0] ?? null,
  });
  const guardedDvp = resolveOptional({
    name: "dvp",
    next: statsRun.dvp,
    previous: loadPreviousOptional(join(DATA_DIR, "dvp.json"), DVP_VERSION),
    error: statsErrors[0] ?? null,
  });
  const guardedGames = resolveOptional({
    name: "games",
    next: gamesRun.games,
    previous: loadPreviousOptional(join(DATA_DIR, "games.json"), GAMES_VERSION),
    error: gamesErrors[0] ?? null,
  });
  for (const guard of [guardedStats, guardedDvp, guardedGames]) {
    if (guard.note) status("warn", "lastgood", guard.note);
  }
  status(
    guardedStats.file ? "ok" : "warn",
    "stats",
    guardedStats.file
      ? `${guardedStats.count} players over week(s) ${JSON.stringify(guardedStats.file.weeks)}` +
        `${guardedStats.file.partial.length ? ` · partial ${JSON.stringify(guardedStats.file.partial)}` : ""}`
      : `no stats file (${statsErrors[0] ?? "no completed week"})`,
  );
  status(
    guardedDvp.file ? "ok" : "warn",
    "dvp",
    guardedDvp.file ? `${guardedDvp.count} teams, half-PPR, ppr_ref kept for provenance` : "no dvp file",
  );
  status(
    guardedGames.file ? "ok" : "warn",
    "games",
    guardedGames.file
      ? `${guardedGames.count} games · ${gamesRun.weatherCalls} weather call(s)` +
        `${gamesErrors.length ? ` · ${gamesErrors.length} source problem(s)` : ""}`
      : `no games file (${gamesErrors[0] ?? "unknown"})`,
  );

  // --- assemble + write -----------------------------------------------------
  const values = { generated_at: generatedAt, sources: orderedByKey(guarded.sources) };

  /** @type {Record<string, any>} */
  const metaSources = {
    players: { ok: true, fetched_at: generatedAt, count: core.players.count },
    projections: { ok: true, fetched_at: generatedAt, count: projectionCount },
    schedule: { ok: true, fetched_at: generatedAt, count: core.schedule.games.length },
  };
  for (const id of Object.keys(PUBLISHED_TABLES)) {
    metaSources[id] = metaEntry(guarded.sources[id], attempts[id], generatedAt);
  }
  if (history) {
    // `count` is the total player rows across every season, so the phone can see at a glance
    // whether the feed is worth reading; a season carried forward flips `ok` to false and names
    // the seasons, because the file itself has nowhere to record its own staleness.
    metaSources.history = {
      ok: guardedHistory.failed.length === 0,
      fetched_at: history.generated_at ?? generatedAt,
      count: historyRows,
      seasons: Object.fromEntries(
        Object.entries(history.seasons).map(([year, entry]) => [year, historyPlayerCount(entry)]),
      ),
    };
    if (guardedHistory.failed.length > 0) {
      metaSources.history.error =
        guardedHistory.notes.join("; ") || `season(s) ${guardedHistory.failed.join(", ")} failed`;
    }
  }
  // 004 design §2.6: one UTC-day snapshot of the FantasyCalc redraft table, append-only. Built
  // here (not written yet) so meta.json can describe it and the size guard can count it.
  const valuesHistoryFile = join(DATA_DIR, "values-history.csv");
  const valuesHistory = appendValuesHistory(
    readTextIfExists(valuesHistoryFile),
    guarded.sources[VALUES_HISTORY_TABLE],
    generatedAt.slice(0, 10),
  );

  for (const [name, guard] of [
    ["stats", guardedStats],
    ["games", guardedGames],
    ["dvp", guardedDvp],
  ]) {
    if (!guard.file) continue;
    const problem = name === "stats" ? statsErrors[0] : name === "dvp" ? statsErrors[0] : gamesErrors[0];
    metaSources[name] = {
      // `ok: false` when the file on disk is a carried-forward copy or a source complained — the
      // file itself has nowhere to record its own staleness (same argument as history.json).
      ok: !guard.kept && !problem,
      fetched_at: guard.file.generated_at ?? generatedAt,
      count: guard.count,
      ...(guard.kept ? { error: guard.note ?? "kept last good" } : problem ? { error: problem } : {}),
    };
  }
  metaSources.values_history = {
    ok: true,
    fetched_at: generatedAt,
    count: valuesHistory.rows,
    ...(valuesHistory.appended ? {} : { error: `no snapshot added for ${generatedAt.slice(0, 10)}` }),
  };

  const meta = {
    generated_at: generatedAt,
    season,
    week,
    pipeline_version: PIPELINE_VERSION,
    sources: orderedByKey(metaSources),
  };

  // `history` is optional: a run that could not build one AND has no committed copy writes no
  // file at all, and src/data.js treats "absent" as the ordinary case (design §13.6 F3).
  // meta.json stays last so the build stamp is never newer than the files it describes.
  /** @type {Record<string, any>} */
  const files = {
    players: core.players,
    projections: core.projections,
    values,
    schedule: core.schedule,
    ...(history ? { history } : {}),
    // Same "absent is ordinary" rule as history.json (004 design §2, FR-103).
    ...(guardedStats.file ? { stats: guardedStats.file } : {}),
    ...(guardedGames.file ? { games: guardedGames.file } : {}),
    ...(guardedDvp.file ? { dvp: guardedDvp.file } : {}),
    meta,
  };

  const problems = validateAll(files);
  let problemCount = 0;
  for (const [name, list] of Object.entries(problems)) {
    problemCount += list.length;
    for (const problem of list.slice(0, 5)) status("warn", `contract:${name}`, problem);
    if (list.length > 5) status("warn", `contract:${name}`, `... and ${list.length - 5} more`);
  }
  if (problemCount === 0) {
    status("ok", "contract", `all ${Object.keys(problems).length} files valid`);
  }

  let totalBytes = 0;
  let totalGzip = 0;
  for (const [name, value] of Object.entries(files)) {
    const size = writeJsonFile(join(DATA_DIR, `${name}.json`), value);
    totalBytes += size.bytes;
    totalGzip += size.gzip;
    status("ok", `write:${name}.json`, formatSize(size));
    if (name === "history") {
      const detail = Object.entries(value.seasons)
        .map(([year, entry]) => `${year}: ${historyPlayerCount(entry)} players / ${entry.weeks} wk`)
        .join(" · ");
      status(
        size.bytes > HISTORY_SIZE_BUDGET_BYTES ? "warn" : "ok",
        "history",
        `${detail} — ${size.bytes.toLocaleString("en-US")} B of a ` +
          `${HISTORY_SIZE_BUDGET_BYTES.toLocaleString("en-US")} byte budget`,
      );
    }
  }
  // data/values-history.csv is not a contract file and the phone never loads it, but it IS
  // committed, so it is written with the rest and counted against the same budget (§2.6).
  const historySize = writeTextFile(valuesHistoryFile, valuesHistory.text);
  totalBytes += historySize.bytes;
  totalGzip += historySize.gzip;
  status(
    historySize.bytes > VALUES_HISTORY_SIZE_BUDGET_BYTES ? "warn" : "ok",
    "values-history",
    `${valuesHistory.appended ? `+${valuesHistory.rows} row(s)` : "no new snapshot today"} — ` +
      `${formatSize(historySize)} of a ${VALUES_HISTORY_SIZE_BUDGET_BYTES.toLocaleString("en-US")} byte budget`,
  );

  status(
    totalBytes > SIZE_BUDGET_BYTES ? "warn" : "ok",
    "data size",
    `${formatSize({ bytes: totalBytes, gzip: totalGzip })} of a ` +
      `${SIZE_BUDGET_BYTES.toLocaleString("en-US")} byte budget`,
  );
  status("ok", "byes", JSON.stringify(core.stats.byes));

  return 0;
}

/**
 * meta.json entry for one value source.
 * @param {any} published table actually written to values.json
 * @param {{ table: any, error: string|null }|undefined} attemptResult
 * @param {string} fallbackTimestamp
 * @returns {{ ok: boolean, fetched_at: string, count: number, error?: string, unmatched?: number }}
 */
function metaEntry(published, attemptResult, fallbackTimestamp) {
  /** @type {Record<string, any>} */
  const entry = {
    ok: published?.ok === true,
    fetched_at: published?.fetched_at ?? fallbackTimestamp,
    count: published?.count ?? 0,
  };
  if (published?.error !== undefined) entry.error = published.error;
  else if (attemptResult?.error) entry.error = attemptResult.error;
  else if (entry.ok === false) entry.error = "source produced no table";
  if (typeof attemptResult?.table?.unmatched === "number") entry.unmatched = attemptResult.table.unmatched;
  return entry;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`pipeline crashed: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
