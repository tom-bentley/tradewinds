// data/games.json — the three-source join (004 design §2.2). Fixtures are live pulls from
// 2026-09-22: the nflverse season slice, one ESPN scoreboard body and one Open-Meteo forecast.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ESPN_TO_SLEEPER,
  GAMES_VERSION,
  NFLVERSE_TO_SLEEPER,
  buildGames,
  espnTeam,
  espnWeekIndex,
  fetchNflverseGames,
  isoInstant,
  needsWeather,
  nflverseTeam,
  pickHour,
} from "../pipeline/sources/games.mjs";
import { validateGames } from "../pipeline/contract.mjs";
import { resolveOptional } from "../pipeline/lastgood.mjs";

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fixture = (name) => JSON.parse(read(name));

const CSV = read("nfldata_games_2026_raw.csv");
const ESPN_BODY = fixture("espn_scoreboard_2026_wk3_raw.json");
const METEO = fixture("open_meteo_2026_raw.json");
const GAMES = fixture("games_2026.json");
const SCHEDULE = fixture("schedule.json");
const AT = "2026-09-22T16:00:00Z";

test("team codes: nflverse writes the Rams LA, Sleeper writes LAR", () => {
  // Measured live over the whole 2026 schedule: 31 of 32 codes agree and this is the one that
  // does not. Washington is WAS in BOTH vocabularies; WSH is ESPN's spelling.
  assert.deepEqual(NFLVERSE_TO_SLEEPER, { LA: "LAR" });
  assert.equal(nflverseTeam("LA"), "LAR");
  assert.equal(nflverseTeam("LAC"), "LAC");
  assert.equal(nflverseTeam("WAS"), "WAS");
  assert.equal(nflverseTeam(""), null);
  assert.equal(espnTeam("WSH"), "WAS");
  assert.equal(ESPN_TO_SLEEPER.LA, "LAR");
});

test("the nflverse slice parses and flips the spread sign", async () => {
  const { rows } = await fetchNflverseGames(2026, { text: CSV });
  assert.equal(rows.length, 272);
  assert.ok(rows.every((row) => row.week >= 1 && row.week <= 18));
  assert.ok(rows.every((row) => row.nv && row.nv.startsWith("2026_")));
  // nflverse `spread_line` is POSITIVE when the home team is favoured; design §2.2 wants negative.
  // Cross-check against the moneylines, which are unambiguous: the favourite's is the negative one.
  let checked = 0;
  for (const row of rows) {
    if (row.spread === null || row.mlHome === null || row.mlAway === null || row.spread === 0) continue;
    const homeFavoured = row.mlHome < row.mlAway;
    assert.equal(row.spread < 0, homeFavoured, `${row.nv} spread ${row.spread} vs ml ${row.mlHome}/${row.mlAway}`);
    checked += 1;
  }
  assert.ok(checked > 30, `only ${checked} games cross-checked`);  // only played/near weeks carry lines
  // Rams rows arrive as LA in the CSV and must leave as LAR.
  assert.ok(rows.some((row) => row.home === "LAR" || row.away === "LAR"));
  assert.ok(!rows.some((row) => row.home === "LA" || row.away === "LA"));
});

