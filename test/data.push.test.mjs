// Client-side Web Push (design §11.4), exercised against fake browser APIs. Named `data.push`
// so it stays inside the data-layer agent's `test/data.*.test.mjs` file pattern.
//
// Nothing here touches a global: `src/push.js` takes `{ win, notification, serviceWorker,
// storage }` and falls back to the real browser objects only when they are not injected.

import test from "node:test";
import assert from "node:assert/strict";

import { webcrypto } from "node:crypto";

import {
  ALERT_REASON_TEXT,
  DEFAULT_PREFS,
  PAIRING_VERSION,
  PUSH_STORAGE_KEY,
  PushError,
  VAPID_PUBLIC_KEY,
  GITHUB_TOKEN_KEY,
  alertsStatus,
  alertsSupported,
  clearProbeCache,
  deviceIdOf,
  deviceLabel,
  disableAlerts,
  dispatchToGithub,
  enableAlerts,
  ensureSubscription,
  maskToken,
  pairingBlob,
  pairingCode,
  pushReceipts,
  reasonText,
  saveToken,
  sendPairing,
  storedPairing,
  storedToken,
  testNotification,
  updatePrefs,
  urlBase64ToUint8Array,
} from "../src/push.js";
import { makeMemoryIndexedDb } from "./shims/indexeddb-shim.mjs";

/** The key from design §11.1 — public half, safe to embed. */
const VAPID = "BHRrun9caaSWpO0KOYVBrEHU7lo0SJ2qNQ203fkbMP24VIyZTa1Rssxk2XpiFekMscVSUBlj6TakzQ8Xu0l5CQo";

const UA = {
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

const settings = { leagueId: "1394476745138147328", userId: "1394551386997272576" };

/* ─────────────────────────────── fakes ─────────────────────────────── */

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** localStorage that throws on every call — Safari private mode. */
const brokenStorage = () => ({
  getItem() {
    throw new DOMException("denied");
  },
  setItem() {
    throw new DOMException("QuotaExceededError");
  },
  removeItem() {
    throw new DOMException("denied");
  },
});

function fakeNotification({ permission = "default", grants = "granted" } = {}) {
  const api = {
    permission,
    requests: 0,
    async requestPermission() {
      api.requests += 1;
      api.permission = grants;
      return grants;
    },
  };
  return api;
}

function fakeSubscription(endpoint = "https://web.push.apple.com/QF2c-token") {
  return {
    endpoint,
    unsubscribes: 0,
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: { p256dh: "BM9-p256dh-key", auth: "aUtH-secret" },
    }),
    async unsubscribe() {
      this.unsubscribes += 1;
      return true;
    },
  };
}

/**
 * @param {{existing?: object|null, subscribe?: Function, ready?: Promise}} [options]
 *   `subscribe` replaces the default behaviour (used for the InvalidStateError retry).
 */
function fakeServiceWorker({ existing = null, subscribe, ready } = {}) {
  let current = null;
  /** A real unsubscribe also detaches the subscription from the registration. */
  const track = (sub) => {
    if (!sub || sub.tracked) return sub;
    const inner = sub.unsubscribe.bind(sub);
    sub.tracked = true;
    sub.unsubscribe = async () => {
      const ok = await inner();
      if (current === sub) current = null;
      return ok;
    };
    return sub;
  };
  current = track(existing);

  const pushManager = {
    subscribeCalls: [],
    async subscribe(options) {
      pushManager.subscribeCalls.push(options);
      current = track(subscribe ? await subscribe(options, current) : fakeSubscription());
      return current;
    },
    async getSubscription() {
      return current;
    },
  };
  const registration = { pushManager, scope: "https://tom-bentley.github.io/tradewinds/" };
  return {
    ready: ready ?? Promise.resolve(registration),
    registration,
    pushManager,
    get subscription() {
      return current;
    },
  };
}

/**
 * A whole fake browser. Defaults describe Edge on Windows, installed-irrelevant, permission
 * not yet asked.
 */
function harness(overrides = {}) {
  const {
    ua = UA.edge,
    platform = "Win32",
    maxTouchPoints = 0,
    standalone,
    displayMode = "browser",
    secure = true,
    pushManager = true,
    notification = fakeNotification(),
    serviceWorker = fakeServiceWorker(),
    storage = fakeStorage(),
    hasNotification = true,
    hasServiceWorker = true,
  } = overrides;

  const navigator = {
    userAgent: ua,
    platform,
    maxTouchPoints,
    ...(standalone === undefined ? {} : { standalone }),
    ...(hasServiceWorker ? { serviceWorker } : {}),
  };

  const win = {
    navigator,
    isSecureContext: secure,
    matchMedia: (query) => ({ matches: query.includes("standalone") && displayMode === "standalone" }),
    localStorage: storage,
    ...(pushManager ? { PushManager: function PushManager() {} } : {}),
    ...(hasNotification ? { Notification: notification } : {}),
  };

  return { deps: { win }, win, navigator, notification, serviceWorker, storage };
}

/* ─────────────────────────────── alertsSupported ─────────────────────────────── */

test("alertsSupported: a normal desktop browser is good to go", () => {
  const { deps } = harness();
  assert.deepEqual(alertsSupported(deps), { ok: true, reason: null });
});

