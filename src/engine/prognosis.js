// src/engine/prognosis.js — the deterministic prognosis rubric (004 design §3.3, R7 §6).
//
// The research desk's language model never emits a probability, a week count or a multiplier. Its
// only job is CLASSIFICATION against cited evidence: it fills a schema of enums, each with a quote.
// This file is the other half — a pure function that indexes a versioned table with those enums and
// returns a distribution. It is the argument injuries.js:1-13 already makes for a table over a
// model, extended one level up: the INPUTS to the table become enums too, so the desk's output
// space is finite, diff-able, and a rubric bump invalidates every old dossier deterministically.
//
// Purity, like the rest of the engine: no network, no wall clock, no randomness. The clock arrives
// as `ctx.now` and nowhere else, so a dossier + a data snapshot + `ctx.now` replay to the identical
// answer (FR-109, SC-103).
//
// EVERY NUMBER BELOW CITES R7. Where a number is a design choice rather than a measurement it is
// tagged [DESIGN] — R7's own discipline, kept so that the calibration loop (R7 §6.6) knows which
// cells are priors waiting for data and which are literature.
//
// Module graph: this file imports injuries.js and nothing else in the engine imports this file
// except advisor.js. injuries.js stays the leaf — see the "research-dossier seam" note there for
// why the slice-row gate lives down in injuries.js rather than up here.

import { DOSSIER_RUBRIC, SEASON_GAMES, absenceOf, dossierLookup, sliceIsValid, statusKeyOf } from "./injuries.js";

/** The rubric this engine maps. A dossier written under any other id is ignored, not mis-read. */
export const RUBRIC_ID = DOSSIER_RUBRIC;

// Re-exported so a caller needs one import. Defined in injuries.js because the leaf module needs it
// for its own pre-check and may not import upward (see the seam note in injuries.js).
export { sliceIsValid, statusKeyOf };

// ---------------------------------------------------------------------------------------------
// Enums — R7 §6.3 verbatim, plus the closed vocabularies R7 §6.2 states inline. Exported so the
// desk's validator can check against the same inventory the engine indexes (R7 §6.5).
// ---------------------------------------------------------------------------------------------

export const ENUMS = Object.freeze({
  injury_type: Object.freeze([
    "HAMSTRING", "GROIN_ADDUCTOR", "CALF", "QUAD", "HIP_FLEXOR", "OBLIQUE", "CORE_MUSCLE",
    "ANKLE_LOW", "ANKLE_HIGH", "TURF_TOE", "LISFRANC", "JONES_5MT", "FOOT_OTHER", "PLANTAR_FASCIA",
    "ACL", "PCL", "MCL", "LCL", "MENISCUS", "BONE_BRUISE", "PATELLAR_TENDON", "KNEE_UNSPEC",
    "ACHILLES",
    "SHOULDER_AC", "SHOULDER_INSTABILITY", "SHOULDER_LABRUM", "PEC", "CLAVICLE", "ELBOW",
    "HAND_FINGER", "THUMB", "WRIST", "FOREARM",
    "RIB", "BACK_STRAIN", "BACK_DISC", "NECK", "CONCUSSION",
    "ILLNESS", "PERSONAL", "REST", "NON_INJURY", "NONE", "UNKNOWN",
  ]),
  practice_pattern: Object.freeze([
    "FP_FP_FP", "LP_FP_FP", "LP_LP_FP", "LP_LP_LP", "DNP_LP_LP", "DNP_DNP_LP", "DNP_DNP_DNP",
    "SHORT_WEEK_ONE_REPORT", "NO_PRACTICE_YET", "UNKNOWN",
  ]),
  side: Object.freeze(["LEFT", "RIGHT", "BILATERAL", "NA", "UNKNOWN"]),
  severity: Object.freeze(["GRADE_1", "GRADE_2", "GRADE_3", "HIGH_GRADE", "LOW_GRADE", "UNKNOWN"]),
  surgery: Object.freeze(["NONE", "SCHEDULED", "ARTHROSCOPIC", "RECONSTRUCTION", "ORIF", "UNKNOWN"]),
  recurrence: Object.freeze(["FIRST", "RE_AGGRAVATION", "CHRONIC", "UNKNOWN"]),
  team_timeline: Object.freeze(["DAY_TO_DAY", "WEEK_TO_WEEK", "MULTI_WEEK", "IR", "SEASON", "UNKNOWN"]),
  designation: Object.freeze(["NONE", "Q", "D", "O", "IR", "IR_R", "PUP", "NFI", "SUS", "EXEMPT"]),
  ramp_class: Object.freeze(["RAMP_NONE", "RAMP_MODERATE", "RAMP_SURGICAL"]),
  confidence: Object.freeze(["HIGH", "MEDIUM", "LOW"]),
});

/**
 * Severity from least to most severe. `UNKNOWN` is deliberately NOT on the chain: it is the WIDE
 * cell, not a middle one, and the monotonicity property is stated over graded evidence only.
 */
export const SEVERITY_ORDER = Object.freeze(["LOW_GRADE", "GRADE_1", "GRADE_2", "GRADE_3", "HIGH_GRADE"]);

// ---------------------------------------------------------------------------------------------
// Table construction helpers. `b({4: .25, 6: .22})` reads like R7's own notation; JS orders
// integer-like keys ascending, so the literal order in this file is the order on the wire.
// ---------------------------------------------------------------------------------------------

const b = (spec) =>
  Object.freeze(
    Object.entries(spec).map(([games, p]) => Object.freeze({ games: Number(games), p }))
  );

/** The season sentinel as a distribution (injuries.js `SEASON_GAMES`). */
const SEASON = b({ [SEASON_GAMES]: 1 });

/** One surgery node that answers the same way whatever the procedure. */
const anySurgery = (branches) => Object.freeze({ UNKNOWN: branches });

/**
 * A type node. `unknown` is mandatory (it is what an unfilled severity resolves to); the five
 * graded cells are optional but, when ANY of them is given, ALL five must be — otherwise the
 * missing ones would fall back to the wide `unknown` cell and break stochastic dominance along
 * `SEVERITY_ORDER`. A test asserts this.
 */
const type = (cells) => Object.freeze(cells);

// ---------------------------------------------------------------------------------------------
// §1 base[injury_type][severity][surgery] — R7 §2.1 (evidence table) and §3.3 (replacement rows).
// Resolution widens rather than throwing: severity → the type's UNKNOWN cell, surgery → that
// cell's UNKNOWN, type → `statusFallback[designation]`. Unknown in, wide out; never an exception.
// ---------------------------------------------------------------------------------------------

