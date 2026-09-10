// Tradewinds — live Sleeper + FantasyCalc client (browser, no dependencies).
//
// Every Sleeper request is cache-busted (`cb=<ms>`) and sent with `cache: "no-store"` so the
// browser/CDN never hands back a stale roster (design §5, FR-002). Requests time out after 12 s
// and retry twice on transport errors and on 5xx/429 — never on a 4xx like 404, which is a real
// answer ("no such league") rather than a blip.
//
// Every function takes an optional trailing options object so callers (and tests) can inject a
// `fetchImpl` instead of monkey-patching `globalThis.fetch`.

import { SLEEPER, FANTASYCALC } from "./config.js";

/** Request defaults; exported so the UI/tests can read the contract rather than restate it. */
export const REQUEST_DEFAULTS = Object.freeze({
  timeoutMs: 12000,
  retries: 2,
  backoffMs: Object.freeze([400, 900]),
});

/**
 * Error thrown by every function in this module.
 * @property {number} status HTTP status, or 0 for a transport/timeout failure.
 * @property {string} url Request URL (without the cache-buster).
 */
export class SleeperError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, url?: string, cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "SleeperError";
    this.status = info.status ?? 0;
    this.url = info.url ?? "";
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

/**
 * Append a cache-buster, respecting a URL that already carries a query string.
 * @param {string} url
 * @param {number} [stamp]
 * @returns {string}
 */
export function withCacheBuster(url, stamp = Date.now()) {
  return `${url}${url.includes("?") ? "&" : "?"}cb=${stamp}`;
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Transport failures and these statuses are worth a second look. */
const retryableStatus = (status) => status === 429 || (status >= 500 && status <= 599);

/**
 * @typedef {object} RequestOptions
 * @property {typeof fetch} [fetchImpl] Fetch implementation (default `globalThis.fetch`).
 * @property {number} [timeoutMs] Per-attempt timeout (default 12000).
 * @property {number} [retries] Extra attempts after the first (default 2).
 * @property {number[]} [backoffMs] Delay before each retry (default [400, 900]).
 * @property {boolean} [cacheBust] Append `cb=<ms>` (default true).
 * @property {AbortSignal} [signal] Caller cancellation, combined with the timeout.
 */

/**
 * Fetch JSON with timeout + retry. Resolves the parsed body (Sleeper answers `null` for a few
 * "not found" cases with a 200 — that is passed through as `null`, not an error).
 * @param {string} url Absolute URL without a cache-buster.
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
export async function requestJson(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = REQUEST_DEFAULTS.timeoutMs,
    retries = REQUEST_DEFAULTS.retries,
    backoffMs = REQUEST_DEFAULTS.backoffMs,
    cacheBust = true,
    signal,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new SleeperError("fetch is not available in this environment", { url });
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0);

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) throw new SleeperError("request cancelled", { url });
      signal.addEventListener("abort", onAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(cacheBust ? withCacheBuster(url) : url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        const error = new SleeperError(`HTTP ${response.status} for ${url}`, {
          status: response.status,
          url,
        });
        if (retryableStatus(response.status) && attempt < retries) {
          lastError = error;
          continue;
        }
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error instanceof SleeperError) throw error;
      const message = timedOut
        ? `timeout after ${timeoutMs}ms for ${url}`
        : `network error for ${url}: ${error?.message ?? error}`;
      lastError = new SleeperError(message, { status: 0, url, cause: error });
      if (attempt >= retries) throw lastError;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  /* c8 ignore next */
  throw lastError ?? new SleeperError(`request failed for ${url}`, { url });
}

/**
 * League settings, scoring and roster positions.
 * @param {string} leagueId
 * @param {RequestOptions} [options]
 * @returns {Promise<object>}
 */
export function getLeague(leagueId, options) {
  return requestJson(`${SLEEPER.v1}/league/${leagueId}`, options);
}

/**
 * League members (display names, avatars, team names).
 * @param {string} leagueId
 * @param {RequestOptions} [options]
 * @returns {Promise<object[]>}
 */
