#!/usr/bin/env node
// Tradewinds push-alert job (design §11.3).
//
//   node pipeline/alerts.mjs                 # diff against data/alerts-state.json, push what is new
//   ALERT_TEST=1 node pipeline/alerts.mjs    # one "alerts are on" push per device, no state change
//
// There is no server, so this scheduled Action IS the push sender (§11.1): it signs with VAPID and
// encrypts per RFC 8291 through web-push, which CI installs at run time
// (`npm i --no-save web-push@3.6.7`) so the repo itself stays dependency-free.
//
// Env: PUSH_SUBSCRIPTIONS (JSON array of pairing payloads, §11.4), VAPID_PUBLIC_KEY,
//      VAPID_PRIVATE_KEY, VAPID_SUBJECT (defaults to the Pages URL), ALERT_TEST.
// Exit codes: 0 = ran (including "nothing paired"), 1 = misconfigured or every league failed.
//
// Everything above main() is pure: composeAlerts(ctx, device, state) decides WHAT to say,
// applyState(state, update) decides what to remember, and main() only wires
// env -> fetch -> engine -> sender -> data/alerts-state.json.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POLITE_DELAY_MS, fetchJson, isoTimestamp, readJsonIfExists, sleep, writeJsonFile } from "./util.mjs";
import { validateAlertsState } from "./contract.mjs";
import {
  buildContext,
  findFreeAgents,
  findTrades,
  gradeTransaction,
  playerOf,
  rosterById,
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

/** Push-service replies that mean "this endpoint is dead, stop sending" (§11.3). */
export const GONE_STATUS_CODES = new Set([404, 410]);

/** Pairing payloads may omit prefs; these are the §11.4 defaults. */
export const DEFAULT_PREFS = Object.freeze({
  trades: true,
  deals: true,
  freeAgents: true,
  minDealScore: 2,
  minFaGain: 1,
});

/** How deep to look before thresholds and the per-run cap trim the list. */
export const MAX_DEALS_SCANNED = 10;
export const MAX_FA_SCANNED = 12;

export const SLEEPER_API = "https://api.sleeper.app";
export const TRENDING_URL = `${SLEEPER_API}/v1/players/nfl/trending/add?lookback_hours=24&limit=50`;

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
 * Fill in the §11.4 defaults for a partial (or missing) prefs object.
 * @param {unknown} prefs
 * @returns {{ trades: boolean, deals: boolean, freeAgents: boolean, minDealScore: number,
 *   minFaGain: number }}
 */
export function normalizePrefs(prefs) {
  const raw = prefs && typeof prefs === "object" ? prefs : {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    trades: raw.trades !== false,
    deals: raw.deals !== false,
    freeAgents: raw.freeAgents !== false,
    minDealScore: num(raw.minDealScore, DEFAULT_PREFS.minDealScore),
    minFaGain: num(raw.minFaGain, DEFAULT_PREFS.minFaGain),
  };
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
    leagues[leagueId] = {
      seenTradeIds: [...(entry.seenTradeIds || [])].slice(-HISTORY_LIMIT),
      week: Number.isFinite(entry.week) ? Number(entry.week) : null,
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
      lastNotifiedAt: entry.lastNotifiedAt ?? null,
    };
    if (entry.expired === true) device.expired = true;
    devices[deviceId] = device;
  }
  return { v: 1, leagues, devices };
}

/**
 * Fold one device's run into the state. Pure: returns a new object and never mutates the input, so
 * every device in a league composes against the same pre-run snapshot (§11.3 diffing).
 * @param {object} state previous state
 * @param {{ leagueId?: string, week?: number|null, deviceId?: string,
 *   seen?: { trades?: string[], deals?: string[], fa?: string[] },
 *   notifiedAt?: string|null, expired?: boolean }} [update]
 * @returns {object} the next state
 */
