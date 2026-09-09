// Tradewinds — the single seam between the UI and everything it does not own.
//
// Normal load resolves `src/data.js` + `src/engine/*`. With `?mock=1` (or the sticky
// `tradewinds.mock` flag) it resolves `src/ui/mock.js`, which implements the same surface
// from the committed test fixtures. Nothing else in src/ui/ imports the engine directly, so
// the contract below is the complete list of what the UI expects other agents to ship.

import { possessive } from "./format.js";
import * as CONFIG from "../config.js";

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
  if (!pending) pending = (MOCK ? loadMock() : loadLive()).then(decorate);
  return pending;
}

async function loadMock() {
  const m = await import("./mock.js");
  return { mode: "mock", ...m.api };
}

/** Import a module that may not exist yet (waiver.js, push.js). Never throws. */
async function optional(path) {
  try { return await import(/* @vite-ignore */ path); } catch { return null; }
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

  // §11.2 / §11.4 — shipped by B2 and B4 in parallel. Absent modules fall through to the
  // stand-ins in `decorate()`; every real export takes precedence the moment it exists.
  const [waiver, push] = await Promise.all([optional("../engine/waiver.js"), optional("../push.js")]);

  return {
    mode: "live",

    // ---- src/engine/waiver.js (§11.2) -------------------------------------------------
    // waiver.js `freeAgentPool` is a FLAT id array; the stand-in finder wants them grouped, so
    // the by-position view from lineup.js is what `freeAgentPoolByPos` carries.
    freeAgentPool: (waiver && waiver.freeAgentPool) || null,
    freeAgentPoolByPos: mods.lineup.freeAgentPoolByPos || null,
    waiverStatus: (waiver && waiver.waiverStatus) || null,
    findFreeAgents: (waiver && waiver.findFreeAgents) || null,
    gradeTransaction: (waiver && waiver.gradeTransaction) || null,

    // ---- src/push.js (§11.4) -----------------------------------------------------------
    alertsSupported: (push && push.alertsSupported) || null,
    alertsStatus: (push && push.alertsStatus) || null,
    enableAlerts: (push && push.enableAlerts) || null,
    disableAlerts: (push && push.disableAlerts) || null,
    updatePrefs: (push && push.updatePrefs) || null,
    pairingCode: (push && push.pairingCode) || null,
    reasonText: (push && push.reasonText) || null,

    // ---- src/data.js transactions (§11.4) ----------------------------------------------
    getTransactionsWithNew: mods.data.getTransactionsWithNew || null,
    markTradesSeen: mods.data.markTradesSeen || null,
    attachTransactions: mods.data.attachTransactions || null,

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

/* ================================================================== v1.2 seam
   §11.2 (engine/waiver.js) and §11.4 (push.js, data.js transactions) are being written in
   parallel. Everything below is a behaviour-identical stand-in that `decorate()` installs ONLY
   when the real export is missing, so the UI ships today and upgrades itself the moment the
   real module lands. Nothing here is the engine of record. */

/** Published 2026-09-09 (design §11.1). config.js wins once the key lands there. */
const VAPID_PUBLIC_KEY_FALLBACK =
  "BHRrun9caaSWpO0KOYVBrEHU7lo0SJ2qNQ203fkbMP24VIyZTa1Rssxk2XpiFekMscVSUBlj6TakzQ8Xu0l5CQo";

export const PUSH_KEY = "tradewinds.push.v1";
const SEEN_TRADES_KEY = (leagueId) => "tradewinds.seenTrades." + leagueId;
export const DEFAULT_PREFS = Object.freeze({
  trades: true, deals: true, freeAgents: true, minDealScore: 2, minFaGain: 1,
});

const vapidKey = () => CONFIG.VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY_FALLBACK;

/* ---------------------------------------------------------------- transactions */

function readSeen(leagueId) {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_TRADES_KEY(leagueId)) || "[]")); }
  catch { return new Set(); }
}

function writeSeen(leagueId, ids) {
  try { localStorage.setItem(SEEN_TRADES_KEY(leagueId), JSON.stringify([...ids].slice(-200))); }
  catch { /* private mode */ }
}

export function markTradesSeenLocal(leagueId, ids = []) {
  if (!leagueId || !ids.length) return;
  const seen = readSeen(leagueId);
  for (const id of ids) seen.add(String(id));
  writeSeen(leagueId, seen);
}

