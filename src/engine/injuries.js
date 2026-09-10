// src/engine/injuries.js — "how long is he out?", the one judgement call in the advisor
// (design.md §12.2).
//
// Everything else the advisor does is arithmetic the engine already owns: lineups, market value,
// the free-agent and trade finders. Absence duration is the only input nobody publishes for free,
// so it is a TABLE rather than a model — ordered rules matched on `${injPart} ${injNotes}`, each
// carrying a probability distribution over "games missed from ctx.week inclusive". A table is
// auditable, editable from Settings later (`ctx.settings.injuryTable`), and costs nothing to run.
//
// Why the distribution matters: Sleeper's future-week projections do NOT encode fresh news — the
// morning after meniscus surgery Bowers still projected 13.07 for week 2 (design §12.1). So the
// advisor grades every move in a SCENARIO context whose future weeks are scaled by P(available),
// never by mutating the shared ctx. Pure, like the rest of the engine: no clock, no fetch.

import { isBye } from "./lineup.js";

/** `games` sentinel for "the rest of the season". */
export const SEASON_GAMES = 99;

/** Statuses that park a player on a reserve list — a minimum absence, whatever the body part. */
export const IR_STATUSES = Object.freeze(["IR", "PUP", "Reserve", "DNR", "NA"]);

/** Questionable moves this much of a body-part rule's mass to "plays this week" (design §12.2). */
export const QUESTIONABLE_SHIFT = 0.6;

/** Season-long branch set, reused by the season rule. */
const SEASON_BRANCHES = Object.freeze([{ games: SEASON_GAMES, p: 1 }]);

/** The reserve-list floor: four games at minimum, with a season-ending tail. */
const IR_MIN4 = Object.freeze([
  { games: 4, p: 0.4 },
  { games: 6, p: 0.3 },
  { games: 8, p: 0.2 },
  { games: SEASON_GAMES, p: 0.1 },
]);

/**
 * What a status alone says, with no useful body part. These are also the rows a body-part rule
 * falls back to (the `byStatus` rules) — an ankle tweak that is merely Questionable is a
 * different animal from the same ankle listed Out.
 */
export const STATUS_BRANCHES = Object.freeze({
  Questionable: Object.freeze([
    { games: 0, p: 0.7 },
    { games: 1, p: 0.3 },
  ]),
  Doubtful: Object.freeze([
    { games: 1, p: 0.7 },
    { games: 2, p: 0.2 },
    { games: 3, p: 0.1 },
  ]),
  Out: Object.freeze([
    { games: 1, p: 0.5 },
    { games: 2, p: 0.3 },
    { games: 3, p: 0.1 },
    { games: 4, p: 0.1 },
  ]),
  // A suspension with no game count in the notes: most are one or two weeks, some are six.
  Sus: Object.freeze([
    { games: 1, p: 0.5 },
    { games: 2, p: 0.3 },
    { games: 4, p: 0.2 },
  ]),
  // Sleeper's COVID list empties fast; it is not a reserve-list injury.
  COV: Object.freeze([
    { games: 1, p: 0.6 },
    { games: 2, p: 0.4 },
  ]),
  IR: IR_MIN4,
  PUP: IR_MIN4,
  Reserve: IR_MIN4,
  DNR: IR_MIN4,
  NA: IR_MIN4,
});

/**
 * The injury-duration table (design §12.2): ordered, first match wins, tokens matched
 * case-insensitively as substrings of `${injPart} ${injNotes}`.
 *
 * Row shape (plain JSON so `DEFAULTS.injuryTable` can ship a replacement verbatim):
 *   { key, statuses?: string[], tokens?: string[], with?: string[], byStatus?: true,
 *     branches?: [{ games, p }] }
 * `statuses` matches the status instead of the text; `tokens` needs one hit; `with` needs a
 * second hit from its own list (fracture AND a big bone); `byStatus` means "the body part is
 * known-minor, so the status decides".
 */
