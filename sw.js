/* Tradewinds service worker — classic script, no imports (design §7).
 *
 * Strategy
 *   data/*.json      network-first, cache fallback  (fresh values when online, usable offline)
 *   everything else  stale-while-revalidate         (instant shell, silently updated)
 *   navigations      network-first, ./index.html from cache when offline
 *   cross-origin     not intercepted at all — Sleeper, FantasyCalc and sleepercdn images go
 *                    straight to the network so a stale cache can never fake live league data.
 *
 * Updates: a new worker installs and waits. It tells open pages `{ type: "update-available" }`;
 * the UI shows a toast and posts back `{ type: "SKIP_WAITING" }` when the user accepts.
 * Register with `navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })` so
 * iOS Safari re-checks this file instead of serving it from the HTTP cache (research R2 §A).
 *
 * Push (design §11.1/§11.4): the scheduled GitHub Action is the sender; this worker only shows
 * what arrives and routes the tap. Every push MUST end in a visible notification — the
 * subscription is `userVisibleOnly`, and a silent push costs the app its push permission.
 */

const CACHE = "tradewinds-v0.4.1"; // keep equal to "tradewinds-v" + APP_VERSION (src/config.js) — bump both on every app deploy
const CACHE_PREFIX = "tradewinds-";

const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.webmanifest",
  "./src/config.js",
  "./src/data.js",
  "./src/sleeper.js",
  "./src/idb.js",
  "./src/push.js",
  "./src/engine/context.js",
  "./src/engine/values.js",
  "./src/engine/lineup.js",
  "./src/engine/trade.js",
  "./src/engine/finder.js",
  "./src/engine/explain.js",
  "./src/engine/waiver.js",
  "./src/engine/advisor.js",
  "./src/engine/injuries.js",
  "./src/engine/risk.js",
  "./src/ui/app.js",
  "./src/ui/advisor.js",
  "./src/ui/deals.js",
  "./src/ui/freeagents.js",
  "./src/ui/analyze.js",
  "./src/ui/league.js",
  "./src/ui/players.js",
  "./src/ui/settings.js",
  "./src/ui/setup.js",
  "./src/ui/alerts.js",
  "./src/ui/services.js",
  "./src/ui/store.js",
  "./src/ui/mock.js",
  "./src/ui/components.js",
  "./src/ui/format.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

const isDataFile = (url) => /\/data\/[^/]+\.json$/.test(url.pathname);

async function precache() {
  const cache = await caches.open(CACHE);
  // One at a time: a single missing file (an icon, a module not written yet) must not abort the
  // whole install and leave the app uninstallable.
  for (const asset of PRECACHE) {
    try {
      await cache.add(new Request(asset, { cache: "reload" }));
    } catch {
      /* skipped — it will be picked up by stale-while-revalidate on first use */
    }
  }
}

async function announceUpdate() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage({ type: "update-available" });
}

