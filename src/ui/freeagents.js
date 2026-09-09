// Tradewinds — the Free agents pane of the Deals tab (design §11.5).
//
// The wire is the cheapest trade there is, so it is graded on the same lineup axis: every row
// is an (add, drop) pair with a points-per-week gain, not a "top available" list. The engine
// call (`findFreeAgents`) is synchronous and walks the roster once per candidate, so it runs in
// an idle callback after first paint — the skeleton is what the tab shows meanwhile.

import { store, setIn } from "./store.js";
import { playerThumb, skeleton, empty, signTone, injuryTag } from "./components.js";
import {
  escapeHtml, fmtValue, fmtNum, fmtPts, waiverChipText, clip,
} from "./format.js";
import { openPlayerSheet } from "./players.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const MAX_RESULTS = 12;

let gen = 0; // generation token — a target/position change abandons an in-flight compute

export function faAbort() { gen += 1; }

/* ---------------------------------------------------------------- compute */

/** Rest-of-season points per week, straight off the projection matrix. */
function rosPerWeek(ctx, id) {
  const wk = ctx.proj.get(id);
  if (!wk || !ctx.weeksLeft.length) return null;
  let t = 0;
  for (const w of ctx.weeksLeft) t += Number(wk[w - 1]) || 0;
  return t / ctx.weeksLeft.length;
}

/**
 * Kick off a search for `store.deals.forRosterId`.
 * `ctx.transactions` decides whether a player is an instant add or a waiver claim, so it is
 * pulled (once, memoized by app.js) BEFORE the finder runs — a missing feed would silently
 * grade every waiver-locked player as free.
 */
export async function faStart(env) {
  gen += 1;
  const token = gen;
  const ctx = store.ctx;
  setIn("deals", { fa: { ...store.deals.fa, status: "running", results: [], error: null } });
  faPaint(env);

  // The engine is pure — it never reads the clock — so the UI supplies "now" for waiver windows.
  if (ctx.now == null) ctx.now = Date.now();
  if (!Array.isArray(ctx.transactions) || !ctx.transactions.length) {
    try {
      const out = await env.transactions();
      if (token !== gen) return;
      ctx.transactions = (out && out.txns) || [];
    } catch (err) {
      console.warn("[fa] transactions unavailable — waiver windows will read as free", err);
      if (!Array.isArray(ctx.transactions)) ctx.transactions = [];
    }
  }
  if (token !== gen) return;
  idle(() => compute(env, token));
}

function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 32);
}

function compute(env, token) {
  if (token !== gen) return;
  const ctx = store.ctx;
  const d = store.deals;
  const t0 = performance.now();
  try {
    const results = env.svc.findFreeAgents(ctx, {
      rosterId: d.forRosterId,
      maxResults: MAX_RESULTS,
      position: d.fa.pos || null,
    }) || [];
    setIn("deals", {
      fa: { ...store.deals.fa, status: "done", results, error: null, ms: Math.round(performance.now() - t0) },
    });
  } catch (err) {
    console.error("[fa] findFreeAgents failed", err);
    setIn("deals", {
      fa: { ...store.deals.fa, status: "error", results: [], error: String(err && err.message ? err.message : err) },
    });
  }
  faPaint(env);
}

/* ---------------------------------------------------------------- render */

export function faFilters() {
  const cur = store.deals.fa.pos;
  return `<label class="fsel"><span class="vh">Position</span>
    <select data-f="fapos"><option value="">Every position</option>
    ${POSITIONS.map((p) => `<option value="${p}"${cur === p ? " selected" : ""}>${p} only</option>`).join("")}</select></label>`;
}

/** "you" when the wire is being read for my own team, otherwise that team's name. */
function subjectName() {
  const ctx = store.ctx;
  const d = store.deals;
  if (ctx.myRosterId != null && d.forRosterId === ctx.myRosterId) return "your";
  const r = ctx.rosters.find((x) => x.rosterId === d.forRosterId);
  return r ? `${r.displayName}'s` : "that";
}

