// Tradewinds — boot, hash routing, header chrome, service-worker update flow.

import { store, set, subscribe } from "./store.js";
import { services, MOCK, ServicesError } from "./services.js";
import { toast, closeTopSheet, closeAllSheets, syncThemeColor } from "./components.js";
import { escapeHtml, clockTime, relTime } from "./format.js";
import { APP_NAME } from "../config.js";

import * as deals from "./deals.js";
import * as analyze from "./analyze.js";
import * as league from "./league.js";
import * as players from "./players.js";
import * as settings from "./settings.js";

const VIEWS = { deals, analyze, league, players, settings };
const TABS = Object.keys(VIEWS);

let svc = null;
let active = null; // { name, instance }
const scrollTop = new Map();

const $ = (id) => document.getElementById(id);

/* ================================================================== boot */

boot();

async function boot() {
  paintBoot();
  try {
    svc = await services();
    set({ mode: svc.mode }, "mode");
    const s = svc.loadSettings();
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
    startRouter();
    installForegroundRefresh();
    syncThemeColor();
    registerSW();
  } catch (err) {
    console.error("[app] boot failed", err);
    set({ status: "error", error: err }, "error");
    paintError(err);
  }
}

/** Re-run loadAll with the current settings (after a dial or league change). */
async function reload({ hard = false } = {}) {
  if (!svc) return;
  const s = svc.loadSettings();
  store.settings = s;
  if (hard) {
    store.deals = { status: "idle", results: [], filters: { rival: "", pos: "", shape: "" }, error: null };
    store.league = { txns: null, txnStatus: "idle" };
    store.analyze = { theirRosterId: null, give: [], get: [], q: "", result: null, expanded: false, error: null };
  } else {
    store.deals = { ...store.deals, status: "idle", results: [] };
  }
  try {
    const out = await svc.loadAll({ settings: s });
    set({ ctx: out.ctx, freshness: out.freshness || {}, errors: out.errors || [] }, "reload");
    store.lastLiveAt = Date.now();
    renderView(true);
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
    store.deals = { ...store.deals, status: "idle", results: [] };
    store.league = { txns: null, txnStatus: "idle" };
    set({ ctx: out.ctx, freshness: out.freshness || {}, errors: out.errors || [] }, "refresh");
    store.lastLiveAt = Date.now();
    renderView(true);
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

/* ================================================================== router */

function tabFromHash() {
  const h = (location.hash || "").replace(/^#/, "");
  return TABS.includes(h) ? h : "deals";
}

function startRouter() {
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

const env = { get svc() { return svc; }, go, refresh, reload, rerender: () => renderView(true) };

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
  const rail = $("hdr-fresh");
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
