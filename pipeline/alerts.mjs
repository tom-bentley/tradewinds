#!/usr/bin/env node
// Tradewinds push-alert job (design §11.3, advisor §12.3).
//
//   node pipeline/alerts.mjs                 # diff against data/alerts-state.json, push what is new
//   ALERT_TEST=1 node pipeline/alerts.mjs    # one "alerts are on" push per device, no state change
//   ALERT_DRY=1 ALERT_DRY_LEAGUE=<id> ALERT_DRY_USER=<id> node pipeline/alerts.mjs
//   ALERT_FULL=1 node pipeline/alerts.mjs    # also push advice for standing issues (skips first-run seeding)
//                                            # no secrets, no writes: print what a phone would get
//
// There is no server, so this scheduled Action IS the push sender (§11.1): it signs with VAPID and
// encrypts per RFC 8291 through web-push, which CI installs at run time
// (`npm i --no-save web-push@3.6.7`) so the repo itself stays dependency-free.
//
// Since v1.3 the run also carries the ADVISOR (§12): one position-filtered current-week
// projections call gives every rostered player's live `injury_*`/`news_updated` fields AND fresh
// current-week points, the engine turns the diff against last run's snapshot into "here is what to
// do about it", and that advice outranks trades/deals/free agents in the per-run cap. Advice is
// the whole point of the 10-minute cron: Sleeper tells Tom that Bowers is Doubtful, nothing tells
// him to start Goedert.
//
// Env: PUSH_SUBSCRIPTIONS (JSON array of pairing payloads, §11.4), VAPID_PUBLIC_KEY,
//      VAPID_PRIVATE_KEY, VAPID_SUBJECT (defaults to the Pages URL), ALERT_TEST,
//      ALERT_DRY / ALERT_DRY_LEAGUE / ALERT_DRY_USER,
//      ALERT_WEBHOOKS (optional, §13.3 B3: a JSON array of Discord/Slack/ntfy/plain-JSON URLs
//      treated as extra devices, so an alert the phone never shows still lands somewhere).
// Exit codes: 0 = ran (including "nothing paired"), 1 = misconfigured or every league failed.
//
// Everything above main() is pure: composeAlerts(ctx, device, state, options) decides WHAT to say,
// applyState(state, update) decides what to remember, and main() only wires
// env -> fetch -> engine -> sender -> data/alerts-state.json + data/advisor.json.

import { createDecipheriv, createECDH, createHash, hkdfSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  POLITE_DELAY_MS,
  compareIds,
  fetchJson,
  isoTimestamp,
  numOrNull,
  readJsonIfExists,
  round,
  sleep,
  writeJsonFile,
} from "./util.mjs";
import { ADVISOR_ITEM_LIMIT, ADVISOR_VERSION, validateAdvisor, validateAlertsState } from "./contract.mjs";
import { enqueueAll } from "./queue.mjs";
import { PROJECTION_POSITION_QUERY, textOrNull, weeklyPoints } from "./sources/sleeper.mjs";
import {
  adviseAll,
  applyStatuses,
  applyWeekPoints,
  buildContext,
  diffStatuses,
  findFreeAgents,
  findTrades,
  gradeTransaction,
  playerOf,
  rosterById,
  statusKey,
} from "../src/engine/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the site is served from; also the VAPID `sub:` claim and the base of every deep link. */
export const DEFAULT_SUBJECT = "https://tom-bentley.github.io/tradewinds/";

/** Safe to embed (§11.1). The private half lives only in the GitHub secret VAPID_PRIVATE_KEY. */
export const VAPID_PUBLIC_KEY =
  "BHRrun9caaSWpO0KOYVBrEHU7lo0SJ2qNQ203fkbMP24VIyZTa1Rssxk2XpiFekMscVSUBlj6TakzQ8Xu0l5CQo";

/** A phone that buzzes four times in one cron tick is a phone with alerts switched off. */
export const MAX_PER_DEVICE = 3;

/** Remembered keys per array (§11.3). Older keys fall off the front. */
export const HISTORY_LIMIT = 200;

/** Relative to the Pages scope, so one string works from the SW and from a browser tab. */
export const NOTIFICATION_ICON = "icons/icon-192.png";

/** Drop a push the phone never picked up rather than delivering a stale deal an hour later. */
export const PUSH_TTL_SECONDS = 3600;

/**
 * How long the push service should hold a notification for a phone that is off or out of
 * coverage, per kind (design §13.3 B3). Advice is the only kind worth four hours — a lineup hole
 * still matters when the phone wakes up before kickoff. A trade idea two hours stale is noise.
 */
export const TTL_BY_KIND = Object.freeze({ advice: 4 * 3600, trades: 2 * 3600, deals: 2 * 3600, fa: 2 * 3600 });

/**
 * `Urgency` (RFC 8030 §5.3). Apple throttles background wakeups for low-urgency pushes; advice is
 * the one kind that should wake the phone now, so everything else stays "normal" rather than
 * competing with it.
 */
export const URGENCY_BY_KIND = Object.freeze({ advice: "high" });

/**
 * TTL + urgency for one notification kind.
 * @param {string} kind
 * @returns {{TTL: number, urgency: string}}
 */
export function deliveryOptions(kind) {
  return { TTL: TTL_BY_KIND[kind] ?? PUSH_TTL_SECONDS, urgency: URGENCY_BY_KIND[kind] ?? "normal" };
}

/** Push-service replies that mean "this endpoint is dead, stop sending" (§11.3). */
export const GONE_STATUS_CODES = new Set([404, 410]);

/** Pairing payloads may omit prefs; these are the §11.4/§12.3 defaults. */
export const DEFAULT_PREFS = Object.freeze({
  trades: true,
  deals: true,
  freeAgents: true,
  advice: true,
  rivalNews: false,
  minDealScore: 2,
  minFaGain: 1,
  // v1.4 noise control (design §13.3 B3). Between 2026-09-09 and 2026-09-17 this job sent ~70
  // "New deal to propose" pushes to one phone. A cooldown per kind plus a digest is the
  // difference between an alert and a nag. Advice and completed trades are never throttled.
  dealsCooldownHours: 6,
  faCooldownHours: 6,
  maxDealsPerPush: 1,
});

/** How deep to look before thresholds and the per-run cap trim the list. */
export const MAX_DEALS_SCANNED = 10;
export const MAX_FA_SCANNED = 12;

/**
 * Watched ids missing from the weekly projection rows fall back to one request each (§12.3).
 * Forty is roughly ten seconds of polite sequential calls — enough to cover a normal gap, small
 * enough that a broken projections endpoint cannot turn one run into 140 requests.
 */
export const MAX_STATUS_FALLBACK = 40;

export const SLEEPER_API = "https://api.sleeper.app";
export const TRENDING_URL = `${SLEEPER_API}/v1/players/nfl/trending/add?lookback_hours=24&limit=50`;

/**
 * The one call that carries live statuses for every rostered player (§12.1). Position-filtered
 * (~2 MB instead of 5.7 MB) and cache-busted by the caller — Sleeper's CDN holds these for 600 s
 * and stale injury data is exactly the thing this job exists to beat.
 * @param {string|number} season
 * @param {number} week
 * @returns {string}
 */
export function projectionsUrl(season, week) {
  return `${SLEEPER_API}/projections/nfl/${season}/${week}?season_type=regular&${PROJECTION_POSITION_QUERY}`;
}

/**
 * @param {string} id
 * @returns {string} the per-player fallback endpoint (§12.3)
 */
export function playerUrl(id) {
  return `${SLEEPER_API}/v1/players/nfl/${id}`;
}

/** Pipeline files the engine needs to build a context. */
const DATA_FILES = ["players", "projections", "values", "schedule", "meta"];

/** Truthy env flags, spelled the way a workflow_dispatch boolean input spells them. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEnabled(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

/**
 * Stable per-device id: the endpoint is the only field guaranteed unique, and hashing it keeps
 * push-service URLs out of the committed state file.
 * @param {string} endpoint
 * @returns {string} 16 hex characters
 */
export function deviceKey(endpoint) {
  return createHash("sha256").update(String(endpoint), "utf8").digest("hex").slice(0, 16);
}

/**
 * The same function under the name the app and the service worker use (design §13.3 B2). The
 * three implementations must agree byte for byte or the phone cannot ask "am I in the sender's
 * device list?" — the shared test vector is `https://web.push.apple.com/QF2c-token` →
 * `ee64af5d15e243bb`, asserted here and in `test/data.push.test.mjs`.
 * @param {string} endpoint
 * @returns {string} 16 hex characters
 */
export const deviceIdOf = deviceKey;

/**
 * Fill in the §11.4/§12.3 defaults for a partial (or missing) prefs object. `advice` is on by
 * default (it is the reason the job runs every ten minutes); `rivalNews` is off, because a rival's
 * injury is interesting, not actionable.
 * @param {unknown} prefs
 * @returns {{ trades: boolean, deals: boolean, freeAgents: boolean, advice: boolean,
 *   rivalNews: boolean, minDealScore: number, minFaGain: number }}
 */
export function normalizePrefs(prefs) {
  const raw = prefs && typeof prefs === "object" ? prefs : {};
  const num = (value, fallback) =>
    value != null && Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    trades: raw.trades !== false,
    deals: raw.deals !== false,
    freeAgents: raw.freeAgents !== false,
    advice: raw.advice !== false,
    rivalNews: raw.rivalNews === true,
    minDealScore: num(raw.minDealScore, DEFAULT_PREFS.minDealScore),
    minFaGain: num(raw.minFaGain, DEFAULT_PREFS.minFaGain),
    // The point of filling these here: the pairing code already in PUSH_SUBSCRIPTIONS predates
    // v1.4 and says nothing about cooldowns. It gets them anyway, with no re-paste.
    dealsCooldownHours: Math.max(0, num(raw.dealsCooldownHours, DEFAULT_PREFS.dealsCooldownHours)),
    faCooldownHours: Math.max(0, num(raw.faCooldownHours, DEFAULT_PREFS.faCooldownHours)),
    maxDealsPerPush: Math.max(1, Math.round(num(raw.maxDealsPerPush, DEFAULT_PREFS.maxDealsPerPush))),
  };
}

/* --- self-healing pairing (design §13.3 B5) ---------------------------------------------------
 *
 * The phone cannot edit a repository secret, but it CAN fire a `repository_dispatch` with a
 * fine-grained PAT. It sends its pairing payload sealed to the VAPID PUBLIC key (ECIES: ephemeral
 * ECDH P-256 → HKDF-SHA256 → AES-256-GCM, see `pairingBlob` in src/push.js); this job opens it
 * with `VAPID_PRIVATE_KEY` and files the CIPHERTEXT in data/alerts-state.json. The state file is
 * public, so what lands there has to be unreadable without the private key — and it is.
 *
 * Why it matters (research R5 §6.2): iOS does not reliably fire `pushsubscriptionchange`, there is
 * no `expirationTime`, and web.push.apple.com answers 201 for a subscription it has already
 * discarded. A phone whose endpoint rotates is therefore invisible to the sender forever. This is
 * the path that lets the phone say "I moved" without a human copying a code at all.
 */

/** HKDF `info`; must match `PAIR_INFO` in src/push.js byte for byte. */
export const PAIR_INFO = "tradewinds-pair-v1";

/** AES-GCM authentication tag length, in bytes. */
const GCM_TAG_BYTES = 16;

const fromB64Url = (value) => Buffer.from(String(value ?? ""), "base64url");

