// Tradewinds — League tab. Standings, roster sheets, graded completed trades, recent moves.

import { store, setIn } from "./store.js";
import {
  avatar, teamName, skeleton, empty, openSheet, positionGroups, verdictWord, injuryTag, signTone,
} from "./components.js";
import { escapeHtml, fmtValue, fmtFull, fmtNum, fmtPct, relTime, clip } from "./format.js";
import { prefill } from "./analyze.js";

export const title = "League";

let env = null;

export function mount(el, e) {
  env = e;
  el.innerHTML = `<div class="league">
    ${standings()}
    <section class="sec"><div class="sec-head"><h2>Completed trades</h2></div><div id="lg-trades">${skeleton(2, "sk-row")}</div></section>
    <section class="sec"><div class="sec-head"><h2>Recent moves</h2></div><div id="lg-moves">${skeleton(3, "sk-row")}</div></section>
    ${trending()}
  </div>`;
  el.addEventListener("click", onClick);
  loadTxns();
  return { destroy() {} };
}

/* ---------------------------------------------------------------- standings */

function rosterValue(ctx, r) {
  let v = 0;
  for (const id of r.players) v += env.svc.marketValue(ctx, id).mAdj || 0;
  return v;
}

function standings() {
  const ctx = store.ctx;
  const rows = ctx.rosters
    .map((r) => ({ r, v: rosterValue(ctx, r) }))
    .sort((a, b) => b.r.wins - a.r.wins || b.r.fpts - a.r.fpts || b.v - a.v);
  return `<section class="sec">
    <div class="sec-head"><h2>${escapeHtml(ctx.league.name)}</h2><span class="sec-note">week ${ctx.week} of ${ctx.lastWeek}</span></div>
    <table class="stand">
      <thead><tr><th scope="col" class="c-rk">#</th><th scope="col">Team</th><th scope="col" class="c-n">W–L</th><th scope="col" class="c-n">PF</th><th scope="col" class="c-n">Value</th></tr></thead>
      <tbody>${rows.map(({ r, v }, i) => `<tr class="${r.rosterId === ctx.myRosterId ? "is-me" : ""}">
        <td class="c-rk num">${i + 1}</td>
        <td><button type="button" class="team-hit" data-act="roster" data-id="${r.rosterId}">${avatar(r, 26)}
          <span class="team-txt"><span class="team-n">${escapeHtml(clip(r.teamName, 20))}</span><span class="team-u">${escapeHtml(r.displayName)}</span></span></button></td>
        <td class="c-n num">${r.wins}–${r.losses}${r.ties ? "–" + r.ties : ""}</td>
        <td class="c-n num">${fmtNum(r.fpts, 0)}</td>
        <td class="c-n num">${fmtValue(v)}</td></tr>`).join("")}</tbody>
    </table>
  </section>`;
}

/* ---------------------------------------------------------------- roster sheet */

