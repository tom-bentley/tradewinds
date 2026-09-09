// Tradewinds — boot, hash routing, header chrome, service-worker update flow.

import { store, set, setIn, subscribe } from "./store.js";
import { services, MOCK, ServicesError, isSetupRequired, stripDeepLink } from "./services.js";
import { toast, closeTopSheet, closeAllSheets, syncThemeColor } from "./components.js";
import { escapeHtml, clockTime, relTime, clip } from "./format.js";
import { APP_NAME } from "../config.js";

import * as deals from "./deals.js";
import * as analyze from "./analyze.js";
import * as league from "./league.js";
import * as players from "./players.js";
import * as settings from "./settings.js";
import * as setup from "./setup.js";

const VIEWS = { deals, analyze, league, players, settings };
const TABS = Object.keys(VIEWS);

let svc = null;
let active = null; // { name, instance }
let routerStarted = false;
const scrollTop = new Map();

const $ = (id) => document.getElementById(id);

/* ================================================================== boot */

boot();

async function boot() {
  set({ status: "booting", bootStep: "", bootPct: 0 }, "boot");
  screen("app");
  paintBoot();
  try {
    svc = await services();
    set({ mode: svc.mode }, "mode");

    // A shared link (`?league=…&user=…`) configures the app before anything is loaded, then the
    // query is dropped so a reload or a bookmark keeps the saved league instead of re-applying.
    let s = await applyDeepLink();

    // No league yet — first run, or "Switch league" in Settings. Onboarding is the front door.
    if (!s.leagueId) { showSetup(); return; }

    set({ settings: s, bootStep: "Loading league data", bootPct: 4 }, "boot");
    paintBoot();
    const out = await svc.loadAll({
      settings: s,
      // data.js reports { step, label, done, total }; the mock reports { step, pct }.
      onProgress: (p) => {
        if (!p) return;
        store.bootStep = p.label || p.step || store.bootStep;
        const pct = typeof p.pct === "number" ? p.pct
          : p.total ? Math.round((p.done / p.total) * 100) : store.bootPct;
        store.bootPct = Math.max(store.bootPct, pct);
        paintBoot();
      },
    });
    set({ ctx: out.ctx, freshness: out.freshness || {}, errors: out.errors || [], status: "ready" }, "ready");
    store.lastLiveAt = Date.now();
    if (!routerStarted) {
      routerStarted = true;
      startRouter();
      installForegroundRefresh();
      registerSW();
    } else {
      renderView(true);
    }
    syncThemeColor();
    // New-trade awareness runs after first paint: it is a background read, never a boot gate.
    setTimeout(() => transactions(), 0);
  } catch (err) {
    // data.js signals "no league configured" with SetupRequiredError, not a crash screen.
    if (isSetupRequired(err)) { showSetup(); return; }
    console.error("[app] boot failed", err);
    set({ status: "error", error: err }, "error");
    paintError(err);
  }
}

/** Apply `?league=&user=` if present, then strip it. Returns the settings to boot with. */
async function applyDeepLink() {
  try {
    // Cheap sync parse first, so a normal boot never awaits a network round-trip.
    const seen = svc.readDeepLink ? svc.readDeepLink() : null;
    if (seen && seen.leagueId) {
      // applyDeepLink resolves `user=<username>` to a user id; it does not persist anything.
      const patch = svc.applyDeepLink ? await svc.applyDeepLink() : seen;
      if (patch && patch.leagueId) {
        // Spread over explicit nulls: a link with no user must clear the PREVIOUS league's user
        // rather than inherit it, otherwise the wrong roster comes back as "me".
        const next = svc.saveSettings({ userId: null, username: null, ...patch });
        (svc.clearDeepLink || stripDeepLink)();
        store.setup = { ...store.setup, status: "idle", leagues: null, error: null };
        if (next && next.leagueId) return next;
      }
    }
  } catch (err) {
    console.warn("[app] deep link ignored", err);
  }
  return svc.loadSettings();
}

/* ---------------------------------------------------------------- onboarding */

function screen(name) {
  const app = document.getElementById("app");
  if (app) app.dataset.screen = name;
}

function showSetup() {
  set({ status: "setup", ctx: null, freshness: null, errors: [] }, "setup");
  store.setup = { ...store.setup, season: store.setup.season || (svc ? svc.loadSettings().season : null) };
  screen("setup");
  paintHeader();
  const host = $("view");
  const el = document.createElement("section");
  el.className = "view view-setup";
  host.replaceChildren(el);
  if (active) {
    try { active.instance && active.instance.destroy && active.instance.destroy(); } catch { /* ignore */ }
  }
  active = { name: "setup", instance: setup.mount(el, env) };
  syncThemeColor();
}