/**
 * Open a sealed pairing blob. Throws on anything that is not exactly what `pairingBlob` produced —
 * a tampered ciphertext fails the GCM tag, which is the point of using GCM.
 *
 * @param {string} blob base64url of the JSON envelope `{v, epk, salt, iv, ct}`
 * @param {string} vapidPrivateKey base64url of the 32-byte P-256 scalar (the GitHub secret)
 * @returns {object} the pairing payload
 */
export function decryptPairingBlob(blob, vapidPrivateKey) {
  const text = fromB64Url(blob).toString("utf8");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new Error(`pairing blob is not an envelope: ${error.message}`);
  }
  if (!envelope || envelope.v !== 1) throw new Error(`unsupported pairing blob version ${envelope?.v}`);

  const epk = fromB64Url(envelope.epk);
  if (epk.length !== 65 || epk[0] !== 4) throw new Error("pairing blob: ephemeral key is not an uncompressed P-256 point");
  const salt = fromB64Url(envelope.salt);
  const iv = fromB64Url(envelope.iv);
  const ct = fromB64Url(envelope.ct);
  if (iv.length !== 12) throw new Error("pairing blob: iv must be 12 bytes");
  if (ct.length <= GCM_TAG_BYTES) throw new Error("pairing blob: ciphertext too short");

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(fromB64Url(vapidPrivateKey));
  // P-256 ECDH yields the 32-byte x coordinate — the same bytes WebCrypto's deriveBits returns.
  const shared = ecdh.computeSecret(epk);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(PAIR_INFO, "utf8"), 32));

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_BYTES));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/**
 * `github.event.client_payload`, as the workflow hands it over (`toJson`, so "{}" for every other
 * trigger). Never throws.
 * @param {unknown} raw
 * @returns {{ blob: string|null, deviceId: string|null, label: string|null, test: boolean }}
 */
export function parseDispatchPayload(raw) {
  const text = raw == null ? "" : String(raw).trim();
  if (!text || text === "null") return { blob: null, deviceId: null, label: null, test: false };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { blob: null, deviceId: null, label: null, test: false };
  }
  if (!parsed || typeof parsed !== "object") return { blob: null, deviceId: null, label: null, test: false };
  return {
    blob: typeof parsed.blob === "string" && parsed.blob ? parsed.blob : null,
    deviceId: typeof parsed.deviceId === "string" && parsed.deviceId ? parsed.deviceId : null,
    label: typeof parsed.label === "string" && parsed.label ? parsed.label : null,
    test: parsed.test === true || parsed.test === "true",
  };
}

/**
 * Is this decrypted payload something we are willing to push to? Same bar as a pasted pairing.
 * @param {unknown} pairing
 * @returns {string[]} problems; empty means good
 */
export function validatePairing(pairing) {
  /** @type {string[]} */
  const problems = [];
  if (!pairing || typeof pairing !== "object") return ["pairing is not an object"];
  if (pairing.v !== 1) problems.push(`pairing.v must be 1, got ${JSON.stringify(pairing.v)}`);
  const sub = pairing.sub && typeof pairing.sub === "object" ? pairing.sub : null;
  const endpoint = sub && typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  if (!/^https:\/\//i.test(endpoint)) problems.push("pairing.sub.endpoint must be an https url");
  const keys = sub?.keys && typeof sub.keys === "object" ? sub.keys : {};
  if (typeof keys.p256dh !== "string" || !keys.p256dh) problems.push("pairing.sub.keys.p256dh is missing");
  if (typeof keys.auth !== "string" || !keys.auth) problems.push("pairing.sub.keys.auth is missing");
  if (!String(pairing.leagueId ?? "").trim()) problems.push("pairing.leagueId is missing");
  return problems;
}

/**
 * File a new pairing (ciphertext only) and retire whatever it replaces.
 *
 * "Replaces" is (userId, label): the same phone, re-subscribed. Its old entry is not deleted —
 * marking it `supersededBy` keeps the history readable in the doctor and in git, and one line in
 * the log says which id took over.
 *
 * @param {object} state
 * @param {{ id: string, blob: string, label?: string|null, userId?: string|null,
 *   leagueId?: string|null, createdAt?: string|null }} pairing
 * @returns {{ state: object, superseded: string[] }}
 */
export function applyPairing(state, pairing) {
  const next = canonicalState(state);
  const pairings = { ...(next.pairings || {}) };
  /** @type {string[]} */
  const superseded = [];
  const sameDevice = (entry) =>
    String(entry?.userId ?? "") === String(pairing.userId ?? "") &&
    String(entry?.label ?? "") === String(pairing.label ?? "");

  for (const [id, entry] of Object.entries(pairings)) {
    if (id === pairing.id || !sameDevice(entry)) continue;
    pairings[id] = { ...entry, supersededBy: pairing.id };
    superseded.push(id);
  }
  pairings[pairing.id] = {
    blob: String(pairing.blob),
    label: pairing.label ?? null,
    userId: pairing.userId ?? null,
    leagueId: pairing.leagueId ?? null,
    createdAt: pairing.createdAt ?? null,
  };
  return { state: canonicalState({ ...next, pairings }), superseded };
}

/**
 * The devices the state file's own pairings describe. A superseded entry is skipped: it is history,
 * not a destination.
 * @param {object} state
 * @param {string} vapidPrivateKey
 * @param {(id: string, message: string) => void} [onProblem]
 * @returns {object[]} devices in the shape `parseSubscriptions` produces
 */
export function pairedDevices(state, vapidPrivateKey, onProblem) {
  /** @type {object[]} */
  const devices = [];
  const pairings = (state && state.pairings) || {};
  if (!vapidPrivateKey) return devices;
  for (const id of Object.keys(pairings).sort()) {
    const entry = pairings[id] || {};
    if (entry.supersededBy) continue;
    let pairing;
    try {
      pairing = decryptPairingBlob(entry.blob, vapidPrivateKey);
    } catch (error) {
      if (onProblem) onProblem(id, `could not be decrypted (${error.message})`);
      continue;
    }
    const problems = validatePairing(pairing);
    if (problems.length) {
      if (onProblem) onProblem(id, problems[0]);
      continue;
    }
    const endpoint = String(pairing.sub.endpoint).trim();
    devices.push({
      id: deviceIdOf(endpoint),
      sub: { endpoint, keys: { p256dh: pairing.sub.keys.p256dh, auth: pairing.sub.keys.auth } },
      endpoint,
      leagueId: String(pairing.leagueId),
      userId: pairing.userId == null ? null : String(pairing.userId),
      label: String(entry.label || pairing.label || `device ${id.slice(0, 6)}`),
      prefs: normalizePrefs(pairing.prefs),
      createdAt: pairing.createdAt ?? entry.createdAt ?? null,
      selfPaired: true,
    });
  }
  return devices;
}

/**
 * One device list from the two sources. A pairing the phone filed itself WINS over the pasted
 * secret for the same (userId, label): the phone knows its current endpoint, the secret does not.
 * @param {object[]} fromSecret
 * @param {object[]} fromPairings
 * @returns {{ devices: object[], superseded: { id: string, by: string, label: string }[] }}
 */
export function mergeDevices(fromSecret, fromPairings) {
  const byId = new Map();
  /** @type {{ id: string, by: string, label: string }[]} */
  const superseded = [];
  for (const device of fromPairings) byId.set(device.id, device);

  for (const device of fromSecret) {
    if (byId.has(device.id)) continue;
    const newer = fromPairings.find(
      (paired) =>
        String(paired.userId ?? "") === String(device.userId ?? "") &&
        String(paired.label ?? "") === String(device.label ?? ""),
    );
    if (newer) {
      superseded.push({ id: device.id, by: newer.id, label: device.label });
      continue;
    }
    byId.set(device.id, device);
  }
  return { devices: [...byId.values()], superseded };
}

/**
 * Parse PUSH_SUBSCRIPTIONS. Never throws: a malformed row is reported and skipped so one bad paste
 * cannot silence every other device.
 * @param {unknown} raw JSON text — an array of pairing payloads, or a single one
 * @returns {{ devices: object[], problems: string[] }}
 */
export function parseSubscriptions(raw) {
  /** @type {string[]} */
  const problems = [];
  const text = raw == null ? "" : String(raw).trim();
  if (text === "") return { devices: [], problems };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { devices: [], problems: [`PUSH_SUBSCRIPTIONS is not valid JSON: ${error.message}`] };
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  /** @type {object[]} */
  const devices = [];
  /** @type {Set<string>} */
  const seen = new Set();

  rows.forEach((row, index) => {
    const pairing = row && typeof row === "object" ? row : {};
    const sub = pairing.sub && typeof pairing.sub === "object" ? pairing.sub : null;
    const endpoint = sub && typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
    if (!endpoint) {
      problems.push(`subscription[${index}]: no sub.endpoint`);
      return;
    }
    const keys = sub.keys && typeof sub.keys === "object" ? sub.keys : {};
    if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || !keys.p256dh || !keys.auth) {
      problems.push(`subscription[${index}]: sub.keys needs both p256dh and auth`);
      return;
    }
    const leagueId = String(pairing.leagueId ?? "").trim();
    if (!leagueId) {
      problems.push(`subscription[${index}]: no leagueId`);
      return;
    }
    const id = deviceKey(endpoint);
    if (seen.has(id)) {
      problems.push(`subscription[${index}]: duplicate endpoint (device ${id})`);
      return;
    }
    seen.add(id);
    devices.push({
      id,
      sub: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      endpoint,
      leagueId,
      userId: pairing.userId == null ? null : String(pairing.userId),
      label:
        typeof pairing.label === "string" && pairing.label.trim()
          ? pairing.label.trim()
          : `device ${id.slice(0, 6)}`,
      prefs: normalizePrefs(pairing.prefs),
      createdAt: pairing.createdAt ?? null,
    });
  });

  return { devices, problems };
}

/**
 * @returns {{ v: number, leagues: Record<string, any>, devices: Record<string, any> }}
 */
export function emptyState() {
  return { v: 1, leagues: {}, devices: {} };
}

/**
 * Keep the newest keys, drop duplicates, bound the array (§11.3).
 * @param {string[]} existing
 * @param {string[]} added
 * @returns {string[]}
 */
function bounded(existing, added) {
  const fresh = new Set(added);
  const kept = (existing || []).filter((key) => !fresh.has(key));
  return [...kept, ...added].slice(-HISTORY_LIMIT);
}

/**
 * Rebuild the state with a fixed key order and bounded arrays, so an unchanged run produces a
 * byte-identical file and a changed one produces a small diff.
 * @param {object} state
 * @returns {object}
 */
