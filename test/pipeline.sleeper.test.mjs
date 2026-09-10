// Sleeper normalizers on the 2026-09-09 raw samples. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PROJECTIONS_VERSION,
  PROJECTION_EXCLUDED_KEYS,
  SEASON_WEEKS,
  accumulateStatWeek,
  buildNameIndex,
  buildPlayers,
  buildSchedule,
  buildTeamNameIndex,
  computeByes,
  decodeStatLine,
  finalizeProjections,
  statLinePoints,
  statPairs,
  weeklyPoints,
} from "../pipeline/sources/sleeper.mjs";
import { validatePlayers, validateProjections, validateSchedule } from "../pipeline/contract.mjs";

const GENERATED_AT = "2026-09-09T12:00:00Z";

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
const allowedIds = new Set(Object.keys(players.players));

/**
 * Encode the raw week-1 sample as projections v2.
 * @param {{ weeks?: number }} [options] replay week 1 into `weeks` weeks
 */
function encodeSample(options = {}) {
  const { weeks = 1 } = options;
  /** @type {Map<string, any>} */
  const target = new Map();
  for (let week = 1; week <= weeks; week += 1) {
    accumulateStatWeek(target, week, rawProjections, { allowedIds });
  }
  return finalizeProjections(target, { season: "2026", generatedAt: GENERATED_AT });
}

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
    injPart: null,
    injNotes: null,
    newsAt: rawPlayers["9221"].news_updated,
    age: rawPlayers["9221"].age,
    exp: rawPlayers["9221"].years_exp,
    num: rawPlayers["9221"].number,
    dc: rawPlayers["9221"].depth_chart_order,
    fp: ["RB"],
    bye: 6,
  });
  assert.equal(players.players["12529"].inj, "Out");
});

test("buildPlayers carries the v2.1 injury detail the advisor needs (design §12.3)", () => {
  // "Out" alone cannot say how long; "Ankle" is what picks a row out of the duration table.
  const henderson = players.players["12529"];
  assert.equal(henderson.injPart, "Ankle");
  assert.equal(henderson.injNotes, null);
  assert.equal(henderson.newsAt, rawPlayers["12529"].news_updated);
  assert.equal(typeof henderson.newsAt, "number");

  // Empty strings are as common as nulls in the dump, and "" is not a body part.
  const built = buildPlayers(
    {
      9999: {
        player_id: "9999",
        position: "WR",
        active: true,
        team: "DET",
        full_name: "Blank Fields",
        injury_status: "",
        injury_body_part: "   ",
        injury_notes: "",
        news_updated: null,
      },
    },
    byes,
    { generatedAt: GENERATED_AT },
  );
  assert.deepEqual(
    { ...built.players["9999"] },
    {
      id: "9999",
      name: "Blank Fields",
      pos: "WR",
      team: "DET",
      inj: null,
      injPart: null,
      injNotes: null,
      newsAt: null,
      age: null,
      exp: null,
      num: null,
      dc: null,
      fp: [],
      bye: 6,
    },
  );
  // key order is fixed, so a rerun on identical input is byte-identical
  assert.deepEqual(Object.keys(built.players["9999"]), [
    "id",
    "name",
    "pos",
    "team",
    "inj",
    "injPart",
    "injNotes",
    "newsAt",
    "age",
    "exp",
    "num",
    "dc",
    "fp",
    "bye",
  ]);
});

test("buildPlayers names team defenses <TEAM> D/ST with null bio fields", () => {
  assert.deepEqual(players.players.KC, {
    id: "KC",
    name: "KC D/ST",
    pos: "DEF",
    team: "KC",
    inj: null,
    injPart: null,
    injNotes: null,
    newsAt: null,
    age: null,
    exp: null,
    num: null,
    dc: null,
    fp: ["DEF"],
    bye: 5,
  });
});

// --- projections v2: raw stat lines ----------------------------------------

test("statPairs drops derived keys and zeros, rounds to 2 decimals and sorts by key", () => {
  assert.deepEqual(
    statPairs({
      rush_yd: 12.345,
      rec: 0,
      pts_half_ppr: 18.4,
      pts_ppr: 18.4,
      pts_std: 18.4,
      gp: 1,
      cmp_pct: 66.4,
      adp_dd_ppr: 999,
      pos_adp_dd_ppr: 999,
      bonus_rec_rb: 1.5,
      broken: Number.NaN,
      text: "nope",
    }),
    [
      ["bonus_rec_rb", 1.5],
      ["rush_yd", 12.35],
    ],
  );
  assert.equal(statPairs({ rec: 0, gp: 1 }), null, "a line with nothing scoreable is not shipped");
  assert.equal(statPairs(null), null);
});

test("the excluded key list is exactly the seven derived/meta keys of design 10.1", () => {
  assert.deepEqual(
    [...PROJECTION_EXCLUDED_KEYS].sort(),
    ["adp_dd_ppr", "cmp_pct", "gp", "pos_adp_dd_ppr", "pts_half_ppr", "pts_ppr", "pts_std"],
  );
});

test("accumulateStatWeek keeps fantasy positions and known ids only", () => {
  /** @type {Map<string, any>} */
  const target = new Map();
  const result = accumulateStatWeek(target, 1, rawProjections, { allowedIds });

  assert.equal(target.has("1379"), false, "FB row must be skipped");
  assert.equal(target.has("12713"), false, "kicker outside allowedIds must be skipped");
  assert.equal(result.skippedPosition, 1);
  assert.equal(result.skippedUnknown, 1);
  assert.equal(result.kept, 6);

  const gibbs = target.get("9221");
  assert.equal(gibbs.length, SEASON_WEEKS);
  assert.deepEqual(gibbs.slice(1), new Array(SEASON_WEEKS - 1).fill(null));
});

