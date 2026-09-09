// Tradewinds — Analyze tab. Rival strip -> two roster columns -> sticky verdict panel.
// The panel recomputes evaluateTrade on every selection change (debounced 50 ms) and is the
// only aria-live region in the app.

import { store, resetAnalyze, toggleSide } from "./store.js";
import {
  avatar, teamName, playerRow, positionGroups, verdictWord, valueBars, bestBadge, flagChips,
  statStrip, icon, empty, toast, copyText, openSheet,
} from "./components.js";
import { escapeHtml, fmtPct, fmtPts, fmtNum, fmtValue, fmtFull, clip } from "./format.js";

export const title = "Analyze";

let env = null;
let timer = null;

export function mount(el, e) {
  env = e;
  const ctx = store.ctx;
  const a = store.analyze;
  if (a.theirRosterId == null || !ctx.rosters.some((r) => r.rosterId === a.theirRosterId)) {
    a.theirRosterId = ctx.rosters.find((r) => r.rosterId !== ctx.myRosterId)?.rosterId ?? null;
  }

  el.innerHTML = `<div class="analyze">
    ${rivalStrip(ctx, a.theirRosterId)}
    <div class="srch">
      ${icon("search", "srch-ic")}
      <input type="search" id="an-q" class="srch-in" placeholder="Filter both rosters" aria-label="Filter both rosters" value="${escapeHtml(a.q)}" autocomplete="off">
    </div>
    <div class="cols" id="an-cols">${columns(ctx, a)}</div>
    <div class="vpanel" id="an-panel" aria-live="polite">${panel(ctx, a)}</div>
  </div>`;

  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  scheduleEval();
  return { destroy() { if (timer) clearTimeout(timer); } };
}

/* ---------------------------------------------------------------- render */

function rivalStrip(ctx, theirId) {
  const rivals = ctx.rosters.filter((r) => r.rosterId !== ctx.myRosterId);
  return `<div class="rivals" role="group" aria-label="Trade partner">
    ${rivals.map((r) => `<button type="button" class="rival${r.rosterId === theirId ? " is-on" : ""}"
      data-act="rival" data-id="${r.rosterId}" aria-pressed="${r.rosterId === theirId}">
      ${avatar(r, 38)}<span class="rival-n">${escapeHtml(clip(r.displayName, 11))}</span>
    </button>`).join("")}
  </div>`;
}

function matches(ctx, id, q) {
  if (!q) return true;
  const p = ctx.players.get(id);
  if (!p) return false;
  const s = `${p.name} ${p.pos} ${p.team}`.toLowerCase();
  return s.includes(q.toLowerCase());
}

function columnList(ctx, roster, side, selected, q) {
  const ids = roster.players.filter((id) => matches(ctx, id, q));
  const groups = positionGroups(ctx, ids);
  if (!groups.length) return `<p class="col-empty">Nothing matches.</p>`;
  return groups.map(([pos, list]) => {
    const rows = list
      .map((id) => ({ id, mv: env.svc.marketValue(ctx, id) }))
      .sort((x, y) => (y.mv.m ?? -1) - (x.mv.m ?? -1));
    return `<div class="pgroup"><h4 class="pgroup-h">${escapeHtml(pos)}<span class="pgroup-n">${rows.length}</span></h4>
      ${rows.map((r) => playerRow(ctx, r.id, { side, selected: selected.includes(r.id), mv: r.mv, compact: true })).join("")}</div>`;
  }).join("");
}

function columns(ctx, a) {
  const mine = ctx.rosters.find((r) => r.rosterId === ctx.myRosterId);
  const theirs = ctx.rosters.find((r) => r.rosterId === a.theirRosterId);
  if (!theirs) return empty("Pick a trade partner", "Choose a team above to see both rosters side by side.");
  return `<section class="col">
      <h3 class="col-h"><i class="dot theirs"></i>You give</h3>
      <p class="col-sub">${teamName(mine)}</p>
      ${columnList(ctx, mine, "give", a.give, a.q)}
    </section>
    <section class="col col-r">
      <h3 class="col-h"><i class="dot mine"></i>You get</h3>
      <p class="col-sub">${teamName(theirs)}</p>
      ${columnList(ctx, theirs, "get", a.get, a.q)}
    </section>`;
}

