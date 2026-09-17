// Service-worker behaviour, exercised in a fake ServiceWorkerGlobalScope (node:vm). Named
// `data.sw` so it stays inside the data-layer agent's `test/data.*.test.mjs` file pattern.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import { makeMemoryIndexedDb } from "./shims/indexeddb-shim.mjs";

const SCOPE = "https://tom-bentley.github.io/tradewinds/";
const SW_SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const CACHE_NAME = SW_SOURCE.match(/^const CACHE = "([^"]+)";/m)[1]; // versioned with APP_VERSION
const PRECACHE = SW_SOURCE.match(/^const PRECACHE = \[([\s\S]*?)\];$/m)[1].match(/"[^"]+"/g).map(
  (entry) => JSON.parse(entry),
);

class FakeResponse {
  constructor(body = "", init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.type = init.type ?? "basic";
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  clone() {
    return new FakeResponse(this.body, { status: this.status, type: this.type });
  }
}

class FakeRequest {
  constructor(input, init = {}) {
    this.url = typeof input === "string" ? new URL(input, SCOPE).href : input.url;
    this.method = init.method ?? input?.method ?? "GET";
    this.mode = init.mode ?? input?.mode ?? "cors";
    this.cache = init.cache ?? input?.cache;
  }
}

const stripSearch = (url) => url.split("?")[0];

class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  async add(request) {
    const response = await this.fetchImpl(request);
    if (!response || !response.ok) throw new TypeError("cache.add failed");
    this.entries.set(request.url, response);
  }
  async put(request, response) {
    if (!response.ok) throw new TypeError("cache.put needs an ok response");
    this.entries.set(request.url ?? String(request), response);
  }
  async match(request, options = {}) {
    const url = request.url ?? new URL(String(request), SCOPE).href;
    if (this.entries.has(url)) return this.entries.get(url);
    if (!options.ignoreSearch) return undefined;
    for (const [key, value] of this.entries) if (stripSearch(key) === stripSearch(url)) return value;
    return undefined;
  }
}

