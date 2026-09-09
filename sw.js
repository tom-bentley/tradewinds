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

const CACHE = "tradewinds-v0.1.0"; // keep equal to "tradewinds-v" + APP_VERSION (src/config.js) — bump both on every app deploy
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
  "./src/ui/app.js",
  "./src/ui/deals.js",
  "./src/ui/analyze.js",
  "./src/ui/league.js",
  "./src/ui/players.js",
  "./src/ui/settings.js",
  "./src/ui/setup.js",
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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ──────────────────────────────── push notifications ────────────────────────────────
 * Payload (pipeline/alerts.mjs, design §11.3): { title, body, tag, url, icon }.
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

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event.data);
  const title = payload.title || NOTIFICATION_FALLBACK_TITLE;
  const url = payload.url || appScope();
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      tag: payload.tag || "tradewinds",
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: { url },
      // Alerts about the same league reuse a tag; replacing quietly beats buzzing twice.
      renotify: false,
    }),
  );
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