function rosterSheet(rosterId) {
  const ctx = store.ctx;
  const r = ctx.rosters.find((x) => x.rosterId === rosterId);
  if (!r) return;
  const line = safe(() => env.svc.bestLineup(ctx, r.players, ctx.week));
  const season = safe(() => env.svc.seasonLineup(ctx, r.players, {}));
  const total = r.players.reduce((s, id) => s + (env.svc.marketValue(ctx, id).mAdj || 0), 0);
  const groups = positionGroups(ctx, r.players);

  const body = `<div class="rsheet">
    <div class="rsheet-top">${avatar(r, 44)}
      <div><p class="rsheet-n">${teamName(r)}</p><p class="rsheet-u">${escapeHtml(r.displayName)} · ${r.wins}–${r.losses}</p></div>
    </div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-k">Roster value</span><span class="kpi-v num">${fmtFull(total)}</span></div>
      <div class="kpi"><span class="kpi-k">Week ${ctx.week} projection</span><span class="kpi-v num">${line ? fmtNum(line.total) : "—"}</span></div>
      <div class="kpi"><span class="kpi-k">Rest of season</span><span class="kpi-v num">${season ? fmtNum(season.avgPerWeek) : "—"}</span><span class="kpi-u">pts/wk</span></div>
    </div>
    ${line ? `<h3 class="sub">Best lineup this week</h3>
      <table class="mini mini-line"><tbody>${line.slots.map((s) => {
        const p = s.id ? ctx.players.get(s.id) : null;
        return `<tr><th scope="row">${escapeHtml(s.slot)}</th><td>${p ? escapeHtml(p.name) : '<span class="dim">empty</span>'}</td><td class="num">${fmtNum(s.pts)}</td></tr>`;
      }).join("")}</tbody></table>` : ""}
    <h3 class="sub">Roster by value</h3>
    ${groups.map(([pos, list]) => {
      const rows = list.map((id) => ({ id, mv: env.svc.marketValue(ctx, id) })).sort((a, b) => (b.mv.m ?? -1) - (a.mv.m ?? -1));
      return `<div class="pgroup"><h4 class="pgroup-h">${escapeHtml(pos)}<span class="pgroup-n">${rows.length}</span></h4>
        ${rows.map(({ id, mv }) => {
          const p = ctx.players.get(id);
          return `<div class="prow prow-static"><span class="prow-main"><span class="prow-name">${escapeHtml(p?.name || id)}</span>
            <span class="prow-meta"><span class="dim">${escapeHtml(p?.team || "")}</span>${injuryTag(p?.inj)}${r.starters.includes(id) ? '<span class="tag tag-ok">starter</span>' : ""}</span></span>
            <span class="prow-val num">${mv.m != null ? fmtValue(mv.m) : "—"}</span></div>`;
        }).join("")}</div>`;
    }).join("")}
  </div>`;
  openSheet({ title: r.teamName, body });
}

function safe(fn) { try { return fn(); } catch (e) { console.warn("[league]", e); return null; } }

/* ---------------------------------------------------------------- transactions */

async function loadTxns() {
  const ctx = store.ctx;
  if (store.league.txns) { paintTxns(); return; }
  setIn("league", { txnStatus: "running" });
  try {
    const txns = await Promise.resolve(env.svc.getTransactions(ctx, { rounds: ctx.week }));
    setIn("league", { txns: txns || [], txnStatus: "done" });
  } catch (err) {
    console.error("[league] getTransactions failed", err);
    setIn("league", { txns: [], txnStatus: "error" });
  }
  paintTxns();
}

function paintTxns() {
  const ctx = store.ctx;
  const txns = store.league.txns || [];
  const trades = txns.filter((t) => t.type === "trade");
  const moves = txns.filter((t) => t.type !== "trade").slice(0, 8);

  const th = document.getElementById("lg-trades");
  if (th) {
    th.innerHTML = trades.length
      ? trades.map(tradeCard).join("")
      : (store.league.txnStatus === "error"
        ? empty("Trades unavailable", "The transaction feed did not answer. Pull to refresh from the header.")
        : empty("No trades yet this season", "When someone in the league trades, it lands here with a grade from both sides."));
  }

  const mh = document.getElementById("lg-moves");
  if (mh) {
    mh.innerHTML = moves.length
      ? `<ul class="moves">${moves.map((t) => {
        const who = ctx.rosters.find((r) => r.rosterId === t.rosterIds[0]);
        const add = Object.keys(t.adds || {}).map((id) => ctx.players.get(id)?.name || id);
        const drop = Object.keys(t.drops || {}).map((id) => ctx.players.get(id)?.name || id);
        return `<li class="move"><span class="move-who">${escapeHtml(who?.displayName || "—")}</span>
          <span class="move-txt">${add.length ? `<b class="win">+</b> ${escapeHtml(add.join(", "))}` : ""}${drop.length ? ` <b class="loss">−</b> <span class="dim">${escapeHtml(drop.join(", "))}</span>` : ""}</span>
          <span class="move-t">${escapeHtml(relTime(t.created))}</span></li>`;
      }).join("")}</ul>`
      : empty("No moves logged", "Adds and drops from the league appear here.");
  }
}