/** Boot sw.js inside a fake global scope and return the handles a test needs. */
function bootServiceWorker({
  network,
  cacheNames = [],
  hasActiveWorker = false,
  windows = [SCOPE],
  indexedDB = makeMemoryIndexedDb(),
  /** Make `showNotification` reject, the failure mode the receipt log exists to catch. */
  showNotificationFails = 0,
  /** `pushManager.subscribe` behaviour for the pushsubscriptionchange tests. */
  subscribeImpl,
} = {}) {
  const cacheStorage = new Map();
  for (const name of cacheNames) cacheStorage.set(name, new FakeCache());

  const fetchCalls = [];
  const fetchImpl = async (request) => {
    const url = request.url ?? String(request);
    fetchCalls.push(url);
    const respond = network?.(url);
    if (respond === undefined) throw new TypeError(`fetch failed: ${url}`);
    return respond;
  };

  const listeners = new Map();
  const posted = [];
  const state = { skipWaiting: 0, claimed: 0, fetchCalls };

  const caches = {
    async open(name) {
      if (!cacheStorage.has(name)) cacheStorage.set(name, new FakeCache());
      const cache = cacheStorage.get(name);
      cache.fetchImpl = fetchImpl;
      return cache;
    },
    async keys() {
      return [...cacheStorage.keys()];
    },
    async delete(name) {
      return cacheStorage.delete(name);
    },
    async match(request, options) {
      for (const cache of cacheStorage.values()) {
        const hit = await cache.match(request, options);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  /** An open page: `url` decides whether the worker treats it as one of ours. */
  const makeClient = (url) => {
    const client = {
      url,
      focused: 0,
      messages: [],
      async focus() {
        client.focused += 1;
        return client;
      },
      postMessage(data) {
        client.messages.push(data);
        posted.push(data);
      },
    };
    return client;
  };
  const clients = windows.map(makeClient);
  const notifications = [];
  const opened = [];

  let showFailures = showNotificationFails;
  const subscribeCalls = [];
  const self = {
    location: new URL(`${SCOPE}sw.js`),
    indexedDB,
    crypto: webcrypto,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    registration: {
      active: hasActiveWorker ? { state: "activated" } : null,
      scope: SCOPE,
      pushManager: {
        async subscribe(options) {
          subscribeCalls.push(options);
          if (subscribeImpl) return subscribeImpl(options);
          return {
            endpoint: `${SCOPE.replace("tom-bentley.github.io/tradewinds/", "")}web.push.apple.com/new-endpoint`,
            toJSON: () => ({
              endpoint: "https://web.push.apple.com/new-endpoint",
              keys: { p256dh: "BM9-new", auth: "aUtH-new" },
            }),
          };
        },
      },
      async showNotification(title, options) {
        if (showFailures > 0) {
          showFailures -= 1;
          throw new Error("notification refused by the platform");
        }
        notifications.push({ title, options });
      },
    },
    skipWaiting: () => {
      state.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        state.claimed += 1;
      },
      matchAll: async () => clients,
      openWindow: async (url) => {
        opened.push(url);
        return makeClient(url);
      },
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
  };

  const sandbox = {
    self,
    caches,
    fetch: fetchImpl,
    Request: FakeRequest,
    Response: FakeResponse,
    URL,
    console,
    // Worker globals the receipt log and the re-subscribe path use. They are not JS intrinsics,
    // so a vm context does not get them for free.
    TextEncoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(SW_SOURCE, vm.createContext(sandbox));

  const dispatch = async (type, event) => {
    const waits = [];
    const responses = [];
    const wrapped = {
      ...event,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => responses.push(promise),
    };
    for (const handler of listeners.get(type) ?? []) handler(wrapped);
    await Promise.all(waits);
    return responses.length ? await responses[0].catch((error) => error) : undefined;
  };

  /** Read the receipt log the way the page will: straight out of the fake IndexedDB. */
  const readStore = (name) => {
    const db = indexedDB.databases.get("tradewinds-sw");
    if (!db || !db.stores.has(name)) return [];
    return [...db.stores.get(name).rows.values()];
  };

  return {
    dispatch,
    caches,
    cacheStorage,
    posted,
    state,
    fetchCalls,
    clients,
    notifications,
    opened,
    indexedDB,
    subscribeCalls,
    receipts: () => readStore("pushes"),
    subscriptionRecord: () => readStore("subscription")[0] ?? null,
  };
}

/** A PushEvent payload: JSON when it parses, plain text when it does not. */
const pushData = (body) => ({
  json: () => JSON.parse(body),
  text: () => body,
});

/** Messages are minted inside the vm context (foreign prototype), so compare by field. */
const messagesOf = (client) => client.messages.map((message) => ({ type: message.type, url: message.url }));

/** The notification the OS hands back on a tap. */
const clickedNotification = (data) => {
  const notification = { data, closed: 0, close: () => (notification.closed += 1) };
  return notification;
};

/** Everything in the shell resolves except the two files listed as missing. */
const shellNetwork = (missing = []) => (url) =>
  missing.some((name) => url.endsWith(name)) ? new FakeResponse("", { status: 404 }) : new FakeResponse(`body:${url}`);

test("install precaches the shell and survives files that do not exist yet", async () => {
  const sw = bootServiceWorker({ network: shellNetwork(["ui/deals.js", "icons/icon-512.png"]) });

  await sw.dispatch("install", {});

  const cache = sw.cacheStorage.get(CACHE_NAME);
  assert.ok(cache, "the versioned cache was created");
  assert.ok(cache.entries.has(`${SCOPE}index.html`), "index.html precached");
  assert.ok(cache.entries.has(`${SCOPE}src/data.js`), "modules precached");
  assert.ok(cache.entries.has(`${SCOPE}icons/apple-touch-icon.png`));
  assert.ok(!cache.entries.has(`${SCOPE}src/ui/deals.js`), "a 404 is skipped, not fatal");
  assert.equal(cache.entries.size, PRECACHE.length - 2, "every other shell file landed");
});

test("the shell list covers every module the app boots with, onboarding included", () => {
  // setup.js is loaded on a cold start with no league saved — if it is not precached, the very
  // first offline launch of a fresh install has nothing to show.
  for (const asset of ["./index.html", "./src/data.js", "./src/ui/setup.js", "./src/ui/app.js"]) {
    assert.ok(PRECACHE.includes(asset), `${asset} must be precached`);
  }
  assert.equal(new Set(PRECACHE).size, PRECACHE.length, "no duplicate shell entries");
});

test("a first install stays quiet; an update tells the open tabs", async () => {
  const first = bootServiceWorker({ network: shellNetwork() });
  await first.dispatch("install", {});
  assert.deepEqual(first.posted, []);

  const update = bootServiceWorker({ network: shellNetwork(), hasActiveWorker: true });
  await update.dispatch("install", {});
  // The message object is minted inside the vm context, so compare structurally by field.
  assert.deepEqual(update.posted.map((message) => message.type), ["update-available"]);
  assert.equal(update.posted.length, 1);
  assert.equal(update.state.skipWaiting, 0, "the user decides when to reload");
});

test("activate drops old Tradewinds caches, keeps foreign ones, and claims clients", async () => {
  const sw = bootServiceWorker({ cacheNames: ["tradewinds-v0", CACHE_NAME, "some-other-app"] });

  await sw.dispatch("activate", {});

  assert.deepEqual(await sw.caches.keys(), [CACHE_NAME, "some-other-app"]);
  assert.equal(sw.state.claimed, 1);
});

test("SKIP_WAITING is the only message that acts", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch("message", { data: { type: "something-else" } });
  assert.equal(sw.state.skipWaiting, 0);
  await sw.dispatch("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(sw.state.skipWaiting, 1);
});

test("cross-origin API calls and non-GET requests are never intercepted", async () => {
  const sw = bootServiceWorker({ network: () => new FakeResponse("live") });

  const sleeper = await sw.dispatch("fetch", {
    request: new FakeRequest("https://api.sleeper.app/v1/league/1?cb=1"),
  });
  const fantasycalc = await sw.dispatch("fetch", {
    request: new FakeRequest("https://api.fantasycalc.com/values/current?isDynasty=false"),
  });
  const post = await sw.dispatch("fetch", { request: new FakeRequest(`${SCOPE}index.html`, { method: "POST" }) });

  assert.equal(sleeper, undefined, "respondWith was not called — the network handles it");
  assert.equal(fantasycalc, undefined);
  assert.equal(post, undefined);
  assert.deepEqual(sw.fetchCalls, [], "the worker did not even touch the network itself");
});

test("data/*.json is network-first and falls back to the cached copy offline", async () => {
  const sw = bootServiceWorker({ network: () => new FakeResponse("fresh-values") });
  const request = new FakeRequest(`${SCOPE}data/values.json`);

  const online = await sw.dispatch("fetch", { request });
  assert.equal(online.body, "fresh-values");
  assert.equal((await sw.cacheStorage.get(CACHE_NAME).match(request)).body, "fresh-values", "cached for later");

  const offline = bootServiceWorker({ network: () => undefined });
  const cache = await offline.caches.open(CACHE_NAME);
  await cache.put(request, new FakeResponse("last-good-values"));
  const cached = await offline.dispatch("fetch", { request });
  assert.equal(cached.body, "last-good-values");
});

test("shell assets are served from cache and refreshed in the background", async () => {
  const sw = bootServiceWorker({ network: () => new FakeResponse("v2-styles") });
  const request = new FakeRequest(`${SCOPE}styles.css`);
  const cache = await sw.caches.open(CACHE_NAME);
  await cache.put(request, new FakeResponse("v1-styles"));

  const served = await sw.dispatch("fetch", { request });
  assert.equal(served.body, "v1-styles", "instant paint from cache");
  await new Promise((resolve) => setImmediate(resolve)); // let the revalidation settle
  assert.equal((await cache.match(request)).body, "v2-styles", "cache refreshed behind the scenes");
});

test("an uncached asset offline resolves to a 504 rather than a hard rejection", async () => {
  const sw = bootServiceWorker({ network: () => undefined });
  const response = await sw.dispatch("fetch", { request: new FakeRequest(`${SCOPE}src/ui/app.js`) });
  assert.equal(response.status, 504);
});

test("a navigation offline opens the cached app shell", async () => {
  const sw = bootServiceWorker({ network: () => undefined });
  const cache = await sw.caches.open(CACHE_NAME);
  await cache.put(new FakeRequest(`${SCOPE}index.html`), new FakeResponse("<!doctype html>shell"));

  const response = await sw.dispatch("fetch", {
    request: new FakeRequest(`${SCOPE}?tab=deals`, { mode: "navigate" }),
  });
  assert.equal(response.body, "<!doctype html>shell");
});

/* ─────────────────────────── push + notificationclick (design §11.4) ─────────────────────────── */

test("push.js is part of the precached shell", () => {
  assert.ok(PRECACHE.includes("./src/push.js"), "the alerts module must work offline like the rest");
});

test("a push shows the notification the alerts job composed", async () => {
  const sw = bootServiceWorker();

  await sw.dispatch("push", {
    data: pushData(
      JSON.stringify({
        title: "Trade: hobbezilla ⇄ speckledorf",
        body: "hobbezilla gets Gibbs · speckledorf gets Nabers · hobbezilla +12 % / +2.1 pts/wk",
        tag: "trade-1402507062906265600",
        url: `${SCOPE}#league`,
        icon: "icons/icon-192.png",
      }),
    ),
  });

  assert.equal(sw.notifications.length, 1);
  const { title, options } = sw.notifications[0];
  assert.equal(title, "Trade: hobbezilla ⇄ speckledorf");
  assert.match(options.body, /^hobbezilla gets Gibbs/);
  assert.equal(options.tag, "trade-1402507062906265600");
  assert.equal(options.icon, "./icons/icon-192.png", "the precached shell icon, never a pushed URL");
  assert.equal(options.badge, "./icons/icon-192.png");
  assert.equal(options.data.url, `${SCOPE}#league`, "the tap target rides on the notification");
  assert.equal(options.renotify, false);
});

test("a push that is not JSON still shows something", async () => {
  // userVisibleOnly means every push MUST end in a notification — a silent one costs the app
  // its push permission, and iOS shows its own "updated in the background" notice instead.
  const text = bootServiceWorker();
  await text.dispatch("push", { data: pushData("Free agent worth a drop: add Tucker") });
  assert.equal(text.notifications[0].title, "Tradewinds");
  assert.equal(text.notifications[0].body, undefined);
  assert.equal(text.notifications[0].options.body, "Free agent worth a drop: add Tucker");
  assert.equal(text.notifications[0].options.data.url, SCOPE, "no url in the payload → open the app");

  const empty = bootServiceWorker();
  await empty.dispatch("push", {});
  assert.equal(empty.notifications.length, 1);
  assert.equal(empty.notifications[0].title, "Tradewinds");
  assert.equal(empty.notifications[0].options.body, "");
  assert.equal(empty.notifications[0].options.tag, "tradewinds");
});

test("a notification tap focuses the open app and tells it where to go", async () => {
  const sw = bootServiceWorker();
  const notification = clickedNotification({ url: `${SCOPE}#deals` });

  await sw.dispatch("notificationclick", { notification });

  assert.equal(notification.closed, 1, "the notification is dismissed");
  assert.equal(sw.clients[0].focused, 1);
  assert.deepEqual(messagesOf(sw.clients[0]), [{ type: "open-url", url: `${SCOPE}#deals` }]);
  assert.deepEqual(sw.opened, [], "no second window when one is already open");
});

test("a tap with no app open — or only a foreign tab — opens a window", async () => {
  const none = bootServiceWorker({ windows: [] });
  await none.dispatch("notificationclick", { notification: clickedNotification({ url: `${SCOPE}#league` }) });
  assert.deepEqual(none.opened, [`${SCOPE}#league`]);

  // Another site's page is still a window client: it must not be focused or messaged.
  const foreign = bootServiceWorker({ windows: ["https://example.com/other", "https://tom-bentley.github.io/elsewhere/"] });
  await foreign.dispatch("notificationclick", { notification: clickedNotification({ url: `${SCOPE}#deals` }) });
  assert.deepEqual(foreign.opened, [`${SCOPE}#deals`]);
  assert.deepEqual(foreign.posted, [], "nothing was posted to a page outside our scope");
  assert.equal(foreign.clients[0].focused, 0);
});

test("a tap on a notification with no data still opens the app", async () => {
  const sw = bootServiceWorker({ windows: [] });
  await sw.dispatch("notificationclick", { notification: clickedNotification(undefined) });
  assert.deepEqual(sw.opened, [SCOPE]);
});

test("a relative deep link in the payload resolves against the app scope", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch("notificationclick", { notification: clickedNotification({ url: "./#league" }) });
  assert.deepEqual(messagesOf(sw.clients[0]), [{ type: "open-url", url: `${SCOPE}#league` }]);
});

/* ───────────────── receipts + subscription self-heal (design §13.3 B1) ───────────────── */

/** The device id the alerts job files an endpoint under (first 16 hex of SHA-256). */
async function deviceIdOf(endpoint) {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

test("every push writes a receipt the page can read back", async () => {
  const sw = bootServiceWorker();

  await sw.dispatch("push", {
    data: pushData(
      JSON.stringify({
        title: "New deal to propose",
        body: "Send Tucker to hobbezilla for Nabers · +2.1 pts/wk",
        tag: "deal-7:4866>9221",
        kind: "deals",
        url: `${SCOPE}#deals`,
      }),
    ),
  });

  const receipts = sw.receipts();
  assert.equal(receipts.length, 1, "one push, one receipt");
  assert.equal(receipts[0].title, "New deal to propose");
  assert.equal(receipts[0].tag, "deal-7:4866>9221");
  assert.equal(receipts[0].kind, "deals");
  assert.equal(receipts[0].shown, true);
  assert.equal(receipts[0].error, null);
  assert.ok(Number.isFinite(receipts[0].at), "the receipt is timestamped");
});

test("the receipt kind falls back to the tag when the payload does not say", async () => {
  const sw = bootServiceWorker();
  for (const tag of ["advice-11604", "deal-x", "fa-4046", "trade-140", "test", "tradewinds"]) {
    await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "t", tag })) });
  }
  assert.deepEqual(
    sw.receipts().map((r) => r.kind),
    ["advice", "deals", "fa", "trades", "test", "other"],
  );
});

