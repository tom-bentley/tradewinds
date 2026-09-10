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

/**
 * What the Settings → Alerts card renders. **Async** — it asks the service worker whether a
 * subscription is actually live, which is the only honest answer (the stored pairing can
 * outlive a subscription the OS dropped).
 * @param {PushDeps} [deps]
 * @returns {Promise<{supported: boolean, reason: string|null, permission: string,
 *   subscribed: boolean, pairing: object|null}>} `reason` is the `alertsSupported()` reason and
 *   is additive to the design's four keys — it saves the UI a second probe.
 */
export async function alertsStatus(deps = {}) {
  const d = resolve(deps);
  const support = alertsSupported(deps);
  const pairing = storedPairing(deps);
  const permission = typeof d.notification?.permission === "string" ? d.notification.permission : "unsupported";

  let subscribed = Boolean(pairing);
  const reg = await readyRegistration(d, SW_STATUS_TIMEOUT_MS);
  if (reg) subscribed = Boolean(await currentSubscription(reg));

  return { supported: support.ok, reason: support.reason, permission, subscribed, pairing };
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
