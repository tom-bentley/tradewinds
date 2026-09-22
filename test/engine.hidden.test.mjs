// test/engine.hidden.test.mjs — hidden value, synergy and the two lists (R10 §4, 004 design §3.6).
//
// Nothing here asserts a 2026 player fact. The stats payload is INLINE and hand-built (decoded
// through the shipped `buildStats`, design §2.1 shape) and the history beside it is invented to
// make one player score under his opportunity and another over it — the two shapes the module
// exists to separate. Every expectation is either the contract's own algebra (`modelValue`'s four
// factors, `marketGap = modelValue − mAdj`) or one of R10 §4.8's failure modes.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULTS } from "../src/config.js";
import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import { marketValue } from "../src/engine/values.js";
import { playerRisk } from "../src/engine/risk.js";
import { usageTotals } from "../src/engine/usage.js";
import {
  GAP_TAU_PER_WEEK,
  SCARCITY_CAP,
  acquireList,
  hiddenLists,
  hiddenValue,
  sellList,
  synergyScore,
} from "../src/engine/hidden.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const MINE = 3; // Tom's roster in the Boyball fixture
const DEEBO = "5872"; // WR SF, un-rostered — pairs with my QB for the stack test
const HIGGINS = "6801"; // WR CIN, mine
const DOWNS = "9500"; // WR IND, mine
const REED = "10222"; // WR GB, mine
const BIGSBY = "9225"; // RB PHI, un-rostered, depth chart 2
const BARKLEY = "4866"; // RB PHI, mine, depth chart 1 — Bigsby's starter
const PURDY = "8183"; // QB SF, mine — Deebo's passer
const LOOP = "12711"; // K BAL, mine
const HOU_DEF = "HOU"; // DEF, mine

const KEYS = [
  "off_snp",
  "tm_off_snp",
  "gp",
  "rec_tgt",
  "rec",
  "rec_yd",
  "rec_td",
  "rec_rz_tgt",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rush_rz_att",
  "pass_att",
  "pass_yd",
  "pass_td",
  "pass_rz_att",
];

const line = (row) => {
  if (row == null) return 0;
  const out = [];
  for (const [k, v] of Object.entries(row)) out.push(KEYS.indexOf(k), v);
  return out;
};

const statsFile = (weeks, players, teams, partial = []) => ({
  version: 1,
  generated_at: "2026-09-22T12:00:00Z",
  season: "2026",
  weeks,
  partial,
  keys: KEYS,
  players: Object.fromEntries(Object.entries(players).map(([id, rows]) => [id, rows.map(line)])),
  std: {},
  teams,
});

const historyFile = (players, weeks) => ({ seasons: { 2026: { weeks, players } } });

/** Three identical weeks of the same usage line — flat on purpose, so the SCORES are the subject. */
const repeat = (row, n = 3) => Array.from({ length: n }, () => ({ ...row }));

const TEAM_WEEK = { tgt: 30, snp: 62, att: 38, rush: 24 };
const TEAMS = Object.fromEntries(
  ["SF", "CIN", "IND", "GB", "PHI"].map((t) => [t, { 1: TEAM_WEEK, 2: TEAM_WEEK, 3: TEAM_WEEK }])
);

const USAGE = statsFile(
  [1, 2, 3],
  {
    // scored far UNDER his opportunity — the buy shape
    [DEEBO]: repeat({ off_snp: 55, tm_off_snp: 62, gp: 1, rec_tgt: 12, rec_rz_tgt: 2 }),
    // scored far OVER it — the sell shape
    [HIGGINS]: repeat({ off_snp: 50, tm_off_snp: 62, gp: 1, rec_tgt: 6, rec_rz_tgt: 1 }),
    [DOWNS]: repeat({ off_snp: 40, tm_off_snp: 62, gp: 1, rec_tgt: 7 }),
    [REED]: repeat({ off_snp: 45, tm_off_snp: 62, gp: 1, rec_tgt: 8, rec_rz_tgt: 1 }),
    [BIGSBY]: repeat({ off_snp: 20, tm_off_snp: 62, gp: 1, rec_tgt: 2, rush_att: 12, rush_rz_att: 3 }),
    [BARKLEY]: repeat({ off_snp: 50, tm_off_snp: 62, gp: 1, rec_tgt: 3, rush_att: 18, rush_rz_att: 4 }),
  },
  TEAMS
);

