// data/history.json v1 (design §13.6 F1): the season-actuals feed behind the risk model.
// Fixtures are the live 2025 payloads trimmed to 32 rows (`sleeper_stats_2025[_wk1]_raw.json`,
// captured 2026-09-17). The only networked test stubs `globalThis.fetch`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HISTORY_SCORING,
  HISTORY_VERSION,
  buildHistorySeason,
  collectHistory,
  fetchSeasonStats,
  fetchWeekStats,
  finalizeHistory,
  historyCell,
  historySeasonPlan,
  rosterPlayerIds,
} from "../pipeline/sources/sleeper.mjs";
import { MAX_HISTORY_WEEKS, validateAll, validateHistory } from "../pipeline/contract.mjs";
import {
  HISTORY_FLOORS,
  historyPlayerCount,
  historySeasonFloor,
  resolveHistory,
} from "../pipeline/lastgood.mjs";

const GENERATED_AT = "2026-09-17T12:00:00Z";

/** @param {string} name */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const rawTotals = fixture("sleeper_stats_2025_raw.json");
const rawWeek1 = fixture("sleeper_stats_2025_wk1_raw.json");
const players = fixture("players.json").players;
const rosters = fixture("rosters.json");

/** players.json ∪ every rostered id — exactly the allowlist refresh.mjs builds. */
const allowedIds = new Set([...Object.keys(players), ...rosterPlayerIds(rosters)]);

