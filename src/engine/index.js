// src/engine/index.js — one import surface for the UI layer.
export {
  buildContext,
  buildHistory,
  mergeSettings,
  activePlayers,
  activeCount,
  tradeablePlayers,
  isReserve,
  isTaxi,
  irEligibleStatus,
  historyRow,
  historyWeekly,
  // 004 design §3.1 — player-intelligence inputs (optional, tolerant builders)
  buildStats,
  buildGames,
  buildDvp,
  buildDossiers,
  statsRow,
  gameFor,
  playerOf,
  rosterById,
  rosteredIds,
  rosPoints,
  resolveMyRosterId,
  slotEligibility,
  seasonShape,
  resolveSlots,
  projectionPoints,
  scoringMultipliers,
  resolveNow,
  FAAB_WAIVER_TYPE,
  DEFAULT_WAIVER_CLEAR_DAYS,
  DEFAULT_WAIVER_BUDGET,
  SLOT_ELIGIBILITY,
  BENCH_SLOTS,
  QB_SLOTS,
  IR_ALWAYS_STATUSES,
} from "./context.js";

export {
  curveFit,
  curveValue,
  marketValue,
  waiverReplacement,
  surplus,
  sideValue,
  scaleFactors,
  rosRanks,
  rosBaselines,
  injuryDiscount,
  rosterPctScale,
  tableFor,
  tableRows,
  tableCandidates,
  roleKind,
  REFERENCE_SOURCE,
  CURVE_SOURCE,
  ROLE_TABLES,
  BC_TIER_VARIANTS,
} from "./values.js";

export {
  bestLineup,
  seasonLineup,
  backfill,
  backfillPositions,
  freeAgentPoolByPos,
  slotDemand,
  weekPoints,
  weekVector,
  isBye,
  settingsBlock,
  streamerTable,
  streamerFor,
  streamBudget,
  WEEK_ZERO_STATUSES,
} from "./lineup.js";

// v1.4 risk axis (design §13.5 D4): per-player risk, starter/bench concentration, fragility,
// roster risk and the before/after delta a trade makes. `historyWeekly` stays internal to risk.js
// — context.js already exports a function of that name.
export {
  historyOf,
  durabilityOf,
  playerRisk,
  lineupConcentration,
  rosterFragility,
  rosterRisk,
  tradeRisk,
  consensusGaps,
  // 004 (design §3.5/§3.6): per-week roster mean/sd for the season map, underdog lambda helper
  rosterWeekly,
  lambdaEffective,
  LAMBDA_MARGIN_SCALE,
} from "./risk.js";

export {
  evaluateTrade,
  finalizeExplanation,
  rosterLanding,
  cheapestDroppable,
  acceptanceTier,
  edgeBand,
  edgePct,
  cachedSeasonLineup,
  verdictLabel,
  renderVerdictLabel,
  VERDICT_LABELS,
  EDGE_BANDS,
  LINEUP_OVERRIDE_PTS,
  VETO_EDGE,
  ACCEPT_EDGE,
  ACCEPT_DELTA,
} from "./trade.js";

export {
  findTrades,
  findLeagueTrades,
  tradePool,
  positionalSurplus,
  MAX_CANDIDATES,
  DEFAULT_SHAPES,
} from "./finder.js";

export {
  freeAgentPool,
  waiverStatus,
  findFreeAgents,
  gradeTransaction,
  suggestedBid,
  trendCount,
  alternativesAt,
  currentStarters,
  dropCandidates,
  protectedBySurplus,
  DAY_MS,
  CANDIDATES_PER_POS,
  MAX_FA_CANDIDATES,
  PROTECTED_BY_SURPLUS,
  MAX_BID_SHARE,
  BID_GAIN_SCALE,
  BID_PHASE_FLOOR,
  BID_AGGRESSIVE_MULT,
  ALT_BAND_PER_WEEK,
} from "./waiver.js";

export {
  absenceOf,
  availability,
  withAbsence,
  INJURY_RULES,
  STATUS_BRANCHES,
  IR_STATUSES,
  QUESTIONABLE_SHIFT,
  SEASON_GAMES,
  // 004 (design §2.4/§3.3): dossier gate — rubric id, statusKey formula, slice shape, lookup
  IR_RETURN_BRANCHES,
  DOSSIER_RUBRIC,
  statusKeyOf,
  sliceIsValid,
  dossierLookup,
} from "./injuries.js";

export {
  applyStatuses,
  applyWeekPoints,
  statusKey,
  diffStatuses,
  standingIssues,
  irEligible,
  irEligibility,
  advise,
  adviseAll,
  shortName,
  SUMMARY_MAX,
  HEADLINE_MAX,
  MOVE_EPSILON,
  TRADE_MEAN_GAMES,
  TRADE_HOLE_PER_WEEK,
  WIRE_RESULTS,
  MAX_ALTERNATIVES,
  NEXT_WEEKS,
  ISSUE_STATUSES,
  IR_ALWAYS,
  STATUS_CHAIN,
  SEVERITY_ORDER,
  // 004: the one-line provenance note for a dossier-driven absence ("per dossier (as of …)")
  absenceNoteOf,
} from "./advisor.js";

export {
  explain,
  sideNames,
  defaultNames,
  resolveNames,
  voice,
  flagText,
  expectedReturn,
  fmt0,
  fmt1,
  nameOf,
  namesOf,
  displayTier,
  acceptancePhrase,
  MAX_MEANINGFUL_TIER,
} from "./explain.js";

// 004 Player Intelligence (design §3). Each module is pure and optional-input tolerant: with no
// stats/games/dvp/dossiers in ctx every function degrades to null/neutral rather than throwing.

// §3.3 — the R7 prognosis rubric (codes in, numbers out) and the dossier-first absence path
export {
  RUBRIC_ID,
  ENUMS,
  SEVERITY_ORDER as PROGNOSIS_SEVERITY_ORDER, // advisor.js owns the bare name
  RAMP_POSITION_TILT,
  PROGNOSIS_TABLES,
  rampClassOf,
  rampFor,
  prognose,
  dossierPrognosis,
} from "./prognosis.js";

// §3.4 — K/DEF streaming model, Rotowire's embedded opponent factor (display only), grades, flags
export {
  teamImplied,
  oppImplied,
  oppFactor,
  streamingFactor,
  calibrationFactor,
  matchupFlags,
  matchupGrade,
} from "./matchup.js";

// §3.5 — season map: schedule, win probability, seeded simulation, holes and horizon-matched moves
export {
  seasonMapSettings,
  erf,
  normalCdf,
  pWin,
  weekStrength,
  mulberry32,
  buildSchedule,
  seedOrder,
  bracketShape,
  kindForHorizon,
  horizonBid,
  rankMoves,
  simulateSeason,
  seasonMap,
  HORIZON_KINDS,
  TRADE_MIN_WEEKS,
} from "./seasonmap.js";

// §3.2 — usage shares and trends from ctx.stats
export {
  TREND_SLOPE_MIN,
  olsSlope,
  usageOf,
  usageTotals,
} from "./usage.js";

// §3.6 — hidden value, roster synergy, acquire/sell lists
export {
  synergyScore,
  hiddenValue,
  acquireList,
  sellList,
  hiddenLists,
  unrosteredPriced,
} from "./hidden.js";