function tradeCard(t) {
  const ctx = store.ctx;
  const ids = [...new Set(t.rosterIds)].sort((a, b) => a - b);
  const [lo, hi] = ids;
  const loR = ctx.rosters.find((r) => r.rosterId === lo);
  const hiR = ctx.rosters.find((r) => r.rosterId === hi);
  const gets = (rid) => Object.entries(t.adds || {}).filter(([, r]) => r === rid).map(([id]) => id);
  const loGet = gets(lo), hiGet = gets(hi);

  // A completed trade belongs to two other managers as often as not, so it is graded and
  // written from roster `lo`'s side with both teams named (design §10.3 `sideNames`).
  const sn = env.svc.sideNames(ctx, lo, hi);
  let res = null;
  try {
    res = env.svc.evaluateTrade(ctx, { myRosterId: lo, theirRosterId: hi, give: hiGet, get: loGet }, { names: sn });
  } catch (e) { console.warn("[league] grade failed", e); }

  const nm = (id) => escapeHtml(clip(ctx.players.get(id)?.name || id, 20));
  const tone = res?.verdict?.code || "fair";
  return `<article class="tcard" data-tone="${escapeHtml(tone)}">
    <header class="tcard-h">
      <span class="tcard-when">${escapeHtml(relTime(t.created))}</span>
      ${res ? verdictWord(res.verdict) : '<span class="verdict-word" data-tone="even">Ungraded</span>'}
    </header>
    <div class="tcard-sides">
      <div class="tside"><p class="tside-n">${escapeHtml(clip(loR?.displayName || "", 14))}
        <span class="tside-e num" data-tone="${signTone(res?.me?.edgePct, 0.5)}">${res ? fmtPct(res.me.edgePct) : "—"}</span></p>
        <p class="tside-p">${loGet.map(nm).join("<br>") || '<span class="dim">nothing</span>'}</p></div>
      <div class="tside"><p class="tside-n">${escapeHtml(clip(hiR?.displayName || "", 14))}
        <span class="tside-e num" data-tone="${signTone(res?.them?.edgePct, 0.5)}">${res ? fmtPct(res.them.edgePct) : "—"}</span></p>
        <p class="tside-p">${hiGet.map(nm).join("<br>") || '<span class="dim">nothing</span>'}</p></div>
    </div>
    ${res ? `<p class="tcard-why">${escapeHtml(res.reasons?.[0]?.text || "")}</p>` : ""}
    <div class="tcard-acts">
      <button type="button" class="btn btn-ghost btn-sm" data-act="reopen"
        data-a="${lo}" data-b="${hi}"
        data-give="${escapeHtml(hiGet.join(","))}" data-get="${escapeHtml(loGet.join(","))}">Re-open in Analyze</button>
    </div>
  </article>`;
}

/* ---------------------------------------------------------------- trending */

function trending() {
  const ctx = store.ctx;
  const list = ctx.trending;
  if (!list || !list.length) return "";
  return `<section class="sec"><div class="sec-head"><h2>Trending adds</h2><span class="sec-note">last 24 hours</span></div>
    <ul class="trend-list">${list.slice(0, 8).map((t) => {
      const p = ctx.players.get(t.id);
      const owner = ctx.rosterOf.get(t.id);
      const or = owner ? ctx.rosters.find((r) => r.rosterId === owner) : null;
      return `<li class="trow"><span class="trow-n">${escapeHtml(p?.name || t.id)}</span>
        <span class="trow-m"><span class="dim">${escapeHtml(p?.pos || "")} ${escapeHtml(p?.team || "")}</span></span>
        <span class="trow-o">${or ? escapeHtml(clip(or.displayName, 12)) : '<span class="win">free</span>'}</span>
        <span class="trow-c num">${fmtValue(t.count)}</span></li>`;
    }).join("")}</ul></section>`;
}

/* ---------------------------------------------------------------- events */

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "roster") { rosterSheet(Number(t.dataset.id)); return; }
  if (t.dataset.act === "reopen") {
    const ids = (v) => (v ? v.split(",").filter(Boolean) : []);
    prefill({
      aRosterId: Number(t.dataset.a),
      theirRosterId: Number(t.dataset.b),
      give: ids(t.dataset.give),
      get: ids(t.dataset.get),
    });
    env.go("analyze");
  }
}
