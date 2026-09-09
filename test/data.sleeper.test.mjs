import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUEST_DEFAULTS,
  SleeperError,
  fantasyCalcUrl,
  getFantasyCalc,
  getLeague,
  getRosters,
  getState,
  getTrending,
  getUser,
  getUserLeagues,
  withCacheBuster,
} from "../src/sleeper.js";
import { fixture, hangs, jsonResponse, makeFetchMock, networkError } from "./shims/fetch-mock.mjs";

const LEAGUE = "1394476745138147328";
const fast = (fetchImpl) => ({ fetchImpl, backoffMs: [0, 0] });

test("request defaults match the locked contract (12 s, 2 retries, 400/900 ms)", () => {
  assert.equal(REQUEST_DEFAULTS.timeoutMs, 12000);
  assert.equal(REQUEST_DEFAULTS.retries, 2);
  assert.deepEqual([...REQUEST_DEFAULTS.backoffMs], [400, 900]);
});

test("withCacheBuster respects an existing query string", () => {
  assert.equal(withCacheBuster("https://x/y", 42), "https://x/y?cb=42");
  assert.equal(withCacheBuster("https://x/y?a=1", 42), "https://x/y?a=1&cb=42");
});

test("every Sleeper call appends cb and sends cache: no-store", async () => {
  const fetchMock = makeFetchMock([
    { match: "/league/", respond: fixture("league.json") },
    { match: "/state/nfl", respond: fixture("state.json") },
    { match: "/trending/add", respond: fixture("trending_add.json") },
  ]);

  const league = await getLeague(LEAGUE, fast(fetchMock));
  await getState(fast(fetchMock));
  await getTrending("add", 24, 50, fast(fetchMock));

  assert.equal(league.league_id, LEAGUE);
  assert.equal(fetchMock.calls.length, 3);
  for (const call of fetchMock.calls) {
    assert.match(call.url, /[?&]cb=\d+/, `no cache-buster on ${call.url}`);
    assert.equal(call.cache, "no-store");
    assert.ok(call.init.signal, "an abort signal is always attached");
  }
  assert.match(fetchMock.calls[0].url, new RegExp(`/v1/league/${LEAGUE}\\?cb=\\d+$`));
  // The trending URL already has a query string, so the buster must join with "&".
  assert.match(fetchMock.calls[2].url, /lookback_hours=24&limit=50&cb=\d+$/);
});

test("retries a 500 and returns the retry's body", async () => {
  const fetchMock = makeFetchMock([
    {
      match: "/rosters",
      respond: ({ hit }) => (hit === 1 ? jsonResponse({ error: "boom" }, 500) : fixture("rosters.json")),
    },
  ]);

  const rosters = await getRosters(LEAGUE, fast(fetchMock));
  assert.equal(rosters.length, 8);
  assert.equal(fetchMock.count("/rosters"), 2, "one failure + one success");
});

test("retries a network error up to the retry budget, then throws SleeperError", async () => {
  const fetchMock = makeFetchMock([{ match: "/rosters", respond: networkError() }]);

  const error = await getRosters(LEAGUE, fast(fetchMock)).then(
    () => null,
    (err) => err,
  );
  assert.ok(error instanceof SleeperError);
  assert.equal(error.status, 0);
  assert.match(error.message, /network error/);
  assert.equal(fetchMock.count("/rosters"), 3, "initial attempt + 2 retries");
});

test("a 404 is an answer, not a blip — no retry", async () => {
  const fetchMock = makeFetchMock([{ match: "/league/", respond: jsonResponse(null, 404) }]);

  const error = await getLeague("nope", fast(fetchMock)).then(
    () => null,
    (err) => err,
  );
  assert.ok(error instanceof SleeperError);
  assert.equal(error.status, 404);
  assert.match(error.url, /\/v1\/league\/nope$/, "the error URL is the clean one");
  assert.equal(fetchMock.count("/league/"), 1);
});

test("a hung request is aborted by the timeout", async () => {
  const fetchMock = makeFetchMock([{ match: "/state/nfl", respond: hangs() }]);

  const started = Date.now();
  const error = await getState({ fetchImpl: fetchMock, timeoutMs: 25, retries: 0 }).then(
    () => null,
    (err) => err,
  );
  assert.ok(error instanceof SleeperError);
  assert.equal(error.status, 0);
  assert.match(error.message, /timeout after 25ms/);
  assert.ok(Date.now() - started < 2000, "failed fast instead of hanging");
  assert.equal(fetchMock.calls[0].init.signal.aborted, true);
});

test("getFantasyCalc builds the pipeline-identical URL and skips the cache-buster", async () => {
  const fetchMock = makeFetchMock([{ match: "fantasycalc", respond: fixture("fantasycalc_redraft_raw.json") }]);

  const rows = await getFantasyCalc({ isDynasty: false, numQbs: 1, numTeams: 8, ppr: 0.5 }, fast(fetchMock));

  assert.equal(rows.length, 199);
  assert.equal(
    fetchMock.calls[0].url,
    "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=8&ppr=0.5",
  );
  assert.equal(fetchMock.calls[0].url, fixture("values.json").sources.fc_redraft.url);
  assert.equal(fetchMock.calls[0].cache, "no-store");
  assert.doesNotMatch(fetchMock.calls[0].url, /cb=/);
  assert.equal(
    fantasyCalcUrl({ isDynasty: true, numQbs: 1, numTeams: 8, ppr: 0.5 }),
    fixture("values.json").sources.fc_dynasty.url,
  );
});

test("user + league lookup endpoints are shaped for the Settings tab", async () => {
  const fetchMock = makeFetchMock([
    { match: "/user/tommyteez", respond: { user_id: "1394551386997272576", display_name: "tommyteez", avatar: "abc" } },
    { match: "/leagues/nfl/2026", respond: [fixture("league.json")] },
  ]);

  const user = await getUser("tommyteez", fast(fetchMock));
  const leagues = await getUserLeagues(user.user_id, "2026", fast(fetchMock));

  assert.equal(user.user_id, "1394551386997272576");
  assert.equal(leagues[0].league_id, LEAGUE);
  assert.match(fetchMock.calls[1].url, /\/v1\/user\/1394551386997272576\/leagues\/nfl\/2026\?cb=\d+$/);
});
