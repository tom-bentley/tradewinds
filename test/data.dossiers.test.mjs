// `loadDossiers` and the dossier validator (004 design §2.4).
//
// The slice is DESK-written, not pipeline-written, so it carries no `meta.json` stamp and cannot
// ride along with the pipeline download — it has its own loader, modelled on `loadAdvisorFeed`,
// with the same rule: every failure mode resolves `null` and none of them is an error. A repo
// whose research desk has never run simply has no such file.

import test from "node:test";
import assert from "node:assert/strict";

import { DOSSIERS_FILE, loadAll, loadDossiers } from "../src/data.js";
import { validateDossiers } from "../pipeline/contract.mjs";
import { fixture, jsonResponse, makeFetchMock } from "./shims/fetch-mock.mjs";
import { makeMemoryIdb } from "./shims/idb-shim.mjs";

const SLICE = fixture("dossiers_sample.json");
const INVALID = fixture("dossiers_invalid.json");
const KEY = `pipeline:${DOSSIERS_FILE}`;

const deps = (respond, seed = {}) => ({
  fetchImpl: makeFetchMock([{ match: `data/${DOSSIERS_FILE}`, respond }]),
  idb: makeMemoryIdb(seed),
});

test("loadDossiers reads the file and files a copy in the drawer", async () => {
  const { fetchImpl, idb } = deps(() => SLICE);
  assert.deepEqual(await loadDossiers({ fetchImpl, idb }), SLICE);
  assert.deepEqual((await idb.get(KEY)).payload, SLICE);
  // No cache-buster on the URL, `no-store` instead — the SW copy stays addressable offline.
  assert.equal(fetchImpl.calls[0].cache, "no-store");
  assert.ok(!fetchImpl.calls[0].url.includes("cb="));
});

test("loadDossiers treats a 404 as absent and never caches the error page over a good copy", async () => {
  // GitHub Pages serves a 404 as an HTML page, so the shape gate is what keeps it out of the engine.
  const { fetchImpl, idb } = deps(() => jsonResponse({ nope: true }, 404), { [KEY]: SLICE });
  assert.equal(await loadDossiers({ fetchImpl, idb }), SLICE, "the cached copy answers instead");
  assert.deepEqual((await idb.get(KEY)).payload, SLICE, "the drawer was not overwritten");
});

test("loadDossiers rejects a 200 that is not a dossier file", async () => {
  for (const body of [{ v: 2, players: {} }, { v: 1 }, { v: 1, players: [] }, "<!doctype html>", null]) {
    const { fetchImpl, idb } = deps(() => body);
    assert.equal(await loadDossiers({ fetchImpl, idb }), null, JSON.stringify(body));
    assert.equal(await idb.get(KEY), undefined, "nothing unusable is ever cached");
  }
});

