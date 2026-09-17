// Tradewinds — client-side Web Push (design §11.1 and §11.4).
//
// ── Why it looks like this ───────────────────────────────────────────────────────────────────
// iOS delivers Web Push only to web apps INSTALLED on the Home Screen (iOS ≥ 16.4, research
// R2 §A): a plain Safari tab can never subscribe, and the permission prompt has to come from a
// real user gesture inside the installed app. So the whole flow is: check `alertsSupported()`
// → render a button → call `enableAlerts()` FROM THE CLICK HANDLER (never on load, never after
// an `await` that loses the gesture on some browsers).
//
// There is no server. The scheduled GitHub Action is the sender, and it reads this device's
// subscription out of the repository secret `PUSH_SUBSCRIPTIONS` — so pairing is a one-time
// copy/paste: `pairingCode(pairing)` → the user pastes it into the secret (a JSON ARRAY of
// pairing payloads: one device is `[ <code> ]`, more devices are comma-separated).
//
// ── Using it (the UI's whole contract with this module) ──────────────────────────────────────
//   import { alertsSupported, alertsStatus, enableAlerts, disableAlerts, pairingCode,
//            updatePrefs, PushError, reasonText } from "../push.js";
//
//   const support = alertsSupported();                     // sync, cheap, safe on any browser
//   button.disabled = !support.ok;
//   hint.textContent = support.ok ? "" : reasonText(support.reason);
//
//   button.addEventListener("click", async () => {         // ← the gesture matters
//     try {
//       const pairing = await enableAlerts({ settings, prefs: { freeAgents: false } });
//       showPairingSheet(pairingCode(pairing));
//     } catch (error) {
//       if (error instanceof PushError) return showHint(reasonText(error.reason));
//       throw error;
//     }
//   });
//
// Everything is dependency-injectable through `deps` — `{ notification, serviceWorker, storage,
// win }` — so the tests never touch a global. In the browser the defaults are
// `window.Notification`, `navigator.serviceWorker`, `localStorage` and `window`.

import * as config from "./config.js";

/** localStorage key holding this device's pairing payload (design §11.4). */
export const PUSH_STORAGE_KEY = "tradewinds.push.v1";

/** Pairing payload schema version — bump together with `pipeline/alerts.mjs`. */
export const PAIRING_VERSION = 1;

/**
 * Public half of the VAPID key pair generated 2026-09-09 (design §11.1). Public keys are meant
 * to be embedded in the client; only `VAPID_PRIVATE_KEY` is a secret. Read from `config.js`
 * when that export exists, otherwise the identical literal below — so this module works before
 * the config change lands.
 */
const VAPID_FALLBACK =
  "BHRrun9caaSWpO0KOYVBrEHU7lo0SJ2qNQ203fkbMP24VIyZTa1Rssxk2XpiFekMscVSUBlj6TakzQ8Xu0l5CQo";

export const VAPID_PUBLIC_KEY =
  typeof config.VAPID_PUBLIC_KEY === "string" && config.VAPID_PUBLIC_KEY
    ? config.VAPID_PUBLIC_KEY
    : VAPID_FALLBACK;

/**
 * Alert preferences the pairing payload carries (design §11.4, extended in §12.5).
 * `advice` (my players' status changes) outranks every other kind in the job's per-run cap, so
 * it defaults on; `rivalNews` is interesting rather than actionable and defaults off.
 * The pairing schema itself is unchanged — new keys are additive, so `PAIRING_VERSION` stays 1
 * and a device paired before v1.3 keeps working (the job's `normalizePrefs` fills the defaults).
 */
export const DEFAULT_PREFS = Object.freeze({
  trades: true,
  deals: true,
  freeAgents: true,
  advice: true,
  rivalNews: false,
  minDealScore: 2,
  minFaGain: 1,
  // v1.4 (design §13.3 B3): noise control. Seventy "new deal" pushes in eight days is how a phone
  // learns to ignore an app. There is no UI for these yet — the job's `normalizePrefs` fills the
  // same values, so a device paired before v1.4 is throttled without re-pasting anything.
  dealsCooldownHours: 6,
  faCooldownHours: 6,
  maxDealsPerPush: 1,
});

/**
 * Why alerts are unavailable, in words the Settings card can print verbatim.
 * `not-installed` is the one every iPhone user hits first, so it says exactly what to do.
 */
export const ALERT_REASON_TEXT = Object.freeze({
  unsupported: "This browser cannot receive push notifications.",
  "not-installed":
    "Add Tradewinds to your Home Screen first (Share → Add to Home Screen), then open it from " +
    "there — iOS only sends alerts to installed web apps.",
  denied:
    "Notifications are blocked for Tradewinds. Turn them back on in iOS Settings → " +
    "Notifications → Tradewinds (or your browser's site settings), then try again.",
  insecure: "Alerts need a secure (https) connection.",
});

/**
 * @param {string|null} reason
 * @returns {string} display text for an `alertsSupported()` / `PushError` reason ("" when ok).
 */
export function reasonText(reason) {
  return ALERT_REASON_TEXT[reason] ?? (reason ? String(reason) : "");
}

