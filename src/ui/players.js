// Tradewinds — Players tab. Search the whole player table, open a value card for anyone.

import { store } from "./store.js";
import { icon, openSheet, empty, trendArrow, rosterPctWarning, injuryTag } from "./components.js";
import { escapeHtml, fmtValue, fmtFull, fmtNum, fmtRosterPct, initials, clip, posRankLabel } from "./format.js";
import { SLEEPER } from "../config.js";

export const title = "Players";

let env = null;

export function mount(el, e) {
  env = e;
  el.innerHTML = `<div class="players">
    <div class="srch srch-lg">
      ${icon("search", "srch-ic")}
      <input type="search" id="pl-q" class="srch-in" placeholder="Search any player" aria-label="Search players by name, team or position"
        value="${escapeHtml(store.players.q)}" autocomplete="off" enterkeyhint="search">
    </div>
    <div id="pl-list"></div>
  </div>`;
  el.addEventListener("input", onInput);
  el.addEventListener("click", onClick);
  paint();
  return { destroy() {} };
}

function rosPerWeek(ctx, id) {
  const wk = ctx.proj.get(id);
  if (!wk) return null;
  let t = 0;
  for (const w of ctx.weeksLeft) t += wk[w - 1] || 0;
  return ctx.weeksLeft.length ? t / ctx.weeksLeft.length : null;
}