/**
 * `{ txns, newTradeIds }` regardless of which shape the data layer returns: data.js may hand
 * back a bare array (v1.1), `{ txns, newTradeIds }`, or `{ transactions, newTradeIds }`.
 */
export function normalizeTxnResult(out, ctx) {
  const txns = Array.isArray(out) ? out : (out && (out.txns || out.transactions)) || [];
  const leagueId = String(ctx?.league?.id ?? ctx?.leagueId ?? "");
  let newTradeIds = Array.isArray(out?.newTradeIds) ? out.newTradeIds.map(String) : null;
  if (!newTradeIds) {
    // The data layer did not diff for us — do it here off the same localStorage ledger the
    // local `markTradesSeen` writes, so the dot and the toast never fire twice for one trade.
    const seen = readSeen(leagueId);
    newTradeIds = txns
      .filter((t) => t && t.type === "trade" && (!t.status || t.status === "complete" || t.status === "unknown"))
      .map((t) => String(t.id))
      .filter((id) => id && !seen.has(id));
  }
  return { txns, newTradeIds };
}

/* ---------------------------------------------------------------- waiver engine */

const FA_PER_POS = 8;
const FA_MAX_CANDIDATES = 48; // 8 per position across QB/RB/WR/TE/K/DEF — every position gets a look
const PROTECT_TOP = 6;

function poolOf(api, ctx) {
  // Grouped by position, never the flat array: the stand-in finder takes the top N per slot so
  // kickers and defenses are still looked at.
  const grouped = api.freeAgentPoolByPos || api.freeAgentPool;
  if (grouped) {
    try {
      const p = grouped(ctx);
      if (p && !Array.isArray(p) && Object.keys(p).length) return p;
    } catch { /* fall through */ }
  }
  const byPos = {};
  for (const [id, p] of ctx.players) {
    if (!p || !p.pos || ctx.rosterOf.has(id)) continue;
    (byPos[p.pos] = byPos[p.pos] || []).push(id);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) =>
      rosPerWeek(ctx, b) - rosPerWeek(ctx, a) ||
      ((api.marketValue(ctx, b).mAdj || 0) - (api.marketValue(ctx, a).mAdj || 0)));
  }
  return byPos;
}

function rosPerWeek(ctx, id) {
  const wk = ctx.proj.get(id);
  if (!wk || !ctx.weeksLeft.length) return 0;
  let t = 0;
  for (const w of ctx.weeksLeft) t += Number(wk[w - 1]) || 0;
  return t / ctx.weeksLeft.length;
}

/** §11.2 `waiverStatus` — a drop younger than the league's waiver window is still on waivers. */
export function waiverStatusLocal(ctx, id) {
  const now = ctx?.now || Date.now();
  const days = Number(ctx?.league?.waiverClearDays ?? ctx?.league?.settings?.waiver_clear_days ?? 2) || 2;
  let dropped = null;
  for (const t of ctx?.transactions || []) {
    if (!t || !t.drops || t.drops[id] == null) continue;
    if (!dropped || Number(t.created) > Number(dropped.created)) dropped = t;
  }
  if (!dropped) return { status: "free", clearsAt: null, droppedBy: null };
  const clears = Number(dropped.created) + days * 86400000;
  if (!Number.isFinite(clears) || clears <= now) return { status: "free", clearsAt: null, droppedBy: null };
  return { status: "waivers", clearsAt: new Date(clears).toISOString(), droppedBy: dropped.drops[id] ?? null };
}

function suggestedBidLocal(ctx, roster, gainPerWeek, alternatives) {
  const s = ctx?.league?.settings || {};
  const waiverType = ctx?.league?.waiverType ?? s.waiver_type;
  if (Number(waiverType) !== 2) return null;
  const budget = Number(ctx?.league?.waiverBudget ?? s.waiver_budget ?? 100);
  const remaining = Math.max(0, budget - Number(roster?.waiverBudgetUsed || 0));
  if (remaining <= 0) return null;
  const scarcity = 1 + 0.5 * (1 - Math.min(alternatives, 6) / 6);
  const phase = 0.35 + 0.65 * (1 - Math.min(1, ctx.weeksLeft.length / 17));
  const share = Math.min(0.35, gainPerWeek / 10) * scarcity * phase;
  const value = Math.max(1, Math.round(remaining * share));
  return { value, aggressive: Math.min(remaining, Math.round(value * 1.6)) };
}