test("alertsSupported: no PushManager / no Notification / no service worker → unsupported", () => {
  assert.deepEqual(alertsSupported(harness({ pushManager: false }).deps), { ok: false, reason: "unsupported" });
  assert.deepEqual(alertsSupported(harness({ hasNotification: false }).deps), { ok: false, reason: "unsupported" });
  assert.deepEqual(alertsSupported(harness({ hasServiceWorker: false }).deps), { ok: false, reason: "unsupported" });
});

test("alertsSupported: an iPhone Safari TAB reports not-installed, never unsupported", () => {
  // The tell that makes this test matter: on iOS a plain tab exposes neither API, so an
  // API-first check would tell every iPhone user "unsupported" when the fix is one Share-sheet
  // tap away (design §11.5 — the reason text has to say "Add to Home Screen").
  const tab = harness({ ua: UA.iphone, platform: "iPhone", maxTouchPoints: 5, standalone: false, pushManager: false, hasNotification: false });
  assert.deepEqual(alertsSupported(tab.deps), { ok: false, reason: "not-installed" });
  assert.match(reasonText("not-installed"), /Home Screen/);
  assert.equal(reasonText("not-installed"), ALERT_REASON_TEXT["not-installed"]);
});

test("alertsSupported: installed on the Home Screen is ok, by either standalone signal", () => {
  const flagged = harness({ ua: UA.iphone, platform: "iPhone", maxTouchPoints: 5, standalone: true });
  assert.deepEqual(alertsSupported(flagged.deps), { ok: true, reason: null });

  // iPadOS reports itself as a desktop Mac; the touch-point count is the only tell.
  const ipad = harness({ ua: UA.mac, platform: "MacIntel", maxTouchPoints: 5, displayMode: "standalone" });
  assert.deepEqual(alertsSupported(ipad.deps), { ok: true, reason: null });

  const ipadTab = harness({ ua: UA.mac, platform: "MacIntel", maxTouchPoints: 5 });
  assert.deepEqual(alertsSupported(ipadTab.deps), { ok: false, reason: "not-installed" });

  // A real Mac (no touch points) is never asked to install anything.
  const mac = harness({ ua: UA.mac, platform: "MacIntel", maxTouchPoints: 0 });
  assert.deepEqual(alertsSupported(mac.deps), { ok: true, reason: null });
});

test("alertsSupported: http and a denied permission each have their own reason", () => {
  assert.deepEqual(alertsSupported(harness({ secure: false }).deps), { ok: false, reason: "insecure" });
  const denied = harness({ notification: fakeNotification({ permission: "denied" }) });
  assert.deepEqual(alertsSupported(denied.deps), { ok: false, reason: "denied" });
});

test("deviceLabel names the device the way the pairing list should read", () => {
  assert.equal(deviceLabel(harness({ ua: UA.iphone, platform: "iPhone" }).deps), "iPhone");
  assert.equal(deviceLabel(harness({ ua: UA.mac, platform: "MacIntel", maxTouchPoints: 5 }).deps), "iPad");
  assert.equal(deviceLabel(harness().deps), "Edge on Windows");
  assert.equal(deviceLabel(harness({ ua: UA.mac, platform: "MacIntel" }).deps), "Safari on macOS");
  assert.equal(deviceLabel(harness({ ua: UA.android, platform: "Linux armv8l" }).deps), "Chrome on Android");
  assert.equal(deviceLabel(harness({ ua: "" }).deps), "This device");
});

/* ─────────────────────────────── the VAPID key ─────────────────────────────── */

test("urlBase64ToUint8Array decodes the real VAPID key to a 65-byte P-256 point", () => {
  assert.equal(VAPID_PUBLIC_KEY, VAPID, "config.js and the built-in fallback are the same key");

  const bytes = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 65, "an uncompressed P-256 public key is 65 bytes");
  assert.equal(bytes[0], 0x04, "…and starts with the uncompressed-point marker");

  // base64url: no padding, `-`/`_` instead of `+`/`/`.
  assert.deepEqual([...urlBase64ToUint8Array("_-8")], [0xff, 0xef]);
  assert.equal(urlBase64ToUint8Array("").length, 0);
});

/* ─────────────────────────────── enableAlerts ─────────────────────────────── */

test("enableAlerts: permission → subscribe → pairing payload, stored and returned", async () => {
  const { deps, notification, serviceWorker, storage } = harness();

  const pairing = await enableAlerts({ settings }, deps);

  assert.equal(notification.requests, 1, "the permission prompt fired once");
  assert.equal(serviceWorker.pushManager.subscribeCalls.length, 1);
  const [options] = serviceWorker.pushManager.subscribeCalls;
  assert.equal(options.userVisibleOnly, true, "iOS refuses silent pushes");
  assert.ok(options.applicationServerKey instanceof Uint8Array);
  assert.equal(options.applicationServerKey.length, 65);
  assert.equal(options.applicationServerKey[0], 0x04);

  assert.deepEqual(Object.keys(pairing), ["v", "sub", "leagueId", "userId", "label", "prefs", "createdAt"]);
  assert.equal(pairing.v, PAIRING_VERSION);
  assert.deepEqual(pairing.sub, serviceWorker.subscription.toJSON());
  assert.equal(pairing.sub.endpoint, "https://web.push.apple.com/QF2c-token");
  assert.equal(pairing.leagueId, settings.leagueId);
  assert.equal(pairing.userId, settings.userId);
  assert.equal(pairing.label, "Edge on Windows", "a readable default label from the UA");
  assert.deepEqual(pairing.prefs, DEFAULT_PREFS);
  assert.match(pairing.createdAt, /^\d{4}-\d\d-\d\dT/);

  // Stored under the key the design names, and readable back.
  assert.deepEqual(JSON.parse(storage.map.get(PUSH_STORAGE_KEY)), pairing);
  assert.deepEqual(storedPairing(deps), pairing);
});

