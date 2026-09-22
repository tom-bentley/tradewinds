// src/engine/waiver.js — the free-agent axis (design.md §11.2, R4 §4).
//
// The wire is the cheapest trade there is. Every candidate add is scored on the SAME two axes a
// trade is: what the starting lineup gains over the remaining weeks (playoff weeks weighted), and
// what the roster gains on market value. "Worth dropping someone for" is then one number, not a
// vibe — and the drop is named, legal, and never a player the roster cannot afford to lose.
//
// Pure, like the rest of the engine: no DOM, no fetch, no reading of the clock. It arrives as
// `ctx.now` (design.md §11.2) so every waiver window is reproducible in a test. With no clock the
// module degrades honestly: everybody reads "free", flagged `unknown`.

import { POSITIONS, TRADEABLE } from "../config.js";
import {
  activePlayers,
  playerOf,
  rosPoints,
  rosterById,
  rosteredIds,
  slotEligibility,
  DEFAULT_WAIVER_CLEAR_DAYS,
  FAAB_WAIVER_TYPE,
} from "./context.js";
import { marketValue, surplus } from "./values.js";
import { bestLineup, settingsBlock, weekPoints } from "./lineup.js";
import { cachedSeasonLineup, evaluateTrade } from "./trade.js";
import { consensusGaps, playerRisk, rosterFragility } from "./risk.js";
import { fmt1, nameOf, sideNames, voice } from "./explain.js";

/** One day in milliseconds — the unit Sleeper's `waiver_clear_days` is counted in. */
export const DAY_MS = 86400000;
/** How many free agents per position enter the shortlist (design.md §11.2 "top ~40"). */
export const CANDIDATES_PER_POS = 8;
/** Hard ceiling on the shortlist, before any lineup is evaluated. */
export const MAX_FA_CANDIDATES = 40;
/** The top of a roster by surplus is never a drop candidate, whatever the wire offers. */
export const PROTECTED_BY_SURPLUS = 6;
/** Bid model (design.md §11.2, ported from R4 §4; re-derived in 004 per R9 §Q9.4 R-8). */
export const MAX_BID_SHARE = 0.35;
export const BID_GAIN_SCALE = 10;
export const BID_PHASE_FLOOR = 0.35;
export const BID_AGGRESSIVE_MULT = 1.6;
export const SEASON_WEEKS = 17;
/**
 * Total points — Δ per week × the weeks the add will actually start — that prices a bid at the
 * whole `MAX_BID_SHARE` before scarcity and phase.
 *
 * Calibrated to R5 §2.3's published tiers via R9 §Q9.4's worked example: an 8-point weekly upgrade
 * started for 12 weeks is 96 points and reads 28 % of budget (R5's "league-winner 30–40 %" band,
 * and the 0.35 cap once scarcity multiplies it); a 3 pts/wk rest-of-season add at week 1 is 51
 * points and reads 15 %, the middle of the "weekly starter 10–20 %" tier. ENGINE-CHOSEN.
 */
export const BID_TOTAL_SCALE = 340;
/** Another free agent within this many points per week is "the same add, still available". */
export const ALT_BAND_PER_WEEK = 2;
/** Lineup gains inside this margin are a tie, settled on market value instead. */
const GAIN_EPSILON = 1e-6;
/** How many drop candidates (best gain first) are re-scored with their insurance cost (§13.5 D3).
 *  The gain-maximizing drop is not always the right one: cutting the only body that covers a
 *  fragile starter can cost more than the add brings. */
const DROP_FINALISTS = 3;
/** Below this the insurance/risk components are not worth a sentence. */
const WHY_EPSILON = 0.05;

/**
 * Every player nobody rosters: not on a `players`, `reserve` or `taxi` list anywhere in the
 * league, playing one of the six fantasy positions, and worth listing at all (a remaining-season
 * projection or a market price). Best-first by remaining points, then value. Memoized per ctx.
 * @param {object} ctx
 * @returns {string[]} player ids
 */
export function freeAgentPool(ctx) {
  if (ctx.memo.faPool) return ctx.memo.faPool;
  const taken = rosteredIds(ctx);
  const ids = [];
  for (const [id, p] of ctx.players) {
    if (!p || !POSITIONS.includes(p.pos) || taken.has(id)) continue;
    if (rosPoints(ctx, id) <= 0 && marketValue(ctx, id).mAdj == null) continue;
    ids.push(id);
  }
  ids.sort(
    (a, b) =>
      rosPoints(ctx, b) - rosPoints(ctx, a) ||
      (marketValue(ctx, b).mAdj || 0) - (marketValue(ctx, a).mAdj || 0) ||
      (a < b ? -1 : 1)
  );
  ctx.memo.faPool = ids;
  return ids;
}

/**
 * Sleeper trending adds keyed by player id. `ctx.trending` is the raw
 * `/players/nfl/trending/add` payload: `[{ player_id, count }]`.
 * @param {object} ctx
 * @returns {Map<string, number>}
 */
function trendMap(ctx) {
  if (ctx.memo.trendMap) return ctx.memo.trendMap;
  const map = new Map();
  for (const row of ctx.trending || []) {
    if (!row) continue;
    const id = row.player_id != null ? row.player_id : row.id;
    const count = Number(row.count);
    if (id == null || !Number.isFinite(count)) continue;
    map.set(String(id), count);
  }
  ctx.memo.trendMap = map;
  return map;
}

/**
 * How many managers added this player in the trending window.
 * @param {object} ctx
 * @param {string} id
 * @returns {number|null} null when he is not trending (or nothing was loaded)
 */