const BASE = Object.freeze({
  // --- Soft tissue -----------------------------------------------------------------------------
  // R7 §3.3 row 9: BAMIC grade drives days and games missed; combined biceps femoris +
  // semitendinosus median 27 d ≈ 4 games [3]. The per-grade medians are paywalled, so the grade
  // split is [DESIGN] interpolation anchored on the published UNKNOWN row and the 27 d median.
  // Recurrence is NOT lengthened into the tail here — the 33% reinjury / 27% same-season figure
  // [4] is a POST-RETURN hazard and is returned separately (R7 §6.4 step 8).
  HAMSTRING: type({
    UNKNOWN: anySurgery(b({ 1: 0.35, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.07, 8: 0.03 })),
    LOW_GRADE: anySurgery(b({ 1: 0.55, 2: 0.3, 3: 0.1, 4: 0.05 })), // [DESIGN] = GRADE_1
    GRADE_1: anySurgery(b({ 1: 0.55, 2: 0.3, 3: 0.1, 4: 0.05 })), // [DESIGN]
    GRADE_2: anySurgery(b({ 1: 0.35, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.07, 8: 0.03 })), // R7 §3.3 row 9
    GRADE_3: anySurgery(b({ 1: 0.1, 2: 0.2, 3: 0.25, 4: 0.25, 6: 0.15, 8: 0.05 })), // [DESIGN], 27 d median [3]
    HIGH_GRADE: anySurgery(b({ 1: 0.1, 2: 0.2, 3: 0.25, 4: 0.25, 6: 0.15, 8: 0.05 })), // [DESIGN] = GRADE_3
  }),
  // R7 §2.1 [5]: adductor 24.1%, calf 12.6%, quad 8.3% of lower-extremity strains — but the
  // DURATION table could not be retrieved, so all three take the soft-tissue row. Marked
  // UNVERIFIED in R7 "What I could not verify".
  GROIN_ADDUCTOR: type({ UNKNOWN: anySurgery(b({ 1: 0.35, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.07, 8: 0.03 })) }),
  CALF: type({ UNKNOWN: anySurgery(b({ 1: 0.35, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.07, 8: 0.03 })) }),
  QUAD: type({ UNKNOWN: anySurgery(b({ 1: 0.35, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.07, 8: 0.03 })) }),
  // R7 §2.1: QB hip bucket mean 1.8 wk, 10% miss 5+ [2].
  HIP_FLEXOR: type({ UNKNOWN: anySurgery(b({ 1: 0.45, 2: 0.3, 3: 0.15, 4: 0.05, 6: 0.05 })) }),
  OBLIQUE: type({ UNKNOWN: anySurgery(b({ 1: 0.35, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.07, 8: 0.03 })) }), // UNVERIFIED, soft-tissue row
  // R7 §2.1 [18]: surgery indicated after 6-12 wk of failed conservative care, >90% RTS after.
  CORE_MUSCLE: type({
    UNKNOWN: anySurgery(b({ 1: 0.15, 2: 0.2, 3: 0.2, 4: 0.15, 6: 0.15, 8: 0.1, 12: 0.05 })),
  }),

  // --- Foot and ankle --------------------------------------------------------------------------
  // R7 §2.1 [2]: lateral (low) ankle sprain, QB mean 2.3 wk, 8% miss 5+ wk, minimal decline back.
  ANKLE_LOW: type({ UNKNOWN: anySurgery(b({ 1: 0.3, 2: 0.3, 3: 0.2, 4: 0.12, 6: 0.08 })) }),
  // R7 §3.3 row 5: median 30 d to full participation, IQR 19-73 d [6]; QB mean 3.7 wk with 23%
  // missing 5+ [2]. Operative runs 9-16 wk and the deltoid-tear (175 d) / fracture (250 d)
  // variants are season-ending in-season [6], so the surgical cells escalate.
  ANKLE_HIGH: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 2: 0.15, 3: 0.25, 4: 0.25, 6: 0.2, 8: 0.1, [SEASON_GAMES]: 0.05 }),
      ORIF: SEASON, // R7 §2.1 [6]: with fracture, median 250 d (IQR 142-266)
      RECONSTRUCTION: SEASON,
      SCHEDULED: b({ 6: 0.2, 8: 0.25, 10: 0.2, [SEASON_GAMES]: 0.35 }), // operative 9-16 wk [6][7]
      ARTHROSCOPIC: b({ 6: 0.2, 8: 0.25, 10: 0.2, [SEASON_GAMES]: 0.35 }),
    }),
  }),
  // R7 §3.3 row 12 [16]: grade I 3-5 d, grade II 2-4 wk, grade III / high-grade mean 140.9 d
  // (operative grade 3 averaged 16.5 wk missed), 91% RTP overall / 80% operative.
  TURF_TOE: type({
    UNKNOWN: anySurgery(b({ 0: 0.2, 1: 0.2, 2: 0.2, 4: 0.2, 6: 0.1, [SEASON_GAMES]: 0.1 })),
    LOW_GRADE: anySurgery(b({ 0: 0.6, 1: 0.4 })),
    GRADE_1: anySurgery(b({ 0: 0.6, 1: 0.4 })),
    GRADE_2: anySurgery(b({ 2: 0.3, 3: 0.3, 4: 0.3, 6: 0.1 })),
    GRADE_3: anySurgery(b({ 6: 0.2, 8: 0.2, 12: 0.2, [SEASON_GAMES]: 0.4 })),
    HIGH_GRADE: anySurgery(b({ 6: 0.2, 8: 0.2, 12: 0.2, [SEASON_GAMES]: 0.4 })),
  }),
  // R7 §2.1 [13][14]: median 11.1 mo, >90% RTP; non-operative median 6.2 mo vs operative 11.6 mo.
  LISFRANC: type({ UNKNOWN: anySurgery(SEASON) }),
  // R7 §3.3 row 3 [15]: IM screw, 100% RTP at mean 9.5 wk, 7.5% reoperation (another series: 36%
  // back under 10 wk but 60% revision).
  JONES_5MT: type({ UNKNOWN: anySurgery(b({ 6: 0.15, 8: 0.35, 10: 0.3, [SEASON_GAMES]: 0.2 })) }),
  FOOT_OTHER: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 6: 0.2 }), // [DESIGN] — no NFL series for the residual bucket
      ORIF: b({ 6: 0.15, 8: 0.35, 10: 0.3, [SEASON_GAMES]: 0.2 }), // R7 §3.3 row 3, foot fracture
    }),
  }),
  PLANTAR_FASCIA: type({ UNKNOWN: anySurgery(b({ 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 6: 0.2 })) }), // [DESIGN] — R7 lists it as a MISSING rule

  // --- Knee ------------------------------------------------------------------------------------
  // R7 §2.1 [9][10]: mean 10.8-11.4 mo to first game; 61% miss at least half a season.
  ACL: type({ UNKNOWN: anySurgery(SEASON) }),
  PCL: type({ UNKNOWN: anySurgery(b({ 2: 0.15, 3: 0.15, 4: 0.15, 6: 0.15, 8: 0.15, 12: 0.1, [SEASON_GAMES]: 0.15 })) }), // [DESIGN] — R7: UNVERIFIED, so widen
  // R7 §3.3 row 7 [8]: G1 1-3 wk, G2 4-6 wk, G3 up to ~8 wk (3-4 wk in pros with supervised early
  // functional rehab); near-100% RTP without surgery for an isolated MCL.
  MCL: type({
    UNKNOWN: anySurgery(b({ 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 6: 0.15, 8: 0.05 })),
    LOW_GRADE: anySurgery(b({ 1: 0.35, 2: 0.35, 3: 0.3 })),
    GRADE_1: anySurgery(b({ 1: 0.35, 2: 0.35, 3: 0.3 })),
    GRADE_2: anySurgery(b({ 3: 0.15, 4: 0.35, 5: 0.2, 6: 0.3 })),
    GRADE_3: anySurgery(b({ 4: 0.2, 6: 0.3, 8: 0.4, 10: 0.1 })),
    HIGH_GRADE: anySurgery(b({ 4: 0.2, 6: 0.3, 8: 0.4, 10: 0.1 })),
  }),
  // R7 §3.3 row 7 flags that `sprain × knee` swallows LCL and gives it MCL numbers; with no LCL
  // series published, the MCL row is the honest answer rather than an invented one. [DESIGN]
  LCL: type({ UNKNOWN: anySurgery(b({ 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 6: 0.15, 8: 0.05 })) }),
  // R7 §3.3 row 6 — "the worst row in the file". Trim mean 2.1 mo / RTS 98.2%; repair mean 5.8 mo
  // / RTS 96.9% [11] (alt. series 4.3 vs 7.6 mo [12]). A 3.5-month separation one row cannot hold.
  MENISCUS: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 2: 0.1, 3: 0.15, 4: 0.2, 6: 0.2, 8: 0.15, [SEASON_GAMES]: 0.2 }), // the mixture
      NONE: b({ 2: 0.2, 3: 0.25, 4: 0.25, 6: 0.2, 8: 0.1 }), // managed without surgery
      ARTHROSCOPIC: b({ 2: 0.15, 3: 0.25, 4: 0.25, 6: 0.2, 8: 0.15 }), // trim / partial meniscectomy [11]
      SCHEDULED: b({ 2: 0.1, 3: 0.15, 4: 0.2, 6: 0.2, 8: 0.15, [SEASON_GAMES]: 0.2 }),
      RECONSTRUCTION: SEASON, // repair [11][12] — also caught by the step-2 hard override
      ORIF: SEASON,
    }),
  }),
  BONE_BRUISE: type({ UNKNOWN: anySurgery(b({ 0: 0.15, 1: 0.25, 2: 0.25, 3: 0.2, 4: 0.15 })) }), // [DESIGN] — R7: UNVERIFIED
  // R7 §3.3 row 1 false positive: bare `patellar` also matches patellar TENDINITIS, which is not
  // season-ending. So the type is not in `seasonTypes`; the rupture is expressed as grade/surgery.
  PATELLAR_TENDON: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 1: 0.25, 2: 0.25, 3: 0.2, 4: 0.15, 6: 0.15 }), // tendinitis-dominated [DESIGN]
      RECONSTRUCTION: SEASON,
      ORIF: SEASON,
    }),
    LOW_GRADE: anySurgery(b({ 0: 0.2, 1: 0.3, 2: 0.3, 3: 0.2 })),
    GRADE_1: anySurgery(b({ 0: 0.2, 1: 0.3, 2: 0.3, 3: 0.2 })),
    GRADE_2: anySurgery(b({ 1: 0.2, 2: 0.25, 3: 0.25, 4: 0.2, 6: 0.1 })),
    GRADE_3: anySurgery(SEASON), // a ruptured patellar tendon is season-ending [R7 §3.3 row 1]
    HIGH_GRADE: anySurgery(SEASON),
  }),
  // R7 §3.3 row 8 [2]: QB knee bucket mean 5.0 wk with 48% missing 5+ wk.
  KNEE_UNSPEC: type({
    UNKNOWN: anySurgery(b({ 1: 0.2, 2: 0.2, 3: 0.15, 4: 0.15, 6: 0.15, 8: 0.1, [SEASON_GAMES]: 0.05 })),
  }),

  // --- Achilles --------------------------------------------------------------------------------
  // R7 §2.1 [17]: mean 10.78 ± 1.4 mo; RTP 66.2% (2024 SR) / 80.6% (2008-22 matched cohort).
  ACHILLES: type({ UNKNOWN: anySurgery(SEASON) }),

  // --- Shoulder and arm ------------------------------------------------------------------------
  // R7 §3.3 row 11 [19]: AC joint mean 9.8 d lost overall, QB mean 17.3 d, only 1.7% operative;
  // low-grade ~10 d vs high-grade ~64 d.
  SHOULDER_AC: type({
    UNKNOWN: anySurgery(b({ 0: 0.15, 1: 0.35, 2: 0.25, 3: 0.15, 4: 0.05, 8: 0.05 })),
    LOW_GRADE: anySurgery(b({ 0: 0.25, 1: 0.45, 2: 0.25, 3: 0.05 })),
    GRADE_1: anySurgery(b({ 0: 0.25, 1: 0.45, 2: 0.25, 3: 0.05 })),
    GRADE_2: anySurgery(b({ 0: 0.15, 1: 0.35, 2: 0.25, 3: 0.15, 4: 0.05, 8: 0.05 })),
    GRADE_3: anySurgery(b({ 4: 0.2, 6: 0.2, 8: 0.3, 10: 0.2, [SEASON_GAMES]: 0.1 })),
    HIGH_GRADE: anySurgery(b({ 4: 0.2, 6: 0.2, 8: 0.3, 10: 0.2, [SEASON_GAMES]: 0.1 })),
  }),
  // R7 §3.3 row 11 [20]: subluxation median 0.0 wk (92% RTP), dislocation non-op median 3.0 wk,
  // operative repair median 39.3 wk; 47% recurrence overall (non-op 55% vs operative 26%).
  SHOULDER_INSTABILITY: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 0: 0.15, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.1, 6: 0.05, [SEASON_GAMES]: 0.1 }),
      RECONSTRUCTION: SEASON,
      ORIF: SEASON,
      ARTHROSCOPIC: SEASON, // operative median 39.3 wk [20]
      SCHEDULED: SEASON,
    }),
    LOW_GRADE: anySurgery(b({ 0: 0.6, 1: 0.25, 2: 0.15 })), // subluxation, median 0.0 wk [20]
    GRADE_1: anySurgery(b({ 0: 0.6, 1: 0.25, 2: 0.15 })),
    GRADE_2: anySurgery(b({ 0: 0.15, 1: 0.2, 2: 0.2, 3: 0.25, 4: 0.1, 6: 0.1 })),
    GRADE_3: anySurgery(b({ 1: 0.15, 2: 0.25, 3: 0.25, 4: 0.2, 6: 0.15 })), // dislocation non-op, median 3.0 wk [20]
    HIGH_GRADE: anySurgery(b({ 1: 0.15, 2: 0.25, 3: 0.25, 4: 0.2, 6: 0.15 })),
  }),
  // R7 §2.1 [21]: the 2026 OJSM matched cohort (111 labral repair episodes) was located but its
  // numbers were NOT extracted, so this row is [DESIGN] and R7 §2.2 places labral repair in the
  // surgical ramp class.
  SHOULDER_LABRUM: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 1: 0.15, 2: 0.15, 3: 0.15, 4: 0.15, 6: 0.15, 8: 0.1, [SEASON_GAMES]: 0.15 }),
      ARTHROSCOPIC: b({ 8: 0.2, 12: 0.2, [SEASON_GAMES]: 0.6 }),
      RECONSTRUCTION: SEASON,
      ORIF: SEASON,
      SCHEDULED: b({ 8: 0.2, 12: 0.2, [SEASON_GAMES]: 0.6 }),
    }),
  }),
  // R7 §3.3 row 1: "torn pec" is a season-ending token, but a pec STRAIN is not — so the type is
  // not in `seasonTypes` and the escalation rides on grade and surgery.
  PEC: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 2: 0.2, 3: 0.2, 4: 0.2, 6: 0.2, 8: 0.2 }), // [DESIGN]
      RECONSTRUCTION: SEASON,
      ORIF: SEASON,
      SCHEDULED: SEASON,
    }),
    LOW_GRADE: anySurgery(b({ 1: 0.3, 2: 0.3, 3: 0.25, 4: 0.15 })),
    GRADE_1: anySurgery(b({ 1: 0.3, 2: 0.3, 3: 0.25, 4: 0.15 })),
    GRADE_2: anySurgery(b({ 2: 0.2, 3: 0.2, 4: 0.2, 6: 0.2, 8: 0.2 })),
    GRADE_3: anySurgery(SEASON), // a torn pec [R7 §3.3 row 1]
    HIGH_GRADE: anySurgery(SEASON),
  }),
  // R7 §3.3 row 3 [22]: clavicle ORIF, 94.1% RTS at mean 211.3 ± 144.7 d — only 44% the SAME
  // season; under 6 wk 6.25%, 6-12 wk 31.25%, over 12 wk 62.5%.
  CLAVICLE: type({ UNKNOWN: anySurgery(b({ 6: 0.08, 8: 0.12, 12: 0.15, [SEASON_GAMES]: 0.65 })) }),
  // R7 §3.3 row 11 [2]: QB elbow bucket mean 3.1 wk, 18% miss 5+ wk.
  ELBOW: type({ UNKNOWN: anySurgery(b({ 1: 0.3, 2: 0.3, 3: 0.25, 4: 0.15 })) }),

  // --- Hand and wrist --------------------------------------------------------------------------
  // R7 §3.3 row 4 [23]: metacarpal fractures, median RTP 15 d (IQR 1-55); no effect of age,
  // position, mechanism or articular involvement.
  HAND_FINGER: type({ UNKNOWN: anySurgery(b({ 1: 0.3, 2: 0.4, 4: 0.3 })) }),
  // R7 §3.3 row 4 [23]: thumb metacarpal non-operative median 55 d vs operative median 24 d.
  THUMB: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 2: 0.2, 4: 0.3, 6: 0.3, 8: 0.2 }),
      NONE: b({ 4: 0.2, 6: 0.3, 8: 0.35, 10: 0.15 }), // 55 d non-operative [23]
      ORIF: b({ 2: 0.25, 3: 0.35, 4: 0.25, 6: 0.15 }), // 24 d operative [23]
      ARTHROSCOPIC: b({ 2: 0.25, 3: 0.35, 4: 0.25, 6: 0.15 }),
      SCHEDULED: b({ 2: 0.25, 3: 0.35, 4: 0.25, 6: 0.15 }),
    }),
  }),
  // R7 §2.1 [2]: QB hand/wrist bucket mean 3.3 wk with 28% missing 5+ wk. [DESIGN] shape.
  WRIST: type({ UNKNOWN: anySurgery(b({ 1: 0.18, 2: 0.22, 3: 0.2, 4: 0.14, 6: 0.18, 8: 0.08 })) }),
  FOREARM: type({ UNKNOWN: anySurgery(b({ 2: 0.2, 4: 0.3, 6: 0.3, 8: 0.2 })) }), // [DESIGN] — no NFL series

  // --- Trunk, back, head -----------------------------------------------------------------------
  // R7 §2.1 [25][2]: 1-2 ribs ≈ 1-2 games (QBs 3.5-5 wk), 3+ ribs 4-8 wk; QB rib bucket mean 1.5 wk.
  RIB: type({
    UNKNOWN: anySurgery(b({ 1: 0.4, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.05 })),
    LOW_GRADE: anySurgery(b({ 1: 0.5, 2: 0.3, 3: 0.2 })),
    GRADE_1: anySurgery(b({ 1: 0.5, 2: 0.3, 3: 0.2 })),
    GRADE_2: anySurgery(b({ 1: 0.4, 2: 0.3, 3: 0.15, 4: 0.1, 6: 0.05 })),
    GRADE_3: anySurgery(b({ 4: 0.3, 6: 0.3, 8: 0.3, 10: 0.1 })), // 3+ ribs, 4-8 wk [25]
    HIGH_GRADE: anySurgery(b({ 4: 0.3, 6: 0.3, 8: 0.3, 10: 0.1 })),
  }),
  // R7 §3.3 row 12 [26]: NFL low-back injury mean 22.8 d to RTP.
  BACK_STRAIN: type({ UNKNOWN: anySurgery(b({ 1: 0.2, 2: 0.25, 3: 0.25, 4: 0.2, 6: 0.1 })) }),
  // R7 §3.3 row 12 [26][27]: with 1-2 epidural injections, 82.4% RTP at mean 0.6 GAMES missed;
  // microdiscectomy 82.6% RTP at mean 10.8 wk (elite-athlete meta: operative 5.19 mo).
  BACK_DISC: type({
    UNKNOWN: Object.freeze({
      UNKNOWN: b({ 0: 0.2, 1: 0.2, 2: 0.15, 4: 0.1, 6: 0.1, 8: 0.1, [SEASON_GAMES]: 0.15 }),
      NONE: b({ 0: 0.5, 1: 0.25, 2: 0.15, 4: 0.1 }), // injection pathway, mean 0.6 games [26]
      SCHEDULED: b({ 6: 0.2, 8: 0.2, 12: 0.2, [SEASON_GAMES]: 0.4 }),
      ARTHROSCOPIC: b({ 6: 0.2, 8: 0.2, 12: 0.2, [SEASON_GAMES]: 0.4 }), // microdiscectomy [26][27]
      RECONSTRUCTION: SEASON, // fusion
      ORIF: SEASON,
    }),
  }),
  NECK: type({ UNKNOWN: anySurgery(b({ 0: 0.15, 1: 0.3, 2: 0.2, 3: 0.15, 4: 0.1, [SEASON_GAMES]: 0.1 })) }), // [DESIGN] — R7 §3.3 row 12: UNVERIFIED in either direction
  // R7 §3.3 row 10 [28][29][2]: median 9 d to clearance; QB bucket mean 1.3 wk with only 4%
  // missing 5+ wk. The 5-phase protocol has no fixed timetable and bars same-day return.
  CONCUSSION: type({ UNKNOWN: anySurgery(b({ 0: 0.05, 1: 0.7, 2: 0.2, 3: 0.05 })) }),

  // --- Non-injury ------------------------------------------------------------------------------
  ILLNESS: type({ UNKNOWN: anySurgery(b({ 0: 0.4, 1: 0.45, 2: 0.15 })) }), // [DESIGN]
  PERSONAL: type({ UNKNOWN: anySurgery(b({ 0: 0.35, 1: 0.45, 2: 0.2 })) }), // [DESIGN]
  REST: type({ UNKNOWN: anySurgery(b({ 0: 0.6, 1: 0.4 })) }), // [DESIGN]
  NON_INJURY: type({ UNKNOWN: anySurgery(b({ 0: 0.5, 1: 0.5 })) }), // [DESIGN]
  // NONE and UNKNOWN are deliberately absent: with no body-part evidence the designation decides,
  // which is exactly `statusFallback` (R7 §6.4 step 1's third `??`).
});