/** Re-run loadAll with the current settings (after a dial or league change). */
async function reload({ hard = false } = {}) {
  if (!svc) return;
  const s = svc.loadSettings();
  store.settings = s;
  txnsPending = null;
  if (hard) {
    store.deals = {
      ...store.deals, status: "idle", results: [], filters: { rival: "", pos: "", shape: "" }, error: null,
      fa: { status: "idle", results: [], pos: "", error: null, ms: null },
    };
    store.league = { txns: null, txnStatus: "idle", newTradeIds: [] };
    store.analyze = { theirRosterId: null, give: [], get: [], q: "", result: null, expanded: false, error: null };
  } else {
    store.deals = { ...store.deals, status: "idle", results: [], fa: { ...store.deals.fa, status: "idle", results: [] } };
  }
  try {
    const out = await svc.loadAll({ settings: s });
    set({ ctx: out.ctx, freshness: out.freshness || {}, errors: out.errors || [] }, "reload");
    store.lastLiveAt = Date.now();
    renderView(true);
    transactions();
  } catch (err) {
    toast("Could not reload: " + (err.message || err), { tone: "warn", timeout: 6000 });
  }
}

let refreshing = false;
async function refresh({ silent = false } = {}) {
  if (!svc || store.status !== "ready" || refreshing) return;
  refreshing = true;
  const btn = $("btn-refresh");
  btn && btn.classList.add("is-spin");
  try {
    const out = await svc.refreshLive(store.settings);
    txnsPending = null;
    store.deals = { ...store.deals, status: "idle", results: [], fa: { ...store.deals.fa, status: "idle", results: [] } };
    store.league = { ...store.league, txns: null, txnStatus: "idle" };
    set({ ctx: out.ctx, freshness: out.freshness || {}, errors: out.errors || [] }, "refresh");
    store.lastLiveAt = Date.now();
    renderView(true);
    transactions();
    if (!silent) toast("Data refreshed.");
  } catch (err) {
    console.error("[app] refresh failed", err);
    toast("Refresh failed — showing the last good data.", { tone: "warn" });
  } finally {
    refreshing = false;
    btn && btn.classList.remove("is-spin");
  }
}

/* ----------------------------------------------------- foreground refresh */
// A home-screen app is resumed, not relaunched: iOS keeps the page alive in the background for
// hours. Whenever it comes back to the foreground with live data older than this, re-pull
// rosters/state/values silently so a verdict is never computed on a stale league.
export const FOREGROUND_REFRESH_MS = 60 * 1000;

function maybeRefreshOnForeground() {
  if (document.visibilityState !== "visible") return;
  if (store.status !== "ready" || !store.lastLiveAt) return;
  if (Date.now() - store.lastLiveAt < FOREGROUND_REFRESH_MS) return;
  refresh({ silent: true });
}

function installForegroundRefresh() {
  document.addEventListener("visibilitychange", maybeRefreshOnForeground);
  window.addEventListener("focus", maybeRefreshOnForeground);
  window.addEventListener("pageshow", maybeRefreshOnForeground);
  window.addEventListener("online", maybeRefreshOnForeground);
}

/* ======================================================== transactions + new trades
   One fetch per load, shared by the League tab (completed-trade grades and the recent-moves
   list) and by Deals → Free agents (waiver windows). Memoized so mounting both tabs costs one
   round-trip; `refresh` and `reload` drop the memo so the next reader re-pulls. */

let txnsPending = null;

function transactions({ force = false } = {}) {
  if (force) txnsPending = null;
  if (!txnsPending) txnsPending = loadTransactions();
  return txnsPending;
}

async function loadTransactions() {
  const ctx = store.ctx;
  if (!ctx || !svc || !svc.getTransactionsWithNew) return { txns: [], newTradeIds: [] };
  // The engine never reads the clock, so "now" is supplied here for the waiver windows.
  // `attachTransactions` (data.js) does both jobs — hang the feed on the ctx AND stamp ctx.now —
  // so prefer it and fall back to the plain fetch in demo mode.
  if (!Number.isFinite(ctx.now)) ctx.now = Date.now();
  setIn("league", { txnStatus: "running" });
  try {
    const fetcher = svc.attachTransactions || svc.getTransactionsWithNew;
    const out = await fetcher(ctx, { rounds: ctx.week });
    const txns = out.txns || [];
    ctx.transactions = txns;
    setIn("league", { txns, txnStatus: "done", newTradeIds: out.newTradeIds || [] });
    announceNewTrades(out.newTradeIds || [], txns);
    return { txns, newTradeIds: out.newTradeIds || [] };
  } catch (err) {
    console.error("[app] transactions failed", err);
    if (!Array.isArray(ctx.transactions)) ctx.transactions = [];
    setIn("league", { txns: [], txnStatus: "error", newTradeIds: [] });
    return { txns: [], newTradeIds: [] };
  }
}

