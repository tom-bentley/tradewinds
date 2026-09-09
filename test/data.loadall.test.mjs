import test from "node:test";
import assert from "node:assert/strict";

import {
  FC_FLOORS,
  PIPELINE_FILES,
  fcParamsFromLeague,
  fcTableNames,
  listLeagues,
  loadAll,
  normalizeFantasyCalc,
  refreshLive,
} from "../src/data.js";
import { fixture, jsonResponse, makeFetchMock } from "./shims/fetch-mock.mjs";
import { makeMemoryIdb } from "./shims/idb-shim.mjs";

const LEAGUE = "1394476745138147328";
const NOW = Date.parse("2026-09-09T18:00:00Z"); // 2 h after the fixture pipeline run
const NOW_ISO = new Date(NOW).toISOString();
const PIPELINE_AT = fixture("meta.json").generated_at; // "2026-09-09T15:59:31Z"

const settings = { leagueId: LEAGUE, userId: "1394551386997272576", season: "2026" };
const boom = () => {
  throw new TypeError("fetch failed");
};

/** Build the standard route table; every layer can be swapped for a failure/short response. */
function makeRoutes({ data, league, users, rosters, state, fcRedraft, fcDynasty } = {}) {
  return [
    ...PIPELINE_FILES.map((file) => ({ match: `data/${file}`, respond: data ?? (() => fixture(file)) })),
    { match: /\/league\/[^/?]+\/users/, respond: users ?? (() => fixture("users.json")) },
    { match: /\/league\/[^/?]+\/rosters/, respond: rosters ?? (() => fixture("rosters.json")) },
    { match: /\/league\/[^/?]+\?cb=/, respond: league ?? (() => fixture("league.json")) },
    { match: "/state/nfl", respond: state ?? (() => fixture("state.json")) },
    { match: "isDynasty=false", respond: fcRedraft ?? (() => fixture("fantasycalc_redraft_raw.json")) },
    { match: "isDynasty=true", respond: fcDynasty ?? (() => fixture("fantasycalc_dynasty_raw.json")) },
  ];
}

/** A buildContext stand-in: records what the data layer handed the engine. */
function stubEngine() {
  const seen = [];
  const buildContext = (input, appliedSettings) => {
    seen.push({ input, settings: appliedSettings });
    return {
      league: { id: input.league?.league_id, name: input.league?.name },
      week: Number(input.state?.week) || 1,
      values: input.values,
      players: input.players,
    };
  };
  buildContext.seen = seen;
  return buildContext;
}

function harness({ routes = makeRoutes(), seed = {}, seedSavedAt, idbFail = false } = {}) {
  const fetchImpl = makeFetchMock(routes);
  const idb = makeMemoryIdb(seed, { savedAt: seedSavedAt, fail: idbFail });
  const buildContext = stubEngine();
  return {
    fetchImpl,
    idb,
    buildContext,
    deps: { fetchImpl, idb, buildContext, now: () => NOW, request: { backoffMs: [0, 0] } },
  };
}

/** Sleeper last-good payloads, as loadAll would have stored them. */
const sleeperSeed = () => ({
  [`sleeper:league:${LEAGUE}`]: fixture("league.json"),
  [`sleeper:users:${LEAGUE}`]: fixture("users.json"),
  [`sleeper:rosters:${LEAGUE}`]: fixture("rosters.json"),
  [`sleeper:state:${LEAGUE}`]: fixture("state.json"),
});

const pipelineSeed = () =>
  Object.fromEntries(PIPELINE_FILES.map((file) => [`pipeline:${file}`, fixture(file)]));

test("fcParamsFromLeague reads numQbs/numTeams/ppr off the league", () => {
  assert.deepEqual(fcParamsFromLeague(fixture("league.json")), { numQbs: 1, numTeams: 8, ppr: 0.5 });
  assert.deepEqual(
    fcParamsFromLeague({
      roster_positions: ["QB", "SUPER_FLEX", "RB", "WR"],
      total_rosters: 12,
      scoring_settings: { rec: 1 },
    }),
    { numQbs: 2, numTeams: 12, ppr: 1 },
  );
  assert.deepEqual(fcParamsFromLeague(null), { numQbs: 1, numTeams: 12, ppr: 0 }, "no rec setting = 0 PPR");
});