function waiverStatusFor(api, ctx, id) {
  if (api.waiverStatus) {
    try { return api.waiverStatus(ctx, id); } catch { /* fall through */ }
  }
  return waiverStatusLocal(ctx, id);
}

/** Sleeper trending adds, tolerant of both `{ id }` (ctx) and `{ player_id }` (raw) rows. */
export function trendCount(ctx, id) {
  for (const t of ctx?.trending || []) {
    if (String(t.id ?? t.player_id) === String(id)) return Number(t.count) || null;
  }
  return null;
}

function safeNum(fn) {
  try {
    const v = fn();
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

function whyLines(ctx, { add, drop, gain, status, trend }) {
  const nm = (id) => ctx.players.get(id)?.name || id;
  const pos = ctx.players.get(add)?.pos || "";
  const lines = [];
  lines.push(drop
    ? `${nm(add)} starts over ${nm(drop)} often enough to add ${gain.toFixed(1)} pts/week.`
    : `${nm(add)} fills an open roster spot for ${gain.toFixed(1)} pts/week.`);
  lines.push(status === "waivers"
    ? "Still on waivers — a claim beats anyone trying to add him for free."
    : "Free to add right now: no claim, no FAAB.");
  if (trend) lines.push(`${trend.toLocaleString("en-US")} managers added him in the last 24 hours.`);
  if (pos) lines.push(`Best ${pos} left on this wire by rest-of-season points.`);
  return lines;
}

/**
 * §11.2 `findFreeAgents` stand-in. Same row shape and ordering rule; the real engine searches
 * drops harder, so `decorate()` prefers it whenever waiver.js is present.
 */
export function findFreeAgentsLocal(api, ctx, opts = {}) {
  const { rosterId, maxResults = 12, position = null, minGainPerWeek = 0.5 } = opts;
  const roster = (ctx.rosters || []).find((r) => r.rosterId === rosterId);
  if (!roster) return [];
  if (ctx.now == null) ctx.now = Date.now();

  const pool = poolOf(api, ctx);
  const positions = position ? [String(position).toUpperCase()] : Object.keys(pool);
  const candidates = [];
  for (const pos of positions) {
    for (const id of (pool[pos] || []).slice(0, FA_PER_POS)) candidates.push(id);
  }
  // Deliberately NOT sorted by raw points before the cut: quarterbacks outscore everyone, so a
  // global sort would drop every kicker and defense off the end of the shortlist.
  const shortlist = candidates.slice(0, FA_MAX_CANDIDATES);

  const base = api.seasonLineup(ctx, roster.players, {});
  const maxRoster = Number(ctx.league?.maxRoster) || roster.players.length;
  const openSpot = roster.players.length < maxRoster;

  // Protect the top of the roster by surplus, then the current starters unless the add plays
  // the same position and outscores them — the drop rule from §11.2.
  const ranked = roster.players
    .map((id) => ({ id, s: safeNum(() => api.surplus(ctx, id)) }))
    .sort((a, b) => b.s - a.s);
  const shielded = new Set(ranked.slice(0, PROTECT_TOP).map((x) => x.id));
  const starters = new Set(roster.starters || []);
  const posOf = (id) => ctx.players.get(id)?.pos || "";
  const mAdjOf = (id) => (id ? api.marketValue(ctx, id).mAdj : null);

  const out = [];
  for (const add of shortlist) {
    // Dropping only ever removes points, so the open-spot lineup bounds every (add, drop) pair.
    const upper = api.seasonLineup(ctx, [...roster.players, add], {});
    const upperGain = upper.avgPerWeek - base.avgPerWeek;
    if (upperGain < minGainPerWeek) continue;

    let best = openSpot ? { drop: null, gain: upperGain, playoff: upper.playoffAvg - base.playoffAvg } : null;
    for (const { id: drop } of ranked) {
      if (shielded.has(drop)) continue;
      if (starters.has(drop) && !(posOf(drop) === posOf(add) && rosPerWeek(ctx, add) > rosPerWeek(ctx, drop))) continue;
      const line = api.seasonLineup(ctx, roster.players.filter((x) => x !== drop).concat(add), {});
      const gain = line.avgPerWeek - base.avgPerWeek;
      if (!best || gain > best.gain) best = { drop, gain, playoff: line.playoffAvg - base.playoffAvg };
    }
    if (!best || best.gain < minGainPerWeek) continue;

    const w = waiverStatusFor(api, ctx, add);
    const addM = mAdjOf(add);
    const dropM = mAdjOf(best.drop);
    const raw = addM == null || dropM == null ? 0 : addM - dropM;
    const valueDelta = Number.isFinite(raw) ? raw : 0;
    const trend = trendCount(ctx, add);
    out.push({
      add,
      drop: best.drop,
      gainPerWeek: best.gain,
      playoffGainPerWeek: best.playoff,
      valueDelta,
      status: w.status,
      clearsAt: w.clearsAt,
      suggestedBid: w.status === "waivers"
        ? suggestedBidLocal(ctx, roster, best.gain, (pool[posOf(add)] || []).length)
        : null,
      trend,
      why: whyLines(ctx, { add, drop: best.drop, gain: best.gain, status: w.status, trend }),
      score: best.gain + 0.05 * (valueDelta / 100),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxResults);
}

/** §11.2 `gradeTransaction` stand-in — both sides of a completed trade, or an add/drop line. */
export function gradeTransactionLocal(api, ctx, txn) {
  if (!txn) return null;
  if (txn.type === "trade") {
    const ids = [...new Set(txn.rosterIds || [])].sort((x, y) => x - y);
    const [a, b] = ids;
    if (a == null || b == null) return null;
    const to = (rid) => Object.entries(txn.adds || {}).filter(([, r]) => r === rid).map(([id]) => id);
    const get = to(a);
    const give = to(b);
    let result = null;
    let mirror = null;
    try { result = api.evaluateTrade(ctx, { myRosterId: a, theirRosterId: b, give, get }); } catch { /* ungraded */ }
    try { mirror = api.evaluateTrade(ctx, { myRosterId: b, theirRosterId: a, give: get, get: give }); } catch { /* ungraded */ }
    return {
      a, b, give, get, result,
      edgeA: result?.me?.edgePct ?? null,
      deltaA: result?.me?.deltaPerWeek ?? null,
      edgeB: mirror?.me?.edgePct ?? result?.them?.edgePct ?? null,
      deltaB: mirror?.me?.deltaPerWeek ?? result?.them?.deltaPerWeek ?? null,
      labelA: result?.verdict?.label ?? null,
      labelB: mirror?.verdict?.label ?? null,
      codeA: result?.verdict?.code ?? null,
      codeB: mirror?.verdict?.code ?? null,
    };
  }
  const rosterId = (txn.rosterIds || [])[0] ?? null;
  const add = Object.keys(txn.adds || {})[0] ?? null;
  const drop = Object.keys(txn.drops || {})[0] ?? null;
  let gainPerWeek = null;
  const roster = (ctx.rosters || []).find((r) => r.rosterId === rosterId);
  if (roster && add) {
    try {
      const now = roster.players;
      const before = now.filter((x) => x !== add).concat(drop ? [drop] : []);
      gainPerWeek = api.seasonLineup(ctx, now, {}).avgPerWeek - api.seasonLineup(ctx, before, {}).avgPerWeek;
    } catch { /* leave null */ }
  }
  return { rosterId, add, drop, gainPerWeek };
}

/* ---------------------------------------------------------------- push (§11.4) */

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.platform || "") ||
  (/Mac/.test(navigator.platform || "") && (navigator.maxTouchPoints || 0) > 1) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent || "");

const isStandalone = () => {
  try { return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches; }
  catch { return false; }
};

export function alertsSupportedLocal() {
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  if (isIOS() && !isStandalone()) return { ok: false, reason: "not-installed" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, reason: "unsupported" };
  }
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  return { ok: true, reason: null };
}

/** Reasons in words the Settings card can print. push.js owns the real copy once it lands. */
export const ALERT_REASON_TEXT = Object.freeze({
  unsupported: "This browser cannot receive push notifications.",
  "not-installed":
    "Alerts only work from the Home Screen app. In Safari tap Share → Add to Home Screen, " +
    "then open Tradewinds from the icon.",
  denied:
    "Notifications are blocked for Tradewinds. Turn them back on in iOS Settings → " +
    "Notifications → Tradewinds (or your browser's site settings), then try again.",
  insecure: "Alerts need a secure (https) connection.",
});

export function reasonTextLocal(reason) {
  return ALERT_REASON_TEXT[reason] ?? (reason ? String(reason) : "");
}

function readPairing() {
  try { return JSON.parse(localStorage.getItem(PUSH_KEY) || "null"); } catch { return null; }
}

function writePairing(p) {
  try {
    if (p) localStorage.setItem(PUSH_KEY, JSON.stringify(p));
    else localStorage.removeItem(PUSH_KEY);
  } catch { /* private mode */ }
}

export async function alertsStatusLocal() {
  const sup = alertsSupportedLocal();
  const pairing = readPairing();
  return {
    supported: sup.ok,
    reason: sup.reason,
    permission: "Notification" in window ? Notification.permission : "default",
    subscribed: !!pairing,
    pairing,
  };
}

function urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function pushError(reason) {
  const err = new Error(reasonTextLocal(reason));
  err.name = "PushError";
  err.code = "PUSH_ERROR";
  err.reason = reason;
  return err;
}

function deviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Mac/.test(ua)) return "Mac";
  return "Browser";
}