export function faPaint(env) {
  const host = document.getElementById("dl-list");
  if (!host) return;
  const fa = store.deals.fa;

  if (fa.status === "running" || fa.status === "idle") {
    host.innerHTML = `<p class="hint" role="status">Grading every free agent against ${escapeHtml(subjectName())} roster…</p>${skeleton(3, "sk-deal")}`;
    return;
  }
  if (fa.status === "error") {
    host.innerHTML = empty("The wire search stopped", fa.error || "Unknown error.", { act: "recompute", label: "Try again" });
    return;
  }
  if (!fa.results.length) {
    host.innerHTML = fa.pos
      ? empty("No free agent at that position beats the roster",
        `Nothing on the wire at ${fa.pos} is worth a roster spot right now.`,
        { act: "fa-clear", label: "Every position" })
      : empty("Nothing on the wire beats your roster right now.",
        "Every available player would sit on the bench. Check back after the next waiver run.");
    return;
  }
  host.innerHTML = `<ol class="fa-list">${fa.results.map((r, i) => card(env, r, i)).join("")}</ol>
    <p class="hint hint-end">${fa.results.length} worth a move${fa.ms != null ? ` · found in ${fa.ms} ms` : ""}</p>`;
}

function statusChip(row) {
  const waivers = row.status === "waivers";
  return `<span class="schip ${waivers ? "schip-wv" : "schip-free"}">${escapeHtml(waiverChipText(row))}</span>`;
}

function card(env, row, i) {
  const ctx = store.ctx;
  const p = ctx.players.get(row.add) || { name: row.add, pos: "", team: "" };
  const mv = env.svc.marketValue(ctx, row.add);
  const ros = rosPerWeek(ctx, row.add);
  const drop = row.drop ? ctx.players.get(row.drop) : null;
  const why = Array.isArray(row.why) && row.why.length ? row.why[0] : "";
  const playoff = Number(row.playoffGainPerWeek);
  return `<li class="fa" data-status="${escapeHtml(row.status || "free")}">
    <button type="button" class="fa-hit" data-act="fa-open" data-id="${escapeHtml(row.add)}">
      <span class="fa-rank num">${i + 1}</span>
      ${playerThumb(ctx, row.add, 44)}
      <span class="fa-body">
        <span class="fa-h">
          <span class="fa-name">${escapeHtml(clip(p.name, 20))}${injuryTag(p.inj)}</span>
          <span class="fa-val num">${mv.m != null ? fmtValue(mv.m) : "—"}</span>
        </span>
        <span class="fa-meta">${escapeHtml(p.pos || "")}${p.team ? ` · ${escapeHtml(p.team)}` : ""}
          <span class="dim">· ${ros != null ? fmtNum(ros) : "—"} pts/wk ROS</span>
          ${row.trend ? `<span class="fa-trend" title="Sleeper adds, last 24 hours">🔥 ${escapeHtml(Number(row.trend).toLocaleString("en-US"))}</span>` : ""}</span>
        <span class="fa-chips">
          ${statusChip(row)}
          ${drop
            ? `<span class="schip schip-drop">drop ${escapeHtml(clip(drop.name, 16))}</span>`
            : `<span class="schip schip-open">open roster spot</span>`}
        </span>
        <span class="deal-stats">
          <span class="dstat"><b class="num" data-tone="${signTone(row.gainPerWeek)}">${fmtPts(row.gainPerWeek)}</b> pts/wk</span>
          ${Number.isFinite(playoff) ? `<span class="dstat"><b class="num" data-tone="${signTone(playoff)}">${fmtPts(playoff)}</b> playoffs</span>` : ""}
          <span class="dstat"><b class="num" data-tone="${signTone(row.valueDelta, 50)}">${row.valueDelta > 0 ? "+" : ""}${fmtValue(row.valueDelta)}</b> value</span>
        </span>
        ${why ? `<span class="deal-why">${escapeHtml(why)}</span>` : ""}
      </span>
    </button>
  </li>`;
}

/* ---------------------------------------------------------------- events */

/** @returns {boolean} true when the click belonged to this pane. */
export function faClick(e, env) {
  const t = e.target.closest("[data-act]");
  if (!t) return false;
  if (t.dataset.act === "fa-open") {
    openPlayerSheet(t.dataset.id, env);
    return true;
  }
  if (t.dataset.act === "fa-clear") {
    store.deals.fa = { ...store.deals.fa, pos: "" };
    const f = document.getElementById("dl-filters");
    if (f) f.innerHTML = faFilters();
    faStart(env);
    return true;
  }
  return false;
}

/** @returns {boolean} true when the change belonged to this pane. */
export function faChange(e, env) {
  const sel = e.target.closest("select[data-f='fapos']");
  if (!sel) return false;
  store.deals.fa = { ...store.deals.fa, pos: sel.value };
  faStart(env);
  return true;
}
