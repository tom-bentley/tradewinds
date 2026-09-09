// Last-good guard: a failed or short source must never overwrite a good table. No network.

import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROW_FLOORS,
  applyLastGood,
  loadPreviousValueSources,
  resolveSource,
  rowCount,
} from "../pipeline/lastgood.mjs";

const PREVIOUS_FETCHED_AT = "2026-09-08T06:00:00Z";

/**
 * @param {number} rows
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function table(rows, overrides = {}) {
  /** @type {Record<string, Record<string, number>>} */
  const values = {};
  for (let i = 0; i < rows; i += 1) values[String(1000 + i)] = { v: 100 - i, r: i + 1 };
  return {
    label: "FantasyCalc redraft",
    kind: "redraft",
    variant: { numQbs: 1 },
    fetched_at: PREVIOUS_FETCHED_AT,
    ok: true,
    count: rows,
    url: "https://api.fantasycalc.com/values/current?isDynasty=false",
    values,
    ...overrides,
  };
}

test("row floors match the design contract, 2QB variants included", () => {
  assert.deepEqual(ROW_FLOORS, {
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
});

test("loadPreviousValueSources drops table ids the pipeline no longer publishes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tradewinds-lastgood-"));
  const file = join(dir, "values.json");
  writeFileSync(
    file,
    JSON.stringify({
      generated_at: PREVIOUS_FETCHED_AT,
      sources: { fc_redraft: table(200), bc_tiers: table(450, { kind: "tiers" }) },
    }),
    "utf8",
  );

  assert.deepEqual(Object.keys(loadPreviousValueSources(file)).sort(), ["bc_tiers", "fc_redraft"]);
  assert.deepEqual(Object.keys(loadPreviousValueSources(file, { keep: ["fc_redraft", "bc_tiers_half"] })), [
    "fc_redraft",
  ]);
  assert.deepEqual(loadPreviousValueSources(join(dir, "missing.json"), { keep: ["fc_redraft"] }), {});
});

test("rowCount ignores a table's self-reported count", () => {
  assert.equal(rowCount(table(3, { count: 999 })), 3);
  assert.equal(rowCount(null), 0);
  assert.equal(rowCount({ values: null }), 0);
});

test("a healthy table is published untouched", () => {
  const next = table(200, { fetched_at: "2026-09-09T12:00:00Z" });
  const resolved = resolveSource({ id: "fc_redraft", next, previous: table(199), floor: 150 });
  assert.equal(resolved.kept, false);
  assert.equal(resolved.table, next);
  assert.equal(resolved.note, null);
});

test("an empty new table keeps the previous one with ok:false and its original fetched_at", () => {
  const previous = table(199);
  const { sources, kept, failed, notes } = applyLastGood({
    attempts: { fc_redraft: { table: table(0, { count: 0 }) } },
    previous: { fc_redraft: previous },
  });
  const published = sources.fc_redraft;
  assert.deepEqual(kept, ["fc_redraft"]);
  assert.deepEqual(failed, ["fc_redraft"]);
  assert.equal(published.ok, false);
  assert.equal(published.count, 199);
  assert.equal(published.fetched_at, PREVIOUS_FETCHED_AT);
  assert.deepEqual(published.values, previous.values);
  assert.match(published.error, /row count 0 below floor 150/);
  assert.equal(notes.length, 1);
});

test("a table below its floor keeps the previous one", () => {
  const { sources } = applyLastGood({
    attempts: { dp_dynasty: { table: table(299, { kind: "dynasty" }) } },
    previous: { dp_dynasty: table(640, { kind: "dynasty" }) },
  });
  assert.equal(sources.dp_dynasty.ok, false);
  assert.equal(sources.dp_dynasty.count, 640);
});

test("a thrown fetch keeps the previous table and records the error", () => {
  const { sources, kept } = applyLastGood({
    attempts: { bc_tiers: { table: null, error: "bc_tiers failed: HTTP 503 for .../weekly-RB-HALF.csv" } },
    previous: { bc_tiers: table(450, { kind: "tiers", label: "Boris Chen half-PPR wk 1" }) },
  });
  assert.deepEqual(kept, ["bc_tiers"]);
  assert.equal(sources.bc_tiers.ok, false);
  assert.equal(sources.bc_tiers.count, 450);
  assert.match(sources.bc_tiers.error, /HTTP 503/);
});

test("a failure with no previous table publishes nothing rather than an empty one", () => {
  const { sources, notes } = applyLastGood({
    attempts: { fc_dynasty: { table: null, error: "fc_dynasty failed: ENOTFOUND" } },
    previous: {},
  });
  assert.equal(sources.fc_dynasty, undefined);
  assert.match(notes[0], /no previous table to fall back on/);
});

test("a short table with no previous copy is published as ok:false rather than dropped", () => {
  const { sources } = applyLastGood({
    attempts: { fc_redraft: { table: table(10) } },
    previous: {},
  });
  assert.equal(sources.fc_redraft.ok, false);
  assert.equal(sources.fc_redraft.count, 10);
});

test("a source that was published before but not attempted is carried forward", () => {
  const { sources, kept } = applyLastGood({
    attempts: { fc_redraft: { table: table(200) } },
    previous: { fc_redraft: table(199), dp_dynasty: table(640, { kind: "dynasty" }) },
  });
  assert.equal(sources.fc_redraft.ok, true);
  assert.equal(sources.dp_dynasty.ok, false);
  assert.match(sources.dp_dynasty.error, /not attempted/);
  assert.deepEqual(kept, ["dp_dynasty"]);
});

test("published sources come out in a stable key order", () => {
  const attempts = {
    fc_redraft: { table: table(200) },
    bc_tiers: { table: table(150, { kind: "tiers" }) },
    dp_dynasty: { table: table(640, { kind: "dynasty" }) },
  };
  const forward = applyLastGood({ attempts });
  const reversed = applyLastGood({
    attempts: Object.fromEntries(Object.entries(attempts).reverse()),
  });
  assert.deepEqual(Object.keys(forward.sources), Object.keys(reversed.sources));
  assert.deepEqual(Object.keys(forward.sources), ["bc_tiers", "dp_dynasty", "fc_redraft"]);
});