export function canonicalState(state) {
  const source = state && typeof state === "object" ? state : emptyState();
  /** @type {Record<string, any>} */
  const leagues = {};
  for (const leagueId of Object.keys(source.leagues || {}).sort()) {
    const entry = source.leagues[leagueId] || {};
    /** @type {Record<string, string>} */
    const status = {};
    const rawStatus = entry.status && typeof entry.status === "object" ? entry.status : {};
    for (const id of Object.keys(rawStatus).sort(compareIds)) status[id] = String(rawStatus[id]);
    leagues[leagueId] = {
      seenTradeIds: [...(entry.seenTradeIds || [])].slice(-HISTORY_LIMIT),
      week: Number.isFinite(entry.week) ? Number(entry.week) : null,
      status,
      statusAt: entry.statusAt ?? null,
    };
  }
  /** @type {Record<string, any>} */
  const devices = {};
  for (const deviceId of Object.keys(source.devices || {}).sort()) {
    const entry = source.devices[deviceId] || {};
    /** @type {Record<string, any>} */
    const device = {
      seenDeals: [...(entry.seenDeals || [])].slice(-HISTORY_LIMIT),
      seenFa: [...(entry.seenFa || [])].slice(-HISTORY_LIMIT),
      seenAdvice: [...(entry.seenAdvice || [])].slice(-HISTORY_LIMIT),
      lastNotifiedAt: entry.lastNotifiedAt ?? null,
    };
    // The §13.3 B3 server view. Written ONLY once a send has happened, so a device entry from
    // before v1.4 — and every quiet run afterwards — still serializes byte for byte as it did.
    if (entry.lastSentAt) device.lastSentAt = entry.lastSentAt;
    if (entry.sentCount != null && Number.isFinite(Number(entry.sentCount))) {
      device.sentCount = Number(entry.sentCount);
    }
    if (entry.lastResult && typeof entry.lastResult === "object") {
      device.lastResult = {
        status: entry.lastResult.status ?? null,
        at: entry.lastResult.at ?? null,
        ...(entry.lastResult.detail ? { detail: String(entry.lastResult.detail) } : {}),
      };
    }
    if (entry.lastKindAt && typeof entry.lastKindAt === "object") {
      /** @type {Record<string, string>} */
      const lastKindAt = {};
      for (const kind of Object.keys(entry.lastKindAt).sort()) {
        if (entry.lastKindAt[kind]) lastKindAt[kind] = String(entry.lastKindAt[kind]);
      }
      if (Object.keys(lastKindAt).length) device.lastKindAt = lastKindAt;
    }
    if (entry.expired === true) device.expired = true;
    devices[deviceId] = device;
  }

  // §13.3 B5 — pairings the phones filed themselves, ciphertext only. The key is omitted entirely
  // when there are none, so a state file written before v1.4 serializes exactly as it did.
  /** @type {Record<string, any>} */
  const pairings = {};
  for (const id of Object.keys(source.pairings || {}).sort()) {
    const entry = source.pairings[id] || {};
    if (typeof entry.blob !== "string" || !entry.blob) continue;
    /** @type {Record<string, any>} */
    const row = {
      blob: entry.blob,
      label: entry.label ?? null,
      userId: entry.userId == null ? null : String(entry.userId),
      leagueId: entry.leagueId == null ? null : String(entry.leagueId),
      createdAt: entry.createdAt ?? null,
    };
    if (entry.supersededBy) row.supersededBy = String(entry.supersededBy);
    pairings[id] = row;
  }

  const canonical = { v: 1, leagues, devices };
  if (Object.keys(pairings).length) canonical.pairings = pairings;
  return canonical;
}

/**
 * Fold one device's run into the state. Pure: returns a new object and never mutates the input, so
 * every device in a league composes against the same pre-run snapshot (§11.3 diffing).
 * @param {object} state previous state
 * @param {{ leagueId?: string, week?: number|null, status?: Record<string, string>|null,
 *   statusAt?: string|null, deviceId?: string,
 *   seen?: { trades?: string[], deals?: string[], fa?: string[], advice?: string[] },
 *   notifiedAt?: string|null, expired?: boolean }} [update]
 * @returns {object} the next state
 */
export function applyState(state, update = {}) {
  const next = canonicalState(state);
  const {
    leagueId,
    week,
    status,
    statusAt,
    deviceId,
    seen = {},
    notifiedAt = null,
    expired,
    sent = null,
    lastKindAt = null,
  } = update;

  if (leagueId) {
    const entry = next.leagues[leagueId] || { seenTradeIds: [], week: null, status: {}, statusAt: null };
    if (seen.trades && seen.trades.length) entry.seenTradeIds = bounded(entry.seenTradeIds, seen.trades);
    if (Number.isFinite(week)) entry.week = Number(week);
    if (status && typeof status === "object") entry.status = { ...status };
    if (statusAt) entry.statusAt = statusAt;
    next.leagues[leagueId] = entry;
  }

  if (deviceId) {
    const previous = next.devices[deviceId];
    const touched =
      (seen.deals && seen.deals.length) ||
      (seen.fa && seen.fa.length) ||
      (seen.advice && seen.advice.length) ||
      Boolean(notifiedAt) ||
      Boolean(sent) ||
      Boolean(lastKindAt && Object.keys(lastKindAt).length) ||
      expired === true;
    if (previous || touched) {
      const entry = previous || { seenDeals: [], seenFa: [], seenAdvice: [], lastNotifiedAt: null };
      if (seen.deals && seen.deals.length) entry.seenDeals = bounded(entry.seenDeals, seen.deals);
      if (seen.fa && seen.fa.length) entry.seenFa = bounded(entry.seenFa, seen.fa);
      if (seen.advice && seen.advice.length) entry.seenAdvice = bounded(entry.seenAdvice, seen.advice);
      if (notifiedAt) entry.lastNotifiedAt = notifiedAt;
      // The server view (§13.3 B3): what the sender believes it did for this device, so the app
      // can compare it against what the phone actually showed.
      if (sent) {
        if (sent.at) entry.lastSentAt = sent.at;
        if (Number.isFinite(Number(sent.count)) && Number(sent.count) > 0) {
          entry.sentCount = Number(entry.sentCount || 0) + Number(sent.count);
        }
        if (sent.result) entry.lastResult = sent.result;
      }
      if (lastKindAt && Object.keys(lastKindAt).length) {
        entry.lastKindAt = { ...(entry.lastKindAt || {}), ...lastKindAt };
      }
      if (expired === true) entry.expired = true;
      next.devices[deviceId] = entry;
    }
  }

  return canonicalState(next);
}

/**
 * Read data/alerts-state.json. A missing or invalid file starts a fresh state rather than failing
 * the run — the worst case is one repeated notification.
 * @param {string} file
 * @param {(kind: string, id: string, detail: string) => void} [status]
 * @returns {object}
 */
export function loadState(file, status) {
  const raw = readJsonIfExists(file);
  if (raw == null) return emptyState();
  const problems = validateAlertsState(raw);
  if (problems.length) {
    if (status) status("warn", "state", `${file} rejected (${problems[0]}) — starting fresh`);
    return emptyState();
  }
  return canonicalState(raw);
}

/**
 * Sleeper transaction -> the normalized shape buildContext and gradeTransaction expect. Same logic
 * as src/data.js `normalizeTransaction` (copied, not imported: data.js is a browser module).
 * @param {any} raw
 * @param {number} round
 * @returns {object}
 */
export function normalizeTransaction(raw, round) {
  return {
    id: String(raw?.transaction_id ?? ""),
    week: Number(raw?.leg ?? round) || round,
    type: raw?.type ?? "unknown",
    status: raw?.status ?? "unknown",
    created: Number(raw?.created ?? raw?.status_updated ?? 0),
    adds: raw?.adds ?? {},
    drops: raw?.drops ?? {},
    rosterIds: Array.isArray(raw?.roster_ids) ? raw.roster_ids : [],
    draftPicks: Array.isArray(raw?.draft_picks) ? raw.draft_picks : [],
  };
}

// --- live statuses (§12.3) ---------------------------------------------------------------------

/**
 * Split one week of raw Sleeper projection rows into what the advisor needs: the status of every
 * player in the payload, and that player's raw current-week `stats` so each league can score them
 * with its own `scoring_settings`. Pure — the fetching lives in main().
 *
 * Every row carries `player.injury_status`/`injury_body_part`/`injury_notes`/`news_updated`, which
 * is why one 2 MB call replaces ~140 per-player requests (§12.1). `depth_chart_order` is absent
 * from these rows in practice; it stays in the shape because the per-player fallback does carry it.
 *
 * @param {unknown} rows raw rows from `/projections/nfl/{season}/{week}`
 * @returns {{ statuses: { id: string, inj: string|null, injPart: string|null,
 *   injNotes: string|null, newsAt: number|null, dc: number|null }[],
 *   stats: Map<string, Record<string, number>> }}
 */
export function statusRowsFromProjections(rows) {
  /** @type {{ id: string, inj: string|null, injPart: string|null, injNotes: string|null,
   *   newsAt: number|null, dc: number|null }[]} */
  const statuses = [];
  /** @type {Map<string, Record<string, number>>} */
  const stats = new Map();
  /** @type {Set<string>} */
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row && typeof row.player_id === "string" ? row.player_id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const player = row.player && typeof row.player === "object" ? row.player : {};
    statuses.push({
      id,
      inj: textOrNull(player.injury_status),
      injPart: textOrNull(player.injury_body_part),
      injNotes: textOrNull(player.injury_notes),
      newsAt: numOrNull(player.news_updated),
      dc: numOrNull(player.depth_chart_order),
    });
    if (row.stats && typeof row.stats === "object") stats.set(id, row.stats);
  }
  return { statuses, stats };
}

/**
 * The same status row from `GET /v1/players/nfl/{id}` — the fallback for watched ids the weekly
 * projections do not list (a player with no projected game still has news).
 * @param {string} id
 * @param {unknown} raw the endpoint's body: the player row, or `{ [id]: row }`
 * @returns {{ id: string, inj: string|null, injPart: string|null, injNotes: string|null,
 *   newsAt: number|null, dc: number|null }}
 */
export function statusRowFromPlayer(id, raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const player = body[id] && typeof body[id] === "object" ? body[id] : body;
  return {
    id: String(id),
    inj: textOrNull(player.injury_status),
    injPart: textOrNull(player.injury_body_part),
    injNotes: textOrNull(player.injury_notes),
    newsAt: numOrNull(player.news_updated),
    dc: numOrNull(player.depth_chart_order),
  };
}

/**
 * League-exact current-week points for every watched id the projections covered, ready for
 * `applyWeekPoints`. Sleeper re-projects within hours of an injury (Bowers 12.71 -> 0), which is
 * the number that decides whether the lineup actually has a hole (§12.1).
 * @param {Map<string, Record<string, number>>} stats id -> raw stat line
 * @param {Iterable<string>} watch ids worth scoring
 * @param {Record<string, number>|null|undefined} scoring the league's `scoring_settings`
 * @param {number} week
 * @returns {{ id: string, week: number, pts: number }[]} ordered by id
 */
export function weekPointRows(stats, watch, scoring, week) {
  /** @type {{ id: string, week: number, pts: number }[]} */
  const rows = [];
  for (const id of [...watch].sort(compareIds)) {
    const line = stats.get(id);
    if (!line) continue;
    rows.push({ id, week, pts: round(weeklyPoints(line, scoring), 2) });
  }
  return rows;
}

/**
 * The watch set: every id on a roster, on IR or on the taxi squad in this league (§12.3). Read off
 * the raw Sleeper rosters because it is needed before any context is built.
 * @param {any[]} rosters
 * @returns {Set<string>}
 */
export function watchSet(rosters) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const roster of Array.isArray(rosters) ? rosters : []) {
    for (const field of ["players", "reserve", "taxi"]) {
      for (const id of Array.isArray(roster?.[field]) ? roster[field] : []) {
        if (id != null && id !== "") ids.add(String(id));
      }
    }
  }
  return ids;
}

/**
 * This run's status snapshot for one league, as `Record<id, StatusKey>`.
 *
 * Only the watch set is kept, so a player who left every roster disappears from the file. A
 * watched id we did NOT see this run (missing from the projections and past the fallback budget)
 * keeps its previous key rather than vanishing: dropping it would make the next sighting look like
 * a first sighting, and `diffStatuses` would swallow the very transition this job exists to catch.
 *
 * @param {Record<string, string>|null|undefined} previous last run's snapshot
 * @param {Set<string>} watch every id on a roster/reserve/taxi in this league
 * @param {{ id: string }[]} rows status rows observed this run
 * @returns {Record<string, string>} ids in stable order
 */
