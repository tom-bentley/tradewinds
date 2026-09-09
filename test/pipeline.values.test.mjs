// Value-source normalizers on the 2026-09-09 raw samples. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fantasyCalcParams, fantasyCalcUrl, normalizeFantasyCalc } from "../pipeline/sources/fantasycalc.mjs";
import { buildFpToSleeper, normalizeDynastyProcess } from "../pipeline/sources/dynastyprocess.mjs";
import { normalizeBorisChen, parseBorisChen, resolveBorisChenId } from "../pipeline/sources/borischen.mjs";
import { buildNameIndex, buildPlayers, buildTeamNameIndex, computeByes } from "../pipeline/sources/sleeper.mjs";
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

const league = json("league.json");
const contractPlayers = json("players.json").players;
const nameIndex = buildNameIndex(contractPlayers);
const teamNameIndex = buildTeamNameIndex(json("sleeper_players_raw.json"));

// --- FantasyCalc -----------------------------------------------------------

test("fantasyCalcParams reads numQbs / numTeams / ppr from the league", () => {
  assert.deepEqual(fantasyCalcParams(league), { numQbs: 1, numTeams: 8, ppr: 0.5 });
  assert.deepEqual(
    fantasyCalcParams({
      roster_positions: ["QB", "SUPER_FLEX", "RB", "BN"],
      total_rosters: 12,
      scoring_settings: { rec: 1 },
    }),
    { numQbs: 2, numTeams: 12, ppr: 1 },
  );
});

test("fantasyCalcUrl builds the documented query", () => {
  assert.equal(
    fantasyCalcUrl({ isDynasty: false, numQbs: 1, numTeams: 8, ppr: 0.5 }),
    "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=8&ppr=0.5",
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

test("normalizeDynastyProcess ignores rows without a 1QB value", () => {
  const csv = 'player,pos,ecr_1qb,value_1qb,fp_id\n"No Value","RB",1,NA,"1"\n"Has Value","RB",2,500,"1"\n';
  const result = normalizeDynastyProcess(csv, { fpToSleeper: new Map([["1", "42"]]) });
  assert.equal(result.parsed, 1);
  assert.deepEqual(result.values, { 42: { v: 500, r: 1, pr: 1, ecr: 2 } });
});

// --- Boris Chen ------------------------------------------------------------

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
        label: "FantasyCalc redraft",
        kind: "redraft",
        fetched_at: GENERATED_AT,
        ok: true,
        count: Object.keys(redraft).length,
        url: fantasyCalcUrl({ isDynasty: false, ...fantasyCalcParams(league) }),
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
