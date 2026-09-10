// Tradewinds — the Advisor tab (design §12.5). The first tab and the default route.
//
// Every other tab answers a question the user thought to ask. This one answers the question the
// user did not know to ask yet: Sleeper said Bowers is Doubtful — now what? The whole tab is one
// list of open issues on my roster, each with the numbered moves that follow from the math, and
// under it the news feed the alerts job committed for the league.
//
// Two things happen on mount, in this order and for a reason:
//   1. `refreshStatuses` reads the live injury status of every player I roster. The pipeline's
//      players.json is hours old; an advisory built on it would be advice about yesterday.
//   2. `adviseAll` turns those statuses into cards — standing issues (he is Out and still in my
//      lineup) plus what changed since this device last looked (`prev` → `next` snapshots).
// Both are the engine's and the data layer's work. This file renders and routes, nothing else.

import { store, setIn } from "./store.js";
import {
  icon, skeleton, empty, openSheet, sectionHead, playerThumb, injuryTag, signTone,
} from "./components.js";
import {
  escapeHtml, clockTime, relTime, clip, fmtNum, fmtPts, absencePhrase, whenChipText,
  statusMetaLine, thisWeekLine, headline as headlineText, feedAgeLine,
} from "./format.js";
import { openPlayerSheet } from "./players.js";
import { prefill } from "./analyze.js";

export const title = "Advisor";

/** Moves that are really "go and look at the wire" — they get the Open Deals chip. */
const WIRE_MOVES = new Set(["add", "drop", "hold"]);

/** How an alternatives row's `owner` field renders as a chip. */
const OWNER_CLASS = { mine: "schip-free", free: "schip-open", waivers: "schip-wv" };

let env = null;
let gen = 0; // generation token — a refresh or an unmount abandons an in-flight compute

/* ================================================================== mount */

export function mount(el, e) {
  env = e;
  el.innerHTML = shell();
  el.addEventListener("click", onClick);

  if (store.advisor.status === "idle") start();
  else { paintList(); paintFeed(); }
  return { destroy() { gen += 1; } };
}

const myRosterId = () => {
  const ctx = store.ctx;
  return ctx && ctx.myRosterId != null ? ctx.myRosterId : null;
};

/** My roster plus my reserve: the reserve is exactly where an "activate him" issue hides. */
function watchSet(ctx, rosterId) {
  const roster = (ctx.rosters || []).find((r) => r.rosterId === rosterId);
  if (!roster) return [];
  return [...new Set([...(roster.players || []), ...(roster.reserve || [])])];
}

function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 32);
}

/* ================================================================== compute */

/**
 * Live statuses → events → advisories. Never throws: a failed status read leaves the previous
 * cards on screen with an honest note, because stale advice beats a blank tab.
 */
export async function start() {
  const ctx = store.ctx;
  const me = myRosterId();
  if (!ctx || me == null) {
    // Viewer mode: there is no "my roster" to advise, so the feed is the whole tab (§12.5).
    setIn("advisor", { status: "done", items: [], error: null, unseen: [] });
    paintList();
    paintFeed();
    return;
  }

  gen += 1;
  const token = gen;
  setIn("advisor", { status: "running", error: null });
  paintList();

  // The engine never reads the clock, and its waiver windows need the transaction feed, so both
  // are supplied here — the same contract the Free agents pane works under.
  if (ctx.now == null) ctx.now = Date.now();
  if (!Array.isArray(ctx.transactions) || !ctx.transactions.length) {
    try {
      const out = await env.transactions();
      if (token !== gen) return;
      ctx.transactions = (out && out.txns) || [];
    } catch (err) {
      console.warn("[advisor] transactions unavailable — waiver windows will read as free", err);
      if (!Array.isArray(ctx.transactions)) ctx.transactions = [];
    }
  }

  let refreshed = null;
  try {
    refreshed = await env.svc.refreshStatuses(ctx, watchSet(ctx, me), { concurrency: 6 });
  } catch (err) {
    console.error("[advisor] refreshStatuses failed", err);
    if (token !== gen) return;
    setIn("advisor", {
      status: store.advisor.items.length ? "done" : "error",
      error: String(err && err.message ? err.message : err),
    });
    paintList();
    paintFeed();
    return;
  }
  if (token !== gen) return;

  // The fresh context replaces the shared one: every other tab should grade trades against the
  // injury statuses the phone just read, not the ones the pipeline committed this morning.
  const next = refreshed.ctx || ctx;
  next.now = ctx.now;
  next.transactions = ctx.transactions;
  next.advisorFeed = ctx.advisorFeed ?? null;
  store.ctx = next;

  idle(() => compute(token, refreshed, me));
}