export function nextStatusSnapshot(previous, watch, rows) {
  /** @type {Map<string, string>} */
  const observed = new Map();
  for (const row of rows || []) {
    if (!row || !watch.has(String(row.id))) continue;
    observed.set(String(row.id), statusKey(row));
  }
  /** @type {Record<string, string>} */
  const snapshot = {};
  const carried = previous && typeof previous === "object" ? previous : {};
  for (const id of [...watch].sort(compareIds)) {
    if (observed.has(id)) snapshot[id] = observed.get(id);
    else if (Object.prototype.hasOwnProperty.call(carried, id)) snapshot[id] = carried[id];
  }
  return snapshot;
}

// --- notification text -------------------------------------------------------------------------

/**
 * @param {number} value
 * @param {number} [decimals]
 * @returns {string} "+2.1" / "-0.4" / "+12"
 */
export function signed(value, decimals = 1) {
  const number = Number.isFinite(Number(value)) ? Number(value) : 0;
  const body = Math.abs(number).toFixed(decimals);
  // "-0 %" reads like a bug; anything that rounds to zero is written "+0".
  const negative = number < 0 && Number(body) !== 0;
  return `${negative ? "-" : "+"}${body}`;
}

/**
 * @param {object} ctx
 * @param {string} id
 * @returns {string}
 */
function nameOf(ctx, id) {
  const player = playerOf(ctx, id);
  return (player && player.name) || String(id);
}

/**
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {string}
 */
function namesOf(ctx, ids) {
  const list = (ids || []).map((id) => nameOf(ctx, id));
  if (!list.length) return "nothing";
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 2).join(", ")} +${list.length - 2} more`;
}

/**
 * Team name if the manager set one, else the Sleeper display name.
 * @param {object} ctx
 * @param {number|null} rosterId
 * @returns {string}
 */
function teamLabel(ctx, rosterId) {
  const roster = rosterById(ctx, rosterId);
  if (!roster) return rosterId == null ? "Unknown team" : `Roster ${rosterId}`;
  return roster.teamName || roster.displayName || `Roster ${roster.rosterId}`;
}

/**
 * Stable identity for a proposal, so the same shortlist entry never fires twice (§11.3).
 * @param {{ theirRosterId: number, give: string[], get: string[] }} deal
 * @returns {string}
 */
export function dealKey(deal) {
  const give = [...(deal.give || [])].sort().join(",");
  const get = [...(deal.get || [])].sort().join(",");
  return `${deal.theirRosterId}:${give}>${get}`;
}

/**
 * Free-agent suggestions are keyed by the player to ADD only: the best drop shifts around as
 * lineups change, and re-alerting for the same add would be noise.
 * @param {{ add: string }} candidate
 * @returns {string}
 */
export function faKey(candidate) {
  return String(candidate.add);
}

/**
 * The wire payload the service worker reads (§11.3). Extra bookkeeping fields never ship.
 * @param {{ title: string, body: string, tag: string, url: string }} notification
 * @returns {{ title: string, body: string, tag: string, url: string, icon: string }}
 */
export function payloadOf(notification) {
  return {
    title: notification.title,
    body: notification.body,
    tag: notification.tag,
    url: notification.url,
    icon: NOTIFICATION_ICON,
    // §13.3 B1: the worker files its receipt under this, so the Diagnose sheet can say WHICH
    // kind of alert this phone did and did not show.
    kind: notification.kind ?? null,
  };
}

/**
 * The ALERT_TEST payload — proves pairing end to end without touching state (§11.3).
 * @param {string} subject
 * @returns {{ title: string, body: string, tag: string, url: string }}
 */
export function testPayload(subject) {
  return {
    title: "Tradewinds alerts are on",
    body: "You will hear about new trades and deals here.",
    tag: "test",
    url: subject || DEFAULT_SUBJECT,
  };
}

// --- composition -------------------------------------------------------------------------------

/**
 * Completed trades the league has not been told about yet, oldest first.
 * @param {object} ctx
 * @param {Set<string>} seenTrades
 * @param {string} url
 * @param {string[]} problems
 * @returns {object[]} notification candidates
 */
function tradeCandidates(ctx, seenTrades, url, problems) {
  const all = Array.isArray(ctx.transactions) ? ctx.transactions : [];
  const fresh = all
    .filter((txn) => txn && txn.type === "trade" && txn.status === "complete")
    .filter((txn) => txn.id && !seenTrades.has(String(txn.id)))
    .sort((a, b) => (a.created || 0) - (b.created || 0));

  return fresh.map((txn) => {
    let grade = null;
    try {
      grade = gradeTransaction(ctx, txn);
    } catch (error) {
      problems.push(`grading trade ${txn.id} failed: ${error.message}`);
    }
    // adds map player -> receiving roster (§11.2), which is unambiguous even without a grade.
    const adds = txn.adds || {};
    const involved = txn.rosterIds && txn.rosterIds.length ? [...txn.rosterIds] : [...new Set(Object.values(adds))];
    const a = grade && grade.a != null ? grade.a : involved[0] ?? null;
    const b =
      grade && grade.b != null ? grade.b : involved.find((rosterId) => rosterId !== a) ?? involved[1] ?? null;
    const gets =
      grade && Array.isArray(grade.get) && grade.get.length
        ? grade.get
        : Object.keys(adds).filter((id) => adds[id] === a);
    const gives =
      grade && Array.isArray(grade.give) && grade.give.length
        ? grade.give
        : Object.keys(adds).filter((id) => adds[id] === b);
    const aName = teamLabel(ctx, a);
    const bName = teamLabel(ctx, b);
    const parts = [`${aName} gets ${namesOf(ctx, gets)}`, `${bName} gets ${namesOf(ctx, gives)}`];
    if (grade && Number.isFinite(Number(grade.edgeA)) && Number.isFinite(Number(grade.deltaA))) {
      parts.push(`${aName} ${signed(grade.edgeA, 0)} % / ${signed(grade.deltaA, 1)} pts/wk`);
    }
    return {
      kind: "trades",
      key: String(txn.id),
      keys: [String(txn.id)],
      title: `Trade: ${aName} ⇄ ${bName}`,
      body: parts.join(" · "),
      tag: `trade-${txn.id}`,
      url,
      summary: `${aName} ⇄ ${bName}`,
    };
  });
}

/**
 * Finder proposals above the device's score threshold that it has not seen.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {object} prefs
 * @param {Set<string>} seenDeals
 * @param {string} url
 * @param {string[]} problems
 * @returns {object[]}
 */
function dealCandidates(ctx, rosterId, prefs, seenDeals, url, problems) {
  /** @type {any[]} */
  let deals = [];
  try {
    deals = findTrades(ctx, { myRosterId: rosterId, maxResults: MAX_DEALS_SCANNED }) || [];
  } catch (error) {
    problems.push(`findTrades failed: ${error.message}`);
    return [];
  }
  return deals
    .filter((deal) => Number(deal.score) >= prefs.minDealScore)
    .map((deal) => ({ deal, key: dealKey(deal) }))
    .filter(({ key }) => !seenDeals.has(key))
    .map(({ deal, key }) => {
      const them = teamLabel(ctx, deal.theirRosterId);
      const swap = `send ${namesOf(ctx, deal.give)} to ${them} for ${namesOf(ctx, deal.get)}`;
      const gain = `${signed(deal.myDeltaPerWeek, 1)} pts/wk, ${signed(deal.myEdgePct, 0)} % value`;
      return {
        kind: "deals",
        key,
        keys: [key],
        title: "New deal to propose",
        body: `${swap.charAt(0).toUpperCase()}${swap.slice(1)} · ${gain}`,
        tag: `deal-${key}`,
        url,
        summary: `${swap} (${signed(deal.myDeltaPerWeek, 1)} pts/wk)`,
      };
    });
}

/**
 * Free agents worth a roster spot that the device has not seen.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {object} prefs
 * @param {Set<string>} seenFa
 * @param {string} url
 * @param {string[]} problems
 * @returns {object[]}
 */
function faCandidates(ctx, rosterId, prefs, seenFa, url, problems) {
  /** @type {any[]} */
  let candidates = [];
  try {
    candidates =
      findFreeAgents(ctx, {
        rosterId,
        maxResults: MAX_FA_SCANNED,
        minGainPerWeek: prefs.minFaGain,
      }) || [];
  } catch (error) {
    problems.push(`findFreeAgents failed: ${error.message}`);
    return [];
  }
  return candidates
    .filter((candidate) => Number(candidate.gainPerWeek) >= prefs.minFaGain)
    .map((candidate) => ({ candidate, key: faKey(candidate) }))
    .filter(({ key }) => !seenFa.has(key))
    .map(({ candidate, key }) => {
      const move = candidate.drop
        ? `Add ${nameOf(ctx, candidate.add)}, drop ${nameOf(ctx, candidate.drop)}`
        : `Add ${nameOf(ctx, candidate.add)} to an open spot`;
      const body = `${move} (${signed(candidate.gainPerWeek, 1)} pts/wk)`;
      return {
        kind: "fa",
        key,
        keys: [key],
        title: "Free agent worth a drop",
        body,
        tag: `fa-${key}`,
        url,
        summary: `${move.charAt(0).toLowerCase()}${move.slice(1)} (${signed(candidate.gainPerWeek, 1)} pts/wk)`,
      };
    });
}

/**
 * The engine's advisories for this device, as notification candidates (§12.3).
 *
 * `seenAdvice` is keyed on `${id}:${statusKey}`, so a player re-alerts only when his status, body
 * part or note actually changes — `news_updated` ticking on its own never buzzes the phone. Rival
 * and free-agent news is severity "low" and stays out unless the device asked for it.
 *
 * @param {object[]} advisories from adviseAll, already sorted by severity then recency
 * @param {object} prefs
 * @param {Set<string>} seenAdvice
 * @param {string} url
 * @returns {object[]}
 */
function adviceCandidates(advisories, prefs, seenAdvice, url) {
  return advisories
    .filter((advisory) => advisory && typeof advisory.key === "string" && advisory.key !== "")
    .filter((advisory) => !seenAdvice.has(advisory.key))
    .filter((advisory) => advisory.severity !== "low" || prefs.rivalNews)
    .map((advisory) => ({
      kind: "advice",
      key: advisory.key,
      keys: [advisory.key],
      title: advisory.headline,
      body: advisory.summary,
      tag: `advice-${advisory.id}`,
      url,
      summary: advisory.summary,
    }));
}

/**
 * Collapse a whole kind into one notification when it will not fit under the per-run cap.
 * @param {string} kind
 * @param {object[]} items
 * @param {string} url
 * @returns {object}
 */
function batchOf(kind, items, url) {
  const keys = items.map((item) => item.key);
  if (kind === "advice") {
    return {
      kind,
      key: null,
      keys,
      title: `${items.length} status changes on your roster`,
      body: `most urgent: ${items[0].summary}`,
      tag: "advice",
      url,
      batched: true,
    };
  }
  if (kind === "trades") {
    const latest = items[items.length - 1];
    return {
      kind,
      key: null,
      keys,
      title: "New trades in the league",
      body: `${items.length} new trades — latest: ${latest.summary}`,
      tag: "trades",
      url,
      batched: true,
    };
  }
  if (kind === "deals") {
    return {
      kind,
      key: null,
      keys,
      title: "New deals to propose",
      body: `${items.length} new deals — best: ${items[0].summary}`,
      tag: "deals",
      url,
      batched: true,
    };
  }
  return {
    kind,
    key: null,
    keys,
    title: "Free agents worth a drop",
    body: `${items.length} new free agents — best: ${items[0].summary}`,
    tag: "fa",
    url,
    batched: true,
  };
}

/** notification.kind -> the seen-bucket that remembers it. */
const SEEN_BUCKETS = Object.freeze({ trades: "trades", deals: "deals", fa: "fa", advice: "advice" });

/** Kinds a cooldown applies to, and the pref that sets it (design §13.3 B3). */
const COOLDOWN_PREF = Object.freeze({ deals: "dealsCooldownHours", fa: "faCooldownHours" });

/**
 * Is this kind still inside its cooldown for this device?
 *
 * Only `deals` and `fa` are ever throttled: they are standing suggestions that will be just as
 * true in six hours. Advice expires at kickoff and a completed trade is news, so neither waits.
 *
 * @param {string} kind
 * @param {object} prefs normalized
 * @param {Record<string, string>|undefined} lastKindAt ISO timestamps from the device state
 * @param {number} now ms
 * @returns {{cooling: boolean, until: number|null}}
 */
export function cooldownState(kind, prefs, lastKindAt, now) {
  const prefKey = COOLDOWN_PREF[kind];
  if (!prefKey) return { cooling: false, until: null };
  const hours = Number(prefs?.[prefKey]);
  if (!Number.isFinite(hours) || hours <= 0) return { cooling: false, until: null };
  const last = Date.parse(String((lastKindAt || {})[kind] ?? ""));
  if (Number.isNaN(last)) return { cooling: false, until: null };
  const until = last + hours * 3600 * 1000;
  return { cooling: now < until, until };
}

/**
 * @returns {{ trades: string[], deals: string[], fa: string[], advice: string[] }}
 */
function emptySeen() {
  return { trades: [], deals: [], fa: [], advice: [] };
}

/**
 * Turn this run's status transitions into research-queue requests (004 design §2.5, trigger ii).
 * Pure: the queue write itself happens once per run in `main`.
 *
 * Depth and priority follow the ladder in §2.5. A transition on MY roster is the one that changes
 * a start/sit or an IR decision, so it earns a `deep` fill at priority 2; a rival's is trade and
 * waiver intelligence, so it is `standard` at priority 5 and only when the device asked for rival
 * news at all. Free agents are skipped here on purpose — the desk's own trending sweep covers the
 * unrostered market, and enqueuing every unowned Questionable player would swamp the queue.
 *
 * `sk` is the post-transition `statusKey`, which is exactly the freshness oracle a dossier is
 * stamped with (R11 §Q11.3): a dossier written for this key stays valid until the status moves.
 * @param {object} ctx engine context (only `rosterOf` is read)
 * @param {object[]} events `diffStatuses` output
 * @param {{ rosterId: number|string|null, includeRivals?: boolean }} options
 * @returns {object[]} `queue.appendRow` requests, at most one per player
 */
export function researchRequests(ctx, events, options) {
  const { rosterId, includeRivals = false } = options || {};
  /** @type {Map<string, object>} */
  const out = new Map();
  for (const event of events || []) {
    if (!event || event.id == null) continue;
    const id = String(event.id);
    const owner = ctx?.rosterOf?.has?.(id) ? ctx.rosterOf.get(id) : null;
    if (owner == null) continue;
    const mine = rosterId != null && String(owner) === String(rosterId);
    if (!mine && !includeRivals) continue;
    // A player who is both mine and (impossibly) a rival's keeps the deeper request.
    if (out.has(id) && out.get(id).depth === "deep") continue;
    out.set(id, {
      player_id: id,
      depth: mine ? "deep" : "standard",
      reason: "news",
      sk: statusKey(event.after),
      requested_by: "alerts",
      priority: mine ? 2 : 5,
    });
  }
  return [...out.values()];
}

/**
 * Decide what one device should hear about this run. Pure — no fetch, no clock, no sending.
 *
 * Advice comes first: a lineup hole expires at kickoff, a trade idea does not (§12.1). The run cap
 * is unchanged, so on a busy Sunday the trades/deals/free agents simply wait for the next run.
 *
 * `options.status` is this run's `Record<id, StatusKey>` snapshot for the league; the diff against
 * the one in `state` is what makes an event. The FIRST run for a league (no stored snapshot) is a
 * seeding run: its advisories go into the feed and into `seen.advice` as the baseline, but nothing
 * is pushed — otherwise pairing a device would immediately buzz about every Questionable player
 * already on the roster.
 *
 * @param {object} ctx engine context, statuses and current-week points already applied
 * @param {{ id: string, leagueId?: string, rosterId?: number|null, prefs?: object,
 *   subject?: string, label?: string }} device pairing payload; `subject` sets the deep-link base
 * @param {object} state the run's pre-run alerts state (never mutated)
 * @param {{ status?: Record<string, string>, seeding?: boolean, now?: number }} [options]
 *   `now` drives the per-kind cooldowns (§13.3 B3); the engine still never reads a clock itself.
 * @returns {{ notifications: object[], advisories: object[], research: object[],
 *   baseline: string[], seen: { trades: string[], deals: string[], fa: string[], advice: string[] },
 *   seeding: boolean, deferred: number, cooled: Record<string, number>, problems: string[] }}
 *   `research` is the queue.mjs request list for data/research-queue.json (004 design §2.5).
 */
export function composeAlerts(ctx, device, state, options = {}) {
  /** @type {string[]} */
  const problems = [];
  const prefs = normalizePrefs(device.prefs);
  const subject = device.subject || DEFAULT_SUBJECT;
  const leagueUrl = `${subject}#league`;
  const dealsUrl = `${subject}#deals`;
  const advisorUrl = `${subject}#advisor`;
  const leagueId = String(device.leagueId ?? (ctx.league && ctx.league.id) ?? "");
  const leagueState = ((state && state.leagues) || {})[leagueId] || {};
  const deviceState = ((state && state.devices) || {})[device.id] || {};
  const seenTrades = new Set(leagueState.seenTradeIds || []);
  const seenDeals = new Set(deviceState.seenDeals || []);
  const seenFa = new Set(deviceState.seenFa || []);
  const seenAdvice = new Set(deviceState.seenAdvice || []);
  const rosterId = device.rosterId != null ? device.rosterId : ctx.myRosterId;

  const previousStatus = leagueState.status && typeof leagueState.status === "object" ? leagueState.status : {};
  const nextStatus = options.status && typeof options.status === "object" ? options.status : {};
  const seeding = options.seeding === undefined ? Object.keys(previousStatus).length === 0 : options.seeding === true;

  // The feed wants every advisory even when this device silenced the pushes, so this runs
  // regardless of prefs.advice; only the notification group below is gated.
  /** @type {object[]} */
  let advisories = [];
  /** @type {object[]} */
  let research = [];
  if (rosterId != null) {
    try {
      const events = diffStatuses(previousStatus, nextStatus);
      advisories = adviseAll(ctx, { rosterId, events, includeRivals: prefs.rivalNews }) || [];
      // 004 design §2.5 trigger (ii): the same diff that produces an advisory also asks the
      // research desk for a dossier. Zero extra HTTP requests — the status rows are already here.
      // A seeding run is excluded: the first sight of a league is not a transition, and enqueuing
      // every Questionable player on day one would drown the desk.
      if (!seeding) {
        research = researchRequests(ctx, events, { rosterId, includeRivals: prefs.rivalNews });
      }
    } catch (error) {
      problems.push(`adviseAll failed: ${error.message}`);
      advisories = [];
      research = [];
    }
  }

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const lastKindAt = deviceState.lastKindAt || {};
  /** @type {Record<string, number>} */
  const cooled = {};

  /** @type {{ kind: string, items: object[] }[]} */
  const groups = [];
  if (prefs.advice && !seeding) {
    groups.push({ kind: "advice", items: adviceCandidates(advisories, prefs, seenAdvice, advisorUrl) });
  }
  if (prefs.trades) groups.push({ kind: "trades", items: tradeCandidates(ctx, seenTrades, leagueUrl, problems) });
  if (prefs.deals && rosterId != null) {
    groups.push({ kind: "deals", items: dealCandidates(ctx, rosterId, prefs, seenDeals, dealsUrl, problems) });
  }
  if (prefs.freeAgents && rosterId != null) {
    groups.push({ kind: "fa", items: faCandidates(ctx, rosterId, prefs, seenFa, dealsUrl, problems) });
  }

  /** @type {object[]} */
  const notifications = [];
  let deferred = 0;
  for (const group of groups) {
    if (!group.items.length) continue;

    // Cooldown: hold the whole kind back WITHOUT marking anything seen, so the same suggestions
    // are offered again once it lapses rather than being silently burned.
    const cooldown = cooldownState(group.kind, prefs, lastKindAt, now);
    if (cooldown.cooling) {
      cooled[group.kind] = group.items.length;
      continue;
    }

    // One digest instead of N pushes for the kind that produced 70 of them in eight days.
    if (group.kind === "deals" && group.items.length > prefs.maxDealsPerPush) {
      group.items = [batchOf("deals", group.items, group.items[0].url)];
    }

    const remaining = MAX_PER_DEVICE - notifications.length;
    if (remaining <= 0) {
      // No slot left this run: leave these unseen so the next run can deliver them.
      deferred += group.items.length;
      continue;
    }
    if (group.items.length <= remaining) {
      notifications.push(...group.items);
    } else {
      notifications.push(batchOf(group.kind, group.items, group.items[0].url));
    }
  }

  const seen = emptySeen();
  for (const notification of notifications) {
    seen[SEEN_BUCKETS[notification.kind] ?? "fa"].push(...notification.keys);
  }

  // Nothing shipped on a seeding run, but the roster's standing issues are the status quo, not
  // news: remember them so the next run only speaks up about what actually changed.
  const baseline = seeding ? advisories.map((advisory) => advisory.key).filter(Boolean) : [];

  return { notifications, advisories, research, baseline, seen, seeding, deferred, cooled, problems };
}

