// Contract validators, and a check that the committed data/ files satisfy them. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  validateAll,
  validateMeta,
  validatePlayers,
  validateProjections,
  validateSchedule,
  validateValues,
} from "../pipeline/contract.mjs";

/** @param {string} name */
function dataFile(name) {
  return JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
}

test("the committed data/ files satisfy their contracts", () => {
  const problems = validateAll({
    players: dataFile("players.json"),
    projections: dataFile("projections.json"),
    values: dataFile("values.json"),
    schedule: dataFile("schedule.json"),
    meta: dataFile("meta.json"),
  });
  for (const [file, list] of Object.entries(problems)) {
    assert.deepEqual(list, [], `${file}.json: ${list.join(" | ")}`);
  }
});

test("validatePlayers catches a count mismatch, a bad position and a mis-named defense", () => {
  const problems = validatePlayers({
    generated_at: "2026-09-09T12:00:00Z",
    count: 99,
    players: {
      9221: { id: "9221", name: "Jahmyr Gibbs", pos: "RB", team: "DET", inj: null, fp: ["RB"], bye: 6 },
      KC: { id: "KC", name: "Kansas City", pos: "DEF", team: "KC", inj: null, fp: ["DEF"], bye: 5 },
      X: { id: "wrong", name: "", pos: "P", team: "", inj: 7, fp: "RB", bye: "6" },
    },
  });
  assert.ok(problems.some((p) => p.includes("players.count 99")));
  assert.ok(problems.some((p) => p.includes('should be "KC D/ST"')));
  assert.ok(problems.some((p) => p.includes('players["X"].id')));
  assert.ok(problems.some((p) => p.includes('players["X"].pos')));
  assert.ok(problems.some((p) => p.includes('players["X"].fp')));
  assert.ok(problems.some((p) => p.includes("only 3 rows")));
});

test("validatePlayers rejects a non-object", () => {
  assert.deepEqual(validatePlayers(null), ["players: not an object"]);
  assert.deepEqual(validatePlayers([]), ["players: not an object"]);
});

test("validateProjections catches wrong week counts, non-numbers and all-zero rows", () => {
  const problems = validateProjections({
    generated_at: "2026-09-09T12:00:00Z",
    season: "2026",
    scoring: "pts_half_ppr",
    weeks: [1, 2, 3],
    players: {
      1: new Array(17).fill(1),
      2: [...new Array(17).fill(1), "x"],
      3: new Array(18).fill(0),
    },
  });
  assert.ok(problems.some((p) => p.includes("projections.scoring")));
  assert.ok(problems.some((p) => p.includes("projections.weeks must list 18")));
  assert.ok(problems.some((p) => p.includes('players["1"] must be 18 numbers')));
  assert.ok(problems.some((p) => p.includes('players["2"] contains a non-finite value')));
  assert.ok(problems.some((p) => p.includes('players["3"] is all zero')));
});

test("validateValues requires an error when ok is false and rejects non-numeric fields", () => {
  const problems = validateValues({
    generated_at: "2026-09-09T12:00:00Z",
    sources: {
      fc_redraft: {
        label: "FantasyCalc redraft",
        kind: "redraft",
        fetched_at: "2026-09-09T12:00:00Z",
        ok: false,
        count: 1,
        url: "https://api.fantasycalc.com/values/current",
        values: { 9221: { v: 10274, tier: "1" } },
      },
      mystery: { label: "", kind: "vibes", fetched_at: "yesterday", ok: true, count: 0, values: {} },
    },
  });
  assert.ok(problems.some((p) => p.includes("ok=false requires an error string")));
  assert.ok(problems.some((p) => p.includes('values["9221"].tier is not a finite number')));
  assert.ok(problems.some((p) => p.includes('sources["mystery"].kind')));
  assert.ok(problems.some((p) => p.includes('sources["mystery"].fetched_at')));
});

test("validateValues accepts a last-good table carrying ok:false plus an error", () => {
  assert.deepEqual(
    validateValues({
      generated_at: "2026-09-09T12:00:00Z",
      sources: {
        bc_tiers: {
          label: "Boris Chen half-PPR wk 1",
          kind: "tiers",
          week: 1,
          fetched_at: "2026-09-08T06:00:00Z",
          ok: false,
          error: "row count 0 below floor 100",
          count: 1,
          url: "https://s3-us-west-1.amazonaws.com/fftiers/out/weekly-<POS>.csv",
          values: { 9221: { tier: 1, pr: 1, sd: 0 } },
        },
      },
    }),
    [],
  );
});

test("validateSchedule catches missing byes and malformed games", () => {
  const problems = validateSchedule({
    generated_at: "2026-09-09T12:00:00Z",
    season: 2026,
    byes: { KC: "five" },
    games: [{ w: 0, home: "", away: "CHI", date: 20260913 }],
  });
  assert.ok(problems.some((p) => p.includes("schedule.season must be a string")));
  assert.ok(problems.some((p) => p.includes('schedule.byes["KC"]')));
  assert.ok(problems.some((p) => p.includes("games[0].w is invalid")));
  assert.ok(problems.some((p) => p.includes("games[0].home is empty")));
  assert.ok(problems.some((p) => p.includes("games[0].date")));
  assert.ok(problems.some((p) => p.includes("only 1 games")));
});

test("validateMeta catches a zero week, a missing league id and a bad source entry", () => {
  const problems = validateMeta({
    generated_at: "2026-09-09T12:00:00Z",
    season: "2026",
    week: 0,
    league_id: "",
    pipeline_version: 1,
    sources: { fc_redraft: { ok: false, fetched_at: "2026-09-09T12:00:00Z", count: 0 } },
  });
  assert.ok(problems.some((p) => p.includes("meta.week")));
  assert.ok(problems.some((p) => p.includes("meta.league_id is empty")));
  assert.ok(problems.some((p) => p.includes("meta.pipeline_version")));
  assert.ok(problems.some((p) => p.includes("ok=false requires an error string")));
});

test("validateMeta accepts a clean meta object", () => {
  assert.deepEqual(
    validateMeta({
      generated_at: "2026-09-09T12:00:00Z",
      season: "2026",
      week: 1,
      league_id: "1394476745138147328",
      pipeline_version: "1.0.0",
      sources: { players: { ok: true, fetched_at: "2026-09-09T12:00:00Z", count: 869 } },
    }),
    [],
  );
});
