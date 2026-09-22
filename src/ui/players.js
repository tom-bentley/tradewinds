// Tradewinds — Players tab. Search the whole player table, open a value card for anyone.

import { store } from "./store.js";
import {
  icon, openSheet, empty, trendArrow, rosterPctWarning, injuryTag, bandChip, pct01, toast,
} from "./components.js";
import {
  weekStrip, usageSparkline, matchupStrip, matchupNextChips, availabilityBar,
  valueBullet, synergyBadges, dossierCard,
} from "./sparkline.js";
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

/**
 * The one mark allowed in a list row (R12 §Q12.4 P2): a 56×18 snap-share sparkline, and nothing
 * else. Rows stay condensed — up to 60 of them repaint on every keystroke (`paint`), so this is
 * 3 SVG nodes or none at all. `usageOf` is a Phase-0 stand-in that answers null until the engine
 * merges; a null answer means the row simply omits the mark, never a placeholder box.
 */
function rowSpark(ctx, id) {
  const u = typeof env?.svc?.usageOf === "function" ? safe(() => env.svc.usageOf(ctx, id)) : null;
  if (!u || !Array.isArray(u.weeks)) return "";
  const series = Array.isArray(u.snapShare) && u.snapShare.some((v) => v != null)
    ? u.snapShare : u.targetShare;
  if (!Array.isArray(series)) return "";
  return usageSparkline({
    weeks: u.weeks, values: series, row: true, uid: `row-${id}`,
    kind: series === u.snapShare ? "snap share" : "target share of team pass attempts",
    partialWeeks: u.partialWeeks,
  });
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
      const spark = rowSpark(ctx, id);
      return `<li><button type="button" class="prow prow-wide" data-act="player" data-id="${escapeHtml(id)}">
        <span class="prow-main">
          <span class="prow-name">${escapeHtml(p.name)}</span>
          <span class="prow-meta">${escapeHtml(p.pos)}<span class="dim">${escapeHtml(p.team ? " " + p.team : "")}</span>
            ${injuryTag(p.inj)}<span class="owner ${or ? (or.rosterId === ctx.myRosterId ? "owner-me" : "") : "owner-free"}">${or ? escapeHtml(clip(or.displayName, 12)) : "free agent"}</span></span>
        </span>
        ${spark ? `<span class="prow-spark">${spark}</span>` : ""}
        <span class="prow-val num">${mv.m != null ? fmtValue(mv.m) : "—"}</span>
      </button></li>`;
    }).join("")}</ul>`;
}

/* ---------------------------------------------------------------- sheet */

/** The risk module is wired in at integration and absent in demo mode — never assume it. */
function safe(fn) { try { return fn(); } catch (err) { console.warn("[players]", err); return null; } }

/** A callable service, or null. Every 004 module is optional in exactly this way. */
function svcFn(svc, name) { return typeof svc?.[name] === "function" ? svc[name] : null; }

/**
 * THIS season's weekly actuals, by week number.
 *
 * `risk.historyOf` deliberately prefers the newest COMPLETE season (risk.js:132) because six
 * games say little about durability, and `historyWeekly` drops the week index entirely — so
 * neither exposed helper can answer "what did he score in week 5 of the season we are in".
 * `ctx.history` holds it (`buildHistory`, context.js:508: `seasons[year].w[i]` = week i+1 as
 * `[pts_std, rec]`, null for a week he did not play), so the sheet reads it directly and applies
 * this league's PPR. Listed in the report as a service worth exposing (`seasonWeekly(ctx, id)`).
 */
function seasonWeekly(ctx, id) {
  const row = ctx.history && typeof ctx.history.get === "function" ? ctx.history.get(id) : null;
  const block = row && row.seasons ? row.seasons[String(ctx.season || "")] : null;
  if (!block || !Array.isArray(block.w) || !block.w.length) return null;
  const ppr = Number(ctx.league && ctx.league.ppr) || 0;
  const weeks = [];
  const actual = [];
  const dnp = [];
  const upto = Math.max(0, Math.min(block.w.length, Number(ctx.week) ? Number(ctx.week) - 1 : block.w.length));
  for (let i = 0; i < upto; i += 1) {
    const w = i + 1;
    weeks.push(w);
    const cell = block.w[i];
    if (!Array.isArray(cell)) { actual.push(null); dnp.push(w); continue; }
    actual.push((Number(cell[0]) || 0) + ppr * (Number(cell[1]) || 0));
  }
  return weeks.length ? { weeks, actual, dnp } : null;
}

/** Per-week projections from `ctx.proj`, which is a dense vector indexed by week − 1. */
function projFor(ctx, id, weeks) {
  const vec = ctx.proj && typeof ctx.proj.get === "function" ? ctx.proj.get(id) : null;
  if (!vec) return weeks.map(() => null);
  return weeks.map((w) => {
    const v = Number(vec[w - 1]);
    return Number.isFinite(v) ? v : null;
  });
}

function byeWeeksOf(ctx, p) {
  const b = ctx.byes && p && p.team ? Number(ctx.byes[p.team]) : NaN;
  return Number.isFinite(b) ? [b] : [];
}

/** Weeks from now to the end of the scoring season — the horizon P3 and P4 both draw. */
function aheadWeeks(ctx) {
  const from = Number(ctx.week) || 1;
  const to = Number(ctx.lastWeek) || 17;
  const out = [];
  for (let w = from; w <= to; w += 1) out.push(w);
  return out;
}

/* ---------------------------------------------------------------- sheet sections */

/**
 * P6 — market against model. `hiddenValue` is a Phase-0 stand-in returning null until the engine
 * merges, and K/DEF are unpriced by every trade source, so the block stands down in both cases
 * rather than drawing a bullet against a number nobody computed.
 */
function valueSection(ctx, svc, id, mv) {
  const hv = svcFn(svc, "hiddenValue") ? safe(() => svc.hiddenValue(ctx, id)) : null;
  const market = mv.mAdj != null ? mv.mAdj : mv.m;
  const model = hv && Number.isFinite(Number(hv.modelValue)) ? Number(hv.modelValue) : null;
  if (market == null || model == null) return { html: "", hv };
  return {
    hv,
    html: `<h3 class="sub">Market against model</h3>
      ${valueBullet({ market, model, label: "Model value" })}
      ${hv.confidence === "provisional" ? `<p class="mv-note">Provisional — under four played weeks, so the usage half of this is thin.</p>` : ""}
      ${Array.isArray(hv.why) && hv.why.length ? `<ul class="reasons">${hv.why.slice(0, 2).map((w) => `<li>${escapeHtml(String(w))}</li>`).join("")}</ul>` : ""}`,
  };
}

/** P1 — the headline mark: what happened each week against what was expected. */
function weekSection(ctx, id, p) {
  const sw = seasonWeekly(ctx, id);
  if (!sw) {
    return `<h3 class="sub">Week by week</h3>
      ${empty("No games yet", "Week-by-week points appear here after the first Sunday.")}`;
  }
  return `<h3 class="sub">Week by week</h3>
    ${weekStrip({
      weeks: sw.weeks, actual: sw.actual, projected: projFor(ctx, id, sw.weeks),
      byeWeeks: byeWeeksOf(ctx, p), dnpWeeks: sw.dnp, currentWeek: Number(ctx.week) || undefined,
      name: p.name, act: "mv-twin", id: `week-${id}`, uid: `wk-${id}`,
    })}`;
}

/** P3 — the schedule ahead. Aligned cell-for-cell with P1 above it: same 20-unit pitch. */
function matchupSection(ctx, svc, id, p) {
  const fn = svcFn(svc, "matchupGrade");
  if (!fn) return "";
  const weeks = aheadWeeks(ctx);
  const grades = weeks.map((w) => safe(() => fn(ctx, id, w)));
  if (!grades.some((g) => g && Number.isFinite(Number(g.bin)))) {
    return `<h3 class="sub">The schedule ahead</h3>
      <p class="note">The remaining schedule is not graded yet.</p>`;
  }
  return `<h3 class="sub">The schedule ahead</h3>
    ${matchupNextChips(weeks, grades)}
    ${matchupStrip({
      weeks, grades, byeWeeks: byeWeeksOf(ctx, p), currentWeek: Number(ctx.week) || undefined,
      name: p.name, act: "mv-twin", id: `mg-${id}`, uid: `mg-${id}`,
    })}`;
}

/** P2 — is the role growing? Two series here (never in a row), with both numbers printed. */
function usageSection(ctx, svc, id) {
  const fn = svcFn(svc, "usageOf");
  const u = fn ? safe(() => fn(ctx, id)) : null;
  if (!u || !Array.isArray(u.weeks) || !u.weeks.length) return "";
  const snap = Array.isArray(u.snapShare) ? u.snapShare : [];
  const tgt = Array.isArray(u.targetShare) ? u.targetShare : [];
  const spark = usageSparkline({
    weeks: u.weeks, values: snap.some((v) => v != null) ? snap : tgt,
    second: snap.some((v) => v != null) ? tgt : null,
    kind: snap.some((v) => v != null) ? "snap share" : "target share of team pass attempts",
    secondKind: "target share of team pass attempts",
    partialWeeks: u.partialWeeks, uid: `us-${id}`,
  });
  if (!spark) return "";
  const last = (xs) => { for (let i = xs.length - 1; i >= 0; i -= 1) if (xs[i] != null) return xs[i]; return null; };
  const trend = (t) => (t && t.real ? ` <span class="dim">(${t.slope > 0 ? "rising" : "falling"} over ${t.weeks} weeks)</span>` : "");
  return `<h3 class="sub">Role</h3>
    ${spark}
    <p class="mv-peak"><b class="num">${escapeHtml(pct01(last(snap)))}</b> of snaps${trend(u.trend && u.trend.snap)}
      · <b class="num">${escapeHtml(pct01(last(tgt)))}</b> of team targets${trend(u.trend && u.trend.tgt)}</p>`;
}

/**
 * P4 — the prognosis made temporal. `availability(ctx, id, week, absence)` (injuries.js:330) is
 * already the exact curve this draws, so the UI derives nothing: it asks the engine once per week
 * and renders the answer. Absent engine ⇒ absent block, never a flat 100 %.
 */
function availabilitySection(ctx, svc, id) {
  const availFn = svcFn(svc, "availability");
  const absFn = svcFn(svc, "dossierPrognosis") || svcFn(svc, "absenceOf");
  if (!availFn || !absFn) return "";
  const absence = safe(() => absFn(ctx, id));
  if (!absence || !Array.isArray(absence.branches) || !absence.branches.length) return "";
  const weeks = aheadWeeks(ctx);
  const ps = weeks.map((w) => {
    const v = safe(() => availFn(ctx, id, w, absence));
    return Number.isFinite(Number(v)) ? Number(v) : null;
  });
  if (!ps.some((v) => v != null) || ps.every((v) => v === 1)) return "";
  let missed = 0;
  for (const p of ps) if (p != null) missed += 1 - p;
  return availabilityBar({ weeks, pAvailable: ps, expectedMissed: missed });
}

/**
 * P8 — claims plus dated sources. The slice is `ctx.dossiers`, the full report is fetched lazily
 * and only when a slice exists (R11 §Q11.3: the full file is never part of the cold start).
 */
function dossierSection(ctx, svc, id) {
  const slice = ctx.dossiers && typeof ctx.dossiers.get === "function" ? ctx.dossiers.get(id) : null;
  const prog = svcFn(svc, "dossierPrognosis") ? safe(() => svc.dossierPrognosis(ctx, id)) : null;
  if (!slice && !(prog && prog.source === "dossier")) return "";
  const withStale = slice ? { ...slice, stale: !!(slice.stale || (prog && prog.stale)) } : null;
  return `<h3 class="sub">What the desk filed</h3>
    <div id="pl-dossier">${dossierCard(withStale, null, { now: ctx.now || Date.now() })}</div>`;
}

/** P7 — handcuff / stack / bye clash / schedule complement. Never for K or DEF (R10 §2.6). */
function synergySection(ctx, svc, id, p, hv) {
  if (p.pos === "K" || p.pos === "DEF") return "";
  let parts = hv && hv.synergy && Array.isArray(hv.synergy.parts) ? hv.synergy.parts : null;
  if (!parts && svcFn(svc, "synergyScore") && ctx.myRosterId != null) {
    const s = safe(() => svc.synergyScore(ctx, ctx.myRosterId, id));
    parts = s && Array.isArray(s.parts) ? s.parts : null;
  }
  if (!parts || !parts.length) return "";
  const named = parts.map((x) => ({
    ...x,
    name: x.name || (x.withId && ctx.players.get(x.withId) ? ctx.players.get(x.withId).name : null),
  }));
  return `<h3 class="sub">Fit with my roster</h3>
    ${synergyBadges(named, { signed: true })}`;
}

/**
 * The research desk, from the phone (R11 §Q11.2). Cloned from the alerts test-push button: one
 * dispatch, one optimistic chip. The chip says the request was ACCEPTED and never that a dossier
 * has arrived — "accepted ≠ delivered" is the lesson the alerts path already paid for.
 */
function researchSection(svc) {
  if (!svcFn(svc, "requestResearch")) return "";
  return `<div class="mv-research">
    <button type="button" class="btn btn-ghost" data-act="research">Research this player</button>
    <span class="mv-rchip" id="pl-rchip" role="status"></span>
  </div>`;
}

/* ---------------------------------------------------------------- the sheet */

/**
 * The value card for one player. Exported because the Deals tab's free-agent rows open the
 * same sheet; `e` lets a caller pass its own env when Players has never been mounted.
 *
 * Section order is R12's tab map, and it is not arbitrary: identity, then the three KPI tiles,
 * then the market-against-model bullet the first tile begs for, then what actually happened week
 * by week, then what is coming, then why (role), then the risk it carries, then the evidence,
 * then the fit — and only then the source and market tables that were already here.
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

  // §13.5 D4: what this player's week actually looks like — the spread, not just the mean.
  const pr = typeof svc.playerRisk === "function" ? safe(() => svc.playerRisk(ctx, id)) : null;
  const hist = typeof svc.historyOf === "function" ? safe(() => svc.historyOf(ctx, id)) : null;
  const value = valueSection(ctx, svc, id, mv);

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
      <div class="kpi"><span class="kpi-k">Consensus value</span><span class="kpi-v big">${mv.m != null ? fmtFull(mv.m) : "—"}</span></div>
      <div class="kpi"><span class="kpi-k">Rest of season</span><span class="kpi-v num">${pw != null ? fmtNum(pw) : "—"}</span><span class="kpi-u">pts/wk</span></div>
      <div class="kpi"><span class="kpi-k">30-day trend</span><span class="kpi-v">${trendArrow(mv.trend)}</span></div>
    </div>

    ${mv.m == null ? `<p class="note note-warn">No market value: kickers and defenses are not priced by any trade source, so they never carry a verdict.</p>` : ""}
    ${rosterPctWarning(mv)}

    ${value.html}
    ${weekSection(ctx, id, p)}
    ${matchupSection(ctx, svc, id, p)}
    ${usageSection(ctx, svc, id)}

    ${pr ? `<h3 class="sub">Risk ${bandChip(pr.band)}</h3>
    <div class="kpis">
      <div class="kpi"><span class="kpi-k">Floor <span class="dim">p20</span></span><span class="kpi-v num">${fmtNum(pr.floor)}</span><span class="kpi-u">pts/wk</span></div>
      <div class="kpi"><span class="kpi-k">Mean</span><span class="kpi-v num">${fmtNum(pr.mean)}</span><span class="kpi-u">pts/wk</span></div>
      <div class="kpi"><span class="kpi-k">Ceiling <span class="dim">p80</span></span><span class="kpi-v num">${fmtNum(pr.ceiling)}</span><span class="kpi-u">pts/wk</span></div>
    </div>
    ${availabilitySection(ctx, svc, id)}
    <table class="mini"><tbody>
      <tr><th scope="row">Durability</th><td class="num">${pct01(pr.durability)}</td></tr>
      <tr><th scope="row">Available now</th><td class="num">${pct01(pr.availabilityNow)}</td></tr>
      <tr><th scope="row">Available rest of season</th><td class="num">${pct01(pr.rosAvailability)}</td></tr>
      <tr><th scope="row">Weekly swing</th><td class="num">${pct01(pr.volatility)}</td></tr>
      ${hist && hist.gp != null ? `<tr><th scope="row">${escapeHtml(String(hist.season || "last season"))} games played</th><td class="num">${hist.gp}${hist.ga != null ? ` of ${hist.ga}` : ""}</td></tr>` : ""}
    </tbody></table>
    ${(pr.reasons || []).length ? `<ul class="reasons risk-notes">${(pr.reasons || []).slice(0, 3).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}` : ""}

    ${dossierSection(ctx, svc, id)}
    ${synergySection(ctx, svc, id, p, value.hv)}
    ${researchSection(svc)}

    <details class="mv-live" id="pl-live">
      <summary>Every stat, week by week</summary>
      <div id="pl-live-body"><p class="note">Loading the live stat line…</p></div>
    </details>

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

  openSheet({
    title: p.name,
    body,
    onMount(el) {
      el.addEventListener("click", (ev) => onSheetClick(ev, el, id, p, svc, ctx));
      loadLiveStats(el, id, ctx);
    },
  });
}