// ---------------------------------------------------------------------------------------------
// §2 statusFallback[designation] — R7 §3.1 and §3.2. What a label alone says.
// ---------------------------------------------------------------------------------------------

const STATUS_FALLBACK = Object.freeze({
  NONE: b({ 0: 1 }),
  Q: b({ 0: 0.7, 1: 0.3 }), // R7 §3.1 [1]: 71% of Questionable players played, 2017-2023, n > 2,000
  D: b({ 0: 0.06, 1: 0.94 }), // R7 §3.1 [1]: 5.9% play; Surprises 1: D says nothing about week 2+
  O: b({ 1: 0.45, 2: 0.25, 3: 0.12, 4: 0.1, 6: 0.08 }), // R7 §3.1: widen the tail; QB buckets run 1.3-5.0 wk [2]
  IR: b({ 4: 0.25, 6: 0.22, 8: 0.18, 10: 0.1, [SEASON_GAMES]: 0.25 }), // R7 §3.2 [32]: only 8 return designations exist
  IR_R: b({ 0: 0.05, 1: 0.3, 2: 0.3, 3: 0.25, [SEASON_GAMES]: 0.1 }), // R7 §3.2 [32]: 21-day activate-or-revert window
  PUP: b({ 4: 0.15, 6: 0.2, 8: 0.2, 10: 0.15, [SEASON_GAMES]: 0.3 }), // R7 §3.2 [33][35]: 4 games + 5-wk + 3-wk windows
  NFI: b({ 4: 0.15, 6: 0.2, 8: 0.2, 10: 0.15, [SEASON_GAMES]: 0.3 }), // R7 §5.1: as PUP, non-football injury
  SUS: b({ 1: 0.1, 2: 0.15, 3: 0.05, 4: 0.3, 6: 0.32, 10: 0.08 }), // R7 §3.1 [30][31]: 4/2/6 first violation, 10 second
  EXEMPT: b({ 4: 0.15, 6: 0.2, 9: 0.2, 12: 0.15, [SEASON_GAMES]: 0.3 }), // R7 §3.2/§5.1 [36][37]: no fixed duration
  // Sleeper occasionally invents a status string; over-reacting to one costs points, so an
  // unknown designation reads as Questionable — the same rule injuries.js:247 already applies.
  UNKNOWN: b({ 0: 0.7, 1: 0.3 }),
});