const HISTORY = historyFile(
  {
    [DEEBO]: { gp: 3, ga: 3, w: [[2, 2], [2, 2], [2, 2]] }, //  3.0 /wk
    [HIGGINS]: { gp: 3, ga: 3, w: [[14, 4], [14, 4], [14, 4]] }, // 16.0 /wk
    [DOWNS]: { gp: 3, ga: 3, w: [[4, 2], [4, 2], [4, 2]] }, //  5.0 /wk
    [REED]: { gp: 3, ga: 3, w: [[5, 2], [5, 2], [5, 2]] }, //  6.0 /wk
    [BIGSBY]: { gp: 3, ga: 3, w: [[6, 0], [6, 0], [6, 0]] }, //  6.0 /wk
    [BARKLEY]: { gp: 3, ga: 3, w: [[20, 0], [20, 0], [20, 0]] }, // 20.0 /wk
  },
  3
);

let INPUT;
let bare; // no stats at all — the degrade path
let ctx; // stats + history loaded
before(() => {
  INPUT = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
    state: fixture("state.json"),
  };
  bare = buildContext(INPUT, {});
  ctx = buildContext({ ...INPUT, stats: USAGE, history: HISTORY }, {});
});

const build = (extra = {}, settings = {}) => buildContext({ ...INPUT, stats: USAGE, history: HISTORY, ...extra }, settings);

// ---------------------------------------------------------------------------------------------
// modelValue — R10 §4.3
// ---------------------------------------------------------------------------------------------

test("modelValue is mAdj × (1+α·usageZ) × (1+β·matchupZ) × (1−γ·riskZ), and marketGap is the difference", () => {
  const { alpha, beta, gamma } = DEFAULTS.hidden;
  assert.equal(beta, 0, "R8 §5.4 ruled the matchup term out for skill positions — it ships at zero");

  for (const id of [DEEBO, HIGGINS, BIGSBY, BARKLEY]) {
    const h = hiddenValue(ctx, id, { rosterId: MINE });
    const mAdj = marketValue(ctx, id).mAdj;
    assert.ok(mAdj != null, `${id} needs a market price for this test`);
    // the usage z is the only lever this test can reconstruct from outside; the risk z is the
    // residual, and it must be the same residual for every player (one formula, no special cases)
    const factorUsage = 1 + alpha * h.usage.z;
    const implied = h.modelValue / (mAdj * factorUsage);
    const riskZ = (1 - implied) / gamma;
    assert.ok(Math.abs(riskZ) <= 2 + 1e-9, `risk z ${riskZ} is clipped to ±2`);
    assert.ok(Math.abs(h.marketGap - (h.modelValue - mAdj)) < 1e-9);
    assert.ok(Math.abs(h.usage.z) <= 2 + 1e-9, "the usage z is clipped within position to ±2");
  }

  // the usage z is WITHIN POSITION and signed by the gap (R10 §4.3, §1.4 caveat 1)
  const buy = hiddenValue(ctx, DEEBO, { rosterId: MINE });
  const sell = hiddenValue(ctx, HIGGINS, { rosterId: MINE });
  assert.ok(buy.usage.perWeek > 0 && sell.usage.perWeek < 0);
  assert.ok(buy.usage.z > 0 && sell.usage.z < 0, `${buy.usage.z} / ${sell.usage.z}`);
  assert.ok(buy.modelValue > marketValue(ctx, DEEBO).mAdj * (1 - gamma * 2), "usage lifts the buy side");
});

test("β = 0: loading per-game context cannot move a single number on the row", () => {
  const games = {
    version: 1,
    games: [{ id: "g1", week: 1, home: "SF", away: "CIN", total: 51.5, spread: -7, roof: "dome", wind: 0 }],
  };
  const withGames = build({ games });
  assert.ok(withGames.games.size > 0, "the games file loaded");
  const a = hiddenValue(ctx, DEEBO, { rosterId: MINE });
  const b = hiddenValue(withGames, DEEBO, { rosterId: MINE });
  assert.equal(JSON.stringify(b), JSON.stringify(a));
});

// ---------------------------------------------------------------------------------------------
// R10 §4.8 failure modes
// ---------------------------------------------------------------------------------------------

