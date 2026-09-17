// pipeline/alerts.mjs — composition, diffing, batching, state and the send loop (design §11.3).
//
// No network and no clock: every Sleeper read is an injected function backed by test/fixtures,
// the engine gets an explicit `now`, and the sender is injected. main() runs against a scratch
// copy of the data files in a temp directory, so nothing here writes into data/.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyStatuses, buildContext } from "../src/engine/index.js";
import { isoTimestamp } from "../pipeline/util.mjs";
import { validateAdvisor, validateAlertsState } from "../pipeline/contract.mjs";
import {
  DEFAULT_PREFS,
  DEFAULT_SUBJECT,
  HISTORY_LIMIT,
  MAX_PER_DEVICE,
  MAX_STATUS_FALLBACK,
  NOTIFICATION_ICON,
  PAIR_INFO,
  applyPairing,
  applyState,
  canonicalState,
  composeAlerts,
  cooldownState,
  dealKey,
  decryptPairingBlob,
  deliveryOptions,
  deviceIdOf,
  deviceKey,
  dryRunDevice,
  emptyState,
  isGoneError,
  main,
  mergeAdvisor,
  mergeDevices,
  nextStatusSnapshot,
  normalizePrefs,
  normalizeTransaction,
  pairedDevices,
  parseDispatchPayload,
  parseSubscriptions,
  parseWebhooks,
  payloadOf,
  sendWebhook,
  statusRowFromPlayer,
  statusRowsFromProjections,
  testPayload,
  validatePairing,
  watchSet,
  webhookKind,
  webhookRequest,
  weekPointRows,
} from "../pipeline/alerts.mjs";
import {
  diagnose as doctorDiagnose,
  main as doctorMain,
  render as doctorRender,
} from "../scripts/alerts-doctor.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const LEAGUE_ID = "1394476745138147328";
const USER_ID = "1394551386997272576"; // tommyteez, roster 3
const MY_ROSTER = 3;
const SUBJECT = "https://tom-bentley.github.io/tradewinds/";
const TRADE_ID = "9900000000000000001";
const BOWERS = "11604"; // roster 3's starting TE — Doubtful (knee, meniscus surgery) 2026-09-09
const GOEDERT = "5022"; // his bench replacement

// Fixtures load inside before(), never at import time: the pipeline rewrites projections.json and
// values_full.json while the suite runs.
let CTX;
let NOW;
let RAW_TRANSACTIONS;
let SUBSCRIPTIONS;
let TMP_ROOT;
let PLAYERS;
let STATUS_RAW;

/** What fakeFetch answers the weekly projections call with; a test swaps it to flip a status. */
let STATUS_ROWS = [];

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
  PLAYERS = fixture("players.json").players;
  STATUS_RAW = fixture("sleeper_projections_wk1_status_raw.json");
  STATUS_ROWS = STATUS_RAW;
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

/**
 * The `/v1/players/nfl/{id}` fallback body, rebuilt from the players fixture.
 * @param {string} id
 * @returns {object}
 */
function rawPlayerRow(id) {
  const player = PLAYERS[id];
  if (!player) return {};
  return {
    player_id: id,
    position: player.pos,
    team: player.team,
    injury_status: player.inj,
    injury_body_part: null,
    injury_notes: null,
    injury_start_date: null,
    news_updated: null,
    depth_chart_order: player.dc,
  };
}

/** Sleeper endpoint -> fixture, standing in for pipeline/util.mjs fetchJson. */
function fakeFetch(url) {
  if (url.includes("/v1/state/nfl")) return Promise.resolve(fixture("state.json"));
  if (url.includes("/trending/add")) return Promise.resolve(fixture("trending_add.json"));
  if (url.includes("/projections/nfl/2026/1")) return Promise.resolve(STATUS_ROWS);
  if (url.endsWith(`/league/${LEAGUE_ID}`)) return Promise.resolve(fixture("league.json"));
  if (url.endsWith("/users")) return Promise.resolve(fixture("users.json"));
  if (url.endsWith("/rosters")) return Promise.resolve(fixture("rosters.json"));
  if (url.includes("/transactions/1")) return Promise.resolve(RAW_TRANSACTIONS);
  if (url.includes("/transactions/")) return Promise.resolve([]);
  const player = /\/v1\/players\/nfl\/(\w+)(?:\?|$)/.exec(url);
  if (player) return Promise.resolve(rawPlayerRow(player[1]));
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
  const advisorText = existsSync(advisorFilePath()) ? readFileSync(advisorFilePath(), "utf8") : null;
  return { code, lines, state, advisorText, advisor: advisorText == null ? null : JSON.parse(advisorText) };
}

const stateFilePath = () => join(TMP_ROOT, "data", "alerts-state.json");
const advisorFilePath = () => join(TMP_ROOT, "data", "advisor.json");
const clearStateFile = () => rmSync(stateFilePath(), { force: true });
const clearAdvisorFile = () => rmSync(advisorFilePath(), { force: true });
const subsEnv = (rows) => JSON.stringify(rows);

/**
 * One paired phone with the given prefs, so an advisor test is not reading two devices at once.
 * @param {object} [prefs]
 * @returns {object[]}
 */
const phone = (prefs = {}) => [{ ...SUBSCRIPTIONS[0], prefs: { ...SUBSCRIPTIONS[0].prefs, ...prefs } }];

/** The projections rows as they read BEFORE the meniscus news (Sleeper re-projected 12.71 -> 0). */
function healthyRows() {
  return STATUS_RAW.map((row) =>
    row.player_id === BOWERS
      ? {
          ...row,
          player: { ...row.player, injury_status: null, injury_body_part: null, injury_notes: null },
          stats: { rec: 5.5, rec_yd: 62, rec_td: 0.45, pts_half_ppr: 12.71 },
        }
      : row,
  );
}

/**
 * @param {object} env extra env for main()
 * @param {object} [options] extra main() options
 */
