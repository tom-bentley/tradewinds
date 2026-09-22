// 004 design §3.1 — the player-intelligence seams in context.js: stats, games, dvp and dossiers are
// OPTIONAL inputs whose builders never throw and collapse to empty collections, and buildContext
// exposes them on ctx without changing anything else.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildContext,
  buildStats,
  buildGames,
  buildDvp,
  buildDossiers,
  statsRow,
  gameFor,
} from "../src/engine/context.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

let input;
before(() => {
  input = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    state: fixture("state.json"),
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
  };
});

const STATS = {
  version: 1,
  season: "2026",
  weeks: [1, 2],
  partial: [2],
  keys: ["off_snp", "tm_off_snp", "rec_tgt", "rec"],
  players: {
    "1": [[0, 60, 1, 70, 2, 8, 3, 6], [0, 55, 1, 65, 2, 10, 3, 7]],
    "2": [0, [0, 30, 1, 65]],
    "3": [0, 0], // never played → dropped
    "4": "garbage",
  },
  std: { "1": [0, 115, 1, 135, 2, 18, 3, 13] },
  teams: { kc: { "1": { tgt: 31, snp: 70, att: 27, rush: 22 }, "2": { tgt: 33, snp: 65 } } },
};

test("buildStats decodes pair lists into dense vectors, keeps std, teams and partial weeks", () => {
  const b = buildStats(STATS);
  assert.deepEqual(b.keys, ["off_snp", "tm_off_snp", "rec_tgt", "rec"]);
  assert.deepEqual(b.weeks, [1, 2]);
  assert.deepEqual([...b.partial], [2]);
  const one = b.stats.get("1");
  assert.deepEqual(one.rows, [[60, 70, 8, 6], [55, 65, 10, 7]]);
  assert.deepEqual(one.std, [115, 135, 18, 13]);
  const two = b.stats.get("2");
  assert.equal(two.rows[0], null, "scalar 0 is an empty week");
  assert.deepEqual(two.rows[1], [30, 65, 0, 0]);
  assert.equal(two.std, null);
  assert.equal(b.stats.has("3"), false, "a player with no played week is dropped");
  assert.equal(b.stats.has("4"), false, "malformed rows are skipped");
  assert.deepEqual(b.teams.get("KC|1"), { tgt: 31, snp: 70, att: 27, rush: 22 });
  assert.deepEqual(b.teams.get("KC|2"), { tgt: 33, snp: 65, att: 0, rush: 0 });
});

test("buildStats / buildDvp / buildDossiers collapse garbage to empty collections", () => {
  for (const bad of [undefined, null, 7, "x", [], {}, { version: 2, keys: [], players: {} }, { version: 1 }]) {
    const s = buildStats(bad);
    assert.equal(s.stats.size, 0);
    assert.deepEqual(s.keys, []);
    assert.equal(s.teams.size, 0);
    assert.equal(buildDvp(bad).teams.size, 0);
    assert.equal(buildDossiers(bad).size, 0);
  }
});

test("buildGames threads the schedule first and merges games.json rows onto the same team-week", () => {
  const schedule = { byes: {}, games: [{ week: 3, home: "buf", away: "lac" }, { week: 3, home: "GB", away: "ATL" }] };
  const games = {
    version: 1,
    games: [{ id: "202610304", week: 3, home: "BUF", away: "LAC", spread: -6, total: 43.5, roof: "outdoors" }],
  };
  const b = buildGames(games, schedule);
  assert.equal(b.games.size, 2);
  const buf = b.games.get(b.gameOf.get("BUF|3"));
  assert.equal(buf.id, "202610304", "the games.json id replaces the synthetic schedule id");
  assert.equal(buf.total, 43.5);
  assert.equal(b.gameOf.get("LAC|3"), "202610304", "both teams index the merged game");
  const gb = b.games.get(b.gameOf.get("ATL|3"));
  assert.equal(gb.home, "GB");
  assert.equal(gb.spread, undefined, "schedule-only games carry no lines");
  assert.equal(buildGames(null, null).games.size, 0);
  assert.equal(buildGames({ version: 1, games: [{ week: "x" }] }, {}).games.size, 0);
});

test("buildDvp keeps allowed arrays with nulls, std and the PPR provenance", () => {
  const b = buildDvp({
    version: 1,
    weeks: [1, 2],
    teams: { kc: { gp: 2, allowed: { WR: [31, null], TE: [8.8, 4.1] }, std: { WR: 31, TE: 12.9 }, ppr_ref: { WR: 40 } } },
  });
  assert.deepEqual(b.weeks, [1, 2]);
  const kc = b.teams.get("KC");
  assert.equal(kc.gp, 2);
  assert.deepEqual(kc.allowed.WR, [31, null]);
  assert.equal(kc.std.TE, 12.9);
  assert.deepEqual(kc.pprRef, { WR: 40 });
});

test("buildDossiers keeps raw slice rows and inherits the file-level rubric", () => {
  const b = buildDossiers({ v: 1, rubric: "r7-v1", players: { "11604": { sk: "Out|Knee|", depth: "deep" }, "9": null } });
  assert.equal(b.size, 1);
  assert.equal(b.get("11604").rubric, "r7-v1");
  assert.equal(b.get("11604").sk, "Out|Knee|");
  assert.equal(buildDossiers({ v: 2, players: { a: {} } }).size, 0, "unknown file version is ignored");
});

test("buildContext exposes empty intelligence inputs on a 0.4-era data set and full ones when present", () => {
  const plain = buildContext(input, { leagueId: input.league.league_id });
  assert.equal(plain.stats.size, 0);
  assert.deepEqual(plain.statKeys, []);
  assert.equal(plain.teamStats.size, 0);
  assert.equal(plain.dvp.size, 0);
  assert.equal(plain.dossiers.size, 0);
  assert.equal(statsRow(plain, "1"), null);
  // schedule.json games are threaded into gameOf even without games.json
  const anyTeam = plain.byes && Object.keys(plain.byes)[0];
  if (anyTeam) assert.ok(plain.games.size > 0, "schedule games populate ctx.games");

  const rich = buildContext(
    { ...input, stats: STATS, dvp: { version: 1, weeks: [1], teams: { KC: { gp: 1, allowed: { WR: [31] }, std: { WR: 31 } } } }, dossiers: { v: 1, rubric: "r7-v1", players: { "1": { sk: "||" } } } },
    { leagueId: input.league.league_id },
  );
  assert.equal(rich.stats.size, 2);
  assert.deepEqual(statsRow(rich, "1").rows[0], [60, 70, 8, 6]);
  assert.equal(rich.dvp.get("KC").gp, 1);
  assert.equal(rich.dossiers.get("1").rubric, "r7-v1");
  // everything else is untouched
  assert.equal(rich.week, plain.week);
  assert.equal(rich.players.size, plain.players.size);
  assert.equal(gameFor(rich, "NOPE", 1), null);
});
