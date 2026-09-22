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

/**
 * Questionable moves this much of a body-part rule's mass to "plays this week" (design §12.2).
 *
 * R7 §4.2 measures 0.70 (71% of Questionable players played, 2017–2023, n > 2,000 [1]) and the
 * evidence-matched constant lives in `PROGNOSIS_TABLES.play` (prognosis.js), conditioned on the
 * practice pattern as R7 asks. This table constant is deliberately LEFT AT 0.60 so that a repo
 * with no dossiers keeps 0.4.x behaviour everywhere the R7 §3 replacement rows do not reach.
 */
export const QUESTIONABLE_SHIFT = 0.6;

/** Season-long branch set, reused by the season rule. */
const SEASON_BRANCHES = Object.freeze([{ games: SEASON_GAMES, p: 1 }]);

/**
 * The reserve-list rows (R7 §3.2). All three count their minimum from PLACEMENT, so every one of
 * them is served down by `games_served` before it is used — see `serveDown`.
 */
// R7 §3.2 [32]: 4-game minimum from placement; only 8 return designations exist per regular season
// (10 with a postseason), so most in-season IR placements never get one — hence the heavy tail.
const IR_NO_RETURN = Object.freeze([
  { games: 4, p: 0.25 },
  { games: 6, p: 0.22 },
  { games: 8, p: 0.18 },
  { games: 10, p: 0.1 },
  { games: SEASON_GAMES, p: 0.25 },
]);

// R7 §3.2 [32]: "designated to return" opens a 21-day practice window — activate to the 53 or
// revert to season-ending IR. A hard cap of three games, plus the revert mass.
const IR_RETURN_WINDOW = Object.freeze([
  { games: 0, p: 0.05 },
  { games: 1, p: 0.3 },
  { games: 2, p: 0.3 },
  { games: 3, p: 0.25 },
  { games: SEASON_GAMES, p: 0.1 },
]);

// R7 §3.2 [33][35]: Reserve/PUP and Reserve/NFI miss the first 4 games, then get a 5-week window
// to begin practising and 3 further weeks to activate or shut down — a longer right tail than IR.
const PUP_RESERVE = Object.freeze([
  { games: 4, p: 0.15 },
  { games: 6, p: 0.2 },
  { games: 8, p: 0.2 },
  { games: 10, p: 0.15 },
  { games: SEASON_GAMES, p: 0.3 },
]);

/** Notes that say the 21-day return window is open (R7 §3.4 item 4). */
const IR_RETURN_TOKENS = Object.freeze(["designated to return", "ir-r", "ir return", "21-day", "21 day"]);

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
  // R7 §3.1 [1]: Doubtful players play 5.9% of the time — nonzero, and `shiftToPlaying` is only
  // applied to Questionable, so the old row asserted 0%. R7 Surprises 1: Doubtful is a GAME-STATUS
  // designation and carries no information at all about week 2+, so the old 2/3-game tail was a
  // prognosis invented from a designation that does not contain one. Body-part rules carry duration.
  Doubtful: Object.freeze([
    { games: 0, p: 0.06 },
    { games: 1, p: 0.94 },
  ]),
  Out: Object.freeze([
    { games: 1, p: 0.5 },
    { games: 2, p: 0.3 },
    { games: 3, p: 0.1 },
    { games: 4, p: 0.1 },
  ]),
  // A suspension with no game count in the notes. R7 §3.1 [30][31]: the old row was an INVERTED
  // prior — it put 80% of its mass at 1–2 games, while the NFL's published schedule clusters at
  // 4–6 (4 steroid/stimulant/HGH, 2 diuretic/masking, 6 test manipulation, 10 for a second
  // steroid violation). Substances-of-abuse suspensions became rarer after the Dec-2024
  // modifications (THC threshold 150 → 350 ng/mL, no offseason stimulant suspensions).
  Sus: Object.freeze([
    { games: 1, p: 0.1 },
    { games: 2, p: 0.15 },
    { games: 3, p: 0.05 },
    { games: 4, p: 0.3 },
    { games: 6, p: 0.32 },
    { games: 10, p: 0.08 },
  ]),
  // Sleeper's COVID list empties fast; it is not a reserve-list injury. R7 §3.1: deprecated, not
  // deleted — no live 2026 referent, but still the right fallback for "non-injury unavailable".
  COV: Object.freeze([
    { games: 1, p: 0.6 },
    { games: 2, p: 0.4 },
  ]),
  // R7 §3.2: the reserve lists are three different mechanisms, not one. `Reserve`/`DNR`/`NA` are
  // Sleeper feed codes with no official NFL equivalent, so they take the generic IR row.
  IR: IR_NO_RETURN,
  PUP: PUP_RESERVE,
  Reserve: IR_NO_RETURN,
  DNR: IR_NO_RETURN,
  NA: IR_NO_RETURN,
});

