// Tradewinds — browser data layer: settings, pipeline files, live Sleeper/FantasyCalc layers.
//
// One call does the whole cold start: `loadAll()` reads the committed `data/*.json` (with an
// IndexedDB last-good copy behind it), layers today's live league state on top, optionally
// refreshes FantasyCalc values, and hands the lot to the engine's `buildContext`.
//
// ── Using it (the UI's whole contract with this module) ──────────────────────────────────────
//   import { applyDeepLink, clearDeepLink, loadAll, saveSettings, SetupRequiredError } from "../data.js";
//
//   const patch = await applyDeepLink();       // ?league=<id>&user=<username|id> → settings patch
//   if (patch) { saveSettings(patch); clearDeepLink(); }   // then the address bar is tidy again
//   try {
//     const { ctx, freshness, errors } = await loadAll({ onProgress });
//   } catch (error) {
//     if (error instanceof SetupRequiredError) return showSetup();  // no league yet → onboarding
//     throw error;                                                  // anything else is a real failure
//   }
// There is no baked-in league any more: `settings.leagueId` starts null and `loadAll` throws
// `SetupRequiredError` (`code: "SETUP_REQUIRED"`) until onboarding saves one. `settings.userId`
// stays optional — a league with no user loads fine and `ctx.myRosterId` is null (viewer mode).
// For the onboarding league picker: `getCurrentSeason()` → season label, then
// `listLeagues(userId, season)`; both `lookupUser` and `listLeagues` are re-exported here.
//
// ── The freshness object (for the UI header chips) ───────────────────────────────────────────
//   freshness.pipeline : ISO string | null — `generated_at` of the committed data files, i.e.
//                        when the cron job last rebuilt players/projections/values/schedule.
//                        Render as "values built 3 h ago".
//   freshness.pipelineSource : "network" — the data files were downloaded on this load.
//                        "idb" — `data/meta.json` still carried the same `generated_at` as the
//                        stored copy, so the 250 KB behind it was reused from IndexedDB
//                        (or, when offline, the last-good copy was all we had).
//   freshness.season   : string — season the app is in, from `state.league_season` (Sleeper flips
//                        it in the spring), falling back to `state.season` then `settings.season`.
//   freshness.live     : ISO string | null — "as of" time of the league snapshot in ctx. Equals
//                        now when league/users/rosters/state all came off the network; when any
//                        piece came from the cache it is the OLDEST piece's save time, so the
//                        chip never over-promises. Render as "rosters live 12:04".
//   freshness.values   : "live"     — FantasyCalc answered and its table replaced the committed
//                                     one (row count cleared the sanity floor).
//                        "pipeline" — the committed data/values.json is in play (FantasyCalc was
//                                     unreachable, or returned too few rows to trust).
//                        "cache"    — values came out of IndexedDB, not the network (offline).
//   freshness.offline  : true when ANY layer fell back to a cached copy. Show the offline banner.
//   freshness.stale    : true when the pipeline files are more than 24 h old (cron is behind);
//                        worth a quiet warning, the app still works.
// `errors` is a parallel, non-fatal list of `{ source, message }` — one entry per layer that had
// to fall back. An empty array means everything came from the network.
//
// ── New trades, for the toast and the League dot (design §11.4) ──────────────────────────────
//   const { txns, newTradeIds } = await getTransactionsWithNew(ctx);   // ids never shown here
//   if (newTradeIds.length) showToast(...);                            // then, once on screen:
//   await markTradesSeen(ctx.league.id, newTradeIds);
// `getTransactions` still returns a plain array (the ids ride along as a non-enumerable
// `newTradeIds` property), so older callers are untouched. Push notifications for the same
// trades are a separate path entirely — see `src/push.js` and `pipeline/alerts.mjs`.
//
// ── Live injury statuses, for the Advisor tab (design §12.4) ─────────────────────────────────
//   const { ctx: fresh, rows, failed, prev, next } = await refreshStatuses(ctx, ids);
// `ids` is the watch set (my roster + reserve). Each id is read from Sleeper's per-player
// endpoint — the only cheap source of a FRESH `injury_status` — with bounded concurrency; one
// dead id lands in `failed` and never throws. The rows are applied to a NEW context (the input
// `ctx` is never mutated) and stored under IDB `status:<leagueId>` so the next visit can diff
// against them: `prev` is the snapshot that was in the drawer, `next` is the one just written,
// and both are `Record<playerId, StatusKey>` ready for the engine's `diffStatuses`.
// The advisories the app has already shown live under IDB `seenAdvice:<leagueId>` —
// `unseenAdviceKeys()` drives the Advisor tab dot, `markAdviceSeen()` clears it.

import { DEFAULTS, STORAGE_KEY } from "./config.js";
import * as sleeper from "./sleeper.js";
import { idb as defaultIdb } from "./idb.js";

/** Files the pipeline commits under `data/`. */
export const PIPELINE_FILES = Object.freeze([
  "players.json",
  "projections.json",
  "values.json",
  "schedule.json",
  "meta.json",
]);

/**
 * The advisor feed (design §12.3/§12.4) — written by the alerts job, NOT part of `PIPELINE_FILES`
 * because the app must open perfectly well without it: a repo that has never run the job simply
 * has no such file, and `ctx.advisorFeed` is then null.
 */
export const ADVISOR_FILE = "advisor.json";

/** The heavy four. `meta.json` is fetched first and decides whether these are downloaded at all. */
const PIPELINE_DATA_FILES = Object.freeze(PIPELINE_FILES.filter((file) => file !== "meta.json"));

/** Without these three there is nothing to analyze. */
const REQUIRED_FILES = Object.freeze(["players.json", "projections.json", "values.json"]);

/** Minimum row counts before a live FantasyCalc table may replace the committed one (design §3). */
export const FC_FLOORS = Object.freeze({
  fc_redraft: 150,
  fc_dynasty: 300,
  fc_redraft_2qb: 150,
  fc_dynasty_2qb: 300,
});

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PROGRESS_TOTAL = 4;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readStoredSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Current settings: `DEFAULTS` deep-merged with whatever the Settings tab has persisted.
 * Always returns a fresh, mutable object — DEFAULTS is never handed out by reference.
 * @returns {object} settings
 */
export function loadSettings() {
  return deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), readStoredSettings());
}

/**
 * Merge a patch into the stored settings and persist the result.
 * @param {object} patch Partial settings (nested objects are merged, arrays replaced).
 * @returns {object} the merged settings
 */