/** Replay week 1 into `weeks` columns so a multi-week season can be asserted from one sample. */
function season(weeks = 1, { totals = rawTotals, week1 = rawWeek1 } = {}) {
  return buildHistorySeason({
    totals,
    weekly: Array.from({ length: weeks }, () => week1),
    allowedIds,
  });
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────────

test("historySeasonPlan covers last season complete and this season through the played weeks", () => {
  assert.deepEqual(historySeasonPlan({ season: "2026", week: 2 }), [
    { season: "2025", weeks: 18 },
    { season: "2026", weeks: 1 },
  ]);
  assert.deepEqual(
    historySeasonPlan({ season: 2026, week: 1 }),
    [
      { season: "2025", weeks: 18 },
      { season: "2026", weeks: 0 },
    ],
    "week 1 is still being played, so this season contributes nothing yet",
  );
  assert.deepEqual(historySeasonPlan({ season: "2026", week: 25 })[1], { season: "2026", weeks: 18 });
  assert.deepEqual(historySeasonPlan({ season: "2026", week: 0 })[1], { season: "2026", weeks: 0 });
});

// ── the `w` cell ──────────────────────────────────────────────────────────────────────────────

test("historyCell is [pts_std, rec] for an active week and null for everything else", () => {
  assert.deepEqual(historyCell({ gp: 1, pts_std: 14.44, rec: 4 }), [14.4, 4], "one decimal");
  assert.deepEqual(historyCell({ gp: 1, pts_std: 26.02 }), [26, 0], "no reception key means 0 catches");
  assert.deepEqual(historyCell({ gp: 1 }), [0, 0], "dressed and scored nothing is an ACTIVE zero week");
  assert.equal(historyCell({ gms_active: 1, pos_rank_std: 999 }), null, "no gp means he did not play");
  assert.equal(historyCell({ gp: 0, pts_std: 12 }), null);
  assert.equal(historyCell(undefined), null, "absent from the week payload entirely");
  assert.equal(historyCell(null), null);
  assert.equal(historyCell([1, 2]), null);
});

test("ANCHOR: std + 0.5·rec reproduces Sleeper's own pts_half_ppr on every active fixture row", () => {
  let checked = 0;
  for (const [id, row] of Object.entries(rawWeek1)) {
    const cell = historyCell(row);
    if (!cell || typeof row.pts_half_ppr !== "number") continue;
    const [std, rec] = cell;
    assert.ok(
      Math.abs(std + 0.5 * rec - row.pts_half_ppr) <= 0.05,
      `${id}: ${std} + 0.5*${rec} != ${row.pts_half_ppr}`,
    );
    assert.ok(Math.abs(std + rec - row.pts_ppr) <= 0.05, `${id}: PPR mismatch`);
    checked += 1;
  }
  assert.ok(checked >= 20, `expected the fixture to exercise 20+ active rows, got ${checked}`);
});

// ── one season ────────────────────────────────────────────────────────────────────────────────

test("buildHistorySeason keeps gp/gms_active from the totals and one cell per week", () => {
  const built = season(18);
  assert.equal(built.weeks, 18);
  const saquon = built.players["4866"];
  assert.equal(saquon.gp, 16, "season totals, not the replayed weeks");
  assert.equal(saquon.ga, 17);
  assert.equal(saquon.w.length, 18);
  assert.deepEqual(saquon.w[0], [14.4, 4]);
  for (const [id, gp, ga] of [
    ["11604", 12, 14],
    ["4046", 14, 17],
    ["6794", 17, 17],
    ["9509", 17, 17],
    ["5850", 15, 15],
  ]) {
    assert.equal(built.players[id].gp, gp, `${id} gp`);
    assert.equal(built.players[id].ga, ga, `${id} gms_active`);
  }
  assert.deepEqual(built.players["4046"].w[0], [26, 0], "a QB with no catches still ships a rec of 0");
});

test("buildHistorySeason nulls a week the player is absent from or did not play", () => {
  const built = season(2);
  assert.deepEqual(built.players["2359"], undefined, "absent from every week payload — row dropped");
  assert.deepEqual(
    buildHistorySeason({
      totals: rawTotals,
      weekly: [rawWeek1, {}],
      allowedIds,
    }).players["4866"].w,
    [[14.4, 4], null],
    "a week nobody has played yet is a column of nulls",
  );
  assert.equal(
    season(1).players["9502"],
    undefined,
    "Tank Dell has a week-1 row but no gp — no active week, so no row",
  );
});

test("buildHistorySeason reads a team defense, whose rows carry no gms_active", () => {
  const phi = season(3).players.PHI;
  assert.equal(phi.gp, 17);
  assert.equal(phi.ga, null);
  assert.deepEqual(phi.w[0], [3, 0]);
});

test("buildHistorySeason keeps an active-but-scoreless week instead of dropping it", () => {
  // Tyler Higbee played week 1 of 2025 and finished with no pts_std key at all.
  assert.equal(rawWeek1["3271"].pts_std, undefined);
  assert.deepEqual(season(1).players["3271"].w[0], [0, 0]);
});

test("buildHistorySeason ships only allowed ids, ordered numerically", () => {
  const built = season(1);
  for (const outsider of ["13037", "13156"]) {
    assert.ok(rawTotals[outsider], `${outsider} is in the raw payload`);
    assert.equal(built.players[outsider], undefined, `${outsider} is not in players.json or on a roster`);
  }
  const ids = Object.keys(built.players);
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  assert.deepEqual(numeric, numeric.slice().sort((a, b) => Number(a) - Number(b)));
  assert.equal(ids[ids.length - 1], "PHI", "team codes sort after numeric ids");
  assert.equal(built.players["138"], undefined, "an empty totals row with no active week is dropped");
});

test("buildHistorySeason falls back to counting active weeks when the totals have no gp", () => {
  const built = buildHistorySeason({ totals: {}, weekly: [rawWeek1, rawWeek1], allowedIds });
  assert.equal(built.players["4866"].gp, 2);
  assert.equal(built.players["4866"].ga, null);
});

test("buildHistorySeason with no allowlist takes every id the weeks mention", () => {
  const built = buildHistorySeason({ totals: rawTotals, weekly: [rawWeek1] });
  assert.ok(built.players["13156"] === undefined, "13156 has no gp in week 1");
  assert.ok(Object.keys(built.players).length >= 25);
});

// ── the envelope ──────────────────────────────────────────────────────────────────────────────

test("finalizeHistory stamps version 1, the scoring keys and sorted seasons", () => {
  const history = finalizeHistory({
    seasons: { 2026: season(1), 2025: season(18) },
    generatedAt: GENERATED_AT,
  });
  assert.equal(history.version, HISTORY_VERSION);
  assert.equal(history.version, 1);
  assert.equal(history.generated_at, GENERATED_AT);
  assert.deepEqual(history.scoring, { std: "pts_std", rec: "rec" });
  assert.deepEqual(history.scoring, HISTORY_SCORING);
  assert.deepEqual(Object.keys(history.seasons), ["2025", "2026"]);
  assert.equal(history.seasons["2025"].weeks, 18);
});

// ── contract ──────────────────────────────────────────────────────────────────────────────────

const validHistory = () =>
  finalizeHistory({ seasons: { 2025: season(18), 2026: season(1) }, generatedAt: GENERATED_AT });

test("validateHistory accepts a file the pipeline just built", () => {
  assert.deepEqual(validateHistory(validHistory()), []);
});

test("validateHistory accepts a season with no completed week", () => {
  const history = finalizeHistory({
    seasons: { 2025: season(18), 2026: { weeks: 0, players: {} } },
    generatedAt: GENERATED_AT,
  });
  assert.deepEqual(validateHistory(history), []);
});

test("validateHistory catches a wrong version, timestamp, scoring block or seasons map", () => {
  assert.deepEqual(validateHistory(null), ["history: not an object"]);
  assert.deepEqual(validateHistory([]), ["history: not an object"]);
  assert.ok(validateHistory({ ...validHistory(), version: 2 })[0].includes("history.version must be 1"));
  assert.ok(validateHistory({ ...validHistory(), generated_at: "yesterday" })[0].includes("ISO timestamp"));
  assert.ok(validateHistory({ ...validHistory(), scoring: { std: "pts_std" } })[0].includes("scoring.rec"));
  assert.deepEqual(validateHistory({ ...validHistory(), seasons: [] }), ["history.seasons: not an object"]);
  assert.deepEqual(validateHistory({ ...validHistory(), seasons: {} }), ["history.seasons: no seasons"]);
});

test("validateHistory catches a bad week count and a `w` of the wrong length", () => {
  const tooManyWeeks = validHistory();
  tooManyWeeks.seasons["2025"] = { ...tooManyWeeks.seasons["2025"], weeks: MAX_HISTORY_WEEKS + 1 };
  assert.ok(validateHistory(tooManyWeeks)[0].includes("weeks must be an integer 0..18"));

  const short = validHistory();
  short.seasons["2025"].players["4866"] = { gp: 16, ga: 17, w: [[1, 0]] };
  assert.deepEqual(validateHistory(short), [
    'history.seasons["2025"].players["4866"].w holds 1 entries, expected 18',
  ]);

  const populatedEmptySeason = validHistory();
  populatedEmptySeason.seasons["2026"] = { weeks: 0, players: { 4866: { gp: 0, ga: 0, w: [] } } };
  assert.ok(validateHistory(populatedEmptySeason)[0].includes("0 weeks but 1 player rows"));
});

test("validateHistory catches a malformed cell, a bad gp/ga and an all-null row", () => {
  const bad = validHistory();
  const row = () => bad.seasons["2026"].players["4866"];
  row().w = [[1]];
  assert.ok(validateHistory(bad)[0].includes("must be null or [pts_std, rec]"));
  row().w = [[1, null]];
  assert.ok(validateHistory(bad)[0].includes("non-finite number"));
  row().w = [[1, 2]];
  row().gp = -1;
  assert.ok(validateHistory(bad)[0].includes("gp must be a non-negative number"));
  row().gp = 1;
  row().ga = "17";
  assert.ok(validateHistory(bad)[0].includes("ga must be a non-negative number or null"));
  row().ga = null;
  row().w = [null];
  assert.ok(validateHistory(bad)[0].includes("has no active week"));
});

test("validateHistory rejects a season key that is not a four-digit year", () => {
  const history = validHistory();
  history.seasons.last = history.seasons["2025"];
  assert.ok(validateHistory(history).some((p) => p.includes("key is not a four-digit season")));
});

test("validateAll reports history only when the run produced one", () => {
  const five = {
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
    meta: fixture("meta.json"),
  };
  assert.deepEqual(Object.keys(validateAll(five)).sort(), [
    "meta",
    "players",
    "projections",
    "schedule",
    "values",
  ]);
  const withHistory = validateAll({ ...five, history: validHistory() });
  assert.deepEqual(withHistory.history, []);
  assert.ok(validateAll({ ...five, history: { version: 9 } }).history.length > 0);
});

// ── last-good guard ───────────────────────────────────────────────────────────────────────────

/** @param {number} rows */
function fakeSeason(rows, weeks = 18) {
  /** @type {Record<string, unknown>} */
  const players = {};
  for (let i = 0; i < rows; i += 1) {
    players[String(1000 + i)] = { gp: 1, ga: 1, w: Array.from({ length: weeks }, () => [1, 0]) };
  }
  return { weeks, players };
}

const previousFile = () =>
  finalizeHistory({
    seasons: { 2025: fakeSeason(400), 2026: fakeSeason(300, 1) },
    generatedAt: "2026-09-14T06:00:00Z",
  });

test("historySeasonFloor only asks for rows once a week has been played", () => {
  assert.equal(historySeasonFloor(18), HISTORY_FLOORS.played);
  assert.equal(historySeasonFloor(1), 150);
  assert.equal(historySeasonFloor(0), 0);
  assert.equal(historyPlayerCount(fakeSeason(7)), 7);
  assert.equal(historyPlayerCount(null), 0);
  assert.equal(historyPlayerCount({ weeks: 3, players: [] }), 0);
});

test("resolveHistory keeps last season when its fetch failed and takes this season's fresh rows", () => {
  const next = finalizeHistory({ seasons: { 2026: fakeSeason(300, 1) }, generatedAt: GENERATED_AT });
  const resolved = resolveHistory({
    next,
    errors: { 2025: "HTTP 503 Service Unavailable" },
    previous: previousFile(),
  });
  assert.deepEqual(resolved.kept, ["2025"]);
  assert.deepEqual(resolved.failed, ["2025"]);
  assert.equal(historyPlayerCount(resolved.history.seasons["2025"]), 400);
  assert.equal(historyPlayerCount(resolved.history.seasons["2026"]), 300);
  assert.equal(resolved.history.generated_at, GENERATED_AT, "the envelope is this run's");
  assert.match(resolved.notes[0], /^history 2025: kept last good season \(400 players over 18 week\(s\)\)/);
  assert.match(resolved.notes[0], /HTTP 503/);
  assert.deepEqual(validateHistory(resolved.history), []);
});

test("resolveHistory treats a short season as a failure", () => {
  const next = finalizeHistory({
    seasons: { 2025: fakeSeason(12), 2026: fakeSeason(300, 1) },
    generatedAt: GENERATED_AT,
  });
  const resolved = resolveHistory({ next, previous: previousFile() });
  assert.deepEqual(resolved.kept, ["2025"]);
  assert.match(resolved.notes[0], /player count 12 below floor 150/);
  assert.equal(historyPlayerCount(resolved.history.seasons["2025"]), 400);
});

test("resolveHistory publishes a short season when there is nothing to fall back on", () => {
  const next = finalizeHistory({ seasons: { 2025: fakeSeason(12) }, generatedAt: GENERATED_AT });
  const resolved = resolveHistory({ next, previous: null });
  assert.deepEqual(resolved.kept, []);
  assert.deepEqual(resolved.failed, ["2025"]);
  assert.equal(historyPlayerCount(resolved.history.seasons["2025"]), 12);
  assert.match(resolved.notes[0], /no previous season to fall back on/);
});

test("resolveHistory falls back to the whole committed file when the run produced nothing", () => {
  const previous = previousFile();
  const resolved = resolveHistory({ next: null, errors: { 2025: "boom", 2026: "boom" }, previous });
  assert.deepEqual(resolved.kept, ["2025", "2026"]);
  assert.equal(resolved.history.generated_at, previous.generated_at);
  assert.deepEqual(validateHistory(resolved.history), []);
});

test("resolveHistory answers null when neither the run nor the repo has a file", () => {
  const resolved = resolveHistory({ next: null, previous: null, errors: { 2025: "boom" } });
  assert.equal(resolved.history, null);
  assert.deepEqual(resolved.failed, ["2025"]);
});

test("resolveHistory lets a season with no completed week through at zero rows", () => {
  const next = finalizeHistory({
    seasons: { 2025: fakeSeason(400), 2026: { weeks: 0, players: {} } },
    generatedAt: GENERATED_AT,
  });
  const resolved = resolveHistory({ next, previous: null });
  assert.deepEqual(resolved.failed, []);
  assert.deepEqual(resolved.notes, []);
});

// ── the roster allowlist ──────────────────────────────────────────────────────────────────────

test("rosterPlayerIds reads players, reserve, taxi and starters off every roster", () => {
  const ids = rosterPlayerIds(rosters);
  assert.equal(ids.length, 138);
  assert.ok(ids.includes("9753"), "a reserve (IR) player counts");
  assert.ok(ids.includes("PHI"), "team defenses count");
  assert.equal(new Set(ids).size, ids.length, "deduplicated");
  assert.deepEqual(rosterPlayerIds(null), []);
  assert.deepEqual(rosterPlayerIds([{ players: null, reserve: ["0", "", 7] }]), []);
});

// ── orchestration (stubbed fetch) ─────────────────────────────────────────────────────────────

/**
 * Stub `globalThis.fetch` for the length of `run`, recording the URLs it saw.
 * @param {(url: string) => unknown} respond a payload, or a throw
 * @param {(urls: string[]) => Promise<void>} run
 */
async function withFetch(respond, run) {
  const original = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return { ok: true, status: 200, statusText: "OK", async text() { return JSON.stringify(respond(url)); } };
  };
  try {
    await run(urls);
  } finally {
    globalThis.fetch = original;
  }
}

