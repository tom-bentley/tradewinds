// Tradewinds — Deals tab. Runs findTrades off the first paint, renders ranked offer tickets.

import { store, setIn } from "./store.js";
import { avatar, playerChip, icon, skeleton, empty, signTone } from "./components.js";
import { escapeHtml, fmtPct, fmtPts, clip, acceptPhrase } from "./format.js";
import { prefill } from "./analyze.js";

export const title = "Deals";

let env = null;

export function mount(el, e) {
  env = e;
  el.innerHTML = shell();
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);

  if (store.deals.status === "idle") {
    setIn("deals", { status: "running" });
    paintList();
    idle(() => compute());
  } else {
    paintList();
  }
  return { destroy() {} };
}

function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 32);
}

function compute() {
  const ctx = store.ctx;
  const t0 = performance.now();
  try {
    const results = env.svc.findTrades(ctx, { myRosterId: ctx.myRosterId });
    setIn("deals", { status: "done", results, error: null, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    console.error("[deals] findTrades failed", err);
    setIn("deals", { status: "error", results: [], error: String(err && err.message ? err.message : err) });
  }
  paintList();
  paintFilters();
}

/* ---------------------------------------------------------------- render */

function shell() {
  return `<div class="deals">
    <div class="deals-head">
      <h2 class="view-h">Best offers to send</h2>
      <button type="button" class="btn btn-ghost btn-sm" data-act="recompute">${icon("refresh")}Recompute</button>
    </div>
    <div class="filters" id="dl-filters">${filters()}</div>
    <div id="dl-list"></div>
  </div>`;
}

function filters() {
  const ctx = store.ctx;
  const f = store.deals.filters;
  const rivals = ctx.rosters.filter((r) => r.rosterId !== ctx.myRosterId);
  const shapes = [...new Set(store.deals.results.map((r) => r.shape))].sort();
  return `<label class="fsel"><span class="vh">Rival</span>
      <select data-f="rival"><option value="">All rivals</option>
      ${rivals.map((r) => `<option value="${r.rosterId}"${f.rival === String(r.rosterId) ? " selected" : ""}>${escapeHtml(clip(r.displayName, 14))}</option>`).join("")}</select></label>
    <label class="fsel"><span class="vh">Position wanted</span>
      <select data-f="pos"><option value="">Any position</option>
      ${["QB", "RB", "WR", "TE"].map((p) => `<option value="${p}"${f.pos === p ? " selected" : ""}>I want a ${p}</option>`).join("")}</select></label>
    <label class="fsel"><span class="vh">Shape</span>
      <select data-f="shape"><option value="">Any shape</option>
      ${shapes.map((s) => `<option value="${s}"${f.shape === s ? " selected" : ""}>${escapeHtml(s.replace("-", " for "))}</option>`).join("")}</select></label>`;
}

function visible() {
  const f = store.deals.filters;
  const ctx = store.ctx;
  return store.deals.results.filter((r) => {
    if (f.rival && String(r.theirRosterId) !== f.rival) return false;
    if (f.shape && r.shape !== f.shape) return false;
    if (f.pos && !r.get.some((id) => ctx.players.get(id)?.pos === f.pos)) return false;
    return true;
  });
}

function paintFilters() {
  const host = document.getElementById("dl-filters");
  if (host) host.innerHTML = filters();
}

function paintList() {
  const host = document.getElementById("dl-list");
  if (!host) return;
  const d = store.deals;
  if (d.status === "running") {
    host.innerHTML = `<p class="hint">Searching every rival roster…</p>${skeleton(3, "sk-deal")}`;
    return;
  }
  if (d.status === "error") {
    host.innerHTML = empty("The finder stopped", d.error || "Unknown error.", { act: "recompute", label: "Try again" });
    return;
  }
  const rows = visible();
  if (!rows.length) {
    const filtered = d.results.length > 0;
    host.innerHTML = empty(
      filtered ? "No offers match those filters" : "No offer clears the bar right now",
      filtered
        ? "Widen the filters, or recompute after the next waiver run."
        : "Every trade that helps you would leave a rival clearly worse off, so none is worth sending. Try Analyze to grade an offer you have been sent.",
      filtered ? { act: "clear-filters", label: "Clear filters" } : null
    );
    return;
  }
  host.innerHTML = `<ol class="deal-list">${rows.map((r, i) => card(r, i)).join("")}</ol>
    <p class="hint hint-end">${rows.length} of ${d.results.length} offers${d.ms != null ? ` · found in ${d.ms} ms` : ""}</p>`;
}

function card(r, i) {
  const ctx = store.ctx;
  const rival = ctx.rosters.find((x) => x.rosterId === r.theirRosterId);
  const v = r.result?.verdict || {};
  const tone = v.code || "fair";
  const acc = acceptPhrase(v);
  const theirDelta = Number(r.theirDeltaPerWeek ?? r.result?.them?.lineup?.deltaPerWeek ?? 0);
  const lineupNote = Math.abs(theirDelta) >= 0.5
    ? ` and ${theirDelta < 0 ? "lose" : "gain"} ${Math.abs(theirDelta).toFixed(1)} pts/wk`
    : "";
  const read = `They ${r.theirEdgePct >= 0 ? "gain" : "give up"} ${Math.abs(r.theirEdgePct).toFixed(0)}%${lineupNote} — ${acc.short}`;
  const idx = store.deals.results.indexOf(r);
  return `<li class="deal" data-tone="${escapeHtml(tone)}">
    <button type="button" class="deal-hit" data-act="open" data-i="${idx}">
      <span class="deal-rank num">${i + 1}</span>
      <span class="deal-body">
        <span class="deal-h">${avatar(rival, 28)}<span class="deal-team">${escapeHtml(clip(rival?.displayName || "", 16))}</span>
          <span class="deal-shape">${escapeHtml(r.shape.replace("-", " for "))}</span></span>
        <span class="swap">
          <span class="swap-row"><span class="swap-k swap-out">out</span><span class="swap-chips">${r.give.map((id) => playerChip(ctx, id, "theirs", env.svc.marketValue(ctx, id))).join("")}</span></span>
          <span class="swap-row"><span class="swap-k swap-in">in</span><span class="swap-chips">${r.get.map((id) => playerChip(ctx, id, "mine", env.svc.marketValue(ctx, id))).join("")}</span></span>
        </span>
        <span class="deal-stats">
          <span class="dstat"><b class="num" data-tone="${signTone(r.myDeltaPerWeek)}">${fmtPts(r.myDeltaPerWeek)}</b> pts/wk</span>
          <span class="dstat"><b class="num" data-tone="${signTone(r.myEdgePct, 0.5)}">${fmtPct(r.myEdgePct)}</b> edge</span>
          <span class="dstat dstat-read ${acc.cls}">${escapeHtml(read)}</span>
        </span>
        ${r.why && r.why.length ? `<span class="deal-why">${escapeHtml(r.why[0])}</span>` : ""}
      </span>
      <span class="deal-go">${icon("chevron")}</span>
    </button>
  </li>`;
}

/* ---------------------------------------------------------------- events */

function onChange(e) {
  const sel = e.target.closest("select[data-f]");
  if (!sel) return;
  store.deals.filters = { ...store.deals.filters, [sel.dataset.f]: sel.value };
  paintList();
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "recompute") {
    setIn("deals", { status: "running", results: [] });
    paintList();
    idle(() => compute());
    return;
  }
  if (t.dataset.act === "clear-filters") {
    store.deals.filters = { rival: "", pos: "", shape: "" };
    paintFilters();
    paintList();
    return;
  }
  if (t.dataset.act === "open") {
    const r = store.deals.results[Number(t.dataset.i)];
    if (!r) return;
    prefill({ theirRosterId: r.theirRosterId, give: r.give, get: r.get });
    env.go("analyze");
  }
}
