import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, STORAGE_KEY } from "../src/config.js";
import { listLeagues, loadSettings, lookupUser, saveSettings } from "../src/data.js";
import { fixture, jsonResponse, makeFetchMock } from "./shims/fetch-mock.mjs";

/** Install a localStorage stand-in; returns the uninstaller. */
function installLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const shim = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true, writable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  };
}

test("loadSettings returns DEFAULTS when nothing is stored, by value not by reference", (t) => {
  t.after(installLocalStorage());
  const snapshot = JSON.parse(JSON.stringify(DEFAULTS));
  const settings = loadSettings();

  assert.equal(settings.leagueId, DEFAULTS.leagueId);
  assert.deepEqual(settings.weights, DEFAULTS.weights);
  settings.weights.fc_redraft = 0.99;
  settings.finder.shapes.push("3-1");
  settings.injuryDiscount.Out = 1;
  assert.deepEqual(
    JSON.parse(JSON.stringify(DEFAULTS)),
    snapshot,
    "DEFAULTS must not be mutable through the result",
  );
});

test("stored settings deep-merge over DEFAULTS", (t) => {
  t.after(
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({ leagueId: "999", weights: { proj: 0.4 }, finder: { perRival: 3 } }),
    }),
  );
  const settings = loadSettings();

  assert.equal(settings.leagueId, "999");
  assert.equal(settings.weights.proj, 0.4, "patched leaf");
  assert.equal(settings.weights.fc_redraft, DEFAULTS.weights.fc_redraft, "sibling keys survive");
  assert.equal(settings.finder.perRival, 3);
  assert.deepEqual(settings.finder.shapes, DEFAULTS.finder.shapes);
  assert.equal(settings.username, DEFAULTS.username);
});

test("corrupt stored JSON falls back to DEFAULTS instead of throwing", (t) => {
  t.after(installLocalStorage({ [STORAGE_KEY]: "{not json" }));
  assert.equal(loadSettings().leagueId, DEFAULTS.leagueId);
});

test("saveSettings merges, persists and returns the merged settings", (t) => {
  t.after(installLocalStorage());

  const saved = saveSettings({ leagueId: "42", weights: { proj: 0.25 } });
  assert.equal(saved.leagueId, "42");
  assert.equal(saved.weights.proj, 0.25);

  const persisted = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY));
  assert.equal(persisted.leagueId, "42");
  assert.equal(loadSettings().weights.proj, 0.25, "a reload sees it");

  saveSettings({ keeperWeight: 0.3 });
  assert.equal(loadSettings().leagueId, "42", "later patches do not clobber earlier ones");
  assert.equal(loadSettings().keeperWeight, 0.3);
});

test("settings still work with no localStorage at all (private mode)", () => {
  // No shim installed on purpose — Node has no localStorage, same as a blocked browser.
  assert.equal(loadSettings().leagueId, DEFAULTS.leagueId);
  assert.equal(saveSettings({ leagueId: "7" }).leagueId, "7", "returns the merge even when it cannot persist");
});

test("lookupUser normalizes the Settings-tab user shape", async () => {
  const fetchImpl = makeFetchMock([
    {
      match: "/user/tommyteez",
      respond: { user_id: "1394551386997272576", display_name: "tommyteez", avatar: "6a3ae7", extra: "ignored" },
    },
  ]);

  const user = await lookupUser("  tommyteez  ", { deps: { fetchImpl, request: { backoffMs: [0, 0] } } });
  assert.deepEqual(user, { user_id: "1394551386997272576", display_name: "tommyteez", avatar: "6a3ae7" });
  assert.match(fetchImpl.calls[0].url, /\/v1\/user\/tommyteez\?cb=/, "whitespace trimmed before the request");
});

test("lookupUser explains an unknown username (Sleeper answers 200 null)", async () => {
  const fetchImpl = makeFetchMock([{ match: "/user/", respond: jsonResponse(null, 200) }]);
  await assert.rejects(
    () => lookupUser("nosuchuser", { deps: { fetchImpl, request: { backoffMs: [0, 0] } } }),
    /No Sleeper user called "nosuchuser"/,
  );
});

test("listLeagues returns just what the league picker needs", async () => {
  const fetchImpl = makeFetchMock([
    { match: "/leagues/nfl/2026", respond: [fixture("league.json"), { league_id: 555, season: 2026 }] },
  ]);

  const leagues = await listLeagues("1394551386997272576", "2026", {
    deps: { fetchImpl, request: { backoffMs: [0, 0] } },
  });

  assert.deepEqual(leagues[0], {
    league_id: "1394476745138147328",
    name: "Boyball 🏈",
    total_rosters: 8,
    status: "in_season",
    season: "2026",
  });
  assert.deepEqual(leagues[1], {
    league_id: "555",
    name: "(unnamed league)",
    total_rosters: 0,
    status: "unknown",
    season: "2026",
  });
});

test("null league/user defaults survive the merge (a fresh install, pre-onboarding)", (t) => {
  // config.js ships leagueId/userId/username as null now; the merge must treat an explicit null
  // as a value rather than tripping over it, or the app cannot boot into setup.
  t.after(
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({ leagueId: null, userId: null, username: null }),
    }),
  );
  const settings = loadSettings();

  assert.equal(settings.leagueId, null);
  assert.equal(settings.userId, null);
  assert.equal(settings.username, null);
  assert.deepEqual(settings.weights, DEFAULTS.weights, "the rest of the defaults are untouched");
  assert.deepEqual(settings.finder.shapes, DEFAULTS.finder.shapes);
});

test("onboarding writes a league over an empty default and it sticks", (t) => {
  t.after(installLocalStorage({ [STORAGE_KEY]: JSON.stringify({ leagueId: null, userId: null }) }));

  const saved = saveSettings({
    leagueId: "1394476745138147328",
    userId: "1394551386997272576",
    username: "tommyteez",
  });

  assert.equal(saved.leagueId, "1394476745138147328");
  assert.equal(loadSettings().userId, "1394551386997272576");
  assert.equal(loadSettings().username, "tommyteez");
});

test("a viewer keeps their league but drops the user (browse-only mode)", (t) => {
  t.after(installLocalStorage({ [STORAGE_KEY]: JSON.stringify({ leagueId: "42", userId: "7" }) }));
  const saved = saveSettings({ userId: null, username: null });
  assert.equal(saved.leagueId, "42");
  assert.equal(saved.userId, null, "an explicit null clears a stored id");
});
