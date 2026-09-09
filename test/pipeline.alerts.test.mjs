// pipeline/alerts.mjs — composition, diffing, batching, state and the send loop (design §11.3).
//
// No network and no clock: every Sleeper read is an injected function backed by test/fixtures,
// the engine gets an explicit `now`, and the sender is injected. main() runs against a scratch
// copy of the data files in a temp directory, so nothing here writes into data/.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContext } from "../src/engine/index.js";
import { validateAlertsState } from "../pipeline/contract.mjs";
import {
  DEFAULT_PREFS,
  DEFAULT_SUBJECT,
  HISTORY_LIMIT,
  MAX_PER_DEVICE,
  NOTIFICATION_ICON,
  applyState,
  canonicalState,
  composeAlerts,
  dealKey,
  deviceKey,
  emptyState,
  isGoneError,
  main,
  normalizePrefs,
  normalizeTransaction,
  parseSubscriptions,
  payloadOf,
  testPayload,
} from "../pipeline/alerts.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const LEAGUE_ID = "1394476745138147328";
const USER_ID = "1394551386997272576"; // tommyteez, roster 3
const MY_ROSTER = 3;
const SUBJECT = "https://tom-bentley.github.io/tradewinds/";
const TRADE_ID = "9900000000000000001";

// Fixtures load inside before(), never at import time: the pipeline rewrites projections.json and
// values_full.json while the suite runs.
let CTX;
let NOW;
let RAW_TRANSACTIONS;
let SUBSCRIPTIONS;
let TMP_ROOT;

/**
 * @param {object} [patch]
 * @returns {object} a device the way main() hands one to composeAlerts
 */
const device = (patch = {}) => ({
  id: "device0000000001",
  leagueId: LEAGUE_ID,
  userId: USER_ID,
  label: "Tom's iPhone",
  subject: SUBJECT,
  rosterId: MY_ROSTER,
  ...patch,
  prefs: normalizePrefs({ ...DEFAULT_PREFS, ...(patch.prefs || {}) }),
});

before(() => {
  const synthetic = fixture("alerts_transactions.json");
  NOW = synthetic.now;
  RAW_TRANSACTIONS = [...synthetic.transactions, ...fixture("transactions_1.json")];
  SUBSCRIPTIONS = fixture("alerts_subscriptions.json");

  const transactions = RAW_TRANSACTIONS.map((row) => normalizeTransaction(row, 1)).sort(
    (a, b) => b.created - a.created,
  );
  CTX = buildContext(
    {
      league: fixture("league.json"),
      users: fixture("users.json"),
      rosters: fixture("rosters.json"),
      players: fixture("players.json"),
      projections: fixture("projections.json"),
      values: fixture("values_full.json"),
      schedule: fixture("schedule.json"),
      state: fixture("state.json"),
      transactions,
      trending: fixture("trending_add.json"),
      now: NOW,
    },
    { userId: USER_ID },
  );

  // A scratch repo root: data/*.json copied out of the fixtures so main() never reads or writes
  // the real data/ directory.
  TMP_ROOT = mkdtempSync(join(tmpdir(), "tradewinds-alerts-"));
  mkdirSync(join(TMP_ROOT, "data"), { recursive: true });
  const copy = (from, to) =>
    writeFileSync(join(TMP_ROOT, "data", to), JSON.stringify(fixture(from)), "utf8");
  copy("players.json", "players.json");
  copy("projections.json", "projections.json");
  copy("values_full.json", "values.json");
  copy("schedule.json", "schedule.json");
  copy("meta.json", "meta.json");
});

