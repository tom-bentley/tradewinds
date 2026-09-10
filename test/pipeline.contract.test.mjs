// Contract validators, and a check that the committed data/ files satisfy them. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ADVISOR_ITEM_LIMIT,
  validateAdvisor,
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

test("validatePlayers accepts the v2.1 advisor fields and rejects the wrong types", () => {
  /** @param {object} extra */
  const check = (extra) =>
    validatePlayers({
      generated_at: "2026-09-09T12:00:00Z",
      count: 2,
      players: {
        11604: {
          id: "11604",
          name: "Brock Bowers",
          pos: "TE",
          team: "LV",
          inj: "Doubtful",
          fp: ["TE"],
          bye: 13,
          ...extra,
        },
        KC: { id: "KC", name: "KC D/ST", pos: "DEF", team: "KC", inj: null, fp: ["DEF"], bye: 5 },
      },
    }).filter((problem) => problem.includes("11604"));

  // present and well-typed
  assert.deepEqual(check({ injPart: "Knee - Meniscus", injNotes: "Surgery", newsAt: 1788984945628 }), []);
  // explicit nulls are the healthy case
  assert.deepEqual(check({ injPart: null, injNotes: null, newsAt: null }), []);
  // absent is fine: files written before design §12.3 simply do not carry them
  assert.deepEqual(check({}), []);

  const wrong = check({ injPart: 7, injNotes: ["surgery"], newsAt: "yesterday" });
  assert.equal(wrong.length, 3);
  assert.ok(wrong.some((p) => p.includes('players["11604"].injPart must be a string or null')));
  assert.ok(wrong.some((p) => p.includes('players["11604"].injNotes must be a string or null')));
  assert.ok(wrong.some((p) => p.includes('players["11604"].newsAt must be a number or null')));
});

/**
 * A minimal contract-valid v2 projections object.
 * @param {Record<string, (number[]|0)[]>} players
 * @param {string[]} [keys]
 */
function projectionsV2(players, keys = ["rush_yd", "rec"]) {
  return {
    generated_at: "2026-09-09T12:00:00Z",
    season: "2026",
    version: 2,
    weeks: Array.from({ length: 18 }, (_, i) => i + 1),
    keys,
    players,
  };
}

/** @param {(number[]|0)[]} weeks */
function fullSeason(weeks) {
  return [...weeks, ...new Array(18 - weeks.length).fill(0)];
}

test("validateProjections accepts a well-formed v2 file", () => {
  const problems = validateProjections(
    projectionsV2({ 9221: fullSeason([[0, 92.1, 1, 4.2], 0, [1, 3]]), KC: fullSeason([[0, 1.5]]) }),
  ).filter((p) => !p.startsWith("projections: only"));
  assert.deepEqual(problems, []);
});

test("validateProjections rejects a v1 file and a wrong version", () => {
  const v1 = {
    generated_at: "2026-09-09T12:00:00Z",
    season: "2026",
    scoring: "league:1394476745138147328",
    weeks: Array.from({ length: 18 }, (_, i) => i + 1),
    players: { 9221: new Array(18).fill(1) },
  };
  const problems = validateProjections(v1);
  assert.ok(problems.some((p) => p.includes("projections.version must be 2")));
  assert.ok(problems.some((p) => p.includes("projections.keys must be a non-empty array")));

  assert.ok(
    validateProjections({ ...projectionsV2({}), version: 3 }).some((p) =>
      p.includes("projections.version must be 2"),
    ),
  );
});

test("validateProjections catches bad weeks, keys and stat lines", () => {
  const problems = validateProjections({
    ...projectionsV2(
      {
        1: fullSeason([[0, 1]]).slice(0, 17),
        2: fullSeason([[9, 1]]),
        3: fullSeason([[0, 1, 1]]),
        4: fullSeason([[0, "x"]]),
        5: fullSeason([[0, 1, 0, 2]]),
        6: new Array(18).fill(0),
      },
      ["rush_yd", "rec", ""],
    ),
    weeks: [1, 2, 3],
  });
  assert.ok(problems.some((p) => p.includes("projections.weeks must list 18")));
  assert.ok(problems.some((p) => p.includes("projections.keys[2] is not a stat name")));
  assert.ok(problems.some((p) => p.includes('players["1"] must be 18 week entries')));
  assert.ok(problems.some((p) => p.includes('players["2"][0][0] is not a key index below 3')));
  assert.ok(problems.some((p) => p.includes('players["3"][0] must hold [keyIdx, value] pairs')));
  assert.ok(problems.some((p) => p.includes('players["4"][0][1] is not a finite number')));
  assert.ok(problems.some((p) => p.includes('players["5"][0] repeats key index 0')));
  assert.ok(problems.some((p) => p.includes('players["6"] has no projected week')));
});

test("validateProjections rejects duplicate stat names", () => {
  const problems = validateProjections(
    projectionsV2({ 1: fullSeason([[0, 1]]) }, ["rec", "rush_yd", "rec"]),
  );
  assert.ok(problems.some((p) => p.includes('projections.keys[2] repeats "rec"')));
});

