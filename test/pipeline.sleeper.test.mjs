// Sleeper normalizers on the 2026-09-09 raw samples. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SEASON_WEEKS,
  accumulateProjectionWeek,
  buildNameIndex,
  buildPlayers,
  buildSchedule,
  buildTeamNameIndex,
  computeByes,
  finalizeProjections,
  weeklyPoints,
} from "../pipeline/sources/sleeper.mjs";
import { validatePlayers, validateProjections, validateSchedule } from "../pipeline/contract.mjs";

const GENERATED_AT = "2026-09-09T12:00:00Z";
const LEAGUE_ID = "1394476745138147328";

/** @param {string} name */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const league = fixture("league.json");
const scoring = league.scoring_settings;
const rawSchedule = fixture("schedule_raw.json");
const rawPlayers = fixture("sleeper_players_raw.json");
const rawProjections = fixture("sleeper_projections_wk1_raw.json");

const byes = computeByes(rawSchedule);
const schedule = buildSchedule(rawSchedule, { season: "2026", generatedAt: GENERATED_AT });
const players = buildPlayers(rawPlayers, byes, { generatedAt: GENERATED_AT });

test("computeByes gives all 32 teams exactly one bye", () => {
  assert.equal(Object.keys(byes).length, 32);
  assert.equal(byes.KC, 5);
  assert.equal(byes.DET, 6);
  assert.equal(byes.ARI, 14);
  for (const week of Object.values(byes)) assert.ok(week >= 5 && week <= 14, `implausible bye ${week}`);
});

test("computeByes keeps a canceled game in the schedule (DAL/SEA wk6 is not a second bye)", () => {
  const canceled = rawSchedule.find((game) => game.status === "canceled");
  assert.ok(canceled, "fixture should contain the canceled DAL/SEA game");
  assert.notEqual(byes[canceled.home], canceled.week);
  assert.notEqual(byes[canceled.away], canceled.week);
});

test("buildSchedule is contract-valid and deterministically ordered", () => {
  assert.deepEqual(validateSchedule(schedule), []);
  assert.equal(schedule.games.length, rawSchedule.length);
  const again = buildSchedule([...rawSchedule].reverse(), { season: "2026", generatedAt: GENERATED_AT });
  assert.equal(JSON.stringify(again), JSON.stringify(schedule));
});

test("buildPlayers keeps the six fantasy positions, active and on a team", () => {
  const ids = Object.keys(players.players);
  assert.equal(players.count, ids.length);
  assert.deepEqual(ids.sort(), ["19", "4866", "6794", "9221", "11564", "12529", "JAX", "KC"].sort());
  assert.equal(players.players["1379"], undefined, "FB is not a fantasy position");
  assert.equal(players.players["3050"], undefined, "inactive player is dropped");
  assert.equal(players.players["184"], undefined, "player without a team is dropped");
});

test("buildPlayers maps the contract fields, including bye and injury", () => {
  const gibbs = players.players["9221"];
  assert.deepEqual(gibbs, {
    id: "9221",
    name: "Jahmyr Gibbs",
    pos: "RB",
    team: "DET",
    inj: null,
    age: rawPlayers["9221"].age,
    exp: rawPlayers["9221"].years_exp,
    num: rawPlayers["9221"].number,
    dc: rawPlayers["9221"].depth_chart_order,
    fp: ["RB"],
    bye: 6,
  });
  assert.equal(players.players["12529"].inj, "Out");
});

test("buildPlayers names team defenses <TEAM> D/ST with null bio fields", () => {
  assert.deepEqual(players.players.KC, {
    id: "KC",
    name: "KC D/ST",
    pos: "DEF",
    team: "KC",
    inj: null,
    age: null,
    exp: null,
    num: null,
    dc: null,
    fp: ["DEF"],
    bye: 5,
  });
});

test("weeklyPoints equals the manual league-exact sum for Jahmyr Gibbs wk1", () => {
  const gibbs = rawProjections.find((row) => row.player_id === "9221");
  assert.ok(gibbs, "fixture should contain Gibbs");

  // Written out by hand from the league's scoring_settings — nothing from the module.
  const manualTerms = [
    ["rec", 0.5],
    ["rec_yd", 0.1],
    ["rec_td", 6],
    ["rec_2pt", 2],
    ["rush_yd", 0.1],
    ["rush_td", 6],
    ["rush_2pt", 2],
    ["fum_lost", -2],
  ];
  let manual = 0;
  for (const [key, weight] of manualTerms) {
    assert.equal(scoring[key], weight, `league scoring for ${key}`);
    manual += gibbs.stats[key] * weight;
  }

  assert.ok(Math.abs(weeklyPoints(gibbs.stats, scoring) - manual) < 1e-9);
  // bonus_rec_rb is in the projection but not in this league's scoring, so it must be ignored.
  assert.ok(gibbs.stats.bonus_rec_rb > 0);
  assert.equal(scoring.bonus_rec_rb, undefined);
  // pts_half_ppr must never be an input either.
  assert.ok(gibbs.stats.pts_half_ppr > 0);
  assert.equal(scoring.pts_half_ppr, undefined);
});