/** MUST be called from a click handler — Safari drops the permission prompt otherwise. */
export async function enableAlertsLocal({ settings, prefs, label } = {}) {
  const sup = alertsSupportedLocal();
  if (!sup.ok) throw pushError(sup.reason);
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw pushError("denied");
  const reg = (await navigator.serviceWorker.getRegistration()) ||
    (await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }));
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || (await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey()),
  }));
  const pairing = {
    v: 1,
    sub: sub.toJSON(),
    leagueId: settings?.leagueId ?? null,
    userId: settings?.userId ?? null,
    label: label || deviceLabel(),
    prefs: { ...DEFAULT_PREFS, ...(prefs || {}) },
    createdAt: new Date().toISOString(),
  };
  writePairing(pairing);
  return pairing;
}

export async function disableAlertsLocal() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe();
  } catch { /* already gone */ }
  writePairing(null);
  return { ok: true };
}

export function updatePrefsLocal(patch = {}) {
  const pairing = readPairing();
  if (!pairing) return null;
  const next = { ...pairing, prefs: { ...DEFAULT_PREFS, ...pairing.prefs, ...patch } };
  writePairing(next);
  return next;
}

/** Compact JSON — one line, no spaces: this string is pasted into a GitHub secret by hand. */
export function pairingCodeLocal(pairing) {
  return pairing ? JSON.stringify(pairing) : "";
}

