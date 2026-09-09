// FantasyCalc source: crowd trade values, redraft and dynasty, keyed by sleeperId.
// https://api.fantasycalc.com/values/current?isDynasty=&numQbs=&numTeams=&ppr=
// CORS `*` (R1) — the browser re-fetches this live; the pipeline copy is the offline fallback.
//
// Since design §10.2 the pipeline is league-agnostic and ships four committed tables: redraft
// and dynasty, each in a 1QB and a 2QB variant. `numTeams`/`ppr` move values <= 2 % (R3), so the
// committed copies pin 12-team half-PPR; only `numQbs` gets its own table.

import { compact, fetchJson, isoTimestamp, numOrNull, orderedById } from "../util.mjs";

export const FANTASYCALC_API = "https://api.fantasycalc.com/values/current";

/** League shape the committed tables are pinned to (design §10.2). */
export const FC_NUM_TEAMS = 12;
export const FC_PPR = 0.5;

/** FantasyCalc reports roster share as 0..1; the contract wants a percentage. */
const ROSTER_PERCENT_SCALE = 100;

/**
 * The four committed FantasyCalc tables, in values.json id order.
 * @type {{ id: string, isDynasty: boolean, numQbs: number, label: string, kind: string }[]}
 */
export const FC_TABLES = [
  { id: "fc_dynasty", isDynasty: true, numQbs: 1, label: "FantasyCalc dynasty 1QB", kind: "dynasty" },
  { id: "fc_dynasty_2qb", isDynasty: true, numQbs: 2, label: "FantasyCalc dynasty 2QB", kind: "dynasty" },
  { id: "fc_redraft", isDynasty: false, numQbs: 1, label: "FantasyCalc redraft 1QB", kind: "redraft" },
  { id: "fc_redraft_2qb", isDynasty: false, numQbs: 2, label: "FantasyCalc redraft 2QB", kind: "redraft" },
];

/**
 * @param {{ isDynasty: boolean, numQbs: number, numTeams?: number, ppr?: number }} options
 * @returns {string}
 */
export function fantasyCalcUrl({ isDynasty, numQbs, numTeams = FC_NUM_TEAMS, ppr = FC_PPR }) {
  return `${FANTASYCALC_API}?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
}

/**
 * Raw FantasyCalc rows -> contract `values` map. Rows without a sleeperId are
 * dropped: the app has no other way to join them.
 * @param {any[]} rows
 * @returns {{ values: Record<string, Record<string, number>>, dropped: number }}
 */
export function normalizeFantasyCalc(rows) {
  /** @type {Record<string, Record<string, number>>} */
  const values = {};
  let dropped = 0;
  if (!Array.isArray(rows)) return { values, dropped };

  for (const row of rows) {
    const sleeperId = row?.player?.sleeperId;
    if (typeof sleeperId !== "string" || sleeperId === "") {
      dropped += 1;
      continue;
    }
    const rosterPercent = numOrNull(row.maybeRosterPercent);
    values[sleeperId] = compact({
      v: numOrNull(row.value),
      r: numOrNull(row.overallRank),
      pr: numOrNull(row.positionRank),
      t: numOrNull(row.trend30Day),
      tier: numOrNull(row.maybeTier),
      adp: numOrNull(row.maybeAdp),
      tf: numOrNull(row.maybeTradeFrequency),
      rp: rosterPercent === null ? null : rosterPercent * ROSTER_PERCENT_SCALE,
      sd: numOrNull(row.maybeMovingStandardDeviation),
    });
  }
  return { values: orderedById(values), dropped };
}

/**
 * Fetch one FantasyCalc table in data/values.json source shape.
 * @param {{ isDynasty: boolean, numQbs: number, label: string, kind: string,
 *   numTeams?: number, ppr?: number }} options
 * @returns {Promise<{ label: string, kind: string, variant: { numQbs: number },
 *   fetched_at: string, ok: true, count: number, url: string,
 *   values: Record<string, Record<string, number>>, dropped: number }>}
 */
export async function fetchFantasyCalcTable(options) {
  const { isDynasty, numQbs, label, kind, numTeams = FC_NUM_TEAMS, ppr = FC_PPR } = options;
  const url = fantasyCalcUrl({ isDynasty, numQbs, numTeams, ppr });
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error(`unexpected FantasyCalc payload from ${url}`);
  const { values, dropped } = normalizeFantasyCalc(rows);
  return {
    label,
    kind,
    variant: { numQbs },
    fetched_at: isoTimestamp(),
    ok: true,
    count: Object.keys(values).length,
    url,
    values,
    dropped,
  };
}