test("enableAlerts: prefs and label override the defaults, viewer mode keeps nulls", async () => {
  const { deps } = harness();

  const pairing = await enableAlerts(
    {
      settings: { alerts: { minDealScore: 3 } }, // saved in Settings…
      prefs: { freeAgents: false, minFaGain: 2 }, // …and overridden by the caller
      label: "  Tom's iPhone  ",
    },
    deps,
  );

  assert.deepEqual(pairing.prefs, {
    // v1.3 (design §12.5) added `advice` and `rivalNews` to the payload; v1.4 (§13.3 B3) added the
    // three noise-control numbers. The schema is additive, so PAIRING_VERSION stays 1 and a device
    // paired before either release keeps working — the job's normalizePrefs fills the gaps.
    advice: true,
    rivalNews: false,
    trades: true,
    deals: true,
    freeAgents: false,
    minDealScore: 3,
    minFaGain: 2,
    dealsCooldownHours: 6,
    faCooldownHours: 6,
    maxDealsPerPush: 1,
  });
  assert.equal(pairing.label, "Tom's iPhone", "trimmed");
  assert.equal(pairing.leagueId, null, "no league configured is a legitimate state");
  assert.equal(pairing.userId, null);
});

test("enableAlerts: the deps may also ride in the options object", async () => {
  const { deps } = harness();
  const pairing = await enableAlerts({ settings, deps });
  assert.equal(pairing.sub.endpoint, "https://web.push.apple.com/QF2c-token");
});

test("enableAlerts: a refused permission throws PushError('denied') and stores nothing", async () => {
  const { deps, notification, serviceWorker, storage } = harness({
    notification: fakeNotification({ permission: "default", grants: "denied" }),
  });

  await assert.rejects(() => enableAlerts({ settings }, deps), (error) => {
    assert.ok(error instanceof PushError);
    assert.equal(error.reason, "denied");
    assert.match(error.message, /blocked/i);
    return true;
  });

  assert.equal(notification.requests, 1);
  assert.equal(serviceWorker.pushManager.subscribeCalls.length, 0, "no subscribe without permission");
  assert.equal(storage.map.size, 0);
  assert.equal(storedPairing(deps), null);
});

test("enableAlerts: an unsupported or uninstalled device never even prompts", async () => {
  const tab = harness({ ua: UA.iphone, platform: "iPhone", maxTouchPoints: 5, standalone: false });
  await assert.rejects(() => enableAlerts({ settings }, tab.deps), (error) => {
    assert.equal(error.reason, "not-installed");
    assert.match(error.message, /Home Screen/);
    return true;
  });
  assert.equal(tab.notification.requests, 0, "no prompt to waste — it cannot succeed");

  const old = harness({ pushManager: false });
  await assert.rejects(() => enableAlerts({ settings }, old.deps), (error) => error.reason === "unsupported");

  const insecure = harness({ secure: false });
  await assert.rejects(() => enableAlerts({ settings }, insecure.deps), (error) => error.reason === "insecure");

  // Already-denied permission is refused up front, without a second prompt.
  const denied = harness({ notification: fakeNotification({ permission: "denied" }) });
  await assert.rejects(() => enableAlerts({ settings }, denied.deps), (error) => error.reason === "denied");
  assert.equal(denied.notification.requests, 0);
});

test("enableAlerts: a subscription left over from an older VAPID key is replaced", async () => {
  const stale = fakeSubscription("https://web.push.apple.com/old-key-token");
  let first = true;
  const serviceWorker = fakeServiceWorker({
    existing: stale,
    subscribe: () => {
      if (first) {
        first = false;
        throw new DOMException("Registration already has a subscription", "InvalidStateError");
      }
      return fakeSubscription("https://web.push.apple.com/new-token");
    },
  });
  const { deps } = harness({ serviceWorker });

  const pairing = await enableAlerts({ settings }, deps);

  assert.equal(stale.unsubscribes, 1, "the old subscription was dropped first");
  assert.equal(serviceWorker.pushManager.subscribeCalls.length, 2);
  assert.equal(pairing.sub.endpoint, "https://web.push.apple.com/new-token");
});

test("enableAlerts: a subscribe that keeps failing is a PushError, not a raw DOMException", async () => {
  const serviceWorker = fakeServiceWorker({
    subscribe: () => {
      throw new DOMException("push service error", "AbortError");
    },
  });
  const { deps } = harness({ serviceWorker });

  await assert.rejects(() => enableAlerts({ settings }, deps), (error) => {
    assert.ok(error instanceof PushError);
    assert.equal(error.reason, "subscribe");
    assert.match(error.message, /push service error/);
    return true;
  });
});

test("enableAlerts: unusable localStorage still returns a pairing to show", async () => {
  const { deps } = harness({ storage: brokenStorage() });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args[0]);
  try {
    const pairing = await enableAlerts({ settings }, deps);
    assert.equal(pairing.sub.endpoint, "https://web.push.apple.com/QF2c-token", "the code is still copyable");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(storedPairing(deps), null, "…it just cannot be remembered");
});