/**
 * Where the sender publishes what it believes about this device (design §13.3 B2). Relative to
 * the app scope so a fork of the repo works unchanged; fetched with `cache: "no-store"`, because
 * a service worker that served a cached copy would answer "paired" forever.
 */
export const ALERTS_STATE_URL = "./data/alerts-state.json";

/** The public Actions API — unauthenticated, rate-limited, and entirely optional. */
export const ACTIONS_RUNS_URL =
  "https://api.github.com/repos/tom-bentley/tradewinds/actions/workflows/alerts.yml/runs?per_page=1";

/** How long a server/Actions probe is reused; the Settings card repaints far more often than this. */
export const PROBE_TTL_MS = 60_000;

/** How long to wait for the service worker to answer a `push-receipts` message. */
export const RECEIPTS_TIMEOUT_MS = 1500;

/** Thrown by `enableAlerts` when the browser or the user says no. `reason` matches the union. */
export class PushError extends Error {
  /**
   * @param {"unsupported"|"not-installed"|"denied"|"insecure"|"subscribe"} reason
   * @param {string} [message] Defaults to the display text for the reason.
   */
  constructor(reason, message) {
    super(message ?? reasonText(reason) ?? String(reason));
    this.name = "PushError";
    this.reason = reason;
    this.code = "PUSH_ERROR";
  }
}

/* ───────────────────────────── dependency plumbing ───────────────────────────── */

/** How long to wait for `serviceWorker.ready` before giving up (Safari can hang on it). */
const SW_READY_TIMEOUT_MS = 8000;
/** The status card is rendered on every Settings paint, so it waits a lot less. */
const SW_STATUS_TIMEOUT_MS = 3000;

/**
 * @typedef {object} PushDeps
 * @property {object} [win] Stand-in for `window` (`navigator`, `matchMedia`, `isSecureContext`,
 *   `PushManager`, `Notification`, `localStorage`).
 * @property {object} [notification] Stand-in for `window.Notification`.
 * @property {object} [serviceWorker] Stand-in for `navigator.serviceWorker`.
 * @property {object} [storage] Stand-in for `localStorage`.
 * @property {object} [navigator] Stand-in for `window.navigator`.
 * @property {Function} [pushManager] Stand-in for `window.PushManager` (presence check only).
 * @property {number} [swReadyTimeoutMs] How long to wait for `serviceWorker.ready`, for tests.
 * @property {() => number} [now] Clock, for tests.
 */

/** Resolve every injectable against the browser defaults. Never throws. */
function resolve(deps = {}) {
  const win = deps.win ?? globalThis;
  const nav = deps.navigator ?? win?.navigator ?? {};
  return {
    win: win ?? {},
    nav,
    notification: deps.notification ?? win?.Notification,
    serviceWorker: deps.serviceWorker ?? nav?.serviceWorker,
    storage: deps.storage ?? win?.localStorage,
    pushManager: deps.pushManager ?? win?.PushManager,
    swReadyTimeoutMs: deps.swReadyTimeoutMs,
    now: deps.now ?? Date.now,
    // Diagnostics plumbing (design §13.3 B2). `network: false` is how the Settings card paints
    // instantly before the slower probes come back.
    fetchImpl: deps.fetchImpl ?? (typeof win?.fetch === "function" ? win.fetch.bind(win) : null),
    subtle: deps.subtle ?? win?.crypto?.subtle ?? globalThis.crypto?.subtle ?? null,
    indexedDB: deps.indexedDB ?? win?.indexedDB ?? null,
    network: deps.network !== false,
    receiptsTimeoutMs: Number(deps.receiptsTimeoutMs ?? RECEIPTS_TIMEOUT_MS),
    probeTtlMs: Number(deps.probeTtlMs ?? PROBE_TTL_MS),
  };
}

/** True on iPhone/iPad/iPod, including iPadOS which reports itself as a desktop Mac. */
function isIos(nav) {
  const ua = String(nav?.userAgent ?? "");
  return /iP(hone|ad|od)/.test(ua) || (nav?.platform === "MacIntel" && Number(nav?.maxTouchPoints) > 1);
}

/** True when the page is running as an installed app rather than in browser chrome. */
function isStandalone({ win, nav }) {
  if (nav?.standalone === true) return true; // iOS Safari's own flag
  try {
    return win?.matchMedia?.("(display-mode: standalone)")?.matches === true;
  } catch {
    return false;
  }
}

/* ───────────────────────────── capability probe ───────────────────────────── */

/**
 * Can this device receive alerts at all? Cheap, synchronous, safe to call on every render.
 *
 * The order of the checks is deliberate: an iPhone Safari TAB exposes neither `Notification`
 * nor `PushManager`, so the install check has to come first or every iPhone would be told
 * "unsupported" when the real answer is "add it to your Home Screen".
 *
 * @param {PushDeps} [deps]
 * @returns {{ok: boolean, reason: null|"unsupported"|"not-installed"|"denied"|"insecure"}}
 */
