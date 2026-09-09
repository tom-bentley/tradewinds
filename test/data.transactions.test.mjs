import test from "node:test";
import assert from "node:assert/strict";

import { getTransactions, normalizeTransaction } from "../src/data.js";
import { fixture, jsonResponse, makeFetchMock } from "./shims/fetch-mock.mjs";
import { makeMemoryIdb } from "./shims/idb-shim.mjs";

const LEAGUE = "1394476745138147328";
const roundOf = (url) => Number(url.match(/\/transactions\/(\d+)/)?.[1] ?? 0);
const ctxAt = (week) => ({ league: { id: LEAGUE }, week });

function harness(respond) {
  const fetchImpl = makeFetchMock([
    {
      match: "/transactions/",
      respond: respond ?? (({ url }) => (roundOf(url) === 1 ? fixture("transactions_1.json") : [])),
    },
  ]);
  const idb = makeMemoryIdb();
  return { fetchImpl, idb, deps: { fetchImpl, idb, request: { backoffMs: [0, 0] } } };
}

test("normalizeTransaction maps Sleeper's field names to the app's", () => {
  const raw = fixture("transactions_1.json")[1];
  assert.deepEqual(normalizeTransaction(raw, 1), {
    id: "1402506705622855680",
    week: 1,
    type: "free_agent",
    status: "complete",
    created: 1788746165237,
    adds: { 9502: 2 },
    drops: { 12534: 2 },
    rosterIds: [2],
    draftPicks: [],
  });
  // Sleeper sends null for "nothing dropped"; the UI should never have to null-check.
  assert.deepEqual(normalizeTransaction({ transaction_id: "x", adds: null, drops: null }, 4).drops, {});
  assert.equal(normalizeTransaction({ transaction_id: "x" }, 4).week, 4, "leg falls back to the round");
});

test("getTransactions normalizes week 1 and sorts newest first", async () => {
  const { deps, fetchImpl } = harness();

  const txns = await getTransactions(ctxAt(1), { deps });

  assert.equal(txns.length, 7);
  assert.equal(fetchImpl.count("/transactions/1"), 1, "week 1 is the current week: exactly one round");
  assert.equal(txns.filter((t) => t.type === "free_agent").length, 6);
  assert.equal(txns.filter((t) => t.type === "waiver").length, 1);
  assert.ok(txns.every((t) => t.status === "complete"));
  assert.ok(txns.every((t) => t.week === 1 && Array.isArray(t.draftPicks) && t.draftPicks.length === 0));

  const created = txns.map((t) => t.created);
  assert.deepEqual(created, [...created].sort((a, b) => b - a), "newest first");
  assert.equal(txns[0].id, "1402507062906265600");
  assert.deepEqual(txns[0].adds, { 10219: 2 });
  assert.deepEqual(txns[0].drops, {}, "an add with no drop normalizes to an empty object");
  assert.deepEqual(txns[0].rosterIds, [2]);

  const waiver = txns.find((t) => t.type === "waiver");
  assert.deepEqual(waiver.adds, { 6806: 1 });
  assert.deepEqual(waiver.drops, { 4046: 1 });
});

test("getTransactions caches closed weeks and always re-pulls the current one", async () => {
  const { deps, fetchImpl, idb } = harness();

  const first = await getTransactions(ctxAt(3), { deps });
  assert.equal(first.length, 7, "week 1 has the moves; weeks 2 and 3 are empty");
  assert.equal(fetchImpl.count("/transactions/"), 3, "one request per round on a cold cache");
  assert.deepEqual(
    [...idb.store.keys()].sort(),
    [`sleeper:txns:${LEAGUE}:1`, `sleeper:txns:${LEAGUE}:2`],
    "only the closed weeks are cached",
  );

  const second = await getTransactions(ctxAt(3), { deps });
  assert.deepEqual(second, first);
  assert.equal(fetchImpl.count("/transactions/"), 4, "only the live week was re-fetched");
  assert.equal(fetchImpl.count("/transactions/3"), 2);
});

test("getTransactions honors an explicit rounds list", async () => {
  const { deps, fetchImpl } = harness();
  const txns = await getTransactions(ctxAt(8), { rounds: [1], deps });
  assert.equal(txns.length, 7);
  assert.deepEqual(fetchImpl.urls("/transactions/").map(roundOf), [1]);
});

test("rounds may be a single number meaning 'weeks 1..N' (how the League tab calls it)", async () => {
  const { deps, fetchImpl } = harness();
  await getTransactions(ctxAt(4), { rounds: 3, deps });
  assert.deepEqual(fetchImpl.urls("/transactions/").map(roundOf).sort(), [1, 2, 3]);
});

test("a failing round degrades to the cached copy, then to an empty list", async (t) => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args[0]);
  t.after(() => {
    console.warn = realWarn;
  });

  const { deps, fetchImpl } = harness(({ url }) => {
    if (roundOf(url) === 2) return jsonResponse({ error: "nope" }, 500);
    return roundOf(url) === 1 ? fixture("transactions_1.json") : [];
  });

  const first = await getTransactions(ctxAt(3), { deps });
  assert.equal(first.length, 7, "week 2 failing does not lose weeks 1 and 3");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transactions for week 2 unavailable/);

  // Week 1 is now cached, so a total outage still returns it.
  fetchImpl.calls.length = 0;
  const second = await getTransactions(ctxAt(3), {
    deps: { ...deps, fetchImpl: makeFetchMock([{ match: /.*/, respond: () => { throw new TypeError("fetch failed"); } }]) },
  });
  assert.equal(second.length, 7);
});
