// Service-worker behaviour, exercised in a fake ServiceWorkerGlobalScope (node:vm). Named
// `data.sw` so it stays inside the data-layer agent's `test/data.*.test.mjs` file pattern.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const SCOPE = "https://tom-bentley.github.io/tradewinds/";
const SW_SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

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
function bootServiceWorker({ network, cacheNames = [], hasActiveWorker = false } = {}) {
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

  const self = {
    location: new URL(`${SCOPE}sw.js`),
    registration: { active: hasActiveWorker ? { state: "activated" } : null },
    skipWaiting: () => {
      state.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        state.claimed += 1;
      },
      matchAll: async () => [{ postMessage: (data) => posted.push(data) }],
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
  };

  const sandbox = { self, caches, fetch: fetchImpl, Request: FakeRequest, Response: FakeResponse, URL, console };
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

  return { dispatch, caches, cacheStorage, posted, state, fetchCalls };
}

/** Everything in the shell resolves except the two files listed as missing. */
const shellNetwork = (missing = []) => (url) =>
  missing.some((name) => url.endsWith(name)) ? new FakeResponse("", { status: 404 }) : new FakeResponse(`body:${url}`);

test("install precaches the shell and survives files that do not exist yet", async () => {
  const sw = bootServiceWorker({ network: shellNetwork(["ui/deals.js", "icons/icon-512.png"]) });

  await sw.dispatch("install", {});

  const cache = sw.cacheStorage.get("tradewinds-v1");
  assert.ok(cache, "the versioned cache was created");
  assert.ok(cache.entries.has(`${SCOPE}index.html`), "index.html precached");
  assert.ok(cache.entries.has(`${SCOPE}src/data.js`), "modules precached");
  assert.ok(cache.entries.has(`${SCOPE}icons/apple-touch-icon.png`));
  assert.ok(!cache.entries.has(`${SCOPE}src/ui/deals.js`), "a 404 is skipped, not fatal");
  assert.equal(cache.entries.size, 26 - 2, "every other shell file landed");
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
  const sw = bootServiceWorker({ cacheNames: ["tradewinds-v0", "tradewinds-v1", "some-other-app"] });

  await sw.dispatch("activate", {});

  assert.deepEqual(await sw.caches.keys(), ["tradewinds-v1", "some-other-app"]);
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
  assert.equal((await sw.cacheStorage.get("tradewinds-v1").match(request)).body, "fresh-values", "cached for later");

  const offline = bootServiceWorker({ network: () => undefined });
  const cache = await offline.caches.open("tradewinds-v1");
  await cache.put(request, new FakeResponse("last-good-values"));
  const cached = await offline.dispatch("fetch", { request });
  assert.equal(cached.body, "last-good-values");
});

test("shell assets are served from cache and refreshed in the background", async () => {
  const sw = bootServiceWorker({ network: () => new FakeResponse("v2-styles") });
  const request = new FakeRequest(`${SCOPE}styles.css`);
  const cache = await sw.caches.open("tradewinds-v1");
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
  const cache = await sw.caches.open("tradewinds-v1");
  await cache.put(new FakeRequest(`${SCOPE}index.html`), new FakeResponse("<!doctype html>shell"));

  const response = await sw.dispatch("fetch", {
    request: new FakeRequest(`${SCOPE}?tab=deals`, { mode: "navigate" }),
  });
  assert.equal(response.body, "<!doctype html>shell");
});