function compute(token, refreshed, rosterId) {
  if (token !== gen) return;
  const ctx = store.ctx;
  const t0 = performance.now();
  let items = [];
  try {
    const standing = env.svc.standingIssues(ctx, rosterId) || [];
    const changed = env.svc.diffStatuses(refreshed.prev, refreshed.next) || [];
    const events = dedupeEvents([...standing, ...changed]);
    items = env.svc.adviseAll(ctx, { rosterId, events, includeRivals: false }) || [];
  } catch (err) {
    console.error("[advisor] adviseAll failed", err);
    setIn("advisor", {
      status: "error", items: [], error: String(err && err.message ? err.message : err),
    });
    paintList();
    paintFeed();
    return;
  }
  setIn("advisor", {
    status: "done",
    items,
    error: null,
    at: refreshed.at || new Date().toISOString(),
    failed: refreshed.failed || [],
    ms: Math.round(performance.now() - t0),
  });
  paintHead();
  paintList();
  paintFeed();
  markSeen();
}

/** One card per (player, kind): a standing issue and a fresh event on the same man are one card. */
export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const event of events) {
    if (!event || event.id == null) continue;
    const key = `${event.id}:${event.kind || "status"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

/** Every advisory now on screen counts as seen — that is what turns the tab dot off. */
function markSeen() {
  const ctx = store.ctx;
  const leagueId = ctx?.league?.id;
  if (!leagueId) return;
  const keys = [...new Set([...store.advisor.items, ...feedItems()].map((a) => a && a.key).filter(Boolean))];
  if (!keys.length) return;
  Promise.resolve(env.svc.markAdviceSeen(leagueId, keys))
    .then(() => env.clearAdviceDot && env.clearAdviceDot())
    .catch((err) => console.warn("[advisor] markAdviceSeen failed", err));
}

/* ================================================================== feed */

/** `ctx.advisorFeed.leagues[<my league>].items`, newest first. Absent feed → []. */
export function feedItems(ctx = store.ctx) {
  const feed = ctx && ctx.advisorFeed;
  const leagueId = ctx?.league?.id;
  const bucket = feed && feed.leagues ? feed.leagues[leagueId] || feed.leagues[String(leagueId)] : null;
  const items = Array.isArray(bucket?.items) ? bucket.items.slice() : [];
  items.sort((a, b) => (toTime(b) || 0) - (toTime(a) || 0));
  return items;
}

const toTime = (item) => Date.parse(item?.at ?? "") || Number(item?.newsAt) || 0;

/** A feed item about someone else's player reads dim: it is news, not a decision. */
const isRival = (item) => {
  const me = myRosterId();
  return me == null ? false : item.owner != null && item.owner !== me;
};

/* ================================================================== render */

function shell() {
  return `<div class="advisor">
    <div class="ad-head" id="ad-head">${headBar()}</div>
    <div id="ad-list" aria-live="polite"></div>
    <div id="ad-feed"></div>
  </div>`;
}

function headBar() {
  const a = store.advisor;
  const as = a.at ? clockTime(a.at) : null;
  const sub = a.status === "running" ? "reading live statuses…" : as ? `as of ${as}` : "";
  return `<div class="ad-title"><span class="view-h">Advisor</span>${
    sub ? `<span class="ad-as">· ${escapeHtml(sub)}</span>` : ""}</div>
    <button type="button" class="icon-btn${a.status === "running" ? " is-spin" : ""}" data-act="ad-refresh"
      aria-label="Read live injury statuses again">${icon("refresh")}</button>`;
}

function paintHead() {
  const host = document.getElementById("ad-head");
  if (host) host.innerHTML = headBar();
}

function paintList() {
  const host = document.getElementById("ad-list");
  if (!host) return;
  const a = store.advisor;
  paintHead();

  if (myRosterId() == null) {
    host.innerHTML = `<p class="note">Viewer mode — Tradewinds does not know which team is yours in
      this league, so it has nobody to advise. Pick your team in Settings to get cards here.</p>`;
    return;
  }
  if (a.status === "running" || a.status === "idle") {
    host.innerHTML = `<p class="hint" role="status">Reading the live status of every player you roster…</p>${skeleton(2, "sk-deal")}`;
    return;
  }
  if (a.status === "error") {
    host.innerHTML = empty("Could not read live statuses", a.error || "Unknown error.",
      { act: "ad-refresh", label: "Try again" });
    return;
  }
  if (!a.items.length) {
    host.innerHTML = empty(
      "Nothing to act on",
      "Your starters are healthy and nobody is on a bye this week.",
    ) + failedNote();
    return;
  }
  host.innerHTML = `<ol class="adv-list">${a.items.map((item, i) => card(item, i)).join("")}</ol>${failedNote()}`;
}

/** A status read that failed is worth one quiet line: the advice is one player short. */
function failedNote() {
  const failed = store.advisor.failed || [];
  if (!failed.length) return "";
  const names = failed.map((id) => store.ctx.players.get(id)?.name || id).slice(0, 3);
  return `<p class="note note-warn">Sleeper did not answer for ${escapeHtml(names.join(", "))}${
    failed.length > names.length ? ` and ${failed.length - names.length} more` : ""} — those players
    were graded on the committed data instead.</p>`;
}

function paintFeed() {
  const host = document.getElementById("ad-feed");
  if (!host) return;
  const items = feedItems();
  const feed = store.ctx?.advisorFeed;
  if (!items.length) {
    // Nothing to apologise for: a league whose alerts job has never run has no feed at all.
    host.innerHTML = feed
      ? `<section class="sec">${sectionHead("League news")}<p class="note">No advisories in the
        league this week.</p></section>`
      : "";
    return;
  }
  const age = feedAgeLine(feed?.generated_at);
  host.innerHTML = `<section class="sec">
    ${sectionHead("League news", age ? `<span class="sec-note">${escapeHtml(age)}</span>` : "")}
    <ul class="ad-feed">${items.map((item, i) => feedRow(item, i)).join("")}</ul>
  </section>`;
}

function feedRow(item, i) {
  const rival = isRival(item);
  const when = relTime(item.at ?? item.newsAt);
  return `<li class="fitem${rival ? " is-rival" : ""}" data-sev="${escapeHtml(item.severity || "low")}">
    <button type="button" class="fitem-hit" data-act="ad-feed-open" data-i="${i}">
      <span class="fitem-b">
        <span class="fitem-h">${escapeHtml(headlineText(item.headline || item.name))}</span>
        <span class="fitem-m">${escapeHtml(ownerLabel(item))}${
          when ? ` · ${escapeHtml(when)}` : ""}</span>
      </span>
      <span class="fitem-go">${icon("chevron")}</span>
    </button>
  </li>`;
}

function ownerLabel(item) {
  const ctx = store.ctx;
  const me = myRosterId();
  if (item.owner == null) return "free agent";
  if (item.owner === me) return "your team";
  const r = (ctx.rosters || []).find((x) => x.rosterId === item.owner);
  return r ? clip(r.teamName || r.displayName, 18) : "another team";
}

/* ---------------------------------------------------------------- one card */

function card(item, i) {
  return `<li class="adv" data-sev="${escapeHtml(item.severity || "low")}">
    <div class="adv-body">${cardBody(item, i)}</div>
  </li>`;
}

/**
 * The card's contents, used both in the list and inside the feed sheet — one layout, so a
 * league-news item is read exactly the way my own advisory is.
 * @param {object} item Advisory
 * @param {number} i index into the list the click handler will look in
 * @param {{feed?: boolean}} [opts]
 */
function cardBody(item, i, opts = {}) {
  const ctx = store.ctx;
  const p = ctx.players.get(item.id) || {};
  const meta = statusMetaLine(item);
  const absence = absencePhrase(item.absence);
  const week = thisWeekLine(item.thisWeek, item.name || p.name);
  const source = opts.feed ? "feed" : "list";
  const posBits = [item.pos || p.pos, item.team || p.team].filter(Boolean).join(" · ");

  return `<div class="adv-h">
      ${playerThumb(ctx, item.id, 40)}
      <div class="adv-hb">
        <p class="adv-t">${escapeHtml(headlineText(item.headline || `${item.name} → ${item.after?.inj || "news"}`))}</p>
        <p class="adv-m">${escapeHtml(posBits)}${posBits && meta ? " · " : ""}${escapeHtml(meta)}${injuryTag(item.after?.inj)}</p>
      </div>
    </div>
    ${absence ? `<p class="adv-abs">${escapeHtml(absence)}</p>` : ""}
    ${week ? `<p class="adv-week">${escapeHtml(week)}</p>` : ""}
    ${irLine(item)}
    ${moves(item, i, source)}
    ${alternatives(item)}`;
}

/**
 * The IR window, but only when the moves do not already say it. The engine writes an "ir" move
 * whose text IS `ir.text` whenever the window matters, and printing the same sentence twice on
 * one card reads like a bug.
 */
function irLine(item) {
  const ir = item.ir;
  if (!ir || !ir.text || ir.eligibleNow) return "";
  const said = (item.moves || []).some((m) => m && (m.type === "ir" || String(m.text || "").includes(ir.text)));
  return said ? "" : `<p class="adv-ir">${escapeHtml(ir.text)}</p>`;
}

/** A chip is 14 characters wide: a long name gives up its first name rather than its ending. */
function chipName(name) {
  const full = String(name ?? "").trim();
  if (full.length <= 14) return full;
  const parts = full.split(/\s+/);
  return clip(parts.length > 1 ? parts[parts.length - 1] : full, 14);
}

function moves(item, i, source) {
  const list = Array.isArray(item.moves) ? item.moves : [];
  if (!list.length) return "";
  return `<ol class="adv-moves">${list.map((move, m) => `<li class="adv-move" data-type="${escapeHtml(move.type || "note")}">
    <p class="adv-mv-h"><span class="adv-mv-n num">${m + 1}</span>
      <span class="adv-mv-x"><span class="adv-mv-t">${escapeHtml(move.text || "")}</span>
        <span class="wchip">${escapeHtml(whenChipText(move))}</span></span></p>
    ${move.why ? `<p class="adv-why">${escapeHtml(move.why)}</p>` : ""}
    ${moveStats(move)}
    <p class="adv-acts">${moveChips(item, move, i, m, source)}</p>
  </li>`).join("")}</ol>`;
}

function moveStats(move) {
  const delta = Number(move.deltaPerWeek);
  const value = Number(move.valueDelta);
  const bits = [];
  if (Number.isFinite(delta) && Math.abs(delta) >= 0.05) {
    bits.push(`<span class="dstat"><b class="num" data-tone="${signTone(delta)}">${fmtPts(delta)}</b> pts/wk</span>`);
  }
  if (Number.isFinite(value) && Math.abs(value) >= 25) {
    bits.push(`<span class="dstat"><b class="num" data-tone="${signTone(value, 25)}">${fmtPts(value, 0)}</b> value</span>`);
  }
  if (move.bid) {
    bits.push(`<span class="dstat">bid <b class="num">${escapeHtml(String(move.bid.value ?? move.bid))}</b></span>`);
  }
  return bits.length ? `<p class="deal-stats">${bits.join("")}</p>` : "";
}

function moveChips(item, move, i, m, source) {
  const chips = [];
  const type = move.type || "note";
  if (WIRE_MOVES.has(type)) {
    chips.push(chip("Open Deals", "ad-wire", { i, m, s: source }));
  }
  if (type === "trade" || (move.add && move.drop)) {
    chips.push(chip("Analyze", "ad-analyze", { i, m, s: source }));
  }
  const who = move.add || item.id;
  if (store.ctx.players.has(who)) {
    chips.push(chip(move.add ? chipName(store.ctx.players.get(who).name) : "Player", "ad-player", { id: who }));
  }
  return chips.join("");
}

function chip(label, act, data = {}) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${escapeHtml(String(v))}"`).join(" ");
  return `<button type="button" class="mchip" data-act="${escapeHtml(act)}" ${attrs}>${escapeHtml(label)}</button>`;
}

