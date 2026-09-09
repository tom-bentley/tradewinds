// Tradewinds — first-run onboarding (design §10.5). No league is baked into the build, so this
// screen is the app's front door: Sleeper username -> the leagues that user plays in this season
// -> tap one to save it and boot. A second path takes a bare league id and opens the league in
// viewer mode (no "me", no second person anywhere downstream).
//
// It is not a tab: app.js mounts it directly when `loadAll` throws SetupRequiredError, and calls
// `env.boot()` again once a league is saved.

import { store, setIn } from "./store.js";
import { toast } from "./components.js";
import { escapeHtml, qbLabel, pprLabel } from "./format.js";
import { APP_NAME } from "../config.js";

export const title = "Set up";

let env = null;

export function mount(el, e) {
  env = e;
  el.innerHTML = render();
  el.addEventListener("submit", onSubmit);
  el.addEventListener("click", onClick);
  focusFirst(el);
  return { destroy() {} };
}

function focusFirst(el) {
  const input = el.querySelector("#su-user");
  // Only steal focus when the field is empty — a re-render mid-typing must not reset the caret.
  if (input && !input.value) setTimeout(() => input.focus(), 60);
}

/* ---------------------------------------------------------------- render */

function season() {
  return String(store.setup.season || store.settings?.season || new Date().getFullYear());
}

function render() {
  const s = store.setup;
  const busy = s.status === "looking";
  return `<div class="setup">
    <div class="setup-hero">
      ${mark(38)}
      <h1 class="setup-t">${escapeHtml(APP_NAME)}</h1>
      <p class="setup-b">Grade any trade in your Sleeper league — values, lineup impact and whether
        the other manager would say yes. Point it at a league to begin.</p>
    </div>

    <form class="card setup-card" id="su-form" novalidate>
      <label class="fld" for="su-user"><span>Sleeper username</span>
        <input type="text" id="su-user" name="username" value="${escapeHtml(s.username || "")}"
          placeholder="tommyteez" autocapitalize="none" autocorrect="off" autocomplete="username"
          spellcheck="false" enterkeyhint="go" ${busy ? "disabled" : ""}></label>
      <button type="submit" class="btn" ${busy ? "disabled" : ""}>${busy ? "Looking…" : "Find my leagues"}</button>
      <p class="dial-help">Your Sleeper handle, not an email. Nothing is stored anywhere but this phone.</p>
    </form>

    ${s.error ? `<p class="note note-warn setup-err" role="alert">${escapeHtml(s.error)}</p>` : ""}
    <div id="su-leagues">${leagueList(s)}</div>

    <details class="setup-alt"${s.byId ? " open" : ""}>
      <summary>Browse a league by id</summary>
      <form class="card" id="su-idform" novalidate>
        <label class="fld" for="su-league"><span>League id</span>
          <input type="text" id="su-league" name="leagueId" value="${escapeHtml(s.leagueId || "")}"
            placeholder="1394476745138147328" inputmode="numeric" autocomplete="off" spellcheck="false"
            enterkeyhint="go"></label>
        <button type="submit" class="btn btn-ghost">Open read-only</button>
        <p class="dial-help">Viewer mode: no team of your own, so Deals and Analyze start on the
          first team in the league. Add your username later in Settings.</p>
      </form>
    </details>

    <p class="setup-foot">Values from FantasyCalc, DynastyProcess and Boris Chen; rosters from the
      public Sleeper API. No account, no tracking, no cost.</p>
  </div>`;
}

function leagueList(s) {
  if (s.status !== "done" || !s.leagues) return "";
  if (!s.leagues.length) {
    return `<p class="note note-warn" role="alert">No leagues for ${escapeHtml(season())} on that account.</p>`;
  }
  return `<h2 class="view-h setup-h">${s.leagues.length} league${s.leagues.length > 1 ? "s" : ""} for ${escapeHtml(season())}</h2>
    <ul class="lglist">${s.leagues.map((l) => `<li>
      <button type="button" class="lgrow lgrow-set" data-act="pick" data-id="${escapeHtml(l.league_id)}"
        data-name="${escapeHtml(l.name || "")}">
        <span class="lgrow-body">
          <span class="lgrow-n">${escapeHtml(l.name || "Untitled league")}</span>
          <span class="lgrow-s dim">${escapeHtml(shapeOf(l))}</span>
        </span>
        <span class="lgrow-go" aria-hidden="true">›</span>
      </button></li>`).join("")}</ul>`;
}

/** "8 teams · 1QB · PPR 0.5" — the three things that change how a trade is priced. */
function shapeOf(l) {
  const teams = l.total_rosters ?? l.settings?.num_teams;
  const bits = [];
  if (Number.isFinite(Number(teams)) && Number(teams) > 0) bits.push(`${Number(teams)} teams`);
  // Only claim a shape the payload actually carries — "1QB · PPR 0" is a lie about a league
  // whose settings have not been fetched.
  if (l.roster_positions) bits.push(qbLabel(l.roster_positions));
  if (l.scoring_settings) bits.push(pprLabel(l.scoring_settings));
  if (!bits.length) bits.push(String(l.season || ""), l.status || "");
  return bits.filter(Boolean).join(" · ");
}

