// src/engine/index.js — one import surface for the UI layer.
export {
  buildContext,
  mergeSettings,
  activePlayers,
  activeCount,
  playerOf,
  rosterById,
  rosteredIds,
  rosPoints,
  resolveMyRosterId,
  slotEligibility,
  SLOT_ELIGIBILITY,
  BENCH_SLOTS,
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
  REFERENCE_SOURCE,
  CURVE_SOURCE,
} from "./values.js";

export {
  bestLineup,
  seasonLineup,
  backfill,
  backfillPositions,
  freeAgentPool,
  slotDemand,
  weekPoints,
  weekVector,
  isBye,
  WEEK_ZERO_STATUSES,
} from "./lineup.js";

export {
  evaluateTrade,
  finalizeExplanation,
  cheapestDroppable,
  acceptanceTier,
  edgeBand,
  edgePct,
  cachedSeasonLineup,
  VERDICT_LABELS,
  EDGE_BANDS,
  LINEUP_OVERRIDE_PTS,
  VETO_EDGE,
  ACCEPT_EDGE,
  ACCEPT_DELTA,
} from "./trade.js";

export { findTrades, tradePool, positionalSurplus, MAX_CANDIDATES, DEFAULT_SHAPES } from "./finder.js";

export {
  explain,
  flagText,
  fmt0,
  fmt1,
  nameOf,
  namesOf,
  displayTier,
  acceptancePhrase,
  MAX_MEANINGFUL_TIER,
} from "./explain.js";