export const INJURY_RULES = Object.freeze([
  {
    key: "season",
    tokens: ["acl", "achilles", "ruptur", "season", "torn pec", "patellar"],
    branches: SEASON_BRANCHES,
  },
  { key: "irMin4", statuses: IR_STATUSES, branches: IR_MIN4 },
  {
    key: "fractureBig",
    tokens: ["fractur", "broken"],
    with: ["foot", "ankle", "leg", "fibula", "tibia", "collarbone", "clavicle", "scapula"],
    branches: [
      { games: 4, p: 0.3 },
      { games: 6, p: 0.4 },
      { games: 8, p: 0.3 },
    ],
  },
  {
    key: "fractureSmall",
    tokens: ["fractur", "broken"],
    with: ["hand", "finger", "thumb", "wrist", "rib"],
    branches: [
      { games: 1, p: 0.3 },
      { games: 2, p: 0.4 },
      { games: 4, p: 0.3 },
    ],
  },
  {
    key: "highAnkle",
    tokens: ["high ankle"],
    branches: [
      { games: 2, p: 0.3 },
      { games: 3, p: 0.3 },
      { games: 4, p: 0.25 },
      { games: 6, p: 0.15 },
    ],
  },
  {
    key: "meniscus",
    tokens: ["meniscus"],
    branches: [
      { games: 1, p: 0.3 },
      { games: 2, p: 0.3 },
      { games: 3, p: 0.15 },
      { games: 4, p: 0.15 },
      { games: 6, p: 0.1 },
    ],
  },
  {
    key: "mcl",
    tokens: ["mcl", "sprain"],
    with: ["knee"],
    branches: [
      { games: 2, p: 0.3 },
      { games: 3, p: 0.3 },
      { games: 4, p: 0.25 },
      { games: 6, p: 0.15 },
    ],
  },
  {
    key: "knee",
    tokens: ["knee"],
    branches: [
      { games: 1, p: 0.4 },
      { games: 2, p: 0.3 },
      { games: 3, p: 0.2 },
      { games: 4, p: 0.1 },
    ],
  },
  {
    key: "softTissue",
    tokens: ["hamstring", "groin", "calf", "quad", "hip flexor", "oblique"],
    branches: [
      { games: 1, p: 0.4 },
      { games: 2, p: 0.35 },
      { games: 3, p: 0.15 },
      { games: 4, p: 0.1 },
    ],
  },
  {
    key: "concussion",
    tokens: ["concussion", "head"],
    branches: [
      { games: 1, p: 0.75 },
      { games: 2, p: 0.25 },
    ],
  },
  {
    key: "shoulder",
    tokens: ["shoulder", "ac joint", "pec", "elbow"],
    branches: [
      { games: 1, p: 0.4 },
      { games: 2, p: 0.3 },
      { games: 3, p: 0.2 },
      { games: 4, p: 0.1 },
    ],
  },
  {
    key: "minor",
    tokens: ["ankle", "back", "ribs", "neck", "toe", "illness", "personal", "rest", "not injury"],
    byStatus: true,
  },
]);

/** The rules the user may have replaced, or the built-in table. */
function tableOf(ctx) {
  const custom = ctx && ctx.settings ? ctx.settings.injuryTable : null;
  return Array.isArray(custom) && custom.length ? custom : INJURY_RULES;
}

/**
 * Merge duplicate branches, drop empty ones and renormalize to 1 — a hand-edited table is
 * allowed to be sloppy, the math is not.
 * @param {Array<{games:number, p:number}>} list
 * @returns {Array<{games:number, p:number}>}
 */
function normalizeBranches(list) {
  const byGames = new Map();
  for (const branch of list || []) {
    if (!branch) continue;
    const games = Math.max(0, Math.round(Number(branch.games) || 0));
    const p = Number(branch.p);
    if (!Number.isFinite(p) || p <= 0) continue;
    byGames.set(games, (byGames.get(games) || 0) + p);
  }
  if (!byGames.size) return [{ games: 0, p: 1 }];
  const out = [...byGames.entries()].sort((a, b) => a[0] - b[0]).map(([games, p]) => ({ games, p }));
  let sum = 0;
  for (const branch of out) sum += branch.p;
  if (sum > 0 && Math.abs(sum - 1) > 1e-9) for (const branch of out) branch.p /= sum;
  return out;
}

/** Σ games × p. Reads as "expected games missed"; a season-ending tail deliberately dominates. */
function meanOf(branches) {
  let mean = 0;
  for (const branch of branches || []) mean += branch.games * branch.p;
  return mean;
}

