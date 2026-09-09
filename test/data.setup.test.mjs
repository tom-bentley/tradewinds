// First-run behaviour: no baked-in league (design §10.4). Onboarding is a starting state, not an
// error, and a shared `?league=…&user=…` link has to survive being pasted into a fresh browser.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SetupRequiredError,
  applyDeepLink,
  clearDeepLink,
  currentSeason,
  getCurrentSeason,
  loadAll,
  readDeepLink,
  seasonFromState,
} from "../src/data.js";
import { jsonResponse, makeFetchMock } from "./shims/fetch-mock.mjs";
import { makeMemoryIdb } from "./shims/idb-shim.mjs";

const LEAGUE = "1394476745138147328";
const USER = "1394551386997272576";
const quiet = { request: { backoffMs: [0, 0] } };

/** Deps whose fetch fails the test if it is ever called. */
function noNetwork() {
  const fetchImpl = makeFetchMock([]); // every route misses → TypeError, like an offline fetch
  return { fetchImpl, deps: { fetchImpl, idb: makeMemoryIdb(), ...quiet } };
}

/** Silence one expected console.warn for the length of a test. */
function muteWarnings(t) {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
}

/** Install a `location` (and optional `history`) shim; returns the recorded replaceState urls. */
function installLocation(t, href) {
  const replaced = [];
  const previous = ["location", "history"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  Object.defineProperty(globalThis, "location", {
    value: new URL(href),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: { replaceState: (_state, _title, url) => replaced.push(url) },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return replaced;
}

// ── SetupRequiredError ──────────────────────────────────────────────────────────────────────

test("loadAll without a league asks for setup instead of failing", async () => {
  const { fetchImpl, deps } = noNetwork();

  const error = await loadAll({ settings: { season: "2026" }, deps }).then(
    () => null,
    (reason) => reason,
  );

  assert.ok(error instanceof SetupRequiredError);
  assert.ok(error instanceof Error, "still an Error, so a generic handler can log it");
  assert.equal(error.code, "SETUP_REQUIRED", "the UI may switch on the code instead");
  assert.equal(error.name, "SetupRequiredError");
  assert.match(error.message, /league/i);
  assert.equal(fetchImpl.calls.length, 0, "nothing was fetched — there is nothing to fetch yet");
});

test("null, empty and whitespace league ids all mean 'not set up yet'", async () => {
  for (const leagueId of [null, undefined, "", "   "]) {
    const { deps } = noNetwork();
    await assert.rejects(() => loadAll({ settings: { leagueId }, deps }), SetupRequiredError);
  }
});

// ── Deep links ──────────────────────────────────────────────────────────────────────────────

test("readDeepLink parses ?league=&user= into a settings patch", () => {
  assert.deepEqual(readDeepLink(`?league=${LEAGUE}&user=${USER}`), {
    leagueId: LEAGUE,
    userId: USER,
  });
  assert.deepEqual(readDeepLink(`?league=${LEAGUE}&user=tommyteez`), {
    leagueId: LEAGUE,
    username: "tommyteez",
  });
  assert.deepEqual(readDeepLink(`?league=${LEAGUE}`), { leagueId: LEAGUE }, "user is optional");
  assert.deepEqual(readDeepLink(`league=${LEAGUE}&tab=deals`), { leagueId: LEAGUE }, "no '?' needed");
  assert.deepEqual(readDeepLink(`?league=${LEAGUE}&user=%20tommyteez%20`), {
    leagueId: LEAGUE,
    username: "tommyteez",
  });
});

test("readDeepLink returns null for anything that is not a league link", () => {
  for (const search of ["", "?", "?tab=deals", "?league=", "?league=%20", "?user=tommyteez"]) {
    assert.equal(readDeepLink(search), null, search || "(empty)");
  }
  assert.equal(readDeepLink("?league=boyball"), null, "a league id is numeric");
  assert.equal(readDeepLink(null), null);
  assert.equal(readDeepLink(undefined), null, "no location in Node either");
});

test("readDeepLink reads location.search when nothing is passed", (t) => {
  installLocation(t, `https://tom-bentley.github.io/tradewinds/?league=${LEAGUE}&user=hobbezilla`);
  assert.deepEqual(readDeepLink(), { leagueId: LEAGUE, username: "hobbezilla" });
});

test("applyDeepLink resolves a username, and never calls out for a numeric id", async () => {
  const idOnly = noNetwork();
  assert.deepEqual(await applyDeepLink({ search: `?league=${LEAGUE}&user=${USER}`, deps: idOnly.deps }), {
    leagueId: LEAGUE,
    userId: USER,
  });
  assert.equal(idOnly.fetchImpl.calls.length, 0, "a numeric user needs no lookup");

  const fetchImpl = makeFetchMock([
    { match: "/user/tommyteez", respond: { user_id: USER, display_name: "tommyteez" } },
  ]);
  const patch = await applyDeepLink({
    search: `?league=${LEAGUE}&user=tommyteez`,
    deps: { fetchImpl, ...quiet },
  });
  assert.deepEqual(patch, { leagueId: LEAGUE, userId: USER, username: "tommyteez" });
});

test("applyDeepLink still opens the league when the username is unknown (viewer mode)", async (t) => {
  muteWarnings(t);
  const fetchImpl = makeFetchMock([{ match: "/user/", respond: jsonResponse(null, 200) }]);

  const patch = await applyDeepLink({
    search: `?league=${LEAGUE}&user=ghost`,
    deps: { fetchImpl, ...quiet },
  });

  assert.deepEqual(patch, { leagueId: LEAGUE, username: "ghost" }, "no userId — nobody's team");
});

test("applyDeepLink is null when there is no link to apply", async () => {
  const { fetchImpl, deps } = noNetwork();
  assert.equal(await applyDeepLink({ search: "?tab=deals", deps }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("clearDeepLink strips only the link parameters", (t) => {
  const replaced = installLocation(t, `https://host/tradewinds/?league=${LEAGUE}&user=x&tab=deals`);
  clearDeepLink();
  assert.deepEqual(replaced, ["/tradewinds/?tab=deals"]);
});

test("clearDeepLink does nothing when there is nothing to strip", (t) => {
  const replaced = installLocation(t, "https://host/tradewinds/?tab=deals");
  clearDeepLink();
  assert.deepEqual(replaced, [], "no pointless history entry");
});

test("clearDeepLink outside a browser is a no-op, not a crash", () => {
  assert.equal(clearDeepLink(), undefined);
});

// ── Season ──────────────────────────────────────────────────────────────────────────────────

test("seasonFromState prefers league_season, then season, then settings", () => {
  assert.equal(seasonFromState({ league_season: "2027", season: "2026" }), "2027");
  assert.equal(seasonFromState({ season: "2026" }), "2026");
  assert.equal(seasonFromState({}, { season: "2025" }), "2025");
  assert.equal(seasonFromState(null, {}), String(new Date().getUTCFullYear() - (new Date().getUTCMonth() >= 2 ? 0 : 1)));
  assert.match(currentSeason(), /^\d{4}$/, "there is always some season to ask about");
});

// NOTE: this pair is order-dependent — a successful getCurrentSeason memoizes the season for
// `currentSeason()`, so the offline fallback has to be exercised first.
test("getCurrentSeason falls back to settings when Sleeper is unreachable", async (t) => {
  muteWarnings(t);
  const fetchImpl = makeFetchMock([]);
  assert.equal(await getCurrentSeason({ settings: { season: "2024" }, deps: { fetchImpl, ...quiet } }), "2024");
});

test("getCurrentSeason reads the season off /state/nfl and remembers it", async () => {
  const fetchImpl = makeFetchMock([{ match: "/state/nfl", respond: { season: "2026", league_season: "2027" } }]);

  assert.equal(await getCurrentSeason({ deps: { fetchImpl, ...quiet } }), "2027");
  assert.equal(currentSeason(), "2027", "the league picker gets it without a second call");
  assert.match(fetchImpl.calls[0].url, /\/v1\/state\/nfl\?cb=/);
});
