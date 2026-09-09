// Tradewinds — browser data layer: settings, pipeline files, live Sleeper/FantasyCalc layers.
//
// One call does the whole cold start: `loadAll()` reads the committed `data/*.json` (with an
// IndexedDB last-good copy behind it), layers today's live league state on top, optionally
// refreshes FantasyCalc values, and hands the lot to the engine's `buildContext`.
//
// ── The freshness object (for the UI header chips) ───────────────────────────────────────────
//   freshness.pipeline : ISO string | null — `generated_at` of the committed data files, i.e.
//                        when the cron job last rebuilt players/projections/values/schedule.
//                        Render as "values built 3 h ago".
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

/** Without these three there is nothing to analyze. */
const REQUIRED_FILES = Object.freeze(["players.json", "projections.json", "values.json"]);

/** Minimum row counts before a live FantasyCalc table may replace the committed one (design §3). */
export const FC_FLOORS = Object.freeze({ fc_redraft: 150, fc_dynasty: 300 });

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PIPELINE_REUSE_MS = 5 * 60 * 1000;
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

function assign(target, key, value) {
  if (value !== null && value !== undefined) target[key] = value;
}

/**
 * Normalize raw FantasyCalc rows into the committed values-table shape (design §3), so a live
 * overlay is byte-compatible with what the pipeline writes.
 * @param {object[]} rows raw rows from `getFantasyCalc`
 * @param {{label: string, kind: string, url: string, fetchedAt?: string}} meta
 * @returns {{label: string, kind: string, fetched_at: string, ok: boolean, count: number,
 *            url: string, values: Record<string, object>}}
 */
export function normalizeFantasyCalc(rows, { label, kind, url, fetchedAt } = {}) {
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
  return {
    label,
    kind,
    fetched_at: fetchedAt || new Date().toISOString(),
    ok: count > 0,
    count,
    url,
    values,
  };
}

const FC_OVERLAYS = Object.freeze([
  { name: "fc_redraft", isDynasty: false, label: "FantasyCalc redraft", kind: "redraft" },
  { name: "fc_dynasty", isDynasty: true, label: "FantasyCalc dynasty", kind: "dynasty" },
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
 * @property {{pipeline: string|null, live: string|null, values: "live"|"pipeline"|"cache",
 *             offline: boolean, stale: boolean}} freshness See the header comment.
 * @property {Array<{source: string, message: string}>} errors Non-fatal fallbacks.
 */

/**
 * Load everything the app needs and build the engine context.
 * @param {{settings?: object, onProgress?: (p: {step: string, label: string, done: number,
 *          total: number}) => void, deps?: LoadDeps, force?: boolean,
 *          signal?: AbortSignal}} [options]
 * @returns {Promise<LoadResult>}
 * @throws {Error} only when the app truly cannot run (no data files and no cache, or no league).
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

  // ── 1. Pipeline files ───────────────────────────────────────────────────────────────────────
  progress("pipeline", "Loading players and projections", 0);
  /** @type {Record<string, any>} */
  const files = {};
  /** @type {Record<string, "network"|"reuse"|"cache">} How each file was obtained. */
  const fileSource = {};
  await Promise.all(
    PIPELINE_FILES.map(async (file) => {
      const key = `pipeline:${file}`;
      if (force) {
        // A manual refresh re-pulls the league, not the 250 KB of pipeline output that the cron
        // only rewrites every 6 h — reuse a copy saved in the last 5 minutes. That is a
        // deliberate reuse of fresh data, not an offline fallback.
        const recent = await idb.get(key);
        const savedAt = Date.parse(recent?.savedAt ?? "");
        if (recent && Number.isFinite(savedAt) && nowMs() - savedAt < PIPELINE_REUSE_MS) {
          files[file] = recent.payload;
          fileSource[file] = "reuse";
          return;
        }
      }
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

  // ── 2. Live Sleeper layer ───────────────────────────────────────────────────────────────────
  progress("league", "Fetching live league state", 1);
  const leagueId = String(settings.leagueId ?? "");
  const nowIso = new Date(nowMs()).toISOString();
  /** @type {Record<string, any>} */
  const live = {};
  /** @type {string[]} */
  const liveStamps = [];
  let offline = pipelineOffline;

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

  // ── 3. FantasyCalc live overlay ─────────────────────────────────────────────────────────────
  progress("values", "Refreshing trade values", 2);
  const valuesFile = files["values.json"];
  const values = { ...valuesFile, sources: { ...(valuesFile?.sources ?? {}) } };
  let valuesMode = fileSource["values.json"] === "cache" ? "cache" : "pipeline";
  const fcParams = fcParamsFromLeague(live.league);
  let anyLive = false;
  let anyFcCache = false;

  await Promise.all(
    FC_OVERLAYS.map(async ({ name, isDynasty, label, kind }) => {
      const params = { isDynasty, ...fcParams };
      const url = sleeper.fantasyCalcUrl(params);
      const key = fcCacheKey(name, fcParams);
      try {
        const rows = await sleeper.getFantasyCalc(params, request);
        const table = normalizeFantasyCalc(rows, { label, kind, url, fetchedAt: nowIso });
        if (table.count < FC_FLOORS[name]) {
          errors.push({
            source: name,
            message: `FantasyCalc returned ${table.count} rows (floor ${FC_FLOORS[name]}) — keeping the committed table`,
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
    },
    settings,
  );
  progress("done", "Ready", PROGRESS_TOTAL);

  return {
    ctx,
    freshness: {
      pipeline: pipelineAt,
      live: liveAt,
      values: valuesMode,
      offline,
      stale,
    },
    errors,
  };
}

/**
 * Pull-to-refresh: re-fetch the live layers, reusing pipeline files fetched in the last 5 minutes.
 * Sleeper is never served from the cache first here — the cache is only a last resort so a refresh
 * with no signal degrades instead of blanking the app (`freshness.offline` then reads true).
 * @param {object} [settings]
 * @param {{onProgress?: Function, deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<LoadResult>}
 */
export function refreshLive(settings, options = {}) {
  return loadAll({ ...options, settings: settings ?? loadSettings(), force: true });
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

/**
 * League transactions, newest first. Closed weeks are cached in IndexedDB (they never change);
 * the current week is always re-fetched.
 * @param {object} ctx Engine context (uses `ctx.league.id` and `ctx.week`).
 * @param {{rounds?: number[]|number, deps?: LoadDeps, signal?: AbortSignal}} [options] `rounds`
 *   may be a list of weeks or a single number meaning "weeks 1..N".
 * @returns {Promise<Transaction[]>}
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

  return results.flat().sort((a, b) => b.created - a.created);
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
 * Every league a user is in for a season, for the Settings league picker.
 * @param {string} userId
 * @param {string|number} [season]
 * @param {{deps?: LoadDeps, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<{league_id: string, name: string, total_rosters: number,
 *           status: string, season: string}>>}
 */
export async function listLeagues(userId, season = DEFAULTS.season, options = {}) {
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