test("loadDossiers resolves null when there is no file and no cached copy", async () => {
  const { fetchImpl, idb } = deps(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal(await loadDossiers({ fetchImpl, idb }), null);
  // A cached copy that is itself malformed is not trusted either.
  const stale = deps(
    () => {
      throw new TypeError("fetch failed");
    },
    { [KEY]: { v: 99 } },
  );
  assert.equal(await loadDossiers(stale), null);
});

test("loadAll hands buildContext the slice, and null when the desk has never run", async () => {
  const settings = { leagueId: "1394476745138147328", userId: "1394551386997272576", season: "2026" };
  const routes = (dossiers) => [
    ...["players.json", "projections.json", "values.json", "schedule.json", "meta.json", "history.json"].map(
      (file) => ({ match: `data/${file}`, respond: () => fixture(file) }),
    ),
    { match: `data/${DOSSIERS_FILE}`, respond: dossiers },
    { match: "/trending/add", respond: () => fixture("trending_add.json") },
    { match: /\/league\/[^/?]+\/users/, respond: () => fixture("users.json") },
    { match: /\/league\/[^/?]+\/rosters/, respond: () => fixture("rosters.json") },
    { match: /\/league\/[^/?]+\?cb=/, respond: () => fixture("league.json") },
    { match: "/state/nfl", respond: () => fixture("state.json") },
    { match: "isDynasty=false", respond: () => fixture("fantasycalc_redraft_raw.json") },
    { match: "isDynasty=true", respond: () => fixture("fantasycalc_dynasty_raw.json") },
  ];
  const run = async (dossiers) => {
    const seen = [];
    const buildContext = (input) => {
      seen.push(input);
      return { league: {}, week: 1 };
    };
    await loadAll({
      settings,
      deps: { fetchImpl: makeFetchMock(routes(dossiers)), idb: makeMemoryIdb(), buildContext, now: () => Date.parse("2026-09-09T18:00:00Z") },
    });
    return seen[0];
  };

  assert.deepEqual((await run(() => SLICE)).dossiers, SLICE);
  assert.equal((await run(() => jsonResponse({}, 404))).dossiers, null, "absent is the ordinary case");
});

// ── validateDossiers (R11 §Q11.3's 11 rules, R7 §6.3 enums) ────────────────────────────────────

test("the sample slice passes, and every row fits the 512 B cap", () => {
  assert.deepEqual(validateDossiers(SLICE), []);
  for (const row of Object.values(SLICE.players)) {
    assert.ok(Buffer.byteLength(JSON.stringify(row), "utf8") <= 512);
  }
});

test("validateDossiers names free-text enums, a broken distribution and a thin deep fill", () => {
  const problems = validateDossiers(INVALID);
  const says = (text) => problems.some((problem) => problem.includes(text));
  assert.ok(says('codes.injury_type is "meniscus"'), "R7 enums are UPPER_SNAKE — rule 4");
  assert.ok(says('codes.severity is "bad"'), "rule 4");
  assert.ok(says("branches sum to 0.7"), "rule 7: Σp = 1 ± 0.001");
  assert.ok(says("is not above the previous branch"), "rule 7: strictly increasing games");
  assert.ok(says("deep with n=1"), "rule 9: a deep dossier is a three-fill consensus");
  // The one good row in the same file is not blamed for its neighbour.
  assert.ok(!problems.some((problem) => problem.includes('players["10236"]')));
});

test("validateDossiers enforces the TTL ladder and the expiry ordering (rule 2)", () => {
  const withRow = (patch) => ({
    ...SLICE,
    players: { 10236: { ...SLICE.players["10236"], ...patch } },
  });
  assert.ok(
    validateDossiers(withRow({ expires_at: "2026-09-22T13:38:00Z" })).some((p) => p.includes("not after as_of")),
  );
  // deep is 48 h; 72 h of claimed freshness is a standard-depth claim on a deep row.
  assert.ok(
    validateDossiers(withRow({ expires_at: "2026-09-25T13:38:00Z" })).some((p) => p.includes("deep TTL is 48 h")),
  );
  // The same span is fine at standard depth (72 h), once `n` matches the depth.
  assert.deepEqual(
    validateDossiers(withRow({ depth: "standard", expires_at: "2026-09-25T13:38:00Z" })),
    [],
  );
});

test("validateDossiers runs the cross-file rules only when it is given the other side", () => {
  const ids = Object.keys(SLICE.players);
  assert.deepEqual(validateDossiers(SLICE, { playerIds: ids, dossierFiles: ids }), []);
  // Rule 3: a slice row for a player data/players.json has never heard of.
  assert.ok(validateDossiers(SLICE, { playerIds: [] }).some((p) => p.includes("not a player in data/players.json")));
  // Rule 11: both directions of the orphan check.
  assert.ok(validateDossiers(SLICE, { dossierFiles: [] }).some((p) => p.includes("has no data/dossiers/")));
  assert.ok(
    validateDossiers(SLICE, { dossierFiles: [...ids, "999"] }).some((p) => p.includes("has no slice row")),
  );
});

test("validateDossiers rejects a wrong version, a missing rubric and a malformed file", () => {
  assert.ok(validateDossiers({ ...SLICE, v: 2 }).some((p) => p.includes("dossiers.v must be 1")));
  assert.ok(validateDossiers({ ...SLICE, rubric: null }).some((p) => p.includes("dossiers.rubric")));
  assert.deepEqual(validateDossiers(null), ["dossiers: not an object"]);
  assert.ok(validateDossiers({ ...SLICE, players: [] }).some((p) => p.includes("not an object")));
});
