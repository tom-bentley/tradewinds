// src/engine/explain.js — plain-English rendering of a TradeResult (R3 §g templates).
// One sentence per slot; only the slots that fire are rendered. Every number is shown to one
// decimal so the phone UI never has to re-format.

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
 * @returns {string}
 */
export function flagText(ctx, flag) {
  switch (flag.type) {
    case "deadline":
      return `Trade deadline has passed — it was week ${flag.week}, and it is week ${flag.now}.`;
    case "short":
      return `Invalid — leaves ${flag.side === "them" ? "them" : "you"} short at ${flag.slot} in week ${flag.week}.`;
    case "roster_size": {
      const theirs = flag.side === "them";
      const who = theirs ? "They must drop" : "Requires dropping";
      const whose = theirs ? "their" : "your";
      return flag.drop
        ? `${who} ${nameOf(ctx, flag.drop)} — ${whose} roster would hold ${flag.count} of ${flag.max}.`
        : `${theirs ? "Their" : "Your"} roster would hold ${flag.count} of ${flag.max} — a drop is required.`;
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
      return `Prices unsettled on ${flag.side === "them" ? "their" : "your"} side — recent value swings exceed ${fmt0(UNSETTLED_SHARE * 100)}% of it.`;
    default:
      return flag.text || "";
  }
}

/**
 * Render a TradeResult as a headline plus the reason lines that fire.
 * @param {object} ctx
 * @param {object} result TradeResult from evaluateTrade
 * @returns {{headline:string, lines:Array<{kind:string, text:string}>}}
 */
export function explain(ctx, result) {
  const lines = [];
  const v = result.verdict;
  const me = result.me;
  const them = result.them;
  const edge = Number(v.edgePct) || 0;
  const dpw = Number(v.deltaPerWeek) || 0;

  const headline =
    `${v.label}: you ${edge >= 0 ? "win" : "lose"} by ${fmt1(Math.abs(edge))}% ` +
    `and ${dpw >= 0 ? "gain" : "lose"} ${fmt1(Math.abs(dpw))} pts/week.`;
  lines.push({ kind: "headline", text: headline });

  // BEST — who gets the best player in the deal
  if (result.best && result.best.id) {
    lines.push({
      kind: "best",
      text: `${nameOf(ctx, result.best.id)} (${badge(ctx, result.best.id)}) is the best player in the deal — ${
        result.best.side === "me" ? "you get" : "they get"
      } him.`,
    });
  }

  // CONSOL / SHALLOW — the consolidation credit, in the league's own waiver terms
  const n = result.give.length;
  const m = result.get.length;
  if (n !== m) {
    const consolidating = n > m; // I send more bodies than I get back
    const detail = consolidating ? me.backfillDetail || [] : them.backfillDetail || [];
    const freed = Math.abs(n - m);
    const w = waiverReplacement(ctx);
    // name the spot by what actually filled it; with no backfill on record, price it as a FLEX
    let pos = detail.length ? detail[0].pos : null;
    if (pos == null || w.best[pos] == null) {
      pos = ["RB", "WR", "TE"].reduce((best, p) => (w[p] > w[best] ? p : best), "RB");
    }
    const bestFa = w.best[pos] || null;
    lines.push({
      kind: "consol",
      text:
        `${consolidating ? "You" : "They"} send ${consolidating ? n : m} and get ${consolidating ? m : n}; ` +
        `the ${freed} freed spot${freed === 1 ? "" : "s"} is worth ~${fmt0(w[pos] || 0)} here` +
        (bestFa ? `, where the best free ${pos} is ${nameOf(ctx, bestFa.id)} (${fmt0(bestFa.m)}).` : "."),
    });
    if (bestFa) {
      const mv = marketValue(ctx, bestFa.id);
      if (mv.rosterPct != null && mv.rosterPct >= FREE_ELSEWHERE_PCT) {
        lines.push({
          kind: "shallow",
          text: `${nameOf(ctx, bestFa.id)} is rostered in ${fmt1(mv.rosterPct)}% of leagues but is free in ours — ${ctx.league.numTeams} teams is shallow.`,
        });
      }
    }
  }

  // LINEUP
  const dpo = Number(v.deltaPlayoffPerWeek) || 0;
  lines.push({
    kind: "lineup",
    text:
      `Your starters ${dpw >= 0 ? "gain" : "lose"} ${fmt1(Math.abs(dpw))} pts/week, ` +
      `${dpo >= 0 ? "+" : "-"}${fmt1(Math.abs(dpo))} in the weeks ${ctx.playoffWeeks[0]}-${
        ctx.playoffWeeks[ctx.playoffWeeks.length - 1]
      } playoffs.`,
  });

  // RISK — one line per non-block flag that names a player
  for (const flag of result.flags || []) {
    if (flag.severity === "block") continue;
    if (!["injury", "free_elsewhere", "trend", "bye", "coverage", "unsettled"].includes(flag.type)) continue;
    lines.push({ kind: "risk", text: flag.text || flagText(ctx, flag) });
  }

  // RIVAL — both of the numbers they will look at, then the call
  const rival = rosterById(ctx, result.theirRosterId);
  const theirEdge = Number(them.edgePct) || 0;
  const theirDpw = Number(them.lineup && them.lineup.deltaPerWeek) || 0;
  lines.push({
    kind: "rival",
    text:
      `${(rival && rival.teamName) || "They"} ${theirEdge >= 0 ? "gains" : "loses"} ${fmt1(Math.abs(theirEdge))}% ` +
      `and ${theirDpw >= 0 ? "gains" : "loses"} ${fmt1(Math.abs(theirDpw))} pts/week — ` +
      `${acceptancePhrase(v.acceptance)}.`,
  });

  // VETO
  if (v.veto) {
    lines.push({
      kind: "veto",
      text: `Lopsided — ${ctx.league.vetoVotesNeeded} of ${ctx.league.numTeams} owners can veto within ${
        ctx.league.tradeReviewDays * 24
      } hours.`,
    });
  }

  // BLOCK — hard stoppers last so they read as the closing word
  for (const flag of result.flags || []) {
    if (flag.severity !== "block") continue;
    lines.push({ kind: "block", text: flag.text || flagText(ctx, flag) });
  }

  return { headline, lines };
}
