// DynastyProcess source: 1QB dynasty trade values (GPL-3.0), from raw.githubusercontent.com.
//
//   files/values-players.csv  50 KB  weekly (Fri)  player,pos,team,age,draft_year,ecr_1qb,
//                                                  ecr_2qb,ecr_pos,value_1qb,value_2qb,
//                                                  scrape_date,fp_id
//   files/db_playerids.csv   2.6 MB  weekly (Fri)  the id spine; supplies fantasypros_id -> sleeper_id
//
// values-players.csv carries no sleeper_id of its own, so the id file is required to key the
// table by Sleeper id. Normalized name+position is the fallback for the ~1.6% it misses.

import { compact, csvRecords, fetchText, isoTimestamp, normalizeName, numOrNull, orderedById } from "../util.mjs";

const RAW_BASE = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";

export const DP_VALUES_URL = `${RAW_BASE}/values-players.csv`;
export const DP_PLAYERIDS_URL = `${RAW_BASE}/db_playerids.csv`;

/** DynastyProcess publishes its data files under GPL-3.0. */
export const DP_LICENSE = "GPL-3.0";

/**
 * Build fantasypros_id -> sleeper_id from db_playerids.csv.
 * @param {string} csvText
 * @returns {Map<string, string>}
 */
export function buildFpToSleeper(csvText) {
  const { records } = csvRecords(csvText);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const record of records) {
    const fp = (record.fantasypros_id ?? "").trim();
    const sleeper = (record.sleeper_id ?? "").trim();
    if (fp === "" || fp === "NA" || sleeper === "" || sleeper === "NA") continue;
    map.set(fp, sleeper);
  }
  return map;
}

/**
 * values-players.csv -> contract `values` map keyed by Sleeper id.
 * Ranks are computed over every parsed row (so they mirror the published file),
 * then only the rows we could key are emitted.
 * @param {string} valuesCsv
 * @param {{ fpToSleeper: Map<string, string>, nameIndex?: Map<string, string|null>|null }} options
 * @returns {{ values: Record<string, Record<string, number>>, parsed: number, matchedById: number,
 *   matchedByName: number, unmatched: number, unmatchedNames: string[], scrapeDate: string|null }}
 */
export function normalizeDynastyProcess(valuesCsv, options) {
  const { fpToSleeper, nameIndex = null } = options;
  const { records } = csvRecords(valuesCsv);

  const rows = records
    .map((record) => ({
      name: (record.player ?? "").trim(),
      pos: (record.pos ?? "").trim(),
      fpId: (record.fp_id ?? "").trim(),
      value: numOrNull(record.value_1qb),
      ecr: numOrNull(record.ecr_1qb),
      scrapeDate: (record.scrape_date ?? "").trim() || null,
    }))
    .filter((row) => row.value !== null);

  rows.sort((a, b) => b.value - a.value);

  /** @type {Record<string, number>} */
  const positionSeen = {};
  /** @type {Record<string, Record<string, number>>} */
  const values = {};
  /** @type {string[]} */
  const unmatchedNames = [];
  let matchedById = 0;
  let matchedByName = 0;

  rows.forEach((row, index) => {
    positionSeen[row.pos] = (positionSeen[row.pos] ?? 0) + 1;
    let sleeperId = row.fpId ? fpToSleeper.get(row.fpId) : undefined;
    if (sleeperId) {
      matchedById += 1;
    } else if (nameIndex) {
      const candidate = nameIndex.get(`${normalizeName(row.name)}|${row.pos}`);
      if (candidate) {
        sleeperId = candidate;
        matchedByName += 1;
      }
    }
    if (!sleeperId) {
      unmatchedNames.push(`${row.name}/${row.pos}`);
      return;
    }
    values[sleeperId] = compact({
      v: row.value,
      r: index + 1,
      pr: positionSeen[row.pos],
      ecr: row.ecr,
    });
  });

  return {
    values: orderedById(values),
    parsed: rows.length,
    matchedById,
    matchedByName,
    unmatched: unmatchedNames.length,
    unmatchedNames,
    scrapeDate: rows[0]?.scrapeDate ?? null,
  };
}

/**
 * Fetch the DynastyProcess table in data/values.json source shape.
 * @param {{ nameIndex?: Map<string, string|null>|null }} [options]
 * @returns {Promise<{ label: string, kind: string, license: string, fetched_at: string, ok: true,
 *   count: number, url: string, values: Record<string, Record<string, number>>,
 *   unmatched: number, unmatchedNames: string[], scrapeDate: string|null }>}
 */
export async function fetchDynastyProcessTable(options = {}) {
  const valuesCsv = await fetchText(DP_VALUES_URL);
  const idsCsv = await fetchText(DP_PLAYERIDS_URL);
  const fpToSleeper = buildFpToSleeper(idsCsv);
  if (fpToSleeper.size === 0) {
    throw new Error(`no fantasypros_id -> sleeper_id pairs parsed from ${DP_PLAYERIDS_URL}`);
  }
  const normalized = normalizeDynastyProcess(valuesCsv, {
    fpToSleeper,
    nameIndex: options.nameIndex ?? null,
  });
  return {
    label: "DynastyProcess 1QB",
    kind: "dynasty",
    license: DP_LICENSE,
    fetched_at: isoTimestamp(),
    ok: true,
    count: Object.keys(normalized.values).length,
    url: DP_VALUES_URL,
    values: normalized.values,
    unmatched: normalized.unmatched,
    unmatchedNames: normalized.unmatchedNames,
    scrapeDate: normalized.scrapeDate,
  };
}