/**
 * Group delivered notifications back into the seen-buckets (only what actually shipped is
 * remembered, so a failed send retries next run).
 * @param {object[]} notifications
 * @returns {{ trades: string[], deals: string[], fa: string[], advice: string[] }}
 */
export function seenOf(notifications) {
  const seen = emptySeen();
  for (const notification of notifications || []) {
    seen[SEEN_BUCKETS[notification.kind] ?? "fa"].push(...(notification.keys || []));
  }
  return seen;
}

// --- advisor feed (§12.3) ------------------------------------------------------------------------

/** Most urgent first when two advisories were produced by the same run. */
const SEVERITY_RANK = Object.freeze({ high: 0, med: 1, low: 2 });

/**
 * @returns {{ v: number, generated_at: string|null, leagues: Record<string, any> }}
 */
export function emptyAdvisor() {
  return { v: ADVISOR_VERSION, generated_at: null, leagues: {} };
}

/**
 * Fold this run's advisories into data/advisor.json — the league news feed the Advisor tab reads
 * when the phone has not recomputed anything itself (§12.5).
 *
 * Advisories from every device in a league are merged and deduped on `key`, so Tom's iPhone and
 * iPad contribute one list. A key advised again keeps its place but takes this run's `at`, which is
 * what "newest first" sorts on. Ordering is fully determined by (at, severity, key), so two
 * identical runs produce byte-identical bytes and the workflow commits nothing.
 *
 * @param {unknown} previous the parsed file from the last run, if any
 * @param {Record<string, { week: number|null, items: object[] }>} updates per league, this run
 * @param {{ at: string }} meta
 * @returns {{ v: number, generated_at: string, leagues: Record<string, any> }}
 */
