// Tradewinds — the single seam between the UI and everything it does not own.
//
// Normal load resolves `src/data.js` + `src/engine/*`. With `?mock=1` (or the sticky
// `tradewinds.mock` flag) it resolves `src/ui/mock.js`, which implements the same surface
// from the committed test fixtures. Nothing else in src/ui/ imports the engine directly, so
// the contract below is the complete list of what the UI expects other agents to ship.

import { possessive } from "./format.js";

const qs = new URLSearchParams(location.search);
export const MOCK =
  qs.get("mock") === "1" || (qs.get("mock") !== "0" && localStorage.getItem("tradewinds.mock") === "1");

if (qs.has("mock")) {
  try {
    if (qs.get("mock") === "1") localStorage.setItem("tradewinds.mock", "1");
    else localStorage.removeItem("tradewinds.mock");
  } catch { /* private mode */ }
}

export class ServicesError extends Error {
  constructor(message, missing) {
    super(message);
    this.name = "ServicesError";
    this.missing = missing || [];
  }
}

/**
 * Thrown by data.js when no league is configured yet (design §10.4). The class travels with
 * the module that threw, so never `instanceof` it across the seam — use `isSetupRequired`.
 */
export class SetupRequiredError extends Error {
  constructor(message = "No Sleeper league is configured yet.") {
    super(message);
    this.name = "SetupRequiredError";
    this.code = "SETUP_REQUIRED";
  }
}

/** Duck-typed so it recognises data.js's own SetupRequiredError as well as the one above. */
export function isSetupRequired(err) {
  return !!err && (err.name === "SetupRequiredError" || err.code === "SETUP_REQUIRED");
}

/* ---------------------------------------------------------------- local fallbacks
   §10.3/§10.4 add four symbols to the engine and data layer. Until they land, these stand in
   so the UI (and `?mock=1`) behave identically; `loadLive()` always prefers the real export. */

const DEEP_LINK_KEYS = ["league", "user"];

/** `?league=<id>&user=<username|id>` -> a settings patch, or null. */
export function readDeepLinkLocal(search = location.search) {
  const q = new URLSearchParams(search);
  const leagueId = (q.get("league") || "").trim();
  if (!leagueId) return null;
  const user = (q.get("user") || "").trim();
  const patch = { leagueId };
  if (user) {
    // Sleeper ids are long digit strings; anything else is a username to resolve at load.
    if (/^\d{6,}$/.test(user)) patch.userId = user;
    else patch.username = user;
  } else {
    patch.userId = null;
    patch.username = null;
  }
  return patch;
}

/** Strip the deep-link params from the address bar, keeping everything else (e.g. ?mock=1). */
export function stripDeepLink() {
  try {
    const q = new URLSearchParams(location.search);
    if (!DEEP_LINK_KEYS.some((k) => q.has(k))) return;
    for (const k of DEEP_LINK_KEYS) q.delete(k);
    const qs = q.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  } catch { /* history unavailable */ }
}

function rosterOf(ctx, id) {
  return (ctx.rosters || []).find((r) => r.rosterId === id) || null;
}

function teamLabel(ctx, id) {
  const r = rosterOf(ctx, id);
  return (r && (r.teamName || r.displayName)) || `Roster ${id}`;
}

/** `{ a, aPoss, b, first }` — second person only when side A is the signed-in manager. */
export function sideNamesLocal(ctx, aRosterId, bRosterId) {
  const mine = ctx && ctx.myRosterId != null && aRosterId === ctx.myRosterId;
  const a = mine ? "You" : teamLabel(ctx, aRosterId);
  return { a, aPoss: mine ? "Your" : possessive(a), b: teamLabel(ctx, bRosterId), first: mine };
}

let pending = null;

/** Resolve (once) the whole service surface. Throws ServicesError if a module is missing. */
export function services() {
  if (!pending) pending = MOCK ? loadMock() : loadLive();
  return pending;
}

async function loadMock() {
  const m = await import("./mock.js");
  return { mode: "mock", ...m.api };
}

async function loadLive() {
  const specs = [
    ["data", "../data.js"],
    ["values", "../engine/values.js"],
    ["lineup", "../engine/lineup.js"],
    ["trade", "../engine/trade.js"],
    ["finder", "../engine/finder.js"],
    ["explain", "../engine/explain.js"],
  ];
  const settled = await Promise.allSettled(specs.map(([, p]) => import(/* @vite-ignore */ p)));
  const missing = [];
  const mods = {};
  settled.forEach((r, i) => {
    const [name, path] = specs[i];
    if (r.status === "fulfilled") mods[name] = r.value;
    else missing.push({ name, path, message: String(r.reason && r.reason.message) });
  });
  if (missing.length) {
    throw new ServicesError(
      "Some app modules could not be loaded: " + missing.map((m) => m.path).join(", "),
      missing
    );
  }

  // sleeper.js is already in the graph (data.js imports it), so this costs nothing. It backs
  // the two lookup helpers when data.js omits them, and supplies `getLeague`, which onboarding
  // needs for the roster_positions / scoring_settings that `listLeagues` does not carry.
  let sleeper = null;
  try { sleeper = await import("../sleeper.js"); } catch { /* optional */ }

  return {
    mode: "live",

    // ---- src/data.js ------------------------------------------------------------------
    loadSettings: mods.data.loadSettings,
    saveSettings: mods.data.saveSettings,
    loadAll: mods.data.loadAll,
    refreshLive: mods.data.refreshLive,
    getTransactions: mods.data.getTransactions,
    lookupUser: mods.data.lookupUser || (sleeper && sleeper.getUser) || null,
    listLeagues: mods.data.listLeagues || (sleeper && sleeper.getUserLeagues) || null,
    clearCache: mods.data.clearCache || null,
    // §10.4 — first-run / deep-link plumbing. `applyDeepLink()` RESOLVES a patch (it may hit
    // the network to turn a username into an id); the caller saves it and clears the query.
    readDeepLink: mods.data.readDeepLink || readDeepLinkLocal,
    applyDeepLink: mods.data.applyDeepLink || (async (o = {}) => readDeepLinkLocal(o.search)),
    clearDeepLink: mods.data.clearDeepLink || stripDeepLink,
    // Onboarding extras: the season Sleeper thinks it is, and the full league object.
    getCurrentSeason: mods.data.getCurrentSeason || null,
    getLeague: (sleeper && sleeper.getLeague) || null,

    // ---- src/engine/values.js ---------------------------------------------------------
    marketValue: mods.values.marketValue,
    waiverReplacement: mods.values.waiverReplacement,
    sideValue: mods.values.sideValue,
    surplus: mods.values.surplus,

    // ---- src/engine/lineup.js ---------------------------------------------------------
    bestLineup: mods.lineup.bestLineup,
    seasonLineup: mods.lineup.seasonLineup,

    // ---- src/engine/{trade,finder,explain}.js -----------------------------------------
    evaluateTrade: mods.trade.evaluateTrade,
    findTrades: mods.finder.findTrades,
    // §10.3 — whole-league scan. Optional: deals.js drives findTrades per roster when absent.
    findLeagueTrades: mods.finder.findLeagueTrades || null,
    explain: mods.explain.explain,
    sideNames: mods.explain.sideNames || sideNamesLocal,
  };
}