/** A dot on the League tab plus one toast per new completed trade (design §11.5). */
function announceNewTrades(ids, txns) {
  paintTradeDot();
  if (!ids.length) return;
  const ctx = store.ctx;
  const nameOf = (rid) => {
    const r = ctx.rosters.find((x) => x.rosterId === rid);
    return clip((r && (r.teamName || r.displayName)) || `Roster ${rid}`, 14);
  };
  for (const id of ids.slice(0, 3)) {
    const t = txns.find((x) => String(x.id) === String(id));
    if (!t) continue;
    const sides = [...new Set(t.rosterIds || [])].map(nameOf);
    toast(`New trade: ${sides.join(" ⇄ ") || "in your league"}`, {
      action: "View",
      timeout: 9000,
      onAction: () => go("league"),
    });
  }
}

/** The League tab's unread dot. Hidden as soon as the League view marks the trades seen. */
function paintTradeDot() {
  const tab = document.querySelector('#tabs a[data-tab="league"]');
  if (!tab) return;
  const on = (store.league.newTradeIds || []).length > 0;
  tab.classList.toggle("has-dot", on);
  const dot = tab.querySelector(".tab-dot");
  if (dot) dot.hidden = !on;
  if (on) tab.setAttribute("aria-description", "new trade");
  else tab.removeAttribute("aria-description");
}

/* ================================================================== router */

function tabFromHash() {
  const h = (location.hash || "").replace(/^#/, "");
  return TABS.includes(h) ? h : "deals";
}

/**
 * `notificationclick` in sw.js focuses this page and posts `{ type: "open-url", url }`.
 * The url is the full Pages URL with a hash; only the hash matters to the router, and an
 * unknown one is ignored rather than blanking the view.
 */
function installSwMessages() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.type !== "open-url" || !d.url) return;
    let hash = "";
    try { hash = new URL(d.url, location.href).hash; } catch { hash = String(d.url).includes("#") ? "#" + String(d.url).split("#")[1] : ""; }
    const tab = hash.replace(/^#/, "");
    if (!TABS.includes(tab)) return;
    closeAllSheets();
    go(tab);
  });
}