test("finalizeProjections emits the v2 shape: version, keys vocabulary and 18 week entries", () => {
  const projections = encodeSample();
  assert.equal(projections.version, PROJECTIONS_VERSION);
  assert.equal(projections.season, "2026");
  assert.deepEqual(projections.weeks, Array.from({ length: SEASON_WEEKS }, (_, i) => i + 1));
  assert.equal(projections.scoring, undefined, "v2 is league-agnostic — no scoring field");

  assert.ok(projections.keys.length > 20, `only ${projections.keys.length} stat keys`);
  assert.equal(new Set(projections.keys).size, projections.keys.length, "keys must be unique");
  for (const key of projections.keys) assert.equal(PROJECTION_EXCLUDED_KEYS.has(key), false);

  const gibbs = projections.players["9221"];
  assert.equal(gibbs.length, SEASON_WEEKS);
  assert.deepEqual(gibbs.slice(1), new Array(SEASON_WEEKS - 1).fill(0), "weeks with no projection are 0");
  assert.ok(Array.isArray(gibbs[0]) && gibbs[0].length % 2 === 0);
  assert.equal(decodeStatLine(gibbs[0], projections.keys).rec_yd, 30.67);
});

test("finalizeProjections orders players by id and grows the vocabulary deterministically", () => {
  const first = encodeSample();
  const second = encodeSample();
  assert.equal(JSON.stringify(first), JSON.stringify(second), "a rerun must be byte-identical");
  assert.deepEqual(Object.keys(first.players), ["4866", "6794", "9221", "11564", "JAX", "KC"]);

  // The vocabulary is the first-appearance order of the id walk, so the first player's own
  // stat names lead the array in alphabetical order.
  const leadPairs = decodeStatLine(first.players["4866"][0], first.keys);
  assert.deepEqual(first.keys.slice(0, Object.keys(leadPairs).length), Object.keys(leadPairs).sort());
});

test("finalizeProjections drops players with no projected week and is contract-valid", () => {
  /** @type {Map<string, any>} */
  const target = new Map();
  for (let week = 1; week <= SEASON_WEEKS; week += 1) {
    accumulateStatWeek(target, week, rawProjections, { allowedIds });
  }
  target.set("0000", new Array(SEASON_WEEKS).fill(null));

  const projections = finalizeProjections(target, { season: "2026", generatedAt: GENERATED_AT });
  assert.equal(projections.players["0000"], undefined, "a player with no week is dropped");

  const problems = validateProjections(projections).filter((p) => !p.startsWith("projections: only"));
  assert.deepEqual(problems, []);
});

test("ANCHOR 1: v2 client scoring equals the v1 league-exact formula on identical raw rows", () => {
  const projections = encodeSample();
  const ids = Object.keys(projections.players);
  assert.equal(ids.length, 6, "the sample should carry six scoreable players");

  for (const id of ids) {
    const raw = rawProjections.find((row) => row.player_id === id);
    const client = statLinePoints(projections.players[id][0], projections.keys, scoring);
    const exact = weeklyPoints(raw.stats, scoring);
    assert.ok(
      Math.abs(client - exact) < 1e-9,
      `${id}: client ${client} vs league-exact ${exact} (diff ${Math.abs(client - exact)})`,
    );
    assert.ok(exact > 0, `${id} should score something`);
  }
});

test("ANCHOR 1 covers a QB, a kicker-free DEF and a RB, and ignores unscored keys", () => {
  const projections = encodeSample();
  const gibbs = decodeStatLine(projections.players["9221"][0], projections.keys);
  // bonus_rec_rb is shipped (some leagues score it) but Boyball does not, so it cannot move points.
  assert.ok(gibbs.bonus_rec_rb > 0);
  assert.equal(scoring.bonus_rec_rb, undefined);
  const withoutBonus = { ...gibbs };
  delete withoutBonus.bonus_rec_rb;
  const points = Object.entries(withoutBonus).reduce((sum, [k, v]) => sum + v * (scoring[k] ?? 0), 0);
  assert.ok(Math.abs(points - weeklyPoints(rawProjections.find((r) => r.player_id === "9221").stats, scoring)) < 1e-9);

  const kc = decodeStatLine(projections.players.KC[0], projections.keys);
  assert.equal(kc.pts_half_ppr, undefined, "derived keys never ship");
  assert.ok(kc.sack > 0 && kc.pts_allow_14_20 > 0);

  const qb = decodeStatLine(projections.players["11564"][0], projections.keys);
  assert.ok(qb.pass_yd > 0 && qb.pass_td > 0);
});

test("decodeStatLine is the inverse of the encoding and tolerates a 0 week", () => {
  const projections = encodeSample();
  assert.deepEqual(decodeStatLine(0, projections.keys), {});
  assert.deepEqual(decodeStatLine(undefined, projections.keys), {});
  const decoded = decodeStatLine(projections.players["6794"][0], projections.keys);
  const raw = rawProjections.find((row) => row.player_id === "6794").stats;
  for (const [key, value] of Object.entries(decoded)) assert.equal(value, raw[key]);
});

test("statLinePoints is 0 without an entry or without scoring", () => {
  const projections = encodeSample();
  assert.equal(statLinePoints(0, projections.keys, scoring), 0);
  assert.equal(statLinePoints(projections.players.KC[0], projections.keys, null), 0);
  assert.equal(statLinePoints(projections.players.KC[0], projections.keys, {}), 0);
});

// --- weeklyPoints: the v1 reference the anchor is measured against ----------

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

// --- id indexes -------------------------------------------------------------

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