/* ---------------------------------------------------------------- sheet events */

function onSheetClick(ev, el, id, p, svc, ctx) {
  const t = ev.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "mv-twin") { ev.preventDefault(); openTwin(t, p.name); return; }
  if (t.dataset.act === "research") { ev.preventDefault(); requestResearch(el, t, id, p, svc, ctx); }
}

/** One tap on a strip opens the numbers it could not print (R12 §R7, §R10). */
function openTwin(button, name) {
  const src = button.parentElement && button.parentElement.querySelector(".mv-twin-src");
  if (!src) return;
  openSheet({ title: name || "Week by week", body: `<div class="psheet">${src.innerHTML}</div>` });
}

/**
 * Ask the desk for a report (R11 §Q11.2 steps 1–4). The chip is optimistic about DELIVERY of the
 * request and silent about the answer: it says GitHub accepted the dispatch, never that a dossier
 * is on its way or when it will land. A refusal prints the reason the service gave, verbatim.
 */
async function requestResearch(el, button, id, p, svc, ctx) {
  const chip = el.querySelector("#pl-rchip");
  const sk = typeof svc.statusKey === "function" ? safe(() => svc.statusKey(p)) : null;
  button.disabled = true;
  if (chip) { chip.dataset.tone = ""; chip.textContent = "Asking…"; }
  try {
    const res = await Promise.resolve(svc.requestResearch(id, { depth: "deep", sk }));
    if (res && res.ok) {
      if (chip) { chip.dataset.tone = ""; chip.textContent = "Queued — the desk picks it up when it is next awake."; }
      toast("Research queued.");
    } else {
      button.disabled = false;
      const why = (res && res.reason) || "GitHub refused the request.";
      if (chip) { chip.dataset.tone = "loss"; chip.textContent = why; }
    }
  } catch (err) {
    console.warn("[players] research request failed", err);
    button.disabled = false;
    if (chip) { chip.dataset.tone = "loss"; chip.textContent = "Could not reach GitHub."; }
  }
}

