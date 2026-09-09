// Boris Chen source: consensus weekly tiers, half-PPR where a half-PPR file exists.
//
//   https://s3-us-west-1.amazonaws.com/fftiers/out/weekly-<POS>.csv
//   columns: "Rank","Player.Name","Matchup","Best.Rank","Worst.Rank","Avg.Rank","Std.Dev","Tier"
//
// No CORS on the bucket (R1 §4) so this is pipeline-only. Files are names-only, so ids come from
// normalized name + position; team defenses join on the team name instead.

import { compact, csvRecords, fetchText, isoTimestamp, normalizeName, numOrNull, orderedById, sleep } from "../util.mjs";

const BC_BASE = "https://s3-us-west-1.amazonaws.com/fftiers/out";

/**
 * File per position. `HALF` variants exist only where the scoring format matters.
 * `FLX` is a cross-position RB/WR/TE ranking and supplies the overall rank.
 * @type {{ file: string, pos: string, flex?: boolean }[]}
 */
export const BC_FILES = [
  { file: "weekly-QB.csv", pos: "QB" },
  { file: "weekly-RB-HALF.csv", pos: "RB" },
  { file: "weekly-WR-HALF.csv", pos: "WR" },
  { file: "weekly-TE-HALF.csv", pos: "TE" },
  { file: "weekly-K.csv", pos: "K" },
  { file: "weekly-DST.csv", pos: "DEF" },
  { file: "weekly-FLX-HALF.csv", pos: "FLEX", flex: true },
];

/** Positions the FLEX file can contain, in match-priority order. */
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/** Delay between the seven small bucket reads. */
const BC_REQUEST_DELAY_MS = 250;

/**
 * @param {string} file
 * @returns {string}
 */
export function borisChenUrl(file) {
  return `${BC_BASE}/${file}`;
}

/**
 * Parse one Boris Chen weekly CSV.
 * @param {string} csvText
 * @returns {{ rank: number|null, name: string, best: number|null, worst: number|null,
 *   avg: number|null, sd: number|null, tier: number|null }[]}
 */
export function parseBorisChen(csvText) {
  const { records } = csvRecords(csvText);
  return records
    .map((record) => ({
      rank: numOrNull(record.Rank),
      name: (record["Player.Name"] ?? "").trim(),
      best: numOrNull(record["Best.Rank"]),
      worst: numOrNull(record["Worst.Rank"]),
      avg: numOrNull(record["Avg.Rank"]),
      sd: numOrNull(record["Std.Dev"]),
      tier: numOrNull(record.Tier),
    }))
    .filter((row) => row.name !== "");
}

/**
 * Resolve one Boris Chen row to a Sleeper id.
 * @param {{ name: string }} row
 * @param {string} pos "QB".."DEF", or "FLEX" for the cross-position file
 * @param {{ nameIndex: Map<string, string|null>, teamNameIndex: Map<string, string> }} indexes
 * @returns {string|null}
 */
export function resolveBorisChenId(row, pos, indexes) {
  const key = normalizeName(row.name);
  if (key === "") return null;
  if (pos === "DEF") return indexes.teamNameIndex.get(key) ?? null;
  if (pos === "FLEX") {
    const hits = FLEX_POSITIONS.map((p) => indexes.nameIndex.get(`${key}|${p}`)).filter(Boolean);
    return hits.length === 1 ? /** @type {string} */ (hits[0]) : null;
  }
  return indexes.nameIndex.get(`${key}|${pos}`) ?? null;
}

/**
 * Fold the parsed position files into the contract `values` map.
 * Position files supply `tier`, `pr` and `sd`; the FLEX file supplies `r`.
 * @param {{ pos: string, flex?: boolean, rows: ReturnType<typeof parseBorisChen> }[]} files
 * @param {{ nameIndex: Map<string, string|null>, teamNameIndex: Map<string, string> }} indexes
 * @returns {{ values: Record<string, Record<string, number>>, matched: number, unmatched: number,
 *   unmatchedNames: string[] }}
 */
export function normalizeBorisChen(files, indexes) {
  /** @type {Record<string, Record<string, number>>} */
  const draft = {};
  /** @type {string[]} */
  const unmatchedNames = [];
  let matched = 0;

  for (const { pos, flex, rows } of files) {
    for (const row of rows) {
      const id = resolveBorisChenId(row, pos, indexes);
      if (!id) {
        unmatchedNames.push(`${row.name}/${pos}`);
        continue;
      }
      if (!draft[id]) draft[id] = {};
      if (flex) {
        draft[id].r = row.rank;
      } else {
        matched += 1;
        draft[id].tier = row.tier;
        draft[id].pr = row.rank;
        draft[id].sd = row.sd;
      }
    }
  }

  /** @type {Record<string, Record<string, number>>} */
  const values = {};
  for (const [id, entry] of Object.entries(draft)) {
    const row = compact({ tier: entry.tier, r: entry.r, pr: entry.pr, sd: entry.sd });
    if (Object.keys(row).length > 0) values[id] = row;
  }
  return { values: orderedById(values), matched, unmatched: unmatchedNames.length, unmatchedNames };
}

/**
 * Fetch the current-week Boris Chen tiers in data/values.json source shape.
 * @param {{ week: number, nameIndex: Map<string, string|null>,
 *   teamNameIndex: Map<string, string> }} options
 * @returns {Promise<{ label: string, kind: string, week: number, fetched_at: string, ok: true,
 *   count: number, url: string, values: Record<string, Record<string, number>>,
 *   unmatched: number, unmatchedNames: string[], missingFiles: string[] }>}
 */
export async function fetchBorisChenTable(options) {
  const { week, nameIndex, teamNameIndex } = options;
  /** @type {{ pos: string, flex?: boolean, rows: ReturnType<typeof parseBorisChen> }[]} */
  const files = [];
  /** @type {string[]} */
  const missingFiles = [];

  for (const [index, spec] of BC_FILES.entries()) {
    const url = borisChenUrl(spec.file);
    try {
      const text = await fetchText(url, { retries: 1 });
      files.push({ pos: spec.pos, flex: spec.flex, rows: parseBorisChen(text) });
    } catch (error) {
      // A single missing position file must not sink the table.
      missingFiles.push(`${spec.file} (${error.message})`);
    }
    if (index < BC_FILES.length - 1) await sleep(BC_REQUEST_DELAY_MS);
  }

  if (files.length === 0) {
    throw new Error(`no Boris Chen files readable under ${BC_BASE}`);
  }

  const normalized = normalizeBorisChen(files, { nameIndex, teamNameIndex });
  return {
    label: `Boris Chen half-PPR wk ${week}`,
    kind: "tiers",
    week,
    fetched_at: isoTimestamp(),
    ok: true,
    count: Object.keys(normalized.values).length,
    url: `${BC_BASE}/weekly-<POS>.csv`,
    values: normalized.values,
    unmatched: normalized.unmatched,
    unmatchedNames: normalized.unmatchedNames,
    missingFiles,
  };
}