self.addEventListener("install", (event) => {
  // An already-active worker means this install is an update, not a first run.
  const isUpdate = Boolean(self.registration && self.registration.active);
  event.waitUntil(
    precache().then(() => (isUpdate ? announceUpdate() : undefined)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/* ──────────────────────────── receipts + subscription log (design §13.3 B1) ────────────────────
 * The sender's logs say "sent"; only this worker knows whether anything was ever SHOWN. Every
 * push writes a receipt here and the Settings card reads them back, which is the whole difference
 * between "alerts are on" (a local flag) and "alerts are working" (evidence).
 *
 * Raw IndexedDB, because the SW is a classic script and cannot import src/idb.js. Every call is
 * wrapped: a browser with IDB blocked (private mode, storage pressure) must still show the
 * notification — the log is diagnostics, never a precondition.
 */

const RECEIPT_DB = "tradewinds-sw";
const RECEIPT_DB_VERSION = 1;
/** Receipts: one record per push this worker handled. */
const RECEIPT_STORE = "pushes";
/** One record, key "last": the most recent `pushsubscriptionchange`. */
const SUBSCRIPTION_STORE = "subscription";
/** Enough to cover several days of a ten-minute cron without growing without bound. */
const RECEIPT_LIMIT = 50;
/** The single record key in SUBSCRIPTION_STORE — the page only ever wants the latest. */
const SUBSCRIPTION_KEY = "last";
/** How long a write waits for its transaction to commit before giving up on the confirmation. */
const COMMIT_TIMEOUT_MS = 2000;

/** Promise-wrap one IDBRequest. */
function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

/** Open (and migrate) the diagnostics database. Rejects rather than throwing synchronously. */
function openReceiptDb() {
  return new Promise((resolve, reject) => {
    const factory = self.indexedDB;
    if (!factory) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    let request;
    try {
      request = factory.open(RECEIPT_DB, RECEIPT_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      // Auto-incrementing keys, not the timestamp: two pushes can land in the same millisecond
      // and a receipt that overwrites another would hide exactly the case we are chasing.
      if (!db.objectStoreNames.contains(RECEIPT_STORE)) {
        db.createObjectStore(RECEIPT_STORE, { keyPath: "seq", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(SUBSCRIPTION_STORE)) db.createObjectStore(SUBSCRIPTION_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** Run `work(store)` in one transaction and settle when the transaction does. Never throws. */
async function withStore(name, mode, work) {
  let db = null;
  try {
    db = await openReceiptDb();
    const tx = db.transaction(name, mode);
    // The commit handlers go on NOW, before the first request: a transaction auto-commits as soon
    // as its last request settles, and a handler attached after that never fires. Waiting for the
    // commit matters because a worker killed between a successful write and the commit loses the
    // receipt. The timeout is the backstop — a hung `waitUntil` would be worse than a missing row.
    const committed =
      mode === "readwrite"
        ? new Promise((resolve) => {
            let timer = null;
            const finish = () => {
              if (timer !== null) {
                clearTimeout(timer);
                timer = null;
              }
              resolve();
            };
            tx.oncomplete = finish;
            tx.onerror = finish;
            tx.onabort = finish;
            if (typeof setTimeout === "function") timer = setTimeout(finish, COMMIT_TIMEOUT_MS);
          })
        : null;
    const result = await work(tx.objectStore(name));
    if (committed) await committed;
    return result;
  } catch (error) {
    return undefined;
  } finally {
    try {
      if (db && typeof db.close === "function") db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Append one receipt and trim the log back to RECEIPT_LIMIT. Never throws. */
async function recordReceipt(receipt) {
  return withStore(RECEIPT_STORE, "readwrite", async (store) => {
    await idbRequest(store.add(receipt));
    const keys = await idbRequest(store.getAllKeys());
    const excess = (keys || []).length - RECEIPT_LIMIT;
    for (let i = 0; i < excess; i += 1) await idbRequest(store.delete(keys[i]));
    return true;
  });
}

/** The newest receipts first, at most `limit`. Never throws; [] when the log is unreadable. */
async function readReceipts(limit = RECEIPT_LIMIT) {
  const rows = await withStore(RECEIPT_STORE, "readonly", (store) => idbRequest(store.getAll()));
  if (!Array.isArray(rows)) return [];
  return rows.slice(-limit).reverse();
}

/** Remember a subscription rotation so the page can say "re-pair" instead of guessing. */
async function recordSubscriptionChange(record) {
  return withStore(SUBSCRIPTION_STORE, "readwrite", (store) =>
    idbRequest(store.put(record, SUBSCRIPTION_KEY)),
  );
}

/** The last recorded rotation, or null. */
async function readSubscriptionChange() {
  const record = await withStore(SUBSCRIPTION_STORE, "readonly", (store) =>
    idbRequest(store.get(SUBSCRIPTION_KEY)),
  );
  return record ?? null;
}

/**
 * The device id the alerts job files this endpoint under: first 16 hex of SHA-256(endpoint).
 * Byte-identical to `deviceIdOf` in pipeline/alerts.mjs and src/push.js — the three have to
 * agree or "is this phone in the sender's list?" is unanswerable.
 * @param {string|null|undefined} endpoint
 * @returns {Promise<string|null>}
 */
async function deviceIdOf(endpoint) {
  const value = typeof endpoint === "string" ? endpoint : "";
  const subtle = self.crypto && self.crypto.subtle;
  if (!value || !subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  } catch {
    return null;
  }
}

/** Post to every page under our scope. Never throws. */
async function postToClients(message) {
  let windows = [];
  try {
    windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  } catch {
    return;
  }
  for (const client of windows) {
    try {
      client.postMessage(message);
    } catch {
      /* a client going away mid-post is not an error worth propagating */
    }
  }
}

/* ──────────────────────────────── push notifications ────────────────────────────────
 * Payload (pipeline/alerts.mjs, design §11.3): { title, body, tag, url, icon, kind }.
 * A push that is not JSON still has to show something, or iOS shows its own
 * "this site was updated in the background" notice and the subscription is at risk.
 */

const NOTIFICATION_FALLBACK_TITLE = "Tradewinds";
/** Always the precached shell icon: a pushed URL could point anywhere, or at nothing. */
const NOTIFICATION_ICON = "./icons/icon-192.png";

/** The app's own base URL — everything the notification opens is resolved against it. */
function appScope() {
  return (self.registration && self.registration.scope) || new URL("./", self.location).href;
}

/** JSON payload, a plain-text body, or nothing at all. Never throws. */
function readPushPayload(data) {
  if (!data) return {};
  try {
    const parsed = data.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string") return { body: parsed };
  } catch {
    /* not JSON — fall through to the text body */
  }
  try {
    const text = data.text();
    return text ? { body: text } : {};
  } catch {
    return {};
  }
}

/** What kind of alert this was, for the receipt log: the payload says so, else the tag does. */
function kindOf(payload, tag) {
  if (typeof payload.kind === "string" && payload.kind) return payload.kind;
  // Tags are `<kind>-<key>` for single alerts and the bare kind for a batch (pipeline/alerts.mjs).
  // "tradewinds" — this worker's own fallback tag — is deliberately not a trade.
  const name = String(tag || "");
  const head = name.split("-")[0];
  if (head === "test") return "test";
  if (head === "advice") return "advice";
  if (head === "deal" || head === "deals") return "deals";
  if (head === "fa") return "fa";
  if (head === "trade" || head === "trades") return "trades";
  return "other";
}

/**
 * Show the notification and write the receipt. `showNotification` is wrapped because a rejected
 * one is invisible from the sender's side — the job logs a 201 and the phone shows nothing, which
 * is precisely the failure this release exists to expose. A failure still tries the simplest
 * possible notification: `userVisibleOnly` means a push with nothing on screen costs the app its
 * push permission.
 */
async function showAndRecord(payload) {
  const title = payload.title || NOTIFICATION_FALLBACK_TITLE;
  const tag = payload.tag || "tradewinds";
  const url = payload.url || appScope();
  const receipt = { at: Date.now(), title, tag, kind: kindOf(payload, tag), shown: false, error: null };

  try {
    await self.registration.showNotification(title, {
      body: payload.body || "",
      tag,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: { url },
      // Alerts about the same league reuse a tag; replacing quietly beats buzzing twice.
      renotify: false,
    });
    receipt.shown = true;
  } catch (error) {
    receipt.error = String((error && error.message) || error);
    try {
      await self.registration.showNotification(NOTIFICATION_FALLBACK_TITLE, {
        body: payload.body || title,
        tag,
      });
      receipt.shown = true;
      receipt.error += " (fallback notification shown)";
    } catch (fallbackError) {
      receipt.error += ` · fallback failed: ${String((fallbackError && fallbackError.message) || fallbackError)}`;
    }
  }

  await recordReceipt(receipt);
  return receipt;
}

self.addEventListener("push", (event) => {
  event.waitUntil(showAndRecord(readPushPayload(event.data)));
});

/* ─────────────────────── pushsubscriptionchange (design §13.3 B1) ───────────────────────
 * iOS rotates a push subscription on its own schedule (app update, storage eviction, an OS
 * upgrade). The old endpoint keeps returning 201 to the sender for a while, so the GitHub job
 * cheerfully reports "3/3 sent" to an endpoint nothing is listening on. The worker re-subscribes
 * immediately and records the rotation; the page turns that into "re-pair this phone".
 *
 * The key literal below MUST stay equal to `VAPID_PUBLIC_KEY` in src/config.js (and to the copy
 * in pipeline/alerts.mjs) — a classic worker cannot import it. Public by design (design §11.1).
 */
const VAPID_PUBLIC_KEY =
  "BHRrun9caaSWpO0KOYVBrEHU7lo0SJ2qNQ203fkbMP24VIyZTa1Rssxk2XpiFekMscVSUBlj6TakzQ8Xu0l5CQo";

/** base64url → the Uint8Array `pushManager.subscribe` wants (same code as src/push.js). */
function vapidKeyBytes(base64String) {
  const input = String(base64String || "").trim();
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = self.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function handleSubscriptionChange(event) {
  const oldSubscription = (event && event.oldSubscription) || null;
  const oldEndpointHash = await deviceIdOf(oldSubscription && oldSubscription.endpoint);

  let subscription = (event && event.newSubscription) || null;
  let error = null;
  if (!subscription) {
    try {
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(VAPID_PUBLIC_KEY),
      });
    } catch (subscribeError) {
      error = String((subscribeError && subscribeError.message) || subscribeError);
    }
  }

  const newSub =
    subscription && typeof subscription.toJSON === "function"
      ? subscription.toJSON()
      : subscription
        ? { endpoint: subscription.endpoint }
        : null;
  const record = {
    at: Date.now(),
    oldEndpointHash,
    newEndpointHash: await deviceIdOf(newSub && newSub.endpoint),
    newSub,
    error,
  };
  await recordSubscriptionChange(record);
  await postToClients({
    type: "push-subscription-changed",
    at: record.at,
    oldEndpointHash: record.oldEndpointHash,
    newEndpointHash: record.newEndpointHash,
    error: record.error,
  });
  return record;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

/* ──────────────────────────────── messages from the page ──────────────────────────────── */

/** Answer a `push-receipts` request on the MessageChannel port, the source client, or broadcast. */
async function replyWithReceipts(event) {
  const reply = {
    type: "push-receipts",
    at: Date.now(),
    receipts: await readReceipts(),
    subscriptionChange: await readSubscriptionChange(),
  };
  const port = event.ports && event.ports[0];
  if (port && typeof port.postMessage === "function") {
    try {
      port.postMessage(reply);
      return reply;
    } catch {
      /* the page went away — fall through to a broadcast */
    }
  }
  const source = event.source;
  if (source && typeof source.postMessage === "function") {
    try {
      source.postMessage(reply);
      return reply;
    } catch {
      /* same */
    }
  }
  await postToClients(reply);
  return reply;
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "push-receipts") event.waitUntil(replyWithReceipts(event));
});

/** Focus the app if it is already open (and tell it where to go), otherwise open it. */
async function openFromNotification(url) {
  const scope = appScope();
  const target = new URL(url || "./", scope).href;
  let clients = [];
  try {
    clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch {
    clients = [];
  }

  for (const client of clients) {
    if (typeof client.url !== "string" || !client.url.startsWith(scope)) continue;
    try {
      await client.focus();
    } catch {
      /* focus can be refused; the message below still routes the open tab */
    }
    client.postMessage({ type: "open-url", url: target });
    return;
  }

  if (self.clients.openWindow) await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  if (notification && typeof notification.close === "function") notification.close();
  const url = (notification && notification.data && notification.data.url) || appScope();
  event.waitUntil(openFromNotification(url));
});

async function putInCache(request, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch {
    /* quota or an uncacheable request — not fatal */
  }
}

/** Fresh data when we can get it, the last copy when we cannot. */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await putInCache(request, response);
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

/** Serve the cached shell immediately, refresh it in the background. */
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request, { ignoreSearch: false });
  const network = fetch(request)
    .then((response) => {
      putInCache(request, response);
      return response;
    })
    .catch(() => undefined);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  return new Response("", { status: 504, statusText: "Offline and not cached" });
}

/** A navigation offline still opens the app shell. */
async function navigate(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const shell =
      (await caches.match("./index.html", { ignoreSearch: true })) ||
      (await caches.match("./", { ignoreSearch: true }));
    if (shell) return shell;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // never touch the APIs or the CDN

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  if (isDataFile(url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