/* ---------------------------------------------------------------- live stat line */

const STAT_LABELS = {
  pts_half_ppr: "Points (half PPR)", pts_ppr: "Points (PPR)", pts_std: "Points (standard)",
  off_snp: "Offensive snaps", tm_off_snp: "Team offensive snaps",
  rec: "Receptions", rec_tgt: "Targets", rec_yd: "Receiving yards", rec_td: "Receiving TDs",
  rec_rz_tgt: "Red-zone targets", rec_ypr: "Yards per reception",
  rush_att: "Carries", rush_yd: "Rushing yards", rush_td: "Rushing TDs", rush_rz_att: "Red-zone carries",
  pass_att: "Attempts", pass_cmp: "Completions", pass_yd: "Passing yards", pass_td: "Passing TDs",
  pass_int: "Interceptions", pass_rz_att: "Red-zone attempts",
  gp: "Games played", gms_active: "Games active", fum_lost: "Fumbles lost",
};
/** The rows worth a phone's width, in reading order. Anything else stays in the API. */
const STAT_ORDER = [
  "pts_half_ppr", "off_snp", "tm_off_snp", "rec_tgt", "rec", "rec_yd", "rec_td", "rec_rz_tgt",
  "rush_att", "rush_yd", "rush_td", "rush_rz_att", "pass_att", "pass_cmp", "pass_yd", "pass_td",
  "pass_int", "fum_lost",
];