export function saveSettings(patch = {}) {
  const next = deepMerge(loadSettings(), patch);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("Tradewinds: settings could not be saved locally", error);
  }
  return next;
}

// ── Setup, deep links and the season label ───────────────────────────────────────────────────

/**
 * No league configured yet. The UI catches this (or `error.code === "SETUP_REQUIRED"`) and shows
 * onboarding instead of an error card — it is a starting state, not a failure.
 */
export class SetupRequiredError extends Error {
  /** @param {string} [message] */
  constructor(message = "Tradewinds has no Sleeper league yet.") {
    super(message);
    this.name = "SetupRequiredError";
    this.code = "SETUP_REQUIRED";
  }
}

const trimmed = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** Sleeper ids (leagues, users) are numeric snowflake strings; a username never is. */
const isNumericId = (value) => /^\d+$/.test(value);

/** Query parameters that make up a shared league link. */
const DEEP_LINK_PARAMS = Object.freeze(["league", "user"]);

/**
 * Parse a shared link — `?league=<id>&user=<username or numeric id>` — into a settings patch.
 * Pure: no network, no storage. `user` is optional (the league then opens in viewer mode) and is
 * read as a user id when it is all digits, otherwise as a username for `applyDeepLink` to resolve.
 * @param {string} [search] defaults to `location.search`
 * @returns {{leagueId: string, userId?: string, username?: string}|null} null when there is no
 *   usable `league` parameter (absent, empty, or not a Sleeper id).
 */