test("R10 §4.8: a regression flag is SUPPRESSED under minWeeks played weeks", () => {
  assert.equal(DEFAULTS.hidden.minWeeks, 3);
  // the same enormous gap, on two weeks instead of three
  const short = build({
    stats: statsFile(
      [1, 2],
      { [DEEBO]: repeat({ off_snp: 55, tm_off_snp: 62, gp: 1, rec_tgt: 12, rec_rz_tgt: 2 }, 2) },
      { SF: { 1: TEAM_WEEK, 2: TEAM_WEEK } }
    ),
    history: historyFile({ [DEEBO]: { gp: 2, ga: 2, w: [[2, 2], [2, 2]] } }, 2),
  });
  const h = hiddenValue(short, DEEBO, { rosterId: MINE });
  assert.equal(h.usage.playedWeeks, 2);
  assert.ok(h.usage.perWeek > GAP_TAU_PER_WEEK, `the gap is ${h.usage.perWeek}/wk, well over τ`);
  assert.equal(h.usage.direction, "neutral", "two weeks is not a regression flag");
  assert.equal(h.confidence, "provisional");
  assert.ok(h.why.some((s) => s.includes("suppressed")), h.why.join(" | "));
  assert.ok(h.why.some((s) => s.includes(`Provisional — 2 of ${DEFAULTS.hidden.provisionalWeeks} weeks`)));

  // at three weeks the same shape fires, and says which side it is
  const full = hiddenValue(ctx, DEEBO, { rosterId: MINE });
  assert.equal(full.usage.playedWeeks, 3);
  assert.equal(full.usage.direction, "positive");
  assert.ok(full.why.some((s) => s.includes("scored under his opportunity")));
  assert.equal(hiddenValue(ctx, HIGGINS, { rosterId: MINE }).usage.direction, "negative");
  // and a gap inside τ is no flag at all, however many weeks there are
  assert.equal(hiddenValue(ctx, REED, { rosterId: MINE }).usage.direction, "neutral");
});

test("R10 §2.6: synergy never runs on K or DEF", () => {
  for (const id of [LOOP, HOU_DEF]) {
    const s = synergyScore(ctx, MINE, id);
    assert.deepEqual(s, { score: 0, parts: [] }, `${id} must not be scored for fit`);
    const h = hiddenValue(ctx, id, { rosterId: MINE });
    assert.equal(h.synergy.score, 0);
    assert.deepEqual(h.synergy.parts, []);
    assert.equal(h.modelValue, null, "K/DEF carry no market value, so there is no gap to find");
    assert.equal(h.marketGap, 0);
    assert.ok(h.why.some((s2) => s2.includes("no market price")), h.why.join(" | "));
  }
  // they are not on either list either
  const lists = hiddenLists(ctx, MINE, { n: 40 });
  for (const row of [...lists.acquire, ...lists.sell]) {
    assert.ok(!["K", "DEF"].includes(row.pos), `${row.name} is a ${row.pos}`);
  }
});