/* ─────────────────────────────── pairing code / prefs ─────────────────────────────── */

test("pairingCode is compact single-line JSON that round-trips", async () => {
  const { deps } = harness();
  const pairing = await enableAlerts({ settings, label: "iPhone" }, deps);

  const code = pairingCode(pairing);
  assert.ok(!/\n/.test(code), "one line — it goes through a copy button and a GitHub form field");
  assert.ok(!/\s{2,}/.test(code), "no pretty-printing");
  assert.deepEqual(JSON.parse(code), pairing);
  // PUSH_SUBSCRIPTIONS holds a JSON array of these payloads (design §11.3).
  assert.deepEqual(JSON.parse(`[${code}]`), [pairing]);

  assert.equal(pairingCode(null), "", "nothing paired, nothing to copy");
});

test("updatePrefs merges into the stored pairing (and the code has to be re-pasted)", async () => {
  const { deps, storage } = harness();
  const pairing = await enableAlerts({ settings }, deps);

  const updated = updatePrefs({ deals: false, minFaGain: 1.5 }, deps);

  assert.deepEqual(updated.prefs, { ...DEFAULT_PREFS, deals: false, minFaGain: 1.5 });
  assert.equal(updated.createdAt, pairing.createdAt, "same pairing, edited");
  assert.deepEqual(updated.sub, pairing.sub);
  assert.deepEqual(JSON.parse(storage.map.get(PUSH_STORAGE_KEY)).prefs, updated.prefs, "persisted");
  // The job reads prefs out of the GitHub secret, so the new code is what has to be pasted.
  assert.notEqual(pairingCode(updated), pairingCode(pairing));

  const unpaired = harness();
  assert.equal(updatePrefs({ deals: false }, unpaired.deps), null);
});

/* ─────────────────────────────── status / disable ─────────────────────────────── */

test("alertsStatus reports what the Settings card needs", async () => {
  const { deps, notification } = harness();

  // `network: false` is the fast local-only probe the card paints with first (design §13.3 B2).
  const before = await alertsStatus({ ...deps, network: false });
  assert.deepEqual(
    { supported: before.supported, reason: before.reason, permission: before.permission, subscribed: before.subscribed, pairing: before.pairing },
    { supported: true, reason: null, permission: "default", subscribed: false, pairing: null },
  );
  assert.equal(before.probed, false, "nothing was asked of the sender");
  assert.equal(before.serverPaired, null, "and so nothing is claimed about it");

  const pairing = await enableAlerts({ settings }, deps);
  const after = await alertsStatus({ ...deps, network: false });
  assert.equal(after.permission, "granted");
  assert.equal(notification.permission, "granted");
  assert.equal(after.subscribed, true);
  assert.deepEqual(after.pairing, pairing);
});

test("alertsStatus: a live subscription beats a stale stored pairing", async () => {
  const { deps } = harness();
  await enableAlerts({ settings }, deps);

  // The OS dropped the subscription behind the app's back: the pairing is still on disk.
  const dropped = harness({
    serviceWorker: fakeServiceWorker(),
    notification: fakeNotification({ permission: "granted" }),
    storage: fakeStorage({ [PUSH_STORAGE_KEY]: JSON.stringify(storedPairing(deps)) }),
  });
  const status = await alertsStatus(dropped.deps);
  assert.equal(status.subscribed, false, "the truth comes from pushManager, not localStorage");
  assert.ok(status.pairing, "…but the pairing code is still there to re-paste");
});

test("alertsStatus on a browser that cannot do any of this never throws", async () => {
  const bare = harness({ hasServiceWorker: false, hasNotification: false, pushManager: false });
  const status = await alertsStatus(bare.deps);
  assert.deepEqual(
    { supported: status.supported, reason: status.reason, permission: status.permission, subscribed: status.subscribed, pairing: status.pairing },
    { supported: false, reason: "unsupported", permission: "unsupported", subscribed: false, pairing: null },
  );
  // Every diagnostic answer is "we could not check" rather than a verdict pulled from nowhere.
  assert.equal(status.deviceId, null);
  assert.equal(status.serverPaired, null);
  assert.equal(status.endpointChanged, false);
  assert.equal(status.receipts.source, null);
});

test("disableAlerts unsubscribes and clears the pairing", async () => {
  const { deps, serviceWorker, storage } = harness();
  await enableAlerts({ settings }, deps);
  const sub = serviceWorker.subscription;

  const result = await disableAlerts(deps);

  assert.deepEqual(result, { unsubscribed: true, cleared: true });
  assert.equal(sub.unsubscribes, 1);
  assert.equal(storage.map.has(PUSH_STORAGE_KEY), false);
  assert.equal(storedPairing(deps), null);
  assert.equal((await alertsStatus(deps)).subscribed, false);
});

test("disableAlerts with nothing subscribed still clears, and never throws", async () => {
  const { deps } = harness();
  assert.deepEqual(await disableAlerts(deps), { unsubscribed: false, cleared: true });

  const bare = harness({ hasServiceWorker: false });
  assert.deepEqual(await disableAlerts(bare.deps), { unsubscribed: false, cleared: true });
});