/**
 * The full weekly stat line, live from Sleeper (004 design §2.7). It is a disclosure, not the
 * sheet: the fetch is fired after the sheet is already on screen, its failure prints one honest
 * line, and nothing above it waits on the answer. Sleeper serves `Access-Control-Allow-Origin: *`
 * on this route, and the cache-buster is the same one the rest of the app uses for live reads.
 */
async function loadLiveStats(el, id, ctx) {
  const host = el.querySelector("#pl-live-body");
  if (!host) return;
  const season = String(ctx.season || "");
  if (!season) { host.innerHTML = `<p class="note">No season is set, so there is no stat line to fetch.</p>`; return; }
  const url = `${SLEEPER.base}/stats/nfl/player/${encodeURIComponent(id)}`
    + `?season_type=regular&season=${encodeURIComponent(season)}&grouping=week&cb=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    host.innerHTML = liveTable(json, season);
  } catch (err) {
    console.warn("[players] live stats unavailable", err);
    host.innerHTML = `<p class="note">Live stats unavailable — the rest of this card is unaffected.</p>`;
  }
}

/** `{ "1": { stats: {...} }, "2": null, … }` → one `.mini` table, weeks as columns. */
export function liveTable(json, season) {
  if (!json || typeof json !== "object") return `<p class="note">Live stats unavailable.</p>`;
  const weeks = Object.keys(json)
    .filter((k) => /^\d+$/.test(k) && json[k] && json[k].stats)
    .map(Number).sort((a, b) => a - b);
  if (!weeks.length) return `<p class="note">No weekly stat line yet for ${escapeHtml(String(season))}.</p>`;
  const present = STAT_ORDER.filter((k) => weeks.some((w) => Number.isFinite(Number(json[w].stats[k]))));
  if (!present.length) return `<p class="note">The stat line came back empty.</p>`;
  const num = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 10) / 10) : "—");
  return `<table class="mini mv-twin"><caption>Live from Sleeper, ${escapeHtml(String(season))}</caption>
    <thead><tr><th scope="col">Stat</th>${weeks.map((w) => `<th scope="col" class="mv-r num">${w}</th>`).join("")}</tr></thead>
    <tbody>${present.map((k) => `<tr><th scope="row">${escapeHtml(STAT_LABELS[k] || k)}</th>${
      weeks.map((w) => `<td class="num">${escapeHtml(num(json[w].stats[k]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
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