export function trendCount(ctx, id) {
  const hit = trendMap(ctx).get(String(id));
  return hit === undefined ? null : hit;
}

/** This league's waiver window in days (0 is legal and means "no window at all"). */
function clearDays(ctx) {
  const days = Number(ctx.league && ctx.league.waiverClearDays);
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_WAIVER_CLEAR_DAYS;
}

/** A transaction that actually happened (Sleeper also stores failed claims). */
function settled(txn) {
  const status = txn && txn.status;
  return !status || status === "complete" || status === "unknown";
}

/**
 * Can this player be added right now, or is he still sitting on waivers?
 *
 * The Sleeper fact this whole feature turns on (R4 / 002 memory): a player OUTSIDE the waiver
 * window is a $0 INSTANT add even in a FAAB league — the budget only ever buys a contested claim.
 * `created` on the drop transaction is the moment that clock started.
 * @param {object} ctx
 * @param {string} id
 * @returns {{status:"free"|"waivers", clearsAt:string|null, clearsAtMs:number|null,
 *            droppedBy:number|null, droppedAt:number|null, ageMs:number|null, unknown:boolean}}
 */
export function waiverStatus(ctx, id) {
  const free = (extra) => ({
    status: "free",
    clearsAt: null,
    clearsAtMs: null,
    droppedBy: null,
    droppedAt: null,
    ageMs: null,
    unknown: false,
    ...extra,
  });
  // No clock, no window: nothing can be measured, so nothing is asserted.
  if (ctx.now == null) return free({ unknown: true });

  // The newest move that touched this player. A trade lists him in adds AND drops, and an add
  // after a drop means somebody already claimed him — neither is a live waiver window.
  let latest = null;
  for (const txn of ctx.transactions || []) {
    if (!txn || !settled(txn)) continue;
    const dropRoster = txn.drops ? txn.drops[id] : undefined;
    const addRoster = txn.adds ? txn.adds[id] : undefined;
    if (dropRoster === undefined && addRoster === undefined) continue;
    const created = Number(txn.created) || 0;
    if (!latest || created > latest.created) latest = { created, dropRoster, addRoster };
  }
  if (!latest || latest.dropRoster == null || latest.addRoster != null) return free();

  const dropper = Number(latest.dropRoster);
  const clearsAtMs = latest.created + clearDays(ctx) * DAY_MS;
  const common = {
    droppedBy: Number.isFinite(dropper) ? dropper : null,
    droppedAt: latest.created,
    ageMs: ctx.now - latest.created,
    unknown: false,
  };
  if (ctx.now < clearsAtMs) {
    return { status: "waivers", clearsAt: new Date(clearsAtMs).toISOString(), clearsAtMs, ...common };
  }
  return { status: "free", clearsAt: null, clearsAtMs: null, ...common };
}

/**
 * The lineup the owner actually set this week — those are the players a recommendation may not
 * casually cut. Falls back to the optimal lineup when Sleeper has no starters on file.
 * @param {object} ctx
 * @param {number} rosterId
 * @returns {Set<string>}
 */
export function currentStarters(ctx, rosterId) {
  const roster = rosterById(ctx, rosterId);
  if (!roster) return new Set();
  const set = new Set((roster.starters || []).filter((id) => id && id !== "0"));
  if (set.size) return set;
  for (const slot of bestLineup(ctx, activePlayers(roster), ctx.week).slots) {
    if (slot.id) set.add(slot.id);
  }
  return set;
}

/**
 * The top of a roster by surplus — the players a free agent never displaces, however the lineup
 * math happens to fall out on one 17-week sweep.
 * @param {object} ctx
 * @param {string[]} ids
 * @param {number} [n]
 * @returns {Set<string>}
 */
export function protectedBySurplus(ctx, ids, n = PROTECTED_BY_SURPLUS) {
  const ranked = [...ids].sort(
    (a, b) => surplus(ctx, b) - surplus(ctx, a) || rosPoints(ctx, b) - rosPoints(ctx, a) || (a < b ? -1 : 1)
  );
  return new Set(ranked.slice(0, n));
}

/**
 * Players this roster may legally cut for a specific add (design.md §11.2): never a current-week
 * starter — unless the add plays the same position and outscores him THIS week, the one swap that
 * cannot cost points now — and never the top of the roster by surplus. K and DEF are starters by
 * construction, so this is also R4's SWAP_ONLY rule.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {string} addId
 * @returns {string[]}
 */
export function dropCandidates(ctx, rosterId, addId) {
  const roster = rosterById(ctx, rosterId);
  if (!roster) return [];
  const ids = activePlayers(roster);
  const starters = currentStarters(ctx, rosterId);
  const shielded = protectedBySurplus(ctx, ids);
  const addPos = playerOf(ctx, addId).pos;
  const addNow = weekPoints(ctx, addId, ctx.week);
  return ids.filter((id) => {
    if (id === addId || shielded.has(id)) return false;
    if (!starters.has(id)) return true;
    return playerOf(ctx, id).pos === addPos && addNow > weekPoints(ctx, id, ctx.week);
  });
}

/** mAdj(add) − mAdj(drop); zero for a K/DEF candidate, who is only ever worth his points.
 *  Display only since §13.5 D3 — the scored market term is `surplusDeltaOf` below. */
