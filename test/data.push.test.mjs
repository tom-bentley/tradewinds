// Client-side Web Push (design §11.4), exercised against fake browser APIs. Named `data.push`
// so it stays inside the data-layer agent's `test/data.*.test.mjs` file pattern.
//
// Nothing here touches a global: `src/push.js` takes `{ win, notification, serviceWorker,
// storage }` and falls back to the real browser objects only when they are not injected.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_REASON_TEXT,
  DEFAULT_PREFS,
  PAIRING_VERSION,
  PUSH_STORAGE_KEY,
  PushError,
  VAPID_PUBLIC_KEY,
  alertsStatus,
  alertsSupported,
  deviceLabel,
  disableAlerts,
  enableAlerts,
  pairingCode,
  reasonText,
  storedPairing,
  updatePrefs,
  urlBase64ToUint8Array,
} from "../src/push.js";

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
    // v1.3 (design §12.5) added `advice` and `rivalNews` to the payload; the schema is additive,
    // so PAIRING_VERSION stays 1 and a device paired before them keeps working.
    advice: true,
    rivalNews: false,
    trades: true,
    deals: true,
    freeAgents: false,
    minDealScore: 3,
    minFaGain: 2,
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

  const before = await alertsStatus(deps);
  assert.deepEqual(before, {
    supported: true,
    reason: null,
    permission: "default",
    subscribed: false,
    pairing: null,
  });

  const pairing = await enableAlerts({ settings }, deps);
  const after = await alertsStatus(deps);
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
  assert.deepEqual(await alertsStatus(bare.deps), {
    supported: false,
    reason: "unsupported",
    permission: "unsupported",
    subscribed: false,
    pairing: null,
  });
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