function search(q) {
  const ctx = store.ctx;
  const needle = q.trim().toLowerCase();
  const out = [];
  for (const [id, p] of ctx.players) {
    const hay = `${p.name} ${p.pos} ${p.team}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    out.push({ id, p, mv: env.svc.marketValue(ctx, id) });
    if (out.length > 400) break;
  }
  out.sort((a, b) => (b.mv.m ?? -1) - (a.mv.m ?? -1));
  return out.slice(0, 60);
}

function topValues() {
  const ctx = store.ctx;
  const out = [];
  for (const [id, p] of ctx.players) {
    const mv = env.svc.marketValue(ctx, id);
    if (mv.m == null) continue;
    out.push({ id, p, mv });
  }
  out.sort((a, b) => b.mv.m - a.mv.m);
  return out.slice(0, 25);
}

function paint() {
  const host = document.getElementById("pl-list");
  if (!host) return;
  const ctx = store.ctx;
  const q = store.players.q.trim();
  if (q.length === 1) {
    host.innerHTML = `<p class="hint">Keep typing — two letters at least.</p>`;
    return;
  }
  const rows = q.length >= 2 ? search(q) : topValues();
  if (!rows.length) {
    host.innerHTML = empty("Nobody by that name", `No player matches “${q}”. Try a team code like DET, or a position.`);
    return;
  }
  host.innerHTML = `${q.length >= 2 ? "" : '<h2 class="view-h">Most valuable players</h2>'}
    <ul class="plist">${rows.map(({ id, p, mv }) => {
      const owner = ctx.rosterOf.get(id);
      const or = owner ? ctx.rosters.find((r) => r.rosterId === owner) : null;
      return `<li><button type="button" class="prow prow-wide" data-act="player" data-id="${escapeHtml(id)}">
        <span class="prow-main">
          <span class="prow-name">${escapeHtml(p.name)}</span>
          <span class="prow-meta">${escapeHtml(p.pos)}<span class="dim">${escapeHtml(p.team ? " " + p.team : "")}</span>
            ${injuryTag(p.inj)}<span class="owner ${or ? (or.rosterId === ctx.myRosterId ? "owner-me" : "") : "owner-free"}">${or ? escapeHtml(clip(or.displayName, 12)) : "free agent"}</span></span>
        </span>
        <span class="prow-val num">${mv.m != null ? fmtValue(mv.m) : "—"}</span>
      </button></li>`;
    }).join("")}</ul>`;
}

/* ---------------------------------------------------------------- sheet */

/**
 * The value card for one player. Exported because the Deals tab's free-agent rows open the
 * same sheet; `e` lets a caller pass its own env when Players has never been mounted.
 * @param {string} id
 * @param {object} [e] view env (defaults to the one Players was mounted with)
 */
export function openPlayerSheet(id, e = env) {
  const svc = (e || env).svc;
  const ctx = store.ctx;
  const p = ctx.players.get(id);
  if (!p) return;
  const mv = svc.marketValue(ctx, id);
  const owner = ctx.rosterOf.get(id);
  const or = owner ? ctx.rosters.find((r) => r.rosterId === owner) : null;
  const bye = ctx.byes?.[p.team];
  const pw = rosPerWeek(ctx, id);
  const ini = escapeHtml(initials(p.name));
  const img = p.pos === "DEF" ? SLEEPER.teamLogo(p.team || id) : SLEEPER.playerThumb(id);

  const srcRows = Object.entries(mv.sources || {});
  const labels = { fc_redraft: "FantasyCalc redraft", fc_dynasty: "FantasyCalc dynasty", dp_dynasty: "DynastyProcess", ktc_redraft: "KeepTradeCut", proj: "Projection-implied", bc_tiers: "Boris Chen" };

  const body = `<div class="psheet">
    <div class="psheet-top">
      <span class="thumb thumb-fb"><i>${ini}</i><img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'"></span>
      <div class="psheet-id">
        <p class="psheet-n">${escapeHtml(p.name)}</p>
        <p class="psheet-m">${escapeHtml(posRankLabel(p.pos, mv.posRank))} · ${escapeHtml(p.team || "FA")}${p.age ? ` · age ${p.age}` : ""}${p.exp != null ? ` · year ${p.exp + 1}` : ""}</p>
        <p class="psheet-m">${or ? `Rostered by <strong>${escapeHtml(or.teamName)}</strong>` : '<strong class="win">Free agent</strong>'}${bye ? ` · bye week ${bye}` : ""}${p.inj ? " " : ""}${injuryTag(p.inj)}</p>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><span class="kpi-k">Consensus value</span><span class="kpi-v num big">${mv.m != null ? fmtFull(mv.m) : "—"}</span></div>
      <div class="kpi"><span class="kpi-k">Rest of season</span><span class="kpi-v num">${pw != null ? fmtNum(pw) : "—"}</span><span class="kpi-u">pts/wk</span></div>
      <div class="kpi"><span class="kpi-k">30-day trend</span><span class="kpi-v">${trendArrow(mv.trend)}</span></div>
    </div>

    ${mv.m == null ? `<p class="note note-warn">No market value: kickers and defenses are not priced by any trade source, so they never carry a verdict.</p>` : ""}
    ${rosterPctWarning(mv)}

    <h3 class="sub">Where the value comes from</h3>
    ${srcRows.length ? `<table class="mini"><tbody>
      ${srcRows.map(([k, v]) => `<tr><th scope="row">${escapeHtml(labels[k] || k)}</th><td class="num">${fmtFull(v)}</td></tr>`).join("")}
      ${mv.dynasty != null ? `<tr class="mini-sum"><th scope="row">Keeper tilt (φ ${ctx.settings.keeperTilt})</th><td class="num">${fmtFull(mv.m)}</td></tr>` : ""}
    </tbody></table>` : `<p class="note">No source prices this player.</p>`}

    <h3 class="sub">Market context</h3>
    <table class="mini"><tbody>
      <tr><th scope="row">Overall rank</th><td class="num">${mv.rank ?? "—"}</td></tr>
      <tr><th scope="row">Position rank</th><td class="num">${mv.posRank ?? "—"}</td></tr>
      <tr><th scope="row">Tier</th><td class="num">${mv.tier ?? "—"}</td></tr>
      <tr><th scope="row">Rostered in</th><td class="num">${mv.rosterPct != null ? fmtRosterPct(mv.rosterPct) + " of leagues" : "—"}</td></tr>
      <tr><th scope="row">Trade frequency</th><td class="num">${mv.tradeFreq != null ? (mv.tradeFreq * 100).toFixed(2) + "%" : "—"}</td></tr>
    </tbody></table>
  </div>`;
  openSheet({ title: p.name, body });
}

/* ---------------------------------------------------------------- events */

function onInput(e) {
  if (e.target.id !== "pl-q") return;
  store.players.q = e.target.value;
  paint();
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (t && t.dataset.act === "player") openPlayerSheet(t.dataset.id);
}