test("espnWeekIndex reduces a scoreboard body to the join keys", () => {
  const index = espnWeekIndex(ESPN_BODY, 3);
  assert.equal(index.size, ESPN_BODY.events.length);
  const [key, value] = [...index][0];
  assert.match(key, /^3\|[A-Z]{2,4}@[A-Z]{2,4}$/);
  assert.match(value.espn, /^\d+$/);
  assert.match(value.kick, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(typeof value.indoor, "boolean");
  assert.deepEqual(espnWeekIndex({}, 3), new Map());
  assert.deepEqual(espnWeekIndex(null, 3), new Map());
});

test("isoInstant normalises ESPN's kickoff to whole seconds", () => {
  assert.equal(isoInstant("2026-09-25T00:15Z"), "2026-09-25T00:15:00Z");
  assert.equal(isoInstant("2026-09-25T00:15:30Z"), "2026-09-25T00:15:30Z");
  assert.equal(isoInstant("nonsense"), null);
  assert.equal(isoInstant(null), null);
});

test("pickHour reads the forecast at kickoff and refuses one that does not cover it", () => {
  const kick = `${METEO.hourly.time[20]}Z`;
  const at = pickHour(METEO, kick);
  assert.equal(at.windMph, Math.round(METEO.hourly.wind_speed_10m[20] * 10) / 10);
  assert.equal(at.tempF, Math.round(METEO.hourly.temperature_2m[20]));
  assert.equal(at.precipPct, Math.round(METEO.hourly.precipitation_probability[20]));
  // A kickoff outside the horizon gets nulls, never the nearest hour it happens to have.
  assert.deepEqual(pickHour(METEO, "2027-01-01T18:00:00Z"), { windMph: null, tempF: null, precipPct: null });
  assert.deepEqual(pickHour({}, kick), { windMph: null, tempF: null, precipPct: null });
});

test("needsWeather skips indoor venues and anything past the forecast horizon", () => {
  const now = Date.parse("2026-09-22T16:00:00Z");
  const base = { roof: "outdoors", indoor: false, kick: "2026-09-27T17:00:00Z" };
  assert.equal(needsWeather(base, now), true);
  assert.equal(needsWeather({ ...base, indoor: true }, now), false);
  assert.equal(needsWeather({ ...base, roof: "dome", indoor: null }, now), false);
  assert.equal(needsWeather({ ...base, roof: "closed", indoor: null }, now), false);
  assert.equal(needsWeather({ ...base, roof: "open", indoor: null }, now), true);
  assert.equal(needsWeather({ ...base, roof: null, indoor: null }, now), false, "unknown roof is not a guess");
  assert.equal(needsWeather({ ...base, kick: "2026-11-01T17:00:00Z" }, now), false);
  assert.equal(needsWeather({ ...base, kick: null }, now), false);
});

test("buildGames joins the Sleeper id and falls back when it cannot", () => {
  const nflverse = [
    {
      nv: "2026_03_LAC_BUF", espn: "401872953", week: 3, home: "BUF", away: "LAC",
      gameday: "2026-09-27", gametime: "13:00", spread: -7, total: 50.5, mlHome: -340, mlAway: 270,
      roof: "outdoors", surface: "a_turf", div: false, restHome: 10, restAway: 7, stadium: "Highmark",
    },
    {
      nv: "2026_03_AAA_BBB", espn: null, week: 3, home: "BBB", away: "AAA",
      gameday: null, gametime: null, spread: null, total: null, mlHome: null, mlAway: null,
      roof: null, surface: null, div: null, restHome: null, restAway: null, stadium: null,
    },
  ];
  const built = buildGames({
    nflverse,
    sleeperIds: new Map([["3|LAC@BUF", "202610304"]]),
    espn: new Map([["3|LAC@BUF", { espn: "401872953", kick: "2026-09-27T17:00:00Z", indoor: false, tempF: 72, wx: null }]]),
    season: 2026,
    generatedAt: AT,
  });
  assert.equal(built.version, GAMES_VERSION);
  assert.equal(built.games[0].id, "202610304");
  assert.equal(built.games[0].indoor, false);
  assert.equal(built.games[0].kick, "2026-09-27T17:00:00Z");
  assert.equal(built.games[0].windMph, null, "wind is only ever filled by the weather pass");
  // No Sleeper id and no ESPN row: the documented fallback key, and nulls everywhere else.
  assert.equal(built.games[1].id, "3|AAA@BBB");
  assert.equal(built.games[1].kick, null);
  assert.equal(built.games[1].indoor, null);
});

test("buildGames derives indoor from the roof when ESPN is silent", () => {
  const make = (roof) =>
    buildGames({
      nflverse: [{ nv: "x", espn: null, week: 1, home: "KC", away: "BUF", roof, surface: null, spread: null, total: null, mlHome: null, mlAway: null, div: null, restHome: null, restAway: null }],
      sleeperIds: new Map(),
      espn: new Map(),
      season: 2026,
      generatedAt: AT,
    }).games[0].indoor;
  assert.equal(make("dome"), true);
  assert.equal(make("closed"), true);
  assert.equal(make("outdoors"), false);
  assert.equal(make("open"), false);
  assert.equal(make(null), null);
});

test("the committed games fixture satisfies the contract and the schedule", () => {
  assert.deepEqual(validateGames(GAMES, { schedule: SCHEDULE }), []);
  assert.equal(GAMES.games.length, 272);
  // Every id is the Sleeper game id the per-player stat rows use, not the fallback key.
  assert.ok(GAMES.games.every((game) => /^\d{9}$/.test(game.id)));
  // Spread sign: negative = home favoured, cross-checked against the moneylines.
  for (const game of GAMES.games) {
    if (game.spread === null || game.spread === 0 || game.mlHome === null || game.mlAway === null) continue;
    assert.equal(game.spread < 0, game.mlHome < game.mlAway, `${game.nv}`);
  }
  // Weather only on outdoor games, and only where a forecast existed. Never a guess indoors.
  for (const game of GAMES.games) {
    if (game.windMph === null) continue;
    assert.notEqual(game.indoor, true, `${game.nv} has wind at an indoor venue`);
  }
});

test("validateGames catches a short season, a bad total and a game the schedule has never heard of", () => {
  assert.ok(validateGames({ ...GAMES, games: GAMES.games.slice(0, 10) }).some((p) => p.includes("floor 200")));
  const bad = structuredClone(GAMES);
  bad.games[0].total = 200;
  assert.ok(validateGames(bad).some((p) => p.includes(".total is 200")));
  const ghost = structuredClone(GAMES);
  ghost.games[0].away = "ZZZ";
  assert.ok(validateGames(ghost, { schedule: SCHEDULE }).some((p) => p.includes("not in data/schedule.json")));
  const dupe = structuredClone(GAMES);
  dupe.games[1].id = dupe.games[0].id;
  assert.ok(validateGames(dupe).some((p) => p.includes("is repeated")));
});

test("last-good keeps the committed games file when a rebuild loses a fifth of the season", () => {
  const thin = { ...GAMES, games: GAMES.games.slice(0, 200) };
  const guarded = resolveOptional({ name: "games", next: thin, previous: GAMES });
  assert.equal(guarded.kept, true);
  assert.equal(guarded.count, 272);
  assert.equal(resolveOptional({ name: "games", next: { ...GAMES, games: GAMES.games.slice(0, 250) }, previous: GAMES }).kept, false);
});