function valueDeltaOf(ctx, addId, dropId) {
  if (!TRADEABLE.includes(playerOf(ctx, addId).pos)) return 0;
  const add = marketValue(ctx, addId).mAdj || 0;
  const drop = dropId ? marketValue(ctx, dropId).mAdj || 0 : 0;
  return add - drop;
}

/**
 * surplus(add) − surplus(drop) — the market term FaScore actually scores (R5 §2.2 mechanism 2,
 * §5.8 check 3).
 *
 * `valueDelta` is a raw mAdj difference, and raw mAdj is not comparable across positions: the
 * wire's best free quarterback prices at 1,359 against 764 for its best free receiver, so a QB2
 * add booked a +12 point score bonus purely for being a quarterback. `surplus` (values.js) nets
 * each player against the WAIVER REPLACEMENT AT HIS OWN POSITION, which is the same number for
 * both sides of a cross-position comparison. A free agent is by construction at or below his
 * position's replacement, so an add's surplus is ~0 and the term reduces to "what the drop
 * costs" — which is exactly the honest answer.
 */
function surplusDeltaOf(ctx, addId, dropId) {
  if (!TRADEABLE.includes(playerOf(ctx, addId).pos) && !dropId) return 0;
  return surplus(ctx, addId) - (dropId ? surplus(ctx, dropId) : 0);
}

/** Remaining-season points per week for one player. */
function perWeek(ctx, id) {
  const weeks = Math.max(1, (ctx.weeksLeft || []).length);
  return rosPoints(ctx, id) / weeks;
}

/**
 * How many other free agents at the same position are close enough to be the same add. Scarcity
 * is the difference between "the only startable tight end left" and "one of nine".
 * @param {object} ctx
 * @param {string} addId
 * @returns {number}
 */
export function alternativesAt(ctx, addId) {
  const pos = playerOf(ctx, addId).pos;
  const band = ALT_BAND_PER_WEEK * Math.max(1, (ctx.weeksLeft || []).length);
  const floor = rosPoints(ctx, addId) - band;
  let n = 0;
  // the pool is sorted by remaining points, so the first same-position miss ends the count
  for (const id of freeAgentPool(ctx)) {
    if (playerOf(ctx, id).pos !== pos) continue;
    if (id === addId) continue;
    if (rosPoints(ctx, id) < floor) break;
    n += 1;
  }
  return n;
}

/**
 * How much of the budget a dollar is still worth, as a function of how much season is left.
 *
 * R9 §Q9.4 R-8 caught this curve running BACKWARDS: `0.35 + 0.65·(1 − weeksLeft/17)` rose from
 * 0.35 in week 1 to 0.96 in week 17, so the same player was bid $10 in week 1 and $27 in week 17 —
 * the opposite of every sourced FAAB heuristic ("FAAB is like a new car; it depreciates", R5 §2.3
 * [34][35]; "$1 in Week 2 buys 15 weeks of a player, $1 in Week 12 buys 5", 4for4 [R11]). The fix
 * is the same expression with the inversion removed: MONOTONE NON-INCREASING across weeks 1–17,
 * floored at `BID_PHASE_FLOOR` so a late add is never free.
 * @param {number} weeksLeft how many scoring weeks remain, this week included
 * @param {number} [seasonWeeks]
 * @returns {number} 1.0 with a full season left, `BID_PHASE_FLOOR` with none
 */
export function faabPhase(weeksLeft, seasonWeeks = SEASON_WEEKS) {
  const n = Number(weeksLeft);
  const span = Number(seasonWeeks) > 0 ? Number(seasonWeeks) : SEASON_WEEKS;
  const left = Number.isFinite(n) ? Math.min(1, Math.max(0, n / span)) : 0;
  return BID_PHASE_FLOOR + (1 - BID_PHASE_FLOOR) * left;
}

/**
 * What to bid, in FAAB units — only ever a number when the player is actually ON waivers in a
 * FAAB league. Outside the window he is free, and a bid is not a thing that exists.
 *
 * Priced as **Δ points per week × the weeks the add will actually start** (R9 §Q9.4 R-8/R-5, R5
 * §2.3): a rest-of-season add in week 2 buys fifteen weeks of the upgrade and a week-15 add buys
 * three, so the same weekly gain is worth a fifth as much [R11][R12]. The phase term on top is the
 * depreciation of the budget itself and now falls with the calendar instead of rising against it.
 * @param {object} ctx
 * @param {number} rosterId
 * @param {string} addId
 * @param {number} gainPerWeek Δ points per week the add is expected to start
 * @param {string} status
 * @param {number} [weeksCovered] how many weeks this add actually covers — a 1-week streamer, a
 *   4-week bridge, or (the default) every remaining week, capped at the season's horizon
 * @returns {{value:number, aggressive:number, remaining:number, weeksCovered:number,
 *   totalPoints:number}|null}
 */
export function suggestedBid(ctx, rosterId, addId, gainPerWeek, status, weeksCovered) {
  if (status !== "waivers") return null;
  if (Number(ctx.league && ctx.league.waiverType) !== FAAB_WAIVER_TYPE) return null;
  const roster = rosterById(ctx, rosterId);
  if (!roster) return null;
  const budget = Number(ctx.league.waiverBudget);
  const remaining = Math.max(0, (Number.isFinite(budget) ? budget : 0) - (Number(roster.waiverBudgetUsed) || 0));
  if (remaining <= 0) return null;

  const weeksLeft = (ctx.weeksLeft || []).length;
  const horizon = Math.max(1, Math.min(weeksLeft || SEASON_WEEKS, SEASON_WEEKS));
  const asked = Number(weeksCovered);
  const covered = Number.isFinite(asked) ? Math.max(0, Math.min(asked, horizon)) : horizon;
  const totalPoints = Math.max(0, Number(gainPerWeek) || 0) * covered;

  const scarcity = 1 + 0.5 * (1 - Math.min(alternativesAt(ctx, addId), 6) / 6);
  const phase = faabPhase(weeksLeft);
  const share = Math.min(MAX_BID_SHARE, totalPoints / BID_TOTAL_SCALE) * scarcity * phase;
  const value = Math.max(1, Math.min(remaining, Math.round(remaining * share)));
  const aggressive = Math.min(remaining, Math.max(value, Math.round(value * BID_AGGRESSIVE_MULT)));
  return { value, aggressive, remaining, weeksCovered: covered, totalPoints };
}

