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
//      ALERT_DRY / ALERT_DRY_LEAGUE / ALERT_DRY_USER.
// Exit codes: 0 = ran (including "nothing paired"), 1 = misconfigured or every league failed.
//
// Everything above main() is pure: composeAlerts(ctx, device, state, options) decides WHAT to say,
// applyState(state, update) decides what to remember, and main() only wires
// env -> fetch -> engine -> sender -> data/alerts-state.json + data/advisor.json.

import { createHash } from "node:crypto";
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
 * Fill in the §11.4/§12.3 defaults for a partial (or missing) prefs object. `advice` is on by
 * default (it is the reason the job runs every ten minutes); `rivalNews` is off, because a rival's
 * injury is interesting, not actionable.
 * @param {unknown} prefs
 * @returns {{ trades: boolean, deals: boolean, freeAgents: boolean, advice: boolean,
 *   rivalNews: boolean, minDealScore: number, minFaGain: number }}
 */
export function normalizePrefs(prefs) {
  const raw = prefs && typeof prefs === "object" ? prefs : {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    trades: raw.trades !== false,
    deals: raw.deals !== false,
    freeAgents: raw.freeAgents !== false,
    advice: raw.advice !== false,
    rivalNews: raw.rivalNews === true,
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
    if (entry.expired === true) device.expired = true;
    devices[deviceId] = device;
  }
  return { v: 1, leagues, devices };
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
  const { leagueId, week, status, statusAt, deviceId, seen = {}, notifiedAt = null, expired } = update;

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
      expired === true;
    if (previous || touched) {
      const entry = previous || { seenDeals: [], seenFa: [], seenAdvice: [], lastNotifiedAt: null };
      if (seen.deals && seen.deals.length) entry.seenDeals = bounded(entry.seenDeals, seen.deals);
      if (seen.fa && seen.fa.length) entry.seenFa = bounded(entry.seenFa, seen.fa);
      if (seen.advice && seen.advice.length) entry.seenAdvice = bounded(entry.seenAdvice, seen.advice);
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

/**
 * @returns {{ trades: string[], deals: string[], fa: string[], advice: string[] }}
 */
function emptySeen() {
  return { trades: [], deals: [], fa: [], advice: [] };
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
 * @param {{ status?: Record<string, string>, seeding?: boolean }} [options]
 * @returns {{ notifications: object[], advisories: object[], baseline: string[],
 *   seen: { trades: string[], deals: string[], fa: string[], advice: string[] },
 *   seeding: boolean, deferred: number, problems: string[] }}
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
  if (rosterId != null) {
    try {
      const events = diffStatuses(previousStatus, nextStatus);
      advisories = adviseAll(ctx, { rosterId, events, includeRivals: prefs.rivalNews }) || [];
    } catch (error) {
      problems.push(`adviseAll failed: ${error.message}`);
      advisories = [];
    }
  }

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

  return { notifications, advisories, baseline, seen, seeding, deferred, problems };
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
    const parsed = parseSubscriptions(env.PUSH_SUBSCRIPTIONS);
    for (const problem of parsed.problems) status("warn", "subscriptions", problem);
    devices = parsed.devices;
    if (!devices.length) {
      status("ok", "subscriptions", "nothing paired");
      return 0;
    }
    status("ok", "subscriptions", `${devices.length} device(s): ${devices.map((d) => d.label).join(", ")}`);
  }

  let sender = options.sender;
  if (!sender && !dry) {
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
  if (!dry && isEnabled(env.ALERT_TEST)) {
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
      const seenKeys = feedKeys.get(leagueId);
      for (const advisory of composed.advisories) {
        if (!advisory || typeof advisory.key !== "string" || seenKeys.has(advisory.key)) continue;
        seenKeys.add(advisory.key);
        feedUpdates[leagueId].items.push(advisory);
      }

      /** @type {object[]} */
      const delivered = [];
      let expired = false;
      for (const notification of composed.notifications) {
        if (dry) {
          delivered.push(notification);
          notified += 1;
          log(`[dry] ${notification.title} — ${notification.body}`);
          continue;
        }
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

      if (!dry) {
        const seen = seenOf(delivered);
        if (composed.baseline.length) seen.advice = [...seen.advice, ...composed.baseline];
        stateOut = applyState(stateOut, {
          leagueId,
          week,
          deviceId: device.id,
          seen,
          notifiedAt: delivered.length ? isoTimestamp(new Date(now)) : null,
          expired: expired || undefined,
        });
      }

      const summary = composed.notifications.length
        ? `${delivered.length}/${composed.notifications.length} sent`
        : "nothing new";
      status("ok", device.label, `${summary}${composed.deferred ? ` · ${composed.deferred} deferred` : ""}`);
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
    return 1;
  }

  // --- dry run: print, write nothing ------------------------------------------------------------
  if (dry) {
    const advisories = Object.values(feedUpdates).flatMap((entry) => entry.items);
    log(JSON.stringify(advisories, null, 2));
    status("ok", "dry", `${notified} notification(s) · ${advisories.length} advisory(ies) · nothing written`);
    return 0;
  }

  const before = JSON.stringify(canonicalState(stateIn));
  const after = JSON.stringify(canonicalState(stateOut));
  if (before === after) {
    status("ok", "state", "data/alerts-state.json unchanged");
  } else {
    const size = writeJsonFile(stateFile, canonicalState(stateOut));
    status("ok", "state", `data/alerts-state.json written (${size.bytes} B)`);
  }

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