export function readDeepLink(search = globalThis.location?.search ?? "") {
  let params;
  try {
    params = new URLSearchParams(trimmed(search).replace(/^[?#]/, ""));
  } catch {
    return null;
  }
  const leagueId = trimmed(params.get("league"));
  if (!isNumericId(leagueId)) return null;
  const user = trimmed(params.get("user"));
  if (!user) return { leagueId };
  return isNumericId(user) ? { leagueId, userId: user } : { leagueId, username: user };
}

/**
 * `readDeepLink` plus the one network call it may need: turning a username into a user id.
 * The UI applies the result with `saveSettings(patch)` before `loadAll`, then `clearDeepLink()`.
 * An unresolvable username is not fatal — the league still opens read-only.
 * @param {{search?: string, deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<{leagueId: string, userId?: string, username?: string}|null>}
 */
export async function applyDeepLink(options = {}) {
  const { search, deps, signal } = options;
  const patch = readDeepLink(search);
  if (!patch?.username) return patch;
  try {
    const user = await lookupUser(patch.username, { deps, signal });
    return { leagueId: patch.leagueId, userId: user.user_id, username: user.display_name };
  } catch (error) {
    console.warn(`Tradewinds: deep-link user "${patch.username}" not found —`, message(error));
    return { leagueId: patch.leagueId, username: patch.username };
  }
}

/** Drop the deep-link parameters from the address bar once they have been saved. Never throws. */
export function clearDeepLink() {
  const history = globalThis.history;
  const href = globalThis.location?.href;
  if (typeof history?.replaceState !== "function" || !href) return;
  try {
    const url = new URL(href);
    if (!DEEP_LINK_PARAMS.some((key) => url.searchParams.has(key))) return;
    for (const key of DEEP_LINK_PARAMS) url.searchParams.delete(key);
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* a browser that refuses replaceState is not worth failing the boot over */
  }
}

/** Season label from the calendar: Sleeper rolls over to the next season in March. */
function fallbackSeason(now = Date.now()) {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  return String(date.getUTCMonth() >= 2 ? year : year - 1);
}

/** Last season `loadAll`/`getCurrentSeason` saw from Sleeper — the default for `listLeagues`. */
let lastKnownSeason = null;

/**
 * Which season a Sleeper `/state/nfl` payload describes. `league_season` is the one leagues are
 * filed under (it flips before `season` does in the spring), so it wins.
 * @param {object} state
 * @param {object} [settings]
 * @returns {string}
 */
export function seasonFromState(state, settings = {}) {
  for (const candidate of [state?.league_season, state?.season, settings?.season]) {
    const value = trimmed(candidate);
    if (value) return value;
  }
  return fallbackSeason();
}

/**
 * Best season known without a network call: what the last load saw, else settings, else the
 * calendar. Used as the default for `listLeagues`.
 * @param {object} [settings]
 * @returns {string}
 */
export function currentSeason(settings) {
  if (lastKnownSeason) return lastKnownSeason;
  return trimmed(settings?.season) || trimmed(loadSettings().season) || fallbackSeason();
}

/**
 * Ask Sleeper which season it is — onboarding needs this before any league exists. Falls back to
 * `currentSeason()` when the network is gone.
 * @param {{settings?: object, deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<string>}
 */
export async function getCurrentSeason(options = {}) {
  const { settings, deps = {}, signal } = options;
  const request = { fetchImpl: deps.fetchImpl ?? globalThis.fetch, signal, ...(deps.request ?? {}) };
  try {
    lastKnownSeason = seasonFromState(await sleeper.getState(request), settings ?? {});
    return lastKnownSeason;
  } catch (error) {
    console.warn("Tradewinds: could not read the NFL state —", message(error));
    return currentSeason(settings);
  }
}

/** Resolve a repo-relative path against the document, so the app works under `/tradewinds/`. */
function siteUrl(relative) {
  const base =
    (typeof document !== "undefined" && document?.baseURI) || globalThis.location?.href || "";
  if (!base) return relative;
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

async function fetchDataFile(file, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this environment");
  const url = siteUrl(`data/${file}`);
  // No cache-buster here on purpose: `no-store` is enough, and a stable URL keeps the service
  // worker's cached copy addressable when the network is gone.
  const response = await fetchImpl(url, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

function makeProgress(onProgress) {
  if (typeof onProgress !== "function") return () => {};
  return (step, label, done) => {
    try {
      onProgress({ step, label, done, total: PROGRESS_TOTAL });
    } catch {
      /* a broken progress handler must never fail the load */
    }
  };
}

const message = (error) => String(error?.message ?? error ?? "unknown error");
const isoOrNull = (value) => (typeof value === "string" && value ? value : null);

/**
 * FantasyCalc query parameters implied by a league's shape.
 * @param {object} league raw Sleeper league
 * @returns {{numQbs: number, numTeams: number, ppr: number}}
 */
export function fcParamsFromLeague(league) {
  const positions = Array.isArray(league?.roster_positions) ? league.roster_positions : [];
  const numQbs = positions.filter((p) => p === "QB" || p === "SUPER_FLEX").length || 1;
  const numTeams = Number(league?.total_rosters) || Number(league?.settings?.num_teams) || 12;
  const rec = Number(league?.scoring_settings?.rec);
  // No `rec` in the scoring settings means no points per reception — same default the pipeline
  // uses (pipeline/sources/fantasycalc.mjs), so the live URL matches the committed one exactly.
  return { numQbs, numTeams, ppr: Number.isFinite(rec) ? rec : 0 };
}

/**
 * Which committed values tables a league's shape resolves to (design §10.2). Superflex/2QB
 * leagues price quarterbacks on a different scale, so they get their own tables; everything else
 * (numTeams, ppr) moves values ≤ 2 % and shares the 1QB tables.
 * @param {number} numQbs QB + SUPER_FLEX slots in `roster_positions`
 * @returns {{fc_redraft: string, fc_dynasty: string}} role → table name
 */
export function fcTableNames(numQbs) {
  const suffix = Number(numQbs) >= 2 ? "_2qb" : "";
  return { fc_redraft: `fc_redraft${suffix}`, fc_dynasty: `fc_dynasty${suffix}` };
}

function assign(target, key, value) {
  if (value !== null && value !== undefined) target[key] = value;
}

/**
 * Normalize raw FantasyCalc rows into the committed values-table shape (design §3), so a live
 * overlay is byte-compatible with what the pipeline writes.
 * @param {object[]} rows raw rows from `getFantasyCalc`
 * @param {{label: string, kind: string, url: string, fetchedAt?: string,
 *          variant?: {numQbs?: number, ppr?: number}}} meta
 * @returns {{label: string, kind: string, fetched_at: string, ok: boolean, count: number,
 *            url: string, variant?: object, values: Record<string, object>}}
 */
export function normalizeFantasyCalc(rows, { label, kind, url, fetchedAt, variant } = {}) {
  const values = {};
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.player?.sleeperId;
    if (id === null || id === undefined || id === "") continue;
    const entry = {};
    assign(entry, "v", row.value);
    assign(entry, "r", row.overallRank);
    assign(entry, "pr", row.positionRank);
    assign(entry, "t", row.trend30Day);
    assign(entry, "tier", row.maybeTier);
    assign(entry, "adp", row.maybeAdp);
    assign(entry, "tf", row.maybeTradeFrequency);
    // FantasyCalc reports roster share as 0..1; the contract (design §3) wants 0..100, and the
    // pipeline scales it the same way — a live overlay must not change the units under the UI.
    assign(entry, "rp", Number.isFinite(row.maybeRosterPercent) ? row.maybeRosterPercent * 100 : null);
    assign(entry, "sd", row.maybeMovingStandardDeviation);
    values[String(id)] = entry;
    count += 1;
  }
  const table = {
    label,
    kind,
    fetched_at: fetchedAt || new Date().toISOString(),
    ok: count > 0,
    count,
    url,
    values,
  };
  if (variant) table.variant = variant;
  return table;
}

const FC_OVERLAYS = Object.freeze([
  { role: "fc_redraft", isDynasty: false, labelBase: "FantasyCalc redraft", kind: "redraft" },
  { role: "fc_dynasty", isDynasty: true, labelBase: "FantasyCalc dynasty", kind: "dynasty" },
]);

const fcCacheKey = (name, params) =>
  `fc:${name}:${params.numQbs}:${params.numTeams}:${params.ppr}`;

async function loadEngineBuildContext() {
  try {
    const module = await import("./engine/context.js");
    if (typeof module.buildContext !== "function") {
      throw new Error("src/engine/context.js does not export buildContext");
    }
    return module.buildContext;
  } catch (error) {
    throw new Error(`Tradewinds could not load its trade engine: ${message(error)}`);
  }
}

/**
 * The pipeline layer, meta first (design §10.4).
 *
 * `data/meta.json` is ~250 bytes and carries the build stamp for all five files, so it is always
 * fetched; when its `generated_at` still matches the stored copy AND every other file is in the
 * drawer, the 250 KB behind it is reused from IndexedDB instead of downloaded again. That check
 * replaces v1's "reuse anything fetched in the last 5 minutes" rule: a matching stamp means the
 * bytes are provably identical, and a changed stamp always wins, however recent the copy is.
 * @param {{fetchImpl: Function, idb: object, force: boolean,
 *          errors: Array<{source: string, message: string}>}} args
 * @returns {Promise<{files: Record<string, any>, fileSource: Record<string, string>,
 *                    pipelineSource: "network"|"idb"}>}
 */
async function loadPipelineFiles({ fetchImpl, idb, force, errors }) {
  /** @type {Record<string, any>} */
  const files = {};
  /** @type {Record<string, "network"|"idb"|"cache">} How each file was obtained. */
  const fileSource = {};
  const storedMeta = await idb.get("pipeline:meta.json");

  try {
    files["meta.json"] = await fetchDataFile("meta.json", fetchImpl);
    fileSource["meta.json"] = "network";
  } catch (error) {
    if (storedMeta) {
      files["meta.json"] = storedMeta.payload;
      fileSource["meta.json"] = "cache";
      errors.push({ source: "data/meta.json", message: `${message(error)} — using cached copy` });
    } else {
      errors.push({ source: "data/meta.json", message: message(error) });
    }
  }

  const stamp = isoOrNull(files["meta.json"]?.generated_at);
  const storedStamp = isoOrNull(storedMeta?.payload?.generated_at);
  if (!force && fileSource["meta.json"] === "network" && stamp && stamp === storedStamp) {
    const stored = await Promise.all(PIPELINE_DATA_FILES.map((file) => idb.get(`pipeline:${file}`)));
    if (stored.every((record) => record?.payload !== undefined && record?.payload !== null)) {
      PIPELINE_DATA_FILES.forEach((file, index) => {
        files[file] = stored[index].payload;
        fileSource[file] = "idb";
      });
      return { files, fileSource, pipelineSource: "idb" };
    }
  }

  await Promise.all(
    PIPELINE_DATA_FILES.map(async (file) => {
      const key = `pipeline:${file}`;
      try {
        files[file] = await fetchDataFile(file, fetchImpl);
        fileSource[file] = "network";
        await idb.set(key, files[file]);
      } catch (error) {
        const cached = await idb.get(key);
        if (cached) {
          files[file] = cached.payload;
          fileSource[file] = "cache";
          errors.push({ source: `data/${file}`, message: `${message(error)} — using cached copy` });
        } else {
          errors.push({ source: `data/${file}`, message: message(error) });
        }
      }
    }),
  );

  // Stamp the drawer with the new build only once its files are actually in it: storing a newer
  // meta over half-downloaded data would make the next load trust yesterday's players.
  if (
    fileSource["meta.json"] === "network" &&
    PIPELINE_DATA_FILES.every((file) => fileSource[file] === "network")
  ) {
    await idb.set("pipeline:meta.json", files["meta.json"]);
  }

  const downloaded = PIPELINE_DATA_FILES.some((file) => fileSource[file] === "network");
  return { files, fileSource, pipelineSource: downloaded ? "network" : "idb" };
}

/**
 * The optional advisor feed (design §12.4). Network-first with an IndexedDB copy behind it, and
 * a total failure is not an error: a repo whose alerts job has never run has no `data/advisor.
 * json` at all, so "absent" is the ordinary case and resolves `null`. Never throws, never
 * contributes to `errors`, and never keeps `loadAll` from finishing.
 * @param {{fetchImpl: Function, idb: object}} deps
 * @returns {Promise<object|null>} the parsed feed, or null when there is none
 */
export async function loadAdvisorFeed({ fetchImpl = globalThis.fetch, idb = defaultIdb } = {}) {
  const key = `pipeline:${ADVISOR_FILE}`;
  try {
    const payload = await fetchDataFile(ADVISOR_FILE, fetchImpl);
    // A GitHub Pages 404 is served as HTML, so a body that is not a feed is treated as absent
    // rather than cached over a good copy.
    if (!isPlainObject(payload) || !isPlainObject(payload.leagues)) return null;
    await idb.set(key, payload);
    return payload;
  } catch {
    const cached = await idb.get(key);
    return isPlainObject(cached?.payload) ? cached.payload : null;
  }
}

/**
 * @typedef {object} LoadDeps
 * @property {typeof fetch} [fetchImpl] Fetch used for both data files and APIs.
 * @property {{get: Function, set: Function, del: Function, keys: Function}} [idb] Cache backend.
 * @property {Function} [buildContext] Engine entry point (default: dynamic import of engine/context.js).
 * @property {() => number} [now] Clock, for tests.
 * @property {object} [request] Extra options forwarded to sleeper.js (timeoutMs, retries, backoffMs).
 */

/**
 * @typedef {object} LoadResult
 * @property {object} ctx Engine context from `buildContext`.
 * @property {{pipeline: string|null, pipelineSource: "network"|"idb", season: string,
 *             live: string|null, values: "live"|"pipeline"|"cache", offline: boolean,
 *             stale: boolean}} freshness See the header comment.
 * @property {Array<{source: string, message: string}>} errors Non-fatal fallbacks.
 */

/**
 * Load everything the app needs and build the engine context.
 * @param {{settings?: object, onProgress?: (p: {step: string, label: string, done: number,
 *          total: number}) => void, deps?: LoadDeps, force?: boolean,
 *          signal?: AbortSignal}} [options] `force: true` re-downloads the pipeline files even
 *   when `data/meta.json` says they are unchanged (Settings → "reload data").
 * @returns {Promise<LoadResult>}
 * @throws {SetupRequiredError} when no league is configured yet — show onboarding, not an error.
 * @throws {Error} when the app truly cannot run (no data files and no cache, no league snapshot).
 */
export async function loadAll(options = {}) {
  const { settings = loadSettings(), onProgress, deps = {}, force = false, signal } = options;
  const {
    fetchImpl = globalThis.fetch,
    idb = defaultIdb,
    buildContext,
    now = Date.now,
  } = deps;
  const request = { fetchImpl, signal, ...(deps.request ?? {}) };
  const progress = makeProgress(onProgress);
  /** @type {Array<{source: string, message: string}>} */
  const errors = [];
  const nowMs = () => now();

  // No baked-in league any more: without one there is nothing to fetch, so bail out before
  // touching the network. `userId` stays optional — a league opens fine in viewer mode.
  const leagueId = trimmed(settings?.leagueId);
  if (!leagueId) {
    throw new SetupRequiredError(
      "Tradewinds has no Sleeper league yet — choose one in setup, or open a ?league=<id> link.",
    );
  }

  // ── 1. Pipeline files (meta first, then only what changed) ──────────────────────────────────
  progress("pipeline", "Loading players and projections", 0);
  const { files, fileSource, pipelineSource } = await loadPipelineFiles({
    fetchImpl,
    idb,
    force,
    errors,
  });

  const missing = REQUIRED_FILES.filter((file) => !files[file]);
  if (missing.length) {
    throw new Error(
      `Tradewinds could not load ${missing.map((f) => `data/${f}`).join(", ")} and has no cached ` +
        "copy. Connect to the network once and reopen the app.",
    );
  }
  if (!files["schedule.json"]) files["schedule.json"] = { byes: {}, games: [] };
  if (!files["meta.json"]) files["meta.json"] = {};

  const pipelineOffline = REQUIRED_FILES.some((file) => fileSource[file] === "cache");
  const pipelineAt =
    isoOrNull(files["meta.json"]?.generated_at) || isoOrNull(files["players.json"]?.generated_at);
  const pipelineMs = Date.parse(pipelineAt ?? "");
  const stale = Number.isFinite(pipelineMs) ? nowMs() - pipelineMs > STALE_AFTER_MS : true;

  // The advisor feed rides along with the live layer rather than adding a round trip of its own;
  // it is awaited at step 4 and resolves null when the job has never written one.
  const advisorJob = loadAdvisorFeed({ fetchImpl, idb });

  // ── 2. Live Sleeper layer ───────────────────────────────────────────────────────────────────
  progress("league", "Fetching live league state", 1);
  const nowIso = new Date(nowMs()).toISOString();
  /** @type {Record<string, any>} */
  const live = {};
  /** @type {string[]} */
  const liveStamps = [];
  let offline = pipelineOffline;

  // Trending adds decorate the League tab and feed `findFreeAgents` (design §11.2). They are
  // nice-to-have, never load-bearing: a failure falls back to the cached list, then to an empty
  // one, and is deliberately kept OUT of `errors` and out of `freshness.offline` so a Sleeper
  // hiccup on a decoration never raises the offline banner. Started here, awaited below, so it
  // rides along with the four live calls instead of adding a round trip.
  const trendingJob = (async () => {
    const key = "sleeper:trending:add";
    try {
      const rows = await sleeper.getTrending("add", 24, 50, request);
      if (!Array.isArray(rows)) throw new Error("empty response");
      await idb.set(key, rows);
      return rows;
    } catch {
      const cached = await idb.get(key);
      return Array.isArray(cached?.payload) ? cached.payload : [];
    }
  })();

  const liveJobs = [
    ["league", () => sleeper.getLeague(leagueId, request)],
    ["users", () => sleeper.getUsers(leagueId, request)],
    ["rosters", () => sleeper.getRosters(leagueId, request)],
    ["state", () => sleeper.getState(request)],
  ];
  await Promise.all(
    liveJobs.map(async ([name, run]) => {
      const key = `sleeper:${name}:${leagueId}`;
      try {
        const payload = await run();
        if (payload === null || payload === undefined) throw new Error("empty response");
        live[name] = payload;
        liveStamps.push(nowIso);
        await idb.set(key, payload);
      } catch (error) {
        errors.push({ source: `sleeper:${name}`, message: message(error) });
        const cached = await idb.get(key);
        if (cached) {
          live[name] = cached.payload;
          liveStamps.push(cached.savedAt ?? nowIso);
        }
        offline = true;
      }
    }),
  );

  if (!live.league || !live.rosters || !live.state) {
    throw new Error(
      `Tradewinds could not reach Sleeper for league ${leagueId} and has no cached copy. ` +
        "Check the league id in Settings, then try again on a connection.",
    );
  }
  if (!live.users) live.users = [];
  const liveAt = liveStamps.length ? liveStamps.slice().sort()[0] : null;
  // Sleeper files leagues under `league_season`, which flips before `season` does in the spring.
  const season = seasonFromState(live.state, settings);
  lastKnownSeason = season;

  // ── 3. FantasyCalc live overlay ─────────────────────────────────────────────────────────────
  progress("values", "Refreshing trade values", 2);
  const valuesFile = files["values.json"];
  const values = { ...valuesFile, sources: { ...(valuesFile?.sources ?? {}) } };
  let valuesMode = fileSource["values.json"] === "cache" ? "cache" : "pipeline";
  const fcParams = fcParamsFromLeague(live.league);
  // A superflex league reads its values off the `_2qb` tables, so that is where the live overlay
  // has to land — writing it into `fc_redraft` would be values for a league shape nobody is in.
  const fcTables = fcTableNames(fcParams.numQbs);
  let anyLive = false;
  let anyFcCache = false;

  await Promise.all(
    FC_OVERLAYS.map(async ({ role, isDynasty, labelBase, kind }) => {
      const name = fcTables[role];
      const params = { isDynasty, ...fcParams };
      const url = sleeper.fantasyCalcUrl(params);
      const key = fcCacheKey(name, fcParams);
      const floor = FC_FLOORS[name] ?? FC_FLOORS[role];
      try {
        const rows = await sleeper.getFantasyCalc(params, request);
        const table = normalizeFantasyCalc(rows, {
          // Keep the committed table's wording when there is one, so the UI's source list does
          // not change label halfway through a session.
          label: values.sources[name]?.label ?? `${labelBase}${fcParams.numQbs >= 2 ? " 2QB" : ""}`,
          kind,
          url,
          fetchedAt: nowIso,
          variant: { numQbs: fcParams.numQbs },
        });
        if (table.count < floor) {
          errors.push({
            source: name,
            message: `FantasyCalc returned ${table.count} rows (floor ${floor}) — keeping the committed table`,
          });
          return;
        }
        values.sources[name] = table;
        anyLive = true;
        await idb.set(key, table);
      } catch (error) {
        errors.push({ source: name, message: message(error) });
        // Only reach for a cached overlay when the committed table is missing or was published
        // with `ok: false`; otherwise the committed copy is the better source of truth.
        const committed = values.sources[name];
        if (committed && committed.ok !== false) return;
        const cached = await idb.get(key);
        if (cached?.payload) {
          values.sources[name] = cached.payload;
          anyFcCache = true;
        }
      }
    }),
  );
  if (anyLive) valuesMode = "live";
  else if (anyFcCache && valuesMode !== "cache") valuesMode = "cache";

  // ── 4. Engine context ───────────────────────────────────────────────────────────────────────
  progress("context", "Building trade context", 3);
  const trending = await trendingJob;
  const build = buildContext ?? (await loadEngineBuildContext());
  const ctx = await build(
    {
      league: live.league,
      users: live.users,
      rosters: live.rosters,
      state: live.state,
      players: files["players.json"],
      projections: files["projections.json"],
      values,
      schedule: files["schedule.json"],
      meta: files["meta.json"],
      // Design §11.2: the engine never calls Date.now(), so the clock is an input. Both keys are
      // optional on the engine side — nothing breaks if buildContext ignores them.
      trending,
      now: nowMs(),
    },
    settings,
  );
  // Optional and additive: the engine knows nothing about the feed, so it is hung on the context
  // here. `null` is the normal value in a repo whose alerts job has not run yet (design §12.4).
  if (ctx && typeof ctx === "object") ctx.advisorFeed = await advisorJob;
  progress("done", "Ready", PROGRESS_TOTAL);

  return {
    ctx,
    freshness: {
      pipeline: pipelineAt,
      pipelineSource,
      season,
      live: liveAt,
      values: valuesMode,
      offline,
      stale,
    },
    errors,
  };
}

/**
 * Pull-to-refresh: the live layers are always re-fetched (they are never served from the cache
 * first — it is a last resort, so a refresh with no signal degrades instead of blanking the app
 * and `freshness.offline` then reads true). The pipeline files come back only if
 * `data/meta.json` says the cron has rebuilt them since the last load.
 * @param {object} [settings]
 * @param {{onProgress?: Function, deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<LoadResult>}
 */
export function refreshLive(settings, options = {}) {
  return loadAll({ ...options, settings: settings ?? loadSettings() });
}

/**
 * @typedef {object} Transaction
 * @property {string} id Sleeper transaction id.
 * @property {number} week Scoring period the move belongs to (Sleeper's `leg`).
 * @property {"trade"|"waiver"|"free_agent"|string} type
 * @property {"complete"|"failed"|string} status
 * @property {number} created Epoch ms.
 * @property {Record<string, number>} adds playerId → roster id that received them.
 * @property {Record<string, number>} drops playerId → roster id that let them go.
 * @property {number[]} rosterIds Every roster involved.
 * @property {object[]} draftPicks Traded picks (empty in leagues without pick trading).
 */

/**
 * Normalize one raw Sleeper transaction.
 * @param {object} raw
 * @param {number} round Fallback week when `leg` is absent.
 * @returns {Transaction}
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

/**
 * Which scoring periods to pull: an explicit list, a number N meaning weeks 1..N (the UI passes
 * `ctx.week`), or — by default — every week of the season so far.
 * @param {number[]|number|undefined} rounds
 * @param {number} week
 * @returns {number[]}
 */
function roundList(rounds, week) {
  if (Array.isArray(rounds) && rounds.length) {
    return rounds.map(Number).filter((round) => Number.isFinite(round) && round > 0);
  }
  const upTo = Math.floor(Number(rounds));
  const last = Number.isFinite(upTo) && upTo > 0 ? upTo : week;
  return Array.from({ length: last }, (_, index) => index + 1);
}

/** IDB key holding the trade ids this device has already been shown (design §11.4). */
const seenTradesKey = (leagueId) => `seenTrades:${leagueId}`;

/** How many trade ids to remember per league — same bound the alerts job uses (design §11.3). */
const SEEN_TRADES_MAX = 200;

/** Ids of the completed trades in a transaction list, newest first. */
function tradeIdsOf(txns) {
  return (Array.isArray(txns) ? txns : [])
    .filter((txn) => txn?.type === "trade" && txn?.status === "complete" && txn?.id)
    .map((txn) => String(txn.id));
}

/**
 * Which of these trades this device has not seen yet. Reads only — seeing them is the UI's call
 * (`markTradesSeen`), because a trade counts as seen when the League tab has actually shown it.
 * @returns {Promise<string[]>} newest first; every trade id on a device with no record yet.
 */
async function unseenTradeIds(idb, leagueId, txns) {
  const ids = tradeIdsOf(txns);
  if (!ids.length || !leagueId) return ids.length ? ids : [];
  const record = await idb.get(seenTradesKey(leagueId));
  const seen = new Set((Array.isArray(record?.payload) ? record.payload : []).map(String));
  return ids.filter((id) => !seen.has(id));
}

/**
 * Mark trades as shown, so `newTradeIds` stops reporting them. Called by the League tab once
 * the trades are on screen (and by the toast when the user taps it).
 * @param {string} leagueId
 * @param {string[]|string} ids
 * @param {{deps?: LoadDeps}} [options]
 * @returns {Promise<string[]>} the ids now remembered for this league (newest first, ≤ 200).
 */
export async function markTradesSeen(leagueId, ids, options = {}) {
  const idb = options.deps?.idb ?? defaultIdb;
  const league = trimmed(leagueId);
  const incoming = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!league) return [];
  const record = await idb.get(seenTradesKey(league));
  const previous = (Array.isArray(record?.payload) ? record.payload : []).map(String);
  // Newest first, de-duplicated, bounded — an old league would otherwise grow without limit.
  const merged = [...new Set([...incoming, ...previous])].slice(0, SEEN_TRADES_MAX);
  await idb.set(seenTradesKey(league), merged);
  return merged;
}

/**
 * League transactions, newest first. Closed weeks are cached in IndexedDB (they never change);
 * the current week is always re-fetched.
 *
 * The returned array also carries `newTradeIds` — the completed trades this device has not been
 * shown yet — as a NON-ENUMERABLE property, so every existing caller (and `assert.deepEqual`)
 * still sees a plain array of transactions. New code should prefer `getTransactionsWithNew`.
 * @param {object} ctx Engine context (uses `ctx.league.id` and `ctx.week`).
 * @param {{rounds?: number[]|number, deps?: LoadDeps, signal?: AbortSignal}} [options] `rounds`
 *   may be a list of weeks or a single number meaning "weeks 1..N".
 * @returns {Promise<Transaction[] & {newTradeIds: string[]}>}
 */
export async function getTransactions(ctx, options = {}) {
  const { rounds, deps = {}, signal } = options;
  const { fetchImpl = globalThis.fetch, idb = defaultIdb } = deps;
  const request = { fetchImpl, signal, ...(deps.request ?? {}) };
  const leagueId = String(ctx?.league?.id ?? ctx?.leagueId ?? "");
  const week = Math.max(1, Number(ctx?.week) || 1);
  const list = roundList(rounds, week);

  const results = await Promise.all(
    list.map(async (round) => {
      const key = `sleeper:txns:${leagueId}:${round}`;
      const closed = round < week;
      if (closed) {
        const cached = await idb.get(key);
        if (Array.isArray(cached?.payload)) return cached.payload;
      }
      try {
        const raw = await sleeper.getTransactions(leagueId, round, request);
        const normalized = (Array.isArray(raw) ? raw : []).map((row) => normalizeTransaction(row, round));
        if (closed) await idb.set(key, normalized);
        return normalized;
      } catch (error) {
        console.warn(`Tradewinds: transactions for week ${round} unavailable —`, message(error));
        const cached = await idb.get(key);
        return Array.isArray(cached?.payload) ? cached.payload : [];
      }
    }),
  );

  const txns = results.flat().sort((a, b) => b.created - a.created);
  const newTradeIds = await unseenTradeIds(idb, leagueId, txns);
  Object.defineProperty(txns, "newTradeIds", {
    value: newTradeIds,
    enumerable: false, // keeps the array deep-equal to a plain Transaction[]
    writable: true,
    configurable: true,
  });
  return txns;
}

/**
 * The same call, with the new-trade ids in the open. This is the shape new UI code should use:
 * `const { txns, newTradeIds } = await getTransactionsWithNew(ctx)` → show a toast when
 * `newTradeIds.length`, then `markTradesSeen(ctx.league.id, newTradeIds)` once they are on screen.
 * @param {object} ctx
 * @param {{rounds?: number[]|number, deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<{txns: Transaction[], newTradeIds: string[]}>}
 */
export async function getTransactionsWithNew(ctx, options = {}) {
  const txns = await getTransactions(ctx, options);
  return { txns, newTradeIds: txns.newTradeIds ?? [] };
}

/**
 * Fetch the transactions and hang them on the context, which is where the engine's waiver math
 * looks for them (`ctx.transactions` + `ctx.now`, design §11.2 — `waiverStatus` reads them when
 * it is called, not when the context is built, so attaching after `loadAll` is enough).
 * `loadAll` deliberately does not do this itself: it would put up to 17 extra requests on the
 * cold-start path for a feature only the Deals → Free agents tab needs.
 * @param {object} ctx
 * @param {{rounds?: number[]|number, deps?: LoadDeps, signal?: AbortSignal, now?: number}} [options]
 * @returns {Promise<{txns: Transaction[], newTradeIds: string[]}>}
 */
export async function attachTransactions(ctx, options = {}) {
  const { txns, newTradeIds } = await getTransactionsWithNew(ctx, options);
  if (ctx && typeof ctx === "object") {
    ctx.transactions = txns;
    if (!Number.isFinite(ctx.now)) ctx.now = Number(options.now) || Date.now();
  }
  return { txns, newTradeIds };
}

/* ═══════════════════════════════════════════════ live statuses + advice (design §12.4) ══════ */

/** How many per-player reads run at once. Six keeps a 17-player roster under two seconds on
 *  cellular without ever looking like a scraper to Sleeper. */
export const STATUS_CONCURRENCY = 6;

/** IDB key holding the last status snapshot this device pulled for a league. */
const statusKeyFor = (leagueId) => `status:${leagueId}`;

/** IDB key holding the advisory keys this device has already shown (design §12.4). */
const seenAdviceKeyFor = (leagueId) => `seenAdvice:${leagueId}`;

/** Same bound the alerts job keeps per device (design §12.3). */
const SEEN_ADVICE_MAX = 200;

const nullableString = (value) => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text ? text : null;
};

const finiteOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * One raw Sleeper player row → the status row shape the engine's `applyStatuses` takes.
 * Sleeper reports a healthy player as `injury_status: null` (sometimes `""`), so every empty
 * string normalizes to null — "" and null must not read as two different statuses when the
 * snapshot is diffed.
 * @param {string|number} id Sleeper player id
 * @param {object|null} raw row from `sleeper.getPlayer`
 * @returns {{id: string, inj: string|null, injPart: string|null, injNotes: string|null,
 *            newsAt: number|null, dc: number|null}}
 */
export function statusRowFrom(id, raw) {
  return {
    id: String(id),
    inj: nullableString(raw?.injury_status),
    injPart: nullableString(raw?.injury_body_part),
    injNotes: nullableString(raw?.injury_notes),
    newsAt: finiteOrNull(raw?.news_updated),
    dc: finiteOrNull(raw?.depth_chart_order),
  };
}

/**
 * The stable identity of a status (design §12.2). `news_updated` is deliberately NOT part of it:
 * Sleeper ticks that field for every headline, and a re-run of the same news is not a new event.
 * @param {{inj?: string|null, injPart?: string|null, injNotes?: string|null}} row
 * @returns {string}
 */
export function statusKeyOf(row) {
  return `${row?.inj ?? ""}|${row?.injPart ?? ""}|${row?.injNotes ?? ""}`;
}

/** `Record<id, StatusKey>` for a list of rows — the snapshot shape `diffStatuses` compares. */
export function snapshotOf(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.id == null) continue;
    out[String(row.id)] = statusKeyOf(row);
  }
  return out;
}

/**
 * `applyStatuses` as the engine defines it (design §12.2), implemented here so the data layer
 * can be used — and tested — before `src/engine/advisor.js` lands. The real export always wins
 * (see `statusApplier`); this is the same contract: a NEW context whose players map carries the
 * patched rows and whose memo is empty, with the input context untouched.
 * @param {object} ctx engine context
 * @param {Array<object>} rows status rows (unknown ids are ignored)
 * @returns {object} a new context
 */
export function applyStatusesLocal(ctx, rows = []) {
  const players = new Map(ctx?.players ?? []);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.id == null) continue;
    const id = String(row.id);
    const player = players.get(id);
    if (!player) continue;
    players.set(id, {
      ...player,
      // null is meaningful here — it is how "cleared, he is healthy again" arrives.
      inj: row.inj ?? null,
      injPart: row.injPart ?? null,
      injNotes: row.injNotes ?? null,
      newsAt: row.newsAt ?? null,
      // Depth-chart order is not part of the status event, so a row that omits it keeps
      // whatever players.json already knew.
      dc: row.dc ?? player.dc ?? null,
    });
  }
  return { ...ctx, players, memo: {} };
}

