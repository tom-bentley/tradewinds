// The data/ byte budget (004 design §1, R13 §Q13.5 hazard 8) and the values-history append
// (design §2.6).
//
// R13's hazard: WS-G alone can push data/ past `SIZE_BUDGET_BYTES`, which the pipeline only WARNS
// about — so nobody notices until the phone is slow. This test fails instead, and it counts every
// file the repo actually commits, including the ones the ALERTS job writes (advisor.json,
// alerts-state.json, research-queue.json) and the ones the desk writes (dossiers.json,
// dossiers/*), none of which the pipeline's own total ever sees.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SIZE_BUDGET_BYTES,
  VALUES_HISTORY_SIZE_BUDGET_BYTES,
  VALUES_HISTORY_TABLE,
  appendValuesHistory,
} from "../pipeline/refresh.mjs";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/** Every committed file under data/, one level of subdirectory deep (data/dossiers/*). */
function committedFiles(dir = DATA_DIR, prefix = "data") {
  /** @type {{path: string, bytes: number}[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...committedFiles(full, `${prefix}/${entry.name}`));
    else out.push({ path: `${prefix}/${entry.name}`, bytes: statSync(full).size });
  }
  return out;
}

test("the committed data/ set stays inside SIZE_BUDGET_BYTES", () => {
  const files = committedFiles();
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const report = files
    .sort((a, b) => b.bytes - a.bytes)
    .map((file) => `  ${file.path.padEnd(28)} ${file.bytes.toLocaleString("en-US")} B`)
    .join("\n");
  assert.ok(
    total <= SIZE_BUDGET_BYTES,
    `data/ is ${total.toLocaleString("en-US")} B against a ${SIZE_BUDGET_BYTES.toLocaleString("en-US")} B budget:\n${report}`,
  );
  // The job-written files are part of the committed set and must be counted, not forgotten.
  for (const name of ["advisor.json", "alerts-state.json", "research-queue.json"]) {
    assert.ok(files.some((file) => file.path === `data/${name}`), `data/${name} is missing from the repo`);
  }
  // A budget with no headroom left is a budget that is about to be breached silently.
  assert.ok(total < SIZE_BUDGET_BYTES * 0.95, `only ${SIZE_BUDGET_BYTES - total} B of headroom left`);
});

test("data/values-history.csv stays inside its own cap", () => {
  const file = committedFiles().find((entry) => entry.path === "data/values-history.csv");
  assert.ok(file, "data/values-history.csv is missing");
  assert.ok(
    file.bytes <= VALUES_HISTORY_SIZE_BUDGET_BYTES,
    `${file.bytes} B against ${VALUES_HISTORY_SIZE_BUDGET_BYTES} B — time to roll the oldest month off (§2.6)`,
  );
});

test("the three 004 files are each well under their own share of the budget", () => {
  const byName = Object.fromEntries(committedFiles().map((file) => [file.path, file.bytes]));
  assert.ok(byName["data/stats.json"] <= 700_000, "stats.json is over its §2.1 ceiling");
  assert.ok(byName["data/dvp.json"] <= 200_000, "dvp.json is over the §2.3 estimate");
  assert.ok(byName["data/games.json"] <= 200_000, "games.json is over the §2.2 estimate");
});

test("appendValuesHistory writes one header and one snapshot a day", () => {
  const table = { values: { 96: { v: 92, t: -2 }, 19: { v: 3.5, t: 0 }, bad: { v: null } } };

  const first = appendValuesHistory(null, table, "2026-09-22");
  assert.equal(first.appended, true);
  assert.equal(first.rows, 2);
  assert.deepEqual(first.text.trimEnd().split("\n"), [
    "date,id,v,t",
    "2026-09-22,19,3.5,0",
    "2026-09-22,96,92,-2",
  ]);

  // Idempotent within a day: the 3-hourly cron adds a snapshot once, then nothing.
  const again = appendValuesHistory(first.text, table, "2026-09-22");
  assert.equal(again.appended, false);
  assert.equal(again.rows, 0);
  assert.equal(again.text, first.text);

  // The next day appends, and never rewrites what is already there.
  const next = appendValuesHistory(first.text, table, "2026-09-23");
  assert.equal(next.appended, true);
  assert.ok(next.text.startsWith(first.text.trimEnd()));
  assert.equal(next.text.trimEnd().split("\n").length, 5);
});

test("appendValuesHistory survives a missing or failed value table", () => {
  const empty = appendValuesHistory("date,id,v,t\n", null, "2026-09-22");
  assert.equal(empty.appended, false);
  assert.equal(empty.text, "date,id,v,t\n");
  assert.equal(appendValuesHistory("", { values: {} }, "2026-09-22").text, "date,id,v,t\n");
  // A file that somehow lost its header gets one back without losing its rows.
  const headerless = appendValuesHistory("2026-09-20,96,90,1\n", { values: {} }, "2026-09-22");
  assert.deepEqual(headerless.text.trimEnd().split("\n"), ["date,id,v,t", "2026-09-20,96,90,1"]);
});

test("the committed values-history is the FantasyCalc redraft table, one day at a time", () => {
  assert.equal(VALUES_HISTORY_TABLE, "fc_redraft");
});
