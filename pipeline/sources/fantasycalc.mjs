// FantasyCalc source: crowd trade values, redraft and dynasty, keyed by sleeperId.
// https://api.fantasycalc.com/values/current?isDynasty=&numQbs=&numTeams=&ppr=
// CORS `*` (R1) — the browser re-fetches this live; the pipeline copy is the offline fallback.

import { compact, fetchJson, isoTimestamp, numOrNull, orderedById } from "../util.mjs";

export const FANTASYCALC_API = "https://api.fantasycalc.com/values/current";

/** Roster slots that consume a quarterback, for FantasyCalc's `numQbs`. */
const QB_SLOTS = new Set(["QB", "SUPER_FLEX"]);

/** FantasyCalc reports roster share as 0..1; the contract wants a percentage. */
const ROSTER_PERCENT_SCALE = 100;

/**
 * @typedef {{ numQbs: number, numTeams: number, ppr: number }} FantasyCalcParams
 */

/**
 * Derive FantasyCalc's league-shape parameters from the Sleeper league object.
 * @param {{ roster_positions?: string[], total_rosters?: number,
 *   scoring_settings?: Record<string, number> }} league
 * @returns {FantasyCalcParams}
 */
export function fantasyCalcParams(league) {
  const rosterPositions = Array.isArray(league?.roster_positions) ? league.roster_positions : [];
  const numQbs = rosterPositions.filter((slot) => QB_SLOTS.has(slot)).length || 1;
  const numTeams = numOrNull(league?.total_rosters) ?? 12;
  const ppr = numOrNull(league?.scoring_settings?.rec) ?? 0;
  return { numQbs, numTeams, ppr };
}

/**
 * @param {FantasyCalcParams & { isDynasty: boolean }} options
 * @returns {string}
 */
export function fantasyCalcUrl({ isDynasty, numQbs, numTeams, ppr }) {
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
 * @param {FantasyCalcParams & { isDynasty: boolean, label: string, kind: string }} options
 * @returns {Promise<{ label: string, kind: string, fetched_at: string, ok: true, count: number,
 *   url: string, values: Record<string, Record<string, number>>, dropped: number }>}
 */
export async function fetchFantasyCalcTable(options) {
  const { isDynasty, numQbs, numTeams, ppr, label, kind } = options;
  const url = fantasyCalcUrl({ isDynasty, numQbs, numTeams, ppr });
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error(`unexpected FantasyCalc payload from ${url}`);
  const { values, dropped } = normalizeFantasyCalc(rows);
  return {
    label,
    kind,
    fetched_at: isoTimestamp(),
    ok: true,
    count: Object.keys(values).length,
    url,
    values,
    dropped,
  };
}
