// Tradewinds — Settings tab. League switching, engine dials, source freshness, housekeeping.

import { store, setIn } from "./store.js";
import { icon, toast, avatar, THEMES, currentTheme, setTheme } from "./components.js";
import { escapeHtml, relTime, clockTime, fmtNum, numQbsOf, pprOf } from "./format.js";
import { APP_NAME, APP_VERSION } from "../config.js";
import { MOCK } from "./services.js";

export const title = "Settings";

let env = null;
let saveTimer = null;

const DIALS = [
  { key: "weights.fc_redraft", label: "FantasyCalc weight", min: 0, max: 1, step: 0.05, help: "How much the market price counts in the blend." },
  { key: "weights.proj", label: "Projection weight", min: 0, max: 1, step: 0.05, help: "How much rest-of-season points count." },
  { key: "keeperTilt", label: "Keeper tilt φ", min: 0, max: 0.5, step: 0.01, help: "Dynasty value nudge for the one keeper spot." },
  { key: "rho", label: "Replacement level ρ", min: 0, max: 1.5, step: 0.05, help: "How much of the waiver-replacement value is subtracted. 1.0 is the full shallow-league discount." },
  { key: "playoffWeight", label: "Playoff weight ω", min: 1, max: 3, step: 0.1, help: "How much weeks 15–17 count against the regular season." },
  { key: "finder.perRival", label: "Offers per rival", min: 1, max: 5, step: 1, help: "How many proposals the Deals tab keeps for each team." },
];

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

export function mount(el, e) {
  env = e;
  el.innerHTML = render();
  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  return { destroy() { if (saveTimer) clearTimeout(saveTimer); } };
}