test("R5 §2.4 / R10 §4.8: rosterPct, tradeFreq and trending adds are never scored", () => {
  const noise = build({
    trending: [
      { player_id: DEEBO, count: 999999 },
      { player_id: HIGGINS, count: 888888 },
    ],
  });
  assert.ok(noise.trending.length > 0, "the trending feed loaded");
  for (const id of [DEEBO, HIGGINS, BARKLEY]) {
    const a = hiddenValue(ctx, id, { rosterId: MINE });
    const b = hiddenValue(noise, id, { rosterId: MINE });
    assert.equal(b.acquireScore, a.acquireScore, `${id} moved on trending adds`);
    assert.equal(b.sellScore, a.sellScore);
    assert.equal(b.verdict, a.verdict);
  }
  // rosterPct / tradeFreq are on the market row and are read by nothing here
  const mv = marketValue(ctx, DEEBO);
  assert.ok("rosterPct" in mv && "tradeFreq" in mv);
  // and the module's CODE never names them either — comments stripped first, so the prose that
  // promises this cannot be what satisfies it
  const code = readFileSync(new URL("../src/engine/hidden.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  for (const field of ["rosterPct", "tradeFreq", "trending", "trendCount"]) {
    assert.ok(!code.includes(field), `hidden.js reads ${field}`);
  }
});

test("R10 §4.8: with no usage loaded it degrades to market-and-risk, and says so", () => {
  assert.equal(bare.stats.size, 0);
  const h = hiddenValue(bare, DEEBO, { rosterId: MINE });
  assert.equal(h.usage.perWeek, null);
  assert.equal(h.usage.gap, null);
  assert.equal(h.usage.z, 0, "no usage means no usage term, not a guessed one");
  assert.equal(h.usage.direction, "neutral");
  assert.equal(h.usage.confidence, 0);
  assert.equal(h.trend.targetSlope, null);
  assert.equal(h.trend.real, false);
  assert.ok(h.modelValue != null, "the market and risk halves still work");
  assert.ok(h.why.some((s) => s.includes("market-price and risk comparison only")), h.why.join(" | "));

  const lists = hiddenLists(bare, MINE, { n: 5 });
  assert.equal(lists.basis, "market");
  assert.ok(lists.note.includes("No usage data is loaded"));
  assert.ok(lists.acquire.length > 0 && lists.sell.length > 0, "the screens still run");

  // ...and a loaded file that simply does not list him says something different
  const h2 = hiddenValue(ctx, "4046", { rosterId: MINE });
  assert.ok(h2.why.some((s) => s.includes("No usage lines are loaded for him")), h2.why.join(" | "));
});

// ---------------------------------------------------------------------------------------------
// synergy parts — R10 §4.6
// ---------------------------------------------------------------------------------------------

test("handcuff: a same-team depth-chart+1 back is named insurance, capped per R5 §4", () => {
  const { handcuffPerWeek, handcuffCap } = DEFAULTS.hidden.synergy;
  const mine = activePlayers(rosterById(ctx, MINE));
  assert.ok(mine.includes(BARKLEY), "the starter is on my roster");
  assert.equal(ctx.players.get(BARKLEY).team, ctx.players.get(BIGSBY).team);
  assert.equal(Number(ctx.players.get(BIGSBY).dc), Number(ctx.players.get(BARKLEY).dc) + 1);

  const s = synergyScore(ctx, MINE, BIGSBY);
  const part = s.parts.find((p) => p.kind === "handcuff");
  assert.ok(part, JSON.stringify(s.parts));
  assert.equal(part.delta, handcuffPerWeek);
  assert.ok(part.delta <= handcuffCap);
  assert.ok(part.reason.includes("direct backup"), part.reason);
  assert.ok(part.reason.includes("never worth a starter"), "R5 §4's direction rule travels with it");

  // a back on a team I hold nobody on gets no handcuff credit
  const other = synergyScore(ctx, MINE, "6039"); // BUF RB, depth chart 2 — my BUF back is dc 1
  const buf = other.parts.find((p) => p.kind === "handcuff");
  assert.ok(buf, "James Cook is dc 1 on BUF, so his dc-2 back IS a handcuff");
  const none = synergyScore(ctx, MINE, "9506"); // TB RB dc 3 — my TB back is dc 1, so not adjacent
  assert.equal(none.parts.find((p) => p.kind === "handcuff"), undefined);
});

test("stack: QB–WR only, and the sign is switched by the underdog weeks (R10 §2.1)", () => {
  const { stackCeiling, stackFloor } = DEFAULTS.hidden.synergy;
  assert.equal(ctx.players.get(PURDY).team, ctx.players.get(DEEBO).team);

  // default: no underdog weeks flagged ⇒ play the floor ⇒ the stack is a COST
  const off = synergyScore(ctx, MINE, DEEBO);
  const cold = off.parts.find((p) => p.kind === "stack");
  assert.ok(cold, JSON.stringify(off.parts.map((p) => p.kind)));
  assert.ok(cold.delta < 0, `${cold.delta}`);
  assert.ok(cold.reason.includes(`${stackCeiling}`) || cold.reason.includes("ceiling"));
  assert.ok(cold.reason.includes("cost"), cold.reason);

  // every remaining week flagged underdog ⇒ buy the ceiling ⇒ the stack is a CREDIT
  const hot = synergyScore(ctx, MINE, DEEBO, { underdogWeeks: ctx.weeksLeft });
  const warm = hot.parts.find((p) => p.kind === "stack");
  assert.ok(warm.delta > 0, `${warm.delta}`);
  assert.ok(warm.delta <= 1.0 + 1e-9 && cold.delta >= -1.0 - 1e-9, "capped at ±1.0 pts/wk");
  assert.ok(warm.reason.includes("underdog"));
  assert.ok(stackCeiling > stackFloor, "the ceiling shift is the bigger of the two [S2]");

  // R10 §2.1 explicitly refuses QB–RB (+0.07) and same-team WR–WR (−0.02)
  const qbRb = synergyScore(ctx, MINE, BIGSBY); // PHI RB, and I hold a PHI RB
  assert.equal(qbRb.parts.find((p) => p.kind === "stack"), undefined);
  const wrWr = synergyScore(ctx, MINE, "8167"); // GB WR, and I hold a GB WR
  assert.equal(wrWr.parts.find((p) => p.kind === "stack"), undefined);
});

test("bye: a crowded bye is a cost, a bye already behind him is a credit (R10 §2.3, §2.8)", () => {
  // Deebo's bye is the same week as three of my skill players'
  const bye = Number(ctx.players.get(DEEBO).bye);
  const mine = activePlayers(rosterById(ctx, MINE)).filter((id) => Number(ctx.players.get(id).bye) === bye);
  assert.ok(mine.length >= 2, `${mine.length} of my players already sit out week ${bye}`);
  const part = synergyScore(ctx, MINE, DEEBO).parts.find((p) => p.kind === "bye");
  assert.ok(part && part.delta < 0, JSON.stringify(part));
  assert.ok(part.delta >= -1.5 - 1e-9, "capped at ±1.5 pts/wk");
  assert.ok(part.reason.includes(`Week ${bye}`), part.reason);

  // fast-forward past his bye and the sign flips: one more usable game [S10]
  const later = buildContext(
    { ...INPUT, stats: USAGE, history: HISTORY, state: { ...fixture("state.json"), week: bye + 1, display_week: bye + 1 } },
    {}
  );
  const passed = synergyScore(later, MINE, DEEBO).parts.find((p) => p.kind === "bye");
  assert.ok(passed && passed.delta > 0, JSON.stringify(passed));
  assert.ok(passed.reason.includes("already passed"));
});

test("scarcity is read LIVE off waiverReplacement, never hard-coded (R10 §2.5)", () => {
  const parts = {};
  for (const id of [DEEBO, BIGSBY, "4046"]) {
    const p = synergyScore(ctx, MINE, id).parts.find((x) => x.kind === "scarcity");
    if (p) parts[ctx.players.get(id).pos] = p;
  }
  assert.ok(parts.QB, "a QB is scored for scarcity like everyone else");
  // QB replacement is 2–3× every skill position on this wire, so a QB is the CHEAPEST to replace
  assert.ok(parts.QB.delta < 0, `${parts.QB.delta}`);
  for (const p of Object.values(parts)) {
    assert.ok(Math.abs(p.delta) <= SCARCITY_CAP + 1e-9, `${p.kind} ${p.delta} broke the cap`);
    assert.ok(/\d/.test(p.reason), "the sentence quotes the live replacement values");
  }
});

// ---------------------------------------------------------------------------------------------
// the lists — R10 §4.7
// ---------------------------------------------------------------------------------------------

test("acquireList and sellList are sorted, disjoint, and every row carries its sentences", () => {
  const mine = new Set(activePlayers(rosterById(ctx, MINE)));
  const acquire = acquireList(ctx, MINE, 8);
  const sell = sellList(ctx, MINE, 8);

  assert.equal(acquire.length, 8);
  assert.ok(sell.length > 0 && sell.length <= 8);
  for (let i = 1; i < acquire.length; i += 1) assert.ok(acquire[i].score <= acquire[i - 1].score);
  for (let i = 1; i < sell.length; i += 1) assert.ok(sell[i].score <= sell[i - 1].score);

  for (const row of acquire) {
    assert.ok(!mine.has(row.id), `${row.name} is already mine`);
    assert.ok(row.why.length > 0 && row.why.every((s) => typeof s === "string" && s.endsWith(".")));
    assert.ok(Math.abs(row.score - row.hidden.acquireScore) < 1e-12);
  }
  for (const row of sell) {
    assert.ok(mine.has(row.id), `${row.name} is not on my roster`);
    assert.ok(Math.abs(row.score - row.hidden.sellScore) < 1e-12);
  }
  // n is honoured, and a silly n is answered rather than thrown at
  assert.equal(acquireList(ctx, MINE, 1).length, 1);
  assert.equal(acquireList(ctx, MINE, 0).length, 0);
  assert.deepEqual(sellList(ctx, 99, 5), [], "a roster that does not exist has nothing to sell");
});

test("the player who scored over his usage outranks his own teammates on the sell list", () => {
  const sell = sellList(ctx, MINE, 20);
  const rank = (id) => sell.findIndex((r) => r.id === id);
  assert.ok(rank(HIGGINS) >= 0 && rank(DOWNS) >= 0 && rank(REED) >= 0);
  // Higgins scored 16/wk on 6 targets; Downs and Reed scored close to their opportunity
  assert.ok(rank(HIGGINS) < rank(DOWNS), `Higgins ${rank(HIGGINS)} vs Downs ${rank(DOWNS)}`);
  assert.ok(rank(HIGGINS) < rank(REED));
  const top = sell[rank(HIGGINS)];
  assert.ok(top.why.some((s) => s.includes("scored over his opportunity")), top.why.join(" | "));
  assert.ok(top.why.some((s) => s.includes("a gap of")));

  // and the buy shape shows up on the acquire side with the same sentence machinery
  const acquire = acquireList(ctx, MINE, 150);
  const deebo = acquire.find((r) => r.id === DEEBO);
  assert.ok(deebo, "the buy-shaped player is on the acquire screen");
  assert.ok(deebo.why.some((s) => s.includes("scored under his opportunity")), deebo.why.join(" | "));
});

test("hiddenLists labels the basis, the weights and how provisional the read is", () => {
  const lists = hiddenLists(ctx, MINE, { n: 3 });
  assert.equal(lists.basis, "usage");
  assert.equal(lists.acquire.length, 3);
  assert.ok(lists.note.includes("0.35 / 0.35 / 0.20 / 0.10"), lists.note);
  assert.ok(lists.note.includes("engine-chosen"), "R5 §4: the weights are labelled where they render");
  assert.ok(lists.note.includes(`Provisional — 3 of ${DEFAULTS.hidden.provisionalWeeks} weeks`), lists.note);
});

// ---------------------------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------------------------

test("hiddenValue is deterministic, memoized, and never touches ctx outside memo", () => {
  const a = buildContext({ ...INPUT, stats: USAGE, history: HISTORY }, {});
  const b = buildContext({ ...INPUT, stats: USAGE, history: HISTORY }, {});
  const rowA = hiddenValue(a, DEEBO, { rosterId: MINE });
  assert.equal(hiddenValue(a, DEEBO, { rosterId: MINE }), rowA, "memoized");
  assert.equal(JSON.stringify(hiddenValue(b, DEEBO, { rosterId: MINE })), JSON.stringify(rowA));
  assert.notEqual(
    JSON.stringify(hiddenValue(a, DEEBO, { rosterId: 1 })),
    JSON.stringify(rowA),
    "a different roster is a different fit, and the memo key knows it"
  );
  assert.notEqual(
    JSON.stringify(hiddenValue(a, DEEBO, { rosterId: MINE, underdogWeeks: a.weeksLeft })),
    JSON.stringify(rowA),
    "the underdog switch is part of the memo key"
  );

  // the roster list itself is untouched by a full pass over both screens
  const before = JSON.stringify(rosterById(b, MINE).players);
  hiddenLists(b, MINE, { n: 10 });
  assert.equal(JSON.stringify(rosterById(b, MINE).players), before);
  // and two full passes on two identical contexts agree row for row
  assert.equal(
    JSON.stringify(hiddenLists(a, MINE, { n: 10 })),
    JSON.stringify(hiddenLists(b, MINE, { n: 10 }))
  );
});

test("the usage row on the hidden value is the usage module's own answer", () => {
  for (const id of [DEEBO, HIGGINS, BARKLEY]) {
    const h = hiddenValue(ctx, id, { rosterId: MINE });
    const t = usageTotals(ctx, id);
    assert.equal(h.usage.xfp, t.xfp);
    assert.equal(h.usage.actual, t.actual);
    assert.equal(h.usage.gap, t.gap);
    assert.equal(h.usage.perWeek, t.perWeek);
    assert.equal(h.usage.opportunities, t.opportunities);
    assert.equal(h.usage.playedWeeks, t.playedWeeks);
    // and the risk half is playerRisk's, not a second opinion
    assert.ok(playerRisk(ctx, id).score >= 0);
  }
});