export function alertsSupported(deps = {}) {
  const d = resolve(deps);

  if (!d.win?.isSecureContext) return { ok: false, reason: "insecure" };
  if (isIos(d.nav) && !isStandalone(d)) return { ok: false, reason: "not-installed" };
  if (!d.serviceWorker || !d.pushManager || !d.notification) return { ok: false, reason: "unsupported" };
  if (d.notification.permission === "denied") return { ok: false, reason: "denied" };

  return { ok: true, reason: null };
}

/**
 * A short name for this device, used as the pairing label so a list of paired devices in the
 * GitHub secret is readable ("iPhone", "Edge on Windows").
 * @param {PushDeps} [deps]
 * @returns {string}
 */
export function deviceLabel(deps = {}) {
  const { nav } = resolve(deps);
  const ua = String(nav?.userAgent ?? "");

  // iPadOS 13+ pretends to be a Mac, so check the touch-point tell before the macOS branch.
  if (/iPad/.test(ua) || (nav?.platform === "MacIntel" && Number(nav?.maxTouchPoints) > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPod/.test(ua)) return "iPod";

  const browser = /Edg[A-Za-z]*\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";

  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "This device";
}

/* ───────────────────────────── VAPID key encoding ───────────────────────────── */

/**
 * base64url (the form VAPID keys ship in) → the `Uint8Array` `pushManager.subscribe` wants.
 * The real key decodes to 65 bytes starting with 0x04 — an uncompressed P-256 point.
 * @param {string} base64String
 * @returns {Uint8Array}
 */
export function urlBase64ToUint8Array(base64String) {
  const input = String(base64String ?? "").trim();
  const padding = "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = (input + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = globalThis.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* ───────────────────────────── stored pairing ───────────────────────────── */

/**
 * The pairing payload saved on this device, or null. Never throws (Safari private mode).
 * @param {PushDeps} [deps]
 * @returns {object|null}
 */
export function storedPairing(deps = {}) {
  const { storage } = resolve(deps);
  try {
    const raw = storage?.getItem(PUSH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist a pairing payload. Returns false when storage is unavailable. */
function savePairing(pairing, deps = {}) {
  const { storage } = resolve(deps);
  try {
    storage?.setItem(PUSH_STORAGE_KEY, JSON.stringify(pairing));
    return true;
  } catch (error) {
    console.warn("Tradewinds: the alert pairing could not be saved locally", error);
    return false;
  }
}

/** Forget the pairing payload. Never throws. */
function clearPairing(deps = {}) {
  const { storage } = resolve(deps);
  try {
    storage?.removeItem(PUSH_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The exact string to paste into the GitHub repository secret. Compact, single line, so it
 * survives a copy button and a phone keyboard.
 *
 * `PUSH_SUBSCRIPTIONS` holds a JSON **array** of these payloads: one device is `[ <code> ]`,
 * a second device is appended with a comma. The alerts job (pipeline/alerts.mjs) reads it.
 * @param {object} [pairing] defaults to the pairing stored on this device.
 * @returns {string} "" when there is nothing to copy.
 */
export function pairingCode(pairing = storedPairing()) {
  if (!pairing) return "";
  try {
    return JSON.stringify(pairing);
  } catch {
    return "";
  }
}

/**
 * Merge the alert preference sources, most specific last.
 * @param {object} [settings] app settings (`settings.alerts`, saved by the Settings tab)
 * @param {object} [prefs] explicit overrides from the caller
 */
function mergePrefs(settings, prefs) {
  return {
    ...DEFAULT_PREFS,
    ...(config.DEFAULTS?.alerts ?? {}),
    ...(settings?.alerts ?? {}),
    ...(prefs ?? {}),
  };
}

/* ───────────────────────────── subscribe / unsubscribe ───────────────────────────── */

/** `serviceWorker.ready`, but it resolves null instead of hanging forever. */
async function readyRegistration(d, fallbackMs = SW_READY_TIMEOUT_MS) {
  if (!d.serviceWorker?.ready) return null;
  const timeoutMs = Number(d.swReadyTimeoutMs ?? fallbackMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(d.serviceWorker.ready),
      new Promise((resolve_) => {
        // Never unref this timer: it is bounded and always cleared in `finally`; an unref'd
        // timer let Node 22's test runner drain the loop before the 1 ms test timeout fired.
        timer = setTimeout(() => resolve_(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The live subscription for a registration, or null. Never throws. */
async function currentSubscription(reg) {
  try {
    return (await reg?.pushManager?.getSubscription?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Turn alerts on for this device. **Call this from a click handler** — iOS (and Chrome) only
 * grant notification permission from a user gesture, and a prompt fired on load is rejected
 * outright, permanently in some browsers.
 *
 * @param {{settings?: object, prefs?: object, label?: string, deps?: PushDeps}} [options]
 *   `settings` supplies `leagueId`/`userId` (and `settings.alerts` as the pref baseline);
 *   `prefs` overrides individual preferences; `label` names the device in the pairing list.
 * @param {PushDeps} [deps] alternative place to pass the injectables.
 * @returns {Promise<object>} the pairing payload (also saved to localStorage).
 * @throws {PushError} `unsupported` | `not-installed` | `insecure` | `denied` | `subscribe`
 */
export async function enableAlerts(options = {}, deps = options.deps ?? {}) {
  const { settings = {}, prefs, label } = options;
  const d = resolve(deps);

  const support = alertsSupported(deps);
  if (!support.ok) throw new PushError(support.reason);

  // 1. Permission — the part that needs the user gesture.
  let permission;
  try {
    permission = await d.notification.requestPermission();
  } catch (error) {
    throw new PushError("denied", `Tradewinds could not ask for notification permission: ${error?.message ?? error}`);
  }
  if (permission !== "granted") throw new PushError("denied");

  // 2. The service worker that will show the notifications.
  const reg = await readyRegistration(d);
  if (!reg?.pushManager) {
    throw new PushError("unsupported", "Tradewinds' service worker is not ready yet — reopen the app and try again.");
  }

  // 3. Subscribe. A subscription left over from an older VAPID key makes `subscribe` throw
  //    InvalidStateError, so drop it and ask once more before giving up.
  const subscribeOptions = {
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  };
  let sub;
  try {
    sub = await reg.pushManager.subscribe(subscribeOptions);
  } catch (error) {
    const stale = await currentSubscription(reg);
    if (!stale) throw new PushError("subscribe", `Push subscription failed: ${error?.message ?? error}`);
    try {
      await stale.unsubscribe();
      sub = await reg.pushManager.subscribe(subscribeOptions);
    } catch (retryError) {
      throw new PushError("subscribe", `Push subscription failed: ${retryError?.message ?? retryError}`);
    }
  }

  // 4. The pairing payload (design §11.4) — key order matches the doc so the pasted code reads
  //    the way the spec shows it.
  const pairing = {
    v: PAIRING_VERSION,
    sub: typeof sub?.toJSON === "function" ? sub.toJSON() : { endpoint: sub?.endpoint },
    leagueId: settings?.leagueId != null ? String(settings.leagueId) : null,
    userId: settings?.userId != null ? String(settings.userId) : null,
    label: String(label ?? "").trim() || deviceLabel(deps),
    prefs: mergePrefs(settings, prefs),
    createdAt: new Date(d.now()).toISOString(),
  };

  savePairing(pairing, deps);
  return pairing;
}

/**
 * Turn alerts off: drop the push subscription and forget the pairing. Never throws.
 *
 * Note: this cannot remove the device from the GitHub secret — the endpoint there simply stops
 * working and the alerts job marks it `expired` on the next 410. Tell the user they can delete
 * the line from `PUSH_SUBSCRIPTIONS` if they want it gone immediately.
 * @param {PushDeps} [deps]
 * @returns {Promise<{unsubscribed: boolean, cleared: boolean}>}
 */
export async function disableAlerts(deps = {}) {
  const d = resolve(deps);
  let unsubscribed = false;
  try {
    const reg = await readyRegistration(d, SW_STATUS_TIMEOUT_MS);
    const sub = await currentSubscription(reg);
    if (sub) unsubscribed = (await sub.unsubscribe()) !== false;
  } catch {
    /* no service worker, or it never became ready — clearing the pairing is still right */
  }
  const cleared = clearPairing(deps);
  return { unsubscribed, cleared };
}

/* ───────────────────────── diagnostics: is anything actually arriving? ─────────────────────────
 *
 * The 2026-09-17 complaint in one sentence: the card said "On" for eight days while ~80 pushes
 * were accepted by Apple and none were shown. "On" came from purely LOCAL state — a live
 * subscription plus a pairing in localStorage — which cannot fail the two ways this actually
 * fails: the phone rotated its endpoint (so the secret holds a dead-but-accepted subscription),
 * or the notifications are delivered and suppressed by iOS. Everything below exists so the card
 * can say which.
 */

/**
 * Stable per-device id: the first 16 hex characters of SHA-256(endpoint). **Byte-identical to
 * `deviceIdOf` in pipeline/alerts.mjs and to the copy inside sw.js** — the shared test vector
 * `https://web.push.apple.com/QF2c-token` → `ee64af5d15e243bb` is asserted in both test files.
 * It is what `data/alerts-state.json` keys its `devices` map by, so it is the only way the phone
 * can ask "does the sender know about me?".
 *
 * @param {string|null|undefined} endpoint
 * @param {PushDeps} [deps]
 * @returns {Promise<string|null>} null when there is no endpoint or no WebCrypto
 */
export async function deviceIdOf(endpoint, deps = {}) {
  const value = typeof endpoint === "string" ? endpoint.trim() : "";
  // An explicit `subtle: null` means "this browser has no WebCrypto" — `??` would helpfully fall
  // back to the real one and hide exactly the case being tested.
  const subtle = deps.subtle !== undefined ? deps.subtle : resolve(deps).subtle;
  if (!value || !subtle?.digest) return null;
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

/** Module-level probe cache: `alertsStatus` runs on every Settings paint, the network does not. */
const probeCache = new Map();

async function cachedProbe(key, ttlMs, now, load) {
  const hit = probeCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await load();
  probeCache.set(key, { at: now, value });
  return value;
}

/** Forget the cached server/Actions probes — the Diagnose sheet's refresh button. */
export function clearProbeCache() {
  probeCache.clear();
}

/**
 * `data/alerts-state.json` as the sender last committed it, or null when it cannot be read.
 * @param {PushDeps} [deps]
 * @returns {Promise<object|null>}
 */
export async function fetchAlertsState(deps = {}) {
  const d = resolve(deps);
  if (!d.network || typeof d.fetchImpl !== "function") return null;
  return cachedProbe("state", d.probeTtlMs, d.now(), async () => {
    try {
      const response = await d.fetchImpl(ALERTS_STATE_URL, { cache: "no-store" });
      if (!response?.ok) return null;
      const parsed = await response.json();
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  });
}

/**
 * When the Alerts workflow last ran, from the public Actions API. Unauthenticated and entirely
 * optional: a rate limit or an offline phone just means the card does not mention it.
 * @param {PushDeps} [deps]
 * @returns {Promise<{at: string|null, conclusion: string|null, url: string|null}|null>}
 */
export async function fetchLastRun(deps = {}) {
  const d = resolve(deps);
  if (!d.network || typeof d.fetchImpl !== "function") return null;
  return cachedProbe("runs", Math.max(d.probeTtlMs, 5 * 60_000), d.now(), async () => {
    try {
      const response = await d.fetchImpl(ACTIONS_RUNS_URL, {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response?.ok) return null;
      const body = await response.json();
      const run = Array.isArray(body?.workflow_runs) ? body.workflow_runs[0] : null;
      if (!run) return null;
      return {
        at: run.run_started_at ?? run.created_at ?? null,
        conclusion: run.conclusion ?? run.status ?? null,
        url: run.html_url ?? null,
      };
    } catch {
      return null;
    }
  });
}

/** Ask the service worker for its receipt log. Resolves null when it does not answer in time. */
function askServiceWorker(d) {
  const controller = d.serviceWorker?.controller;
  const channelCtor = d.win?.MessageChannel ?? globalThis.MessageChannel;
  if (!controller?.postMessage || typeof channelCtor !== "function") return Promise.resolve(null);
  return new Promise((resolveReply) => {
    let timer;
    const done = (value) => {
      clearTimeout(timer);
      resolveReply(value);
    };
    try {
      const channel = new channelCtor();
      channel.port1.onmessage = (event) => done(event?.data ?? null);
      controller.postMessage({ type: "push-receipts" }, [channel.port2]);
      // Never unref'd: it is always cleared, and an unref'd timer lets Node's test runner drain
      // the loop before the reply lands.
      timer = setTimeout(() => done(null), d.receiptsTimeoutMs);
    } catch {
      done(null);
    }
  });
}

/** Read the worker's IndexedDB log directly — the fallback when the worker does not reply. */
function readReceiptsFromIdb(d) {
  const factory = d.indexedDB;
  if (!factory?.open) return Promise.resolve(null);
  return new Promise((resolveRows) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveRows(value);
    };
    let request;
    try {
      request = factory.open("tradewinds-sw", 1);
    } catch {
      finish(null);
      return;
    }
    // Do NOT create the stores from here: an upgrade fired by the page would race the worker.
    request.onupgradeneeded = () => finish(null);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains("pushes")) {
          finish(null);
          return;
        }
        const read = db.transaction("pushes", "readonly").objectStore("pushes").getAll();
        read.onsuccess = () => finish(Array.isArray(read.result) ? [...read.result].reverse() : []);
        read.onerror = () => finish(null);
      } catch {
        finish(null);
      }
    };
  });
}

/**
 * What this phone has actually been shown (design §13.3 B1/B2). The service worker answers first
 * (which also proves it is alive); its IndexedDB log is the fallback for a page the worker is not
 * controlling yet.
 * @param {PushDeps} [deps]
 * @returns {Promise<{count24h: number, count: number, lastAt: number|null, lastShown: boolean|null,
 *   failed: number, items: object[], source: "sw"|"idb"|null, subscriptionChange: object|null}>}
 */
export async function pushReceipts(deps = {}) {
  const d = resolve(deps);
  const empty = {
    count24h: 0,
    count: 0,
    lastAt: null,
    lastShown: null,
    failed: 0,
    items: [],
    source: null,
    subscriptionChange: null,
  };

  let source = null;
  let items = null;
  let subscriptionChange = null;

  const reply = await askServiceWorker(d);
  if (reply && Array.isArray(reply.receipts)) {
    source = "sw";
    items = reply.receipts;
    subscriptionChange = reply.subscriptionChange ?? null;
  } else {
    const rows = await readReceiptsFromIdb(d);
    if (Array.isArray(rows)) {
      source = "idb";
      items = rows;
    }
  }
  if (!items) return empty;

  const now = d.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const timed = items.filter((item) => item && Number.isFinite(Number(item.at)));
  return {
    count: items.length,
    count24h: timed.filter((item) => Number(item.at) >= dayAgo).length,
    lastAt: timed.length ? Number(timed[0].at) : null,
    lastShown: items.length ? items[0].shown !== false : null,
    failed: items.filter((item) => item && item.shown === false).length,
    items: items.slice(0, 10),
    source,
    subscriptionChange,
  };
}

/**
 * A notification raised by this device, for this device — no GitHub, no VAPID, no network. It is
 * the one test that separates "the push never arrived" from "iOS is hiding it", so the Diagnose
 * sheet leads with it.
 * @param {{title?: string, body?: string, deps?: PushDeps}} [options]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function testNotification(options = {}, deps = options.deps ?? {}) {
  const d = resolve(deps);
  const permission = d.notification?.permission;
  if (permission !== "granted") return { ok: false, reason: permission === "denied" ? "denied" : "permission" };
  const reg = await readyRegistration(d, SW_STATUS_TIMEOUT_MS);
  if (!reg?.showNotification) return { ok: false, reason: "no-service-worker" };
  try {
    await reg.showNotification(options.title ?? "Tradewinds test", {
      body: options.body ?? "If you can see this, this phone can show alerts.",
      tag: "test-local",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: "./#settings" },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/* ───────────────────── self-healing pairing (design §13.3 B5, research R5 §6.2) ─────────────────
 *
 * Why this exists: iOS does NOT reliably fire `pushsubscriptionchange`, subscriptions carry no
 * `expirationTime`, and Safari clears service-worker state after a stretch of inactivity — so a
 * subscription can simply vanish or rotate with no event at all (Apple Developer Forums 727372;
 * R5 §6.2). The recovery the research recommends is an idempotent re-subscribe on every boot plus
 * a re-sync with the sender (R5 §6.4 item 3). This section is that re-sync, made automatic.
 *
 * The pairing payload contains the endpoint and the two subscription secrets, so it may never be
 * committed in the clear. It is sealed to the VAPID PUBLIC key — the one key the repository
 * already publishes — with ECIES (ephemeral ECDH P-256 → HKDF-SHA256 → AES-256-GCM), so only the
 * holder of `VAPID_PRIVATE_KEY` (the GitHub Action) can open it. The ciphertext is what lands in
 * the public state file.
 */

/** localStorage key holding the fine-grained GitHub PAT that lets this phone re-pair itself. */
export const GITHUB_TOKEN_KEY = "tradewinds.gh.v1";

/** The repository the dispatch goes to. */
export const REPO_SLUG = "tom-bentley/tradewinds";

/** HKDF `info` — changing it changes the derived key, so it is versioned with the blob. */
export const PAIR_INFO = "tradewinds-pair-v1";

const b64urlFromBytes = (bytes) => {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Seal a pairing payload to the VAPID public key. The result is one base64url string, safe to put
 * in a public repository: without `VAPID_PRIVATE_KEY` it is noise.
 *
 * @param {object} pairing the payload `enableAlerts` produced
 * @param {PushDeps & {randomBytes?: Function}} [deps]
 * @returns {Promise<string>}
 * @throws {Error} when WebCrypto is unavailable — the caller falls back to the manual paste.
 */
export async function pairingBlob(pairing, deps = {}) {
  const d = resolve(deps);
  const subtle = deps.subtle !== undefined ? deps.subtle : d.subtle;
  const random =
    deps.randomBytes ??
    ((n) => (d.win?.crypto ?? globalThis.crypto).getRandomValues(new Uint8Array(n)));
  if (!subtle?.deriveBits) throw new Error("This browser cannot encrypt the pairing code.");

  const serverKey = await subtle.importKey(
    "raw",
    urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  // P-256 ECDH derives the 32-byte x coordinate — the same bytes node's `computeSecret` returns.
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, ephemeral.privateKey, 256);

  const salt = random(16);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const keyBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(PAIR_INFO) },
    hkdfKey,
    256,
  );
  const aesKey = await subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, ["encrypt"]);

  const iv = random(12);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(JSON.stringify(pairing)),
  );
  const epk = await subtle.exportKey("raw", ephemeral.publicKey);

  const envelope = {
    v: 1,
    epk: b64urlFromBytes(epk),
    salt: b64urlFromBytes(salt),
    iv: b64urlFromBytes(iv),
    ct: b64urlFromBytes(ciphertext),
  };
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(envelope)));
}

/** The PAT saved on this device, or "". Never throws. */
export function storedToken(deps = {}) {
  const { storage } = resolve(deps);
  try {
    return String(storage?.getItem(GITHUB_TOKEN_KEY) ?? "");
  } catch {
    return "";
  }
}

/** Save (or, with "", forget) the PAT. Returns false when storage refuses. */
export function saveToken(token, deps = {}) {
  const { storage } = resolve(deps);
  try {
    const value = String(token ?? "").trim();
    if (value) storage?.setItem(GITHUB_TOKEN_KEY, value);
    else storage?.removeItem(GITHUB_TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

/** `github_pat_…12345678` — never render a token in full, not even on the owner's own phone. */
export function maskToken(token) {
  const value = String(token ?? "");
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** What a GitHub dispatch failure means, in words the card can print. */
export const DISPATCH_REASON_TEXT = Object.freeze({
  401: "GitHub rejected the token (401). Paste a fresh fine-grained token.",
  403: "The token is missing the Actions: read and write permission (403).",
  404: "GitHub could not find the repository for this token (404) — check that it is scoped to tom-bentley/tradewinds.",
  422: "GitHub refused the payload (422).",
});

/**
 * Ask GitHub to run the Alerts workflow with a payload, via `repository_dispatch`.
 *
 * The token never leaves this phone except as the `Authorization` header on this one request;
 * api.github.com sends CORS headers, so the browser can call it directly.
 *
 * @param {{event?: string, payload?: object, token?: string, repo?: string, deps?: PushDeps}} options
 * @returns {Promise<{ok: boolean, status: number|null, reason?: string}>}
 */
export async function dispatchToGithub(options = {}, deps = options.deps ?? {}) {
  const d = resolve(deps);
  const token = String(options.token ?? storedToken(deps)).trim();
  if (!token) return { ok: false, status: null, reason: "No GitHub token saved on this phone." };
  if (typeof d.fetchImpl !== "function") return { ok: false, status: null, reason: "This browser cannot reach GitHub." };
  const repo = options.repo ?? REPO_SLUG;
  try {
    const response = await d.fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event_type: options.event ?? "alerts", client_payload: options.payload ?? {} }),
    });
    const status = Number(response?.status ?? 0);
    if (status === 204) return { ok: true, status };
    return { ok: false, status, reason: DISPATCH_REASON_TEXT[status] ?? `GitHub replied ${status || "nothing"}.` };
  } catch (error) {
    return { ok: false, status: null, reason: `Could not reach GitHub: ${error?.message ?? error}` };
  }
}

/**
 * Seal this device's pairing and hand it to the Alerts workflow. One call replaces the whole
 * copy-the-code-and-paste-it-into-a-secret dance — when a token is saved.
 * @param {{pairing?: object, token?: string, repo?: string, deps?: PushDeps}} [options]
 * @returns {Promise<{ok: boolean, status?: number|null, reason?: string, deviceId?: string|null}>}
 */
export async function sendPairing(options = {}, deps = options.deps ?? {}) {
  const pairing = options.pairing ?? storedPairing(deps);
  if (!pairing?.sub?.endpoint) return { ok: false, reason: "Nothing is paired on this phone yet." };
  let blob;
  try {
    blob = await pairingBlob(pairing, deps);
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
  const deviceId = await deviceIdOf(pairing.sub.endpoint, deps);
  const result = await dispatchToGithub(
    {
      event: "pair",
      payload: { v: 1, blob, deviceId, label: pairing.label ?? null },
      token: options.token,
      repo: options.repo,
    },
    deps,
  );
  return { ...result, deviceId };
}

/**
 * Make sure this device HAS a live subscription, re-creating it silently when iOS threw it away.
 *
 * No user gesture is needed here: the gesture requirement in Apple's own guidance is on
 * `Notification.requestPermission()` (WebKit blog 13878 / WWDC22 10098, research R5 §6.1), and
 * permission is already `granted` by the time this runs. If a browser disagrees, `subscribe()`
 * rejects and the caller falls back to the "re-pair" banner — nothing is lost either way.
 *
 * @param {PushDeps} [deps]
 * @returns {Promise<{subscription: object|null, resubscribed: boolean, rotated: boolean,
 *   pairing: object|null, error: string|null}>} `rotated` means the stored pairing was rewritten
 *   (a new subscription, or the same one at a new address) and the sender needs the new code.
 */
export async function ensureSubscription(deps = {}) {
  const d = resolve(deps);
  const pairing = storedPairing(deps);
  const reg = await readyRegistration(d, SW_STATUS_TIMEOUT_MS);
  if (!reg?.pushManager) return { subscription: null, resubscribed: false, pairing, error: "no-service-worker" };

  const subJson = (subscription) =>
    typeof subscription?.toJSON === "function" ? subscription.toJSON() : { endpoint: subscription?.endpoint };

  const existing = await currentSubscription(reg);
  if (existing) {
    // The subscription is alive but at a NEW address. Refresh the stored pairing first, or "Show
    // pairing code" would hand Tom a code for an endpoint nothing listens on any more.
    if (pairing && pairing.sub?.endpoint && pairing.sub.endpoint !== existing.endpoint) {
      const next = { ...pairing, sub: subJson(existing), createdAt: new Date(d.now()).toISOString() };
      savePairing(next, deps);
      return { subscription: existing, resubscribed: false, rotated: true, pairing: next, error: null };
    }
    return { subscription: existing, resubscribed: false, rotated: false, pairing, error: null };
  }
  // Nothing stored to restore, or no permission to restore it with: leave it to the user.
  if (!pairing) return { subscription: null, resubscribed: false, rotated: false, pairing: null, error: null };
  if (d.notification?.permission !== "granted") {
    return { subscription: null, resubscribed: false, rotated: false, pairing, error: "permission" };
  }

  try {
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const next = { ...pairing, sub: subJson(subscription), createdAt: new Date(d.now()).toISOString() };
    savePairing(next, deps);
    return { subscription, resubscribed: true, rotated: true, pairing: next, error: null };
  } catch (error) {
    return { subscription: null, resubscribed: false, rotated: false, pairing, error: String(error?.message ?? error) };
  }
}

/**
 * What the Settings → Alerts card renders. **Async** — it asks the service worker whether a
 * subscription is actually live, which is the only honest answer (the stored pairing can
 * outlive a subscription the OS dropped), and — unless `deps.network === false` — it also asks
 * the SENDER what it believes (design §13.3 B2).
 *
 * @param {PushDeps} [deps] `network: false` keeps it local-only and instant.
 * @returns {Promise<{supported: boolean, reason: string|null, permission: string,
 *   subscribed: boolean, pairing: object|null, endpoint: string|null, deviceId: string|null,
 *   pairedDeviceId: string|null, endpointChanged: boolean, serverPaired: boolean|null,
 *   server: {lastSentAt: string|null, sentCount: number|null, lastResult: object|null,
 *     lastNotifiedAt: string|null, expired: boolean}|null,
 *   lastRunAt: string|null, lastRun: object|null, receipts: object, probed: boolean}>}
 */
export async function alertsStatus(deps = {}) {
  const d = resolve(deps);
  const support = alertsSupported(deps);
  const pairing = storedPairing(deps);
  const permission = typeof d.notification?.permission === "string" ? d.notification.permission : "unsupported";

  let subscribed = Boolean(pairing);
  let live = null;
  const reg = await readyRegistration(d, SW_STATUS_TIMEOUT_MS);
  if (reg) {
    live = await currentSubscription(reg);
    subscribed = Boolean(live);
  }

  const endpoint = live?.endpoint ?? pairing?.sub?.endpoint ?? null;
  const pairedEndpoint = pairing?.sub?.endpoint ?? null;
  const [deviceId, pairedDeviceId] = await Promise.all([
    deviceIdOf(endpoint, deps),
    deviceIdOf(pairedEndpoint, deps),
  ]);
  // The failure this release was written for: the OS handed the app a new endpoint and the
  // GitHub secret still holds the old one, which keeps returning 201 to the sender.
  const endpointChanged = Boolean(deviceId && pairedDeviceId && deviceId !== pairedDeviceId);

  const base = {
    supported: support.ok,
    reason: support.reason,
    permission,
    subscribed,
    pairing,
    endpoint,
    deviceId,
    pairedDeviceId,
    endpointChanged,
    serverPaired: null,
    server: null,
    lastRunAt: null,
    lastRun: null,
    receipts: {
      count24h: 0,
      count: 0,
      lastAt: null,
      lastShown: null,
      failed: 0,
      items: [],
      source: null,
      subscriptionChange: null,
    },
    probed: d.network,
  };
  if (!d.network) return base;

  const [state, lastRun, receipts] = await Promise.all([
    fetchAlertsState(deps),
    fetchLastRun(deps),
    pushReceipts(deps),
  ]);

  // `serverPaired` is a three-state answer on purpose: false means "the sender does not know this
  // phone" (re-pair), null means "we could not ask" (say nothing rather than accuse).
  let serverPaired = null;
  let server = null;
  if (state && state.devices && typeof state.devices === "object") {
    const entry = deviceId ? state.devices[deviceId] : null;
    serverPaired = Boolean(entry);
    if (entry) {
      server = {
        lastSentAt: entry.lastSentAt ?? entry.lastNotifiedAt ?? null,
        lastNotifiedAt: entry.lastNotifiedAt ?? null,
        sentCount: entry.sentCount != null && Number.isFinite(Number(entry.sentCount)) ? Number(entry.sentCount) : null,
        lastResult: entry.lastResult ?? null,
        expired: entry.expired === true,
      };
    }
  }

  return {
    ...base,
    serverPaired,
    server,
    lastRunAt: lastRun?.at ?? null,
    lastRun: lastRun ?? null,
    receipts: receipts ?? base.receipts,
  };
}

/**
 * Update the preferences on the stored pairing (the Settings toggles and the two thresholds).
 *
 * IMPORTANT: this only changes the copy on the phone. The alerts job reads its preferences from
 * the `PUSH_SUBSCRIPTIONS` repository secret, so the new code has to be **re-pasted** there
 * before the job honours the change — the pairing sheet says so, and so should any UI that
 * calls this.
 * @param {object} prefs Partial preferences, merged over the stored ones.
 * @param {PushDeps} [deps]
 * @returns {object|null} the updated pairing, or null when this device is not paired.
 */
export function updatePrefs(prefs, deps = {}) {
  const pairing = storedPairing(deps);
  if (!pairing) return null;
  const next = { ...pairing, prefs: { ...DEFAULT_PREFS, ...(pairing.prefs ?? {}), ...(prefs ?? {}) } };
  savePairing(next, deps);
  return next;
}