function mark(size) {
  return `<svg class="mark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke-width="3.2" stroke-linecap="round">
    <path d="M27 12.5A12 12 0 0 0 5.6 10.4" stroke="#2DD4BF"/><path d="M27.4 5.6l.2 7.2-7.1.4" stroke="#2DD4BF"/>
    <path d="M5 19.5a12 12 0 0 0 21.4 2.1" stroke="#F59E0B"/><path d="M4.6 26.4l-.2-7.2 7.1-.4" stroke="#F59E0B"/>
  </svg>`;
}

function repaint() {
  const host = document.getElementById("view");
  const el = host && host.firstElementChild;
  if (el) el.innerHTML = render();
}

/* ---------------------------------------------------------------- events */

async function onSubmit(e) {
  const form = e.target.closest("form");
  if (!form) return;
  e.preventDefault();
  if (form.id === "su-idform") return openById(form);
  if (form.id === "su-form") return lookup(form);
}

async function lookup(form) {
  const username = String(new FormData(form).get("username") || "").trim();
  if (!username) {
    setIn("setup", { error: "Type your Sleeper username first." });
    repaint();
    return;
  }
  if (!env.svc.lookupUser || !env.svc.listLeagues) {
    setIn("setup", { error: "League lookup is not available in this build — open a league by id instead.", byId: true });
    repaint();
    return;
  }
  setIn("setup", { username, status: "looking", error: null, leagues: null });
  repaint();

  let yr = season();
  try {
    // Ask Sleeper which season it is rather than trusting a constant — in January the league
    // list for "this year" is empty and the error would be a lie.
    if (env.svc.getCurrentSeason) {
      try { yr = String(await env.svc.getCurrentSeason()) || yr; } catch { /* keep the default */ }
    }
    const user = await env.svc.lookupUser(username);
    const userId = user && (user.user_id || user.userId);
    if (!userId) throw Object.assign(new Error("not found"), { notFound: true });
    const leagues = await env.svc.listLeagues(userId, yr);
    const rows = Array.isArray(leagues) ? leagues : [];
    setIn("setup", {
      status: "done",
      userId,
      season: yr,
      leagues: rows,
      error: rows.length ? null : `No leagues for ${yr} on that account.`,
    });
    repaint();
    await addShapes(rows);
  } catch (err) {
    setIn("setup", { status: "error", leagues: null, season: yr, error: lookupError(err, username, yr) });
  }
  repaint();
}

/**
 * `listLeagues` returns Sleeper's league summaries, and data.js trims them to id/name/teams —
 * but a manager picks a league by its shape as much as its name, so fill in roster_positions
 * and scoring_settings from `/league/<id>` for any row that arrived without them.
 * Best effort: a row whose league will not load keeps the teams-only label.
 */
async function addShapes(rows) {
  const need = rows.filter((l) => !l.roster_positions || !l.scoring_settings).slice(0, 20);
  if (!need.length || !env.svc.getLeague) return;
  const full = await Promise.allSettled(need.map((l) => env.svc.getLeague(l.league_id)));
  let changed = false;
  full.forEach((r, i) => {
    const league = r.status === "fulfilled" ? r.value : null;
    if (!league) return;
    need[i].roster_positions = league.roster_positions || null;
    need[i].scoring_settings = league.scoring_settings || null;
    need[i].total_rosters = need[i].total_rosters || league.total_rosters;
    changed = true;
  });
  if (changed && store.setup.status === "done") repaint();
}

/** Sleeper answers 404 (or `null`) for an unknown handle; say so in words, not in a status code. */
function lookupError(err, username, yr) {
  const msg = String((err && err.message) || err || "");
  const status = err && err.status;
  if (err?.notFound || status === 404 || /404|not found|no sleeper user/i.test(msg)) {
    return `Username not found — check the spelling of “${username}”.`;
  }
  if (/failed to fetch|network|offline|timed out|timeout/i.test(msg)) {
    return "Could not reach Sleeper. Check the connection and try again.";
  }
  return msg || `Could not look up “${username}”.`;
}

function openById(form) {
  const leagueId = String(new FormData(form).get("leagueId") || "").trim();
  if (!/^\d{6,}$/.test(leagueId)) {
    setIn("setup", { error: "A Sleeper league id is a long run of digits — copy it from the league URL.", byId: true, leagueId });
    repaint();
    return;
  }
  save({ leagueId, userId: null, username: null }, "Opening the league in viewer mode.");
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t || t.dataset.act !== "pick") return;
  const s = store.setup;
  save(
    { leagueId: t.dataset.id, userId: s.userId || null, username: s.username || null },
    `Loading ${t.dataset.name || "your league"}…`
  );
}

function save(patch, message) {
  try {
    env.svc.saveSettings(patch);
  } catch (err) {
    setIn("setup", { error: "Could not save the league on this device: " + (err.message || err) });
    repaint();
    return;
  }
  toast(message, { timeout: 2500 });
  env.boot();
}