test("a service worker that never becomes ready cannot hang the app", async () => {
  // Safari sometimes leaves `serviceWorker.ready` pending forever; the button must not spin
  // forever with it.
  const never = fakeServiceWorker({ ready: new Promise(() => {}) });
  const { deps: base } = harness({ serviceWorker: never });
  const deps = { ...base, swReadyTimeoutMs: 1 };

  const error = await enableAlerts({ settings }, deps).catch((thrown) => thrown);
  assert.ok(error instanceof PushError);
  assert.equal(error.reason, "unsupported");
  assert.match(error.message, /service worker is not ready/);
  assert.equal(never.pushManager.subscribeCalls.length, 0);

  const status = await alertsStatus(deps);
  assert.equal(status.subscribed, false, "no pairing stored, so the honest answer is 'no'");
  assert.deepEqual(await disableAlerts(deps), { unsubscribed: false, cleared: true });
});

/* ───────────────── diagnostics: device id, server view, receipts (design §13.3 B2) ───────────────── */

/** The shared test vector. pipeline/alerts.mjs asserts the SAME endpoint → the SAME id. */
const SHARED_ENDPOINT = "https://web.push.apple.com/QF2c-token";
const SHARED_DEVICE_ID = "ee64af5d15e243bb";

/** A `fetch` that answers a fixed map of URLs; anything else rejects like a network error. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const answer = routes[url] ?? routes[Object.keys(routes).find((k) => String(url).startsWith(k))];
    if (answer === undefined) throw new TypeError("network error");
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.ok !== false,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  };
  impl.calls = calls;
  return impl;
}

/** A service worker controller that answers `push-receipts` on the MessageChannel port. */
function fakeController(reply) {
  const posts = [];
  return {
    posts,
    postMessage(message, transfer) {
      posts.push(message);
      const port = transfer && transfer[0];
      if (!port || reply === undefined) return;
      queueMicrotask(() => port.onmessage({ data: reply }));
    },
  };
}

/** The MessageChannel stand-in: port2 is handed to the worker, port1 keeps the handler. */
function FakeMessageChannel() {
  const port1 = { onmessage: null };
  const port2 = {
    postMessage: (data) => {
      if (typeof port1.onmessage === "function") port1.onmessage({ data });
    },
  };
  // The fake controller calls `port.onmessage(...)` directly on what it is handed.
  port2.onmessage = (event) => {
    if (typeof port1.onmessage === "function") port1.onmessage(event);
  };
  this.port1 = port1;
  this.port2 = port2;
}

const STATE_URL = "./data/alerts-state.json";
const RUNS_URL =
  "https://api.github.com/repos/tom-bentley/tradewinds/actions/workflows/alerts.yml/runs?per_page=1";

/** The committed state file, trimmed to the two fields the phone reads. */
const serverState = (deviceId, entry) => ({
  ok: true,
  body: { v: 1, leagues: {}, devices: { [deviceId]: entry } },
});

const runsBody = (at) => ({
  ok: true,
  body: { workflow_runs: [{ run_started_at: at, conclusion: "success", html_url: "https://github.com/x/y/actions/runs/1" }] },
});

/** A harness whose deps also carry the diagnostics plumbing. */
function diagnosticHarness({ state, runs, receiptsReply, ...rest } = {}) {
  const h = harness({
    notification: fakeNotification({ permission: "granted" }),
    storage: fakeStorage(),
    ...rest,
  });
  const fetchImpl = fakeFetch({
    ...(state === undefined ? {} : { [STATE_URL]: state }),
    ...(runs === undefined ? {} : { [RUNS_URL]: runs }),
  });
  h.win.crypto = webcrypto;
  h.win.MessageChannel = FakeMessageChannel;
  h.navigator.serviceWorker.controller = fakeController(receiptsReply);
  h.deps = { win: h.win, fetchImpl, subtle: webcrypto.subtle, probeTtlMs: 0, receiptsTimeoutMs: 50 };
  h.fetchImpl = fetchImpl;
  return h;
}

test("deviceIdOf matches the alerts job byte for byte (shared vector)", async () => {
  const deps = { subtle: webcrypto.subtle };
  assert.equal(await deviceIdOf(SHARED_ENDPOINT, deps), SHARED_DEVICE_ID);
  assert.equal((await deviceIdOf(SHARED_ENDPOINT, deps)).length, 16);
  assert.equal(await deviceIdOf("https://web.push.apple.com/QF2c-old", deps), "9131f5dc3c5f376c");
  assert.equal(await deviceIdOf("", deps), null, "no endpoint, no id");
  assert.equal(await deviceIdOf(null, deps), null);
  assert.equal(await deviceIdOf(SHARED_ENDPOINT, { subtle: null }), null, "no WebCrypto, no guess");
});

