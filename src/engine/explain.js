// src/engine/explain.js — plain-English rendering of a TradeResult (R3 §g templates).
// One sentence per slot; only the slots that fire are rendered. Every number is shown to one
// decimal so the phone UI never has to re-format.
//
// Every template speaks in one of two voices (design.md §10.3): second person when side A is the
// user ("you win by 7%, your starters gain 2.7"), third person when the trade is between two other
// teams ("hobbezilla wins by 7%, hobbezilla's starters gain 2.7"). `names` carries the voice.

import { playerOf, rosterById } from "./context.js";
import { marketValue, waiverReplacement } from "./values.js";

/** A 30-day FantasyCalc move this large is worth calling out in the explanation. */
export const TREND_FLAG = 400;
/** Below this roster share a player is "probably free in most leagues" (R3 §d). */
export const FREE_ELSEWHERE_PCT = 50;
/** Σ |price std-dev| above this share of a side's surplus means "prices unsettled" (R3 §d). */
export const UNSETTLED_SHARE = 0.05;
/** FantasyCalc's `maybeTier` is an OVERALL tier running 1..42 over 199 players — only the top of
 *  it separates anybody (tiers 1-12 hold 1-2 players each). Deeper numbers are noise, so they are
 *  never shown. */
export const MAX_MEANINGFUL_TIER = 12;

/** Shown when a roster id names no team in this league. */
const UNKNOWN_A = "Team A";
const UNKNOWN_B = "the other team";

/**
 * A team's short display name — the handle owners actually call each other by.
 * @param {object} ctx
 * @param {number|null} rosterId
 * @param {string} fallback
 * @returns {string}
 */
function teamLabel(ctx, rosterId, fallback) {
  const roster = rosterById(ctx, rosterId);
  return (roster && (roster.displayName || roster.teamName)) || fallback;
}

/**
 * Second-person names: side A is the user reading the screen.
 * @param {object} ctx
 * @param {number|null} bRosterId
 * @returns {{a:string, aPoss:string, b:string, first:boolean}}
 */
export function defaultNames(ctx, bRosterId) {
  return { a: "You", aPoss: "Your", b: teamLabel(ctx, bRosterId, UNKNOWN_B), first: true };
}

/**
 * The voice to explain a trade in: second person when side A is the user, third person (both teams
 * named) otherwise — including viewer mode, where `ctx.myRosterId` is null (design.md §10.3).
 * @param {object} ctx
 * @param {number|null} aRosterId
 * @param {number|null} bRosterId
 * @returns {{a:string, aPoss:string, b:string, first:boolean}}
 */
export function sideNames(ctx, aRosterId, bRosterId) {
  if (aRosterId != null && ctx.myRosterId != null && aRosterId === ctx.myRosterId) {
    return defaultNames(ctx, bRosterId);
  }
  const a = teamLabel(ctx, aRosterId, UNKNOWN_A);
  return { a, aPoss: `${a}'s`, b: teamLabel(ctx, bRosterId, UNKNOWN_B), first: false };
}

/**
 * Fill in whatever the caller left out. `explain` and `evaluateTrade` default to second person
 * (design.md §10.3); the UI passes `sideNames(...)` for third-party trades.
 * @param {object} ctx
 * @param {object|null|undefined} names
 * @param {number|null} aRosterId
 * @param {number|null} bRosterId
 * @returns {{a:string, aPoss:string, b:string, first:boolean}}
 */
export function resolveNames(ctx, names, aRosterId, bRosterId) {
  const base = defaultNames(ctx, bRosterId);
  if (!names) return base;
  const first = names.first !== undefined ? !!names.first : base.first;
  const a = names.a != null ? names.a : first ? base.a : teamLabel(ctx, aRosterId, UNKNOWN_A);
  return {
    a,
    aPoss: names.aPoss != null ? names.aPoss : first ? base.aPoss : `${a}'s`,
    b: names.b != null ? names.b : base.b,
    first,
  };
}