test("fetchSeasonStats and fetchWeekStats hit the documented URLs with a cache-buster", async () => {
  await withFetch(
    () => ({ 4866: { gp: 1 } }),
    async (urls) => {
      await fetchSeasonStats("2025");
      await fetchWeekStats(2025, 3);
      assert.match(urls[0], /^https:\/\/api\.sleeper\.app\/v1\/stats\/nfl\/regular\/2025\?cb=\d+$/);
      assert.match(urls[1], /^https:\/\/api\.sleeper\.app\/v1\/stats\/nfl\/regular\/2025\/3\?cb=\d+$/);
    },
  );
  await withFetch(
    () => [1, 2, 3],
    async () => {
      await assert.rejects(() => fetchSeasonStats("2025"), /unexpected season stats payload/);
      await assert.rejects(() => fetchWeekStats("2025", 1), /unexpected week stats payload/);
    },
  );
});

test("collectHistory walks the plan sequentially and returns a contract-valid file", async () => {
  await withFetch(
    (url) => (/\/regular\/\d+\/\d+/.test(url) ? rawWeek1 : rawTotals),
    async (urls) => {
      const { history, errors, stats } = await collectHistory({
        season: "2026",
        week: 2,
        allowedIds,
        generatedAt: GENERATED_AT,
        delayMs: 0,
      });
      assert.deepEqual(errors, {});
      assert.equal(urls.length, 21, "2 season totals + 18 weeks of 2025 + 1 week of 2026");
      assert.deepEqual(Object.keys(history.seasons), ["2025", "2026"]);
      assert.equal(history.seasons["2025"].weeks, 18);
      assert.equal(history.seasons["2026"].weeks, 1);
      assert.equal(stats["2025"].players, Object.keys(history.seasons["2025"].players).length);
      assert.deepEqual(validateHistory(history), []);
    },
  );
});

test("collectHistory records a failed season instead of throwing, and skips an unplayed one", async () => {
  await withFetch(
    (url) => (url.includes("/regular/2025") ? [] : rawWeek1),
    async (urls) => {
      const { history, errors } = await collectHistory({
        season: "2026",
        week: 1,
        allowedIds,
        generatedAt: GENERATED_AT,
        delayMs: 0,
      });
      assert.match(errors["2025"], /unexpected season stats payload/);
      assert.equal(errors["2026"], undefined);
      assert.equal(urls.length, 1, "2025 gave up on its totals call; 2026 has no played week to fetch");
      assert.deepEqual(Object.keys(history.seasons), ["2026"]);
      assert.deepEqual(history.seasons["2026"], { weeks: 0, players: {} });
    },
  );
});
