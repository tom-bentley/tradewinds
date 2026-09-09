// Tradewinds — Deals tab. Two panes behind one segmented control (design §11.5):
//   Trades      — ranked offer tickets for one team, or for the whole league
//   Free agents — the wire, graded on the same lineup axis (src/ui/freeagents.js)
//
// v1.1 (design §10.5): the offers are computed FOR a chosen roster — mine by default, the first
// team in viewer mode, or anyone via the picker — plus a "Whole league" scan. The engine call is
// synchronous and costs ~1 s per roster, so the league scan is driven one team per macrotask:
// the progress line ("3 of 8 teams…") then actually paints between slices instead of after.

import { store, setIn } from "./store.js";
import { avatar, playerChip, icon, skeleton, empty, signTone, openTeamSheet, teamChip } from "./components.js";
import { escapeHtml, fmtPct, fmtPts, clip, acceptPhrase } from "./format.js";
import { prefill } from "./analyze.js";
import { faStart, faPaint, faFilters, faClick, faChange, faAbort } from "./freeagents.js";

export const title = "Deals";

const LEAGUE = "league"; // sentinel value for the "Whole league" row in the picker
const FA = "fa"; // store.deals.tab value for the Free agents pane
const PER_TEAM = 3;
const LEAGUE_MAX = 20;

let env = null;
let scan = 0; // generation token — a scope change abandons an in-flight league scan

export function mount(el, e) {
  env = e;
  ensureTarget();
  el.innerHTML = shell();
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);

  if (isFa()) {
    if (store.deals.fa.status === "idle") faStart(env);
    else faPaint(env);
  } else if (store.deals.status === "idle") start();
  else paintList();
  return { destroy() { scan += 1; faAbort(); } };
}

const isFa = () => store.deals.tab === FA;

/** Never assume a "me" exists: viewer mode targets the first roster in the league. */
function ensureTarget() {
  const ctx = store.ctx;
  const d = store.deals;
  const has = (id) => id != null && ctx.rosters.some((r) => r.rosterId === id);
  if (!has(d.forRosterId)) {
    d.forRosterId = has(ctx.myRosterId) ? ctx.myRosterId : ctx.rosters[0]?.rosterId ?? null;
  }
  // "Whole league" is a Trades-only scope: a wire read is always for exactly one roster.
  if (d.scope !== LEAGUE || isFa()) d.scope = "team";
}

const targetRoster = () => store.ctx.rosters.find((r) => r.rosterId === store.deals.forRosterId) || null;

function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 32);
}

/* ---------------------------------------------------------------- compute */

function start() {
  if (isFa()) { faStart(env); return; }
  scan += 1;
  setIn("deals", { status: "running", results: [], error: null, progress: null });
  paintList();
  if (store.deals.scope === LEAGUE) leagueScan(scan);
  else idle(() => computeTeam(scan));
}

function computeTeam(token) {
  if (token !== scan) return;
  const ctx = store.ctx;
  const forId = store.deals.forRosterId;
  const t0 = performance.now();
  try {
    const results = env.svc.findTrades(ctx, { myRosterId: forId })
      .map((r) => ({ ...r, forRosterId: forId }));
    setIn("deals", { status: "done", results, error: null, ms: Math.round(performance.now() - t0), progress: null });
  } catch (err) {
    console.error("[deals] findTrades failed", err);
    setIn("deals", { status: "error", results: [], error: String(err && err.message ? err.message : err) });
  }
  paintList();
  paintFilters();
}

/**
 * Whole-league scan. `findLeagueTrades(ctx, { perTeam, maxResults, onTeam })` does exactly this
 * in one synchronous call, which would freeze a phone for several seconds; driving the same
 * per-roster loop here keeps the frame budget and gives the progress line something to say.
 * The engine's own aggregator is the fallback when `findTrades` is unavailable.
 */
