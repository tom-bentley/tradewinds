// src/engine/advisor.js — news → a recommended course of action (design.md §12.2).
//
// Sleeper told Tom that Bowers was Doubtful. Nothing told him what to DO, so he panic-dropped a
// top-5 tight end ten minutes later. This module is that missing decision layer, and it is
// deterministic on purpose (design §12.1): the answer is lineup math, the league's own IR rules,
// and the free-agent/trade finders that already exist. The only judgement call — how long is he
// out — lives in the editable table in ./injuries.js.
//
// The shape of every recommendation is the same: what happened, how long it lasts, what it costs
// this week, and the ordered moves that recover the most points — start → IR → add/drop → trade →
// hold. Each move carries a `when` ("now", "when status = Out", "after waivers clear Wed") because
// half of the value is knowing that the IR window opens only once Sleeper flips him to Out.
//
// Pure, like the rest of the engine: no DOM, no fetch, no clock (the caller injects `now`). Every
// scenario is a NEW ctx — memoized week vectors and season lineups are keyed to a context, so
// mutating one would poison the caches the finders depend on.

import {
  activePlayers,
  playerOf,
  rosPoints,
  rosterById,
  resolveNow,
} from "./context.js";
import { WEEK_ZERO_STATUSES, bestLineup, isBye, weekPoints } from "./lineup.js";
import { cachedSeasonLineup } from "./trade.js";
import { findTrades } from "./finder.js";
import {
  currentStarters,
  findFreeAgents,
  freeAgentPool,
  protectedBySurplus,
  waiverStatus,
} from "./waiver.js";
import { fmt1, nameOf, sideNames, voice } from "./explain.js";
import { absenceOf, withAbsence } from "./injuries.js";

/** Push bodies are read on a lock screen: three moves, one line each, hard-capped. */
export const SUMMARY_MAX = 170;
/** iOS truncates a notification title around here. */
export const HEADLINE_MAX = 60;
/** A move worth naming has to be worth this many points per week. */
export const MOVE_EPSILON = 0.05;
/** Below this expected absence a trade is an over-reaction — he is back before it clears review. */
export const TRADE_MEAN_GAMES = 3;
/** ...and the hole he leaves has to be worth this many points per week. */
export const TRADE_HOLE_PER_WEEK = 1.5;
/** How many free agents the wire pass considers. */
export const WIRE_RESULTS = 6;
/** Rows in the alternatives table (design §12.5). */
export const MAX_ALTERNATIVES = 6;
/** "next 4" in the alternatives table. */
export const NEXT_WEEKS = 4;
/** Statuses that are an issue even when nothing changed (design §12.2 standing issues). */
export const ISSUE_STATUSES = Object.freeze([...WEEK_ZERO_STATUSES, "Questionable"]);
/** Reserve lists always accept these two, whatever the league's `reserve_allow_*` say. */
export const IR_ALWAYS = Object.freeze(["IR", "PUP", "Reserve"]);
/** Statuses in worsening order — how `opensWhen` finds the next status that unlocks IR. */
export const STATUS_CHAIN = Object.freeze(["Questionable", "Doubtful", "Out", "IR"]);
/** Severity order for `adviseAll`. */
export const SEVERITY_ORDER = Object.freeze(["high", "med", "low"]);

