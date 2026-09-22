// Tradewinds — the season map (004 design §4, R9 §Q9.5). A LEAGUE SECTION, never a tab:
// `styles.css:834` states that six tabs already leave 65 px each at 390 px, so a seventh is not
// available and every season-level view has to live inside a tab that exists.
//
// The honest message this section is built around, and the reason the summary leads with expected
// wins rather than a weekly percentage: P(win) is compressed into roughly 0.45–0.75 because
// σ_margin ≈ 29 dwarfs any realistic weekly edge. Nothing the engine can do to a lineup moves a
// single week by more than about 10 percentage points (R9 §Q9.5). The section says that out loud
// rather than letting a 52 % bar imply a decision.
//
// Split in two, deliberately: `seasonSection()` is a pure `(map, opts) -> string` that any test
// can call with a synthetic SeasonMap, and `mountSeason()` is the only part that touches the
// store, the clock or the network.

import { store, setIn } from "./store.js";
import { empty } from "./components.js";
import { seasonMap as seasonMapMark, pctSafe } from "./sparkline.js";
import { escapeHtml, fmtNum, fmtPts, clip } from "./format.js";

/** R9 §Q9.5: derived from the measured σ_margin, not from round numbers. */
export const STRONG = 0.60;
export const WEAK = 0.40;

/** The disclosure the feature owes the reader, quoted once and never softened. */
export const ELASTICITY_NOTE =
  "Nothing the engine can do to a lineup moves a single week by more than about 10 percentage points.";

const OBJECTIVES = [
  { key: "bye", label: "Play for the bye" },
  { key: "title", label: "Play for the title" },
];