test("league-exact points stay within 0.2 of Sleeper's pts_half_ppr cross-check", () => {
  for (const id of ["9221", "4866", "6794", "11564"]) {
    const row = rawProjections.find((r) => r.player_id === id);
    const diff = Math.abs(weeklyPoints(row.stats, scoring) - row.stats.pts_half_ppr);
    assert.ok(diff <= 0.2, `${id} differs by ${diff.toFixed(3)}`);
  }
});

test("weeklyPoints scores a team defense from the league's DST keys", () => {
  const kc = rawProjections.find((row) => row.player_id === "KC");
  const expected =
    kc.stats.sack * scoring.sack +
    kc.stats.int * scoring.int +
    kc.stats.def_td * scoring.def_td +
    kc.stats.blk_kick * scoring.blk_kick +
    kc.stats.fum_rec * scoring.fum_rec +
    kc.stats.pts_allow_14_20 * scoring.pts_allow_14_20;
  assert.ok(Math.abs(weeklyPoints(kc.stats, scoring) - expected) < 1e-9);
});

test("weeklyPoints is 0 for missing stats or missing scoring", () => {
  assert.equal(weeklyPoints(null, scoring), 0);
  assert.equal(weeklyPoints({ rec: 5 }, null), 0);
  assert.equal(weeklyPoints({ not_a_stat: 5 }, scoring), 0);
});

test("accumulateProjectionWeek keeps fantasy positions and known ids only", () => {
  const allowedIds = new Set(Object.keys(players.players));
  const target = new Map();
  const result = accumulateProjectionWeek(target, 1, rawProjections, scoring, { allowedIds });

  assert.equal(target.has("1379"), false, "FB row must be skipped");
  assert.equal(target.has("12713"), false, "kicker outside allowedIds must be skipped");
  assert.ok(result.skippedPosition >= 1);
  assert.ok(result.skippedUnknown >= 1);

  const gibbs = target.get("9221");
  assert.equal(gibbs.length, SEASON_WEEKS);
  assert.ok(Math.abs(gibbs[0] - 21.36) < 0.01, `expected ~21.36, got ${gibbs[0]}`);
  assert.deepEqual(gibbs.slice(1), new Array(SEASON_WEEKS - 1).fill(0));
});

test("finalizeProjections drops all-zero players and is contract-valid", () => {
  const allowedIds = new Set(Object.keys(players.players));
  const target = new Map();
  // Enough rows to clear the validator's minimum: replay week 1 into every week.
  for (let week = 1; week <= SEASON_WEEKS; week += 1) {
    accumulateProjectionWeek(target, week, rawProjections, scoring, { allowedIds });
  }
  target.set("0000", new Array(SEASON_WEEKS).fill(0));

  const projections = finalizeProjections(target, {
    season: "2026",
    leagueId: LEAGUE_ID,
    generatedAt: GENERATED_AT,
  });
  assert.equal(projections.scoring, `league:${LEAGUE_ID}`);
  assert.equal(projections.weeks.length, SEASON_WEEKS);
  assert.equal(projections.players["0000"], undefined, "all-zero player is dropped");
  assert.ok(Object.keys(projections.players).length >= 5);

  const problems = validateProjections(projections).filter((p) => !p.startsWith("projections: only"));
  assert.deepEqual(problems, []);
});

test("buildNameIndex keys on name+position and nulls ambiguous names", () => {
  const index = buildNameIndex(players.players);
  assert.equal(index.get("jahmyrgibbs|RB"), "9221");
  assert.equal(index.get("jahmyrgibbs|WR"), undefined);

  const ambiguous = buildNameIndex({
    a: { id: "a", name: "John Smith", pos: "WR" },
    b: { id: "b", name: "John Smith", pos: "WR" },
  });
  assert.equal(ambiguous.get("johnsmith|WR"), null);
});

test("buildTeamNameIndex maps full and short team names to the team code", () => {
  const index = buildTeamNameIndex(rawPlayers);
  assert.equal(index.get("kansascitychiefs"), "KC");
  assert.equal(index.get("chiefs"), "KC");
  assert.equal(index.get("kc"), "KC");
  assert.equal(index.get("jacksonvillejaguars"), "JAX");
});

test("a small players fixture still satisfies the players contract shape", () => {
  const problems = validatePlayers(players).filter((p) => !p.startsWith("players: only"));
  assert.deepEqual(problems, []);
});