/** The IR-R row, exported so the desk and the tests can name it (R7 §3.2). */
export const IR_RETURN_BRANCHES = IR_RETURN_WINDOW;

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
  // R7 §3.2: kept under its historic key so a settings table or a saved advisory still reads. The
  // branches here are only the COMPARISON candidate for the "max(table, reserve floor)" rule; the
  // row a reserve-list player actually gets is picked per status and served down by `games_served`.
  { key: "irMin4", statuses: IR_STATUSES, reserve: true, branches: IR_NO_RETURN },
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
  // R7 §3.3 row 6 — "the worst row in the file". One row cannot hold both procedures: a partial
  // meniscectomy ("trim") returns at mean 2.1 mo (RTS 98.2%), a repair at mean 5.8 mo (RTS 96.9%)
  // [11]; a second series puts them at 4.3 vs 7.6 mo [12]. A 3.5-month separation that a single
  // 2.4-game mean cannot express. Split on the procedure words `ruleMatches` could not see (§3.4).
  {
    key: "meniscusRepair",
    tokens: ["repair", "sutur", "root tear"],
    with: ["meniscus"],
    branches: SEASON_BRANCHES, // R7 §3.3 row 6: repair mean 5.8 mo [11] / 7.6 mo [12] ⇒ season
  },
  {
    key: "meniscusTrim",
    tokens: ["trim", "partial", "meniscectom", "scope", "arthroscop"],
    with: ["meniscus"],
    branches: [
      // R7 §3.3 row 6: trim mean 2.1 mo ≈ 9 games; in-season that reads 2–8 with the mass at 3–6.
      { games: 2, p: 0.15 },
      { games: 3, p: 0.25 },
      { games: 4, p: 0.25 },
      { games: 6, p: 0.2 },
      { games: 8, p: 0.15 },
    ],
  },
  {
    key: "meniscus",
    tokens: ["meniscus"],
    branches: [
      // R7 §3.3 row 6: bare "meniscus" is a mixture of both procedures, so it carries a season tail.
      { games: 2, p: 0.1 },
      { games: 3, p: 0.15 },
      { games: 4, p: 0.2 },
      { games: 6, p: 0.2 },
      { games: 8, p: 0.15 },
      { games: SEASON_GAMES, p: 0.2 },
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
  // R7 §3.3 row 8: "far too optimistic". The QB knee bucket averages 5.0 weeks with 48% missing
  // 5+ weeks [2]; the old row (mean 2.0) put ZERO mass past four games.
  {
    key: "knee",
    tokens: ["knee"],
    branches: [
      { games: 1, p: 0.2 },
      { games: 2, p: 0.2 },
      { games: 3, p: 0.15 },
      { games: 4, p: 0.15 },
      { games: 6, p: 0.15 },
      { games: 8, p: 0.1 },
      { games: SEASON_GAMES, p: 0.05 },
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

// --- The research-dossier seam (004 §2.4, R11 §Q11.3) ----------------------------------------
//
// WHY THE PRECEDENCE PRIMITIVE LIVES HERE AND NOT IN prognosis.js. `absenceOf` is imported by
// lineup.js, risk.js, explain.js and advisor.js, so injuries.js has to stay the LEAF of the
// engine graph: if it imported prognosis.js, and prognosis.js imported `SEASON_GAMES`/`absenceOf`
// back, the cycle would evaluate prognosis.js's table literals while injuries.js's consts were
// still in their temporal dead zone — an order-dependent ReferenceError. So the split is:
//   injuries.js  owns the SLICE-ROW gate (shape, rubric, expiry, statusKey) — data checks only;
//   prognosis.js owns the RUBRIC (tables, enums, `prognose`) and re-exports the gate, adding the
//                ramp and the recurrence hazard on top.
// One direction only: prognosis.js → injuries.js. Nothing imports upward.

/** The code→number mapping this engine honours. A row written under any other rubric is ignored. */
export const DOSSIER_RUBRIC = "r7-v1";

/** Fallback for `ctx.settings.dossier` (config.js `DEFAULTS.dossier`) when settings are absent. */
const DOSSIER_FALLBACK = Object.freeze({
  enabled: true,
  ttlHours: Object.freeze({ deep: 48, standard: 72, quick: 168 }),
  rubric: DOSSIER_RUBRIC,
});

/**
 * The stable identity of a status: what changed, never when it was reported. THE formula — the
 * advisor's `statusKey` normalizes the row and then calls this, so the freshness gate below and
 * the alert diff can never drift apart (design §12.1).
 * @param {{inj?:string|null, injPart?:string|null, injNotes?:string|null}} row
 * @returns {string} `${inj}|${injPart}|${injNotes}`
 */
export function statusKeyOf(row) {
  const r = row || {};
  const s = (v) => (v == null || v === "" ? "" : String(v));
  return `${s(r.inj)}|${s(r.injPart)}|${s(r.injNotes)}`;
}

/**
 * Shape guard for one `data/dossiers.json` slice row (004 design §2.4). Shape only — freshness and
 * status agreement are `dossierLookup`'s job. Anything malformed is simply not a dossier (I10).
 * @param {object} row
 * @returns {boolean}
 */
export function sliceIsValid(row) {
  if (!row || typeof row !== "object") return false;
  if (typeof row.sk !== "string") return false;
  if (!Number.isFinite(Date.parse(row.as_of)) || !Number.isFinite(Date.parse(row.expires_at))) return false;
  if (Date.parse(row.expires_at) <= Date.parse(row.as_of)) return false;
  const prog = row.prog;
  if (!prog || typeof prog !== "object" || !Array.isArray(prog.branches) || !prog.branches.length) return false;
  let sum = 0;
  for (const branch of prog.branches) {
    if (!branch || typeof branch !== "object") return false;
    const games = Number(branch.games);
    const p = Number(branch.p);
    if (!Number.isFinite(games) || games < 0 || games > SEASON_GAMES) return false;
    if (!Number.isFinite(p) || p <= 0 || p > 1) return false;
    sum += p;
  }
  return Math.abs(sum - 1) <= 0.001;
}

/** The dossier block from settings, with the shipped defaults as the floor. */
function dossierSettings(ctx) {
  const block = ctx && ctx.settings ? ctx.settings.dossier : null;
  return block && typeof block === "object" ? { ...DOSSIER_FALLBACK, ...block } : DOSSIER_FALLBACK;
}

/**
 * Is this player's slice row usable, and what does it say?
 *
 * R11 §Q11.3 precedence, in full: the row is used iff its rubric is the one this engine maps, its
 * `expires_at` is still ahead of the injected clock, and its `sk` still equals the LIVE status key.
 * "Status moved ⇒ the dossier is stale by definition, whatever the clock says" — what changed
 * matters, when it was reported does not. A stale JUDGEMENT is worse than a neutral table, which
 * is the `lastgood.mjs` rule inverted, so an unusable row falls through rather than lingering.
 *
 * Never mutates ctx; reads the clock only from `ctx.now` (null ⇒ treat every row as fresh, which
 * is what a replay from a fixture wants).
 * @param {object} ctx
 * @param {{id?:string, inj?:string|null, injPart?:string|null, injNotes?:string|null}} row live status row
 * @returns {{ok:boolean, slice:object|null, branches:Array<{games:number,p:number}>|null,
 *            key:string|null, stale:boolean, reason:string}|null} null ⇒ no dossiers at all
 */
export function dossierLookup(ctx, row) {
  const dossiers = ctx && ctx.dossiers;
  if (!dossiers || typeof dossiers.get !== "function" || dossiers.size === 0) return null;
  const cfg = dossierSettings(ctx);
  if (cfg.enabled === false) return null;
  const id = row && row.id != null ? String(row.id) : null;
  if (!id) return null;
  const slice = dossiers.get(id) || null;
  if (!slice) return miss(null, "no dossier for this player", false);
  if ((slice.rubric || null) !== (cfg.rubric || DOSSIER_RUBRIC)) {
    return miss(slice, `dossier rubric ${slice.rubric || "unset"} is not ${cfg.rubric || DOSSIER_RUBRIC}`, false);
  }
  if (!sliceIsValid(slice)) return miss(slice, "dossier slice row is malformed", true);
  // Defence in depth for validator rule 2 (R11 §Q11.3): a row that outlives its depth's TTL was
  // written by something that did not follow the contract, so it is not trusted either.
  const ttl = Number((cfg.ttlHours || {})[slice.depth]);
  if (Number.isFinite(ttl) && Date.parse(slice.expires_at) - Date.parse(slice.as_of) > ttl * 3600000 + 1) {
    return miss(slice, `dossier TTL exceeds ${ttl} h for depth ${slice.depth}`, true);
  }
  const now = ctx.now == null ? null : Number(ctx.now);
  if (now != null && Number.isFinite(now) && Date.parse(slice.expires_at) <= now) {
    return miss(slice, `dossier expired ${String(slice.expires_at).slice(0, 10)}`, true);
  }
  const live = statusKeyOf(row);
  if (slice.sk !== live) return miss(slice, "dossier is stale (status changed)", true);
  return {
    ok: true,
    slice,
    branches: slice.prog.branches.map((b) => ({ games: Math.round(Number(b.games)), p: Number(b.p) })),
    key: typeof slice.key === "string" && slice.key ? slice.key : "dossier",
    stale: false,
    reason: "",
  };
}

/** A dossier that exists but may not be used. `stale` distinguishes "went off" from "never was". */
function miss(slice, reason, stale) {
  return { ok: false, slice, branches: null, key: null, stale, reason };
}

/**
 * NFL games this player has already served on his current reserve list, from the status row or a
 * dossier hint. R7 §5.3: every reserve mechanism counts its minimum from PLACEMENT while
 * `absenceOf` counts from `ctx.week`, so without this the engine over-estimates every player
 * already on a list — worst in the back half of the season, exactly when IR-stash advice matters.
 * @param {object} row status row
 * @param {object|null} slice dossier slice row, when one exists
 * @returns {number} ≥ 0
 */
function gamesServedOf(row, slice) {
  const candidates = [
    row ? row.games_served : null,
    row ? row.gamesServed : null,
    slice && slice.codes ? slice.codes.games_served : null,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

/**
 * Run the clock down on a reserve-list row: `max(0, base − games_served)` (R7 §3.2 defect 1). The
 * season sentinel is a state, not a count, so it never moves.
 * @param {Array<{games:number,p:number}>} branches
 * @param {number} served
 * @returns {Array<{games:number,p:number}>}
 */
function serveDown(branches, served) {
  if (!(served > 0)) return branches;
  return (branches || []).map((b) =>
    b.games >= SEASON_GAMES ? b : { games: Math.max(0, b.games - served), p: b.p }
  );
}

/**
 * Which reserve-list row this status and these notes deserve (R7 §3.2: IR, IR-R and PUP/NFI are
 * three mechanisms that differ by a factor of ~4 in expected absence, not one).
 * @param {string} inj
 * @param {string} text lowercased `${injPart} ${injNotes}`
 * @returns {Array<{games:number,p:number}>}
 */
function reserveBranches(inj, text) {
  if (IR_RETURN_TOKENS.some((token) => text.includes(token))) return IR_RETURN_WINDOW;
  return STATUS_BRANCHES[inj] || IR_NO_RETURN;
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

// --- Negation guard (R7 §3.4 item 8, Surprises 8) ---------------------------------------------
//
// `ruleMatches` is a substring test over reporter prose, so "avoided a torn ACL" matched `acl` and
// returned SEASON — a live false positive on the highest-consequence row in the table. Two shapes
// cover the published examples: a negator that looks FORWARD over the phrase it denies, and a
// clean-scan word that looks BACK at the part it clears.
const NEGATE_AHEAD =
  "\\b(?:avoided|averted|escaped|dodged|ruled\\s+out\\s+an?|no\\s+(?:torn|tear|structural|significant|ligament)|" +
  "not\\s+(?:torn|broken|a\\s+tear|structural))\\b";
const NEGATE_BEHIND = "\\b(?:intact|clean|negative|unremarkable)\\b";
/** How far a negator reaches. Long enough for "ruled out a torn ACL", short enough to stay local. */
const NEGATE_AHEAD_CHARS = 44;
const NEGATE_BEHIND_CHARS = 30;

/**
 * Character ranges of `text` that a negation covers. Fresh regexes per call — a module-level `/g`
 * literal carries `lastIndex` between calls and would make this impure.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function negatedSpans(text) {
  const spans = [];
  for (const m of text.matchAll(new RegExp(NEGATE_AHEAD, "g"))) {
    spans.push([m.index, m.index + m[0].length + NEGATE_AHEAD_CHARS]);
  }
  for (const m of text.matchAll(new RegExp(NEGATE_BEHIND, "g"))) {
    spans.push([Math.max(0, m.index - NEGATE_BEHIND_CHARS), m.index]);
  }
  return spans;
}

/** Does `token` occur at least once OUTSIDE every negated span? */
function tokenStands(text, token, spans) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    if (!spans.some(([a, b]) => at >= a && at < b)) return true;
    from = at + 1;
  }
}

/**
 * Does this rule fire for this status and this text?
 * @param {object} rule
 * @param {string|null} inj
 * @param {string} text
 * @param {Array<[number,number]>} [spans] negated ranges, computed once per `absenceOf` call
 */
function ruleMatches(rule, inj, text, spans) {
  if (!rule) return false;
  if (Array.isArray(rule.statuses) && rule.statuses.length) return inj != null && rule.statuses.includes(inj);
  const tokens = Array.isArray(rule.tokens) ? rule.tokens : [];
  if (!tokens.length) return false;
  const hits = (list) => list.some((token) => tokenStands(text, String(token).toLowerCase(), spans || []));
  if (!hits(tokens)) return false;
  const second = Array.isArray(rule.with) ? rule.with : null;
  if (second && second.length) return hits(second);
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

  // 0 — a fresh dossier beats the table (004 §2.4). The gate is evaluated here rather than in the
  // callers so that every consumer of `absenceOf` — weekVector, risk, explain, the advisor's
  // scenario — reads the same answer. `dossier` is null when the repo ships no dossiers at all,
  // which is the ordinary case and costs one Map look-up.
  const dossier = dossierLookup(ctx, row);
  if (dossier && dossier.ok) {
    return finish(dossier.key, dossier.branches, { source: "dossier", stale: false, reason: "" });
  }
  const fell = dossier
    ? { source: "table", stale: dossier.stale, reason: dossier.reason }
    : { source: "table", stale: false, reason: "" };

  // No status is no absence, whatever stale body part is still attached to the row.
  if (inj == null) return finish("none", [{ games: 0, p: 1 }], fell);

  const table = tableOf(ctx);
  const spans = negatedSpans(text);
  let hit = null;
  for (const rule of table) {
    if (ruleMatches(rule, inj, text, spans)) {
      hit = rule;
      break;
    }
  }

  // "IR-class statuses take max(table, reserve floor)" (design §12.2): the ordered table hands them
  // the reserve row first, so look downstream for a body part that is WORSE than the floor.
  // R7 §3.5: the `break` used to sit OUTSIDE this `if`, so the "max" was a max over exactly ONE
  // candidate — the first non-status, non-`byStatus` rule that matched. Because the table is
  // ordered worst-first that was usually right, but inserting a mild rule above a severe one
  // silently downgraded every IR player whose notes matched both. The loop now takes a true max.
  const reserve = hit && Array.isArray(hit.statuses) && IR_STATUSES.includes(inj);
  if (reserve) {
    // A table shipped through `ctx.settings.injuryTable` keeps its own branches verbatim — only
    // the built-in row (flagged `reserve`) knows which of the three mechanisms it is looking at.
    const served = hit.reserve ? gamesServedOf(row, dossier ? dossier.slice : null) : 0;
    const floor = serveDown(hit.reserve ? reserveBranches(inj, text) : hit.branches, served);
    let best = { key: hit.key, branches: floor, mean: meanOf(floor) };
    for (const rule of table) {
      if (rule === hit || Array.isArray(rule.statuses) || rule.byStatus) continue;
      if (!ruleMatches(rule, inj, text, spans)) continue;
      const mean = meanOf(rule.branches);
      if (mean > best.mean) best = { key: rule.key, branches: rule.branches, mean };
    }
    return finish(best.key, best.branches, fell);
  }

  if (!hit || hit.byStatus) return finish(hit ? hit.key : `status:${inj}`, statusBranches(inj, text), fell);
  // A body-part match still respects the status: Questionable is a body part he will probably
  // play through, so most of the mass moves back to week zero.
  const branches = inj === "Questionable" ? shiftToPlaying(hit.branches, QUESTIONABLE_SHIFT) : hit.branches;
  return finish(hit.key, branches, fell);
}

/**
 * Package a branch list as an Absence. `source`/`stale`/`reason` are additive: a caller that only
 * knows the 0.4.x shape reads exactly what it read before.
 */
function finish(key, branches, extra) {
  const norm = normalizeBranches(branches);
  let seasonMass = 0;
  for (const branch of norm) if (branch.games >= SEASON_GAMES) seasonMass += branch.p;
  return {
    key,
    branches: norm,
    mean: meanOf(norm),
    seasonOver: seasonMass >= 0.5,
    source: (extra && extra.source) || "table",
    stale: !!(extra && extra.stale),
    reason: (extra && extra.reason) || "",
  };
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
 *
 * Since §13.5 D1 `weekVector` applies the SAME discount from the live status, so the scenario ctx
 * carries `memo.absenceApplied` — the set of ids whose projections already hold the discount.
 * Without it a hypothetical would be scaled twice and an Out player would read a quarter of his
 * points rather than a half. The stamp survives nesting: a second `withAbsence` on the same ctx
 * keeps the first id marked.
 * @param {object} ctx
 * @param {string} id
 * @param {{branches:Array<{games:number,p:number}>}} absence
 * @returns {object} a new ctx
 */
export function withAbsence(ctx, id, absence) {
  const applied = new Set(ctx.absenceApplied || (ctx.memo && ctx.memo.absenceApplied) || []);
  const vec = ctx.proj.get(id);
  // The stamp lives on the ctx as well as in the memo: several helpers derive a scenario with
  // `{ ...ctx, memo: {} }` (advisor's `withReserve`, `applyStatuses`), and a lost stamp would
  // silently square the discount.
  if (!vec || !absence || !absence.branches) {
    return applied.size ? { ...ctx, absenceApplied: applied, memo: { absenceApplied: applied } } : { ...ctx, memo: {} };
  }
  const patched = Array.from(vec, (n) => Number(n) || 0);
  for (let w = ctx.week + 1; w <= ctx.lastWeek; w += 1) {
    const i = w - 1;
    if (i >= patched.length) break;
    if (!patched[i]) continue;
    patched[i] *= availability(ctx, id, w, absence);
  }
  const proj = new Map(ctx.proj);
  proj.set(id, patched);
  applied.add(id);
  return { ...ctx, proj, absenceApplied: applied, memo: { absenceApplied: applied } };
}