test("normalizeFantasyCalc produces the committed table shape", () => {
  const committed = fixture("values.json").sources.fc_redraft;
  const table = normalizeFantasyCalc(fixture("fantasycalc_redraft_raw.json"), {
    label: committed.label,
    kind: committed.kind,
    url: committed.url,
    fetchedAt: NOW_ISO,
  });

  assert.equal(table.count, 199);
  assert.equal(table.ok, true);
  assert.equal(table.kind, "redraft");
  assert.equal(table.url, committed.url);
  assert.equal(table.fetched_at, NOW_ISO);
  const gibbs = table.values["9221"];
  assert.equal(gibbs.v, 10274);
  assert.equal(gibbs.r, 1);
  assert.equal(gibbs.pr, 1);
  assert.equal(gibbs.t, -255);
  assert.equal(gibbs.tier, 1);
  assert.equal(gibbs.tf, 0.0163);
  assert.equal(gibbs.rp, 0.9827 * 100, "roster share is scaled to 0..100 like the pipeline");
  assert.ok(!("adp" in gibbs), "null FantasyCalc fields are omitted, not stored as null");
  // Rows without a Sleeper id can never be joined to a roster, so they are dropped.
  const withoutId = normalizeFantasyCalc([{ player: {}, value: 1 }, { player: { sleeperId: "5" }, value: 2 }], {});
  assert.equal(withoutId.count, 1);
  assert.equal(normalizeFantasyCalc(null, {}).ok, false);
});