/** @type {Promise<Function>|null} memoized resolution of the engine's own `applyStatuses`. */
let statusApplierPromise = null;

/** The engine's `applyStatuses` when the module exists, otherwise the local contract copy. */
function statusApplier() {
  if (!statusApplierPromise) {
    statusApplierPromise = (async () => {
      for (const path of ["./engine/advisor.js", "./engine/index.js"]) {
        try {
          const module = await import(path);
          if (typeof module.applyStatuses === "function") return module.applyStatuses;
        } catch {
          /* not shipped yet — try the next one */
        }
      }
      return applyStatusesLocal;
    })();
  }
  return statusApplierPromise;
}

/** Run `job` over `items` with at most `limit` in flight. Order of results follows `items`. */
async function pooled(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await job(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Pull live injury statuses for a watch set and fold them into the context (design §12.4).
 *
 * Sleeper's per-player endpoint is the only cheap source of a status that is minutes old, so the
 * phone reads exactly the ids it cares about (my roster + reserve — seventeen, not fifteen
 * thousand). One dead id is a `failed` entry, never an exception: an advisory built from sixteen
 * fresh rows beats no advisory at all.
 *
 * @param {object} ctx engine context (never mutated)
 * @param {Array<string|number>} ids watch set
 * @param {{fetchImpl?: Function, idb?: object, concurrency?: number, now?: Function|number,
 *          applyStatuses?: Function, signal?: AbortSignal, request?: object,
 *          deps?: LoadDeps}} [options]
 * @returns {Promise<{ctx: object, rows: Array<object>, failed: string[], at: string,
 *                    prev: Record<string, string>|null, next: Record<string, string>}>}
 *   `ctx` is a NEW context; `prev` is the snapshot that was in the drawer before this call
 *   (null on a device's first visit — the engine treats a first sighting as "not an event").
 */
export async function refreshStatuses(ctx, ids, options = {}) {
  const deps = options.deps ?? {};
  const fetchImpl = options.fetchImpl ?? deps.fetchImpl ?? globalThis.fetch;
  const idb = options.idb ?? deps.idb ?? defaultIdb;
  const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : STATUS_CONCURRENCY;
  const clock = options.now ?? deps.now ?? Date.now;
  const nowMs = typeof clock === "function" ? Number(clock()) : Number(clock);
  const request = { fetchImpl, signal: options.signal, ...(options.request ?? deps.request ?? {}) };

  const watch = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => id != null).map(String))];
  const leagueId = String(ctx?.league?.id ?? ctx?.leagueId ?? "");
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();

  /** @type {string[]} */
  const failed = [];
  const settled = await pooled(watch, concurrency, async (id) => {
    try {
      const raw = await sleeper.getPlayer(id, request);
      if (!raw || typeof raw !== "object") throw new Error("empty response");
      return statusRowFrom(id, raw);
    } catch (error) {
      console.warn(`Tradewinds: live status for ${id} unavailable —`, message(error));
      failed.push(String(id));
      return null;
    }
  });
  const rows = settled.filter(Boolean);

  const apply = options.applyStatuses ?? deps.applyStatuses ?? (await statusApplier());
  const nextCtx = apply(ctx, rows);

  // The previous snapshot is read BEFORE the new one lands: it is the whole basis of "what
  // changed since I last looked", which is what the Advisor tab turns into events.
  let prev = null;
  let next = snapshotOf(rows);
  if (leagueId) {
    const stored = await idb.get(statusKeyFor(leagueId));
    const storedKeys = stored?.payload?.keys;
    if (isPlainObject(storedKeys)) prev = storedKeys;
    // Ids that failed this round keep their last known key, so a flaky request can never read
    // as "his status was cleared".
    if (prev) for (const id of failed) if (prev[id] !== undefined && next[id] === undefined) next[id] = prev[id];
    await idb.set(statusKeyFor(leagueId), { at, week: ctx?.week ?? null, rows, keys: next });
  }

  return { ctx: nextCtx, rows, failed, at, prev, next };
}