export function applyState(state, update = {}) {
  const next = canonicalState(state);
  const { leagueId, week, deviceId, seen = {}, notifiedAt = null, expired } = update;

  if (leagueId) {
    const entry = next.leagues[leagueId] || { seenTradeIds: [], week: null };
    if (seen.trades && seen.trades.length) entry.seenTradeIds = bounded(entry.seenTradeIds, seen.trades);
    if (Number.isFinite(week)) entry.week = Number(week);
    next.leagues[leagueId] = entry;
  }

  if (deviceId) {
    const previous = next.devices[deviceId];
    const touched =
      (seen.deals && seen.deals.length) ||
      (seen.fa && seen.fa.length) ||
      Boolean(notifiedAt) ||
      expired === true;
    if (previous || touched) {
      const entry = previous || { seenDeals: [], seenFa: [], lastNotifiedAt: null };
      if (seen.deals && seen.deals.length) entry.seenDeals = bounded(entry.seenDeals, seen.deals);
      if (seen.fa && seen.fa.length) entry.seenFa = bounded(entry.seenFa, seen.fa);
      if (notifiedAt) entry.lastNotifiedAt = notifiedAt;
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
 * Collapse a whole kind into one notification when it will not fit under the per-run cap.
 * @param {string} kind
 * @param {object[]} items
 * @param {string} url
 * @returns {object}
 */
function batchOf(kind, items, url) {
  const keys = items.map((item) => item.key);
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

/**
 * Decide what one device should hear about this run. Pure — no fetch, no clock, no sending.
 *
 * @param {object} ctx engine context (needs ctx.transactions for the trade diff)
 * @param {{ id: string, leagueId?: string, rosterId?: number|null, prefs?: object,
 *   subject?: string, label?: string }} device pairing payload; `subject` sets the deep-link base
 * @param {object} state the run's pre-run alerts state (never mutated)
 * @returns {{ notifications: object[], seen: { trades: string[], deals: string[], fa: string[] },
 *   deferred: number, problems: string[] }}
 */
export function composeAlerts(ctx, device, state) {
  /** @type {string[]} */
  const problems = [];
  const prefs = normalizePrefs(device.prefs);
  const subject = device.subject || DEFAULT_SUBJECT;
  const leagueUrl = `${subject}#league`;
  const dealsUrl = `${subject}#deals`;
  const leagueId = String(device.leagueId ?? (ctx.league && ctx.league.id) ?? "");
  const leagueState = ((state && state.leagues) || {})[leagueId] || {};
  const deviceState = ((state && state.devices) || {})[device.id] || {};
  const seenTrades = new Set(leagueState.seenTradeIds || []);
  const seenDeals = new Set(deviceState.seenDeals || []);
  const seenFa = new Set(deviceState.seenFa || []);
  const rosterId = device.rosterId != null ? device.rosterId : ctx.myRosterId;

  /** @type {{ kind: string, items: object[] }[]} */
  const groups = [];
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

  const seen = { trades: [], deals: [], fa: [] };
  for (const notification of notifications) {
    const bucket = notification.kind === "trades" ? seen.trades : notification.kind === "deals" ? seen.deals : seen.fa;
    bucket.push(...notification.keys);
  }

  return { notifications, seen, deferred, problems };
}

/**
 * Group delivered notifications back into the three seen-buckets (only what actually shipped is
 * remembered, so a failed send retries next run).
 * @param {object[]} notifications
 * @returns {{ trades: string[], deals: string[], fa: string[] }}
 */
export function seenOf(notifications) {
  const seen = { trades: [], deals: [], fa: [] };
  for (const notification of notifications || []) {
    const bucket = notification.kind === "trades" ? seen.trades : notification.kind === "deals" ? seen.deals : seen.fa;
    bucket.push(...(notification.keys || []));
  }
  return seen;
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
 * Build the real sender. web-push is imported dynamically so importing this module (tests, `--check`)
 * never requires the dependency to be installed.
 * @param {{ subject: string, publicKey: string, privateKey: string }} vapid
 * @returns {Promise<(subscription: object, payload: string) => Promise<any>>}
 */
export async function defaultSender(vapid) {
  const module = await import("web-push");
  const webpush = module.default ?? module;
  return (subscription, payload) =>
    webpush.sendNotification(subscription, payload, {
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
      TTL: PUSH_TTL_SECONDS,
    });
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

  log(`tradewinds alerts — ${isoTimestamp(new Date(now))} — ${subject}`);

  const { devices, problems } = parseSubscriptions(env.PUSH_SUBSCRIPTIONS);
  for (const problem of problems) status("warn", "subscriptions", problem);
  if (!devices.length) {
    status("ok", "subscriptions", "nothing paired");
    return 0;
  }
  status("ok", "subscriptions", `${devices.length} device(s): ${devices.map((d) => d.label).join(", ")}`);

  let sender = options.sender;
  if (!sender) {
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

  // --- ALERT_TEST: one push per device, state untouched ------------------------------------------
  if (isEnabled(env.ALERT_TEST)) {
    const payload = JSON.stringify(testPayload(subject));
    let sent = 0;
    for (const device of devices) {
      try {
        await sender(device.sub, payload);
        sent += 1;
        status("ok", "test push", device.label);
      } catch (error) {
        status("warn", "test push", `${device.label}: ${statusCodeOf(error) ?? ""} ${error.message}`.trim());
      }
    }
    status("ok", "test", `${sent}/${devices.length} delivered · state untouched`);
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

  const stateFile = join(root, "data", "alerts-state.json");
  const stateIn = loadState(stateFile, status);
  let stateOut = stateIn;

  /** @type {any} */
  let nflState = null;
  try {
    nflState = await get(`${SLEEPER_API}/v1/state/nfl`);
  } catch (error) {
    status("fail", "state", `sleeper state unavailable: ${error.message}`);
    return 1;
  }
  const week = Math.max(1, Number(nflState?.week) || 1);
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

  // --- per league --------------------------------------------------------------------------------
  const leagueIds = [...new Set(devices.map((device) => device.leagueId))];
  /** @type {Map<string, any>} */
  const contexts = new Map();
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

    for (const device of mine) {
      const deviceState = (stateOut.devices || {})[device.id] || {};
      if (deviceState.expired === true) {
        status("warn", device.label, "marked expired in alerts-state — re-pair this device");
        continue;
      }
      const key = `${leagueId}|${device.userId ?? ""}`;
      if (!contexts.has(key)) {
        contexts.set(
          key,
          buildContext(
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
          ),
        );
      }
      const ctx = contexts.get(key);
      const composed = composeAlerts(ctx, { ...device, subject, rosterId: ctx.myRosterId }, stateIn);
      for (const problem of composed.problems) status("warn", device.label, problem);
      if (ctx.myRosterId == null) status("warn", device.label, "user does not own a roster here — trades only");

      /** @type {object[]} */
      const delivered = [];
      let expired = false;
      for (const notification of composed.notifications) {
        try {
          await sender(device.sub, JSON.stringify(payloadOf(notification)));
          delivered.push(notification);
          notified += 1;
          status("ok", "push", `${device.label} · ${notification.title} — ${notification.body}`);
        } catch (error) {
          if (isGoneError(error)) {
            expired = true;
            status(
              "warn",
              "push",
              `${device.label}: endpoint gone (${statusCodeOf(error)}) — marking expired; edit PUSH_SUBSCRIPTIONS by hand`,
            );
            break;
          }
          status("warn", "push", `${device.label}: send failed (${statusCodeOf(error) ?? "no status"}) — ${error.message}`);
        }
      }

      stateOut = applyState(stateOut, {
        leagueId,
        week,
        deviceId: device.id,
        seen: seenOf(delivered),
        notifiedAt: delivered.length ? isoTimestamp(new Date(now)) : null,
        expired: expired || undefined,
      });

      const summary = composed.notifications.length
        ? `${delivered.length}/${composed.notifications.length} sent`
        : "nothing new";
      status("ok", device.label, `${summary}${composed.deferred ? ` · ${composed.deferred} deferred` : ""}`);
    }
  }

  if (!leaguesOk) {
    status("fail", "leagues", `no league could be fetched (${leagueIds.length} tried)`);
    return 1;
  }

  const before = JSON.stringify(canonicalState(stateIn));
  const after = JSON.stringify(canonicalState(stateOut));
  if (before === after) {
    status("ok", "state", "data/alerts-state.json unchanged");
  } else {
    const size = writeJsonFile(stateFile, canonicalState(stateOut));
    status("ok", "state", `data/alerts-state.json written (${size.bytes} B)`);
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
