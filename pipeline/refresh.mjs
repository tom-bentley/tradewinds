#!/usr/bin/env node
// Tradewinds data pipeline entry point.
//
//   node pipeline/refresh.mjs
//
// Writes data/{players,projections,values,schedule,meta}.json.
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
  POLITE_DELAY_MS,
  formatSize,
  isoTimestamp,
  orderedByKey,
  sleep,
  writeJsonFile,
} from "./util.mjs";
import { validateAll } from "./contract.mjs";
import { ROW_FLOORS, applyLastGood, loadPreviousValueSources } from "./lastgood.mjs";
import { buildNameIndex, collectSleeper, fetchState } from "./sources/sleeper.mjs";
import { FC_NUM_TEAMS, FC_PPR, FC_TABLES, fetchFantasyCalcTable } from "./sources/fantasycalc.mjs";
import { DP_TABLES, fetchDynastyProcessTables } from "./sources/dynastyprocess.mjs";
import { BC_FORMATS, fetchBorisChenTables } from "./sources/borischen.mjs";

/** Total data/ budget; the run warns (does not fail) above it. Stat lines dominate it. */
const SIZE_BUDGET_BYTES = 1_600_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(REPO_ROOT, "data");

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
  const meta = {
    generated_at: generatedAt,
    season,
    week,
    pipeline_version: PIPELINE_VERSION,
    sources: orderedByKey(metaSources),
  };

  const files = {
    players: core.players,
    projections: core.projections,
    values,
    schedule: core.schedule,
    meta,
  };

  const problems = validateAll(files);
  let problemCount = 0;
  for (const [name, list] of Object.entries(problems)) {
    problemCount += list.length;
    for (const problem of list.slice(0, 5)) status("warn", `contract:${name}`, problem);
    if (list.length > 5) status("warn", `contract:${name}`, `... and ${list.length - 5} more`);
  }
  if (problemCount === 0) status("ok", "contract", "all five files valid");

  let totalBytes = 0;
  let totalGzip = 0;
  for (const [name, value] of Object.entries(files)) {
    const size = writeJsonFile(join(DATA_DIR, `${name}.json`), value);
    totalBytes += size.bytes;
    totalGzip += size.gzip;
    status("ok", `write:${name}.json`, formatSize(size));
  }
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