test("a showNotification that rejects is recorded, and a fallback notification still fires", async () => {
  // The exact failure the sender cannot see: Apple returns 201, the job logs "sent", and the
  // phone shows nothing. Without this receipt the app would keep claiming alerts are on.
  const sw = bootServiceWorker({ showNotificationFails: 1 });

  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "Bowers is Doubtful", tag: "advice-11604" })) });

  const [receipt] = sw.receipts();
  assert.equal(receipt.shown, true, "the fallback got something on screen");
  assert.match(receipt.error, /notification refused/);
  assert.match(receipt.error, /fallback notification shown/);
  assert.equal(sw.notifications.length, 1, "the fallback is the notification that was shown");
  assert.equal(sw.notifications[0].title, "Tradewinds");
});

test("a push with both notification attempts failing is logged as shown:false", async () => {
  const sw = bootServiceWorker({ showNotificationFails: 2 });
  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "gone", tag: "fa-1" })) });
  const [receipt] = sw.receipts();
  assert.equal(receipt.shown, false);
  assert.match(receipt.error, /fallback failed/);
  assert.equal(sw.notifications.length, 0);
});

test("the receipt log is bounded to the last 50 pushes", async () => {
  const sw = bootServiceWorker();
  for (let i = 0; i < 55; i += 1) {
    await sw.dispatch("push", { data: pushData(JSON.stringify({ title: `push ${i}`, tag: `fa-${i}` })) });
  }
  const receipts = sw.receipts();
  assert.equal(receipts.length, 50);
  assert.equal(receipts[0].title, "push 5", "the oldest five fell off the front");
  assert.equal(receipts[49].title, "push 54");
});