/**
 * The status snapshot this device last stored for a league, without touching the network.
 * @param {string} leagueId
 * @param {{deps?: LoadDeps, idb?: object}} [options]
 * @returns {Promise<{at: string|null, rows: Array<object>, keys: Record<string, string>}|null>}
 */
export async function storedStatuses(leagueId, options = {}) {
  const idb = options.idb ?? options.deps?.idb ?? defaultIdb;
  const league = trimmed(leagueId);
  if (!league) return null;
  const record = await idb.get(statusKeyFor(league));
  const payload = record?.payload;
  if (!isPlainObject(payload)) return null;
  return {
    at: isoOrNull(payload.at),
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    keys: isPlainObject(payload.keys) ? payload.keys : {},
  };
}

/**
 * Which advisory keys this device has not shown yet — the Advisor tab dot, in one call.
 * @param {string} leagueId
 * @param {string[]} keys `Advisory.key` values
 * @param {{deps?: LoadDeps, idb?: object}} [options]
 * @returns {Promise<string[]>} the subset that is new, in the order given
 */
export async function unseenAdviceKeys(leagueId, keys, options = {}) {
  const idb = options.idb ?? options.deps?.idb ?? defaultIdb;
  const league = trimmed(leagueId);
  const incoming = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(String);
  if (!league || !incoming.length) return [];
  const record = await idb.get(seenAdviceKeyFor(league));
  const seen = new Set((Array.isArray(record?.payload) ? record.payload : []).map(String));
  return [...new Set(incoming)].filter((key) => !seen.has(key));
}