/** Suspensions state their length: "3-game suspension", "suspended 6 games". */
function suspensionGames(text) {
  const match = /(\d+)\s*-?\s*game/.exec(text) || /(?:games?)\D{0,12}?(\d+)/.exec(text);
  const n = match ? Number(match[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < SEASON_GAMES ? n : null;
}

/**
 * What a status alone implies. Unknown statuses read as Questionable rather than as a
 * catastrophe — Sleeper occasionally invents new strings, and over-reacting to one costs points.
 * @param {string|null} inj
 * @param {string} text lowercased `${injPart} ${injNotes}`
 * @returns {Array<{games:number, p:number}>}
 */
function statusBranches(inj, text) {
  if (inj == null) return [{ games: 0, p: 1 }];
  if (inj === "Sus" || inj === "Suspended") {
    const games = suspensionGames(text);
    return games ? [{ games, p: 1 }] : STATUS_BRANCHES.Sus;
  }
  return STATUS_BRANCHES[inj] || STATUS_BRANCHES.Questionable;
}

/** Does this rule fire for this status and this text? */
function ruleMatches(rule, inj, text) {
  if (!rule) return false;
  if (Array.isArray(rule.statuses) && rule.statuses.length) return inj != null && rule.statuses.includes(inj);
  const tokens = Array.isArray(rule.tokens) ? rule.tokens : [];
  if (!tokens.length) return false;
  if (!tokens.some((token) => text.includes(String(token).toLowerCase()))) return false;
  const second = Array.isArray(rule.with) ? rule.with : null;
  if (second && second.length) return second.some((token) => text.includes(String(token).toLowerCase()));
  return true;
}

/** Move `share` of the mass onto "plays this week" — what Questionable does to a body part. */
function shiftToPlaying(branches, share) {
  const out = [{ games: 0, p: share }];
  for (const branch of branches) out.push({ games: branch.games, p: branch.p * (1 - share) });
  return out;
}

/**
 * How long is he out? Normalized lookup over the injury table (design §12.2).
 *
 * `games` counts NFL games missed from `ctx.week` INCLUSIVE, so `{games: 1}` means "misses this
 * week, back for the next one" and 99 means the season. Branch probabilities sum to 1.
 * @param {object} ctx engine context (only `ctx.settings.injuryTable` is read)
 * @param {{inj?:string|null, injPart?:string|null, injNotes?:string|null}} row status row
 * @returns {{key:string, branches:Array<{games:number,p:number}>, mean:number, seasonOver:boolean}}
 */
export function absenceOf(ctx, row = {}) {
  const inj = row.inj == null || row.inj === "" ? null : String(row.inj);
  const text = `${row.injPart || ""} ${row.injNotes || ""}`.toLowerCase().trim();
  // No status is no absence, whatever stale body part is still attached to the row.
  if (inj == null) return finish("none", [{ games: 0, p: 1 }]);

  const table = tableOf(ctx);
  let hit = null;
  for (const rule of table) {
    if (ruleMatches(rule, inj, text)) {
      hit = rule;
      break;
    }
  }

  // "IR-class statuses take max(table, irMin4)" (design §12.2): the ordered table hands them the
  // irMin4 row first, so look downstream for a body part that is WORSE than four games.
  if (hit && Array.isArray(hit.statuses) && IR_STATUSES.includes(inj)) {
    for (const rule of table) {
      if (rule === hit || Array.isArray(rule.statuses) || rule.byStatus) continue;
      if (!ruleMatches(rule, inj, text)) continue;
      if (meanOf(rule.branches) > meanOf(hit.branches)) hit = rule;
      break;
    }
  }

  if (!hit || hit.byStatus) return finish(hit ? hit.key : `status:${inj}`, statusBranches(inj, text));
  // A body-part match still respects the status: Questionable is a body part he will probably
  // play through, so most of the mass moves back to week zero.
  const branches = inj === "Questionable" ? shiftToPlaying(hit.branches, QUESTIONABLE_SHIFT) : hit.branches;
  return finish(hit.key, branches);
}

/** Package a branch list as an Absence. */
function finish(key, branches) {
  const norm = normalizeBranches(branches);
  let seasonMass = 0;
  for (const branch of norm) if (branch.games >= SEASON_GAMES) seasonMass += branch.p;
  return { key, branches: norm, mean: meanOf(norm), seasonOver: seasonMass >= 0.5 };
}

/**
 * P(this player suits up in `week`), given an Absence.
 *
 * Absence is counted in GAMES, not weeks, so a bye in between pushes the return date a week out:
 * the k-th team game from `ctx.week` is played iff he misses fewer than k games.
 * @param {object} ctx
 * @param {string} id player id (byes are his team's)
 * @param {number} week 1-based
 * @param {{branches:Array<{games:number,p:number}>}} absence
 * @returns {number} 0..1
 */
export function availability(ctx, id, week, absence) {
  const target = Number(week);
  if (!Number.isFinite(target) || target < ctx.week) return 1;
  let games = 0;
  for (let w = ctx.week; w <= target; w += 1) if (!isBye(ctx, id, w)) games += 1;
  if (games === 0) return 0; // the target week IS his bye — he does not play in it either way
  let p = 0;
  for (const branch of (absence && absence.branches) || []) if (branch.games < games) p += branch.p;
  return Math.max(0, Math.min(1, p));
}

/**
 * A scenario context in which this player's FUTURE weeks are discounted by P(available).
 *
 * Required because Sleeper's projections lag fresh news (design §12.1): the day after surgery the
 * feed still projects a full week 2. The current week needs no help — `weekVector` already zeroes
 * it for every status in WEEK_ZERO_STATUSES. Never mutates the input: memoized week vectors and
 * remaining-season points are keyed to a ctx, so a scenario gets a new ctx with an empty memo.
 * @param {object} ctx
 * @param {string} id
 * @param {{branches:Array<{games:number,p:number}>}} absence
 * @returns {object} a new ctx
 */
export function withAbsence(ctx, id, absence) {
  const vec = ctx.proj.get(id);
  if (!vec || !absence || !absence.branches) return { ...ctx, memo: {} };
  const patched = Array.from(vec, (n) => Number(n) || 0);
  for (let w = ctx.week + 1; w <= ctx.lastWeek; w += 1) {
    const i = w - 1;
    if (i >= patched.length) break;
    if (!patched[i]) continue;
    patched[i] *= availability(ctx, id, w, absence);
  }
  const proj = new Map(ctx.proj);
  proj.set(id, patched);
  return { ...ctx, proj, memo: {} };
}