function alternatives(item) {
  const rows = Array.isArray(item.alternatives) ? item.alternatives : [];
  if (!rows.length) return "";
  const pos = item.pos || store.ctx.players.get(item.id)?.pos || "";
  return `<details class="adv-alts">
    <summary>Every ${escapeHtml(pos || "option")} worth a look <span class="dim">(${rows.length})</span></summary>
    <table class="mini adv-alt-t">
      <thead><tr><th scope="col">Player</th><th scope="col">this wk</th><th scope="col">next 4</th><th scope="col">ROS</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <th scope="row">${escapeHtml(clip(row.name || row.id, 16))}
          <span class="schip ${OWNER_CLASS[row.owner] || "schip-drop"}">${escapeHtml(clip(ownerText(row.owner), 12))}</span></th>
        <td class="num">${fmtNum(row.thisWeek)}</td>
        <td class="num">${fmtNum(row.next4)}</td>
        <td class="num">${fmtNum(row.ros)}</td>
      </tr>`).join("")}</tbody>
    </table>
  </details>`;
}

function ownerText(owner) {
  if (owner === "mine") return "yours";
  if (owner === "free") return "free";
  if (owner === "waivers") return "waivers";
  return String(owner ?? "rostered");
}

/* ================================================================== events */

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;

  if (act === "ad-refresh") { start(); return; }

  if (act === "ad-player") { openPlayerSheet(t.dataset.id, env); return; }

  if (act === "ad-feed-open") {
    const item = feedItems()[Number(t.dataset.i)];
    if (!item) return;
    openSheet({
      title: item.name || "Advisory",
      body: `<div class="adv adv-sheet" data-sev="${escapeHtml(item.severity || "low")}">
        <div class="adv-body">${cardBody(item, Number(t.dataset.i), { feed: true })}</div></div>`,
      onMount(host) { host.addEventListener("click", onClick); },
    });
    return;
  }

  const item = pick(t.dataset.s, t.dataset.i);
  const move = item && (item.moves || [])[Number(t.dataset.m)];
  if (!item || !move) return;

  if (act === "ad-wire") { openWire(item, move); return; }
  if (act === "ad-analyze") { openAnalyze(item, move); return; }
}

function pick(source, index) {
  const list = source === "feed" ? feedItems() : store.advisor.items;
  return list[Number(index)] || null;
}

/**
 * Hand the Deals tab a preset instead of a search: the Free agents pane, filtered to the
 * position the advisory is about, computed for my roster. That is the same screen the move's
 * numbers came from, so the two can be compared line for line.
 */
function openWire(item, move) {
  const ctx = store.ctx;
  const me = myRosterId();
  const pos = (move.add && ctx.players.get(move.add)?.pos) || item.pos || ctx.players.get(item.id)?.pos || "";
  store.deals.tab = "fa";
  store.deals.scope = "team";
  if (me != null) store.deals.forRosterId = me;
  store.deals.fa = { ...store.deals.fa, pos, status: "idle", results: [], error: null };
  env.go("deals");
}

/** A trade move carries the two players; Analyze can grade it the moment it opens. */
function openAnalyze(item, move) {
  const ctx = store.ctx;
  const me = myRosterId();
  const get = move.add && ctx.players.has(move.add) ? [move.add] : [];
  const give = move.drop && ctx.players.has(move.drop) ? [move.drop] : [];
  const theirRosterId = get.length ? ctx.rosterOf.get(get[0]) ?? null : null;
  prefill({ aRosterId: me, theirRosterId, give, get });
  env.go("analyze");
}