/**
 * The pronoun/verb kit every template reads, so "you win" and "hobbezilla wins" come from one
 * place. `s` is the third-person verb ending: `win${v.s}` reads correctly in both voices.
 * @param {object} names
 * @returns {{first:boolean, a:string, b:string, aSubject:string, bSubject:string, aPoss:string,
 *            aPossLower:string, bPossLower:string, s:string}}
 */
export function voice(names) {
  const n = names || {};
  const first = n.first !== false;
  const a = n.a != null ? n.a : first ? "You" : UNKNOWN_A;
  const b = n.b != null ? n.b : UNKNOWN_B;
  const aPoss = n.aPoss != null ? n.aPoss : first ? "Your" : `${a}'s`;
  return {
    first,
    a,
    b,
    aSubject: first ? "you" : a,
    bSubject: first ? "they" : b,
    // sentence-start forms: pronouns capitalize, team handles are left exactly as their owner
    // types them ("hobbezilla's starters gain 2.7")
    aStart: first ? "You" : a,
    bStart: first ? "They" : b,
    aPoss,
    aPossLower: first ? aPoss.toLowerCase() : aPoss,
    aPossStart: first ? cap(aPoss) : aPoss,
    bPossLower: first ? "their" : `${b}'s`,
    bPossStart: first ? "Their" : `${b}'s`,
    // second person ("you win", "they gain") takes no -s; a named team does
    s: first ? "" : "s",
  };
}

/**
 * The tier to display for a player, or null when the number is too deep to mean anything.
 * @param {number|null} tier raw tier from marketValue()
 * @returns {number|null}
 */
export function displayTier(tier) {
  return tier != null && tier <= MAX_MEANINGFUL_TIER ? tier : null;
}

/**
 * How to phrase a rival's acceptance tier.
 * @param {"likely"|"possible"|"unlikely"} acceptance
 * @returns {string}
 */
export function acceptancePhrase(acceptance) {
  if (acceptance === "likely") return "likely to accept";
  if (acceptance === "possible") return "might accept";
  return "unlikely to accept";
}

/**
 * Format a number to one decimal.
 * @param {number} n
 * @returns {string}
 */
export function fmt1(n) {
  return (Math.round((Number(n) || 0) * 10) / 10).toFixed(1);
}

/**
 * Format a whole-number value (market values are big and noisy; decimals are noise).
 * @param {number} n
 * @returns {string}
 */
export function fmt0(n) {
  return String(Math.round(Number(n) || 0));
}

/**
 * Player display name.
 * @param {object} ctx
 * @param {string} id
 * @returns {string}
 */
export function nameOf(ctx, id) {
  return playerOf(ctx, id).name || id;
}

/**
 * Comma-joined player names.
 * @param {object} ctx
 * @param {string[]} ids
 * @returns {string}
 */
export function namesOf(ctx, ids) {
  return (ids || []).map((id) => nameOf(ctx, id)).join(", ");
}

/**
 * "RB3, tier 2" style badge for a player.
 * @param {object} ctx
 * @param {string} id
 * @returns {string}
 */
function badge(ctx, id) {
  const mv = marketValue(ctx, id);
  const p = playerOf(ctx, id);
  const posRank = mv.posRank != null ? `${p.pos}${mv.posRank}` : p.pos || "?";
  const tier = displayTier(mv.tier);
  return tier != null ? `${posRank}, tier ${tier}` : posRank;
}

/**
 * Text for one flag, by type. Used by trade.js so flags and reasons speak the same language.
 * @param {object} ctx
 * @param {{type:string, [k:string]:any}} flag
 * @param {object} [names] voice (defaults to second person)
 * @returns {string}
 */
