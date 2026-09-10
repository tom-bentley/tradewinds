// Tradewinds — the live-status layer behind the Advisor tab (design §12.4).
//
// Everything here runs against a mocked fetch and an in-memory IndexedDB: no network, no clock.
// The two rules worth guarding are the ones the UI leans on hardest — one dead player id must
// never sink the whole refresh, and `applyStatuses` must hand back a NEW context (the engine
// memoizes week vectors off the players map, so a mutated ctx would silently serve stale math).

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADVISOR_FILE,
  applyStatusesLocal,
  loadAdvisorFeed,
  markAdviceSeen,
  refreshStatuses,
  snapshotOf,
  statusKeyOf,
  statusRowFrom,
  storedStatuses,
  unseenAdviceKeys,
} from "../src/data.js";
import { jsonResponse, makeFetchMock, networkError } from "./shims/fetch-mock.mjs";
import { makeMemoryIdb } from "./shims/idb-shim.mjs";

const LEAGUE = "1394476745138147328";
const NOW = Date.parse("2026-09-10T14:00:00Z");

/** The five fields the app reads off Sleeper's per-player row, as Sleeper actually shapes them. */
const sleeperRow = (id, patch = {}) => ({
  player_id: id,
  full_name: "Brock Bowers",
  position: "TE",
  team: "LV",
  injury_status: null,
  injury_body_part: null,
  injury_notes: null,
  news_updated: 1757500000000,
  depth_chart_order: 1,
  ...patch,
});

/** A context just rich enough for `applyStatuses`: the players map and a primed memo. */
function makeCtx(extra = {}) {
  return {
    league: { id: LEAGUE, name: "Boyball 🏈" },
    week: 2,
    players: new Map([
      ["11604", { id: "11604", name: "Brock Bowers", pos: "TE", team: "LV", inj: null, dc: 1 }],
      ["5022", { id: "5022", name: "Dallas Goedert", pos: "TE", team: "PHI", inj: null, dc: 1 }],
    ]),
    memo: { weekVector: "stale" },
    ...extra,
  };
}

const routes = (rows) =>
  Object.entries(rows).map(([id, respond]) => ({ match: `/players/nfl/${id}`, respond }));

/* ---------------------------------------------------------------- row mapping */

test("statusRowFrom keeps the five live fields and normalizes empty strings to null", () => {
  const row = statusRowFrom("11604", sleeperRow("11604", {
    injury_status: "Doubtful",
    injury_body_part: "Knee - Meniscus",
    injury_notes: "Bowers had a procedure on his knee Tuesday.",
    news_updated: 1757464500000,
    depth_chart_order: 1,
  }));
  assert.deepEqual(row, {
    id: "11604",
    inj: "Doubtful",
    injPart: "Knee - Meniscus",
    injNotes: "Bowers had a procedure on his knee Tuesday.",
    newsAt: 1757464500000,
    dc: 1,
  });

  // Sleeper reports a healthy player with nulls, and occasionally with empty strings — "" and
  // null must not read as two different statuses when the snapshot is diffed.
  const healthy = statusRowFrom("5022", sleeperRow("5022", { injury_status: "", injury_body_part: "  " }));
  assert.equal(healthy.inj, null);
  assert.equal(healthy.injPart, null);
  assert.equal(statusRowFrom("x", null).newsAt, null, "a missing row is all nulls, never NaN");
});

test("statusKey ignores news_updated, so a re-run of the same news is not a new event", () => {
  const a = statusRowFrom("11604", sleeperRow("11604", { injury_status: "Doubtful", news_updated: 1 }));
  const b = statusRowFrom("11604", sleeperRow("11604", { injury_status: "Doubtful", news_updated: 999 }));
  assert.equal(statusKeyOf(a), statusKeyOf(b));
  assert.equal(statusKeyOf({ inj: "Out", injPart: "Knee", injNotes: null }), "Out|Knee|");
  assert.deepEqual(snapshotOf([a, { id: "5022", inj: null }]), { 11604: "Doubtful||", 5022: "||" });
});

/* ---------------------------------------------------------------- applyStatuses */