function startRouter() {
  installSwMessages();
  window.addEventListener("hashchange", () => renderView());
  $("tabs").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-tab]");
    if (a) closeTopSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTopSheet();
  });
  if (!TABS.includes((location.hash || "").replace(/^#/, ""))) location.replace("#deals");
  renderView();
}

function go(tab) {
  if (tabFromHash() === tab) renderView();
  else location.hash = "#" + tab;
}

const env = {
  get svc() { return svc; },
  go, refresh, reload, boot,
  transactions,
  clearTradeDot,
  rerender: () => renderView(true),
};

/** The League view calls this once it has marked the new trades seen. */
function clearTradeDot() {
  if (!(store.league.newTradeIds || []).length) return;
  setIn("league", { newTradeIds: [] });
  paintTradeDot();
}

function renderView(force = false) {
  const name = tabFromHash();
  if (store.status !== "ready") return;
  if (active && active.name === name && !force) return;
  closeAllSheets();

  const main = $("main");
  if (active) {
    scrollTop.set(active.name, main.scrollTop);
    try { active.instance && active.instance.destroy && active.instance.destroy(); } catch { /* ignore */ }
  }

  const host = $("view");
  const el = document.createElement("section");
  el.className = "view view-" + name;
  host.replaceChildren(el);

  set({ tab: name }, "tab");
  paintTabs(name);
  paintHeader();

  try {
    const instance = VIEWS[name].mount(el, env);
    active = { name, instance };
  } catch (err) {
    console.error(`[app] ${name} view failed`, err);
    el.innerHTML = `<div class="empty"><p class="empty-t">This tab hit an error</p><p class="empty-b">${escapeHtml(err.message || String(err))}</p></div>`;
    active = { name, instance: null };
  }
  main.scrollTop = force ? main.scrollTop : (scrollTop.get(name) || 0);
}

/* ================================================================== chrome */

function paintTabs(name) {
  document.querySelectorAll("#tabs a[data-tab]").forEach((a) => {
    const on = a.dataset.tab === name;
    a.setAttribute("aria-selected", String(on));
    a.classList.toggle("is-on", on);
  });
}

function chip(label, value, mod = "") {
  return `<span class="fchip ${mod}"><span class="fchip-k">${escapeHtml(label)}</span><span class="fchip-v">${escapeHtml(value)}</span></span>`;
}

function paintHeader() {
  const f = store.freshness || {};
  const ctx = store.ctx;

  // The league name lives beside the wordmark: with no baked-in league it is the only thing on
  // screen that says WHICH league every number belongs to.
  const lg = $("hdr-league");
  if (lg) lg.textContent = ctx?.league?.name ? "· " + ctx.league.name : "";

  const rail = $("hdr-fresh");
  if (store.status === "setup") {
    rail.innerHTML = "";
    const b = $("banner");
    if (b) b.hidden = true;
    return;
  }
  const parts = [];
  if (f.offline) parts.push(chip("offline", "last good data", "is-bad"));
  parts.push(chip("rosters", f.live ? (f.offline ? relTime(f.live) : clockTime(f.live)) : "—", f.offline ? "" : "is-live"));
  const vlabel = f.values === "live" ? "live" : relTime(f.pipeline || ctx?.meta?.values);
  parts.push(chip("values", vlabel || "—"));
  if (MOCK) parts.push(chip("demo", "fixtures", "is-warn"));
  rail.innerHTML = parts.join("");

  const wk = $("hdr-week");
  if (wk) wk.textContent = ctx ? `wk ${ctx.week}` : "";

  const banner = $("banner");
  const hard = (store.errors || []).filter((e) => e.source !== "mock");
  if (f.offline) {
    banner.hidden = false;
    banner.className = "banner banner-bad";
    banner.textContent = `Offline — showing data from ${relTime(f.live || f.pipeline)}.`;
  } else if (hard.length) {
    banner.hidden = false;
    banner.className = "banner banner-warn";
    banner.textContent = `${hard.length} source${hard.length > 1 ? "s" : ""} degraded: ${hard.map((e) => e.source).join(", ")}. Values may be stale.`;
  } else {
    banner.hidden = true;
  }
}

/* ================================================================== screens */

function paintBoot() {
  const host = $("view");
  host.innerHTML = `<div class="boot">
    <div class="boot-mark">${brandMark(44)}</div>
    <p class="boot-name">${escapeHtml(APP_NAME)}</p>
    <div class="boot-rail"><i style="width:${Math.min(100, store.bootPct || 4)}%"></i></div>
    <p class="boot-step">${escapeHtml(store.bootStep || "Starting")}…</p>
  </div>`;
}

function paintError(err) {
  const missing = err instanceof ServicesError ? err.missing : null;
  const host = $("view");
  host.innerHTML = `<div class="errscr">
    <p class="err-t">${missing ? "The app modules are not built yet" : "Could not load the league"}</p>
    <p class="err-b">${escapeHtml(err.message || String(err))}</p>
    ${missing ? `<ul class="err-list">${missing.map((m) => `<li><code>${escapeHtml(m.path)}</code></li>`).join("")}</ul>` : ""}
    <div class="err-acts">
      <button type="button" class="btn" data-act="retry">Try again</button>
      ${MOCK ? "" : `<button type="button" class="btn btn-ghost" data-act="demo">Use demo data</button>`}
    </div>
  </div>`;
  host.querySelector('[data-act="retry"]').addEventListener("click", () => location.reload());
  const demo = host.querySelector('[data-act="demo"]');
  if (demo) demo.addEventListener("click", () => { location.search = "?mock=1"; });
  $("hdr-fresh").innerHTML = chip("status", "not loaded", "is-bad");
}

function brandMark(size = 26) {
  return `<svg class="mark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke-width="3.2" stroke-linecap="round">
    <path d="M27 12.5A12 12 0 0 0 5.6 10.4" stroke="#2DD4BF"/><path d="M27.4 5.6l.2 7.2-7.1.4" stroke="#2DD4BF"/>
    <path d="M5 19.5a12 12 0 0 0 21.4 2.1" stroke="#F59E0B"/><path d="M4.6 26.4l-.2-7.2 7.1-.4" stroke="#F59E0B"/>
  </svg>`;
}

/* ================================================================== service worker */

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const forced = new URLSearchParams(location.search).get("sw") === "1";
  // In demo mode the SW would cache fixture URLs that never ship, so skip it unless forced.
  if (MOCK && !forced) return;

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "update-available") offerUpdate(reg);
    });
    if (reg.waiting) offerUpdate(reg);
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(reg);
      });
    });
  }).catch((err) => console.warn("[app] service worker not registered", err));

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

let updateShown = false;
function offerUpdate(reg) {
  if (updateShown) return;
  updateShown = true;
  toast("Update available", {
    action: "Reload",
    timeout: 0,
    onAction: () => {
      const w = reg.waiting || reg.active;
      if (w) w.postMessage({ type: "SKIP_WAITING" });
      setTimeout(() => location.reload(), 400);
    },
  });
}

/* ================================================================== wiring */

$("btn-refresh").addEventListener("click", refresh);
subscribe((_, reason) => { if (reason === "refresh" || reason === "reload") paintHeader(); });