test("a browser with IndexedDB blocked still shows the notification", async () => {
  // Private mode, evicted storage, a quota error: the receipt is diagnostics, never a gate.
  const sw = bootServiceWorker({ indexedDB: makeMemoryIndexedDb({ fail: true }) });
  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "still shown", tag: "advice-1" })) });
  assert.equal(sw.notifications.length, 1);
  assert.equal(sw.notifications[0].title, "still shown");
});

test("pushsubscriptionchange re-subscribes, records the rotation and tells the page", async () => {
  const oldEndpoint = "https://web.push.apple.com/QF2c-old";
  const sw = bootServiceWorker();

  await sw.dispatch("pushsubscriptionchange", {
    oldSubscription: { endpoint: oldEndpoint },
    newSubscription: null,
  });

  assert.equal(sw.subscribeCalls.length, 1, "the worker re-subscribed itself");
  assert.equal(sw.subscribeCalls[0].userVisibleOnly, true);
  assert.equal(sw.subscribeCalls[0].applicationServerKey.length, 65, "an uncompressed P-256 point");
  assert.equal(sw.subscribeCalls[0].applicationServerKey[0], 4);

  const record = sw.subscriptionRecord();
  assert.equal(record.oldEndpointHash, await deviceIdOf(oldEndpoint));
  assert.equal(record.newSub.endpoint, "https://web.push.apple.com/new-endpoint");
  assert.equal(record.newEndpointHash, await deviceIdOf("https://web.push.apple.com/new-endpoint"));
  assert.equal(record.error, null);

  const message = sw.posted.find((m) => m.type === "push-subscription-changed");
  assert.ok(message, "the open page is told the endpoint moved");
  assert.equal(message.oldEndpointHash, record.oldEndpointHash);
  assert.equal(message.newEndpointHash, record.newEndpointHash);
});