/** "6 h", "45 min", "3 d" — how long ago, in the coarsest unit that still says something. */
function agoLabel(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hours = Math.round(ms / 3600000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / DAY_MS)} d`;
}

/** "Wed 3:00 AM" in the reader's own timezone. Formatting a fixed timestamp is pure; reading the
 *  clock would not be — which is why every ms in this module was injected. */
function clockLabel(ms) {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const suffix = d.getHours() >= 12 ? "PM" : "AM";
  const hour = d.getHours() % 12 || 12;
  return `${day} ${hour}:${String(d.getMinutes()).padStart(2, "0")} ${suffix}`;
}

/** 262576 → "262k". Trending counts are league-wide and huge; the exact digits are noise. */
function countLabel(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}m`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

/** Team handle for a roster id, for "dropped by scwone". */
function teamOf(ctx, rosterId) {
  const roster = rosterById(ctx, rosterId);
  return roster ? roster.displayName || roster.teamName : `roster ${rosterId}`;
}

/**
 * The plain-English case for one add (design.md §11.2 templates). Second person when the roster
 * is the user's, the team's own handle otherwise — the same voice rule as every trade line.
 * @returns {string[]}
 */
function whyLines(ctx, row, names) {
  const v = voice(names);
  const lines = [];
  const pos = playerOf(ctx, row.add).pos || "player";

  // 1 — what he projects, against what this roster already starts at that position
  const mine = activePlayers(rosterById(ctx, row.rosterId)).filter((id) => playerOf(ctx, id).pos === pos);
  const best = mine.sort((a, b) => perWeek(ctx, b) - perWeek(ctx, a))[0] || null;
  const projects = `${nameOf(ctx, row.add)} projects ${fmt1(row.projPerWeek)} pts/wk`;
  if (!best) {
    lines.push(`${projects} and ${v.aPossLower} roster has no ${pos}.`);
  } else if (row.projPerWeek > perWeek(ctx, best)) {
    lines.push(`${projects}, ${v.aPossLower} best ${pos} is ${fmt1(perWeek(ctx, best))}.`);
  } else {
    // He is worth a spot without out-projecting the incumbent — the gain is bye and injury
    // coverage, so say which weeks it comes from instead of quoting two numbers that argue
    // against the recommendation.
    const weeks = Math.max(1, (ctx.weeksLeft || []).length);
    lines.push(
      `${projects} against ${v.aPossLower} ${fmt1(perWeek(ctx, best))} at ${pos} — he adds points in ` +
        `${row.weeksHelped} of ${weeks} remaining weeks (byes and absences).`
    );
  }

  // 2 — how to get him: a claim with a price, or a free click
  if (row.status === "waivers") {
    const head =
      row.droppedBy != null && row.ageMs != null
        ? `Dropped by ${teamOf(ctx, row.droppedBy)} ${agoLabel(row.ageMs)} ago — on`
        : "On";
    const bid = row.suggestedBid
      ? `; FAAB bid ${row.suggestedBid.value}–${row.suggestedBid.aggressive} of ${v.aPossLower} ${row.suggestedBid.remaining}.`
      : ".";
    lines.push(`${head} waivers until ${clockLabel(row.clearsAtMs)}${bid}`);
  } else if (row.unknown) {
    lines.push("Waiver window unknown without a clock — check Sleeper before claiming.");
  } else {
    lines.push("Instant add — outside the waiver window.");
  }

  // 3 — the crowd
  if (row.trend != null) lines.push(`🔥 ${countLabel(row.trend)} adds in 24 h.`);

  // 4 — the cost, named
  const playoff = (ctx.playoffWeeks || []).length
    ? `, ${row.playoffGainPerWeek >= 0 ? "+" : "-"}${fmt1(Math.abs(row.playoffGainPerWeek))} in the playoffs`
    : "";
  lines.push(
    row.drop
      ? `Drop ${nameOf(ctx, row.drop)} — ${v.aPossLower} starters gain ${fmt1(row.gainPerWeek)} pts/wk${playoff}.`
      : `Open roster spot, no drop needed — ${v.aPossLower} starters gain ${fmt1(row.gainPerWeek)} pts/wk${playoff}.`
  );

  // 5 — what the wire already does for free. THE anti-QB-bias line (§13.5 D2/D3): a backup whose
  // whole case is one bye week is competing with a streamer, not with an empty slot.
  if (row.streamedAt && row.streamedAt.weeks.length) {
    const weeks = row.streamedAt.weeks;
    lines.push(
      `Without him ${v.aPossLower} ${pos} slot is not empty in ${weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks.join(", ")}`} — ` +
        `the wire streams ${fmt1(row.streamedAt.pts)} pts there for nothing, so he only earns the margin over that.`
    );
  }

  // 5b — R5 §5.8 check 7: the wire is as good as what this roster already starts here, and the
  // add is depth rather than an upgrade. Saying it on an actual upgrade would be noise.
  if (row.streamable && row.streamable.streamable && !row.streamedAt && row.projPerWeek <= row.streamable.mine) {
    lines.push(
      `Do not pay for depth at ${pos}: the best free ${pos} projects ${fmt1(row.streamable.wire)} pts/wk against ` +
        `${v.aPossLower} own ${fmt1(row.streamable.mine)} — that slot is streamable all season.`
    );
  }

  // 6 — insurance: what he covers that nothing on the roster does
  if (row.insurancePerWeek > WHY_EPSILON) {
    lines.push(
      `Insurance: he cuts ${v.aPossLower} expected loss from an absence by ${fmt1(row.insurancePerWeek)} pts/wk.`
    );
  } else if (row.insurancePerWeek < -WHY_EPSILON) {
    lines.push(
      `The drop costs cover: ${v.aPossLower} expected loss from an absence rises ${fmt1(-row.insurancePerWeek)} pts/wk.`
    );
  }

  // 7 — his own risk, and the crowd's opinion of him
  if (row.risk && (row.risk.band === "high" || row.risk.band === "severe")) {
    lines.push(`Risk ${row.risk.band} (${Math.round(row.risk.score)}/100) — ${row.risk.reasons[0]}.`);
  }
  if (row.consensusGap != null && Math.abs(row.consensusGap) >= (row.consensusFlagAt || 2)) {
    lines.push(
      row.consensusGap > 0
        ? `Consensus disagrees: the tier sheet has him ${row.consensusGap} tiers below where his projection ranks.`
        : `Consensus disagrees: the tier sheet has him ${-row.consensusGap} tiers above where his projection ranks.`
    );
  }
  return lines;
}

/**
 * The shortlist: the best free agents per position, capped, before any lineup work.
 * @param {object} ctx
 * @param {string|null} position
 * @returns {string[]}
 */
function shortlist(ctx, position) {
  const wanted = position ? String(position).toUpperCase() : null;
  const perPos = wanted ? MAX_FA_CANDIDATES : CANDIDATES_PER_POS;
  const counts = {};
  const out = [];
  for (const id of freeAgentPool(ctx)) {
    const pos = playerOf(ctx, id).pos;
    if (wanted && pos !== wanted) continue;
    if ((counts[pos] || 0) >= perPos) continue;
    counts[pos] = (counts[pos] || 0) + 1;
    out.push(id);
    if (out.length >= MAX_FA_CANDIDATES) break;
  }
  return out;
}

/**
 * How many of the remaining weeks the swap actually scores more points in — the honest answer to
 * "why add a player my starter out-projects": byes, injuries and the weeks he wins the flex.
 * @param {object} before seasonLineup before the move
 * @param {object} after seasonLineup after it
 * @returns {number}
 */
function weeksHelped(before, after) {
  let n = 0;
  for (let i = 0; i < after.perWeek.length; i += 1) {
    const was = before.perWeek[i] ? before.perWeek[i].total : 0;
    if (after.perWeek[i].total > was + 0.01) n += 1;
  }
  return n;
}

/**
 * Where the roster is already leaning on the wire at one position, and how much that is worth
 * (§13.5 D2). This is the honest denominator for "what does a backup at this position add".
 * @param {object} ctx
 * @param {object} lineup a seasonLineup result
 * @param {string|null} pos
 * @returns {{weeks:number[], pts:number}|null}
 */
function streamedAtPosition(ctx, lineup, pos) {
  if (!pos) return null;
  const weeks = [];
  let best = 0;
  for (const s of lineup.streamed || []) {
    if (!slotEligibility(s.slot).includes(pos)) continue;
    weeks.push(s.week);
    if (s.pts > best) best = s.pts;
  }
  return weeks.length ? { weeks, pts: best } : null;
}

/**
 * Is this position one where the wire is nearly as good as what the roster already starts?
 * R5 §5.8 check 7: when `bestFA[pos] ≥ streamableShare × myStarter[pos]`, depth there is not
 * worth a roster spot — the honest advice is "don't pay for depth here", and in a 1QB, 8-team
 * league that is exactly what the quarterback position looks like.
 * @returns {{mine:number, wire:number, share:number, streamable:boolean}|null}
 */
function streamableAt(ctx, rosterId, pos, share) {
  if (!pos) return null;
  const roster = rosterById(ctx, rosterId);
  if (!roster) return null;
  const perWeekOf = (id) => {
    const weeks = ctx.weeksLeft || [];
    if (!weeks.length) return 0;
    let sum = 0;
    for (const w of weeks) sum += weekPoints(ctx, id, w);
    return sum / weeks.length;
  };
  let mine = 0;
  for (const id of activePlayers(roster)) {
    if (playerOf(ctx, id).pos !== pos) continue;
    const pts = perWeekOf(id);
    if (pts > mine) mine = pts;
  }
  let wire = 0;
  for (const id of freeAgentPool(ctx)) {
    if (playerOf(ctx, id).pos !== pos) continue;
    wire = perWeekOf(id);
    break; // the pool is sorted by remaining points, so the first at this position is the best
  }
  if (mine <= 0) return { mine, wire, share: 1, streamable: wire > 0 };
  return { mine, wire, share: wire / mine, streamable: wire / mine >= share };
}

/**
 * Free agents worth a roster spot, each paired with the player to drop for him.
 *
 * FaScore (§13.5 D3) — every term in the same unit, points per week:
 *
 *   score = gainPerWeek + κ_v·(surplusDelta/100) + κ_i·min(insurancePerWeek, cap) − κ_r·riskPenalty
 *
 * `gainPerWeek` is the same season-long lineup sweep a trade is measured on (`seasonLineup` over
 * `ctx.weeksLeft`, playoff weeks weighted by ω, roster = active − drop + add) — but since §13.5
 * D2 an empty slot is credited with what the WIRE would score there, so a QB2 in a 1QB league is
 * now worth his margin over a streamer rather than his whole projection over an empty slot. That
 * single change is what stops this list from reading "add a quarterback" every week.
 * `surplusDelta` replaces the raw market difference (R5 §2.2 mechanism 2): mAdj is not comparable
 * across positions — the wire's best free QB prices at 1,359 against 764 for its best free WR, so
 * the old `valueDelta` term paid a quarterback +0.6 of score for being a quarterback. `surplus`
 * nets every player against the replacement AT HIS OWN POSITION, so the term is position-blind.
 * `insurancePerWeek` is how much the move reduces `rosterFragility.expectedLossPerWeek` — the
 * bench cover a real handcuff provides and a third quarterback does not, capped at
 * `insuranceCap` because 42% of round-1/2 RB handcuffs make zero starts (R5 §4). `riskPenalty`
 * discounts an add's own gain by his `playerRisk` score, because a gain you cannot count on is
 * worth less. `valueDelta`, `consensusGap` and `streamable` are reported, never scored: they are
 * reasons to look, not numbers to add.
 * @param {object} ctx
 * @param {{rosterId?:number, maxResults?:number, position?:string|null, minGainPerWeek?:number,
 *          valueWeight?:number, insuranceWeight?:number, riskWeight?:number, names?:object}} [opts]
 * @returns {Array<{add:string, drop:string|null, gainPerWeek:number, playoffGainPerWeek:number,
 *   insurancePerWeek:number, riskPenalty:number, valueDelta:number, consensusGap:number|null,
 *   risk:object, status:string, clearsAt:string|null, suggestedBid:object|null,
 *   trend:number|null, why:string[], score:number}>}
 */
export function findFreeAgents(ctx, opts = {}) {
  const cfg = settingsBlock(ctx, "freeAgents");
  const rosterId = opts.rosterId != null ? opts.rosterId : ctx.myRosterId;
  const roster = rosterById(ctx, rosterId);
  if (!roster) return [];
  const pick = (key, fallback) =>
    opts[key] != null ? opts[key] : cfg[key] != null ? cfg[key] : fallback;
  const maxResults = pick("maxResults", 12);
  const minGain = pick("minGainPerWeek", 0.5);
  const kappaV = pick("valueWeight", 0.05);
  const kappaI = pick("insuranceWeight", 0.4);
  const kappaR = pick("riskWeight", 0.4);
  const insuranceCap = pick("insuranceCap", 1);
  const streamShare = pick("streamableShare", 0.8);
  const tierGap = pick("consensusTierGap", 2);
  const names = opts.names || sideNames(ctx, rosterId, null);

  const active = activePlayers(roster);
  const before = cachedSeasonLineup(ctx, active);
  const fragBefore = rosterFragility(ctx, active);
  const gaps = consensusGaps(ctx);
  const openSpot = active.length < ctx.league.maxRoster;
  const rows = [];
  const seen = new Set();

  // insurance is measured on the roster the move leaves behind, so it is a per-pair number
  const insuranceOf = (ids) => fragBefore.expectedLossPerWeek - rosterFragility(ctx, ids).expectedLossPerWeek;

  for (const add of shortlist(ctx, opts.position || null)) {
    if (seen.has(add)) continue;
    seen.add(add);

    // Signing him into a free spot bounds every (add, drop) pair — dropping a player can only
    // ever cost points — so one lineup sweep prunes most of the shortlist before the drop search.
    const ceiling = cachedSeasonLineup(ctx, [...active, add]);
    const ceilingGain = ceiling.avgPerWeek - before.avgPerWeek;
    if (ceilingGain < minGain) continue;

    let best = openSpot
      ? {
          drop: null,
          ids: [...active, add],
          gain: ceilingGain,
          playoff: ceiling.playoffAvg - before.playoffAvg,
          valueDelta: valueDeltaOf(ctx, add, null),
          surplusDelta: surplusDeltaOf(ctx, add, null),
          after: ceiling,
        }
      : null;
    if (!openSpot) {
      /** @type {object[]} */
      const options = [];
      for (const drop of dropCandidates(ctx, rosterId, add)) {
        const ids = active.filter((id) => id !== drop).concat(add);
        const after = cachedSeasonLineup(ctx, ids);
        // a drop that leaves a slot unfillable is not a move Sleeper would even let you make
        if (after.shortWeeks.length > before.shortWeeks.length) continue;
        options.push({
          drop,
          ids,
          gain: after.avgPerWeek - before.avgPerWeek,
          playoff: after.playoffAvg - before.playoffAvg,
          valueDelta: valueDeltaOf(ctx, add, drop),
          surplusDelta: surplusDeltaOf(ctx, add, drop),
          after,
        });
      }
      // Stage 1 ranks on lineup gain alone (cheap, and it is still the dominant term). Stage 2
      // re-scores only the finalists on gain + κ_i·insurance, which is what stops the engine
      // cutting the one body that covers a fragile starter to bank a tenth of a point.
      options.sort((a, b) => b.gain - a.gain || b.surplusDelta - a.surplusDelta || (a.drop < b.drop ? -1 : 1));
      for (const option of options.slice(0, DROP_FINALISTS)) {
        option.insurance = insuranceOf(option.ids);
        const objective = option.gain + kappaI * option.insurance;
        if (!best || objective > best.objective + GAIN_EPSILON) best = { ...option, objective };
      }
    }
    if (!best || best.gain < minGain) continue;

    // R5 §4: 42% of round-1/2 RB handcuffs make ZERO starts, so the credit is capped rather
    // than trusted at face value.
    const rawInsurance = best.insurance != null ? best.insurance : insuranceOf(best.ids);
    const insurancePerWeek = Math.min(rawInsurance, insuranceCap);
    const risk = playerRisk(ctx, add);
    const riskPenalty = (risk.score / 100) * Math.max(0, best.gain);
    const gap = gaps.get(add);
    const status = waiverStatus(ctx, add);
    const pos = playerOf(ctx, add).pos;
    const row = {
      rosterId,
      add,
      drop: best.drop,
      pos,
      gainPerWeek: best.gain,
      playoffGainPerWeek: best.playoff,
      insurancePerWeek,
      riskPenalty,
      valueDelta: best.valueDelta,
      surplusDelta: best.surplusDelta,
      consensusGap: gap ? gap.gap : null,
      consensusTier: gap ? gap.tier : null,
      consensusImpliedTier: gap ? gap.implied : null,
      consensusFlagAt: tierGap,
      risk,
      streamedAt: streamedAtPosition(ctx, before, pos),
      streamable: streamableAt(ctx, rosterId, pos, streamShare),
      weeksHelped: weeksHelped(before, best.after),
      projPerWeek: perWeek(ctx, add),
      value: marketValue(ctx, add).mAdj,
      status: status.status,
      clearsAt: status.clearsAt,
      clearsAtMs: status.clearsAtMs,
      droppedBy: status.droppedBy,
      ageMs: status.ageMs,
      unknown: status.unknown,
      suggestedBid: suggestedBid(ctx, rosterId, add, best.gain, status.status),
      trend: trendCount(ctx, add),
      why: [],
      // the four components and nothing else — they sum to `score` exactly, so the UI can show
      // the arithmetic rather than a black box
      score: best.gain + kappaV * (best.surplusDelta / 100) + kappaI * insurancePerWeek - kappaR * riskPenalty,
    };
    row.why = whyLines(ctx, row, names);
    rows.push(row);
  }

  rows.sort((a, b) => b.score - a.score || b.surplusDelta - a.surplusDelta || (a.add < b.add ? -1 : 1));
  return rows.slice(0, maxResults);
}

/**
 * Roster ids on a transaction, lowest first. `roster_ids` is authoritative; the adds/drops maps
 * are the fallback for a payload that omits it.
 * @param {object} txn
 * @returns {number[]}
 */
function rosterIdsOf(txn) {
  const ids = new Set();
  for (const id of txn.rosterIds || []) {
    const n = Number(id);
    if (Number.isFinite(n)) ids.add(n);
  }
  if (ids.size < 2) {
    for (const map of [txn.adds, txn.drops]) {
      for (const value of Object.values(map || {})) {
        const n = Number(value);
        if (Number.isFinite(n)) ids.add(n);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/** ids minus `remove`, plus any of `add` not already there. Order is preserved. */
function withPlayers(ids, remove, add) {
  const gone = new Set(remove);
  const out = ids.filter((id) => !gone.has(id));
  for (const id of add) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * A context in which the trade has NOT happened yet.
 *
 * Sleeper's `/rosters` already reflects every completed trade, so grading one against the live
 * rosters asks "is it fair for A to send players he no longer has" — and the answer is always
 * "invalid" (R4 §3.4 flags exactly this trap). Rewinding both rosters is cheap and safe: a trade
 * moves players BETWEEN rosters and never changes the SET of rostered ids, so every memoized
 * value that depends on the league as a whole (replacement level, the free-agent pool, the value
 * curve) is identical. Only the per-roster caches are dropped.
 * @returns {object} ctx, or the same ctx when the trade is still a proposal
 */
function rewindContext(ctx, a, b, give, get) {
  const rosterA = rosterById(ctx, a);
  const rosterB = rosterById(ctx, b);
  if (!rosterA || !rosterB) return ctx;
  const onA = new Set(rosterA.players);
  const onB = new Set(rosterB.players);
  const proposed = give.every((id) => onA.has(id)) && get.every((id) => onB.has(id));
  if (proposed) return ctx; // nothing to rewind: the players are still where the trade found them

  const patch = (roster, remove, add) => ({
    ...roster,
    players: withPlayers(roster.players, remove, add),
    starters: roster.starters.filter((id) => !remove.includes(id)),
    reserve: roster.reserve.filter((id) => !remove.includes(id)),
    taxi: roster.taxi.filter((id) => !remove.includes(id)),
  });
  const rewound = new Map([
    [a, patch(rosterA, get, give)],
    [b, patch(rosterB, give, get)],
  ]);
  const rosters = ctx.rosters.map((r) => rewound.get(r.rosterId) || r);
  const rosterOf = new Map(ctx.rosterOf);
  for (const id of give) rosterOf.set(id, a);
  for (const id of get) rosterOf.set(id, b);
  // share the league-wide memo (identical either way); drop only what is keyed by roster
  const memo = { ...ctx.memo };
  delete memo.tradePool;
  delete memo.positionalSurplus;
  return { ...ctx, rosters, rosterOf, memo };
}

/**
 * Grade a trade: both sides, each in its own voice, from the state the trade was made in.
 * @param {object} ctx
 * @param {object} txn normalized transaction
 * @returns {object|null}
 */
function gradeTrade(ctx, txn) {
  const [a, b] = rosterIdsOf(txn);
  if (a == null || b == null) return null;
  const adds = txn.adds || {};
  const drops = txn.drops || {};
  const give = [];
  const get = [];
  const seen = new Set();
  for (const [id, to] of Object.entries(adds)) {
    seen.add(id);
    if (Number(to) === a) get.push(id);
    else if (Number(to) === b) give.push(id);
  }
  // a payload that only records the losing side still names both halves
  for (const [id, from] of Object.entries(drops)) {
    if (seen.has(id)) continue;
    if (Number(from) === a) give.push(id);
    else if (Number(from) === b) get.push(id);
  }

  const namesA = sideNames(ctx, a, b);
  const namesB = sideNames(ctx, b, a);
  const evalCtx = rewindContext(ctx, a, b, give, get);
  const result = evaluateTrade(evalCtx, { myRosterId: a, theirRosterId: b, give, get }, { names: namesA });
  // side B's verdict is B's own engine run, not A's negated: their backfill, their overrides
  const mirror = evaluateTrade(
    evalCtx,
    { myRosterId: b, theirRosterId: a, give: get, get: give },
    { names: namesB }
  );

  return {
    type: "trade",
    id: txn.id || null,
    week: txn.week != null ? txn.week : null,
    created: txn.created != null ? txn.created : null,
    a,
    b,
    give,
    get,
    result,
    mirror,
    edgeA: result.verdict.edgePct,
    deltaA: result.verdict.deltaPerWeek,
    edgeB: mirror.verdict.edgePct,
    deltaB: mirror.verdict.deltaPerWeek,
    labelA: result.verdict.label,
    labelB: mirror.verdict.label,
    codeA: result.verdict.code,
    codeB: mirror.verdict.code,
    acceptance: result.verdict.acceptance,
    draftPicks: (txn.draftPicks || []).length,
  };
}

/**
 * Grade an add/drop: what the move did to that roster's starting lineup, on the same axis as a
 * trade. The live roster already contains the add, so "before" is that roster rewound one move.
 * @param {object} ctx
 * @param {object} txn
 * @returns {object|null}
 */
function gradeAdd(ctx, txn) {
  const adds = Object.entries(txn.adds || {});
  const drops = Object.entries(txn.drops || {});
  const first = (txn.rosterIds || [])[0];
  const rosterId = Number(first != null ? first : (adds[0] || drops[0] || [])[1]);
  const roster = rosterById(ctx, rosterId);
  if (!roster) return null;
  const addIds = adds.filter(([, r]) => Number(r) === rosterId).map(([id]) => id);
  const dropIds = drops.filter(([, r]) => Number(r) === rosterId).map(([id]) => id);

  const after = withPlayers(activePlayers(roster), dropIds, addIds);
  const before = withPlayers(after, addIds, dropIds);
  const afterLineup = cachedSeasonLineup(ctx, after);
  const beforeLineup = cachedSeasonLineup(ctx, before);
  const gainPerWeek = afterLineup.avgPerWeek - beforeLineup.avgPerWeek;
  const playoffGainPerWeek = afterLineup.playoffAvg - beforeLineup.playoffAvg;

  const add = addIds[0] || null;
  const drop = dropIds[0] || null;
  const v = voice(sideNames(ctx, rosterId, null));
  const moved = gainPerWeek >= 0 ? "gain" : "lose";
  const why = [];
  if (add) {
    why.push(
      `${teamOf(ctx, rosterId)} added ${nameOf(ctx, add)}${drop ? ` for ${nameOf(ctx, drop)}` : ""} — ` +
        `${v.aPossLower} starters ${moved} ${fmt1(Math.abs(gainPerWeek))} pts/wk.`
    );
  } else if (drop) {
    why.push(
      `${teamOf(ctx, rosterId)} dropped ${nameOf(ctx, drop)} — ` +
        `${v.aPossLower} starters ${moved} ${fmt1(Math.abs(gainPerWeek))} pts/wk.`
    );
  }

  return {
    type: txn.type || "free_agent",
    id: txn.id || null,
    week: txn.week != null ? txn.week : null,
    created: txn.created != null ? txn.created : null,
    rosterId,
    add,
    drop,
    adds: addIds,
    drops: dropIds,
    gainPerWeek,
    playoffGainPerWeek,
    valueDelta: add ? valueDeltaOf(ctx, add, drop) : 0,
    why,
  };
}

/**
 * Grade one league transaction — the League tab's "who won that trade" and the alerts job's
 * notification body (design.md §11.2, §11.3). Trades run through `evaluateTrade`; adds, waiver
 * claims and commissioner moves run through the same lineup math.
 * @param {object} ctx
 * @param {object} txn normalized transaction (data.js `getTransactions`)
 * @returns {object|null} null when there is nothing to grade (picks only, empty, unknown roster)
 */
export function gradeTransaction(ctx, txn) {
  if (!txn) return null;
  if (txn.type === "trade") return gradeTrade(ctx, txn);
  const moves = Object.keys(txn.adds || {}).length + Object.keys(txn.drops || {}).length;
  if (!moves) return null;
  return gradeAdd(ctx, txn);
}