export function getUsers(leagueId, options) {
  return requestJson(`${SLEEPER.v1}/league/${leagueId}/users`, options);
}

/**
 * Rosters with player ids, starters, reserve and record.
 * @param {string} leagueId
 * @param {RequestOptions} [options]
 * @returns {Promise<object[]>}
 */
export function getRosters(leagueId, options) {
  return requestJson(`${SLEEPER.v1}/league/${leagueId}/rosters`, options);
}

/**
 * Raw transactions for one scoring period (Sleeper calls it a "round"; it is the week).
 * @param {string} leagueId
 * @param {number} round
 * @param {RequestOptions} [options]
 * @returns {Promise<object[]>}
 */
export function getTransactions(leagueId, round, options) {
  return requestJson(`${SLEEPER.v1}/league/${leagueId}/transactions/${round}`, options);
}

/**
 * One player's live Sleeper row — the only endpoint that carries a FRESH injury status without
 * downloading the 15 MB player dump (design §12.1; verified live 2026-09-10: 200, ~1.2 KB,
 * carrying `injury_status`, `injury_body_part`, `injury_notes`, `news_updated` and
 * `depth_chart_order`). Sleeper's CDN caches it for ~600 s, so the cache-buster `requestJson`
 * adds is load-bearing here rather than a nicety.
 * @param {string|number} id Sleeper player id (e.g. "11604")
 * @param {RequestOptions} [options]
 * @returns {Promise<object|null>} the raw player row, or null when Sleeper has no such id
 */
export function getPlayer(id, options) {
  return requestJson(`${SLEEPER.v1}/players/nfl/${encodeURIComponent(String(id))}`, options);
}

/**
 * NFL state — current week, season, season type.
 * @param {RequestOptions} [options]
 * @returns {Promise<object>}
 */
export function getState(options) {
  return requestJson(`${SLEEPER.v1}/state/nfl`, options);
}

/**
 * Trending adds/drops across all of Sleeper.
 * @param {"add"|"drop"} [type]
 * @param {number} [hours]
 * @param {number} [limit]
 * @param {RequestOptions} [options]
 * @returns {Promise<Array<{player_id: string, count: number}>>}
 */
export function getTrending(type = "add", hours = SLEEPER.trendingLookbackHours, limit = 50, options) {
  return requestJson(
    `${SLEEPER.v1}/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`,
    options,
  );
}

/**
 * Look up a Sleeper account by username (or user id). Resolves `null` when there is no match.
 * @param {string} username
 * @param {RequestOptions} [options]
 * @returns {Promise<object|null>}
 */
export function getUser(username, options) {
  return requestJson(`${SLEEPER.v1}/user/${encodeURIComponent(username)}`, options);
}

/**
 * Every NFL league a user is in for a season.
 * @param {string} userId
 * @param {string|number} season
 * @param {RequestOptions} [options]
 * @returns {Promise<object[]>}
 */
export function getUserLeagues(userId, season, options) {
  return requestJson(`${SLEEPER.v1}/user/${userId}/leagues/nfl/${season}`, options);
}

/**
 * Build the FantasyCalc values URL for a league shape. Exported so the values table can record
 * exactly which URL produced it (the pipeline records the same string).
 * @param {{isDynasty: boolean, numQbs: number, numTeams: number, ppr: number}} params
 * @returns {string}
 */
export function fantasyCalcUrl({ isDynasty, numQbs, numTeams, ppr }) {
  return `${FANTASYCALC.base}?isDynasty=${Boolean(isDynasty)}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
}

/**
 * FantasyCalc consensus values for the league shape. No cache-buster: FantasyCalc caches for
 * ~20 min server-side anyway, and a stable URL keeps its CDN (and ours) useful.
 * @param {{isDynasty: boolean, numQbs: number, numTeams: number, ppr: number}} params
 * @param {RequestOptions} [options]
 * @returns {Promise<object[]>} raw FantasyCalc rows
 */
export function getFantasyCalc(params, options = {}) {
  return requestJson(fantasyCalcUrl(params), { ...options, cacheBust: false });
}