// ---------------------------------------------------------------------------------------------
// §3 teamTimeline[code] — the coarse, reliable signal, blended at 0.35 (R7 §6.4 step 4).
// [DESIGN] throughout: no published table maps a coach's phrase to a distribution. `UNKNOWN` is
// null on purpose — blending with an invented prior when the team said nothing would be worse
// than not blending at all.
// ---------------------------------------------------------------------------------------------

const TEAM_TIMELINE = Object.freeze({
  DAY_TO_DAY: b({ 0: 0.55, 1: 0.35, 2: 0.1 }),
  WEEK_TO_WEEK: b({ 1: 0.45, 2: 0.3, 3: 0.15, 4: 0.1 }),
  MULTI_WEEK: b({ 2: 0.2, 3: 0.25, 4: 0.25, 6: 0.2, 8: 0.1 }),
  IR: b({ 4: 0.25, 6: 0.22, 8: 0.18, 10: 0.1, [SEASON_GAMES]: 0.25 }), // R7 §3.2, the IR row
  SEASON: SEASON,
  UNKNOWN: null,
});

/** Types whose diagnosis alone ends the season (R7 §3.3 row 1, §2.1 [9][10][17][13]). */
const SEASON_TYPES = Object.freeze(new Set(["ACL", "ACHILLES", "LISFRANC"]));