const ISSUE_SET = new Set(ISSUE_STATUSES);
const DAY_NAMES = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
/** Name suffixes that are not a surname. */
const SUFFIXES = Object.freeze(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

/** null for anything empty, a trimmed string otherwise. */
function str(value) {
  if (value == null) return null;
  const s = String(value);
  return s === "" ? null : s;
}

/** A finite number, or null — `null` stays null rather than becoming 0 (a real newsAt is never 0). */
function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The three fields a status is made of, normalized. */
function normStatus(row) {
  const r = row || {};
  return { inj: str(r.inj), injPart: str(r.injPart), injNotes: str(r.injNotes) };
}

/**
 * "Dallas Goedert" → "Goedert". Move texts live inside a 170-character push body, and the surname
 * is what a manager calls him anyway. Team defenses keep their whole name ("HOU D/ST").
 * @param {string} name
 * @param {string|null} [pos]
 * @returns {string}
 */
export function shortName(name, pos) {
  const full = String(name || "").trim();
  if (!full || pos === "DEF" || pos === "K") return full;
  const parts = full.split(/\s+/);
  if (parts.length < 2) return full;
  const last = parts[parts.length - 1];
  if (SUFFIXES.includes(last.toLowerCase()) && parts.length > 2) return `${parts[parts.length - 2]} ${last}`;
  return last;
}

/** Cut to `max` characters on a word boundary where possible, with an ellipsis. */
function trim(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "Wed" — which day a waiver claim clears. Formatting an injected ms is pure; reading a clock is not. */
function dayLabel(ms) {
  return ms == null ? "waivers" : DAY_NAMES[new Date(ms).getDay()];
}

/** Points per remaining week, the unit every wire number is quoted in. */
function perWeek(ctx, id) {
  return rosPoints(ctx, id) / Math.max(1, (ctx.weeksLeft || []).length);
}

/**
 * Apply live status rows to a ctx WITHOUT mutating it (design §12.2).
 *
 * A new players map plus an empty memo is the whole trick: `weekVector` caches the injury zeroing,
 * so a patched status has to arrive on a context whose caches were never warmed with the old one.
 * @param {object} ctx
 * @param {Array<{id:string, inj?:string|null, injPart?:string|null, injNotes?:string|null,
 *                newsAt?:number|null, dc?:number|null}>} rows Sleeper player ids; unknown ids ignored
 * @returns {object} a new ctx (the same ctx when no row changed anything)
 */
export function applyStatuses(ctx, rows) {
  const players = new Map(ctx.players);
  let changed = false;
  for (const row of rows || []) {
    if (!row || row.id == null) continue;
    const id = String(row.id);
    const prev = ctx.players.get(id);
    if (!prev) continue; // an id this league's player file never heard of
    const next = {
      ...prev,
      inj: str(row.inj),
      injPart: str(row.injPart),
      injNotes: str(row.injNotes),
      newsAt: row.newsAt !== undefined ? num(row.newsAt) : num(prev.newsAt),
      dc: row.dc !== undefined ? num(row.dc) : num(prev.dc),
    };
    if (
      next.inj === (prev.inj == null ? null : prev.inj) &&
      next.injPart === (prev.injPart == null ? null : prev.injPart) &&
      next.injNotes === (prev.injNotes == null ? null : prev.injNotes) &&
      next.newsAt === num(prev.newsAt) &&
      next.dc === num(prev.dc)
    ) {
      continue;
    }
    players.set(id, next);
    changed = true;
  }
  return changed ? { ...ctx, players, memo: {} } : ctx;
}

/**
 * Apply fresh CURRENT-week points the same way (design §12.1: the projections endpoint reprices a
 * hurt player within hours — Bowers 12.71 → 0 — while future weeks stay stale).
 * @param {object} ctx
 * @param {Array<{id:string, week:number, pts:number}>} rows only `week === ctx.week` is applied
 * @returns {object} a new ctx (the same ctx when nothing changed)
 */
export function applyWeekPoints(ctx, rows) {
  const proj = new Map(ctx.proj);
  let changed = false;
  for (const row of rows || []) {
    if (!row || row.id == null || Number(row.week) !== ctx.week) continue;
    const id = String(row.id);
    const pts = num(row.pts);
    const vec = ctx.proj.get(id);
    if (pts == null || !vec) continue; // no projection row to patch — nothing to say about him
    if ((Number(vec[ctx.week - 1]) || 0) === pts) continue;
    const patched = Array.from(vec, (n) => Number(n) || 0);
    patched[ctx.week - 1] = pts;
    proj.set(id, patched);
    changed = true;
  }
  return changed ? { ...ctx, proj, memo: {} } : ctx;
}

/**
 * The stable identity of a status: what changed, never when it was reported. `news_updated` ticks
 * on its own and must never re-alert (design §12.1).
 * @param {{inj?:string|null, injPart?:string|null, injNotes?:string|null}} row
 * @returns {string} `${inj}|${injPart}|${injNotes}`
 */
export function statusKey(row) {
  const s = normStatus(row);
  return `${s.inj || ""}|${s.injPart || ""}|${s.injNotes || ""}`;
}

/** The inverse of `statusKey` — notes may themselves contain a pipe, so only the first two split. */
function parseStatusKey(key) {
  const parts = String(key == null ? "" : key).split("|");
  return {
    inj: str(parts[0]),
    injPart: str(parts[1]),
    injNotes: str(parts.slice(2).join("|")),
  };
}

/**
 * Diff two status snapshots for a watch set.
 *
 * An id missing from `prev` is a first sighting, NOT an event — the first run for a league seeds
 * the snapshot and alerts nothing (design §12.3). An id missing from `next` fell off the watch set
 * (traded away, dropped) and is nobody's problem.
 * @param {Object<string, string>} prev id → StatusKey
 * @param {Object<string, string>} next id → StatusKey
 * @returns {Array<{id:string, kind:"status", before:object, after:object}>}
 */
export function diffStatuses(prev, next) {
  const was = prev || {};
  const now = next || {};
  const out = [];
  for (const id of Object.keys(now)) {
    const before = was[id];
    if (before === undefined) continue;
    if (before === now[id]) continue;
    out.push({
      id: String(id),
      kind: "status",
      before: parseStatusKey(before),
      after: parseStatusKey(now[id]),
    });
  }
  return out;
}

/**
 * May this league park this status on a reserve slot? Read live from `reserve_allow_*`, never
 * hard-coded: another league lets you stash Doubtful, and Boyball does not.
 * @param {object} ctx
 * @param {string|null} status
 * @returns {boolean}
 */
export function irEligible(ctx, status) {
  if (!status) return false;
  if (IR_ALWAYS.includes(status)) return true;
  const allow = (ctx.league && ctx.league.reserveAllow) || {};
  switch (status) {
    case "Out":
      return !!allow.out;
    case "Doubtful":
      return !!allow.doubtful;
    case "Sus":
    case "Suspended":
      return !!allow.sus;
    case "COV":
      return !!allow.cov;
    case "DNR":
      return !!allow.dnr;
    case "NA":
      return !!allow.na;
    default:
      return false;
  }
}

/**
 * IR is the free move — it buys a bench spot for nothing — but only once the status qualifies.
 * The advisory has to say WHEN that window opens, not just whether it is open (design §12.1).
 * @param {object} ctx
 * @param {number} rosterId the roster whose reserve slots are in play
 * @param {string} id
 * @returns {{eligibleNow:boolean, slotsFree:number, opensWhen:string|null, text:string}}
 */
export function irEligibility(ctx, rosterId, id) {
  const roster = rosterById(ctx, rosterId);
  const slots = Number(ctx.league && ctx.league.irSlots) || 0;
  const used = roster ? (roster.reserve || []).length : 0;
  const slotsFree = Math.max(0, slots - used);
  const status = playerOf(ctx, id).inj || null;
  const eligibleNow = irEligible(ctx, status);

  let opensWhen = null;
  if (!eligibleNow) {
    const from = STATUS_CHAIN.indexOf(status);
    for (let i = Math.max(0, from + 1); i < STATUS_CHAIN.length; i += 1) {
      if (irEligible(ctx, STATUS_CHAIN[i])) {
        opensWhen = STATUS_CHAIN[i];
        break;
      }
    }
  }

  const plural = `${slotsFree} slot${slotsFree === 1 ? "" : "s"} free`;
  let text;
  if (!slots) text = "This league has no IR slots.";
  else if (eligibleNow) text = slotsFree ? `IR-eligible now — ${plural}.` : "IR-eligible, but every IR slot is taken.";
  else if (opensWhen) {
    text = slotsFree
      ? `IR opens when his status becomes ${opensWhen} — ${plural}.`
      : `IR would open at ${opensWhen}, but every IR slot is taken.`;
  } else text = "Not IR-eligible in this league.";

  return { eligibleNow, slotsFree, opensWhen, text };
}

/**
 * What is wrong with this roster right now, even if no news broke — the Advisor tab opens on this
 * (design §12.2). Three kinds: a status that zeroes a week, a reserve player Sleeper will no
 * longer let you park (he blocks every other move until you activate him), and a starter on a bye.
 * @param {object} ctx
 * @param {number} rosterId
 * @returns {Array<{id:string, kind:string, before:null, after:object, newsAt:number|null}>}
 */
export function standingIssues(ctx, rosterId) {
  const roster = rosterById(ctx, rosterId);
  if (!roster) return [];
  const out = [];
  const seen = new Set();
  const push = (id, kind) => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = playerOf(ctx, id);
    out.push({
      id,
      kind,
      before: null,
      after: normStatus(p),
      newsAt: p.newsAt != null ? num(p.newsAt) : null,
    });
  };

  for (const id of activePlayers(roster)) {
    const inj = playerOf(ctx, id).inj;
    if (inj && ISSUE_SET.has(inj)) push(id, "status");
  }
  for (const id of roster.reserve || []) {
    if (!irEligible(ctx, playerOf(ctx, id).inj || null)) push(id, "activate");
  }
  for (const id of currentStarters(ctx, rosterId)) {
    if (isBye(ctx, id, ctx.week)) push(id, "bye");
  }
  return out;
}

/**
 * What this week's lineup does about him: the slot he vacated, who fills it, and what it costs.
 *
 * The reference point is the lineup the manager actually SET in Sleeper, not a recomputed optimum:
 * the whole recommendation is "open the app and make this change", and a change he has already
 * made is not advice. `prior` is the same context with the pre-news status, so `lineupDelta` can
 * say what the news itself cost even when the caller hands us an already-patched ctx.
 * @returns {{started:boolean, bye:boolean, slot:string|null, was:number, now:number,
 *            replacement:string|null, replacementPts:number, gain:number, lineupDelta:number}}
 */
function thisWeekOf(prior, scen, ids, id, starters) {
  const week = scen.week;
  const before = bestLineup(prior, ids, week);
  const after = bestLineup(scen, ids, week);
  const was = weekPoints(prior, id, week);
  const now = weekPoints(scen, id, week);

  const roster = new Set(ids);
  const set = [...starters].filter((sid) => roster.has(sid));
  let setTotal = 0;
  for (const sid of set) setTotal += weekPoints(scen, sid, week);

  // Who has to come OFF the bench: the first man in the optimal lineup who is not already started.
  const seated = new Set(set.length ? set : before.slots.map((s) => s.id).filter(Boolean));
  const newcomer = after.slots.find((s) => s.id && !seated.has(s.id)) || null;
  const priorSlot = before.slots.find((s) => s.id === id) || null;

  return {
    started: starters.has(id),
    bye: isBye(scen, id, week),
    // a benched player has no slot to vacate — his position is the honest label for the card
    slot: starters.has(id)
      ? newcomer ? newcomer.slot : priorSlot ? priorSlot.slot : playerOf(scen, id).pos || null
      : playerOf(scen, id).pos || null,
    was,
    now,
    replacement: newcomer ? newcomer.id : null,
    replacementPts: newcomer ? newcomer.pts : 0,
    // what making the swap is worth against the lineup as it stands right now
    gain: set.length ? after.total - setTotal : after.total - (before.total - was + now),
    // what the news itself cost, once both lineups are played optimally
    lineupDelta: after.total - before.total,
  };
}

/** The same roster with one player parked on IR — how a freed bench spot is priced. */
function withReserve(ctx, rosterId, id) {
  const rosters = ctx.rosters.map((r) =>
    r.rosterId === rosterId && !r.reserve.includes(id)
      ? { ...r, reserve: [...r.reserve, id], starters: r.starters.filter((x) => x !== id) }
      : r
  );
  return { ...ctx, rosters, memo: {} };
}

/** The best unrostered player at one position, whether or not he is worth a roster spot. */
function bestFreeAt(ctx, pos) {
  if (!pos) return null;
  for (const id of freeAgentPool(ctx)) if (playerOf(ctx, id).pos === pos) return id;
  return null;
}

/** One add from the wire, phrased as a move. */
function addMove(ctx, row) {
  const add = shortName(nameOf(ctx, row.add), playerOf(ctx, row.add).pos);
  const drop = row.drop ? shortName(nameOf(ctx, row.drop), playerOf(ctx, row.drop).pos) : null;
  const waivers = row.status === "waivers";
  const price = row.suggestedBid ? ` Bid ${row.suggestedBid.value}–${row.suggestedBid.aggressive}.` : "";
  return {
    type: "add",
    text: drop
      ? `Add ${add} (+${fmt1(row.gainPerWeek)}/wk), drop ${drop}.${price}`
      : `Add ${add} (+${fmt1(row.gainPerWeek)}/wk) into the freed spot.${price}`,
    why: row.why || [],
    deltaPerWeek: row.gainPerWeek,
    valueDelta: row.valueDelta,
    add: row.add,
    drop: row.drop,
    status: row.status,
    clearsAt: row.clearsAt,
    bid: row.suggestedBid,
    when: waivers ? `after waivers clear ${dayLabel(row.clearsAtMs)}` : "now",
  };
}

/** A move with the fields every move carries, so the UI never has to test for undefined. */
function move(type, text, extra = {}) {
  return {
    type,
    text,
    why: [],
    deltaPerWeek: 0,
    valueDelta: 0,
    add: null,
    drop: null,
    status: null,
    clearsAt: null,
    bid: null,
    when: "now",
    ...extra,
  };
}

/** Free agents shown in the alternatives table before rivals' starters fill the rest. */
export const FREE_ALTERNATIVES = 3;

/**
 * The alternatives table: the bodies at that position that bear on THIS decision — every one the
 * roster already holds, the best few on the wire, and then the best rostered elsewhere (the trade
 * targets) — best-first by this week's points. A table of six rival TE1s answers nothing.
 */
function alternativesFor(scen, rosterId, pos, excludeId) {
  if (!pos) return [];
  const week = scen.week;
  const byPoints = (a, b) =>
    weekPoints(scen, b, week) - weekPoints(scen, a, week) ||
    rosPoints(scen, b) - rosPoints(scen, a) ||
    (a < b ? -1 : 1);
  const mine = [];
  const free = [];
  const elsewhere = [];
  for (const [id, p] of scen.players) {
    if (!p || p.pos !== pos || id === excludeId) continue;
    const owned = scen.rosterOf.has(id) ? scen.rosterOf.get(id) : null;
    if (owned == null) free.push(id);
    else if (owned === rosterId) mine.push(id);
    else elsewhere.push(id);
  }
  free.sort(byPoints);
  elsewhere.sort(byPoints);
  const ids = [...mine, ...free.slice(0, FREE_ALTERNATIVES)];
  for (const id of elsewhere) {
    if (ids.length >= MAX_ALTERNATIVES) break;
    ids.push(id);
  }
  ids.sort(byPoints);
  return ids.slice(0, MAX_ALTERNATIVES).map((id) => {
    const p = playerOf(scen, id);
    const owned = scen.rosterOf.has(id) ? scen.rosterOf.get(id) : null;
    let owner;
    if (owned == null) owner = waiverStatus(scen, id).status === "waivers" ? "waivers" : "free";
    else if (owned === rosterId) owner = "mine";
    else {
      const roster = rosterById(scen, owned);
      owner = roster ? roster.teamName || roster.displayName : `Roster ${owned}`;
    }
    let next4 = 0;
    for (let w = week; w < week + NEXT_WEEKS && w <= scen.lastWeek; w += 1) next4 += weekPoints(scen, id, w);
    return {
      id,
      name: p.name || id,
      team: p.team || null,
      thisWeek: weekPoints(scen, id, week),
      next4,
      ros: rosPoints(scen, id),
      owner,
    };
  });
}

/** moves[0..2], joined, inside the push-body budget. */
function summaryOf(moves) {
  const texts = moves.slice(0, 3).map((m) => m.text);
  let out = "";
  for (const text of texts) {
    const next = out ? `${out} ${text}` : text;
    if (next.length > SUMMARY_MAX) break;
    out = next;
  }
  return out || trim(texts[0] || "", SUMMARY_MAX);
}

/** "Brock Bowers → Doubtful (knee - meniscus · surgery)", inside the notification-title budget. */
function headlineOf(ctx, id, kind, after, week) {
  const name = nameOf(ctx, id);
  if (kind === "bye") return trim(`${name} is on bye in week ${week}`, HEADLINE_MAX);
  if (kind === "activate") return trim(`${name} no longer qualifies for IR`, HEADLINE_MAX);
  const detail = [after.injPart, after.injNotes].filter(Boolean).map((s) => s.toLowerCase());
  const status = after.inj || "Active";
  return trim(`${name} → ${status}${detail.length ? ` (${detail.join(" · ")})` : ""}`, HEADLINE_MAX);
}

/**
 * THE call: one status event → one advisory (design §12.2).
 *
 * Order of operations is the whole design. The event is applied to a scenario ctx, the injured
 * player's future weeks are discounted by the absence table, and only then is anything measured —
 * so "the best free tight end" is judged against the roster as it will actually be, not as
 * Sleeper's stale projections describe it.
 * @param {object} ctx
 * @param {{rosterId?:number, event:object, now?:number}} opts `event` from diffStatuses or
 *   standingIssues; `rosterId` is the perspective (my team), defaulting to `ctx.myRosterId`
 * @returns {object} Advisory
 */
export function advise(ctx, opts = {}) {
  const event = opts.event || {};
  const id = String(event.id == null ? "" : event.id);
  const rosterId = opts.rosterId != null ? opts.rosterId : ctx.myRosterId;
  const kind = event.kind || "status";
  const after = normStatus(event.after);
  const before = event.before ? normStatus(event.before) : null;
  const player = playerOf(ctx, id);
  const pos = player.pos || null;
  const owner = ctx.rosterOf.has(id) ? ctx.rosterOf.get(id) : null;
  const mine = owner != null && owner === rosterId;
  const injectedNow = resolveNow(opts.now, ctx.now);
  const base = injectedNow !== ctx.now ? { ...ctx, now: injectedNow } : ctx;

  // 1 — the event, then the absence it implies, applied to a scenario nobody else can see
  const applied = applyStatuses(base, [
    {
      id,
      inj: after.inj,
      injPart: after.injPart,
      injNotes: after.injNotes,
      ...(event.newsAt !== undefined ? { newsAt: event.newsAt } : {}),
    },
  ]);
  const absence = absenceOf(applied, after);
  const scen = withAbsence(applied, id, absence);
  // The world before the news. A ctx handed to us by the app already carries the new status, so
  // "what did this cost" is only answerable against a context rewound to `event.before`.
  const prior = before ? applyStatuses(base, [{ id, ...before }]) : base;

  // 2 — this week's lineup, from the owning roster's point of view
  const homeRosterId = owner != null ? owner : rosterId;
  const roster = rosterById(base, homeRosterId);
  const active = roster ? activePlayers(roster) : [];
  const starters = roster ? currentStarters(base, homeRosterId) : new Set();
  const thisWeek = roster ? thisWeekOf(prior, scen, active, id, starters) : null;

  // 3 — the free move, if the league's own settings allow it
  const ir = irEligibility(scen, homeRosterId, id);

  const moves = [];
  const names = sideNames(base, rosterId, owner != null && !mine ? owner : null);
  const v = voice(names);

  if (mine) {
    // 4 — the lineup fix comes first: it is free, it is this week, and it is the biggest number.
    // Only when the news opens a hole in the lineup the manager actually set: a player already
    // benched needs no replacement, and an unrelated bench-vs-starter tweak is not this story.
    if (thisWeek && thisWeek.started && thisWeek.replacement && thisWeek.gain > MOVE_EPSILON) {
      const who = shortName(nameOf(scen, thisWeek.replacement), playerOf(scen, thisWeek.replacement).pos);
      const why = [
        `${shortName(player.name, pos)} projects ${fmt1(thisWeek.now)} this week — the swap is worth ` +
          `${fmt1(thisWeek.gain)} pts to ${v.aPossLower} lineup as it stands.`,
      ];
      if (Math.abs(thisWeek.lineupDelta) > MOVE_EPSILON) {
        why.push(`The news itself costs ${v.aPossLower} starters ${fmt1(Math.abs(thisWeek.lineupDelta))} pts this week.`);
      }
      moves.push(
        move("start", `${v.first ? "Start" : `${v.a} starts`} ${who} at ${thisWeek.slot} (${fmt1(thisWeek.replacementPts)}).`, {
          why,
          deltaPerWeek: thisWeek.gain,
          add: thisWeek.replacement,
        })
      );
    }

    // 5 — IR: either the move, or the date it becomes one. A player Sleeper will no longer let
    // you park there is the mirror image: he blocks every other move until he is activated.
    if (kind === "activate") {
      moves.push(
        move("activate", `Activate ${shortName(player.name, pos)} — ${after.inj || "healthy"} no longer qualifies for IR.`, {
          why: ["Sleeper blocks roster moves while an ineligible player sits on a reserve slot."],
          add: id,
          status: after.inj,
        })
      );
    } else if (ir.eligibleNow && ir.slotsFree > 0) {
      moves.push(
        move("ir", `Move ${shortName(player.name, pos)} to IR — ${ir.slotsFree} slot${ir.slotsFree === 1 ? "" : "s"} free.`, {
          why: [ir.text],
          drop: id,
          status: after.inj,
        })
      );
    } else if (!ir.eligibleNow && ir.opensWhen && ir.slotsFree > 0) {
      moves.push(
        move("ir", ir.text, {
          why: [`${after.inj || "This status"} cannot be stashed in this league; ${ir.opensWhen} can.`],
          drop: id,
          status: after.inj,
          when: `when status = ${ir.opensWhen}`,
        })
      );
    }

    // 6 — the wire. Two questions: does the freed IR spot pay for itself, and can the wire
    // replace him at his own position?
    const wire = findFreeAgents(scen, { rosterId, maxResults: WIRE_RESULTS, minGainPerWeek: 0 });
    const seenAdds = new Set();
    if (ir.eligibleNow && ir.slotsFree > 0) {
      const freed = findFreeAgents(withReserve(scen, rosterId, id), {
        rosterId,
        maxResults: WIRE_RESULTS,
        minGainPerWeek: 0,
      });
      const best = freed.find((row) => row.gainPerWeek > MOVE_EPSILON);
      if (best) {
        seenAdds.add(best.add);
        moves.push(addMove(scen, best));
      }
    }
    const samePos = wire.find((row) => playerOf(scen, row.add).pos === pos && row.gainPerWeek > MOVE_EPSILON);
    if (samePos && !seenAdds.has(samePos.add)) {
      seenAdds.add(samePos.add);
      moves.push(addMove(scen, samePos));
    }

    // 7 — a trade only for a real, lasting hole; anything shorter is an over-reaction
    const hole = thisWeek ? cachedSeasonLineup(prior, active).avgPerWeek - cachedSeasonLineup(scen, active).avgPerWeek : 0;
    if (absence.mean >= TRADE_MEAN_GAMES && hole >= TRADE_HOLE_PER_WEEK) {
      const deals = findTrades(scen, { myRosterId: rosterId, maxResults: 3 });
      const wanted = deals.find((d) => d.get.some((gid) => playerOf(scen, gid).pos === pos)) || deals[0] || null;
      if (wanted) moves.push(tradeMove(scen, wanted));
    }

    // 8 — nothing on the wire beats what is already here: say so, with the number that proves it
    if (!seenAdds.size) {
      // The comparison is positional: "no free TE beats <my best TE>". The slot replacement is only
      // that man when he plays the same position — a WR sliding into the FLEX is not the TE incumbent.
      const samePos = (x) => x !== id && playerOf(scen, x).pos === pos;
      const incumbent =
        active.filter(samePos).sort((a, b) => rosPoints(scen, b) - rosPoints(scen, a))[0] ||
        (thisWeek && thisWeek.replacement && samePos(thisWeek.replacement) ? thisWeek.replacement : null);
      const bestFree = bestFreeAt(scen, pos);
      // the free agent keeps his whole name here: he is the number that proves the "hold"
      const tail = bestFree ? ` (best: ${nameOf(scen, bestFree)} ${fmt1(perWeek(scen, bestFree))}/wk)` : "";
      moves.push(
        move(
          "hold",
          incumbent
            ? `Hold: no free ${pos} beats ${shortName(nameOf(scen, incumbent), pos)}${tail}.`
            : `Hold: nothing on the wire at ${pos} is worth a roster spot${tail}.`,
          { why: [`Every free ${pos} grades below what ${v.aPossLower} roster already holds.`], add: bestFree }
        )
      );
    }
  } else {
    // A rival's news is only actionable when it opens a hole I can trade into (design §12.2).
    const lostStarter = !!(thisWeek && thisWeek.started && thisWeek.now <= 0);
    if (lostStarter && owner != null) {
      const deals = findTrades(scen, { myRosterId: rosterId, maxResults: 3 }).filter((d) => d.theirRosterId === owner);
      if (deals[0]) moves.push(tradeMove(scen, deals[0]));
    }
    if (!moves.length) {
      const team = roster ? roster.teamName || roster.displayName : "Another team";
      moves.push(move("note", `${team}'s ${shortName(player.name, pos)} is ${after.inj || "back"}; no move for you.`));
    }
  }

  // 9 — how loud this should be: my starters and my best players interrupt, a rival's do not
  let severity = "low";
  if (mine) {
    const shielded = protectedBySurplus(base, active);
    severity = starters.has(id) || shielded.has(id) ? "high" : "med";
  }

  const newsAt = event.newsAt !== undefined ? num(event.newsAt) : num(player.newsAt);
  return {
    key: `${id}:${statusKey(after)}`,
    kind,
    id,
    name: player.name || id,
    pos,
    team: player.team || null,
    owner,
    before,
    after,
    newsAt,
    severity,
    absence,
    thisWeek,
    ir,
    moves,
    alternatives: alternativesFor(scen, rosterId, pos, id),
    headline: headlineOf(scen, id, kind, after, base.week),
    summary: summaryOf(moves),
    url: "#advisor",
  };
}

/** One finder candidate, phrased as a move. */
function tradeMove(ctx, deal) {
  const get = deal.get.map((gid) => shortName(nameOf(ctx, gid), playerOf(ctx, gid).pos)).join(" + ");
  const give = deal.give.map((gid) => shortName(nameOf(ctx, gid), playerOf(ctx, gid).pos)).join(" + ");
  const team = rosterById(ctx, deal.theirRosterId);
  return move("trade", `Trade ${give} for ${get} with ${team ? team.displayName || team.teamName : "a rival"}.`, {
    why: deal.why || [],
    deltaPerWeek: deal.myDeltaPerWeek,
    valueDelta: deal.myEdgePct,
    add: deal.get[0] || null,
    drop: deal.give[0] || null,
  });
}

/** high → med → low, then freshest news first. */
function compareAdvisories(a, b) {
  const rank = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  if (rank) return rank;
  const an = a.newsAt == null ? -Infinity : a.newsAt;
  const bn = b.newsAt == null ? -Infinity : b.newsAt;
  if (an !== bn) return bn - an;
  return a.key < b.key ? -1 : 1;
}

/**
 * Everything one device needs in a single call: the events that just broke plus the problems that
 * were already there, deduped, advised and sorted (design §12.2).
 * @param {object} ctx
 * @param {{rosterId?:number, events?:object[], includeRivals?:boolean}} [opts]
 * @returns {object[]} Advisories, most urgent first
 */
export function adviseAll(ctx, opts = {}) {
  const rosterId = opts.rosterId != null ? opts.rosterId : ctx.myRosterId;
  const includeRivals = !!opts.includeRivals;
  const out = [];
  const seen = new Set();
  for (const event of [...(opts.events || []), ...standingIssues(ctx, rosterId)]) {
    if (!event || event.id == null) continue;
    const id = String(event.id);
    const owner = ctx.rosterOf.has(id) ? ctx.rosterOf.get(id) : null;
    if (!includeRivals && owner !== rosterId) continue;
    const key = `${id}:${statusKey(event.after)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(advise(ctx, { rosterId, event, now: opts.now }));
  }
  out.sort(compareAdvisories);
  return out;
}
