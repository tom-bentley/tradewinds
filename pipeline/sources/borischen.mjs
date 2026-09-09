// Boris Chen source: consensus weekly tiers, in all three scoring formats.
//
//   https://s3-us-west-1.amazonaws.com/fftiers/out/weekly-<POS>[-HALF|-PPR].csv
//   columns: "Rank","Player.Name","Matchup","Best.Rank","Worst.Rank","Avg.Rank","Std.Dev","Tier"
//
// No CORS on the bucket (R1 §4) so this is pipeline-only. Files are names-only, so ids come from
// normalized name + position; team defenses join on the team name instead.
//
// Since design §10.2 the pipeline ships one table per format — `bc_tiers_std` (no suffix),
// `bc_tiers_half` (-HALF), `bc_tiers_ppr` (-PPR). Only RB/WR/TE/FLX have per-format files;
// QB, K and DST are format-independent, so those three downloads are shared by all three tables.

import { compact, csvRecords, fetchText, isoTimestamp, normalizeName, numOrNull, orderedById, sleep } from "../util.mjs";

const BC_BASE = "https://s3-us-west-1.amazonaws.com/fftiers/out";

/**
 * The three published tables. `suffix` selects the RB/WR/TE/FLX file variant.
 * @type {{ id: string, ppr: number, suffix: string, label: string }[]}
 */
export const BC_FORMATS = [
  { id: "bc_tiers_std", ppr: 0, suffix: "", label: "Boris Chen standard" },
  { id: "bc_tiers_half", ppr: 0.5, suffix: "-HALF", label: "Boris Chen half-PPR" },
  { id: "bc_tiers_ppr", ppr: 1, suffix: "-PPR", label: "Boris Chen PPR" },
];

/** Files whose rankings do not depend on reception scoring — fetched once, reused by all formats. */
export const BC_SHARED_FILES = [
  { file: "weekly-QB.csv", pos: "QB" },
  { file: "weekly-K.csv", pos: "K" },
  { file: "weekly-DST.csv", pos: "DEF" },
];

/** Positions published per format. `FLX` is the cross-position ranking that supplies `r`. */
export const BC_FORMAT_POSITIONS = [
  { stem: "weekly-RB", pos: "RB" },
  { stem: "weekly-WR", pos: "WR" },
  { stem: "weekly-TE", pos: "TE" },
  { stem: "weekly-FLX", pos: "FLEX", flex: true },
];

/** Positions the FLEX file can contain, in match-priority order. */
const FLEX_POSITIONS = ["RB", "WR", "TE"];

/** Delay between the fifteen small bucket reads. */
const BC_REQUEST_DELAY_MS = 250;

/**
 * @param {string} file
 * @returns {string}
 */
export function borisChenUrl(file) {
  return `${BC_BASE}/${file}`;
}

/**
 * @param {string} stem e.g. "weekly-RB"
 * @param {string} suffix "", "-HALF" or "-PPR"
 * @returns {string}
 */
export function borisChenFile(stem, suffix) {
  return `${stem}${suffix}.csv`;
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
 * @typedef {{ label: string, kind: string, variant: { ppr: number }, week: number,
 *   fetched_at: string, ok: true, count: number, url: string,
 *   values: Record<string, Record<string, number>>, unmatched: number,
 *   unmatchedNames: string[], missingFiles: string[] }} BorisChenTable
 */

/**
 * Fetch the current-week Boris Chen tiers for all three formats.
 * A single missing position file never sinks a table; only a completely unreadable
 * bucket throws, and then the last-good guard keeps every previous table.
 * @param {{ week: number, nameIndex: Map<string, string|null>,
 *   teamNameIndex: Map<string, string> }} options
 * @returns {Promise<Record<string, BorisChenTable>>} keyed by table id
 */
export async function fetchBorisChenTables(options) {
  const { week, nameIndex, teamNameIndex } = options;

  /** @type {{ file: string, pos: string, flex?: boolean, formats: string[]|null }[]} */
  const plan = [
    ...BC_SHARED_FILES.map((spec) => ({ ...spec, formats: null })),
    ...BC_FORMATS.flatMap((format) =>
      BC_FORMAT_POSITIONS.map((spec) => ({
        file: borisChenFile(spec.stem, format.suffix),
        pos: spec.pos,
        flex: spec.flex,
        formats: [format.id],
      })),
    ),
  ];

  /** @type {Map<string, { pos: string, flex?: boolean, rows: ReturnType<typeof parseBorisChen> }[]>} */
  const perFormat = new Map(BC_FORMATS.map((format) => [format.id, []]));
  /** @type {string[]} */
  const missingFiles = [];
  let readable = 0;

  for (const [index, spec] of plan.entries()) {
    const url = borisChenUrl(spec.file);
    try {
      const text = await fetchText(url, { retries: 1 });
      const parsed = { pos: spec.pos, flex: spec.flex, rows: parseBorisChen(text) };
      const targets = spec.formats ?? BC_FORMATS.map((format) => format.id);
      for (const id of targets) perFormat.get(id).push(parsed);
      readable += 1;
    } catch (error) {
      missingFiles.push(`${spec.file} (${error.message})`);
    }
    if (index < plan.length - 1) await sleep(BC_REQUEST_DELAY_MS);
  }

  if (readable === 0) {
    throw new Error(`no Boris Chen files readable under ${BC_BASE}`);
  }

  const fetchedAt = isoTimestamp();
  /** @type {Record<string, BorisChenTable>} */
  const tables = {};
  for (const format of BC_FORMATS) {
    const normalized = normalizeBorisChen(perFormat.get(format.id), { nameIndex, teamNameIndex });
    tables[format.id] = {
      label: `${format.label} wk ${week}`,
      kind: "tiers",
      variant: { ppr: format.ppr },
      week,
      fetched_at: fetchedAt,
      ok: true,
      count: Object.keys(normalized.values).length,
      url: `${BC_BASE}/weekly-<POS>${format.suffix}.csv`,
      values: normalized.values,
      unmatched: normalized.unmatched,
      unmatchedNames: normalized.unmatchedNames,
      missingFiles,
    };
  }
  return tables;
}