// ---------------------------------------------------------------------------------------------
// §4 recurrence[injury_type] — a POST-RETURN hazard, returned separately so that `availability()`
// can apply it week by week rather than inflating the absence (R7 §3.3 row 9, §6.4 step 8).
// ---------------------------------------------------------------------------------------------

const RECURRENCE = Object.freeze({
  HAMSTRING: 0.27, // R7 §2.1 [4]: 33% reinjure, 27% of them in the SAME season
  GROIN_ADDUCTOR: 0.2, // [DESIGN] — soft-tissue class, R5 §5.4 via R7 §3.3 row 9
  CALF: 0.2, // [DESIGN]
  QUAD: 0.2, // [DESIGN]
  HIP_FLEXOR: 0.2, // [DESIGN]
  OBLIQUE: 0.2, // [DESIGN]
  ANKLE_HIGH: 0.2, // [DESIGN] — R7 §2.1 records re-injury "High", no number published
  SHOULDER_INSTABILITY: 0.47, // R7 §2.1 [20]: 47% recurrence overall (non-op 55%, operative 26%)
  SHOULDER_AC: 0.2, // [DESIGN] — R7 §2.1 "High"
  CONCUSSION: 0.15, // [DESIGN] — R7 §2.1 "Moderate"
  MENISCUS: 0.1, // [DESIGN] — R7 §2.1 "Moderate"
  KNEE_UNSPEC: 0.1, // [DESIGN]
  MCL: 0.1, // [DESIGN]
  ANKLE_LOW: 0.05, // [DESIGN] — R7 §2.1 "Low"
});

// ---------------------------------------------------------------------------------------------
// §5 ramp[class] — multipliers on projected points for the 1st/2nd/3rd game back.
//
// R7 §2.2 and Surprises 2: games missed does NOT predict post-return production (R² = 0.0047,
// n = 2,523 time-loss injuries [24]), so a duration-scaled ramp is UNSUPPORTED. Ramp by injury
// CLASS, never by weeks out. Anchors: [2]'s qualitative first-game columns and the league-wide
// −0.50 PPG [24] (QB −1.95, RB −0.70, WR −0.33, TE ~0).
// ---------------------------------------------------------------------------------------------

const RAMP = Object.freeze({
  RAMP_NONE: b2([[1, 0.95], [2, 1.0], [3, 1.0]]), // "Minimal decline" [2]
  RAMP_MODERATE: b2([[1, 0.85], [2, 0.92], [3, 1.0]]), // "Moderate decline" [2]; −0.50 PPG league-wide [24]
  RAMP_SURGICAL: b2([[1, 0.7], [2, 0.78], [3, 0.85]]), // RTP-with-reduced-performance [9][17][14]
});

/** R7 §2.2: the surgical class does not recover to 1.0 — it floors here for the rest of the season. */
const RAMP_SEASON_FLOOR = Object.freeze({ RAMP_NONE: 1.0, RAMP_MODERATE: 1.0, RAMP_SURGICAL: 0.9 });

/** R7 §2.2 [24]: multiply the decline (1 − m) by this, by position. */
export const RAMP_POSITION_TILT = Object.freeze({ QB: 1.6, RB: 1.2, WR: 0.9, TE: 0.6 });