const runAlerts = (env, options = {}) =>
  runMain({ env: { VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test", ...env }, ...options });

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
    // §13.3 B1 — the service worker files its receipt under this kind.
    kind: "trades",
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
  assert.deepEqual(second.seen, { trades: [], deals: [], fa: [], advice: [] });
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
    assert.deepEqual(Object.keys(push.payload).sort(), ["body", "icon", "kind", "tag", "title", "url"]);
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
  // The test push rides the same payload shape as a real one (icon + kind), so a receipt for it
  // proves exactly what a receipt for an advisory would.
  for (const push of sent) {
    assert.deepEqual(push.payload, { ...testPayload(SUBJECT), icon: NOTIFICATION_ICON, kind: "test" });
  }
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

// --- advisor: live statuses (design 12.3) ----------------------------------------------------

test("statusRowsFromProjections reads the injury block and keeps the raw stat lines", () => {
  const { statuses, stats } = statusRowsFromProjections(STATUS_RAW);
  assert.equal(statuses.length, STATUS_RAW.length);

  // The real 2026-09-09 row: this is the news the phone never explained.
  assert.deepEqual(
    statuses.find((row) => row.id === BOWERS),
    {
      id: BOWERS,
      inj: "Doubtful",
      injPart: "Knee - Meniscus",
      injNotes: "Surgery",
      newsAt: 1788984945628,
      // the weekly rows carry no depth chart; only the per-player fallback does
      dc: null,
    },
  );
  const goedert = statuses.find((row) => row.id === GOEDERT);
  assert.equal(goedert.inj, null);
  assert.equal(goedert.injPart, null);
  assert.equal(goedert.injNotes, null);
  assert.equal(goedert.newsAt, 1789048802204);

  assert.equal(stats.get(GOEDERT).pts_half_ppr, 8.77);
  assert.equal(stats.get(BOWERS).pts_half_ppr, undefined, "Sleeper zeroed his week within hours");

  // junk in, empty out; a repeated player_id is read once
  assert.deepEqual(statusRowsFromProjections(null), { statuses: [], stats: new Map() });
  assert.deepEqual(statusRowsFromProjections([{}, { player_id: 7 }]).statuses, []);
  assert.equal(statusRowsFromProjections([STATUS_RAW[0], STATUS_RAW[0]]).statuses.length, 1);
});

test("statusRowFromPlayer reads the per-player fallback body in either shape", () => {
  const body = {
    injury_status: "Out",
    injury_body_part: "Ankle",
    injury_notes: "",
    news_updated: 1788902120347,
    depth_chart_order: 4,
  };
  assert.deepEqual(statusRowFromPlayer("12529", body), {
    id: "12529",
    inj: "Out",
    injPart: "Ankle",
    injNotes: null,
    newsAt: 1788902120347,
    dc: 4,
  });
  assert.deepEqual(statusRowFromPlayer("12529", { 12529: body }), statusRowFromPlayer("12529", body));
  assert.deepEqual(statusRowFromPlayer("9221", {}), {
    id: "9221",
    inj: null,
    injPart: null,
    injNotes: null,
    newsAt: null,
    dc: null,
  });
});

test("weekPointRows scores the raw lines with the league's own settings", () => {
  const { stats } = statusRowsFromProjections(STATUS_RAW);
  const rows = weekPointRows(stats, [GOEDERT, BOWERS, "nobody"], fixture("league.json").scoring_settings, 1);
  assert.deepEqual(rows, [
    { id: GOEDERT, week: 1, pts: 8.78 },
    { id: BOWERS, week: 1, pts: 0 },
  ]);
  assert.deepEqual(weekPointRows(stats, [GOEDERT], null, 1), [{ id: GOEDERT, week: 1, pts: 0 }]);
});

test("watchSet is every id on a roster, on IR or on the taxi squad", () => {
  const watch = watchSet(fixture("rosters.json"));
  assert.equal(watch.size, 138);
  assert.ok(watch.has(BOWERS) && watch.has(GOEDERT));
  assert.ok(watch.has("9753"), "an IR stash is watched too");
  assert.ok(!watch.has("9482"), "a free agent is not");
  assert.deepEqual([...watchSet([{ players: ["a"], reserve: null, taxi: ["b"] }, null])].sort(), ["a", "b"]);
  assert.equal(watchSet(null).size, 0);
});

test("nextStatusSnapshot keeps the watch set, carries forward what it did not see", () => {
  const watch = new Set(["1", "2", "3"]);
  const previous = { 1: "Questionable||", 2: "||", 9: "Out||" };
  const snapshot = nextStatusSnapshot(previous, watch, [
    { id: "1", inj: "Doubtful", injPart: "Knee", injNotes: null },
    { id: "99", inj: "Out", injPart: null, injNotes: null },
  ]);
  assert.equal(snapshot["1"], "Doubtful|Knee|", "seen this run");
  assert.equal(snapshot["2"], "||", "not seen: the old key stands, or the next sighting looks new");
  assert.equal(snapshot["3"], undefined, "never seen at all");
  assert.equal(snapshot["9"], undefined, "no longer rostered anywhere");
  assert.equal(snapshot["99"], undefined, "not in the watch set");
  assert.deepEqual(Object.keys(nextStatusSnapshot(null, watch, [])), []);
});

// --- advisor: state --------------------------------------------------------------------------

test("state round-trips the advisor keys and keeps seenAdvice bounded", () => {
  const many = Array.from({ length: HISTORY_LIMIT + 40 }, (_, index) => `${index}:Out||`);
  const state = applyState(emptyState(), {
    leagueId: LEAGUE_ID,
    week: 1,
    status: { 11604: "Doubtful|Knee - Meniscus|Surgery", 5022: "||" },
    statusAt: "2026-09-10T14:20:00Z",
    deviceId: "d1",
    seen: { advice: many },
  });
  assert.equal(state.devices.d1.seenAdvice.length, HISTORY_LIMIT);
  assert.equal(state.devices.d1.seenAdvice.at(-1), `${HISTORY_LIMIT + 39}:Out||`);
  assert.equal(state.leagues[LEAGUE_ID].statusAt, "2026-09-10T14:20:00Z");
  assert.deepEqual(Object.keys(state.leagues[LEAGUE_ID].status), [GOEDERT, BOWERS], "ids in stable order");
  assert.deepEqual(validateAlertsState(state), []);

  // canonicalState is a fixed point, and the new keys survive it
  assert.equal(JSON.stringify(canonicalState(state)), JSON.stringify(canonicalState(canonicalState(state))));

  // a pre-advisor state file still loads: the missing keys come back empty, nothing is dropped
  const legacy = canonicalState({
    v: 1,
    leagues: { [LEAGUE_ID]: { seenTradeIds: [TRADE_ID], week: 1 } },
    devices: { d1: { seenDeals: ["a"], seenFa: ["b"], lastNotifiedAt: null } },
  });
  assert.deepEqual(legacy.leagues[LEAGUE_ID].status, {});
  assert.equal(legacy.leagues[LEAGUE_ID].statusAt, null);
  assert.deepEqual(legacy.devices.d1.seenAdvice, []);
  assert.deepEqual(legacy.leagues[LEAGUE_ID].seenTradeIds, [TRADE_ID]);
  assert.deepEqual(validateAlertsState(legacy), []);
});

// --- advisor: the feed file -------------------------------------------------------------------

test("mergeAdvisor merges every device in a league, newest first, bounded at 30", () => {
  const item = (key, severity = "high") => ({
    key,
    id: key.split(":")[0],
    name: `Player ${key}`,
    severity,
    headline: key,
    summary: key,
    moves: [],
  });
  const first = mergeAdvisor(null, { L: { week: 1, items: [item("1:a"), item("2:b", "low")] } }, {
    at: "2026-09-10T14:00:00Z",
  });
  assert.equal(first.v, 1);
  assert.equal(first.generated_at, "2026-09-10T14:00:00Z");
  assert.deepEqual(first.leagues.L.items.map((i) => i.key), ["1:a", "2:b"], "same run: severity breaks the tie");
  for (const entry of first.leagues.L.items) assert.equal(entry.at, "2026-09-10T14:00:00Z");

  const second = mergeAdvisor(first, { L: { week: 1, items: [item("3:c")] } }, { at: "2026-09-10T14:10:00Z" });
  assert.deepEqual(second.leagues.L.items.map((i) => i.key), ["3:c", "1:a", "2:b"], "newest first");

  // an advisory that is still open and still SAYS the same thing keeps its place and its timestamp:
  // a standing issue is re-advised every run, and re-stamping it would rewrite (and commit) the
  // feed every ten minutes for news that has not changed
  const same = mergeAdvisor(second, { L: { week: 1, items: [item("1:a")] } }, { at: "2026-09-10T14:20:00Z" });
  assert.deepEqual(same.leagues.L.items.map((i) => i.key), ["3:c", "1:a", "2:b"], "unchanged advice stays put");
  assert.equal(same.leagues.L.items.find((i) => i.key === "1:a").at, "2026-09-10T14:00:00Z");
  assert.deepEqual(same.leagues, second.leagues, "a fixed point for the committed file");

  // ...but advice whose words changed takes this run's timestamp and moves back to the top
  const changed = { ...item("1:a"), summary: "IR now — 2 slots free." };
  const third = mergeAdvisor(second, { L: { week: 1, items: [changed] } }, { at: "2026-09-10T14:20:00Z" });
  assert.deepEqual(third.leagues.L.items.map((i) => i.key), ["1:a", "3:c", "2:b"]);
  assert.equal(third.leagues.L.items[0].at, "2026-09-10T14:20:00Z");
  assert.equal(third.leagues.L.items.length, 3, "deduped on key");

  // a league with nothing new this run keeps what it had
  assert.deepEqual(mergeAdvisor(third, {}, { at: "2026-09-10T14:30:00Z" }).leagues.L.items.length, 3);

  const flood = mergeAdvisor(
    null,
    { L: { week: 1, items: Array.from({ length: 40 }, (_, index) => item(`${index}:x`)) } },
    { at: "2026-09-10T14:00:00Z" },
  );
  assert.equal(flood.leagues.L.items.length, 30);
  assert.deepEqual(validateAdvisor(flood), []);
});

test("dryRunDevice needs a league and asks for everything", () => {
  assert.equal(dryRunDevice({}, SUBJECT).ok, false);
  assert.match(dryRunDevice({}, SUBJECT).problem, /ALERT_DRY_LEAGUE/);
  const { ok, device } = dryRunDevice({ ALERT_DRY_LEAGUE: LEAGUE_ID, ALERT_DRY_USER: USER_ID }, SUBJECT);
  assert.equal(ok, true);
  assert.equal(device.leagueId, LEAGUE_ID);
  assert.equal(device.userId, USER_ID);
  assert.equal(device.sub, null, "a dry run has nothing to send to");
  assert.equal(device.prefs.rivalNews, true, "a preview hides nothing");
  assert.equal(device.prefs.advice, true);
});

// --- advisor: prefs ----------------------------------------------------------------------------

test("prefs learn advice (on) and rivalNews (off)", () => {
  assert.equal(DEFAULT_PREFS.advice, true);
  assert.equal(DEFAULT_PREFS.rivalNews, false);
  assert.deepEqual(normalizePrefs({}), DEFAULT_PREFS);
  assert.equal(normalizePrefs({ advice: false }).advice, false);
  assert.equal(normalizePrefs({ rivalNews: true }).rivalNews, true);
  assert.equal(normalizePrefs({ rivalNews: "yes" }).rivalNews, false, "opt-in means exactly true");
});

// --- advisor: main() end to end ----------------------------------------------------------------

test("the first run for a league seeds the statuses and says nothing about them", async () => {
  clearStateFile();
  clearAdvisorFile();
  STATUS_ROWS = healthyRows();

  const { sender, sent } = recordingSender();
  const run = await runAlerts({ PUSH_SUBSCRIPTIONS: subsEnv(phone()) }, { sender });
  assert.equal(run.code, 0);
  assert.deepEqual(
    sent.filter((push) => push.payload.tag.startsWith("advice-")),
    [],
    "a seeding run never buzzes about a roster it has only just looked at",
  );
  assert.ok(run.lines.some((line) => line.includes("seeding statuses")));

  const league = run.state.leagues[LEAGUE_ID];
  // 15 of the fixture's TE rows are rostered here; the rest of the watch set comes from the
  // per-player fallback, which is deliberately budgeted (a real run sees all six positions).
  assert.equal(Object.keys(league.status).length, 15 + MAX_STATUS_FALLBACK);
  assert.equal(league.status[BOWERS], "||", "healthy at seed time");
  assert.equal(league.status[GOEDERT], "||");
  assert.ok(!Object.keys(league.status).includes("9482"), "a free agent is never snapshotted");
  assert.equal(league.statusAt, isoTimestamp(new Date(NOW)));
  assert.deepEqual(validateAlertsState(run.state), []);

  // the standing issues are remembered as the baseline, not delivered
  const deviceId = deviceKey(SUBSCRIPTIONS[0].sub.endpoint);
  assert.ok(run.state.devices[deviceId].seenAdvice.length > 0, "the roster's open issues are the status quo");

  // and they are still published to the feed the Advisor tab reads
  assert.ok(run.advisor, "data/advisor.json is written on the seeding run");
  assert.deepEqual(validateAdvisor(run.advisor), []);
  assert.equal(run.advisor.leagues[LEAGUE_ID].week, 1);
});

test("a status flip pushes exactly one advice notification, ahead of the deals and free agents", async () => {
  STATUS_ROWS = STATUS_RAW; // Bowers -> Doubtful (knee, meniscus surgery)

  const { sender, sent } = recordingSender();
  const run = await runAlerts(
    { PUSH_SUBSCRIPTIONS: subsEnv(phone({ minDealScore: 0.5, minFaGain: 0.5 })) },
    { sender },
  );
  assert.equal(run.code, 0);

  const advice = sent.filter((push) => push.payload.tag.startsWith("advice-"));
  assert.equal(advice.length, 1, `expected one advice push, got ${sent.map((p) => p.payload.tag).join(", ")}`);
  assert.equal(advice[0].payload.tag, `advice-${BOWERS}`);
  assert.equal(advice[0].payload.url, `${SUBJECT}#advisor`);
  assert.ok(advice[0].payload.title.length > 0 && advice[0].payload.title.length <= 60);
  assert.ok(advice[0].payload.body.length > 0 && advice[0].payload.body.length <= 170);
  assert.equal(sent[0].payload.tag, advice[0].payload.tag, "advice outranks everything else in the run");

  const deviceId = deviceKey(SUBSCRIPTIONS[0].sub.endpoint);
  const key = `${BOWERS}:Doubtful|Knee - Meniscus|Surgery`;
  assert.ok(run.state.devices[deviceId].seenAdvice.includes(key));
  assert.equal(run.state.leagues[LEAGUE_ID].status[BOWERS], "Doubtful|Knee - Meniscus|Surgery");
  assert.equal(run.state.leagues[LEAGUE_ID].statusAt, isoTimestamp(new Date(NOW)));
  assert.deepEqual(validateAlertsState(run.state), []);

  assert.ok(
    run.advisor.leagues[LEAGUE_ID].items.some((item) => item.key === key),
    "the same advisory lands in the feed",
  );
  assert.deepEqual(validateAdvisor(run.advisor), []);

  // The same news twice is not news. (The feed entry itself is rewritten once, because the
  // advisory arrives as a standing issue rather than an event from here on — `before` goes null.)
  const second = recordingSender();
  const again = await runAlerts(
    { PUSH_SUBSCRIPTIONS: subsEnv(phone({ minDealScore: 0.5, minFaGain: 0.5 })) },
    { sender: second.sender },
  );
  assert.deepEqual(
    second.sent.filter((push) => push.payload.tag.startsWith("advice-")),
    [],
    "one push per (player, status, notes) transition",
  );
  assert.ok(again.advisor.leagues[LEAGUE_ID].items.some((item) => item.key === key));
  assert.deepEqual(validateAdvisor(again.advisor), []);

  // ...and from there the run is a fixed point: identical input, byte-identical files.
  const third = await runAlerts(
    { PUSH_SUBSCRIPTIONS: subsEnv(phone({ minDealScore: 0.5, minFaGain: 0.5 })) },
    { sender: recordingSender().sender },
  );
  assert.equal(third.advisorText, again.advisorText, "an unchanged feed is not rewritten");
  assert.ok(third.lines.some((line) => line.includes("data/advisor.json unchanged")));
  assert.deepEqual(third.state, again.state);
  assert.ok(third.lines.some((line) => line.includes("data/alerts-state.json unchanged")));
});

test("advice that will not fit the per-run cap collapses into one notification", () => {
  // Four of roster 3's healthy starters go Doubtful at once — a Sunday-morning inactives report.
  const roster = fixture("rosters.json").find((entry) => entry.roster_id === MY_ROSTER);
  const hurt = roster.starters.filter((id) => PLAYERS[id] && !PLAYERS[id].inj).slice(0, 4);
  assert.equal(hurt.length, 4);

  const rows = hurt.map((id) => ({ id, inj: "Doubtful", injPart: "Knee", injNotes: null, newsAt: NOW, dc: null }));
  const before = Object.fromEntries(hurt.map((id) => [id, "||"]));
  const after = Object.fromEntries(hurt.map((id) => [id, "Doubtful|Knee|"]));
  const seeded = applyState(emptyState(), {
    leagueId: LEAGUE_ID,
    week: 1,
    status: before,
    statusAt: isoTimestamp(new Date(NOW)),
  });

  const composed = composeAlerts(
    applyStatuses(CTX, rows),
    device({ prefs: { trades: false, deals: false, freeAgents: false } }),
    seeded,
    { status: after },
  );
  assert.deepEqual(composed.problems, []);
  assert.equal(composed.seeding, false);
  assert.ok(composed.advisories.length > MAX_PER_DEVICE);

  assert.equal(composed.notifications.length, 1, "one buzz, not five");
  const [batch] = composed.notifications;
  assert.equal(batch.kind, "advice");
  assert.equal(batch.batched, true);
  assert.equal(batch.key, null);
  assert.equal(batch.tag, "advice");
  assert.equal(batch.url, `${SUBJECT}#advisor`);
  assert.equal(batch.title, `${batch.keys.length} status changes on your roster`);
  assert.match(batch.body, /^most urgent: /);
  assert.ok(batch.body.endsWith(composed.advisories[0].summary), "the most urgent one leads");
  assert.deepEqual(composed.seen.advice, batch.keys, "a batch stands in for every key it covers");
  assert.deepEqual(composed.baseline, [], "nothing is baselined once the league is seeded");

  // switching the advice pref off leaves the run silent without touching the feed
  const muted = composeAlerts(
    applyStatuses(CTX, rows),
    device({ prefs: { trades: false, deals: false, freeAgents: false, advice: false } }),
    seeded,
    { status: after },
  );
  assert.deepEqual(muted.notifications, []);
  assert.ok(muted.advisories.length > 0, "the Advisor tab still gets its feed");
});

test("a dry run prints what it would send and writes nothing", async () => {
  clearStateFile();
  clearAdvisorFile();
  STATUS_ROWS = STATUS_RAW;

  const run = await runMain({
    env: { ALERT_DRY: "1", ALERT_DRY_LEAGUE: LEAGUE_ID, ALERT_DRY_USER: USER_ID },
    sender: () => assert.fail("a dry run must never send"),
  });
  assert.equal(run.code, 0, run.lines.join("\n"));
  assert.equal(run.state, null, "no data/alerts-state.json");
  assert.equal(run.advisorText, null, "no data/advisor.json");
  assert.ok(run.lines.some((line) => line.includes("(dry run)")));

  const previews = run.lines.filter((line) => line.startsWith("[dry] "));
  assert.ok(previews.length > 0, "a dry run with no stored snapshot still previews the standing issues");
  for (const line of previews) assert.match(line, /^\[dry] .+ — .+$/);

  // the advisories are printed as pretty JSON so a human can read the moves
  const json = run.lines.find((line) => line.startsWith("[\n") || line === "[]");
  const advisories = JSON.parse(json);
  assert.ok(Array.isArray(advisories) && advisories.length > 0);
  for (const advisory of advisories) {
    assert.equal(typeof advisory.key, "string");
    assert.ok(Array.isArray(advisory.moves));
  }
  assert.ok(advisories.some((advisory) => advisory.id === BOWERS), "the meniscus case is the point of the release");

  // no VAPID, no PUSH_SUBSCRIPTIONS, and the "nothing paired" early exit does not apply
  assert.ok(!run.lines.some((line) => line.includes("nothing paired")));
});

test("a run whose projections call fails still sends the rest", async () => {
  clearStateFile();
  clearAdvisorFile();
  const { sender, sent } = recordingSender();
  const run = await runAlerts(
    { PUSH_SUBSCRIPTIONS: subsEnv(phone()) },
    {
      sender,
      fetchJsonImpl: (url) =>
        url.includes("/projections/nfl/")
          ? Promise.reject(new Error("HTTP 503 Service Unavailable"))
          : fakeFetch(url),
    },
  );
  assert.equal(run.code, 0);
  assert.ok(run.lines.some((line) => line.includes("no advice this run")));
  assert.ok(sent.some((push) => push.payload.tag === `trade-${TRADE_ID}`), "trades are unaffected");
  assert.deepEqual(validateAlertsState(run.state), []);
});

/* ───────────── v1.4: server view, TTL/urgency, cooldowns, webhooks (design §13.3 B3) ───────────── */

test("deviceIdOf is the shared id the app and the service worker compute", () => {
  // The SAME vector is asserted in test/data.push.test.mjs. If these two ever disagree, the phone
  // can no longer ask "does the sender know about me?" and the whole diagnosis collapses.
  assert.equal(deviceIdOf("https://web.push.apple.com/QF2c-token"), "ee64af5d15e243bb");
  assert.equal(deviceIdOf("https://web.push.apple.com/QF2c-old"), "9131f5dc3c5f376c");
  assert.equal(deviceIdOf("https://discord.com/api/webhooks/123/abc"), "e6b000f9a5947c2e");
  assert.equal(deviceIdOf, deviceKey, "one implementation, two names");
});

test("normalizePrefs fills the v1.4 cooldowns, so a pre-v1.4 pairing needs no re-paste", () => {
  const old = normalizePrefs({ trades: true, deals: true, freeAgents: true, minDealScore: 2, minFaGain: 1 });
  assert.equal(old.dealsCooldownHours, 6);
  assert.equal(old.faCooldownHours, 6);
  assert.equal(old.maxDealsPerPush, 1);

  // Explicit values win; nonsense falls back; the floors hold.
  assert.equal(normalizePrefs({ dealsCooldownHours: 0 }).dealsCooldownHours, 0, "0 disables the cooldown");
  assert.equal(normalizePrefs({ dealsCooldownHours: -4 }).dealsCooldownHours, 0);
  assert.equal(normalizePrefs({ faCooldownHours: "nonsense" }).faCooldownHours, 6);
  assert.equal(normalizePrefs({ maxDealsPerPush: 0 }).maxDealsPerPush, 1, "a digest of nothing is not a thing");
  assert.equal(normalizePrefs({ maxDealsPerPush: 3 }).maxDealsPerPush, 3);
  assert.equal(normalizePrefs({ minFaGain: null }).minFaGain, 1, "null is absent, not zero");
});

test("deliveryOptions: advice is held longer and marked urgent, nothing else is", () => {
  // TTL 0 would be dropped outright whenever the phone is asleep (RFC 8030 / R5 §6.3).
  assert.deepEqual(deliveryOptions("advice"), { TTL: 14400, urgency: "high" });
  assert.deepEqual(deliveryOptions("deals"), { TTL: 7200, urgency: "normal" });
  assert.deepEqual(deliveryOptions("fa"), { TTL: 7200, urgency: "normal" });
  assert.deepEqual(deliveryOptions("trades"), { TTL: 7200, urgency: "normal" });
  assert.deepEqual(deliveryOptions("test"), { TTL: 3600, urgency: "normal" });
  assert.ok(deliveryOptions("anything").TTL > 0, "never zero");
});

test("cooldownState holds a kind back for its window and then lets it go", () => {
  const prefs = normalizePrefs({});
  const at = Date.parse("2026-09-17T06:00:00Z");
  const lastKindAt = { deals: "2026-09-17T06:00:00Z" };

  assert.equal(cooldownState("deals", prefs, lastKindAt, at + 3600_000).cooling, true, "1h in");
  assert.equal(cooldownState("deals", prefs, lastKindAt, at + 6 * 3600_000).cooling, false, "exactly 6h out");
  assert.equal(cooldownState("fa", prefs, lastKindAt, at + 3600_000).cooling, false, "kinds are independent");
  assert.equal(cooldownState("advice", prefs, { advice: "2026-09-17T06:00:00Z" }, at).cooling, false, "advice is never throttled");
  assert.equal(cooldownState("trades", prefs, { trades: "2026-09-17T06:00:00Z" }, at).cooling, false);
  assert.equal(cooldownState("deals", normalizePrefs({ dealsCooldownHours: 0 }), lastKindAt, at).cooling, false);
  assert.equal(cooldownState("deals", prefs, {}, at).cooling, false, "nothing sent yet, nothing to wait for");
});

test("composeAlerts: deals inside their cooldown are held WITHOUT being marked seen", () => {
  const state = applyState(emptyState(), {
    deviceId: "device0000000001",
    lastKindAt: { deals: isoTimestamp(new Date(NOW - 3600_000)) },
  });

  const dealsOnly = device({ prefs: { advice: false, trades: false, freeAgents: false } });
  const held = composeAlerts(CTX, dealsOnly, state, { status: {}, seeding: false, now: NOW });
  assert.equal(held.notifications.filter((n) => n.kind === "deals").length, 0);
  assert.ok(held.cooled.deals > 0, "the count is reported so the log can say why it was quiet");
  assert.deepEqual(held.seen.deals, [], "nothing is burned — the same deals come back after the window");

  // Six hours later the same deals are offered again.
  const later = composeAlerts(CTX, dealsOnly, state, { status: {}, seeding: false, now: NOW + 7 * 3600_000 });
  assert.ok(later.notifications.some((n) => n.kind === "deals"));
  assert.ok(later.seen.deals.length);
});

test("composeAlerts: more than maxDealsPerPush collapses into one digest", () => {
  const composed = composeAlerts(CTX, device({ prefs: { minDealScore: 0, advice: false, trades: false, freeAgents: false } }), emptyState(), {
    status: {},
    seeding: false,
    now: NOW,
  });
  const deals = composed.notifications.filter((n) => n.kind === "deals");
  assert.equal(deals.length, 1, "one push, not one per idea");
  assert.equal(deals[0].batched, true);
  assert.equal(deals[0].title, "New deals to propose");
  assert.match(deals[0].body, /^\d+ new deals — best: /);
  assert.ok(deals[0].keys.length > 1, "…and every idea in it is remembered, so it does not repeat");

  // Under the limit they go one by one. Everything but the first two is already seen here, so the
  // per-run cap (which batches on its own account) never gets a chance to interfere.
  const seenAllButTwo = applyState(emptyState(), {
    deviceId: "device0000000001",
    seen: { deals: deals[0].keys.slice(2) },
  });
  const few = composeAlerts(
    CTX,
    device({ prefs: { minDealScore: 0, advice: false, trades: false, freeAgents: false, maxDealsPerPush: 99 } }),
    seenAllButTwo,
    { status: {}, seeding: false, now: NOW },
  );
  const individually = few.notifications.filter((n) => n.kind === "deals");
  assert.equal(individually.length, 2, "no digest under the limit");
  assert.ok(individually.every((n) => !n.batched));

  // …and with maxDealsPerPush at its default of 1, those same two become one digest again.
  const digested = composeAlerts(
    CTX,
    device({ prefs: { minDealScore: 0, advice: false, trades: false, freeAgents: false } }),
    seenAllButTwo,
    { status: {}, seeding: false, now: NOW },
  );
  const two = digested.notifications.filter((n) => n.kind === "deals");
  assert.equal(two.length, 1);
  assert.equal(two[0].batched, true);
  assert.equal(two[0].keys.length, 2);
});

test("canonicalState carries the server view and stays byte-stable without one", () => {
  // The workflow commits only when the file changes; a run that sends nothing must not rewrite it.
  const legacy = {
    v: 1,
    leagues: {},
    devices: { abc0000000000001: { seenDeals: ["a"], seenFa: [], seenAdvice: [], lastNotifiedAt: "2026-09-17T12:11:48Z" } },
  };
  assert.equal(JSON.stringify(canonicalState(legacy)), JSON.stringify(canonicalState(canonicalState(legacy))));
  assert.equal(
    JSON.stringify(canonicalState(legacy).devices.abc0000000000001),
    JSON.stringify({ seenDeals: ["a"], seenFa: [], seenAdvice: [], lastNotifiedAt: "2026-09-17T12:11:48Z" }),
    "an entry written before v1.4 serializes exactly as it did",
  );

  const withView = applyState(legacy, {
    deviceId: "abc0000000000001",
    sent: { at: "2026-09-17T13:00:00Z", count: 2, result: { status: 201, at: "2026-09-17T13:00:00Z" } },
    lastKindAt: { deals: "2026-09-17T13:00:00Z" },
  });
  const entry = withView.devices.abc0000000000001;
  assert.equal(entry.lastSentAt, "2026-09-17T13:00:00Z");
  assert.equal(entry.sentCount, 2);
  assert.deepEqual(entry.lastResult, { status: 201, at: "2026-09-17T13:00:00Z" });
  assert.deepEqual(entry.lastKindAt, { deals: "2026-09-17T13:00:00Z" });
  assert.deepEqual(validateAlertsState(canonicalState(withView)), [], "the contract accepts the new keys");

  // sentCount accumulates across runs; a quiet run adds nothing.
  const twice = applyState(withView, { deviceId: "abc0000000000001", sent: { at: "2026-09-17T14:00:00Z", count: 1, result: { status: 201, at: "2026-09-17T14:00:00Z" } } });
  assert.equal(twice.devices.abc0000000000001.sentCount, 3);
  const quiet = applyState(twice, { deviceId: "abc0000000000001" });
  assert.equal(JSON.stringify(canonicalState(quiet)), JSON.stringify(canonicalState(twice)), "a quiet run is byte-identical");
});

test("main records what it sent per device, with the status code", async () => {
  clearStateFile();
  clearAdvisorFile();
  const { sender, sent } = recordingSender();
  const run = await runMain({
    env: { PUSH_SUBSCRIPTIONS: subsEnv(phone()), VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test", ALERT_FULL: "1" },
    sender,
  });
  assert.equal(run.code, 0);
  assert.ok(sent.length > 0);

  const id = deviceIdOf(phone()[0].sub.endpoint);
  const entry = run.state.devices[id];
  assert.equal(entry.sentCount, sent.length);
  assert.ok(entry.lastSentAt, "the sender's own view of when it last delivered");
  assert.equal(entry.lastResult.status, 201);
  assert.deepEqual(validateAlertsState(run.state), []);

  // …and the log names the status code, which is all the sender can honestly claim.
  // "accepted", not "delivered": web.push.apple.com answers 2xx for a subscription it has already
  // discarded (Apple Developer Forums 719990; research R5 §6.2), so the log may not overclaim.
  assert.ok(run.lines.some((line) => /\[ok {2}\] push .*· accepted 201 · /.test(line)), run.lines.join("\n"));
  clearStateFile();
  clearAdvisorFile();
});

test("main passes TTL and urgency per notification kind", async () => {
  clearStateFile();
  clearAdvisorFile();
  const seen = [];
  const sender = async (subscription, payload, options) => {
    seen.push({ kind: JSON.parse(payload).kind, options });
    return { statusCode: 201, headers: { "apns-id": "9F2B-TEST" } };
  };
  const run = await runMain({
    env: { PUSH_SUBSCRIPTIONS: subsEnv(phone()), VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: "test", ALERT_FULL: "1" },
    sender,
  });
  assert.equal(run.code, 0);
  assert.ok(seen.length);
  for (const push of seen) assert.deepEqual(push.options, deliveryOptions(push.kind));
  assert.ok(run.lines.some((line) => line.includes("9F2B-TEST")), "the apns-id is logged for correlation");
  clearStateFile();
  clearAdvisorFile();
});

/* --- fallback channels ------------------------------------------------------------------------ */

test("webhookKind reads the flavour off the URL", () => {
  assert.equal(webhookKind("https://discord.com/api/webhooks/123/abc"), "discord");
  assert.equal(webhookKind("https://discordapp.com/api/webhooks/123/abc"), "discord");
  assert.equal(webhookKind("https://hooks.slack.com/services/T/B/x"), "slack");
  assert.equal(webhookKind("https://ntfy.sh/tradewinds-tom"), "ntfy");
  assert.equal(webhookKind("https://ntfy.example.org/topic"), "ntfy");
  assert.equal(webhookKind("https://example.com/hook"), "generic");
  assert.equal(webhookKind("https://discord.com/channels/1/2"), "generic", "only the webhook path counts");
  assert.equal(webhookKind("not a url"), "generic");
});

test("parseWebhooks takes bare URLs or objects, and skips what it cannot use", () => {
  const { webhooks, problems } = parseWebhooks(
    JSON.stringify([
      "https://ntfy.sh/tradewinds-tom",
      { url: "https://hooks.slack.com/services/T/B/x", label: "Team Slack", prefs: { deals: false } },
      { url: "ftp://nope" },
      "https://ntfy.sh/tradewinds-tom",
    ]),
  );
  assert.equal(webhooks.length, 2);
  assert.equal(webhooks[0].id, deviceIdOf("https://ntfy.sh/tradewinds-tom"), "a channel is a device, keyed the same way");
  assert.equal(webhooks[0].webhook.kind, "ntfy");
  assert.equal(webhooks[1].label, "Team Slack");
  assert.equal(webhooks[1].prefs.deals, false, "per-channel prefs, normalized like any other device");
  assert.equal(webhooks[1].prefs.dealsCooldownHours, 6);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /http\(s\) url/);
  assert.match(problems[1], /duplicate/);

  assert.deepEqual(parseWebhooks("").webhooks, [], "no secret, no channels");
  assert.deepEqual(parseWebhooks(undefined).webhooks, []);
  assert.match(parseWebhooks("{oops").problems[0], /not valid JSON/);
});

test("webhookRequest shapes the body each service expects", () => {
  const notification = {
    title: "Trade: hobbezilla ⇄ speckledorf",
    body: "hobbezilla gets Gibbs · speckledorf gets Nabers",
    tag: "trade-1",
    url: `${SUBJECT}#league`,
    kind: "trades",
  };

  const discord = webhookRequest({ url: "https://discord.com/api/webhooks/1/x", kind: "discord" }, notification);
  assert.equal(discord.init.method, "POST");
  assert.deepEqual(JSON.parse(discord.init.body).embeds, [
    { title: notification.title, description: notification.body, url: notification.url },
  ]);

  const slack = webhookRequest({ url: "https://hooks.slack.com/services/T/B/x", kind: "slack" }, notification);
  assert.equal(JSON.parse(slack.init.body).text, `*${notification.title}*\n${notification.body}\n${notification.url}`);

  const ntfy = webhookRequest({ url: "https://ntfy.sh/t", kind: "ntfy" }, notification);
  assert.equal(ntfy.init.body, notification.body);
  assert.equal(ntfy.init.headers.Click, notification.url);
  assert.equal(ntfy.init.headers.Tags, "trades");
  // Header values are Latin-1: "⇄" and "·" would make the request itself fail.
  assert.equal(ntfy.init.headers.Title, "Trade: hobbezilla <-> speckledorf");
  assert.ok(/^[\x20-\x7E]*$/.test(ntfy.init.headers.Title));

  const generic = webhookRequest({ url: "https://example.com/hook", kind: "generic" }, notification);
  assert.deepEqual(JSON.parse(generic.init.body), {
    title: notification.title,
    body: notification.body,
    url: notification.url,
    tag: notification.tag,
    kind: "trades",
  });
});

test("sendWebhook throws with the status code so a dead channel expires like a dead endpoint", async () => {
  const ok = await sendWebhook(
    { url: "https://ntfy.sh/t", kind: "ntfy" },
    { title: "x", body: "y", tag: "t", url: SUBJECT },
    { fetchImpl: async () => ({ status: 200 }) },
  );
  assert.equal(ok.statusCode, 200);

  await assert.rejects(
    sendWebhook({ url: "https://ntfy.sh/t", kind: "ntfy" }, { title: "x", body: "y", tag: "t", url: SUBJECT }, { fetchImpl: async () => ({ status: 410 }) }),
    (error) => {
      assert.equal(error.statusCode, 410);
      assert.equal(isGoneError(error), true);
      return true;
    },
  );
});

test("a webhook channel is a device: same composition, same state, no VAPID needed", async () => {
  clearStateFile();
  clearAdvisorFile();
  const posts = [];
  const run = await runMain({
    env: {
      // No PUSH_SUBSCRIPTIONS and no VAPID_PRIVATE_KEY at all: the channel still gets everything.
      ALERT_WEBHOOKS: JSON.stringify([{ url: "https://ntfy.sh/tradewinds-tom", label: "ntfy", leagueId: LEAGUE_ID, userId: USER_ID }]),
      VAPID_SUBJECT: SUBJECT,
      ALERT_FULL: "1",
    },
    fetchImpl: async (url, init) => {
      posts.push({ url, init });
      return { status: 200, headers: {} };
    },
  });

  assert.equal(run.code, 0);
  assert.ok(posts.length > 0, "the channel was posted to");
  assert.equal(posts[0].url, "https://ntfy.sh/tradewinds-tom");
  assert.ok(posts[0].init.headers.Title);

  const id = deviceIdOf("https://ntfy.sh/tradewinds-tom");
  assert.ok(run.state.devices[id], "and it is remembered exactly like a phone");
  assert.equal(run.state.devices[id].sentCount, posts.length);
  assert.deepEqual(validateAlertsState(run.state), []);

  // The dedupe is shared with the push path, so nothing a channel has already been told is
  // repeated on the next run (what is left over is the per-run cap's deferred queue).
  const firstBodies = posts.map((p) => String(p.init.body));
  const secondPosts = [];
  const second = await runMain({
    env: {
      ALERT_WEBHOOKS: JSON.stringify([{ url: "https://ntfy.sh/tradewinds-tom", label: "ntfy", leagueId: LEAGUE_ID, userId: USER_ID }]),
      VAPID_SUBJECT: SUBJECT,
    },
    fetchImpl: async (url, init) => {
      secondPosts.push({ url, init });
      return { status: 200, headers: {} };
    },
  });
  assert.equal(second.code, 0);
  for (const post of secondPosts) {
    assert.ok(!firstBodies.includes(String(post.init.body)), `repeated: ${post.init.body}`);
  }
  assert.equal(second.state.devices[id].sentCount, posts.length + secondPosts.length, "the count keeps accumulating");
  clearStateFile();
  clearAdvisorFile();
});

test("a webhook with no league and no phone to inherit one from is skipped, not fatal", async () => {
  clearStateFile();
  clearAdvisorFile();
  const run = await runMain({
    env: { ALERT_WEBHOOKS: JSON.stringify(["https://example.com/hook"]), VAPID_SUBJECT: SUBJECT },
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(run.code, 0);
  assert.ok(run.lines.some((line) => line.includes("no leagueId")));
  clearStateFile();
  clearAdvisorFile();
});

/* ───────────── B5: the phone re-pairs itself over repository_dispatch (design §13.3) ───────────── */

/**
 * A throwaway VAPID pair in exactly the format scripts/vapid.mjs prints: the public key is the
 * 65-byte uncompressed point, the private key is the raw 32-byte scalar, both base64url.
 */
function vapidPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { publicKey: raw.toString("base64url"), privateKey: priv.d };
}

/** `pairingBlob` reads the key from the module constant, so the test seals with its own copy. */
async function sealWithWebCrypto(pairing, vapidPublicKey) {
  const subtle = webcrypto.subtle;
  const rawKey = Buffer.from(vapidPublicKey, "base64url");
  const serverKey = await subtle.importKey("raw", rawKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, ephemeral.privateKey, 256);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const keyBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(PAIR_INFO) },
    hkdfKey,
    256,
  );
  const aesKey = await subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(JSON.stringify(pairing)));
  const epk = await subtle.exportKey("raw", ephemeral.publicKey);
  const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
  const envelope = { v: 1, epk: b64(epk), salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

const samplePairing = (over = {}) => ({
  v: 1,
  sub: {
    endpoint: "https://web.push.apple.com/QF2c-rotated-token",
    expirationTime: null,
    keys: { p256dh: "BM9-p256dh-key", auth: "aUtH-secret" },
  },
  leagueId: LEAGUE_ID,
  userId: USER_ID,
  label: "iPhone",
  prefs: { ...DEFAULT_PREFS },
  createdAt: "2026-09-17T13:00:00Z",
  ...over,
});

test("a pairing sealed in the browser opens in node, and only with the right key", async () => {
  // The whole self-healing path rests on these two implementations agreeing: WebCrypto ECDH →
  // HKDF-SHA256 → AES-256-GCM on the phone, node:crypto on the runner.
  const vapid = vapidPair();
  const pairing = samplePairing();
  const blob = await sealWithWebCrypto(pairing, vapid.publicKey);

  assert.deepEqual(decryptPairingBlob(blob, vapid.privateKey), pairing);
  assert.ok(!Buffer.from(blob, "base64url").toString("utf8").includes("web.push.apple.com"), "nothing leaks in the clear");

  const other = vapidPair();
  assert.throws(() => decryptPairingBlob(blob, other.privateKey), /Unsupported state|unable to authenticate|bad decrypt/i);
});

test("a tampered pairing blob is rejected, not half-read", async () => {
  const vapid = vapidPair();
  const blob = await sealWithWebCrypto(samplePairing(), vapid.publicKey);
  const envelope = JSON.parse(Buffer.from(blob, "base64url").toString("utf8"));

  const ct = Buffer.from(envelope.ct, "base64url");
  ct[4] ^= 0xff; // one flipped byte inside the ciphertext
  const tampered = Buffer.from(
    JSON.stringify({ ...envelope, ct: ct.toString("base64url") }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decryptPairingBlob(tampered, vapid.privateKey), /Unsupported state|unable to authenticate|bad decrypt/i);

  // …and so is a malformed envelope, rather than crashing the run.
  assert.throws(() => decryptPairingBlob("not-base64url-json", vapid.privateKey), /not an envelope/);
  assert.throws(
    () => decryptPairingBlob(Buffer.from(JSON.stringify({ v: 2 }), "utf8").toString("base64url"), vapid.privateKey),
    /unsupported pairing blob version/,
  );
  assert.throws(
    () =>
      decryptPairingBlob(
        Buffer.from(JSON.stringify({ ...envelope, epk: "AAAA" }), "utf8").toString("base64url"),
        vapid.privateKey,
      ),
    /uncompressed P-256 point/,
  );
});

test("validatePairing refuses anything it would not push to", () => {
  assert.deepEqual(validatePairing(samplePairing()), []);
  assert.match(validatePairing(samplePairing({ v: 2 }))[0], /pairing\.v/);
  assert.match(validatePairing({ ...samplePairing(), sub: { endpoint: "http://insecure", keys: { p256dh: "a", auth: "b" } } })[0], /https url/);
  assert.match(validatePairing({ ...samplePairing(), sub: { endpoint: "https://x", keys: { auth: "b" } } })[0], /p256dh/);
  assert.match(validatePairing(samplePairing({ leagueId: "" })).join(" "), /leagueId/);
  assert.deepEqual(validatePairing(null), ["pairing is not an object"]);
});

test("parseDispatchPayload survives every trigger the workflow has", () => {
  assert.deepEqual(parseDispatchPayload("{}"), { blob: null, deviceId: null, label: null, test: false });
  assert.deepEqual(parseDispatchPayload(undefined), { blob: null, deviceId: null, label: null, test: false });
  assert.deepEqual(parseDispatchPayload("null"), { blob: null, deviceId: null, label: null, test: false });
  assert.deepEqual(parseDispatchPayload("not json"), { blob: null, deviceId: null, label: null, test: false });
  assert.deepEqual(parseDispatchPayload(JSON.stringify({ v: 1, blob: "abc", deviceId: "d1", label: "iPhone" })), {
    blob: "abc",
    deviceId: "d1",
    label: "iPhone",
    test: false,
  });
  assert.equal(parseDispatchPayload(JSON.stringify({ test: true })).test, true);
});

test("applyPairing stores ciphertext and retires the same phone's older entry", () => {
  const first = applyPairing(emptyState(), {
    id: "aaaa000000000001",
    blob: "BLOB-1",
    label: "iPhone",
    userId: USER_ID,
    leagueId: LEAGUE_ID,
    createdAt: "2026-09-10T00:00:00Z",
  });
  assert.deepEqual(first.superseded, []);
  assert.equal(first.state.pairings.aaaa000000000001.blob, "BLOB-1");

  const second = applyPairing(first.state, {
    id: "bbbb000000000002",
    blob: "BLOB-2",
    label: "iPhone",
    userId: USER_ID,
    leagueId: LEAGUE_ID,
    createdAt: "2026-09-17T00:00:00Z",
  });
  assert.deepEqual(second.superseded, ["aaaa000000000001"]);
  assert.equal(second.state.pairings.aaaa000000000001.supersededBy, "bbbb000000000002");
  assert.equal(second.state.pairings.bbbb000000000002.supersededBy, undefined);

  // A different device (another label) is left alone.
  const third = applyPairing(second.state, { id: "cccc000000000003", blob: "BLOB-3", label: "iPad", userId: USER_ID, leagueId: LEAGUE_ID });
  assert.deepEqual(third.superseded, []);
  assert.equal(third.state.pairings.bbbb000000000002.supersededBy, undefined);

  assert.deepEqual(validateAlertsState(canonicalState(third.state)), [], "the contract still accepts the file");
  // Byte-stable, and absent entirely when nothing has self-paired.
  assert.equal(JSON.stringify(canonicalState(third.state)), JSON.stringify(canonicalState(canonicalState(third.state))));
  assert.equal(canonicalState(emptyState()).pairings, undefined, "no key, no diff, nothing to commit");
});

test("pairedDevices decrypts the live entries and skips the superseded ones", async () => {
  const vapid = vapidPair();
  const oldBlob = await sealWithWebCrypto(samplePairing({ sub: { endpoint: "https://web.push.apple.com/OLD", keys: { p256dh: "a", auth: "b" } } }), vapid.publicKey);
  const newBlob = await sealWithWebCrypto(samplePairing(), vapid.publicKey);

  let state = applyPairing(emptyState(), { id: deviceIdOf("https://web.push.apple.com/OLD"), blob: oldBlob, label: "iPhone", userId: USER_ID, leagueId: LEAGUE_ID }).state;
  state = applyPairing(state, { id: deviceIdOf("https://web.push.apple.com/QF2c-rotated-token"), blob: newBlob, label: "iPhone", userId: USER_ID, leagueId: LEAGUE_ID }).state;

  const problems = [];
  const devices = pairedDevices(state, vapid.privateKey, (id, message) => problems.push(`${id}: ${message}`));
  assert.equal(devices.length, 1, "only the live pairing is a destination");
  assert.equal(devices[0].sub.endpoint, "https://web.push.apple.com/QF2c-rotated-token");
  assert.equal(devices[0].id, deviceIdOf(devices[0].sub.endpoint));
  assert.equal(devices[0].selfPaired, true);
  assert.equal(devices[0].prefs.dealsCooldownHours, 6, "prefs are normalized like any other device");
  assert.deepEqual(problems, []);

  // A blob the private key cannot open is reported and skipped, never fatal.
  const wrongKey = pairedDevices(state, vapidPair().privateKey, (id, message) => problems.push(`${id}: ${message}`));
  assert.deepEqual(wrongKey, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be decrypted/);
  assert.deepEqual(pairedDevices(state, "", () => {}), [], "no private key, no self-paired devices");
});

test("mergeDevices lets a self-filed pairing supersede the pasted secret for the same phone", () => {
  const secret = [{ id: "old0000000000001", userId: USER_ID, label: "iPhone", sub: { endpoint: "https://old" } }];
  const paired = [{ id: "new0000000000002", userId: USER_ID, label: "iPhone", sub: { endpoint: "https://new" }, selfPaired: true }];

  const merged = mergeDevices(secret, paired);
  assert.deepEqual(merged.devices.map((d) => d.id), ["new0000000000002"], "the phone knows its own address");
  assert.deepEqual(merged.superseded, [{ id: "old0000000000001", by: "new0000000000002", label: "iPhone" }]);

  // A different phone in the secret is kept.
  const both = mergeDevices([...secret, { id: "ipad000000000003", userId: USER_ID, label: "iPad", sub: {} }], paired);
  assert.deepEqual(both.devices.map((d) => d.id).sort(), ["ipad000000000003", "new0000000000002"]);

  // Nothing self-paired: the secret stands exactly as before.
  assert.deepEqual(mergeDevices(secret, []).devices, secret);
});

test("main files an incoming pairing, uses it the same run, and never logs the plaintext", async () => {
  clearStateFile();
  clearAdvisorFile();
  const vapid = vapidPair();
  const endpoint = "https://web.push.apple.com/SELF-PAIRED-TOKEN";
  const blob = await sealWithWebCrypto(samplePairing({ sub: { endpoint, keys: { p256dh: "BM9-x", auth: "aUtH-x" } } }), vapid.publicKey);

  const { sender, sent } = recordingSender();
  const run = await runMain({
    env: {
      // No PUSH_SUBSCRIPTIONS at all: the phone pairs itself.
      VAPID_SUBJECT: SUBJECT,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      PAIR_PAYLOAD: JSON.stringify({ v: 1, blob, deviceId: deviceIdOf(endpoint), label: "iPhone" }),
      ALERT_FULL: "1",
    },
    sender,
  });

  assert.equal(run.code, 0);
  const id = deviceIdOf(endpoint);
  assert.ok(run.lines.some((line) => line.includes(`stored ${id}`)), run.lines.join("\n"));
  assert.ok(sent.length > 0, "and it was sent to in the very same run");
  assert.deepEqual([...new Set(sent.map((s) => s.endpoint))], [endpoint]);

  // The state keeps the CIPHERTEXT, never the endpoint or its keys.
  const raw = readFileSync(stateFilePath(), "utf8");
  assert.equal(run.state.pairings[id].blob, blob);
  assert.ok(!raw.includes(endpoint), "the public state file never carries the endpoint");
  assert.ok(!raw.includes("aUtH-x"), "…nor the auth secret");
  assert.ok(!run.lines.join("\n").includes(endpoint), "and neither does the log");
  assert.deepEqual(validateAlertsState(run.state), []);

  clearStateFile();
  clearAdvisorFile();
});

test("a pairing that cannot be opened, or arrives with no key, is a warning and nothing more", async () => {
  clearStateFile();
  clearAdvisorFile();
  const vapid = vapidPair();
  const blob = await sealWithWebCrypto(samplePairing(), vapid.publicKey);

  const noKey = await runMain({
    env: { VAPID_SUBJECT: SUBJECT, PAIR_PAYLOAD: JSON.stringify({ v: 1, blob, label: "iPhone" }) },
  });
  assert.equal(noKey.code, 0);
  assert.ok(noKey.lines.some((line) => line.includes("VAPID_PRIVATE_KEY is not set")));

  const wrongKey = await runMain({
    env: { VAPID_SUBJECT: SUBJECT, VAPID_PRIVATE_KEY: vapidPair().privateKey, PAIR_PAYLOAD: JSON.stringify({ v: 1, blob, label: "iPhone" }) },
  });
  assert.equal(wrongKey.code, 0);
  assert.ok(wrongKey.lines.some((line) => line.includes("could not be opened")));
  assert.ok(wrongKey.lines.some((line) => line.includes("nothing paired")));
  clearStateFile();
  clearAdvisorFile();
});

test("client_payload.test is the phone asking for a test push", async () => {
  clearStateFile();
  const { sender, sent } = recordingSender();
  const run = await runMain({
    env: {
      PUSH_SUBSCRIPTIONS: subsEnv(phone()),
      VAPID_SUBJECT: SUBJECT,
      VAPID_PRIVATE_KEY: "test",
      PAIR_PAYLOAD: JSON.stringify({ test: true }),
    },
    sender,
    fetchJsonImpl: () => Promise.reject(new Error("a test push must not touch the network")),
  });
  assert.equal(run.code, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Tradewinds alerts are on");
  assert.ok(run.lines.some((line) => line.includes("accepted by the push service")));
  clearStateFile();
});

/* ───────────── scripts/alerts-doctor.mjs (design §13.3 B3) ───────────── */

const DOCTOR_NOW = Date.parse("2026-09-17T13:00:00Z");
const run = (at, conclusion = "success") => ({ run_started_at: at, conclusion, html_url: "https://x" });

test("the doctor reads the sender's own view and never claims delivery", () => {
  const result = doctorDiagnose({
    now: DOCTOR_NOW,
    runs: [run("2026-09-17T12:50:00Z")],
    devices: [{ id: "11b2551101563b49", label: "iPhone" }],
    state: {
      v: 1,
      leagues: { [LEAGUE_ID]: {} },
      devices: {
        "11b2551101563b49": {
          seenDeals: ["a", "b"],
          seenFa: [],
          seenAdvice: [],
          lastNotifiedAt: "2026-09-17T12:11:48Z",
          lastSentAt: "2026-09-17T12:11:48Z",
          sentCount: 80,
          lastResult: { status: 201, at: "2026-09-17T12:11:48Z" },
        },
      },
    },
  });

  assert.deepEqual(result.problems, [], "a healthy sender raises nothing — the phone is the unknown");
  assert.equal(result.devices[0].paired, true);
  assert.equal(result.devices[0].sentCount, 80);

  const text = doctorRender(result, { now: DOCTOR_NOW, devicesKnown: true });
  assert.match(text, /accepted\s+80 push/);
  assert.match(text, /CANNOT tell you/);
  assert.match(text, /accepted by Apple/);
  assert.match(text, /Settings . Alerts . Diagnose/);
});

test("the doctor names the three failures it CAN see from outside the phone", () => {
  // 1. the secret and the state file disagree — the endpoint rotated.
  const rotated = doctorDiagnose({
    now: DOCTOR_NOW,
    runs: [run("2026-09-17T12:50:00Z")],
    devices: [{ id: "newnewnewnew0001", label: "iPhone" }],
    state: { v: 1, leagues: {}, devices: { oldoldoldold0001: { seenDeals: [], seenFa: [], seenAdvice: [], lastNotifiedAt: "2026-09-10T00:00:00Z" } } },
  });
  assert.ok(rotated.problems.some((p) => /NOT in PUSH_SUBSCRIPTIONS/.test(p)));
  assert.ok(rotated.problems.some((p) => /has no entry in the state file/.test(p)));

  // 2. an expired device.
  const expired = doctorDiagnose({
    now: DOCTOR_NOW,
    runs: [run("2026-09-17T12:50:00Z")],
    devices: [],
    state: { v: 1, leagues: {}, devices: { d1: { seenDeals: [], seenFa: [], seenAdvice: [], lastNotifiedAt: "2026-09-17T12:00:00Z", expired: true } } },
  });
  assert.ok(expired.problems.some((p) => /marked expired/.test(p)));

  // 3. the workflow itself stopped, or is failing.
  const stalled = doctorDiagnose({ now: DOCTOR_NOW, runs: [run("2026-09-16T00:00:00Z")], devices: [], state: { v: 1, leagues: {}, devices: {} } });
  assert.ok(stalled.problems.some((p) => /has not run for/.test(p)));
  const failing = doctorDiagnose({
    now: DOCTOR_NOW,
    runs: [run("2026-09-17T12:50:00Z", "failure"), run("2026-09-17T12:40:00Z")],
    devices: [],
    state: { v: 1, leagues: {}, devices: {} },
  });
  assert.ok(failing.problems.some((p) => /did not succeed/.test(p)));
});

test("the doctor lists self-filed pairings and does not mistake them for stale devices", () => {
  const result = doctorDiagnose({
    now: DOCTOR_NOW,
    runs: [run("2026-09-17T12:50:00Z")],
    devices: [], // the secret was not supplied
    state: {
      v: 1,
      leagues: {},
      devices: { newnewnewnew0001: { seenDeals: [], seenFa: [], seenAdvice: [], lastNotifiedAt: "2026-09-17T12:00:00Z" } },
      pairings: {
        oldoldoldold0001: { blob: "X", label: "iPhone", userId: USER_ID, leagueId: LEAGUE_ID, createdAt: "2026-09-10T00:00:00Z", supersededBy: "newnewnewnew0001" },
        newnewnewnew0001: { blob: "Y", label: "iPhone", userId: USER_ID, leagueId: LEAGUE_ID, createdAt: "2026-09-17T11:00:00Z" },
      },
    },
  });

  assert.equal(result.pairings.length, 2);
  assert.equal(result.devices[0].selfPaired, true);
  assert.deepEqual(result.problems, [], "a phone that pairs itself is not missing from the secret");

  const text = doctorRender(result, { now: DOCTOR_NOW, devicesKnown: false });
  assert.match(text, /self-paired by the phone/);
  assert.match(text, /superseded by newnewnewnew0001/);
  assert.match(text, /only VAPID_PRIVATE_KEY opens them/);
});

test("the doctor survives an unreachable state file", () => {
  const result = doctorDiagnose({ now: DOCTOR_NOW, runs: null, devices: [], state: null });
  assert.match(result.lines[0], /could not read the Actions API/);
  assert.ok(result.problems.some((p) => /Without the state file/.test(p)));
  assert.deepEqual(result.devices, []);
  assert.doesNotThrow(() => doctorRender(result, { now: DOCTOR_NOW, devicesKnown: false }));
});

test("the doctor's main() reads the public state file and returns a non-zero code for problems", async () => {
  const lines = [];
  const code = await doctorMain({
    argv: [],
    env: {},
    now: DOCTOR_NOW,
    log: (line) => lines.push(line),
    fetchImpl: async (url) => {
      if (url.includes("alerts-state.json")) {
        return { ok: true, json: async () => ({ v: 1, leagues: {}, devices: { d1: { seenDeals: [], seenFa: [], seenAdvice: [], lastNotifiedAt: "2026-09-17T12:00:00Z", expired: true } } }) };
      }
      return { ok: true, json: async () => ({ workflow_runs: [run("2026-09-17T12:50:00Z")] }) };
    },
  });
  assert.equal(code, 1, "an expired device is a problem worth an exit code");
  assert.match(lines.join("\n"), /marked expired/);

  // Everything offline: it still prints, and still refuses to claim health.
  const offlineLines = [];
  const offline = await doctorMain({
    argv: [],
    env: {},
    now: DOCTOR_NOW,
    log: (line) => offlineLines.push(line),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline, 1);
  assert.match(offlineLines.join("\n"), /could not be read/);
});