test("alertsStatus: paired on the server, receipts arriving → everything green", async () => {
  clearProbeCache();
  const h = diagnosticHarness({
    state: serverState(SHARED_DEVICE_ID, {
      seenDeals: [],
      seenFa: [],
      lastNotifiedAt: "2026-09-17T12:11:48Z",
      lastSentAt: "2026-09-17T12:11:48Z",
      sentCount: 80,
      lastResult: { status: 201, at: "2026-09-17T12:11:48Z" },
    }),
    runs: runsBody("2026-09-17T12:11:00Z"),
    receiptsReply: {
      type: "push-receipts",
      receipts: [{ at: Date.parse("2026-09-17T12:11:50Z"), title: "New deal", tag: "deals", kind: "deals", shown: true }],
      subscriptionChange: null,
    },
  });
  await enableAlerts({ settings }, h.deps);

  const status = await alertsStatus(h.deps);

  assert.equal(status.deviceId, SHARED_DEVICE_ID);
  assert.equal(status.serverPaired, true);
  assert.equal(status.endpointChanged, false);
  assert.equal(status.server.sentCount, 80);
  assert.deepEqual(status.server.lastResult, { status: 201, at: "2026-09-17T12:11:48Z" });
  assert.equal(status.lastRunAt, "2026-09-17T12:11:00Z");
  assert.equal(status.receipts.source, "sw");
  assert.equal(status.receipts.count, 1);
  assert.equal(status.receipts.lastShown, true);
  assert.equal(status.probed, true);
  // The state file must never be served from the app's own cache, or "paired" is a fossil.
  const stateCall = h.fetchImpl.calls.find((c) => c.url === STATE_URL);
  assert.equal(stateCall.init.cache, "no-store");
});

test("alertsStatus: the sender does not know this device → serverPaired false", async () => {
  clearProbeCache();
  const h = diagnosticHarness({
    state: serverState("0000000000000000", { seenDeals: [], seenFa: [], lastNotifiedAt: null }),
    receiptsReply: { type: "push-receipts", receipts: [], subscriptionChange: null },
  });
  await enableAlerts({ settings }, h.deps);

  const status = await alertsStatus(h.deps);
  assert.equal(status.serverPaired, false, "this is the re-pair case");
  assert.equal(status.server, null);
});

test("alertsStatus: an unreachable state file says null, never false", async () => {
  // The difference matters: false accuses the pairing, null admits we could not look.
  clearProbeCache();
  const h = diagnosticHarness({ receiptsReply: { type: "push-receipts", receipts: [], subscriptionChange: null } });
  await enableAlerts({ settings }, h.deps);

  const status = await alertsStatus(h.deps);
  assert.equal(status.serverPaired, null);
  assert.equal(status.lastRunAt, null, "the Actions API is optional too");
});

test("alertsStatus: a rotated endpoint is caught by comparing ids", async () => {
  clearProbeCache();
  const rotated = fakeSubscription("https://web.push.apple.com/QF2c-ROTATED");
  const h = diagnosticHarness({
    state: serverState(SHARED_DEVICE_ID, { seenDeals: [], seenFa: [], lastNotifiedAt: "2026-09-17T12:11:48Z", lastSentAt: "2026-09-17T12:11:48Z", sentCount: 80 }),
    receiptsReply: { type: "push-receipts", receipts: [], subscriptionChange: { at: Date.parse("2026-09-14T03:00:00Z"), oldEndpointHash: SHARED_DEVICE_ID } },
  });
  await enableAlerts({ settings }, h.deps); // pairs the original endpoint…
  h.serviceWorker.registration.pushManager.getSubscription = async () => rotated; // …then iOS moves it

  const status = await alertsStatus(h.deps);
  assert.equal(status.pairedDeviceId, SHARED_DEVICE_ID);
  assert.notEqual(status.deviceId, SHARED_DEVICE_ID);
  assert.equal(status.endpointChanged, true, "the GitHub secret is pointing at a dead address");
  assert.equal(status.serverPaired, false, "…and the id the job knows is not this one");
});

