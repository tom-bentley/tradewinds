// Value-source normalizers on the 2026-09-09 raw samples, including the §10.2 variants. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FC_NUM_TEAMS,
  FC_PPR,
  FC_TABLES,
  fantasyCalcUrl,
  normalizeFantasyCalc,
} from "../pipeline/sources/fantasycalc.mjs";
import { DP_TABLES, buildFpToSleeper, normalizeDynastyProcess } from "../pipeline/sources/dynastyprocess.mjs";
import {
  BC_FORMATS,
  BC_FORMAT_POSITIONS,
  BC_SHARED_FILES,
  borisChenFile,
  normalizeBorisChen,
  parseBorisChen,
  resolveBorisChenId,
} from "../pipeline/sources/borischen.mjs";
import { buildNameIndex, buildPlayers, buildTeamNameIndex, computeByes } from "../pipeline/sources/sleeper.mjs";
import { PUBLISHED_TABLES } from "../pipeline/refresh.mjs";
import { ROW_FLOORS } from "../pipeline/lastgood.mjs";
import { validateValues } from "../pipeline/contract.mjs";

const GENERATED_AT = "2026-09-09T12:00:00Z";

/** @param {string} name */
function json(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}
/** @param {string} name */
function text(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const contractPlayers = json("players.json").players;
const nameIndex = buildNameIndex(contractPlayers);
const teamNameIndex = buildTeamNameIndex(json("sleeper_players_raw.json"));

// --- the published table set ------------------------------------------------

test("the pipeline publishes the nine tables of design 10.2, each with a variant", () => {
  assert.deepEqual(Object.keys(PUBLISHED_TABLES).sort(), [
    "bc_tiers_half",
    "bc_tiers_ppr",
    "bc_tiers_std",
    "dp_dynasty",
    "dp_dynasty_2qb",
    "fc_dynasty",
    "fc_dynasty_2qb",
    "fc_redraft",
    "fc_redraft_2qb",
  ]);
  assert.deepEqual(PUBLISHED_TABLES.fc_redraft, { numQbs: 1 });
  assert.deepEqual(PUBLISHED_TABLES.fc_dynasty_2qb, { numQbs: 2 });
  assert.deepEqual(PUBLISHED_TABLES.dp_dynasty_2qb, { numQbs: 2 });
  assert.deepEqual(PUBLISHED_TABLES.bc_tiers_std, { ppr: 0 });
  assert.deepEqual(PUBLISHED_TABLES.bc_tiers_half, { ppr: 0.5 });
  assert.deepEqual(PUBLISHED_TABLES.bc_tiers_ppr, { ppr: 1 });
});

test("every published table has a row floor", () => {
  assert.deepEqual(Object.keys(ROW_FLOORS).sort(), Object.keys(PUBLISHED_TABLES).sort());
  assert.equal(ROW_FLOORS.fc_redraft_2qb, ROW_FLOORS.fc_redraft);
  assert.equal(ROW_FLOORS.fc_dynasty_2qb, ROW_FLOORS.fc_dynasty);
  assert.equal(ROW_FLOORS.dp_dynasty_2qb, ROW_FLOORS.dp_dynasty);
});

// --- FantasyCalc -----------------------------------------------------------

test("the four FantasyCalc tables pin 12-team half-PPR and differ only in numQbs", () => {
  assert.deepEqual(
    FC_TABLES.map((spec) => [spec.id, spec.isDynasty, spec.numQbs, spec.kind]),
    [
      ["fc_dynasty", true, 1, "dynasty"],
      ["fc_dynasty_2qb", true, 2, "dynasty"],
      ["fc_redraft", false, 1, "redraft"],
      ["fc_redraft_2qb", false, 2, "redraft"],
    ],
  );
  assert.equal(FC_NUM_TEAMS, 12);
  assert.equal(FC_PPR, 0.5);
});

test("fantasyCalcUrl builds the documented query and defaults to the pinned league shape", () => {
  assert.equal(
    fantasyCalcUrl({ isDynasty: false, numQbs: 1 }),
    "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=0.5",
  );
  assert.equal(
    fantasyCalcUrl({ isDynasty: true, numQbs: 2, numTeams: 8, ppr: 1 }),
    "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=8&ppr=1",
  );
  assert.deepEqual(
    new Set(FC_TABLES.map((spec) => fantasyCalcUrl(spec))).size,
    4,
    "each table must have its own URL",
  );
});

test("normalizeFantasyCalc maps redraft rows onto the contract fields", () => {
  const rows = json("fantasycalc_redraft_raw.json");
  const { values, dropped } = normalizeFantasyCalc(rows);
  assert.equal(Object.keys(values).length, 199);
  assert.equal(dropped, 0);

  const gibbs = values["9221"];
  assert.equal(gibbs.v, 10274);
  assert.equal(gibbs.r, 1);
  assert.equal(gibbs.pr, 1);
  assert.equal(gibbs.t, -255);
  assert.equal(gibbs.tier, 1);
  assert.ok(Math.abs(gibbs.rp - 98.27) < 1e-9, `roster percent should be 0..100, got ${gibbs.rp}`);
  assert.equal(gibbs.adp, undefined, "null maybeAdp must be omitted");
});

test("normalizeFantasyCalc handles dynasty rows and drops rows without a sleeperId", () => {
  const rows = json("fantasycalc_dynasty_raw.json");
  const { values } = normalizeFantasyCalc(rows);
  assert.equal(Object.keys(values).length, 423);

  const { values: none, dropped } = normalizeFantasyCalc([
    { player: { name: "No Id" }, value: 10 },
    { player: { sleeperId: "1" }, value: 20, overallRank: 1 },
  ]);
  assert.equal(dropped, 1);
  assert.deepEqual(none, { 1: { v: 20, r: 1 } });
});

// --- DynastyProcess --------------------------------------------------------

test("buildFpToSleeper skips NA ids", () => {
  const map = buildFpToSleeper(text("dynastyprocess_playerids_raw.csv"));
  assert.ok(map.size >= 30);
  for (const [fp, sleeper] of map) {
    assert.notEqual(fp, "NA");
    assert.notEqual(sleeper, "NA");
  }
});

test("normalizeDynastyProcess keys by sleeper id and ranks by value", () => {
  const fpToSleeper = buildFpToSleeper(text("dynastyprocess_playerids_raw.csv"));
  const result = normalizeDynastyProcess(text("dynastyprocess_values_raw.csv"), { fpToSleeper });

  assert.equal(result.parsed, 40);
  assert.equal(result.matchedById + result.unmatched, 40);
  assert.equal(result.unmatched, 2, "the fixture withholds two id rows on purpose");
  assert.equal(result.scrapeDate, "2026-09-04");

  const best = Object.values(result.values).reduce((a, b) => (a.v >= b.v ? a : b));
  assert.equal(best.r, 1, "the highest value must be overall rank 1");
  for (const row of Object.values(result.values)) {
    assert.equal(typeof row.v, "number");
    assert.equal(typeof row.r, "number");
    assert.equal(typeof row.pr, "number");
  }
});

test("the two DynastyProcess tables read different columns and recompute their own ranks", () => {
  assert.deepEqual(
    DP_TABLES.map((spec) => [spec.id, spec.numQbs]),
    [
      ["dp_dynasty", 1],
      ["dp_dynasty_2qb", 2],
    ],
  );
  const fpToSleeper = buildFpToSleeper(text("dynastyprocess_playerids_raw.csv"));
  const csv = text("dynastyprocess_values_raw.csv");
  const oneQb = normalizeDynastyProcess(csv, { fpToSleeper, numQbs: 1 });
  const twoQb = normalizeDynastyProcess(csv, { fpToSleeper, numQbs: 2 });

  assert.equal(oneQb.parsed, twoQb.parsed);
  // Ja'Marr Chase is the 1QB #1 and drops behind a quarterback in the 2QB table.
  assert.deepEqual(oneQb.values["7564"], { v: 10232, r: 1, pr: 1, ecr: 1.1 });
  assert.deepEqual(twoQb.values["7564"], { v: 9098, r: 2, pr: 1, ecr: 6.1 });

  const twoQbTop = Object.entries(twoQb.values).find(([, row]) => row.r === 1);
  assert.equal(twoQbTop[0], "4984", "a QB takes over rank 1 once QBs are scarce");
  assert.notEqual(
    Object.keys(oneQb.values).find((id) => oneQb.values[id].r === 1),
    twoQbTop[0],
  );
});

test("normalizeDynastyProcess falls back to normalized name + position", () => {
  const fpToSleeper = buildFpToSleeper(text("dynastyprocess_playerids_raw.csv"));
  const withoutIds = normalizeDynastyProcess(text("dynastyprocess_values_raw.csv"), {
    fpToSleeper: new Map(),
    nameIndex,
  });
  assert.equal(withoutIds.matchedById, 0);
  assert.ok(withoutIds.matchedByName > 30, `name fallback matched only ${withoutIds.matchedByName}`);

  const withBoth = normalizeDynastyProcess(text("dynastyprocess_values_raw.csv"), { fpToSleeper, nameIndex });
  assert.ok(withBoth.unmatched < 2, "the name fallback should recover the withheld rows");
});

test("normalizeDynastyProcess ignores rows without a value in the requested column", () => {
  const csv =
    'player,pos,ecr_1qb,ecr_2qb,value_1qb,value_2qb,fp_id\n' +
    '"No Value","RB",1,1,NA,700,"1"\n' +
    '"Has Value","RB",2,3,500,NA,"1"\n';
  const oneQb = normalizeDynastyProcess(csv, { fpToSleeper: new Map([["1", "42"]]), numQbs: 1 });
  assert.equal(oneQb.parsed, 1);
  assert.deepEqual(oneQb.values, { 42: { v: 500, r: 1, pr: 1, ecr: 2 } });

  const twoQb = normalizeDynastyProcess(csv, { fpToSleeper: new Map([["1", "42"]]), numQbs: 2 });
  assert.equal(twoQb.parsed, 1);
  assert.deepEqual(twoQb.values, { 42: { v: 700, r: 1, pr: 1, ecr: 1 } });
});

// --- Boris Chen ------------------------------------------------------------

test("the three Boris Chen formats map onto the documented file names", () => {
  assert.deepEqual(
    BC_FORMATS.map((format) => [format.id, format.ppr, format.suffix]),
    [
      ["bc_tiers_std", 0, ""],
      ["bc_tiers_half", 0.5, "-HALF"],
      ["bc_tiers_ppr", 1, "-PPR"],
    ],
  );
  assert.deepEqual(
    BC_SHARED_FILES.map((spec) => spec.file),
    ["weekly-QB.csv", "weekly-K.csv", "weekly-DST.csv"],
    "QB / K / DST rankings do not depend on reception scoring",
  );
  assert.deepEqual(
    BC_FORMAT_POSITIONS.map((spec) => BC_FORMATS.map((format) => borisChenFile(spec.stem, format.suffix))),
    [
      ["weekly-RB.csv", "weekly-RB-HALF.csv", "weekly-RB-PPR.csv"],
      ["weekly-WR.csv", "weekly-WR-HALF.csv", "weekly-WR-PPR.csv"],
      ["weekly-TE.csv", "weekly-TE-HALF.csv", "weekly-TE-PPR.csv"],
      ["weekly-FLX.csv", "weekly-FLX-HALF.csv", "weekly-FLX-PPR.csv"],
    ],
  );
  assert.equal(BC_FORMAT_POSITIONS.find((spec) => spec.pos === "FLEX").flex, true);
});

test("parseBorisChen reads the weekly tier CSV columns", () => {
  const rows = parseBorisChen(text("borischen_rb_half_raw.csv"));
  assert.ok(rows.length > 30);
  assert.deepEqual(rows[0], { rank: 1, name: "Jahmyr Gibbs", best: 1, worst: 1, avg: 1, sd: 0, tier: 1 });
});

test("resolveBorisChenId maps skill players, defenses and flex rows", () => {
  const indexes = { nameIndex, teamNameIndex };
  assert.equal(resolveBorisChenId({ name: "Jahmyr Gibbs" }, "RB", indexes), "9221");
  assert.equal(resolveBorisChenId({ name: "Jacksonville Jaguars" }, "DEF", indexes), "JAX");
  assert.equal(resolveBorisChenId({ name: "Jahmyr Gibbs" }, "FLEX", indexes), "9221");
  assert.equal(resolveBorisChenId({ name: "Nobody At All" }, "RB", indexes), null);
});

test("normalizeBorisChen merges position tiers with the flex overall rank", () => {
  const files = [
    { pos: "RB", rows: parseBorisChen(text("borischen_rb_half_raw.csv")) },
    { pos: "QB", rows: parseBorisChen(text("borischen_qb_raw.csv")) },
    { pos: "DEF", rows: parseBorisChen(text("borischen_dst_raw.csv")) },
    { pos: "FLEX", flex: true, rows: parseBorisChen(text("borischen_flx_half_raw.csv")) },
  ];
  const result = normalizeBorisChen(files, { nameIndex, teamNameIndex });

  assert.ok(result.matched > 60, `only ${result.matched} rows matched`);
  const gibbs = result.values["9221"];
  assert.equal(gibbs.tier, 1);
  assert.equal(gibbs.pr, 1);
  assert.equal(gibbs.sd, 0);

  const flexRanked = Object.values(result.values).filter((row) => typeof row.r === "number");
  assert.ok(flexRanked.length > 20, "the FLEX file should supply overall ranks");

  // Defenses join on the team name and land on the Sleeper team code.
  assert.equal(result.values.JAX.tier, 1);
  assert.equal(result.values.JAX.pr, 1);
});

test("normalizeBorisChen is format-agnostic: the shared QB rows land in every format's table", () => {
  const qb = { pos: "QB", rows: parseBorisChen(text("borischen_qb_raw.csv")) };
  const std = normalizeBorisChen([qb, { pos: "RB", rows: parseBorisChen(text("borischen_rb_half_raw.csv")) }], {
    nameIndex,
    teamNameIndex,
  });
  const qbOnly = normalizeBorisChen([qb], { nameIndex, teamNameIndex });
  for (const [id, row] of Object.entries(qbOnly.values)) assert.deepEqual(std.values[id], row);
});

test("normalizeBorisChen records unmatched names instead of guessing", () => {
  const result = normalizeBorisChen(
    [{ pos: "RB", rows: [{ rank: 1, name: "Totally Unknown Person", tier: 1, sd: 0 }] }],
    { nameIndex, teamNameIndex },
  );
  assert.deepEqual(result.values, {});
  assert.equal(result.unmatched, 1);
  assert.deepEqual(result.unmatchedNames, ["Totally Unknown Person/RB"]);
});

// --- assembled values.json --------------------------------------------------

test("normalized tables assemble into a contract-valid values.json", () => {
  const redraft = normalizeFantasyCalc(json("fantasycalc_redraft_raw.json")).values;
  const values = {
    generated_at: GENERATED_AT,
    sources: {
      fc_redraft: {
        label: "FantasyCalc redraft 1QB",
        kind: "redraft",
        variant: { numQbs: 1 },
        fetched_at: GENERATED_AT,
        ok: true,
        count: Object.keys(redraft).length,
        url: fantasyCalcUrl({ isDynasty: false, numQbs: 1 }),
        values: redraft,
      },
      fc_redraft_2qb: {
        label: "FantasyCalc redraft 2QB",
        kind: "redraft",
        variant: { numQbs: 2 },
        fetched_at: GENERATED_AT,
        ok: true,
        count: Object.keys(redraft).length,
        url: fantasyCalcUrl({ isDynasty: false, numQbs: 2 }),
        values: redraft,
      },
    },
  };
  assert.deepEqual(validateValues(values), []);
});

test("computeByes + buildPlayers stay consistent with the shipped players fixture", () => {
  const byes = computeByes(json("schedule_raw.json"));
  const rebuilt = buildPlayers(json("sleeper_players_raw.json"), byes, { generatedAt: GENERATED_AT });
  assert.equal(rebuilt.players["9221"].bye, byes.DET);
});