/**
 * Does a re-advised item still say what the stored one says? Compared on the words a reader sees
 * (headline, summary, severity, move texts and timing) — not on the floating-point details behind
 * them, which drift with every projections refresh without changing the advice.
 * @param {object} stored
 * @param {object} fresh
 * @returns {boolean}
 */
export function sameAdvice(stored, fresh) {
  const words = (item) =>
    JSON.stringify([
      item.headline ?? null,
      item.summary ?? null,
      item.severity ?? null,
      (Array.isArray(item.moves) ? item.moves : []).map((m) => [m.type ?? null, m.text ?? null, m.when ?? null]),
    ]);
  return words(stored) === words(fresh);
}

export function mergeAdvisor(previous, updates, meta) {
  const source =
    previous && typeof previous === "object" && previous.leagues && typeof previous.leagues === "object"
      ? previous.leagues
      : {};
  /** @type {Record<string, any>} */
  const leagues = {};
  for (const leagueId of [...new Set([...Object.keys(source), ...Object.keys(updates || {})])].sort()) {
    const old = source[leagueId] && typeof source[leagueId] === "object" ? source[leagueId] : {};
    const fresh = (updates || {})[leagueId];
    /** @type {Map<string, any>} */
    const byKey = new Map();
    for (const item of Array.isArray(old.items) ? old.items : []) {
      if (item && typeof item.key === "string" && item.key !== "") byKey.set(item.key, item);
    }
    for (const advisory of (fresh && fresh.items) || []) {
      if (!advisory || typeof advisory.key !== "string" || advisory.key === "") continue;
      // A standing issue is re-advised on every run. If the advice still SAYS the same thing, the
      // stored item (and its original `at`) stands — otherwise the feed would be rewritten, and
      // committed, every ten minutes for news that has not changed. Fresh text replaces it.
      const stored = byKey.get(advisory.key);
      if (stored && sameAdvice(stored, advisory)) continue;
      byKey.set(advisory.key, { ...advisory, at: meta.at });
    }
    const items = [...byKey.values()]
      .sort(
        (a, b) =>
          (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
          (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      )
      .slice(0, ADVISOR_ITEM_LIMIT);
    const week = fresh && Number.isFinite(fresh.week) ? Number(fresh.week) : Number.isFinite(old.week) ? old.week : null;
    leagues[leagueId] = { week, items };
  }
  return { v: ADVISOR_VERSION, generated_at: meta.at, leagues };
}

// --- sending -----------------------------------------------------------------------------------

/**
 * @param {any} error
 * @returns {number|null} HTTP status the push service replied with, when there is one
 */
export function statusCodeOf(error) {
  const code = Number(error?.statusCode ?? error?.status ?? error?.response?.statusCode);
  return Number.isFinite(code) ? code : null;
}

/**
 * 404/410 mean the subscription is gone for good (§11.3).
 * @param {any} error
 * @returns {boolean}
 */
export function isGoneError(error) {
  const code = statusCodeOf(error);
  return code != null && GONE_STATUS_CODES.has(code);
}

/**
 * Apple returns the notification's id in `apns-id`; the RFC 8030 answer is a `location` URL.
 * Logging whichever exists turns "the job says it sent" into something that can be correlated
 * with a phone that never buzzed (design §13.3 B3).
 * @param {any} result the push service's response, as web-push resolves it
 * @returns {string|null}
 */
export function receiptIdOf(result) {
  const headers = result?.headers;
  if (!headers) return null;
  const read = (name) =>
    typeof headers.get === "function" ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  const apns = read("apns-id");
  if (apns) return String(apns);
  const location = read("location");
  return location ? String(location) : null;
}

/**
 * Build the real sender. web-push is imported dynamically so importing this module (tests, `--check`)
 * never requires the dependency to be installed.
 *
 * TTL and urgency arrive per notification. Urgency travels as a raw header rather than web-push's
 * own `urgency` option: `options.headers` is copied through verbatim by every 3.x release, while
 * an unknown top-level key makes `sendNotification` throw.
 *
 * @param {{ subject: string, publicKey: string, privateKey: string }} vapid
 * @returns {Promise<(subscription: object, payload: string, options?: object) => Promise<any>>}
 */
export async function defaultSender(vapid) {
  const module = await import("web-push");
  const webpush = module.default ?? module;
  return (subscription, payload, options = {}) =>
    webpush.sendNotification(subscription, payload, {
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
      TTL: Number.isFinite(Number(options.TTL)) ? Number(options.TTL) : PUSH_TTL_SECONDS,
      headers: { Urgency: options.urgency || "normal" },
    });
}

/* --- fallback channels (design §13.3 B3) ------------------------------------------------------
 *
 * Web Push to one iPhone is a single point of failure that nobody can see fail. `ALERT_WEBHOOKS`
 * adds channels that DO report failure: a Discord/Slack/ntfy/plain-JSON endpoint is treated as
 * just another device, with the same composition, the same dedupe and the same state entry, so an
 * alert that never reaches the phone still lands somewhere Tom reads.
 */

/** @typedef {{ url: string, kind: "discord"|"slack"|"ntfy"|"generic", label: string }} Webhook */

/**
 * Which flavour of endpoint this is, from the URL alone — nothing here needs a secret to say so.
 * @param {string} url
 * @returns {"discord"|"slack"|"ntfy"|"generic"}
 */
export function webhookKind(url) {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(String(url));
    host = parsed.host.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    return "generic";
  }
  if (host.endsWith("discord.com") && path.startsWith("/api/webhooks")) return "discord";
  if (host.endsWith("discordapp.com") && path.startsWith("/api/webhooks")) return "discord";
  if (host === "hooks.slack.com") return "slack";
  if (host === "ntfy.sh" || host.startsWith("ntfy.") || host.endsWith(".ntfy.sh")) return "ntfy";
  return "generic";
}

/**
 * Parse `ALERT_WEBHOOKS`: a JSON array of URLs, or of `{url, label, prefs, leagueId, userId}`.
 * Never throws — a malformed entry is reported and skipped, exactly like a bad pairing.
 * @param {unknown} raw
 * @returns {{ webhooks: object[], problems: string[] }}
 */
export function parseWebhooks(raw) {
  /** @type {string[]} */
  const problems = [];
  const text = raw == null ? "" : String(raw).trim();
  if (text === "") return { webhooks: [], problems };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { webhooks: [], problems: [`ALERT_WEBHOOKS is not valid JSON: ${error.message}`] };
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  /** @type {object[]} */
  const webhooks = [];
  /** @type {Set<string>} */
  const seen = new Set();

  rows.forEach((row, index) => {
    const entry = typeof row === "string" ? { url: row } : row && typeof row === "object" ? row : {};
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) {
      problems.push(`webhook[${index}]: needs an http(s) url`);
      return;
    }
    const id = deviceIdOf(url);
    if (seen.has(id)) {
      problems.push(`webhook[${index}]: duplicate url (device ${id})`);
      return;
    }
    seen.add(id);
    const kind = webhookKind(url);
    webhooks.push({
      id,
      webhook: { url, kind, label: String(entry.label ?? "").trim() || kind },
      sub: null,
      endpoint: url,
      leagueId: entry.leagueId == null ? null : String(entry.leagueId),
      userId: entry.userId == null ? null : String(entry.userId),
      label: String(entry.label ?? "").trim() || `${kind} webhook`,
      prefs: normalizePrefs(entry.prefs),
      createdAt: entry.createdAt ?? null,
    });
  });

  return { webhooks, problems };
}

/**
 * The HTTP request one notification becomes, per channel flavour. Pure, so every shape is a test
 * rather than a hopeful POST.
 * @param {Webhook} webhook
 * @param {{ title: string, body: string, tag: string, url: string, kind?: string }} notification
 * @returns {{ url: string, init: { method: string, headers: Record<string, string>, body: string } }}
 */
export function webhookRequest(webhook, notification) {
  const json = (payload) => ({
    url: webhook.url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  });

  if (webhook.kind === "discord") {
    return json({
      username: "Tradewinds",
      embeds: [{ title: notification.title, description: notification.body, url: notification.url }],
    });
  }
  if (webhook.kind === "slack") {
    return json({ text: `*${notification.title}*\n${notification.body}\n${notification.url}` });
  }
  if (webhook.kind === "ntfy") {
    // ntfy carries the title and the tap target in headers; the body is the message itself.
    // Header values must be Latin-1, and composed text here is full of "·" and "⇄".
    return {
      url: webhook.url,
      init: {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          Title: asciiHeader(notification.title),
          Tags: notification.kind || "tradewinds",
          Click: notification.url,
        },
        body: notification.body || notification.title,
      },
    };
  }
  return json({
    title: notification.title,
    body: notification.body,
    url: notification.url,
    tag: notification.tag,
    kind: notification.kind ?? null,
  });
}