test("validateValues requires an error when ok is false and rejects non-numeric fields", () => {
  const problems = validateValues({
    generated_at: "2026-09-09T12:00:00Z",
    sources: {
      fc_redraft: {
        label: "FantasyCalc redraft",
        kind: "redraft",
        variant: { numQbs: 1 },
        fetched_at: "2026-09-09T12:00:00Z",
        ok: false,
        count: 1,
        url: "https://api.fantasycalc.com/values/current",
        values: { 9221: { v: 10274, tier: "1" } },
      },
      mystery: { label: "", kind: "vibes", fetched_at: "yesterday", ok: true, count: 0, values: {} },
      bad_variant: {
        label: "x",
        kind: "tiers",
        variant: { ppr: "half" },
        fetched_at: "2026-09-09T12:00:00Z",
        ok: true,
        count: 0,
        url: "x",
        values: {},
      },
    },
  });
  assert.ok(problems.some((p) => p.includes("ok=false requires an error string")));
  assert.ok(problems.some((p) => p.includes('values["9221"].tier is not a finite number')));
  assert.ok(problems.some((p) => p.includes('sources["mystery"].kind')));
  assert.ok(problems.some((p) => p.includes('sources["mystery"].fetched_at')));
  assert.ok(problems.some((p) => p.includes('sources["mystery"].variant must be an object')));
  assert.ok(problems.some((p) => p.includes('sources["bad_variant"].variant.ppr is not a finite number')));
});

test("validateValues accepts a last-good table carrying ok:false plus an error", () => {
  assert.deepEqual(
    validateValues({
      generated_at: "2026-09-09T12:00:00Z",
      sources: {
        bc_tiers_half: {
          label: "Boris Chen half-PPR wk 1",
          kind: "tiers",
          variant: { ppr: 0.5 },
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

test("validateMeta catches a zero week, an empty league id and a bad source entry", () => {
  const problems = validateMeta({
    generated_at: "2026-09-09T12:00:00Z",
    season: "2026",
    week: 0,
    league_id: "",
    pipeline_version: 1,
    sources: { fc_redraft: { ok: false, fetched_at: "2026-09-09T12:00:00Z", count: 0 } },
  });
  assert.ok(problems.some((p) => p.includes("meta.week")));
  assert.ok(problems.some((p) => p.includes("meta.league_id, when present")));
  assert.ok(problems.some((p) => p.includes("meta.pipeline_version")));
  assert.ok(problems.some((p) => p.includes("ok=false requires an error string")));
});

test("validateMeta accepts a league-agnostic meta object (design 10.6)", () => {
  assert.deepEqual(
    validateMeta({
      generated_at: "2026-09-09T12:00:00Z",
      season: "2026",
      week: 1,
      pipeline_version: "2.0.0",
      sources: { players: { ok: true, fetched_at: "2026-09-09T12:00:00Z", count: 869 } },
    }),
    [],
  );
});

// --- data/advisor.json (design 12.3) ---------------------------------------

/**
 * @param {object} [patch] merged into the one advisory
 * @returns {object} a contract-valid advisor feed
 */
function advisorFeed(patch = {}) {
  return {
    v: 1,
    generated_at: "2026-09-10T14:20:00Z",
    leagues: {
      // quoted: an unquoted 19-digit key would be rounded through Number and change identity
      "1394476745138147328": {
        week: 1,
        items: [
          {
            key: "11604:Doubtful|Knee - Meniscus|Surgery",
            id: "11604",
            name: "Brock Bowers",
            severity: "high",
            headline: "Bowers -> Doubtful (knee - meniscus)",
            summary: "Start Goedert at TE (8.8). IR opens when his status becomes Out.",
            moves: [{ type: "start", text: "Start Dallas Goedert at TE" }],
            at: "2026-09-10T14:20:00Z",
            ...patch,
          },
        ],
      },
    },
  };
}

test("validateAdvisor accepts the feed the alerts job writes", () => {
  assert.deepEqual(validateAdvisor(advisorFeed()), []);
  assert.deepEqual(
    validateAdvisor({ v: 1, generated_at: "2026-09-10T14:20:00Z", leagues: {} }),
    [],
    "a run with nothing to say still writes a valid file",
  );
});

test("validateAdvisor rejects a bad version, timestamp, severity and shape", () => {
  assert.deepEqual(validateAdvisor(null), ["advisor: not an object"]);
  assert.deepEqual(validateAdvisor([]), ["advisor: not an object"]);

  const problems = validateAdvisor({ v: 2, generated_at: "yesterday", leagues: { L: { week: 1.5, items: {} } } });
  assert.ok(problems.some((p) => p.includes("advisor.v must be 1")));
  assert.ok(problems.some((p) => p.includes("advisor.generated_at")));
  assert.ok(problems.some((p) => p.includes('advisor.leagues["L"].week must be an integer or null')));
  assert.ok(problems.some((p) => p.includes('advisor.leagues["L"].items must be an array')));

  const bad = validateAdvisor(advisorFeed({ severity: "urgent", headline: "", moves: "start Goedert", at: 17 }));
  assert.ok(bad.some((p) => p.includes(".severity is \"urgent\"")));
  assert.ok(bad.some((p) => p.includes(".headline is not a non-empty string")));
  assert.ok(bad.some((p) => p.includes(".moves must be an array")));
  assert.ok(bad.some((p) => p.includes(".at: expected an ISO timestamp")));
});

test("validateAdvisor bounds a league to 30 items and refuses a repeated key", () => {
  const feed = advisorFeed();
  const [item] = feed.leagues["1394476745138147328"].items;
  feed.leagues["1394476745138147328"].items = Array.from({ length: ADVISOR_ITEM_LIMIT + 1 }, (_, index) => ({
    ...item,
    key: `${item.key}#${index}`,
  }));
  assert.ok(validateAdvisor(feed).some((p) => p.includes(`bounded to ${ADVISOR_ITEM_LIMIT}`)));

  const dupes = advisorFeed();
  dupes.leagues["1394476745138147328"].items.push({ ...item });
  assert.ok(validateAdvisor(dupes).some((p) => p.includes("repeats key")));
});