after(() => {
  if (TMP_ROOT) rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Sleeper endpoint -> fixture, standing in for pipeline/util.mjs fetchJson. */
function fakeFetch(url) {
  if (url.includes("/v1/state/nfl")) return Promise.resolve(fixture("state.json"));
  if (url.includes("/trending/add")) return Promise.resolve(fixture("trending_add.json"));
  if (url.endsWith(`/league/${LEAGUE_ID}`)) return Promise.resolve(fixture("league.json"));
  if (url.endsWith("/users")) return Promise.resolve(fixture("users.json"));
  if (url.endsWith("/rosters")) return Promise.resolve(fixture("rosters.json"));
  if (url.includes("/transactions/1")) return Promise.resolve(RAW_TRANSACTIONS);
  if (url.includes("/transactions/")) return Promise.resolve([]);
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

/**
 * @param {(subscription: object, payload: string) => void} [onSend]
 * @returns {{ sender: Function, sent: object[] }}
 */
function recordingSender(onSend) {
  const sent = [];
  const sender = async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    if (onSend) onSend(subscription, payload);
    return { statusCode: 201 };
  };
  return { sender, sent };
}

/**
 * @param {object} options extra main() options
 * @returns {Promise<{ code: number, lines: string[], state: object|null }>}
 */
async function runMain(options) {
  const lines = [];
  const code = await main({
    root: TMP_ROOT,
    now: NOW,
    fetchJsonImpl: fakeFetch,
    pause: () => Promise.resolve(),
    log: (line) => lines.push(line),
    ...options,
  });
  const stateFile = join(TMP_ROOT, "data", "alerts-state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  return { code, lines, state };
}

const stateFilePath = () => join(TMP_ROOT, "data", "alerts-state.json");
const clearStateFile = () => rmSync(stateFilePath(), { force: true });
const subsEnv = (rows) => JSON.stringify(rows);

// --- parsing -------------------------------------------------------------------------------

test("parseSubscriptions keeps well-formed pairings and reports the rest", () => {
  const { devices, problems } = parseSubscriptions(subsEnv(SUBSCRIPTIONS));
  assert.equal(devices.length, 2);
  assert.deepEqual(problems, []);
  assert.equal(devices[0].leagueId, LEAGUE_ID);
  assert.equal(devices[0].userId, USER_ID);
  assert.equal(devices[0].id, deviceKey(SUBSCRIPTIONS[0].sub.endpoint));
  assert.equal(devices[0].id.length, 16);
  assert.deepEqual(devices[1].prefs, { ...DEFAULT_PREFS, deals: false, freeAgents: false });

  const messy = parseSubscriptions(
    subsEnv([
      SUBSCRIPTIONS[0],
      SUBSCRIPTIONS[0], // duplicate endpoint
      { sub: { endpoint: "https://example.invalid/x" }, leagueId: "1" }, // no keys
      { sub: { endpoint: "https://example.invalid/y", keys: { p256dh: "a", auth: "b" } } }, // no league
      {},
    ]),
  );
  assert.equal(messy.devices.length, 1);
  assert.equal(messy.problems.length, 4);

  assert.deepEqual(parseSubscriptions("").devices, []);
  assert.deepEqual(parseSubscriptions(undefined).devices, []);
  assert.match(parseSubscriptions("{oops").problems[0], /not valid JSON/);
});

test("prefs fall back to the §11.4 defaults", () => {
  assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs({ deals: false, minFaGain: 0.5 }), {
    ...DEFAULT_PREFS,
    deals: false,
    minFaGain: 0.5,
  });
});

// --- composition + diffing ------------------------------------------------------------------

test("the first run announces the completed trade, the second says nothing", () => {
  const me = device();
  const first = composeAlerts(CTX, me, emptyState());
  assert.deepEqual(first.problems, []);

  const trade = first.notifications.find((n) => n.kind === "trades");
  assert.ok(trade, "the synthetic completed trade must produce a notification");
  assert.equal(first.notifications.filter((n) => n.kind === "trades").length, 1);
  assert.equal(trade.title, "Trade: I love black ops II ⇄ Tommies Teenie Titties");
  assert.match(trade.body, /^I love black ops II gets Jaylen Waddle · Tommies Teenie Titties gets Zay Flowers · /);
  assert.match(trade.body, /I love black ops II [+-]\d+ % \/ [+-]\d+\.\d pts\/wk$/);
  assert.equal(trade.tag, `trade-${TRADE_ID}`);
  assert.equal(trade.url, `${SUBJECT}#league`);
  assert.deepEqual(trade.keys, [TRADE_ID]);
  assert.deepEqual(payloadOf(trade), {
    title: trade.title,
    body: trade.body,
    tag: trade.tag,
    url: trade.url,
    icon: NOTIFICATION_ICON,
  });
  assert.deepEqual(first.seen.trades, [TRADE_ID]);

  const after = applyState(emptyState(), {
    leagueId: LEAGUE_ID,
    week: CTX.week,
    deviceId: me.id,
    seen: first.seen,
    notifiedAt: "2026-09-09T18:30:00Z",
  });
  assert.deepEqual(after.leagues[LEAGUE_ID].seenTradeIds, [TRADE_ID]);
  assert.deepEqual(validateAlertsState(after), []);

  const second = composeAlerts(CTX, me, after);
  assert.deepEqual(second.notifications, [], "nothing is new on the second pass");
  assert.deepEqual(second.seen, { trades: [], deals: [], fa: [] });
});

test("deal alerts respect minDealScore and the deals toggle", () => {
  const permissive = composeAlerts(CTX, device({ prefs: { minDealScore: 0.5, freeAgents: false } }), emptyState());
  const deals = permissive.notifications.filter((n) => n.kind === "deals");
  assert.ok(deals.length > 0, "the fixture league offers deals above a 0.5 score");

  const strict = composeAlerts(
    CTX,
    device({ prefs: { minDealScore: 1000, freeAgents: false } }),
    emptyState(),
  );
  assert.deepEqual(strict.notifications.filter((n) => n.kind === "deals"), []);

  const off = composeAlerts(CTX, device({ prefs: { deals: false, freeAgents: false } }), emptyState());
  assert.deepEqual(off.notifications.map((n) => n.kind), ["trades"]);

  const noTrades = composeAlerts(CTX, device({ prefs: { trades: false, deals: false, freeAgents: false } }), emptyState());
  assert.deepEqual(noTrades.notifications, []);
});

test("a deal already in seenDeals never fires twice", () => {
  const me = device({ prefs: { minDealScore: 0.5, freeAgents: false, trades: false } });
  const first = composeAlerts(CTX, me, emptyState());
  assert.ok(first.seen.deals.length > 0);
  const after = applyState(emptyState(), { deviceId: me.id, seen: first.seen, notifiedAt: "2026-09-09T18:30:00Z" });
  const second = composeAlerts(CTX, me, after);
  assert.deepEqual(second.notifications, []);
  // and the key is the one the finder would rebuild for the same proposal
  assert.match(after.devices[me.id].seenDeals[0], /^\d+:[^>]*>[^>]*$/);
});

test("free-agent alerts respect minFaGain and the freeAgents toggle", () => {
  const quiet = composeAlerts(CTX, device({ prefs: { trades: false, deals: false, minFaGain: 1 } }), emptyState());
  assert.deepEqual(quiet.notifications, [], "nothing on roster 3 gains a full point a week");

  const me = device({ prefs: { trades: false, deals: false, minFaGain: 0.5 } });
  const loud = composeAlerts(CTX, me, emptyState());
  const fa = loud.notifications.filter((n) => n.kind === "fa");
  assert.ok(fa.length > 0, "a 0.5 pts/wk threshold surfaces the dropped free agent");
  const best = fa[0];
  assert.equal(best.url, `${SUBJECT}#deals`);
  assert.ok(best.body.includes("Patrick Mahomes"), `expected the 6-hour-old drop, got: ${best.body}`);
  assert.ok(best.keys.includes("4046"));

  // Drain everyone but the dropped quarterback so the single-candidate wording is exercised too.
  const others = loud.seen.fa.filter((key) => key !== "4046");
  assert.ok(others.length > 0, "the shortlist is deeper than one player");
  const drained = applyState(emptyState(), { deviceId: me.id, seen: { fa: others } });
  const single = composeAlerts(CTX, me, drained).notifications;
  assert.equal(single.length, 1);
  assert.equal(single[0].title, "Free agent worth a drop");
  assert.match(single[0].body, /^Add Patrick Mahomes, (drop .+|to an open spot) \(\+\d\.\d pts\/wk\)$/);
  assert.deepEqual(single[0].keys, ["4046"]);
  assert.equal(single[0].tag, "fa-4046");

  const off = composeAlerts(CTX, device({ prefs: { trades: false, deals: false, freeAgents: false } }), emptyState());
  assert.deepEqual(off.notifications, []);
});

test("a device never gets more than three notifications, extras are batched", () => {
  const me = device({ prefs: { minDealScore: 0.5, minFaGain: 0.5 } });
  const composed = composeAlerts(CTX, me, emptyState());
  assert.ok(composed.notifications.length <= MAX_PER_DEVICE);
  assert.equal(MAX_PER_DEVICE, 3);

  const batched = composed.notifications.filter((n) => n.batched === true);
  assert.ok(batched.length > 0, "more than three candidates must collapse into a batch");
  for (const notification of batched) {
    assert.match(notification.body, /^\d+ new (deals|trades|free agents) — (best|latest): /);
    assert.ok(notification.keys.length > 1, "a batch stands in for every key it covers");
    assert.equal(notification.key, null);
  }
  // everything a batch covers is remembered, so the next run starts clean
  const keys = composed.notifications.flatMap((n) => n.keys);
  assert.equal(new Set(keys).size, keys.length);
  const after = applyState(emptyState(), {
    leagueId: LEAGUE_ID,
    week: CTX.week,
    deviceId: me.id,
    seen: composed.seen,
    notifiedAt: "2026-09-09T18:30:00Z",
  });
  assert.deepEqual(composeAlerts(CTX, me, after).notifications, []);
});

// --- state ---------------------------------------------------------------------------------

test("state arrays stay bounded, ordered and valid", () => {
  const many = Array.from({ length: HISTORY_LIMIT + 50 }, (_, index) => `k${index}`);
  const state = applyState(emptyState(), {
    leagueId: LEAGUE_ID,
    week: 1,
    deviceId: "d1",
    seen: { trades: many, deals: many, fa: many },
    notifiedAt: "2026-09-09T18:30:00Z",
  });
  assert.equal(state.leagues[LEAGUE_ID].seenTradeIds.length, HISTORY_LIMIT);
  assert.equal(state.devices.d1.seenDeals.length, HISTORY_LIMIT);
  assert.equal(state.devices.d1.seenFa.length, HISTORY_LIMIT);
  assert.equal(state.leagues[LEAGUE_ID].seenTradeIds.at(-1), "k249", "the newest key survives");
  assert.equal(state.leagues[LEAGUE_ID].seenTradeIds[0], "k50", "the oldest keys fall off the front");
  assert.deepEqual(validateAlertsState(state), []);

  // re-adding a known key moves it to the end rather than duplicating it
  const again = applyState(state, { deviceId: "d1", seen: { deals: ["k60"] } });
  assert.equal(again.devices.d1.seenDeals.at(-1), "k60");
  assert.equal(again.devices.d1.seenDeals.filter((k) => k === "k60").length, 1);

  // canonical order is stable whatever order the keys arrived in
  const shuffled = { v: 1, leagues: {}, devices: { zz: { seenDeals: [], seenFa: [] }, aa: { seenDeals: [], seenFa: [] } } };
  assert.deepEqual(Object.keys(canonicalState(shuffled).devices), ["aa", "zz"]);
  assert.equal(JSON.stringify(canonicalState(state)), JSON.stringify(canonicalState(canonicalState(state))));

  // applyState never mutates its input
  const before = JSON.stringify(state);
  applyState(state, { deviceId: "d1", seen: { deals: ["zzz"] } });
  assert.equal(JSON.stringify(state), before);
});

// --- main() --------------------------------------------------------------------------------

test("no subscriptions is a clean no-op", async () => {
  const { code, lines, state } = await runMain({ env: {}, sender: () => assert.fail("must not send") });
  assert.equal(code, 0);
  assert.ok(lines.some((line) => line.includes("nothing paired")));
  assert.equal(state, null, "no state file is written when nothing is paired");
});

test("main sends once per new item, records state, then goes quiet", async () => {
  clearStateFile();
  const first = recordingSender();
  const run1 = await runMain({
    env: { PUSH_SUBSCRIPTIONS: subsEnv(SUBSCRIPTIONS), VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test" },
    sender: first.sender,
  });
  assert.equal(run1.code, 0);
  assert.ok(first.sent.length > 0);

  const tradePushes = first.sent.filter((s) => s.payload.tag === `trade-${TRADE_ID}`);
  assert.equal(tradePushes.length, 2, "both paired devices hear about the same league trade");
  for (const push of first.sent) {
    assert.deepEqual(Object.keys(push.payload).sort(), ["body", "icon", "tag", "title", "url"]);
    assert.equal(push.payload.icon, NOTIFICATION_ICON);
    assert.ok(push.payload.url.startsWith(SUBJECT));
  }
  // the trades-only device hears only about the trade
  const ipad = first.sent.filter((s) => s.endpoint.endsWith("ipad"));
  assert.deepEqual(ipad.map((s) => s.payload.tag), [`trade-${TRADE_ID}`]);

  assert.ok(run1.state, "state is committed after a run that sent something");
  assert.deepEqual(validateAlertsState(run1.state), []);
  assert.deepEqual(run1.state.leagues[LEAGUE_ID].seenTradeIds, [TRADE_ID]);
  assert.equal(run1.state.leagues[LEAGUE_ID].week, 1);
  assert.equal(Object.keys(run1.state.devices).length, 2);
  for (const entry of Object.values(run1.state.devices)) assert.ok(entry.lastNotifiedAt);

  const second = recordingSender();
  const run2 = await runMain({
    env: { PUSH_SUBSCRIPTIONS: subsEnv(SUBSCRIPTIONS), VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test" },
    sender: second.sender,
  });
  assert.equal(run2.code, 0);
  assert.deepEqual(second.sent, [], "a second run has nothing new to say");
  assert.deepEqual(run2.state, run1.state, "an unchanged state file is left alone");
  assert.ok(run2.lines.some((line) => line.includes("unchanged")));
});

test("a 410 from the push service marks the device expired and keeps going", async () => {
  clearStateFile();
  const ipad = [SUBSCRIPTIONS[1]];
  const gone = Object.assign(new Error("Gone"), { statusCode: 410 });
  assert.equal(isGoneError(gone), true);
  assert.equal(isGoneError(Object.assign(new Error("nope"), { statusCode: 500 })), false);

  let attempts = 0;
  const run = await runMain({
    env: { PUSH_SUBSCRIPTIONS: subsEnv(ipad), VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test" },
    sender: async () => {
      attempts += 1;
      throw gone;
    },
  });
  assert.equal(run.code, 0);
  assert.equal(attempts, 1);
  const id = deviceKey(ipad[0].sub.endpoint);
  assert.equal(run.state.devices[id].expired, true);
  assert.equal(run.state.devices[id].lastNotifiedAt, null, "a failed send is not remembered as sent");
  assert.deepEqual(run.state.leagues[LEAGUE_ID].seenTradeIds, [], "an undelivered trade is retried next run");
  assert.ok(run.lines.some((line) => line.includes("marking expired")));
  assert.deepEqual(validateAlertsState(run.state), []);

  // the expired device is skipped from then on
  const next = recordingSender();
  const again = await runMain({
    env: { PUSH_SUBSCRIPTIONS: subsEnv(ipad), VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test" },
    sender: next.sender,
  });
  assert.deepEqual(next.sent, []);
  assert.ok(again.lines.some((line) => line.includes("marked expired")));
});

test("ALERT_TEST pushes once per subscription and leaves state alone", async () => {
  clearStateFile();
  const sentinel = canonicalState({
    v: 1,
    leagues: { [LEAGUE_ID]: { seenTradeIds: ["sentinel"], week: 1 } },
    devices: {},
  });
  writeFileSync(stateFilePath(), `${JSON.stringify(sentinel)}\n`, "utf8");
  const before = readFileSync(stateFilePath(), "utf8");

  const { sender, sent } = recordingSender();
  const run = await runMain({
    env: {
      PUSH_SUBSCRIPTIONS: subsEnv(SUBSCRIPTIONS),
      VAPID_SUBJECT: SUBJECT,
      VAPID_PRIVATE_KEY: "test",
      ALERT_TEST: "1",
    },
    sender,
    fetchJsonImpl: () => Promise.reject(new Error("ALERT_TEST must not touch the network")),
  });
  assert.equal(run.code, 0);
  assert.equal(sent.length, SUBSCRIPTIONS.length);
  assert.deepEqual(
    sent.map((s) => s.endpoint).sort(),
    SUBSCRIPTIONS.map((s) => s.sub.endpoint).sort(),
  );
  for (const push of sent) assert.deepEqual(push.payload, testPayload(SUBJECT));
  assert.deepEqual(testPayload(SUBJECT), {
    title: "Tradewinds alerts are on",
    body: "You will hear about new trades and deals here.",
    tag: "test",
    url: SUBJECT,
  });
  assert.equal(readFileSync(stateFilePath(), "utf8"), before, "ALERT_TEST never rewrites state");
  clearStateFile();
});

test("the subject falls back to the published Pages URL", () => {
  assert.equal(DEFAULT_SUBJECT, "https://tom-bentley.github.io/tradewinds/");
  const composed = composeAlerts(CTX, device({ subject: undefined, prefs: { deals: false, freeAgents: false } }), emptyState());
  assert.equal(composed.notifications[0].url, `${DEFAULT_SUBJECT}#league`);
  assert.match(dealKey({ theirRosterId: 4, give: ["b", "a"], get: ["d", "c"] }), /^4:a,b>c,d$/);
});