function leagueScan(token) {
  const ctx = store.ctx;
  const teams = ctx.rosters;
  const t0 = performance.now();

  if (!env.svc.findTrades && env.svc.findLeagueTrades) {
    idle(() => {
      if (token !== scan) return;
      try {
        const results = env.svc.findLeagueTrades(ctx, {
          perTeam: PER_TEAM, maxResults: LEAGUE_MAX,
          onTeam: (rosterId, i, n) => setIn("deals", { progress: { done: i + 1, total: n } }),
        });
        setIn("deals", { status: "done", results, error: null, ms: Math.round(performance.now() - t0), progress: null });
      } catch (err) {
        setIn("deals", { status: "error", results: [], error: String(err && err.message ? err.message : err) });
      }
      paintList();
      paintFilters();
    });
    return;
  }

  const out = [];
  const seen = new Set();
  let i = 0;

  setIn("deals", { progress: { done: 0, total: teams.length } });
  paintList();

  const step = () => {
    if (token !== scan) return;
    if (i >= teams.length) {
      out.sort((a, b) => b.score - a.score);
      setIn("deals", {
        status: "done", results: out.slice(0, LEAGUE_MAX), error: null,
        ms: Math.round(performance.now() - t0), progress: null,
      });
      paintList();
      paintFilters();
      return;
    }
    const roster = teams[i];
    try {
      const rows = env.svc.findTrades(ctx, { myRosterId: roster.rosterId, maxResults: PER_TEAM });
      for (const row of rows.slice(0, PER_TEAM)) {
        // Dedupe unordered: the same swap found from both ends is one deal, not two.
        const pair = [roster.rosterId, row.theirRosterId].sort((a, b) => a - b).join(":");
        const g = [...row.give].sort().join(","), n = [...row.get].sort().join(",");
        if (seen.has(`${pair}|${g}|${n}`) || seen.has(`${pair}|${n}|${g}`)) continue;
        seen.add(`${pair}|${g}|${n}`);
        out.push({ ...row, forRosterId: roster.rosterId });
      }
    } catch (err) {
      console.warn("[deals] findTrades failed for roster", roster.rosterId, err);
    }
    i += 1;
    setIn("deals", { progress: { done: i, total: teams.length } });
    paintProgress();
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

/* ---------------------------------------------------------------- render */

function shell() {
  const fa = isFa();
  return `<div class="deals">
    <div class="seg seg-source" role="tablist" aria-label="Where the deals come from">
      <button type="button" role="tab" data-act="mode" data-v="trades" class="${fa ? "" : "is-on"}" aria-selected="${!fa}">Trades</button>
      <button type="button" role="tab" data-act="mode" data-v="fa" class="${fa ? "is-on" : ""}" aria-selected="${fa}">Free agents</button>
    </div>
    <div class="deals-head">
      <div class="deals-for">
        <span class="view-h">${fa ? "Wire moves for" : "Best offers for"}</span>
        ${pickerChip()}
      </div>
      <button type="button" class="icon-btn" data-act="recompute" aria-label="${fa ? "Search the wire again" : "Recompute offers"}">${icon("refresh")}</button>
    </div>
    <div class="filters" id="dl-filters">${fa ? faFilters() : filters()}</div>
    <div id="dl-list"${fa ? ' aria-live="polite" aria-busy="false"' : ""}></div>
  </div>`;
}

function pickerChip() {
  if (store.deals.scope === LEAGUE && !isFa()) {
    return `<button type="button" class="tchip" data-act="pick-team"><span class="tchip-n">Whole league</span><span class="tchip-c" aria-hidden="true">▾</span></button>`;
  }
  return teamChip(targetRoster(), { act: "pick-team" });
}

function filters() {
  const ctx = store.ctx;
  const f = store.deals.filters;
  const league = store.deals.scope === LEAGUE;
  const teams = ctx.rosters.filter((r) => league || r.rosterId !== store.deals.forRosterId);
  const shapes = [...new Set(store.deals.results.map((r) => r.shape))].sort();
  return `<label class="fsel"><span class="vh">Trade partner</span>
      <select data-f="rival"><option value="">${league ? "All partners" : "All rivals"}</option>
      ${teams.map((r) => `<option value="${r.rosterId}"${f.rival === String(r.rosterId) ? " selected" : ""}>${escapeHtml(clip(r.displayName, 14))}</option>`).join("")}</select></label>
    <label class="fsel"><span class="vh">Position wanted</span>
      <select data-f="pos"><option value="">Any position</option>
      ${["QB", "RB", "WR", "TE"].map((p) => `<option value="${p}"${f.pos === p ? " selected" : ""}>Gets a ${p}</option>`).join("")}</select></label>
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

function progressLine() {
  const p = store.deals.progress;
  if (!p) return `<p class="hint">Searching every rival roster…</p>`;
  return `<p class="hint" id="dl-prog" role="status">${p.done} of ${p.total} teams…</p>`;
}

function paintProgress() {
  const el = document.getElementById("dl-prog");
  const p = store.deals.progress;
  if (el && p) el.textContent = `${p.done} of ${p.total} teams…`;
}

function paintList() {
  const host = document.getElementById("dl-list");
  if (!host) return;
  const d = store.deals;
  if (d.status === "running") {
    host.innerHTML = `${progressLine()}${skeleton(3, "sk-deal")}`;
    return;
  }
  if (d.status === "error") {
    host.innerHTML = empty("The finder stopped", d.error || "Unknown error.", { act: "recompute", label: "Try again" });
    return;
  }
  const rows = visible();
  if (!rows.length) {
    const filtered = d.results.length > 0;
    const who = d.scope === LEAGUE ? "any team" : subjectName();
    host.innerHTML = empty(
      filtered ? "No offers match those filters" : "No offer clears the bar right now",
      filtered
        ? "Widen the filters, or recompute after the next waiver run."
        : `Every trade that helps ${who} would leave the other side clearly worse off, so none is worth sending. Try Analyze to grade an offer instead.`,
      filtered ? { act: "clear-filters", label: "Clear filters" } : null
    );
    return;
  }
  host.innerHTML = `<ol class="deal-list">${rows.map((r, i) => card(r, i)).join("")}</ol>
    <p class="hint hint-end">${rows.length} of ${d.results.length} offers${d.ms != null ? ` · found in ${d.ms} ms` : ""}</p>`;
}

/** "you" when the target is my team, otherwise the team's own name. */
function subjectName() {
  const ctx = store.ctx;
  const d = store.deals;
  if (ctx.myRosterId != null && d.forRosterId === ctx.myRosterId) return "you";
  const r = targetRoster();
  return (r && (r.teamName || r.displayName)) || "that team";
}

/**
 * The one-line "why" under a card. `findTrades` builds its own `why` from the roster it was
 * given, which is second person whenever that roster happens to be mine; re-explaining with the
 * card's own side names keeps a "for scwone" card in scwone's voice.
 */
function whyLine(ctx, r, nm) {
  if (r.result && env.svc.explain) {
    try {
      const lines = env.svc.explain(ctx, r.result, { names: nm }).lines || [];
      const first = lines.find((l) => l.kind !== "headline");
      if (first && first.text) return first.text;
    } catch { /* fall through to the finder's own text */ }
  }
  return r.why && r.why.length ? r.why[0] : "";
}

function card(r, i) {
  const ctx = store.ctx;
  const forId = r.forRosterId != null ? r.forRosterId : store.deals.forRosterId;
  const forR = ctx.rosters.find((x) => x.rosterId === forId);
  const rival = ctx.rosters.find((x) => x.rosterId === r.theirRosterId);
  const nm = env.svc.sideNames(ctx, forId, r.theirRosterId);
  const v = r.result?.verdict || {};
  const tone = v.code || "fair";
  const acc = acceptPhrase(v);
  const theirDelta = Number(r.theirDeltaPerWeek ?? r.result?.them?.lineup?.deltaPerWeek ?? 0);
  const lineupNote = Math.abs(theirDelta) >= 0.5
    ? ` and ${theirDelta < 0 ? "loses" : "gains"} ${Math.abs(theirDelta).toFixed(1)} pts/wk`
    : "";
  const read = `${nm.b} ${r.theirEdgePct >= 0 ? "gains" : "gives up"} ${Math.abs(r.theirEdgePct).toFixed(0)}%${lineupNote} — ${acc.short}`;
  const idx = store.deals.results.indexOf(r);
  const tagged = store.deals.scope === LEAGUE || (ctx.myRosterId != null && forId !== ctx.myRosterId) || ctx.myRosterId == null;
  return `<li class="deal" data-tone="${escapeHtml(tone)}">
    <button type="button" class="deal-hit" data-act="open" data-i="${idx}">
      <span class="deal-rank num">${i + 1}</span>
      <span class="deal-body">
        ${tagged ? `<span class="deal-for">for ${escapeHtml(clip(forR?.displayName || "?", 16))}</span>` : ""}
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
        ${whyLine(ctx, r, nm) ? `<span class="deal-why">${escapeHtml(whyLine(ctx, r, nm))}</span>` : ""}
      </span>
      <span class="deal-go">${icon("chevron")}</span>
    </button>
  </li>`;
}

/* ---------------------------------------------------------------- events */

function onChange(e) {
  if (isFa()) { faChange(e, env); return; }
  const sel = e.target.closest("select[data-f]");
  if (!sel) return;
  store.deals.filters = { ...store.deals.filters, [sel.dataset.f]: sel.value };
  paintList();
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;

  if (act === "mode") {
    const next = t.dataset.v === FA ? FA : "trades";
    if (store.deals.tab === next) return;
    scan += 1;
    faAbort();
    store.deals.tab = next;
    // The whole-league scan has no meaning on the wire; drop back to the picked team.
    if (next === FA && store.deals.scope === LEAGUE) store.deals.scope = "team";
    env.rerender();
    return;
  }

  if (isFa() && faClick(e, env)) return;

  if (act === "pick-team") {
    const fa = isFa();
    openTeamSheet({
      title: fa ? "Wire moves for" : "Best offers for",
      ctx: store.ctx,
      current: store.deals.scope === LEAGUE ? LEAGUE : store.deals.forRosterId,
      // A wire read is always for one roster, so the whole-league row only exists under Trades.
      extras: fa ? [] : [{ value: LEAGUE, label: "Whole league", sub: `every team · up to ${PER_TEAM} offers each` }],
      note: fa
        ? "Free agents are graded against this team's lineup — the best drop comes from its bench."
        : "The whole-league scan runs one team at a time and takes a few seconds.",
      onPick: (value) => {
        const league = value === LEAGUE;
        if (!league && value === store.deals.forRosterId && store.deals.scope === "team") return;
        if (league && store.deals.scope === LEAGUE) return;
        scan += 1; // abandon any in-flight league scan
        faAbort();
        store.deals.scope = league ? LEAGUE : "team";
        if (!league) store.deals.forRosterId = value;
        store.deals.filters = { rival: "", pos: "", shape: "" };
        store.deals.status = "idle";
        store.deals.results = [];
        store.deals.progress = null;
        store.deals.fa = { ...store.deals.fa, status: "idle", results: [], error: null };
        env.rerender();
      },
    });
    return;
  }

  if (act === "recompute") { start(); return; }

  if (act === "clear-filters") {
    store.deals.filters = { rival: "", pos: "", shape: "" };
    paintFilters();
    paintList();
    return;
  }

  if (act === "open") {
    const r = store.deals.results[Number(t.dataset.i)];
    if (!r) return;
    prefill({
      aRosterId: r.forRosterId != null ? r.forRosterId : store.deals.forRosterId,
      theirRosterId: r.theirRosterId,
      give: r.give,
      get: r.get,
    });
    env.go("analyze");
  }
}