export function flagText(ctx, flag, names) {
  const v = voice(names);
  switch (flag.type) {
    case "deadline":
      return `Trade deadline has passed — it was week ${flag.week}, and it is week ${flag.now}.`;
    case "short": {
      const who = flag.side === "them" ? (v.first ? "them" : v.b) : v.first ? "you" : v.a;
      return `Invalid — leaves ${who} short at ${flag.slot} in week ${flag.week}.`;
    }
    case "roster_size": {
      const theirs = flag.side === "them";
      const whose = theirs ? v.bPossLower : v.aPossLower;
      const whoseStart = theirs ? v.bPossStart : v.aPossStart;
      if (!flag.drop) return `${whoseStart} roster would hold ${flag.count} of ${flag.max} — a drop is required.`;
      const who = v.first
        ? theirs
          ? "They must drop"
          : "Requires dropping"
        : `${theirs ? v.b : v.a} must drop`;
      return `${who} ${nameOf(ctx, flag.drop)} — ${whose} roster would hold ${flag.count} of ${flag.max}.`;
    }
    case "injury":
      return `${nameOf(ctx, flag.id)} is ${flag.status}.`;
    case "bye":
      return `${nameOf(ctx, flag.id)} is on bye in week ${flag.week}.`;
    case "coverage":
      return `${nameOf(ctx, flag.id)} has no market price — value is estimated from the projection curve.`;
    case "free_elsewhere":
      return `${nameOf(ctx, flag.id)} is rostered in only ${fmt1(flag.rosterPct)}% of leagues — probably free.`;
    case "trend":
      return `${nameOf(ctx, flag.id)} is ${flag.trend > 0 ? "+" : ""}${fmt0(flag.trend)} over 30 days — the market is ${flag.trend > 0 ? "chasing" : "fleeing"} him.`;
    case "unsettled":
      return `Prices unsettled on ${flag.side === "them" ? v.bPossLower : v.aPossLower} side — recent value swings exceed ${fmt0(UNSETTLED_SHARE * 100)}% of it.`;
    default:
      return flag.text || "";
  }
}