/**
 * Mark advisories as shown. Called by the Advisor view once the cards are on screen — the same
 * rule the League tab uses for trades: seen means *displayed*, not *fetched*.
 * @param {string} leagueId
 * @param {string[]|string} keys
 * @param {{deps?: LoadDeps, idb?: object}} [options]
 * @returns {Promise<string[]>} the keys now remembered for this league (newest first, ≤ 200)
 */
export async function markAdviceSeen(leagueId, keys, options = {}) {
  const idb = options.idb ?? options.deps?.idb ?? defaultIdb;
  const league = trimmed(leagueId);
  const incoming = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(String);
  if (!league) return [];
  const record = await idb.get(seenAdviceKeyFor(league));
  const previous = (Array.isArray(record?.payload) ? record.payload : []).map(String);
  const merged = [...new Set([...incoming, ...previous])].slice(0, SEEN_ADVICE_MAX);
  await idb.set(seenAdviceKeyFor(league), merged);
  return merged;
}

/**
 * Resolve a Sleeper username for the Settings tab.
 * @param {string} username
 * @param {{deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<{user_id: string, display_name: string, avatar: string|null}>}
 * @throws {Error} when the username does not exist.
 */
export async function lookupUser(username, options = {}) {
  const { deps = {}, signal } = options;
  const request = { fetchImpl: deps.fetchImpl ?? globalThis.fetch, signal, ...(deps.request ?? {}) };
  const user = await sleeper.getUser(String(username ?? "").trim(), request);
  if (!user?.user_id) throw new Error(`No Sleeper user called "${username}"`);
  return {
    user_id: String(user.user_id),
    display_name: user.display_name ?? String(username),
    avatar: user.avatar ?? null,
  };
}