test("pushReceipts falls back to the worker's IndexedDB when it does not answer", async () => {
  clearProbeCache();
  const idb = makeMemoryIndexedDb();
  // Seed the log the way sw.js writes it.
  await new Promise((resolve) => {
    const open = idb.open("tradewinds-sw", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pushes", { keyPath: "seq", autoIncrement: true });
    open.onsuccess = () => {
      const store = open.result.transaction("pushes", "readwrite").objectStore("pushes");
      store.add({ at: 1, title: "older", kind: "fa", shown: true });
      const last = store.add({ at: Date.now(), title: "newest", kind: "advice", shown: false });
      last.onsuccess = () => resolve();
    };
  });

  const h = diagnosticHarness({ receiptsReply: undefined }); // the worker never replies
  const receipts = await pushReceipts({ ...h.deps, indexedDB: idb });

  assert.equal(receipts.source, "idb");
  assert.equal(receipts.count, 2);
  assert.equal(receipts.items[0].title, "newest", "newest first");
  assert.equal(receipts.failed, 1);
  assert.equal(receipts.lastShown, false);
});

test("pushReceipts reports nothing readable rather than nothing received", async () => {
  clearProbeCache();
  const h = diagnosticHarness({ receiptsReply: undefined });
  const receipts = await pushReceipts({ ...h.deps, indexedDB: null });
  assert.equal(receipts.source, null, "no evidence either way");
  assert.equal(receipts.count, 0);
  assert.equal(receipts.lastShown, null);
});

test("pushReceipts counts only the last 24 hours for count24h", async () => {
  clearProbeCache();
  const now = Date.parse("2026-09-17T12:00:00Z");
  const h = diagnosticHarness({
    receiptsReply: {
      type: "push-receipts",
      receipts: [
        { at: now - 3600_000, title: "an hour ago", shown: true },
        { at: now - 40 * 3600_000, title: "nearly two days ago", shown: true },
      ],
      subscriptionChange: null,
    },
  });
  const receipts = await pushReceipts({ ...h.deps, now: () => now });
  assert.equal(receipts.count, 2);
  assert.equal(receipts.count24h, 1);
});

test("testNotification raises one locally and reports why when it cannot", async () => {
  const shown = [];
  const granted = harness({ notification: fakeNotification({ permission: "granted" }) });
  granted.serviceWorker.registration.showNotification = async (title, options) => shown.push({ title, options });
  assert.deepEqual(await testNotification({}, granted.deps), { ok: true });
  assert.equal(shown[0].title, "Tradewinds test");
  assert.equal(shown[0].options.tag, "test-local");

  const denied = harness({ notification: fakeNotification({ permission: "denied" }) });
  assert.deepEqual(await testNotification({}, denied.deps), { ok: false, reason: "denied" });

  const refused = harness({ notification: fakeNotification({ permission: "granted" }) });
  refused.serviceWorker.registration.showNotification = async () => {
    throw new Error("nope");
  };
  assert.deepEqual(await testNotification({}, refused.deps), { ok: false, reason: "nope" });
});

test("the server/Actions probes are cached so a repaint is not a request storm", async () => {
  clearProbeCache();
  const h = diagnosticHarness({
    state: serverState(SHARED_DEVICE_ID, { seenDeals: [], seenFa: [], lastNotifiedAt: null }),
    runs: runsBody("2026-09-17T12:11:00Z"),
    receiptsReply: { type: "push-receipts", receipts: [], subscriptionChange: null },
  });
  h.deps.probeTtlMs = 60_000;
  await enableAlerts({ settings }, h.deps);

  await alertsStatus(h.deps);
  await alertsStatus(h.deps);
  await alertsStatus(h.deps);

  assert.equal(h.fetchImpl.calls.filter((c) => c.url === STATE_URL).length, 1, "one state read for three paints");
  assert.equal(h.fetchImpl.calls.filter((c) => c.url === RUNS_URL).length, 1);
  clearProbeCache();
  await alertsStatus(h.deps);
  assert.equal(h.fetchImpl.calls.filter((c) => c.url === STATE_URL).length, 2, "…until the sheet asks again");
});

/* ───────────── B5: this phone re-pairs itself (design §13.3) ───────────── */

test("pairingBlob seals the payload so only VAPID_PRIVATE_KEY can read it", async () => {
  // The job's own `decryptPairingBlob` opens it — that round trip is asserted in
  // test/pipeline.alerts.test.mjs. Here: the envelope is well formed and leaks nothing.
  const { deps } = harness();
  const pairing = { v: 1, sub: { endpoint: "https://web.push.apple.com/QF2c-token", keys: { p256dh: "BM9", auth: "aUtH" } }, leagueId: "1", userId: "2", label: "iPhone" };

  const blob = await pairingBlob(pairing, { ...deps, subtle: webcrypto.subtle, randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) });

  assert.match(blob, /^[A-Za-z0-9_-]+$/, "base64url, safe in a JSON body and a URL");
  const envelope = JSON.parse(Buffer.from(blob, "base64url").toString("utf8"));
  assert.equal(envelope.v, 1);
  assert.equal(Buffer.from(envelope.epk, "base64url").length, 65, "an uncompressed P-256 point");
  assert.equal(Buffer.from(envelope.epk, "base64url")[0], 4);
  assert.equal(Buffer.from(envelope.salt, "base64url").length, 16);
  assert.equal(Buffer.from(envelope.iv, "base64url").length, 12);
  assert.ok(!blob.includes("web.push"), "the endpoint never travels in the clear");
  assert.ok(!Buffer.from(blob, "base64url").toString("utf8").includes("aUtH"));

  // Two seals of the same payload differ: fresh ephemeral key, fresh salt, fresh iv.
  const again = await pairingBlob(pairing, { ...deps, subtle: webcrypto.subtle, randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) });
  assert.notEqual(blob, again);

  await assert.rejects(pairingBlob(pairing, { ...deps, subtle: null }), /cannot encrypt/);
});

test("the GitHub token lives on this phone, masked, and can be removed", () => {
  const { deps, storage } = harness();
  assert.equal(storedToken(deps), "");
  assert.equal(saveToken("github_pat_11ABCDEFG0aaaaaaaaaaaa_ZZZZ", deps), true);
  assert.equal(storage.map.get(GITHUB_TOKEN_KEY), "github_pat_11ABCDEFG0aaaaaaaaaaaa_ZZZZ");
  assert.equal(storedToken(deps), "github_pat_11ABCDEFG0aaaaaaaaaaaa_ZZZZ");
  assert.equal(maskToken(storedToken(deps)), "github_p…ZZZZ", "never rendered in full");
  assert.equal(maskToken("short"), "sh…rt");
  assert.equal(maskToken(""), "");
  saveToken("", deps);
  assert.equal(storedToken(deps), "");
  // Safari private mode: storage throws, and nothing above does.
  const broken = harness({ storage: brokenStorage() });
  assert.equal(storedToken(broken.deps), "");
  assert.equal(saveToken("x", broken.deps), false);
});