/** R7 §2.2 class membership. Any surgery other than NONE/UNKNOWN promotes to the surgical class. */
const RAMP_CLASS_OF = Object.freeze({
  ANKLE_LOW: "RAMP_NONE", ANKLE_HIGH: "RAMP_NONE", MCL: "RAMP_NONE", LCL: "RAMP_NONE",
  PCL: "RAMP_NONE", KNEE_UNSPEC: "RAMP_NONE", BONE_BRUISE: "RAMP_NONE", HIP_FLEXOR: "RAMP_NONE",
  BACK_STRAIN: "RAMP_NONE", ELBOW: "RAMP_NONE",
  HAND_FINGER: "RAMP_MODERATE", THUMB: "RAMP_MODERATE", WRIST: "RAMP_MODERATE",
  FOREARM: "RAMP_MODERATE", SHOULDER_AC: "RAMP_MODERATE", SHOULDER_INSTABILITY: "RAMP_MODERATE",
  RIB: "RAMP_MODERATE", CONCUSSION: "RAMP_MODERATE",
  ACL: "RAMP_SURGICAL", ACHILLES: "RAMP_SURGICAL", LISFRANC: "RAMP_SURGICAL",
  SHOULDER_LABRUM: "RAMP_SURGICAL", CLAVICLE: "RAMP_SURGICAL", JONES_5MT: "RAMP_SURGICAL",
  PATELLAR_TENDON: "RAMP_SURGICAL", BACK_DISC: "RAMP_SURGICAL", PEC: "RAMP_SURGICAL",
});

// ---------------------------------------------------------------------------------------------
// §6 play[practice_pattern] — P(plays this week) for a Questionable player (R7 §4.2).
//
// [DESIGN] throughout. No published play-rate-by-pattern table exists; these are priors
// constructed to average to the measured 71% marginal [1] over a plausible pattern mix, following
// the consensus qualitative rules: DNP→Limited→Full plays, DNP all three days very rarely plays,
// "if he can't practise Friday he won't play Sunday" [40][43]. R7 §6.6 step 4 names these as the
// numbers most in need of real data — the calibration log refits them first.
// ---------------------------------------------------------------------------------------------

const PLAY = Object.freeze({
  FP_FP_FP: 0.95,
  LP_FP_FP: 0.95,
  LP_LP_FP: 0.9,
  LP_LP_LP: 0.75,
  DNP_LP_LP: 0.55,
  DNP_DNP_LP: 0.35,
  DNP_DNP_DNP: 0.15,
  SHORT_WEEK_ONE_REPORT: 0.71, // fall back to the measured marginal [1]
  NO_PRACTICE_YET: 0.7,
  UNKNOWN: 0.7, // R7 §4.2: 0.70 is the evidence-matched constant when no practice data is available
});

/** R7 §4.2 [1]: Doubtful players play 5.9% of the time. Out is 0% by definition [40][42]. */
const PLAY_DOUBTFUL = 0.06;

export const PROGNOSIS_TABLES = Object.freeze({
  version: RUBRIC_ID,
  base: BASE,
  statusFallback: STATUS_FALLBACK,
  teamTimeline: TEAM_TIMELINE,
  seasonTypes: SEASON_TYPES,
  recurrence: RECURRENCE,
  ramp: RAMP,
  rampFloor: RAMP_SEASON_FLOOR,
  rampClassOf: RAMP_CLASS_OF,
  play: PLAY,
  playDoubtful: PLAY_DOUBTFUL,
  // R7 §6.4 steps 3-4: reporters beat the table but are optimistic; the team's word is coarser and
  // more reliable than a reporter's range, so it moves less but is trusted more often.
  w: Object.freeze({ reporter: 0.5, team: 0.35 }),
});

/** Ramp steps are `[{w, share}]` with `w` = the 1st, 2nd, 3rd GAME back (1-based), not a week. */
function b2(pairs) {
  return Object.freeze(pairs.map(([w, share]) => Object.freeze({ w, share })));
}

// ---------------------------------------------------------------------------------------------
// Distribution algebra. Internally a Map<games, p>; `games` is "NFL games missed from ctx.week
// inclusive" exactly as injuries.js defines it, and `SEASON_GAMES` is a STATE, not a count — no
// operation below ever moves it.
// ---------------------------------------------------------------------------------------------

function toMap(branches) {
  const out = new Map();
  for (const branch of branches || []) {
    if (!branch) continue;
    const games = Math.max(0, Math.round(Number(branch.games) || 0));
    const p = Number(branch.p);
    if (!Number.isFinite(p) || p <= 0) continue;
    out.set(games, (out.get(games) || 0) + p);
  }
  return out;
}

function normalize(map) {
  let sum = 0;
  for (const p of map.values()) sum += p;
  if (!(sum > 0)) return new Map([[0, 1]]);
  const out = new Map();
  for (const [games, p] of map) if (p > 0) out.set(games, p / sum);
  return out;
}

function toList(map) {
  return [...map.entries()]
    .filter(([, p]) => p > 0)
    .sort((a, c) => a[0] - c[0])
    .map(([games, p]) => ({ games, p }));
}

/** `(1 − w)·base + w·other`. A mixture with a FIXED partner preserves stochastic dominance. */
function blend(map, other, weight) {
  if (!other || !other.length || !(weight > 0)) return map;
  const out = new Map();
  for (const [games, p] of normalize(map)) out.set(games, p * (1 - weight));
  for (const [games, p] of normalize(toMap(other))) out.set(games, (out.get(games) || 0) + p * weight);
  return out;
}

/** Deterministic coupling `X ↦ max(0, X − k)`. Monotone. */
function shiftLeft(map, k) {
  if (!(k > 0)) return map;
  const out = new Map();
  for (const [games, p] of map) {
    const next = games >= SEASON_GAMES ? games : Math.max(0, games - k);
    out.set(next, (out.get(next) || 0) + p);
  }
  return out;
}

/** Deterministic coupling `X ↦ max(X, floor)`. Monotone. */
function floorAt(map, floor) {
  if (!(floor > 0)) return map;
  const out = new Map();
  for (const [games, p] of map) {
    const next = games >= SEASON_GAMES ? games : Math.max(floor, games);
    out.set(next, (out.get(next) || 0) + p);
  }
  return out;
}

/** Deterministic coupling `X ↦ min(X, cap)` on the non-season mass. Monotone. */
function capAt(map, cap) {
  const out = new Map();
  for (const [games, p] of map) {
    const next = games >= SEASON_GAMES ? games : Math.min(cap, games);
    out.set(next, (out.get(next) || 0) + p);
  }
  return out;
}

/** `share·δ₀ + (1 − share)·X` — what a designation does. A mixture, so monotone. */
function mixToZero(map, share) {
  const out = new Map([[0, Math.max(0, Math.min(1, share))]]);
  for (const [games, p] of map) out.set(games, (out.get(games) || 0) + p * (1 - share));
  return out;
}

/**
 * [lo, hi] weeks from a quote → a distribution over games (R7 §6.4 step 3).
 *
 * 1 NFL game ≈ 7 days, so weeks map straight onto games (R7 §1). [DESIGN]: 70% of the mass sits
 * uniformly inside the stated range and 30% sits just past it, because R7 §6.4 records that
 * reporters beat the table but run optimistic.
 */
function reporterSpread(weeks) {
  const [lo, hi] = weeks;
  const out = new Map();
  const span = hi - lo + 1;
  for (let g = lo; g <= hi; g += 1) out.set(g, (out.get(g) || 0) + 0.7 / span);
  out.set(hi + 1, (out.get(hi + 1) || 0) + 0.2);
  out.set(hi + 2, (out.get(hi + 2) || 0) + 0.1);
  return toList(out);
}

// ---------------------------------------------------------------------------------------------
// Schema normalization — totality lives here. An unknown enum value never throws; it becomes
// `UNKNOWN`, which widens. "A field with no citable evidence must be UNKNOWN — the function
// widens rather than guessing, which is the opposite of the failure mode where an LLM invents a
// grade" (R7 §6.2).
// ---------------------------------------------------------------------------------------------

