#!/usr/bin/env node
// Tradewinds data pipeline entry point.
//
//   node pipeline/refresh.mjs          (env TRADEWINDS_LEAGUE_ID overrides the league)
//
// Writes data/{players,projections,values,schedule,meta}.json.
// Exit 0 when the Sleeper core (players + projections + schedule) succeeded, 1 when it did not.
// FantasyCalc / DynastyProcess / Boris Chen are optional: a failure there keeps the last good
// table and never fails the run.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PIPELINE_VERSION,
  POLITE_DELAY_MS,
  isoTimestamp,
  orderedByKey,
  sleep,
  writeJsonFile,
} from "./util.mjs";
import { validateAll } from "./contract.mjs";
import { ROW_FLOORS, applyLastGood, loadPreviousValueSources } from "./lastgood.mjs";
import { buildNameIndex, collectSleeper, fetchLeague, fetchState } from "./sources/sleeper.mjs";
import { fantasyCalcParams, fetchFantasyCalcTable } from "./sources/fantasycalc.mjs";
import { fetchDynastyProcessTable } from "./sources/dynastyprocess.mjs";
import { fetchBorisChenTable } from "./sources/borischen.mjs";

/** Tom's Boyball league — the app's default. */
export const DEFAULT_LEAGUE_ID = "1394476745138147328";

/** Total data/ budget; the run warns (does not fail) above it. */
const SIZE_BUDGET_BYTES = 600_000;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(REPO_ROOT, "data");

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
 * @param {string} status "ok" | "warn" | "fail"
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
  const leagueId = process.env.TRADEWINDS_LEAGUE_ID || DEFAULT_LEAGUE_ID;
  const generatedAt = isoTimestamp();
  process.stdout.write(`tradewinds pipeline ${PIPELINE_VERSION} — league ${leagueId} — ${generatedAt}\n`);

  // --- league + state -------------------------------------------------------
  /** @type {Record<string, any>} */
  let league;
  /** @type {Record<string, any>} */
  let state;
  try {
    league = await fetchLeague(leagueId);
    await sleep(POLITE_DELAY_MS);
    state = await fetchState();
    await sleep(POLITE_DELAY_MS);
  } catch (error) {
    status("fail", "sleeper_league", error.message);
    return 1;
  }
  if (!league || typeof league !== "object" || !league.scoring_settings) {
    status("fail", "sleeper_league", `league ${leagueId} returned no scoring_settings — check TRADEWINDS_LEAGUE_ID`);
    return 1;
  }
  if (!state || typeof state !== "object") {
    status("fail", "sleeper_state", "https://api.sleeper.app/v1/state/nfl returned no state object");
    return 1;
  }
  const scoring = league.scoring_settings ?? {};
  const season = String(league.season ?? state.season ?? new Date().getUTCFullYear());
  const week = Math.max(1, Number(state.week) || 1);
  status(
    "ok",
    "sleeper_league",
    `${league.name ?? "?"} · season ${season} · week ${week} · ${league.total_rosters ?? "?"} teams · ` +
      `${Object.keys(scoring).length} scoring keys`,
  );

  // --- Sleeper core (required) ---------------------------------------------
  /** @type {Awaited<ReturnType<typeof collectSleeper>>} */
  let core;
  try {
    core = await collectSleeper({
      leagueId,
      season,
      scoring,
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
  const fcParams = fantasyCalcParams(league);
  status("ok", "fantasycalc_params", `numQbs=${fcParams.numQbs} numTeams=${fcParams.numTeams} ppr=${fcParams.ppr}`);

  const fcRedraft = await attempt("fc_redraft", () =>
    fetchFantasyCalcTable({ ...fcParams, isDynasty: false, label: "FantasyCalc redraft", kind: "redraft" }),
  );
  await sleep(POLITE_DELAY_MS);
  const fcDynasty = await attempt("fc_dynasty", () =>
    fetchFantasyCalcTable({ ...fcParams, isDynasty: true, label: "FantasyCalc dynasty", kind: "dynasty" }),
  );
  await sleep(POLITE_DELAY_MS);
  const dpDynasty = await attempt("dp_dynasty", () => fetchDynastyProcessTable({ nameIndex }));
  await sleep(POLITE_DELAY_MS);
  const bcTiers = await attempt("bc_tiers", () =>
    fetchBorisChenTable({ week, nameIndex, teamNameIndex: core.teamNameIndex }),
  );

  /** @type {Record<string, { table: any, error: string|null }>} */
  const attempts = {
    fc_redraft: fcRedraft,
    fc_dynasty: fcDynasty,
    dp_dynasty: dpDynasty,
    bc_tiers: bcTiers,
  };

  // --- last-good guard ------------------------------------------------------
  const valuesFile = join(DATA_DIR, "values.json");
  const previous = loadPreviousValueSources(valuesFile);
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
  for (const note of guarded.notes) status("warn", "lastgood", note);

  for (const [id, result] of Object.entries(attempts)) {
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
    bc_tiers: metaEntry(guarded.sources.bc_tiers, attempts.bc_tiers, generatedAt),
    dp_dynasty: metaEntry(guarded.sources.dp_dynasty, attempts.dp_dynasty, generatedAt),
    fc_dynasty: metaEntry(guarded.sources.fc_dynasty, attempts.fc_dynasty, generatedAt),
    fc_redraft: metaEntry(guarded.sources.fc_redraft, attempts.fc_redraft, generatedAt),
    players: { ok: true, fetched_at: generatedAt, count: core.players.count },
    projections: { ok: true, fetched_at: generatedAt, count: projectionCount },
    schedule: { ok: true, fetched_at: generatedAt, count: core.schedule.games.length },
  };
  const meta = {
    generated_at: generatedAt,
    season,
    week,
    league_id: leagueId,
    pipeline_version: PIPELINE_VERSION,
    sources: metaSources,
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
  for (const [name, value] of Object.entries(files)) {
    const bytes = writeJsonFile(join(DATA_DIR, `${name}.json`), value);
    totalBytes += bytes;
    status("ok", `write:${name}.json`, `${bytes.toLocaleString("en-US")} bytes`);
  }
  status(
    totalBytes > SIZE_BUDGET_BYTES ? "warn" : "ok",
    "data size",
    `${totalBytes.toLocaleString("en-US")} bytes of a ${SIZE_BUDGET_BYTES.toLocaleString("en-US")} byte budget`,
  );
  status("ok", "byes", JSON.stringify(core.stats.byes));
  if (core.stats.medianHalfPprDiff !== null) {
    status(
      "ok",
      "half-ppr xcheck",
      `median |league-exact − pts_half_ppr| = ${core.stats.medianHalfPprDiff.toFixed(3)} pts`,
    );
  }

  return 0;
}

/**
 * meta.json entry for one value source.
 * @param {any} published table actually written to values.json
 * @param {{ table: any, error: string|null }} attemptResult
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