test("sendPairing posts a repository_dispatch and turns every failure into words", async () => {
  const calls = [];
  const respond = (status) => async (url, init) => {
    calls.push({ url, init });
    return { status };
  };

  const ok = diagnosticHarness();
  await enableAlerts({ settings }, ok.deps);
  saveToken("github_pat_TOKEN", ok.deps);
  const sent = await sendPairing({}, { ...ok.deps, fetchImpl: respond(204) });

  assert.equal(sent.ok, true);
  assert.equal(sent.deviceId, SHARED_DEVICE_ID);
  assert.equal(calls[0].url, "https://api.github.com/repos/tom-bentley/tradewinds/dispatches");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer github_pat_TOKEN");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.event_type, "pair");
  assert.equal(body.client_payload.deviceId, SHARED_DEVICE_ID);
  assert.equal(body.client_payload.label, "Edge on Windows");
  assert.ok(body.client_payload.blob.length > 100);
  assert.ok(!calls[0].init.body.includes("web.push.apple.com"), "the dispatch body carries ciphertext only");

  for (const [status, pattern] of [[401, /rejected the token/], [403, /Actions: read and write/], [404, /could not find the repository/]]) {
    const failed = await sendPairing({}, { ...ok.deps, fetchImpl: respond(status) });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, pattern);
  }

  const noToken = harness({ storage: fakeStorage() });
  assert.match((await sendPairing({}, noToken.deps)).reason, /Nothing is paired/);
});

test("dispatchToGithub is how the phone asks for a test push without leaving the app", async () => {
  const calls = [];
  const h = harness();
  saveToken("github_pat_TOKEN", h.deps);
  const result = await dispatchToGithub(
    { event: "alerts", payload: { test: true } },
    {
      ...h.deps,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { status: 204 };
      },
    },
  );
  assert.deepEqual(result, { ok: true, status: 204 });
  assert.deepEqual(JSON.parse(calls[0].init.body), { event_type: "alerts", client_payload: { test: true } });

  const noToken = harness({ storage: fakeStorage() });
  assert.match((await dispatchToGithub({}, noToken.deps)).reason, /No GitHub token/);
});

test("ensureSubscription re-creates a subscription iOS threw away, with no user gesture", async () => {
  // iOS does not reliably fire pushsubscriptionchange and subscriptions carry no expiry (research
  // R5 §6.2), so the subscription can be gone with no event at all. Permission is already granted,
  // which is what makes a silent re-subscribe legal.
  const { deps, serviceWorker, storage } = harness({ notification: fakeNotification({ permission: "granted" }) });
  const pairing = await enableAlerts({ settings }, deps);
  await serviceWorker.subscription.unsubscribe(); // the OS drops it behind the app's back

  const healed = await ensureSubscription(deps);

  assert.equal(healed.resubscribed, true);
  assert.equal(healed.rotated, true);
  assert.ok(healed.subscription);
  assert.equal(serviceWorker.pushManager.subscribeCalls.length, 2);
  assert.equal(healed.pairing.leagueId, pairing.leagueId, "the same pairing, a new subscription");
  assert.deepEqual(JSON.parse(storage.map.get(PUSH_STORAGE_KEY)).sub, healed.pairing.sub, "…and it is what Show pairing code now shows");
});

test("ensureSubscription rewrites the stored pairing when the address merely rotated", async () => {
  const { deps, serviceWorker, storage } = harness({ notification: fakeNotification({ permission: "granted" }) });
  await enableAlerts({ settings }, deps);
  const rotated = fakeSubscription("https://web.push.apple.com/QF2c-ROTATED");
  serviceWorker.registration.pushManager.getSubscription = async () => rotated;

  const healed = await ensureSubscription(deps);

  assert.equal(healed.resubscribed, false, "there was nothing to re-create");
  assert.equal(healed.rotated, true, "…but the sender is holding the wrong address");
  assert.equal(JSON.parse(storage.map.get(PUSH_STORAGE_KEY)).sub.endpoint, "https://web.push.apple.com/QF2c-ROTATED");
});

test("ensureSubscription does nothing it is not entitled to do", async () => {
  // Nothing paired → no silent subscribe (that would be a permission prompt out of nowhere).
  const fresh = harness({ notification: fakeNotification({ permission: "granted" }) });
  const none = await ensureSubscription(fresh.deps);
  assert.deepEqual([none.resubscribed, none.rotated, none.pairing], [false, false, null]);
  assert.equal(fresh.serviceWorker.pushManager.subscribeCalls.length, 0);

  // Paired but permission revoked → say so, do not try.
  const granted = harness({ notification: fakeNotification({ permission: "granted" }) });
  await enableAlerts({ settings }, granted.deps);
  const stored = storedPairing(granted.deps);
  const revoked = harness({
    notification: fakeNotification({ permission: "denied" }),
    storage: fakeStorage({ [PUSH_STORAGE_KEY]: JSON.stringify(stored) }),
  });
  const blocked = await ensureSubscription(revoked.deps);
  assert.equal(blocked.error, "permission");
  assert.equal(revoked.serviceWorker.pushManager.subscribeCalls.length, 0);

  // A subscribe that rejects is reported, never thrown.
  const failing = harness({
    notification: fakeNotification({ permission: "granted" }),
    storage: fakeStorage({ [PUSH_STORAGE_KEY]: JSON.stringify(stored) }),
    serviceWorker: fakeServiceWorker({
      subscribe: () => {
        throw new Error("subscription refused");
      },
    }),
  });
  const failed = await ensureSubscription(failing.deps);
  assert.equal(failed.resubscribed, false);
  assert.match(failed.error, /subscription refused/);
});