function enumOr(value, list, fallback) {
  if (typeof value !== "string") return fallback;
  const up = value.toUpperCase();
  return list.includes(up) ? up : fallback;
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function normalizeSchema(schema) {
  const s = schema && typeof schema === "object" ? schema : {};
  let weeks = null;
  if (Array.isArray(s.reporter_timeline_weeks) && s.reporter_timeline_weeks.length) {
    const lo = Number(s.reporter_timeline_weeks[0]);
    const hi = Number(s.reporter_timeline_weeks.length > 1 ? s.reporter_timeline_weeks[1] : lo);
    // R7 §6.5 validator (g): monotone, `lo ≤ hi ≤ 26`.
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo && hi <= 26) {
      weeks = [Math.floor(lo), Math.floor(hi)];
    }
  }
  return {
    injury_type: enumOr(s.injury_type, ENUMS.injury_type, "UNKNOWN"),
    severity: enumOr(s.severity, ENUMS.severity, "UNKNOWN"),
    surgery: enumOr(s.surgery, ENUMS.surgery, "UNKNOWN"),
    side: enumOr(s.side, ENUMS.side, "UNKNOWN"),
    // Carried for the record and for the desk's validator; R7 §6.4 step 8 keeps the hazard flat
    // per type, so this field is audited but not indexed.
    recurrence: enumOr(s.recurrence, ENUMS.recurrence, "UNKNOWN"),
    team_timeline: enumOr(s.team_timeline, ENUMS.team_timeline, "UNKNOWN"),
    practice_pattern: enumOr(s.practice_pattern, ENUMS.practice_pattern, "UNKNOWN"),
    designation: enumOr(s.designation, ENUMS.designation, "NONE"),
    reporter_timeline_weeks: weeks,
    return_designation_used: s.return_designation_used === true,
    games_served: intOr(s.games_served, 0),
    days_since_injury: intOr(s.days_since_injury, 0),
    suspension_games: intOr(s.suspension_games, 0),
    position: typeof s.position === "string" ? s.position.toUpperCase() : null,
  };
}

/**
 * The ramp class this schema lands in (R7 §2.2). Exported because the dossier stores it so that
 * the choice is auditable rather than re-derived.
 * @param {object} schema
 * @returns {"RAMP_NONE"|"RAMP_MODERATE"|"RAMP_SURGICAL"}
 */
export function rampClassOf(schema) {
  const s = schema && schema.injury_type !== undefined ? schema : normalizeSchema(schema);
  const surgery = enumOr(s.surgery, ENUMS.surgery, "UNKNOWN");
  if (surgery !== "NONE" && surgery !== "UNKNOWN") return "RAMP_SURGICAL";
  return RAMP_CLASS_OF[s.injury_type] || "RAMP_MODERATE";
}

/**
 * The ramp for one player, tilted by position (R7 §2.2): the DECLINE, not the multiplier, scales.
 * @param {Array<{w:number, share:number}>} steps
 * @param {string|null} pos
 * @returns {Array<{w:number, share:number}>}
 */
export function rampFor(steps, pos) {
  const tilt = RAMP_POSITION_TILT[String(pos || "").toUpperCase()];
  if (!steps || !tilt || tilt === 1) return steps || null;
  return steps.map(({ w, share }) => ({ w, share: Math.max(0, Math.min(1, 1 - (1 - share) * tilt)) }));
}

// ---------------------------------------------------------------------------------------------
// The pure function — R7 §6.4, eight steps, in the stated order: evidence about the injury →
// clock → rules → this week's designation, i.e. most-general to most-specific.
// ---------------------------------------------------------------------------------------------

/**
 * Map one filled rubric schema to a games-missed distribution.
 *
 * TOTAL — every enum combination resolves; an unknown value widens and never throws.
 * MONOTONE in severity — stochastic dominance along `SEVERITY_ORDER`, holds because every step is
 *   either a mixture with a fixed partner or a deterministic monotone coupling.
 * DETERMINISTIC — no clock, no fetch, no randomness. Same input, byte-identical output.
 * @param {object} schema R7 §6.2 shape
 * @param {object} [tables] defaults to `PROGNOSIS_TABLES`
 * @returns {{branches:Array<{games:number,p:number}>, ramp:Array<{w:number,share:number}>,
 *           hazard:number, key:string, provenance:string[]}}
 */