test("loadAll: happy path builds ctx, live values, and a clean freshness report", async () => {
  const { deps, fetchImpl, idb, buildContext } = harness();
  const steps = [];

  const { ctx, freshness, errors } = await loadAll({
    settings,
    deps,
    onProgress: (p) => steps.push(p),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(freshness, {
    pipeline: PIPELINE_AT,
    pipelineSource: "network",
    season: "2026",
    live: NOW_ISO,
    values: "live",
    offline: false,
    stale: false,
  });

  // The engine got the parsed data files plus the live league layer.
  assert.equal(buildContext.seen.length, 1);
  const { input, settings: applied } = buildContext.seen[0];
  assert.deepEqual(Object.keys(input).sort(), [
    "league",
    "meta",
    "players",
    "projections",
    "rosters",
    "schedule",
    "state",
    "users",
    "values",
  ]);
  assert.equal(input.league.league_id, LEAGUE);
  assert.equal(input.users.length, 8);
  assert.equal(input.rosters.length, 8);
  assert.equal(input.state.week, 1);
  assert.equal(input.players.count, 871);
  // Projections v2 (raw stat lines) are handed to the engine untouched — this layer never
  // reshapes a pipeline file, so the count tracks whatever the pipeline last committed.
  assert.equal(input.projections.version, 2);
  assert.equal(
    Object.keys(input.projections.players).length,
    Object.keys(fixture("projections.json").players).length,
  );
  assert.equal(input.schedule.byes.KC, 5);
  assert.equal(applied, settings);
  assert.equal(ctx.league.name, "Boyball 🏈");

  // FantasyCalc overlaid both committed tables.
  assert.equal(input.values.sources.fc_redraft.count, 199);
  assert.equal(input.values.sources.fc_redraft.fetched_at, NOW_ISO, "overlay is stamped now");
  assert.equal(input.values.sources.fc_dynasty.count, 423);
  assert.equal(input.values.generated_at, PIPELINE_AT, "the file's own metadata survives the overlay");

  // Data files: no-store, no cache-buster (so the service worker can still match them offline).
  for (const call of fetchImpl.calls.filter((c) => c.url.startsWith("data/"))) {
    assert.equal(call.cache, "no-store");
    assert.doesNotMatch(call.url, /cb=/);
  }
  assert.equal(fetchImpl.count("data/"), 5);
  // Sleeper: cache-busted and no-store.
  for (const call of fetchImpl.calls.filter((c) => c.url.includes("api.sleeper.app"))) {
    assert.match(call.url, /[?&]cb=\d+/);
    assert.equal(call.cache, "no-store");
  }

  // Everything worth keeping went into the cache.
  const keys = [...idb.store.keys()].sort();
  assert.deepEqual(keys, [
    "fc:fc_dynasty:1:8:0.5",
    "fc:fc_redraft:1:8:0.5",
    "pipeline:meta.json",
    "pipeline:players.json",
    "pipeline:projections.json",
    "pipeline:schedule.json",
    "pipeline:values.json",
    `sleeper:league:${LEAGUE}`,
    `sleeper:rosters:${LEAGUE}`,
    `sleeper:state:${LEAGUE}`,
    `sleeper:users:${LEAGUE}`,
  ]);

  assert.deepEqual(
    steps.map((s) => s.step),
    ["pipeline", "league", "values", "context", "done"],
  );
  assert.deepEqual(steps.at(-1), { step: "done", label: "Ready", done: 4, total: 4 });
});

test("loadAll: pipeline files older than 24 h are flagged stale", async () => {
  const { deps } = harness();
  deps.now = () => Date.parse(PIPELINE_AT) + 30 * 60 * 60 * 1000;
  const { freshness } = await loadAll({ settings, deps });
  assert.equal(freshness.stale, true);
  assert.equal(freshness.offline, false);
});

test("loadAll: FantasyCalc 500 keeps the committed tables and reports 'pipeline'", async () => {
  const fcFail = () => jsonResponse({ error: "upstream" }, 500);
  const { deps, buildContext } = harness({ routes: makeRoutes({ fcRedraft: fcFail, fcDynasty: fcFail }) });

  const { freshness, errors } = await loadAll({ settings, deps });

  assert.equal(freshness.values, "pipeline");
  assert.equal(freshness.offline, false, "a values miss is not an offline app");
  assert.deepEqual(errors.map((e) => e.source).sort(), ["fc_dynasty", "fc_redraft"]);
  assert.match(errors[0].message, /HTTP 500/);
  const committed = fixture("values.json").sources;
  const used = buildContext.seen[0].input.values.sources;
  assert.deepEqual(used.fc_redraft, committed.fc_redraft, "committed redraft table untouched");
  assert.deepEqual(used.fc_dynasty, committed.fc_dynasty);
});

test("loadAll: a thin FantasyCalc answer is rejected by the row floor", async () => {
  const thin = (rows) => () => fixture("fantasycalc_redraft_raw.json").slice(0, rows);
  const { deps, buildContext } = harness({
    routes: makeRoutes({ fcRedraft: thin(10), fcDynasty: thin(20) }),
  });

  const { freshness, errors } = await loadAll({ settings, deps });

  assert.equal(freshness.values, "pipeline");
  assert.equal(buildContext.seen[0].input.values.sources.fc_redraft.count, 199, "kept the 199-row table");
  assert.equal(buildContext.seen[0].input.values.sources.fc_dynasty.count, 423);
  const floorError = errors.find((e) => e.source === "fc_redraft");
  assert.match(floorError.message, new RegExp(`10 rows \\(floor ${FC_FLOORS.fc_redraft}\\)`));
});

test("loadAll: one live table above the floor still counts as live values", async () => {
  const thin = () => fixture("fantasycalc_redraft_raw.json").slice(0, 10);
  const { deps, buildContext } = harness({ routes: makeRoutes({ fcRedraft: thin }) });

  const { freshness } = await loadAll({ settings, deps });
  const used = buildContext.seen[0].input.values.sources;

  assert.equal(freshness.values, "live");
  assert.equal(used.fc_redraft.count, 199, "the thin redraft table was refused");
  assert.equal(used.fc_dynasty.fetched_at, NOW_ISO, "the dynasty table is live");
});

test("loadAll: Sleeper unreachable falls back to the last-good league snapshot", async () => {
  const savedAt = "2026-09-09T12:00:00Z";
  const { deps, buildContext } = harness({
    routes: makeRoutes({ league: boom, users: boom, rosters: boom, state: boom }),
    seed: sleeperSeed(),
    seedSavedAt: savedAt,
  });

  const { ctx, freshness, errors } = await loadAll({ settings, deps });

  assert.equal(freshness.offline, true);
  assert.equal(freshness.live, savedAt, "the chip shows when the snapshot was taken, not now");
  assert.equal(freshness.pipeline, PIPELINE_AT, "the pipeline files still came off the network");
  assert.equal(ctx.league.id, LEAGUE);
  assert.equal(buildContext.seen[0].input.rosters.length, 8);
  assert.deepEqual(
    errors.map((e) => e.source).sort(),
    ["sleeper:league", "sleeper:rosters", "sleeper:state", "sleeper:users"],
  );
});

test("loadAll: fully offline (no network at all) still opens from cache", async () => {
  const { deps, buildContext } = harness({
    routes: [{ match: /.*/, respond: boom }],
    seed: { ...pipelineSeed(), ...sleeperSeed() },
    seedSavedAt: "2026-09-09T16:10:00Z",
  });

  const { freshness, errors } = await loadAll({ settings, deps });

  assert.equal(freshness.offline, true);
  assert.equal(freshness.values, "cache", "values came out of IndexedDB");
  assert.equal(freshness.pipeline, PIPELINE_AT);
  assert.equal(buildContext.seen[0].input.players.count, 871);
  assert.ok(errors.length >= 9, `expected a fallback note per layer, got ${errors.length}`);
  assert.ok(errors.some((e) => e.source === "data/players.json" && /using cached copy/.test(e.message)));
});

test("loadAll: no data files and no cache is a clear, actionable failure", async () => {
  const { deps } = harness({ routes: [{ match: /.*/, respond: boom }] });
  await assert.rejects(
    () => loadAll({ settings, deps }),
    /could not load data\/players\.json, data\/projections\.json, data\/values\.json/,
  );
});

test("loadAll: no league and no cache names the league id and Settings", async () => {
  const { deps } = harness({ routes: makeRoutes({ league: boom, rosters: boom, state: boom }) });
  await assert.rejects(() => loadAll({ settings, deps }), new RegExp(`could not reach Sleeper for league ${LEAGUE}`));
});

test("loadAll: a throwing onProgress handler cannot break the load", async () => {
  const { deps } = harness();
  const { ctx } = await loadAll({
    settings,
    deps,
    onProgress: () => {
      throw new Error("UI exploded");
    },
  });
  assert.equal(ctx.league.id, LEAGUE);
});

test("loadAll: works with IndexedDB unavailable (private mode)", async () => {
  const { deps } = harness({ idbFail: true });
  const { freshness, errors } = await loadAll({ settings, deps });
  assert.deepEqual(errors, []);
  assert.equal(freshness.offline, false);
});

// ── Meta-first conditional download (design §10.4) ──────────────────────────────────────────
// `data/meta.json` carries the build stamp for all five files. An unchanged stamp means the
// 250 KB behind it is byte-identical, so it is reused from IndexedDB instead of downloaded.

/** The stored copy of a previous, older pipeline build. */
const olderPipelineSeed = (generatedAt = "2026-09-09T09:59:31Z") => ({
  ...pipelineSeed(),
  "pipeline:meta.json": { ...fixture("meta.json"), generated_at: generatedAt },
});

test("loadAll: an unchanged meta.json reuses the stored files and downloads nothing else", async () => {
  const { deps, fetchImpl, buildContext } = harness({
    seed: pipelineSeed(),
    seedSavedAt: "2026-09-08T16:00:00Z", // deliberately old: the stamp decides, not the clock
  });

  const { freshness, errors } = await loadAll({ settings, deps });

  assert.equal(fetchImpl.count("data/"), 1, "only meta.json was fetched");
  assert.deepEqual(fetchImpl.urls("data/"), ["data/meta.json"]);
  assert.equal(freshness.pipelineSource, "idb");
  assert.equal(freshness.pipeline, PIPELINE_AT, "the stamp still describes the data in play");
  assert.equal(freshness.offline, false, "reusing an unchanged build is not an offline fallback");
  assert.deepEqual(errors, [], "and it is not an error either");
  assert.equal(buildContext.seen[0].input.players.count, 871, "the engine got the stored files");
});

test("loadAll: a changed meta.json re-downloads all five files", async () => {
  const { deps, fetchImpl, idb } = harness({ seed: olderPipelineSeed() });

  const { freshness } = await loadAll({ settings, deps });

  assert.equal(fetchImpl.count("data/"), 5);
  assert.equal(freshness.pipelineSource, "network");
  assert.equal(
    idb.store.get("pipeline:meta.json").payload.generated_at,
    PIPELINE_AT,
    "the drawer is re-stamped with the build it now holds",
  );
});

test("loadAll: a half-downloaded build never re-stamps the cache", async () => {
  // Stamping meta before the files land would make the NEXT load reuse the previous players.
  const stale = "2026-09-09T09:59:31Z";
  const routes = makeRoutes().map((route) =>
    route.match === "data/players.json" ? { ...route, respond: boom } : route,
  );
  const { deps, idb, buildContext } = harness({ routes, seed: olderPipelineSeed(stale) });

  const { errors } = await loadAll({ settings, deps });

  assert.equal(idb.store.get("pipeline:meta.json").payload.generated_at, stale, "old stamp kept");
  assert.equal(buildContext.seen[0].input.players.count, 871, "the app still opens on the copy");
  assert.ok(errors.some((e) => e.source === "data/players.json" && /using cached copy/.test(e.message)));
});

test("loadAll: meta.json unreachable falls back to the stored copy and still loads", async () => {
  const routes = makeRoutes().map((route) =>
    route.match === "data/meta.json" ? { ...route, respond: boom } : route,
  );
  const { deps, fetchImpl, idb } = harness({ routes, seed: pipelineSeed() });

  const { freshness, errors } = await loadAll({ settings, deps });

  assert.equal(fetchImpl.count("data/"), 5, "meta was attempted, the other four downloaded");
  assert.equal(freshness.pipelineSource, "network");
  assert.equal(freshness.pipeline, PIPELINE_AT, "the stored meta still dates the build");
  assert.ok(errors.some((e) => e.source === "data/meta.json"));
  assert.equal(idb.store.get("pipeline:players.json").payload.count, 871);
});

test("loadAll: force re-downloads even when the stamp is unchanged", async () => {
  const { deps, fetchImpl } = harness({ seed: pipelineSeed() });
  const { freshness } = await loadAll({ settings, deps, force: true });
  assert.equal(fetchImpl.count("data/"), 5);
  assert.equal(freshness.pipelineSource, "network");
});

test("refreshLive: re-pulls the league, reuses an unchanged pipeline build", async () => {
  const { deps, fetchImpl } = harness({ seed: pipelineSeed() });

  const { freshness } = await refreshLive(settings, { deps });

  assert.equal(fetchImpl.count("data/"), 1, "no re-download of the 250 KB pipeline payload");
  assert.equal(fetchImpl.count("api.sleeper.app"), 4, "league, users, rosters and state re-pulled");
  assert.equal(freshness.pipelineSource, "idb");
  assert.equal(freshness.live, NOW_ISO);
  assert.equal(freshness.offline, false);
});

test("refreshLive: a fresh copy does not bypass a changed stamp", async () => {
  // The v1 rule ("anything fetched in the last 5 minutes is fine") would have kept this copy.
  const { deps, fetchImpl } = harness({
    seed: olderPipelineSeed(),
    seedSavedAt: new Date(NOW - 60_000).toISOString(),
  });

  const { freshness } = await refreshLive(settings, { deps });

  assert.equal(fetchImpl.count("data/"), 5, "the cron rebuilt: take the new files");
  assert.equal(freshness.pipelineSource, "network");
});

// ── League-shape variants (design §10.2) ────────────────────────────────────────────────────

/** The fixture league with a SUPER_FLEX slot bolted on — a 2QB league in every way that counts. */
function superflexLeague() {
  const league = fixture("league.json");
  league.roster_positions = [...league.roster_positions, "SUPER_FLEX"];
  return league;
}

test("fcTableNames maps a league shape to the committed tables", () => {
  assert.deepEqual(fcTableNames(1), { fc_redraft: "fc_redraft", fc_dynasty: "fc_dynasty" });
  assert.deepEqual(fcTableNames(2), { fc_redraft: "fc_redraft_2qb", fc_dynasty: "fc_dynasty_2qb" });
  assert.deepEqual(fcTableNames(3), { fc_redraft: "fc_redraft_2qb", fc_dynasty: "fc_dynasty_2qb" });
});

test("loadAll: a superflex league overlays the _2qb tables, not the 1QB ones", async () => {
  const { deps, fetchImpl, idb, buildContext } = harness({
    routes: makeRoutes({ league: superflexLeague }),
  });

  const { freshness } = await loadAll({ settings, deps });
  const used = buildContext.seen[0].input.values.sources;
  const committed = fixture("values.json").sources;

  assert.equal(freshness.values, "live");
  assert.equal(used.fc_redraft_2qb.count, 199, "the live table landed in the 2QB slot");
  assert.equal(used.fc_dynasty_2qb.count, 423);
  assert.deepEqual(used.fc_redraft_2qb.variant, { numQbs: 2 }, "tagged with the shape it prices");
  assert.equal(used.fc_redraft_2qb.label, "FantasyCalc redraft 2QB");
  assert.equal(used.fc_redraft_2qb.fetched_at, NOW_ISO);
  assert.deepEqual(used.fc_redraft, committed.fc_redraft, "the 1QB tables are left alone");
  assert.deepEqual(used.fc_dynasty, committed.fc_dynasty);

  assert.equal(fetchImpl.count("numQbs=2"), 2, "FantasyCalc was asked for 2QB values");
  assert.ok(idb.store.has("fc:fc_redraft_2qb:2:8:0.5"), "cached under the variant key");
});

// ── Season (design §10.4) ───────────────────────────────────────────────────────────────────

test("loadAll: the season comes from league_season, and listLeagues follows it", async () => {
  const state = () => ({ ...fixture("state.json"), season: "2026", league_season: "2027" });
  const { deps } = harness({ routes: makeRoutes({ state }) });

  const { freshness } = await loadAll({ settings, deps });
  assert.equal(freshness.season, "2027", "Sleeper files leagues under league_season");

  // The picker asks for "this season" without saying which — the last load decides.
  const picker = makeFetchMock([{ match: "/leagues/nfl/", respond: [] }]);
  await listLeagues("1394551386997272576", undefined, {
    deps: { fetchImpl: picker, request: { backoffMs: [0, 0] } },
  });
  assert.match(picker.calls[0].url, /\/user\/1394551386997272576\/leagues\/nfl\/2027\?cb=/);
});

test("loadAll: a state payload without league_season falls back to season", async () => {
  const state = () => {
    const payload = { ...fixture("state.json"), season: "2025" };
    delete payload.league_season;
    return payload;
  };
  const { deps } = harness({ routes: makeRoutes({ state }) });
  const { freshness } = await loadAll({ settings, deps });
  assert.equal(freshness.season, "2025");
});

test("loadAll: a league with no user loads in viewer mode, settings passed through untouched", async () => {
  const { deps, buildContext } = harness();
  const viewer = { leagueId: LEAGUE, season: "2026" }; // no userId, no username

  const { freshness } = await loadAll({ settings: viewer, deps });

  assert.equal(buildContext.seen[0].settings, viewer, "handed to the engine as-is, by reference");
  assert.deepEqual(Object.keys(viewer).sort(), ["leagueId", "season"], "and never written to");
  assert.equal(freshness.season, "2026");
  assert.equal(buildContext.seen[0].input.rosters.length, 8, "the whole league is still readable");
});