function panel(ctx, a) {
  if (a.error) return `<div class="vp vp-msg"><p class="vp-hint">Could not grade this trade: ${escapeHtml(a.error)}</p></div>`;
  if (!a.give.length || !a.get.length) {
    const n = a.give.length + a.get.length;
    return `<div class="vp vp-msg">
      <p class="vp-hint">${n === 0 ? "Tap a player on each side to grade the trade." : "Now tap a player on the " + (a.give.length ? "right" : "left") + " side."}</p>
      <p class="vp-count"><span class="num">${a.give.length}</span> out · <span class="num">${a.get.length}</span> in</p>
    </div>`;
  }
  const r = a.result;
  if (!r) return `<div class="vp vp-msg"><p class="vp-hint">Grading…</p></div>`;
  const v = r.verdict;
  const mvBest = r.best ? env.svc.marketValue(ctx, r.best.id) : null;
  const headline = env.svc.explain ? safeExplain(ctx, r).headline : "";

  return `<div class="vp" data-tone="${v.code}">
    <div class="vp-top">
      ${verdictWord(v)}
      <span class="vp-accept ${v.acceptLikely ? "yes" : "no"}">${v.acceptLikely ? "They'd likely accept" : "They'd likely decline"}</span>
    </div>
    ${statStrip(v)}
    ${valueBars(r.me)}
    ${bestBadge(ctx, r.best, mvBest)}
    ${flagChips(r.flags)}
    <p class="vp-head">${escapeHtml(headline)}</p>
    <div class="vp-acts">
      <button type="button" class="btn btn-ghost" data-act="toggle-details" aria-expanded="${a.expanded}">${a.expanded ? "Hide details" : "Details"}</button>
      <button type="button" class="btn btn-ghost" data-act="copy">Copy summary</button>
      <button type="button" class="btn btn-ghost" data-act="clear">Clear</button>
    </div>
    ${a.expanded ? details(ctx, r) : ""}
  </div>`;
}

function details(ctx, r) {
  const me = r.me;
  const drop = me.dropSuggestion ? ctx.players.get(me.dropSuggestion) : null;
  const add = (me.backfillDetail || []).map((b) => ctx.players.get(b.id)?.name).filter(Boolean);
  return `<div class="vp-det">
    <ul class="reasons">${(r.reasons || []).map((x) => `<li>${escapeHtml(x.text)}</li>`).join("")}</ul>
    <table class="mini">
      <caption>Starting lineup, weeks ${ctx.week}–${ctx.lastWeek}</caption>
      <tbody>
        <tr><th scope="row">Points per week</th><td class="num">${fmtNum(me.lineup.before.avgPerWeek)}</td><td class="num arrow">→</td><td class="num">${fmtNum(me.lineup.after.avgPerWeek)}</td></tr>
        <tr><th scope="row">Playoff weeks 15–17</th><td class="num">${fmtNum(me.lineup.before.playoffAvg)}</td><td class="num arrow">→</td><td class="num">${fmtNum(me.lineup.after.playoffAvg)}</td></tr>
        <tr><th scope="row">Roster spots used</th><td class="num">${me.rosterCount.before}</td><td class="num arrow">→</td><td class="num">${me.rosterCount.after} of ${me.rosterCount.max}</td></tr>
        <tr><th scope="row">Their points per week</th><td class="num">${fmtNum(r.them.lineup.before.avgPerWeek)}</td><td class="num arrow">→</td><td class="num">${fmtNum(r.them.lineup.after.avgPerWeek)}</td></tr>
      </tbody>
    </table>
    ${add.length ? `<p class="note">Freed spots backfilled from the wire with ${escapeHtml(add.join(", "))}.</p>` : ""}
    ${drop ? `<p class="note note-warn">You would have to drop someone. Cheapest by surplus: ${escapeHtml(drop.name)}.</p>` : ""}
  </div>`;
}