/** Capitalize the first letter, leaving the rest of a team name alone. */
function cap(text) {
  const s = String(text || "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** |Edge%| below this reads as "even on value" in the headline. */
const EVEN_EDGE_PCT = 0.5;
/** |ΔL_pw| below this reads as "no change to your starters". */
const EVEN_DELTA_PW = 0.05;

/**
 * Render a TradeResult as a headline plus the reason lines that fire.
 * @param {object} ctx
 * @param {object} result TradeResult from evaluateTrade
 * @param {{names?:object}} [opts] `names` = { a, aPoss, b, first } (design.md §10.3)
 * @returns {{headline:string, lines:Array<{kind:string, text:string}>}}
 */
export function explain(ctx, result, opts = {}) {
  const names = resolveNames(ctx, opts.names, result.myRosterId, result.theirRosterId);
  const v = voice(names);
  const lines = [];
  const verdict = result.verdict;
  const me = result.me;
  const them = result.them;
  const edge = Number(verdict.edgePct) || 0;
  const dpw = Number(verdict.deltaPerWeek) || 0;

  // Below half a percent the value axis is a wash — say so instead of "lose by 0%".
  const evenValue = Math.abs(edge) < EVEN_EDGE_PCT;
  const evenLineup = Math.abs(dpw) < EVEN_DELTA_PW;
  const valuePhrase = evenValue
    ? "even on value"
    : `${v.aSubject} ${edge >= 0 ? "win" : "lose"}${v.s} by ${fmt1(Math.abs(edge))}% on value`;
  const lineupPhrase = evenLineup
    ? `no change to ${v.aPossLower} starters`
    : // the value clause already named the subject unless it was a wash
      `${evenValue ? `${v.aSubject} ` : ""}${dpw >= 0 ? "gain" : "lose"}${v.s} ${fmt1(Math.abs(dpw))} pts/week`;
  const headline = `${verdict.label}: ${valuePhrase}, ${lineupPhrase}.`;
  lines.push({ kind: "headline", text: headline });

  // BEST — who gets the best player in the deal
  if (result.best && result.best.id) {
    const winner = result.best.side === "me" ? v.aSubject : v.bSubject;
    lines.push({
      kind: "best",
      text: `${nameOf(ctx, result.best.id)} (${badge(ctx, result.best.id)}) is the best player in the deal — ${winner} get${v.s} him.`,
    });
  }

  // CONSOL / SHALLOW — the consolidation credit, in the league's own waiver terms
  const n = result.give.length;
  const m = result.get.length;
  if (n !== m) {
    const consolidating = n > m; // side A sends more bodies than it gets back
    const detail = consolidating ? me.backfillDetail || [] : them.backfillDetail || [];
    const freed = Math.abs(n - m);
    const w = waiverReplacement(ctx);
    // name the spot by what actually filled it; with no backfill on record, price it as a FLEX
    let pos = detail.length ? detail[0].pos : null;
    if (pos == null || w.best[pos] == null) {
      pos = ["RB", "WR", "TE"].reduce((best, p) => (w[p] > w[best] ? p : best), "RB");
    }
    const bestFa = w.best[pos] || null;
    const sender = consolidating ? v.aStart : v.bStart;
    lines.push({
      kind: "consol",
      text:
        `${sender} send${v.s} ${consolidating ? n : m} and get${v.s} ${consolidating ? m : n}; ` +
        `the ${freed} freed spot${freed === 1 ? "" : "s"} is worth ~${fmt0(w[pos] || 0)} here` +
        (bestFa ? `, where the best free ${pos} is ${nameOf(ctx, bestFa.id)} (${fmt0(bestFa.m)}).` : "."),
    });
    if (bestFa) {
      const mv = marketValue(ctx, bestFa.id);
      if (mv.rosterPct != null && mv.rosterPct >= FREE_ELSEWHERE_PCT) {
        lines.push({
          kind: "shallow",
          text: `${nameOf(ctx, bestFa.id)} is rostered in ${fmt1(mv.rosterPct)}% of leagues but is free in ${
            v.first ? "ours" : "this one"
          } — ${ctx.league.numTeams} teams is shallow.`,
        });
      }
    }
  }

  // LINEUP — "starters" is plural in both voices, so the verb never takes an -s here
  const dpo = Number(verdict.deltaPlayoffPerWeek) || 0;
  const playoffs = ctx.playoffWeeks || [];
  const playoffClause = playoffs.length
    ? `, ${dpo >= 0 ? "+" : "-"}${fmt1(Math.abs(dpo))} in the weeks ${playoffs[0]}-${playoffs[playoffs.length - 1]} playoffs`
    : "";
  lines.push({
    kind: "lineup",
    text: `${v.aPossStart} starters ${dpw >= 0 ? "gain" : "lose"} ${fmt1(Math.abs(dpw))} pts/week${playoffClause}.`,
  });

  // RISK — one line per non-block flag that names a player
  for (const flag of result.flags || []) {
    if (flag.severity === "block") continue;
    if (!["injury", "free_elsewhere", "trend", "bye", "coverage", "unsettled"].includes(flag.type)) continue;
    lines.push({ kind: "risk", text: flagText(ctx, flag, names) });
  }

  // RIVAL — both of the numbers side B will look at, then the call. Always names side B.
  const theirEdge = Number(them.edgePct) || 0;
  const theirDpw = Number(them.lineup && them.lineup.deltaPerWeek) || 0;
  lines.push({
    kind: "rival",
    text:
      `${v.b} ${theirEdge >= 0 ? "gains" : "loses"} ${fmt1(Math.abs(theirEdge))}% ` +
      `and ${theirDpw >= 0 ? "gains" : "loses"} ${fmt1(Math.abs(theirDpw))} pts/week — ` +
      `${acceptancePhrase(verdict.acceptance)}.`,
  });

  // VETO
  if (verdict.veto) {
    const hours = (Number(ctx.league.tradeReviewDays) || 0) * 24;
    const window = hours ? ` within ${hours} hours` : "";
    const votes = Number(ctx.league.vetoVotesNeeded) || 0;
    lines.push({
      kind: "veto",
      text: votes
        ? `Lopsided — ${votes} of ${ctx.league.numTeams} owners can veto${window}.`
        : `Lopsided — subject to commissioner review${window}.`,
    });
  }

  // BLOCK — hard stoppers last so they read as the closing word
  for (const flag of result.flags || []) {
    if (flag.severity !== "block") continue;
    lines.push({ kind: "block", text: flag.text || flagText(ctx, flag, names) });
  }

  return { headline, lines };
}