test("applyStatusesLocal returns a NEW context and never touches the input", () => {
  const ctx = makeCtx();
  const before = ctx.players.get("11604");
  const next = applyStatusesLocal(ctx, [
    { id: "11604", inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery", newsAt: 7, dc: null },
    { id: "nobody", inj: "Out" },
  ]);

  assert.notEqual(next, ctx, "a new context object");
  assert.notEqual(next.players, ctx.players, "a new players map");
  assert.deepEqual(next.memo, {}, "the memo is dropped — week vectors cache the injury status");
  assert.equal(ctx.players.get("11604"), before, "the input row is untouched");
  assert.equal(ctx.memo.weekVector, "stale", "the input memo is untouched");

  const patched = next.players.get("11604");
  assert.equal(patched.inj, "Doubtful");
  assert.equal(patched.injPart, "Knee - Meniscus");
  assert.equal(patched.newsAt, 7);
  assert.equal(patched.dc, 1, "a row with no depth-chart order keeps what players.json knew");
  assert.equal(patched.name, "Brock Bowers", "everything else survives");
  assert.equal(next.players.get("5022").inj, null, "a player nobody reported on is unchanged");
  assert.equal(next.players.has("nobody"), false, "unknown ids are ignored");
});

test("applyStatusesLocal clears a status when Sleeper clears it", () => {
  const ctx = makeCtx();
  ctx.players.set("11604", { ...ctx.players.get("11604"), inj: "Doubtful", injPart: "Knee" });
  const next = applyStatusesLocal(ctx, [{ id: "11604", inj: null, injPart: null, injNotes: null, newsAt: 9 }]);
  assert.equal(next.players.get("11604").inj, null);
  assert.equal(next.players.get("11604").injPart, null);
});

/* ---------------------------------------------------------------- refreshStatuses */

test("refreshStatuses maps every id, applies them to a new ctx and stores the snapshot", async () => {
  const fetchImpl = makeFetchMock(routes({
    11604: sleeperRow("11604", {
      injury_status: "Doubtful",
      injury_body_part: "Knee - Meniscus",
      injury_notes: "Surgery Tuesday.",
    }),
    5022: sleeperRow("5022"),
  }));
  const idb = makeMemoryIdb();
  const ctx = makeCtx();

  const out = await refreshStatuses(ctx, ["11604", "5022", "11604"], {
    fetchImpl, idb, now: () => NOW, request: { backoffMs: [0, 0] },
  });

  assert.deepEqual(out.failed, []);
  assert.equal(out.rows.length, 2, "the duplicate id is read once");
  assert.notEqual(out.ctx, ctx, "a NEW context comes back");
  assert.equal(out.ctx.players.get("11604").inj, "Doubtful");
  assert.equal(ctx.players.get("11604").inj, null, "and the one that went in is untouched");
  assert.equal(out.at, new Date(NOW).toISOString());
  assert.equal(out.prev, null, "first visit: nothing to diff against");
  assert.deepEqual(out.next, { 11604: "Doubtful|Knee - Meniscus|Surgery Tuesday.", 5022: "||" });

  for (const call of fetchImpl.calls) {
    assert.match(call.url, /[?&]cb=\d+/, "Sleeper caches this endpoint for 10 minutes");
    assert.equal(call.cache, "no-store");
  }

  const stored = await storedStatuses(LEAGUE, { idb });
  assert.equal(stored.at, out.at);
  assert.equal(stored.rows.length, 2);
  assert.deepEqual(stored.keys, out.next);
});

test("refreshStatuses tolerates one failed id and keeps its last known key", async () => {
  const idb = makeMemoryIdb();
  const ctx = makeCtx();

  const first = await refreshStatuses(ctx, ["11604", "5022"], {
    fetchImpl: makeFetchMock(routes({ 11604: sleeperRow("11604"), 5022: sleeperRow("5022") })),
    idb, now: () => NOW, request: { backoffMs: [0, 0] },
  });
  assert.deepEqual(first.failed, []);

  const flaky = makeFetchMock([
    { match: "/players/nfl/11604", respond: sleeperRow("11604", { injury_status: "Out" }) },
    { match: "/players/nfl/5022", respond: networkError() },
  ]);
  const second = await refreshStatuses(ctx, ["11604", "5022"], {
    fetchImpl: flaky, idb, now: () => NOW + 60000, request: { backoffMs: [0, 0] },
  });

  assert.deepEqual(second.failed, ["5022"], "the dead id is reported, not thrown");
  assert.equal(second.rows.length, 1, "the good row still came back");
  assert.equal(second.ctx.players.get("11604").inj, "Out");
  assert.deepEqual(second.prev, { 11604: "||", 5022: "||" }, "the previous visit is what we diff against");
  assert.equal(second.next["5022"], "||", "a flaky request never reads as 'his status was cleared'");
  assert.equal(second.next["11604"], "Out||");
});

test("refreshStatuses honours the concurrency bound and an empty watch set", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = makeFetchMock([{
    match: "/players/nfl/",
    respond: async ({ url }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return sleeperRow(url.split("/players/nfl/")[1].split("?")[0]);
    },
  }]);
  const idb = makeMemoryIdb();

  const ids = Array.from({ length: 9 }, (_, i) => String(9000 + i));
  const out = await refreshStatuses(makeCtx(), ids, { fetchImpl, idb, concurrency: 3, now: () => NOW });
  assert.equal(out.rows.length, 9);
  assert.ok(peak <= 3, `at most three reads in flight (saw ${peak})`);

  const none = await refreshStatuses(makeCtx(), [], { fetchImpl, idb, now: () => NOW });
  assert.deepEqual(none.rows, []);
  assert.notEqual(none.ctx, null);
});