/**
 * Every league a user is in for a season, for onboarding and the Settings league picker.
 * @param {string} userId
 * @param {string|number} [season] defaults to the season the last load saw (`currentSeason()`).
 * @param {{deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<{league_id: string, name: string, total_rosters: number,
 *           status: string, season: string}>>}
 */
export async function listLeagues(userId, season = currentSeason(), options = {}) {
  const { deps = {}, signal } = options;
  const request = { fetchImpl: deps.fetchImpl ?? globalThis.fetch, signal, ...(deps.request ?? {}) };
  const leagues = await sleeper.getUserLeagues(String(userId), season, request);
  return (Array.isArray(leagues) ? leagues : []).map((league) => ({
    league_id: String(league.league_id),
    name: league.name ?? "(unnamed league)",
    total_rosters: Number(league.total_rosters) || 0,
    status: league.status ?? "unknown",
    season: String(league.season ?? season),
  }));
}

/**
 * Drop every cached copy (Settings → "clear cached data"). Never throws.
 * @param {{deps?: LoadDeps}} [options]
 * @returns {Promise<number>} how many keys were removed.
 */
export async function clearCache(options = {}) {
  const idb = options.deps?.idb ?? defaultIdb;
  const keys = await idb.keys();
  await Promise.all(keys.map((key) => idb.del(key)));
  return keys.length;
}