export function prognose(schema, tables = PROGNOSIS_TABLES) {
  const T = tables && typeof tables === "object" ? tables : PROGNOSIS_TABLES;
  const s = normalizeSchema(schema);
  const provenance = [];

  // 1 — Base: the injury table, indexed by (type, severity, surgery).
  const byType = (T.base || {})[s.injury_type] || null;
  const bySeverity = byType ? byType[s.severity] || byType.UNKNOWN : null;
  let base = bySeverity ? bySeverity[s.surgery] || bySeverity.UNKNOWN : null;
  if (!base && byType && byType.UNKNOWN) base = byType.UNKNOWN.UNKNOWN || null;
  let row = `${s.injury_type}.${s.severity}.${s.surgery}`;
  let fromStatus = false;
  if (base) {
    provenance.push(`base ${row}`);
  } else {
    base = (T.statusFallback || {})[s.designation] || (T.statusFallback || {}).UNKNOWN || b({ 0: 1 });
    row = `status.${s.designation}`;
    fromStatus = true;
    provenance.push(`base ${row} (no table row for ${s.injury_type})`);
  }
  let dist = normalize(toMap(base));

  // 2 — Hard overrides. "Reconstruction and season-class types dominate everything below" — so the
  // evidence blends (3, 4) and the designation (7) are skipped, not merely applied afterwards. A
  // reporter's optimistic range must not argue a reconstructed ACL back onto the field, and a
  // stale Questionable tag must not put 70% of a torn Achilles at "plays this week".
  const hardSeason = s.surgery === "RECONSTRUCTION" || !!(T.seasonTypes && T.seasonTypes.has(s.injury_type));
  if (hardSeason) {
    dist = new Map([[SEASON_GAMES, 1]]);
    row = `season.${s.injury_type}.${s.surgery}`;
    provenance.push(
      s.surgery === "RECONSTRUCTION"
        ? "hard override: reconstruction ends the season"
        : `hard override: ${s.injury_type} is a season-class diagnosis`
    );
  }

  // 3 — Reporter timeline: blend, do not replace. Reporters beat the table but are optimistic.
  if (!hardSeason && s.reporter_timeline_weeks) {
    const [lo, hi] = s.reporter_timeline_weeks;
    dist = blend(dist, reporterSpread(s.reporter_timeline_weeks), T.w.reporter);
    provenance.push(`reporter ${lo}-${hi} wk blended at ${T.w.reporter}`);
  }

  // 4 — Team timeline: a coarser, more reliable signal than the reporter range.
  const team = !hardSeason ? (T.teamTimeline || {})[s.team_timeline] : null;
  if (team && team.length) {
    dist = blend(dist, team, T.w.team);
    provenance.push(`team ${s.team_timeline} blended at ${T.w.team}`);
  }

  // 5 — Clock already run: an injury 9 days old has burned one game of the base estimate.
  const shift = Math.floor(s.days_since_injury / 7);
  if (shift > 0) {
    dist = shiftLeft(dist, shift);
    provenance.push(`clock -${shift} game(s) (${s.days_since_injury} d since injury)`);
  }

  // 6 — Roster mechanism: a truncation, not a blend.
  const d = s.designation;
  if (d === "IR" || d === "PUP" || d === "NFI") {
    const floor = Math.max(0, 4 - s.games_served);
    if (floor > 0) {
      dist = floorAt(dist, floor);
      provenance.push(`${d} floor ${floor} game(s) = max(0, 4 - ${s.games_served} served)`);
    } else {
      provenance.push(`${d} minimum already served (${s.games_served} games)`);
    }
  } else if (d === "IR_R") {
    dist = capAt(dist, 3);
    provenance.push("IR-R: the 21-day activate-or-revert window caps the non-season mass at 3");
  } else if (d === "SUS") {
    if (s.suspension_games > 0 && s.suspension_games < SEASON_GAMES) {
      const left = Math.max(0, s.suspension_games - s.games_served);
      dist = new Map([[left, 1]]);
      row = `sus.${s.suspension_games}`;
      provenance.push(`suspension: stated ${s.suspension_games} games, ${s.games_served} served`);
    } else if (!fromStatus) {
      dist = normalize(toMap((T.statusFallback || {}).SUS));
      row = "status.SUS";
      provenance.push("suspension: no count stated, PED penalty schedule prior");
    } else {
      provenance.push("suspension: no count stated, prior already in play");
    }
  } else if (d === "EXEMPT" && !fromStatus) {
    dist = normalize(toMap((T.statusFallback || {}).EXEMPT));
    row = "status.EXEMPT";
    provenance.push("Commissioner's Exempt List: no fixed duration, exempt prior");
  }

  // 7 — Designation last: it is the freshest, most authoritative bit. Mass is moved ONTO game 0
  // by mixture and OFF it by `X ↦ max(X, 1)` — a conditional would break monotonicity, and
  // "he misses this game" is what Out actually means anyway.
  if (!hardSeason) {
    if (d === "Q") {
      const share = Number((T.play || {})[s.practice_pattern]);
      const p = Number.isFinite(share) ? share : Number((T.play || {}).UNKNOWN) || 0.7;
      dist = mixToZero(floorAt(dist, 1), p);
      provenance.push(`Q: P(plays) = ${p} from practice pattern ${s.practice_pattern}`);
    } else if (d === "D") {
      const p = Number.isFinite(Number(T.playDoubtful)) ? Number(T.playDoubtful) : PLAY_DOUBTFUL;
      dist = mixToZero(floorAt(dist, 1), p);
      provenance.push(`D: P(plays) = ${p}`);
    } else if (d === "O") {
      dist = floorAt(dist, 1);
      provenance.push("O: ruled out, no mass at game 0");
    }
  }

  // 8 — Soft-tissue recurrence is a POST-RETURN hazard, returned separately so `availability()`
  // can apply it week by week rather than inflating the absence.
  const hazard = Number((T.recurrence || {})[s.injury_type]) || 0;
  const rampClass = rampClassOf(s);

  return Object.freeze({
    branches: Object.freeze(toList(normalize(dist))),
    ramp: rampFor((T.ramp || {})[rampClass] || null, s.position),
    rampClass,
    hazard,
    key: `${RUBRIC_ID}:${row}|${d}`,
    provenance: Object.freeze(provenance),
  });
}

// ---------------------------------------------------------------------------------------------
// The dossier-first lookup — 004 design §2.4 precedence, R11 §Q11.3 "Engine precedence and decay".
// ---------------------------------------------------------------------------------------------

/** The ramp a slice row carries: a class name (design §2.4) or an explicit list (R11 §Q11.3). */
function rampOfSlice(slice) {
  const ramp = slice && slice.prog ? slice.prog.ramp : null;
  if (typeof ramp === "string") return RAMP[ramp] || null;
  if (Array.isArray(ramp) && ramp.length) {
    return ramp
      .filter((step) => step && Number.isFinite(Number(step.w)) && Number.isFinite(Number(step.share)))
      .map((step) => ({ w: Number(step.w), share: Number(step.share) }));
  }
  return null;
}

/**
 * This player's prognosis, dossier first and the table second.
 *
 * `source` is the audit trail the UI prints:
 *   "dossier" — a fresh slice row under this rubric whose `sk` still matches the live status;
 *   "table"   — `injuries.js` answered, either because there is no dossier or because the one
 *               there is may not be used (`stale` says which, `reason` says why);
 *   "none"    — nothing to say: no status and no dossier, i.e. a healthy player.
 *
 * Never mutates ctx. Memoized on `ctx.memo` keyed by id AND live status key, so a scenario ctx
 * (which always gets a fresh memo) can never inherit the previous status's answer (I3).
 * @param {object} ctx
 * @param {string} id
 * @param {object} [liveRow] status row to test against; defaults to the player's row in ctx
 * @returns {{branches:Array<{games:number,p:number}>, ramp:Array<{w:number,share:number}>|null,
 *           hazard:number, source:"dossier"|"table"|"none", stale:boolean, reason:string,
 *           key:string, asOf:string|null, mean:number, seasonOver:boolean}}
 */
export function dossierPrognosis(ctx, id, liveRow) {
  const pid = id == null ? "" : String(id);
  const stored = liveRow || (ctx && ctx.players && typeof ctx.players.get === "function" ? ctx.players.get(pid) : null);
  const probe = { ...(stored || {}), id: pid };
  const memoKey = `${pid}|${statusKeyOf(probe)}`;
  const memo = ctx && ctx.memo && typeof ctx.memo === "object" ? ctx.memo : null;
  if (memo) {
    if (!memo.dossierPrognosis) memo.dossierPrognosis = new Map();
    const hit = memo.dossierPrognosis.get(memoKey);
    if (hit) return hit;
  }

  const gate = dossierLookup(ctx, probe);
  let out;
  if (gate && gate.ok) {
    const branches = gate.branches.map((branch) => ({ ...branch }));
    let mean = 0;
    let seasonMass = 0;
    for (const branch of branches) {
      mean += branch.games * branch.p;
      if (branch.games >= SEASON_GAMES) seasonMass += branch.p;
    }
    out = {
      branches,
      ramp: rampOfSlice(gate.slice),
      hazard: Number(gate.slice.prog.hazard) || 0,
      source: "dossier",
      stale: false,
      reason: "",
      key: gate.key,
      asOf: typeof gate.slice.as_of === "string" ? gate.slice.as_of : null,
      mean,
      seasonOver: seasonMass >= 0.5,
    };
  } else {
    // `absenceOf` runs the same gate and takes the table path; calling it keeps ONE definition of
    // the fallback rather than a second copy of the rule ordering here.
    const absence = absenceOf(ctx, probe);
    out = {
      branches: absence.branches.map((branch) => ({ ...branch })),
      ramp: null,
      hazard: 0,
      source: absence.key === "none" && !gate ? "none" : "table",
      stale: gate ? gate.stale : false,
      reason: gate ? gate.reason : "",
      key: absence.key,
      asOf: gate && gate.slice && typeof gate.slice.as_of === "string" ? gate.slice.as_of : null,
      mean: absence.mean,
      seasonOver: absence.seasonOver,
    };
  }
  if (memo) memo.dossierPrognosis.set(memoKey, out);
  return out;
}