test("refreshStatuses prefers an injected applyStatuses (the engine's, once it lands)", async () => {
  const fetchImpl = makeFetchMock(routes({ 11604: sleeperRow("11604") }));
  const seen = [];
  const out = await refreshStatuses(makeCtx(), ["11604"], {
    fetchImpl,
    idb: makeMemoryIdb(),
    now: () => NOW,
    applyStatuses: (ctx, rows) => {
      seen.push(rows);
      return { ...ctx, tagged: true };
    },
  });
  assert.equal(out.ctx.tagged, true);
  assert.equal(seen[0][0].id, "11604");
});

/* ---------------------------------------------------------------- seen advice */

test("the seenAdvice ledger drives the tab dot and forgets nothing it was shown", async () => {
  const idb = makeMemoryIdb();
  const keys = ["11604:Doubtful|Knee|Surgery", "5022:Out||"];

  assert.deepEqual(await unseenAdviceKeys(LEAGUE, keys, { idb }), keys, "nothing seen yet");
  await markAdviceSeen(LEAGUE, [keys[0]], { idb });
  assert.deepEqual(await unseenAdviceKeys(LEAGUE, keys, { idb }), [keys[1]]);
  await markAdviceSeen(LEAGUE, keys, { idb });
  assert.deepEqual(await unseenAdviceKeys(LEAGUE, keys, { idb }), []);

  assert.deepEqual(await unseenAdviceKeys("", keys, { idb }), [], "no league, no dot");
  assert.deepEqual(await unseenAdviceKeys(LEAGUE, [], { idb }), []);
  assert.deepEqual(await markAdviceSeen("", keys, { idb }), []);

  const stored = idb.store.get(`seenAdvice:${LEAGUE}`).payload;
  assert.deepEqual(stored, keys, "newest first, de-duplicated");
});

test("markAdviceSeen bounds the ledger at 200 keys", async () => {
  const idb = makeMemoryIdb();
  await markAdviceSeen(LEAGUE, Array.from({ length: 260 }, (_, i) => `k${i}`), { idb });
  assert.equal(idb.store.get(`seenAdvice:${LEAGUE}`).payload.length, 200);
});

/* ---------------------------------------------------------------- advisor feed */

test("loadAdvisorFeed is optional: a missing file is null, not an error", async () => {
  const idb = makeMemoryIdb();
  const missing = makeFetchMock([{ match: ADVISOR_FILE, respond: jsonResponse(null, 404) }]);
  assert.equal(await loadAdvisorFeed({ fetchImpl: missing, idb }), null);
  assert.equal(idb.store.has(`pipeline:${ADVISOR_FILE}`), false, "nothing is cached for a 404");

  // GitHub Pages answers a missing file with an HTML page, which parses as anything but a feed.
  const html = makeFetchMock([{ match: ADVISOR_FILE, respond: "<!doctype html>" }]);
  assert.equal(await loadAdvisorFeed({ fetchImpl: html, idb }), null);
});

test("loadAdvisorFeed is network-first with the IndexedDB copy behind it", async () => {
  const idb = makeMemoryIdb();
  const feed = { v: 1, generated_at: "2026-09-10T13:40:00Z", leagues: { [LEAGUE]: { week: 2, items: [] } } };
  const online = makeFetchMock([{ match: ADVISOR_FILE, respond: feed }]);

  assert.deepEqual(await loadAdvisorFeed({ fetchImpl: online, idb }), feed);
  assert.deepEqual(idb.store.get(`pipeline:${ADVISOR_FILE}`).payload, feed, "cached for the subway");
  assert.doesNotMatch(online.calls[0].url, /cb=/, "a stable URL keeps the service worker useful");

  const offline = makeFetchMock([{ match: ADVISOR_FILE, respond: networkError() }]);
  assert.deepEqual(await loadAdvisorFeed({ fetchImpl: offline, idb }), feed, "served from the drawer");
});