function fin(v, d = null) {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function strengthOf(pWin) {
  const p = fin(pWin);
  if (p == null) return "unknown";
  if (p >= STRONG) return "strong";
  if (p <= WEAK) return "weak";
  return "even";
}

const STRENGTH_TONE = { strong: "win", even: "even", weak: "loss", unknown: "even" };
const STRENGTH_WORD = { strong: "favoured", even: "a coin flip", weak: "against you", unknown: "unknown" };

const CAUSE_WORD = {
  bye: "on a bye", injury: "injured", suspension: "suspended",
  empty: "nobody rostered", thin: "thin",
};

const KIND_WORD = {
  stream: "stream", "short-add": "short add", "season-add": "season add", trade: "trade",
};

/* ---------------------------------------------------------------- pure render */

/**
 * The whole section, from a SeasonMap.
 *
 * @param {{weeks:object[], summary:object}|null} map
 * @param {object} [opts]
 * @param {number} [opts.week]        the current week, for the "now" ring and card emphasis
 * @param {string} [opts.objective]   "bye" | "title"
 * @param {string} [opts.status]      "idle" | "loading" | "ready" | "unavailable"
 * @param {string} [opts.error]
 * @param {(id:string)=>string} [opts.nameOf] player id → display name
 * @returns {string}
 */
export function seasonSection(map, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const objective = o.objective === "title" ? "title" : "bye";
  const head = `<div class="season-head"><h2>Season map</h2>${objectiveToggle(objective)}</div>`;

  if (o.status === "loading") {
    return `<section class="sec season">${head}
      <p class="season-note" role="status">Loading the league schedule…</p></section>`;
  }
  if (o.error) {
    return `<section class="sec season">${head}
      <p class="note note-warn">${escapeHtml(String(o.error))}</p></section>`;
  }
  const cards = map && Array.isArray(map.weeks) ? map.weeks.filter(Boolean) : [];
  if (!cards.length) {
    return `<section class="sec season">${head}
      ${empty("No schedule yet", "Weekly matchups appear once the league schedule is published.")}
      </section>`;
  }

  const week = fin(o.week);
  const nameOf = typeof o.nameOf === "function" ? o.nameOf : (id) => String(id ?? "");
  return `<section class="sec season">
    ${head}
    ${summaryBlock(map.summary, objective)}
    ${seasonMapMark({ cards, currentWeek: week ?? undefined, act: "season-twin", id: "season", uid: "season" })}
    <p class="season-note">${escapeHtml(ELASTICITY_NOTE)}</p>
    <ul class="wcards">${cards.map((c) => weekCard(c, { week, objective, nameOf })).join("")}</ul>
    ${diagnoseLine(map.summary)}
  </section>`;
}

function objectiveToggle(objective) {
  return `<div class="season-obj" role="group" aria-label="What the season map is optimising for">
    ${OBJECTIVES.map((x) => `<button type="button" class="btn btn-ghost" data-act="season-obj"
      data-obj="${x.key}" aria-pressed="${x.key === objective}">${escapeHtml(x.label)}</button>`).join("")}
  </div>`;
}

/**
 * Expected wins and the odds first, the weekly percentage second — R9 §Q9.5 is explicit that a
 * per-week number always looks like a coin flip and would mislead if it led.
 */
function summaryBlock(summary, objective) {
  const s = summary && typeof summary === "object" ? summary : null;
  if (!s) return "";
  const ew = s.expectedWins || {};
  const odds = objective === "title"
    ? [["Title", s.titleOdds], ["Top seed", s.topSeedOdds], ["Playoffs", s.playoffOdds]]
    : [["First-round bye", s.firstRoundByeOdds], ["Playoffs", s.playoffOdds], ["Title", s.titleOdds]];
  const tiles = [
    ew.record ? `<div class="kpi"><span class="kpi-k">Projected record</span>
      <span class="kpi-v">${escapeHtml(String(ew.record))}</span></div>` : "",
    ...odds.filter(([, v]) => fin(v) != null).map(([k, v]) => `<div class="kpi">
      <span class="kpi-k">${escapeHtml(k)}</span><span class="kpi-v num">${escapeHtml(pctSafe(v))}</span></div>`),
  ].filter(Boolean);

  const weak = Array.isArray(s.weakest) ? s.weakest.slice(0, 3) : [];
  const strong = Array.isArray(s.strongest) ? s.strongest.slice(0, 3) : [];
  const wk = (list) => list.map((x) => `wk ${x.week} (${pctSafe(x.pWin)})`).join(", ");

  return `${tiles.length ? `<div class="kpis season-sum">${tiles.join("")}</div>` : ""}
    ${s.objectiveAdvice ? `<p class="season-note">${escapeHtml(String(s.objectiveAdvice))}</p>` : ""}
    ${weak.length || strong.length ? `<p class="season-note">${
      strong.length ? `Strongest ${escapeHtml(wk(strong))}.` : ""}${strong.length && weak.length ? " " : ""}${
      weak.length ? `Weakest ${escapeHtml(wk(weak))}.` : ""}</p>` : ""}`;
}

/**
 * One week. Opponent, the two means, P(win) with its strength class, the holes WITH THEIR CAUSE
 * (a bye and a torn ACL are the same zero to a lineup optimiser and nothing like each other to a
 * manager), and the top three moves ranked by equity — never by points per week (R9 §Q9.5).
 */
export function weekCard(card, opts = {}) {
  const c = card && typeof card === "object" ? card : null;
  if (!c) return "";
  const week = fin(c.week);
  const now = fin(opts.week);
  const isNow = week != null && now != null && week === now;
  const strength = c.strength || strengthOf(c.pWin);
  const mine = fin(c.me && c.me.mean);
  const them = fin(c.opp && c.opp.mean);
  const nameOf = typeof opts.nameOf === "function" ? opts.nameOf : (id) => String(id ?? "");

  return `<li class="wcard${isNow ? " wcard-is-now" : ""}">
    <p class="wcard-h">
      <span class="wcard-w">wk ${escapeHtml(String(week ?? "—"))}${c.isPlayoffWeek ? " <span class=\"dim\">playoff</span>" : ""}</span>
      <span class="wcard-opp">${escapeHtml(clip((c.opp && c.opp.teamName) || "opponent unknown", 22))}</span>
    </p>
    <p class="wcard-mu">μ <b class="num">${escapeHtml(mine == null ? "—" : fmtNum(mine))}</b>
      against <b class="num">${escapeHtml(them == null ? "—" : fmtNum(them))}</b>
      · <b class="num" data-tone="${STRENGTH_TONE[strength] || "even"}">${escapeHtml(pctSafe(c.pWin))}</b>
      ${escapeHtml(STRENGTH_WORD[strength] || "")}${
      c.scheduleIsProvisional ? ' <span class="dim">· opponent provisional</span>' : ""}</p>
    ${holesLine(c.holes, nameOf)}
    ${movesList(c.moves, opts.objective, nameOf)}
  </li>`;
}

function holesLine(holes, nameOf) {
  const list = Array.isArray(holes) ? holes.filter(Boolean) : [];
  if (!list.length) return "";
  const bits = list.slice(0, 4).map((h) => {
    const who = h.playerId ? nameOf(h.playerId) : null;
    const cause = CAUSE_WORD[h.cause] || h.cause || "open";
    const span = Array.isArray(h.weeks) && h.weeks.length > 1 ? ` for ${h.weeks.length} weeks` : "";
    return `${h.slot || "FLEX"} — ${who ? `${who} ` : ""}${cause}${span}`;
  });
  return `<p class="wcard-holes">Holes: ${escapeHtml(bits.join(" · "))}</p>`;
}

/**
 * The moves, ranked by the manager's own unit. R9 §Q9.5 is blunt about this: the same +3 pts/wk
 * is worth 0.028 pp of title in week 6 and 0.289 pp in week 16, so `winEquity` / `titleEquity`
 * leads the line and `pointsPerWeek` follows it as context.
 */
function movesList(moves, objective, nameOf) {
  const list = Array.isArray(moves) ? moves.filter(Boolean) : [];
  if (!list.length) return "";
  const useTitle = objective === "title";
  const equity = (m) => fin(useTitle ? (m.titleEquity ?? m.winEquity) : m.winEquity);
  const top = [...list].sort((a, b) => (equity(b) ?? -Infinity) - (equity(a) ?? -Infinity)).slice(0, 3);
  return `<ul class="wcard-moves">${top.map((m) => {
    const eq = equity(m);
    const add = m.addId ? nameOf(m.addId) : "a free agent";
    const drop = m.dropId ? nameOf(m.dropId) : (m.cost && m.cost.drop && m.cost.drop.name) || null;
    const faab = fin(m.cost && m.cost.faab);
    const weeks = Array.isArray(m.weeksCovered) ? m.weeksCovered.length : null;
    const cost = [
      faab != null ? `$${Math.round(faab)} FAAB` : "",
      drop ? `drop ${clip(String(drop), 16)}` : "",
      weeks ? `covers ${weeks} week${weeks === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" · ");
    return `<li><b>${escapeHtml(KIND_WORD[m.kind] || m.kind || "move")}</b> ${escapeHtml(clip(String(add), 20))}
      ${eq != null ? `<b class="num" data-tone="${eq > 0 ? "win" : eq < 0 ? "loss" : "even"}">${
        escapeHtml(fmtPts(eq * 100))} pp</b> ${useTitle ? "title" : "win"}` : ""}
      ${fin(m.pointsPerWeek) != null ? `<span class="wcard-eq">· ${escapeHtml(fmtPts(m.pointsPerWeek))} pts/wk</span>` : ""}
      ${cost ? `<span class="wcard-eq">· ${escapeHtml(cost)}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

/**
 * The Diagnose line. σ is the number every P(win) on this page rests on, so it is stated with its
 * sample size and its provenance rather than buried — the same standard the Diagnose sheet holds
 * every other engine constant to.
 */
export function diagnoseLine(summary) {
  const cal = summary && summary.sigmaCalibration;
  if (!cal) return "";
  const sd = fin(cal.sigmaTeam);
  const ci = Array.isArray(cal.ci95) ? cal.ci95.map((x) => fmtNum(x)).join("–") : null;
  const bits = [
    sd != null ? `σ per team ${fmtNum(sd)} pts` : "",
    ci ? `95 % CI ${ci}` : "",
    fin(cal.n) != null ? `n ${fin(cal.n)}` : "",
    cal.source ? String(cal.source) : "",
    cal.model ? `model ${cal.model}` : "",
  ].filter(Boolean);
  if (!bits.length) return "";
  return `<p class="season-note">Diagnose: ${escapeHtml(bits.join(" · "))}. ${escapeHtml(ELASTICITY_NOTE)}</p>`;
}

/* ---------------------------------------------------------------- mount */

/** The objective lives in settings when the data layer will take it, and in the store always. */
export function currentObjective() {
  const fromStore = store.league && store.league.seasonObjective;
  if (fromStore === "bye" || fromStore === "title") return fromStore;
  const s = store.settings && store.settings.seasonMap && store.settings.seasonMap.objective;
  return s === "title" ? "title" : "bye";
}

let gen = 0;

/**
 * Render the section into `host` and, the first time, go and fetch the league schedule.
 *
 * The schedule is the one genuinely new input (R9 §Q9.5): weeks `ctx.week..17` of
 * `/league/{id}/matchups/{w}` plus `/winners_bracket`. That is fifteen requests, so it is fetched
 * ONCE per session and cached on the store; `gen` abandons an in-flight load if the view is torn
 * down under it. Every failure degrades to a sentence, never to a blank or a guess.
 */
export function mountSeason(host, env) {
  if (!host) return;
  const svc = env && env.svc;
  const ctx = store.ctx;
  if (!svc || !ctx || ctx.myRosterId == null) { host.innerHTML = ""; return; }
  if (typeof svc.seasonMap !== "function") { host.innerHTML = ""; return; }

  const lg = store.league || {};
  if (lg.seasonStatus === "ready" || lg.seasonStatus === "unavailable" || lg.seasonStatus === "error") {
    host.innerHTML = renderFromStore(ctx);
    return;
  }
  if (lg.seasonStatus === "loading") { host.innerHTML = seasonSection(null, { status: "loading" }); return; }

  host.innerHTML = seasonSection(null, { status: "loading" });
  gen += 1;
  const token = gen;
  loadSchedule(svc, ctx).then((schedule) => {
    if (token !== gen) return;
    let map = null;
    try {
      map = svc.seasonMap(ctx, { schedule, objective: currentObjective() });
    } catch (err) {
      console.warn("[season] seasonMap failed", err);
    }
    setIn("league", {
      seasonSchedule: schedule,
      seasonMapData: map,
      seasonStatus: map && Array.isArray(map.weeks) && map.weeks.length ? "ready" : "unavailable",
      seasonError: null,
    });
    if (host.isConnected) host.innerHTML = renderFromStore(ctx);
  }).catch((err) => {
    if (token !== gen) return;
    console.warn("[season] schedule load failed", err);
    setIn("league", { seasonStatus: "error", seasonError: "The league schedule could not be loaded, so the season map is unavailable." });
    if (host.isConnected) host.innerHTML = renderFromStore(ctx);
  });
}

function renderFromStore(ctx) {
  const lg = store.league || {};
  return seasonSection(lg.seasonMapData || null, {
    week: ctx.week,
    objective: currentObjective(),
    status: lg.seasonStatus,
    error: lg.seasonError || null,
    nameOf: (id) => {
      const p = ctx.players && typeof ctx.players.get === "function" ? ctx.players.get(id) : null;
      return p ? p.name : String(id ?? "");
    },
  });
}

/**
 * `schedule` per R9 §Q9.5. `getMatchups`/`getWinnersBracket` are Phase-0 stand-ins that resolve
 * to `[]`, which is why every derived field is built defensively: an empty answer yields an empty
 * `byWeek`, which yields an empty map, which the section states as "no schedule yet".
 */
export async function loadSchedule(svc, ctx) {
  setIn("league", { seasonStatus: "loading" });
  const leagueId = (ctx.league && ctx.league.leagueId) || (store.settings && store.settings.leagueId) || null;
  const from = Number(ctx.week) || 1;
  const to = Number(ctx.lastWeek) || 17;
  const byWeek = {};
  if (typeof svc.getMatchups === "function" && leagueId) {
    const weeks = [];
    for (let w = from; w <= to; w += 1) weeks.push(w);
    const answers = await Promise.all(weeks.map(async (w) => {
      try { return [w, await svc.getMatchups(leagueId, w)]; } catch { return [w, null]; }
    }));
    for (const [w, rows] of answers) {
      const pairs = pairUp(rows);
      if (pairs) byWeek[w] = pairs;
    }
  }
  let bracket = null;
  if (typeof svc.getWinnersBracket === "function" && leagueId) {
    try {
      const rounds = await svc.getWinnersBracket(leagueId);
      if (Array.isArray(rounds) && rounds.length) bracket = { provisional: true, asOfWeek: from, rounds };
    } catch { bracket = null; }
  }
  return {
    byWeek,
    playoffWeeks: Array.isArray(ctx.playoffWeeks) ? ctx.playoffWeeks : [],
    bracket,
    source: "sleeper:/matchups",
    pulledAt: new Date(Number(ctx.now) || Date.now()).toISOString(),
  };
}

/**
 * `/matchups/{w}` returns one row per roster carrying a shared `matchup_id`; the schedule wants
 * `rosterId -> opponentRosterId`. A row with no `matchup_id` is a bye or an unscheduled week and
 * is simply absent from the answer, never paired with itself.
 * @returns {Object<string, number>|null}
 */
export function pairUp(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const groups = new Map();
  for (const r of rows) {
    const m = r && (r.matchup_id ?? r.matchupId);
    const rid = r && (r.roster_id ?? r.rosterId);
    if (m == null || rid == null) continue;
    const key = String(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(rid));
  }
  const out = {};
  for (const ids of groups.values()) {
    if (ids.length !== 2) continue;
    out[ids[0]] = ids[1];
    out[ids[1]] = ids[0];
  }
  return Object.keys(out).length ? out : null;
}

/* ---------------------------------------------------------------- events */

/**
 * @returns {boolean} true when the click belonged to this section, so League can stop.
 */
export function seasonClick(e, env) {
  const t = e.target.closest("[data-act]");
  if (!t) return false;
  if (t.dataset.act === "season-obj") {
    e.preventDefault();
    setObjective(t.dataset.obj, env);
    return true;
  }
  if (t.dataset.act === "season-twin") {
    e.preventDefault();
    const src = t.parentElement && t.parentElement.querySelector(".mv-twin-src");
    if (src) {
      // imported lazily to keep this module free of a components<->season cycle
      import("./components.js").then(({ openSheet }) => {
        openSheet({ title: "Season map", body: `<div class="psheet">${src.innerHTML}</div>` });
      });
    }
    return true;
  }
  return false;
}

/**
 * Bye or title. It is written to settings when the data layer accepts it (`saveSettings` deep
 * merges, so an unknown key is additive and harmless) and to the store either way, because the
 * store is what the next paint reads.
 */
export function setObjective(objective, env) {
  const next = objective === "title" ? "title" : "bye";
  const svc = env && env.svc;
  if (svc && typeof svc.saveSettings === "function") {
    try {
      const saved = svc.saveSettings({ seasonMap: { objective: next } });
      if (saved && typeof saved === "object") store.settings = saved;
    } catch (err) {
      console.warn("[season] objective not saved", err);
    }
  }
  const ctx = store.ctx;
  let map = store.league && store.league.seasonMapData;
  if (svc && typeof svc.seasonMap === "function" && ctx && store.league && store.league.seasonSchedule) {
    try {
      map = svc.seasonMap(ctx, { schedule: store.league.seasonSchedule, objective: next });
    } catch (err) {
      console.warn("[season] re-rank failed", err);
    }
  }
  setIn("league", { seasonObjective: next, seasonMapData: map });
  const host = document.getElementById("lg-season");
  if (host && ctx) host.innerHTML = renderFromStore(ctx);
}