function safeExplain(ctx, r) {
  try { return env.svc.explain(ctx, r); } catch { return { headline: r.verdict.label, lines: [] }; }
}

/* ---------------------------------------------------------------- events */

function onInput(e) {
  if (e.target.id !== "an-q") return;
  store.analyze.q = e.target.value;
  document.getElementById("an-cols").innerHTML = columns(store.ctx, store.analyze);
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const a = store.analyze;

  if (act === "rival") {
    const id = Number(t.dataset.id);
    resetAnalyze(id);
    const root = t.closest(".analyze");
    root.querySelectorAll(".rival").forEach((b) => {
      const on = Number(b.dataset.id) === id;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    root.querySelector("#an-q").value = "";
    document.getElementById("an-cols").innerHTML = columns(store.ctx, a);
    renderPanel();
    return;
  }

  if (act === "pick") {
    const id = t.dataset.id;
    const side = t.dataset.side;
    const next = toggleSide(side, id);
    const on = next.includes(id);
    t.classList.toggle("is-sel", on);
    t.setAttribute("aria-pressed", String(on));
    scheduleEval();
    return;
  }

  if (act === "toggle-details") { a.expanded = !a.expanded; renderPanel(); return; }
  if (act === "clear") {
    const root = t.closest(".analyze");
    resetAnalyze(a.theirRosterId);
    root.querySelectorAll(".prow.is-sel").forEach((b) => { b.classList.remove("is-sel"); b.setAttribute("aria-pressed", "false"); });
    renderPanel();
    return;
  }
  if (act === "copy") { doCopy(); }
}

function scheduleEval() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runEval, 50);
}

function runEval() {
  const ctx = store.ctx;
  const a = store.analyze;
  a.error = null;
  if (!a.give.length || !a.get.length || a.theirRosterId == null) { a.result = null; renderPanel(); return; }
  try {
    a.result = env.svc.evaluateTrade(ctx, {
      myRosterId: ctx.myRosterId, theirRosterId: a.theirRosterId, give: a.give, get: a.get,
    });
  } catch (err) {
    a.result = null;
    a.error = String(err && err.message ? err.message : err);
    console.error("[analyze] evaluateTrade failed", err);
  }
  renderPanel();
}

function renderPanel() {
  const host = document.getElementById("an-panel");
  if (host) host.innerHTML = panel(store.ctx, store.analyze);
}

async function doCopy() {
  const ctx = store.ctx, a = store.analyze, r = a.result;
  if (!r) return;
  const nm = (id) => ctx.players.get(id)?.name || id;
  const theirs = ctx.rosters.find((x) => x.rosterId === a.theirRosterId);
  const text = [
    `${r.verdict.label} (Tradewinds)`,
    `I give: ${r.give.map(nm).join(", ")}`,
    `I get:  ${r.get.map(nm).join(", ")}`,
    `Edge ${fmtPct(r.verdict.edgePct)} · starters ${fmtPts(r.verdict.deltaPerWeek)} pts/wk (${fmtPts(r.verdict.deltaPlayoffPerWeek)} in wk 15-17)`,
    `Surplus ${fmtFull(r.me.valueGive.surplus)} out vs ${fmtFull(r.me.valueGet.surplus)} in (raw ${fmtValue(r.me.valueGive.raw)} vs ${fmtValue(r.me.valueGet.raw)})`,
    `${theirs?.teamName || "They"}: ${fmtPct(r.them.edgePct)} — ${r.verdict.acceptLikely ? "likely accepts" : "likely declines"}`,
    ...(r.reasons || []).slice(0, 3).map((x) => `• ${x.text}`),
  ].join("\n");
  const ok = await copyText(text);
  toast(ok ? "Summary copied." : "Copy failed — showing the text instead.", { tone: ok ? "" : "warn" });
  if (!ok) openSheet({ title: "Trade summary", body: `<pre class="pre">${escapeHtml(text)}</pre>` });
}

/** Called by deals.js after prefilling store.analyze. */
export function prefill({ theirRosterId, give, get }) {
  store.analyze = { theirRosterId, give: give.slice(), get: get.slice(), q: "", result: null, expanded: false, error: null };
}