function render() {
  const ctx = store.ctx;
  const s = store.settings || ctx.settings;
  const me = ctx.myRosterId != null ? ctx.rosters.find((r) => r.rosterId === ctx.myRosterId) : null;
  // The three shape numbers the engine actually priced this league with — the value table it
  // picked (1QB vs 2QB) and the tier table (PPR) both hang off them, so they are worth showing.
  const numQbs = ctx.league.numQbs ?? numQbsOf(ctx.league.rosterPositions);
  const ppr = ctx.league.ppr ?? pprOf(ctx.league.scoring);
  const unsupported = ctx.unsupported || [];

  return `<div class="settings">
    <section class="sec">
      <div class="sec-head"><h2>League</h2></div>
      <div class="card">
        <div class="lg-now">${me ? avatar(me, 36) : ""}<div><p class="lg-n">${escapeHtml(ctx.league.name)}</p>
          <p class="lg-m">${me
            ? `${escapeHtml(me.teamName || "")} · ${escapeHtml(s.username || me.displayName || "")}`
            : "Viewer mode — no team of yours in this league"}</p></div></div>
        <table class="mini lg-shape"><tbody>
          <tr><th scope="row">Teams</th><td class="num">${ctx.league.numTeams}</td></tr>
          <tr><th scope="row">Quarterbacks</th><td class="num">${numQbs >= 2 ? "2QB / superflex" : "1QB"}</td></tr>
          <tr><th scope="row">Reception points</th><td class="num">${ppr}</td></tr>
          <tr><th scope="row">Season</th><td class="num">${escapeHtml(String(ctx.season))}</td></tr>
          <tr><th scope="row">League id</th><td class="num dim">${escapeHtml(String(ctx.league.id ?? s.leagueId ?? ""))}</td></tr>
        </tbody></table>
        ${unsupported.length ? `<p class="note note-warn">${escapeHtml(unsupported.join(" and "))} are ignored in lineup math — Tradewinds scores offence only, so an IDP league's starter totals are the offensive half of the lineup.</p>` : ""}
        <div class="btn-col lg-acts">
          <button type="button" class="btn btn-ghost" data-act="switch-league">Switch league</button>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head"><h2>Engine dials</h2><span class="sec-note">changes reload the model</span></div>
      <div class="card dials">
        ${DIALS.map((d) => {
          const v = Number(get(s, d.key) ?? d.min);
          return `<div class="dial">
            <label class="dial-h" for="d-${d.key}"><span class="dial-l">${escapeHtml(d.label)}</span><output class="dial-v num" id="o-${d.key}">${fmtNum(v, d.step >= 1 ? 0 : 2)}</output></label>
            <input type="range" id="d-${d.key}" data-dial="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}">
            <p class="dial-help">${escapeHtml(d.help)}</p>
          </div>`;
        }).join("")}
      </div>
    </section>

    <section class="sec">
      <div class="sec-head"><h2>Data sources</h2></div>
      <table class="mini srcs"><tbody>
        ${Object.entries(ctx.values || {}).map(([k, src]) => `<tr>
          <th scope="row"><i class="dot ${src.ok ? "ok" : "bad"}"></i>${escapeHtml(src.label || k)}</th>
          <td class="num">${src.count ?? "—"}</td>
          <td class="num dim">${escapeHtml(relTime(src.fetched_at))}</td></tr>`).join("")}
        <tr class="mini-sum"><th scope="row">Pipeline build</th><td></td><td class="num dim">${escapeHtml(relTime(ctx.meta?.pipeline))}</td></tr>
        <tr><th scope="row">Live rosters</th><td></td><td class="num dim">${escapeHtml(store.freshness?.live ? clockTime(store.freshness.live) : "—")}</td></tr>
      </tbody></table>
      ${MOCK ? `<p class="note note-warn">Demo mode is on (<code>?mock=1</code>). Every number comes from the committed 2026-09-09 fixtures, not a live league read.</p>` : ""}
    </section>

    <section class="sec">
      <div class="sec-head"><h2>Housekeeping</h2></div>
      <div class="card btn-col">
        <div class="seg" role="group" aria-label="Appearance">
          ${THEMES.map((t) => `<button type="button" class="${currentTheme() === t ? "is-on" : ""}" data-act="theme" data-v="${t}" aria-pressed="${currentTheme() === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
        </div>
        <button type="button" class="btn" data-act="refresh">${icon("refresh")}Refresh data now</button>
        <button type="button" class="btn btn-ghost" data-act="reset">Reset dials to defaults</button>
        <button type="button" class="btn btn-ghost" data-act="clear">Clear cached data</button>
      </div>
    </section>

    <section class="sec">
      <div class="sec-head"><h2>About</h2></div>
      <div class="card about">
        <p><strong>${escapeHtml(APP_NAME)}</strong> ${escapeHtml(APP_VERSION)}${MOCK ? " · demo data" : ""}</p>
        <p>Values blend <strong>FantasyCalc</strong> with a projection-implied curve, checked against
        <strong>DynastyProcess</strong> (GPL-3.0) and <strong>Boris Chen</strong> tiers. Rosters, transactions and
        projections come from the public <strong>Sleeper</strong> API. No accounts, no tracking, no cost.</p>
        <p class="dim">Values are opinions, not oracles. Read the reasons, not just the word.</p>
      </div>
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- events */

function onInput(e) {
  const r = e.target.closest("input[data-dial]");
  if (!r) return;
  const key = r.dataset.dial;
  const step = Number(r.step);
  const out = document.getElementById("o-" + key);
  if (out) out.textContent = fmtNum(Number(r.value), step >= 1 ? 0 : 2);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => applyDials(), 350);
}

function applyDials() {
  const patch = { weights: { ...store.settings.weights }, finder: { ...store.settings.finder } };
  document.querySelectorAll("input[data-dial]").forEach((r) => {
    const [a, b] = r.dataset.dial.split(".");
    if (b) patch[a][b] = Number(r.value);
    else patch[a] = Number(r.value);
  });
  env.svc.saveSettings(patch);
  toast("Dials saved — recalculating.", { timeout: 2200 });
  env.reload();
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;

  if (act === "switch-league") {
    // Forget the league AND the user: onboarding is the one place a league is chosen now.
    env.svc.saveSettings({ leagueId: null, userId: null, username: null });
    setIn("setup", { status: "idle", leagues: null, error: null, userId: null, byId: false, leagueId: "" });
    env.boot();
    return;
  }
  if (act === "theme") { setTheme(t.dataset.v); env.rerender(); return; }
  if (act === "refresh") { env.refresh(); return; }
  if (act === "reset") {
    env.svc.saveSettings({ weights: undefined, keeperTilt: undefined, rho: undefined, playoffWeight: undefined, finder: undefined });
    try { localStorage.removeItem("tradewinds.settings.v1"); } catch { /* ignore */ }
    toast("Dials reset.");
    env.reload({ hard: true });
    return;
  }
  if (act === "clear") {
    if (env.svc.clearCache) {
      Promise.resolve(env.svc.clearCache()).then(() => { toast("Cached data cleared."); env.reload({ hard: true }); });
    } else {
      toast("This build has no local cache to clear.", { tone: "warn" });
    }
  }
}