test("pushsubscriptionchange keeps the browser's own new subscription when it supplies one", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch("pushsubscriptionchange", {
    oldSubscription: { endpoint: "https://web.push.apple.com/QF2c-old" },
    newSubscription: {
      endpoint: "https://web.push.apple.com/QF2c-browser-made",
      toJSON: () => ({ endpoint: "https://web.push.apple.com/QF2c-browser-made", keys: { p256dh: "a", auth: "b" } }),
    },
  });
  assert.equal(sw.subscribeCalls.length, 0, "no second subscription when the browser already made one");
  assert.equal(sw.subscriptionRecord().newSub.endpoint, "https://web.push.apple.com/QF2c-browser-made");
});

test("a re-subscribe that fails is recorded with its error rather than swallowed", async () => {
  const sw = bootServiceWorker({
    subscribeImpl: () => {
      throw new Error("permission revoked");
    },
  });
  await sw.dispatch("pushsubscriptionchange", { oldSubscription: { endpoint: "https://web.push.apple.com/x" } });
  const record = sw.subscriptionRecord();
  assert.equal(record.newSub, null);
  assert.match(record.error, /permission revoked/);
  assert.equal(sw.posted.find((m) => m.type === "push-subscription-changed").error, record.error);
});

test("a push-receipts message is answered on the MessageChannel port", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "one", tag: "advice-1" })) });
  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "two", tag: "fa-2" })) });

  const replies = [];
  await sw.dispatch("message", {
    data: { type: "push-receipts" },
    ports: [{ postMessage: (value) => replies.push(value) }],
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].type, "push-receipts");
  assert.equal(replies[0].receipts.length, 2);
  assert.equal(replies[0].receipts[0].title, "two", "newest first");
  assert.equal(replies[0].subscriptionChange, null, "nothing has rotated on this device");
});

test("a push-receipts message with no port answers the source client", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "one", tag: "advice-1" })) });

  const received = [];
  await sw.dispatch("message", {
    data: { type: "push-receipts" },
    source: { postMessage: (value) => received.push(value) },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].receipts[0].title, "one");
});

test("SKIP_WAITING still works and unknown messages are ignored", async () => {
  const sw = bootServiceWorker();
  await sw.dispatch("message", { data: { type: "push-receipts-please" } });
  await sw.dispatch("message", { data: "a string" });
  assert.equal(sw.state.skipWaiting, 0);
  await sw.dispatch("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(sw.state.skipWaiting, 1);
});

test("the VAPID key in the worker matches src/config.js", () => {
  const config = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
  const fromConfig = config.match(/export const VAPID_PUBLIC_KEY =\s*"([^"]+)"/)[1];
  const fromWorker = SW_SOURCE.match(/^const VAPID_PUBLIC_KEY =\s*\n\s*"([^"]+)";/m)[1];
  assert.equal(fromWorker, fromConfig, "a classic worker cannot import the key — the copies must agree");
});