/* ---------------------------------------------------------------- decorate */

/**
 * Fill any v1.2 symbol the resolved service layer does not carry yet. Real exports always win,
 * so the day waiver.js / push.js land this becomes a no-op.
 * @param {object} api resolved service surface (live or mock)
 */
export function decorate(api) {
  const has = (k) => typeof api[k] === "function";

  if (!has("waiverStatus")) api.waiverStatus = (ctx, id) => waiverStatusLocal(ctx, id);
  if (!has("findFreeAgents")) api.findFreeAgents = (ctx, opts) => findFreeAgentsLocal(api, ctx, opts);
  if (!has("gradeTransaction")) api.gradeTransaction = (ctx, txn) => gradeTransactionLocal(api, ctx, txn);

  const real = has("getTransactionsWithNew") ? api.getTransactionsWithNew : null;
  api.getTransactionsWithNew = async (ctx, options = {}) => {
    const raw = await Promise.resolve(real ? real(ctx, options) : api.getTransactions(ctx, options));
    return normalizeTxnResult(raw, ctx);
  };
  if (!has("markTradesSeen")) api.markTradesSeen = (leagueId, ids) => markTradesSeenLocal(leagueId, ids);

  if (!has("alertsSupported")) api.alertsSupported = alertsSupportedLocal;
  if (!has("alertsStatus")) api.alertsStatus = alertsStatusLocal;
  if (!has("enableAlerts")) api.enableAlerts = enableAlertsLocal;
  if (!has("disableAlerts")) api.disableAlerts = disableAlertsLocal;
  if (!has("updatePrefs")) api.updatePrefs = updatePrefsLocal;
  if (!has("pairingCode")) api.pairingCode = pairingCodeLocal;
  if (!has("reasonText")) api.reasonText = reasonTextLocal;

  return api;
}