/** Header values are Latin-1 only; "Trade: a ⇄ b" would be rejected outright. */
function asciiHeader(text) {
  return String(text ?? "")
    .replace(/[⇄↔]/g, "<->")
    .replace(/·/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .trim() || "Tradewinds";
}

/**
 * POST one notification to one channel. Throws an error carrying `statusCode` on a non-2xx, so
 * the send loop's existing 404/410 handling treats a dead webhook exactly like a dead endpoint.
 * @param {Webhook} webhook
 * @param {object} notification
 * @param {{ fetchImpl: Function }} deps
 * @returns {Promise<{statusCode: number, headers: any}>}
 */
export async function sendWebhook(webhook, notification, deps) {
  const { url, init } = webhookRequest(webhook, notification);
  const response = await deps.fetchImpl(url, init);
  const statusCode = Number(response?.status ?? 0);
  if (!(statusCode >= 200 && statusCode < 300)) {
    const error = new Error(`${webhook.kind} webhook replied ${statusCode || "nothing"}`);
    error.statusCode = statusCode;
    throw error;
  }
  return { statusCode, headers: response?.headers ?? null };
}

// --- live inputs -------------------------------------------------------------------------------

/**
 * Everything the engine needs about one league, fetched live and cache-busted (§3 "Live").
 * @param {string} leagueId
 * @param {{ week: number, get: (url: string) => Promise<any>, pause: () => Promise<void> }} deps
 * @returns {Promise<{ league: any, users: any[], rosters: any[], transactions: object[] }>}
 */
export async function fetchLeagueBundle(leagueId, deps) {
  const { week, get, pause } = deps;
  const league = await get(`${SLEEPER_API}/v1/league/${leagueId}`);
  await pause();
  const users = await get(`${SLEEPER_API}/v1/league/${leagueId}/users`);
  await pause();
  const rosters = await get(`${SLEEPER_API}/v1/league/${leagueId}/rosters`);
  /** @type {object[]} */
  const transactions = [];
  for (let round = 1; round <= week; round += 1) {
    await pause();
    const raw = await get(`${SLEEPER_API}/v1/league/${leagueId}/transactions/${round}`);
    for (const row of Array.isArray(raw) ? raw : []) transactions.push(normalizeTransaction(row, round));
  }
  transactions.sort((a, b) => b.created - a.created);
  return { league, users: users || [], rosters: rosters || [], transactions };
}

/**
 * The one weekly projections call, parsed into statuses + raw stat lines (§12.3). One request
 * covers every rostered player in every paired league.
 * @param {string|number} season
 * @param {number} week
 * @param {{ get: (url: string) => Promise<any> }} deps
 * @returns {Promise<{ statuses: object[], stats: Map<string, Record<string, number>> }>}
 */
export async function fetchWeekStatus(season, week, deps) {
  return statusRowsFromProjections(await deps.get(projectionsUrl(season, week)));
}

/**
 * Per-player statuses for watched ids the weekly rows missed — sequential and budgeted, because
 * this is the request pattern that would turn one cron tick into a burst.
 * @param {string[]} ids already trimmed to the run's budget
 * @param {{ get: (url: string) => Promise<any>, pause: () => Promise<void>,
 *   onProblem?: (id: string, message: string) => void }} deps
 * @returns {Promise<object[]>}
 */
export async function fetchMissingStatuses(ids, deps) {
  const { get, pause, onProblem } = deps;
  /** @type {object[]} */
  const rows = [];
  for (const id of ids) {
    try {
      await pause();
      rows.push(statusRowFromPlayer(id, await get(playerUrl(id))));
    } catch (error) {
      if (onProblem) onProblem(id, error.message);
    }
  }
  return rows;
}

/**
 * The synthetic device a dry run composes for (§12.3). No subscription, no VAPID and no state: it
 * exists so a human can see exactly what the next real run would say. `rivalNews` is on so nothing
 * is filtered out of the preview.
 * @param {Record<string, string|undefined>} env
 * @param {string} subject
 * @returns {{ ok: boolean, device?: object, problem?: string }}
 */
export function dryRunDevice(env, subject) {
  const leagueId = String(env.ALERT_DRY_LEAGUE ?? "").trim();
  if (!leagueId) return { ok: false, problem: "ALERT_DRY=1 needs ALERT_DRY_LEAGUE=<leagueId>" };
  const userId = String(env.ALERT_DRY_USER ?? "").trim();
  return {
    ok: true,
    device: {
      id: "dryrun",
      sub: null,
      endpoint: "dry-run",
      leagueId,
      userId: userId || null,
      label: "dry run",
      subject,
      prefs: normalizePrefs({ rivalNews: true }),
      createdAt: null,
    },
  };
}

// --- entry point -------------------------------------------------------------------------------

/**
 * @param {"ok"|"warn"|"fail"} kind
 * @returns {string}
 */
function tagFor(kind) {
  return kind === "ok" ? "ok  " : kind === "warn" ? "warn" : "FAIL";
}

/**
 * @param {{ env?: Record<string, string|undefined>, sender?: Function, root?: string,
 *   log?: (line: string) => void, now?: number, fetchJsonImpl?: Function,
 *   pause?: () => Promise<void> }} [options]
 * @returns {Promise<number>} process exit code
 */
export async function main(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const status = (kind, id, detail) => log(`[${tagFor(kind)}] ${String(id).padEnd(16)} ${detail}`);
  const root = options.root ?? REPO_ROOT;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const get = options.fetchJsonImpl ?? ((url) => fetchJson(url, { cacheBust: true }));
  const pause = options.pause ?? (() => sleep(POLITE_DELAY_MS));

  const subject = String(env.VAPID_SUBJECT || DEFAULT_SUBJECT);
  const publicKey = String(env.VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY);
  const privateKey = String(env.VAPID_PRIVATE_KEY || "");

  const dry = isEnabled(env.ALERT_DRY);
  log(`tradewinds alerts${dry ? " (dry run)" : ""} — ${isoTimestamp(new Date(now))} — ${subject}`);

  // The state is read FIRST now: since §13.3 B5 it also holds the pairings phones filed for
  // themselves, and those are part of the device list.
  const stateFile = join(root, "data", "alerts-state.json");
  const stateIn = loadState(stateFile, status);
  let stateOut = stateIn;
  /** Write only when something actually changed — the workflow commits whatever this touches. */
  const writeStateIfChanged = () => {
    if (dry) return;
    const before = JSON.stringify(canonicalState(stateIn));
    const after = JSON.stringify(canonicalState(stateOut));
    if (before === after) {
      status("ok", "state", "data/alerts-state.json unchanged");
      return;
    }
    const size = writeJsonFile(stateFile, canonicalState(stateOut));
    status("ok", "state", `data/alerts-state.json written (${size.bytes} B)`);
  };

  /** @type {object[]} */
  let devices = [];
  if (dry) {
    const synthetic = dryRunDevice(env, subject);
    if (!synthetic.ok) {
      status("fail", "dry", synthetic.problem);
      return 1;
    }
    devices = [synthetic.device];
    status("ok", "dry", `league ${synthetic.device.leagueId} · user ${synthetic.device.userId ?? "(none)"}`);
  } else {
    // A phone that re-subscribed sends its new pairing here, sealed to the VAPID public key
    // (§13.3 B5). File it before anything else so THIS run already uses the new endpoint.
    const dispatch = parseDispatchPayload(env.PAIR_PAYLOAD);
    if (dispatch.blob) {
      if (!privateKey) {
        status("warn", "pairing", "a pairing arrived but VAPID_PRIVATE_KEY is not set — cannot open it");
      } else {
        try {
          const pairing = decryptPairingBlob(dispatch.blob, privateKey);
          const problems = validatePairing(pairing);
          if (problems.length) {
            status("warn", "pairing", `rejected: ${problems[0]}`);
          } else {
            const id = deviceIdOf(pairing.sub.endpoint);
            const label = dispatch.label ?? pairing.label ?? null;
            const applied = applyPairing(stateOut, {
              id,
              blob: dispatch.blob,
              label,
              userId: pairing.userId ?? null,
              leagueId: pairing.leagueId ?? null,
              createdAt: pairing.createdAt ?? isoTimestamp(new Date(now)),
            });
            stateOut = applied.state;
            status(
              "ok",
              "pairing",
              `${label ?? "device"} · stored ${id}${applied.superseded.length ? ` · supersedes ${applied.superseded.join(", ")}` : ""}`,
            );
          }
        } catch (error) {
          // Never log the blob or anything it decrypts to — the endpoint and its keys are secrets.
          status("warn", "pairing", `could not be opened (${error.message})`);
        }
      }
    }

    const parsed = parseSubscriptions(env.PUSH_SUBSCRIPTIONS);
    for (const problem of parsed.problems) status("warn", "subscriptions", problem);

    const selfPaired = pairedDevices(stateOut, privateKey, (id, message) =>
      status("warn", "pairing", `${id}: ${message}`),
    );
    const merged = mergeDevices(parsed.devices, selfPaired);
    devices = merged.devices;
    for (const row of merged.superseded) {
      status("ok", "pairing", `${row.label} (${row.id}) in PUSH_SUBSCRIPTIONS is superseded by ${row.by} — skipping the stale one`);
    }
    if (selfPaired.length) status("ok", "pairings", `${selfPaired.length} self-paired device(s)`);
    if (devices.length) {
      status("ok", "subscriptions", `${devices.length} device(s): ${devices.map((d) => d.label).join(", ")}`);
    }

    // Fallback channels ride the same pipeline as a phone (§13.3 B3): same composition, same
    // dedupe, same state entry. No secret → no webhooks, and the job behaves exactly as before.
    const hooks = parseWebhooks(env.ALERT_WEBHOOKS);
    for (const problem of hooks.problems) status("warn", "webhooks", problem);
    if (hooks.webhooks.length) {
      // A channel usually mirrors the phone, so it inherits its league unless it named one.
      const inherit = devices[0] || null;
      for (const hook of hooks.webhooks) {
        const leagueId = hook.leagueId || inherit?.leagueId || "";
        if (!leagueId) {
          status("warn", "webhooks", `${hook.label}: no leagueId (and no paired device to inherit one from)`);
          continue;
        }
        devices.push({ ...hook, leagueId, userId: hook.userId ?? inherit?.userId ?? null });
      }
      status("ok", "webhooks", `${hooks.webhooks.length} channel(s): ${hooks.webhooks.map((h) => `${h.label} (${h.webhook.kind})`).join(", ")}`);
    }

    if (!devices.length) {
      status("ok", "subscriptions", "nothing paired");
      writeStateIfChanged();
      return 0;
    }
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const needsPush = devices.some((device) => device.sub);

  let sender = options.sender;
  if (!sender && !dry && needsPush) {
    if (!privateKey) {
      status("fail", "vapid", "VAPID_PRIVATE_KEY is not set — cannot sign a push");
      return 1;
    }
    try {
      sender = await defaultSender({ subject, publicKey, privateKey });
    } catch (error) {
      status("fail", "web-push", `could not load web-push (${error.message}) — run npm i --no-save web-push@3.6.7`);
      return 1;
    }
  }

  /**
   * One notification to one device — a Web Push subscription or a fallback channel. The two
   * report the same way, so the send loop, the logging and the expiry handling stay single-path.
   */
  const deliver = (device, notification) => {
    if (device.webhook) return sendWebhook(device.webhook, notification, { fetchImpl });
    return sender(device.sub, JSON.stringify(payloadOf(notification)), deliveryOptions(notification.kind));
  };

  // --- ALERT_TEST: one push per device, state otherwise untouched --------------------------------
  // `client_payload.test` is the same request made from the phone (§13.3 B5), so "Send test alert"
  // needs no trip to github.com when a token is saved.
  const testRequested = isEnabled(env.ALERT_TEST) || parseDispatchPayload(env.PAIR_PAYLOAD).test;
  if (!dry && testRequested) {
    const notification = { ...testPayload(subject), kind: "test" };
    let sent = 0;
    for (const device of devices) {
      try {
        const result = await deliver(device, notification);
        sent += 1;
        status("ok", "test push", `${device.label} · ${result?.statusCode ?? "?"}${receiptIdOf(result) ? ` · ${receiptIdOf(result)}` : ""}`);
      } catch (error) {
        status("warn", "test push", `${device.label}: ${statusCodeOf(error) ?? ""} ${error.message}`.trim());
      }
    }
    status("ok", "test", `${sent}/${devices.length} accepted by the push service`);
    // A pairing that arrived in the same dispatch still has to be kept; nothing else is written.
    writeStateIfChanged();
    return 0;
  }

  // --- pipeline files ----------------------------------------------------------------------------
  /** @type {Record<string, any>} */
  const files = {};
  for (const name of DATA_FILES) {
    const file = join(root, "data", `${name}.json`);
    const parsed = readJsonIfExists(file);
    if (parsed == null) {
      status("fail", "data", `data/${name}.json is missing or unreadable`);
      return 1;
    }
    files[name] = parsed;
  }
  status("ok", "data", `players/projections/values/schedule/meta from ${files.meta.generated_at ?? "?"}`);

  /** @type {any} */
  let nflState = null;
  try {
    nflState = await get(`${SLEEPER_API}/v1/state/nfl`);
  } catch (error) {
    status("fail", "state", `sleeper state unavailable: ${error.message}`);
    return 1;
  }
  const week = Math.max(1, Number(nflState?.week) || 1);
  const season = String(nflState?.season || files.meta?.season || "");
  status("ok", "state", `season ${nflState?.season ?? "?"} · week ${week}`);

  /** @type {any[]} */
  let trending = [];
  try {
    await pause();
    const raw = await get(TRENDING_URL);
    trending = Array.isArray(raw) ? raw : [];
  } catch (error) {
    status("warn", "trending", `unavailable (${error.message}) — continuing without it`);
  }

  // --- live statuses: one call, every rostered player (§12.1) ------------------------------------
  /** @type {object[]} */
  let statusRows = [];
  /** @type {Map<string, Record<string, number>>} */
  let statusStats = new Map();
  try {
    await pause();
    const parsed = await fetchWeekStatus(season, week, { get });
    statusRows = parsed.statuses;
    statusStats = parsed.stats;
    status("ok", "statuses", `week ${week} projections: ${statusRows.length} rows`);
  } catch (error) {
    // Not fatal: without statuses there is no advice this run, but trades/deals/FA still work.
    status("warn", "statuses", `week ${week} projections unavailable (${error.message}) — no advice this run`);
  }
  const statusById = new Map(statusRows.map((row) => [row.id, row]));
  let fallbackBudget = MAX_STATUS_FALLBACK;

  // --- per league --------------------------------------------------------------------------------
  const leagueIds = [...new Set(devices.map((device) => device.leagueId))];
  /** @type {Map<string, any>} */
  const contexts = new Map();
  /** @type {Record<string, { week: number, items: object[] }>} */
  const feedUpdates = {};
  /** @type {Map<string, Set<string>>} */
  const feedKeys = new Map();
  /** 004 design §2.5: one research request per player across every device and league this run. */
  /** @type {Map<string, object>} */
  const researchWanted = new Map();
  let leaguesOk = 0;
  let notified = 0;

  for (const leagueId of leagueIds) {
    const mine = devices.filter((device) => device.leagueId === leagueId);
    /** @type {{ league: any, users: any[], rosters: any[], transactions: object[] }} */
    let bundle;
    try {
      await pause();
      bundle = await fetchLeagueBundle(leagueId, { week, get, pause });
    } catch (error) {
      status("warn", `league ${leagueId}`, `live fetch failed: ${error.message}`);
      continue;
    }
    leaguesOk += 1;
    const trades = bundle.transactions.filter((txn) => txn.type === "trade" && txn.status === "complete");
    status(
      "ok",
      `league ${leagueId}`,
      `${bundle.league?.name ?? "?"} · ${bundle.rosters.length} rosters · ${bundle.transactions.length} txns (${trades.length} trades)`,
    );

    // --- live statuses + current-week points for this league's watch set (§12.3) ----------------
    const watch = watchSet(bundle.rosters);
    /** @type {object[]} */
    const observed = [];
    for (const id of watch) {
      const row = statusById.get(id);
      if (row) observed.push(row);
    }
    const missing = [...watch].filter((id) => !statusById.has(id)).sort(compareIds).slice(0, fallbackBudget);
    if (missing.length) {
      fallbackBudget -= missing.length;
      observed.push(
        ...(await fetchMissingStatuses(missing, {
          get,
          pause,
          onProblem: (id, message) => status("warn", "status", `player ${id}: ${message}`),
        })),
      );
    }
    const points = weekPointRows(statusStats, watch, bundle.league?.scoring_settings, week);
    const previousStatus = ((stateIn.leagues || {})[leagueId] || {}).status || {};
    const snapshot = nextStatusSnapshot(previousStatus, watch, observed);
    const statusChanged = JSON.stringify(previousStatus) !== JSON.stringify(snapshot);
    status(
      "ok",
      `league ${leagueId}`,
      `${observed.length}/${watch.size} statuses (${missing.length} per-player) · ${points.length} live points · ` +
        `snapshot ${statusChanged ? "changed" : "unchanged"}`,
    );

    for (const device of mine) {
      const deviceState = (stateOut.devices || {})[device.id] || {};
      if (deviceState.expired === true) {
        status("warn", device.label, "marked expired in alerts-state — re-pair this device");
        continue;
      }
      const key = `${leagueId}|${device.userId ?? ""}`;
      if (!contexts.has(key)) {
        const base = buildContext(
          {
            league: bundle.league,
            users: bundle.users,
            rosters: bundle.rosters,
            players: files.players,
            projections: files.projections,
            values: files.values,
            schedule: files.schedule,
            state: nflState,
            transactions: bundle.transactions,
            trending,
            now,
          },
          { userId: device.userId },
        );
        // Statuses and this week's real points before anything is graded: an advisory computed off
        // last night's projections would recommend starting a player who is already ruled out.
        contexts.set(key, applyWeekPoints(applyStatuses(base, observed), points));
      }
      const ctx = contexts.get(key);
      const composed = composeAlerts(ctx, { ...device, subject, rosterId: ctx.myRosterId }, stateIn, {
        status: snapshot,
        now,
        // A dry run has no stored snapshot to seed, and a preview that prints nothing is useless.
        // ALERT_FULL (workflow input `full`) does the same for a real run: the roster's standing
        // issues are pushed once instead of being baselined silently — the way to hear about a
        // player who was already hurt when the phone was paired.
        seeding: dry || isEnabled(env.ALERT_FULL) ? false : undefined,
      });
      for (const problem of composed.problems) status("warn", device.label, problem);
      if (ctx.myRosterId == null) status("warn", device.label, "user does not own a roster here — trades only");
      if (composed.seeding) status("ok", device.label, "first run for this league — seeding statuses, no advice");

      // Every device in the league contributes to the same feed, deduped on Advisory.key (§12.3).
      if (!feedKeys.has(leagueId)) {
        feedKeys.set(leagueId, new Set());
        feedUpdates[leagueId] = { week, items: [] };
      }
      for (const request of composed.research || []) {
        const existing = researchWanted.get(request.player_id);
        if (!existing || existing.priority > request.priority) researchWanted.set(request.player_id, request);
      }

      const seenKeys = feedKeys.get(leagueId);
      for (const advisory of composed.advisories) {
        if (!advisory || typeof advisory.key !== "string" || seenKeys.has(advisory.key)) continue;
        seenKeys.add(advisory.key);
        feedUpdates[leagueId].items.push(advisory);
      }

      /** @type {object[]} */
      const delivered = [];
      let expired = false;
      /** @type {{status: number|string, at: string}|null} */
      let lastResult = null;
      for (const notification of composed.notifications) {
        if (dry) {
          delivered.push(notification);
          notified += 1;
          const { TTL, urgency } = deliveryOptions(notification.kind);
          log(`[dry] ${notification.title} — ${notification.body} · ttl ${TTL}s · ${urgency}`);
          continue;
        }
        try {
          const result = await deliver(device, notification);
          delivered.push(notification);
          notified += 1;
          const code = result?.statusCode ?? null;
          const receiptId = receiptIdOf(result);
          lastResult = { status: code ?? "sent", at: isoTimestamp(new Date(now)) };
          status(
            "ok",
            "push",
            `${device.label} · accepted ${code ?? "?"} · ${notification.title} — ${notification.body}${receiptId ? ` · ${receiptId}` : ""}`,
          );
        } catch (error) {
          const code = statusCodeOf(error);
          lastResult = { status: code ?? "error", at: isoTimestamp(new Date(now)), detail: error.message };
          if (isGoneError(error)) {
            expired = true;
            status(
              "warn",
              "push",
              `${device.label}: endpoint gone (${code}) — marking expired; edit PUSH_SUBSCRIPTIONS by hand`,
            );
            break;
          }
          status("warn", "push", `${device.label}: send failed (${code ?? "no status"}) — ${error.message}`);
        }
      }

      if (!dry) {
        const seen = seenOf(delivered);
        if (composed.baseline.length) seen.advice = [...seen.advice, ...composed.baseline];
        // Cooldowns start when something actually SHIPPED, not when it was composed — a failed
        // send must not buy the next six hours of silence.
        /** @type {Record<string, string>} */
        const lastKindAt = {};
        for (const notification of delivered) {
          if (notification.kind === "deals" || notification.kind === "fa") {
            lastKindAt[notification.kind] = isoTimestamp(new Date(now));
          }
        }
        stateOut = applyState(stateOut, {
          leagueId,
          week,
          deviceId: device.id,
          seen,
          notifiedAt: delivered.length ? isoTimestamp(new Date(now)) : null,
          sent: lastResult
            ? { at: delivered.length ? isoTimestamp(new Date(now)) : null, count: delivered.length, result: lastResult }
            : null,
          lastKindAt,
          expired: expired || undefined,
        });
      }

      const summary = composed.notifications.length
        ? `${delivered.length}/${composed.notifications.length} sent`
        : "nothing new";
      const cooled = Object.entries(composed.cooled || {})
        .map(([kind, count]) => `${count} ${kind} on cooldown`)
        .join(", ");
      status(
        "ok",
        device.label,
        `${summary}${composed.deferred ? ` · ${composed.deferred} deferred` : ""}${cooled ? ` · ${cooled}` : ""}`,
      );
    }

    // The snapshot belongs to the league, not to a device: record it once, even if every device
    // here was skipped, so the next run has a baseline to diff against.
    if (!dry) {
      stateOut = applyState(stateOut, {
        leagueId,
        week,
        status: snapshot,
        // Only stamped when the snapshot moved: "when we last looked" would rewrite (and commit)
        // the state file on every ten-minute run.
        statusAt: statusChanged ? isoTimestamp(new Date(now)) : null,
      });
    }
  }

  if (!leaguesOk) {
    status("fail", "leagues", `no league could be fetched (${leagueIds.length} tried)`);
    // A pairing filed at the top of this run is not lost because Sleeper was down.
    writeStateIfChanged();
    return 1;
  }

  // --- dry run: print, write nothing ------------------------------------------------------------
  if (dry) {
    const advisories = Object.values(feedUpdates).flatMap((entry) => entry.items);
    log(JSON.stringify(advisories, null, 2));
    status("ok", "dry", `${notified} notification(s) · ${advisories.length} advisory(ies) · nothing written`);
    return 0;
  }

  writeStateIfChanged();

  // --- data/advisor.json: the feed the Advisor tab reads (§12.3) ---------------------------------
  const advisorFile = join(root, "data", "advisor.json");
  const previousFeed = readJsonIfExists(advisorFile) ?? emptyAdvisor();
  const feed = mergeAdvisor(previousFeed, feedUpdates, { at: isoTimestamp(new Date(now)) });
  const feedProblems = validateAdvisor(feed);
  if (feedProblems.length) {
    status("warn", "advisor", `feed rejected (${feedProblems[0]}) — data/advisor.json left alone`);
  } else if (JSON.stringify(feed.leagues) === JSON.stringify(previousFeed.leagues ?? {})) {
    // Only `generated_at` would differ; rewriting it would commit a timestamp every ten minutes.
    status("ok", "advisor", "data/advisor.json unchanged");
  } else {
    const size = writeJsonFile(advisorFile, feed);
    const count = Object.values(feed.leagues).reduce((total, entry) => total + entry.items.length, 0);
    status("ok", "advisor", `data/advisor.json written (${count} advisory(ies), ${size.bytes} B)`);
  }

  // --- data/research-queue.json: what the research desk should look at next (§2.5) --------------
  // Append-only and idempotent: `appendRow` refuses a duplicate of a live (player_id, depth, sk)
  // row and debounces the same status key inside one UTC day, so the ten-minute cadence adds a
  // row on the transition and nothing at all on the ninety runs that follow it.
  if (researchWanted.size > 0) {
    const queueFile = join(root, "data", "research-queue.json");
    const requests = [...researchWanted.values()].sort((a, b) => a.priority - b.priority);
    const result = enqueueAll(queueFile, requests, { now });
    if (!result.written) {
      status("warn", "research", `queue rejected (${result.problems[0]}) — data/research-queue.json left alone`);
    } else if (result.added === 0) {
      status("ok", "research", `${result.skipped} transition(s) already queued — nothing added`);
    } else {
      status(
        "ok",
        "research",
        `data/research-queue.json +${result.added} row(s), ${result.skipped} deduped (${result.bytes} B)`,
      );
    }
  }

  status("ok", "done", `${notified} notification(s) across ${leaguesOk}/${leagueIds.length} league(s)`);
  return 0;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`alerts crashed: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
