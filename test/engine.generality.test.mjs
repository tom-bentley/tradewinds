// Any Sleeper league, not just Boyball (design.md §10.1–§10.3): projections v2 decoded with the
// league's own scoring, season shape read from league settings, superflex/IDP roster shapes, the
// per-shape value tables, and viewer mode where the user owns no roster.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildContext, projectionPoints, resolveSlots, seasonShape } from "../src/engine/context.js";
import { tableFor } from "../src/engine/values.js";
import { bestLineup } from "../src/engine/lineup.js";
import { evaluateTrade } from "../src/engine/trade.js";
import { findTrades } from "../src/engine/finder.js";
import { sideNames } from "../src/engine/explain.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// Fixtures load lazily inside a before() hook, never at import time: the pipeline regenerates
// projections.json and values_full.json while these tests run.
let INPUT;
let PROJ;
let PLAYERS;
let ctx;
before(() => {
  PROJ = fixture("projections.json");
  PLAYERS = fixture("players.json");
  INPUT = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    players: PLAYERS,
    projections: PROJ,
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
    state: fixture("state.json"),
  };
  ctx = buildContext(INPUT, { userId: "1394551386997272576" });
});

// ---------------------------------------------------------------------------------------------
// §10.1 — projections v2: raw stat lines, points computed here
// ---------------------------------------------------------------------------------------------

test("ANCHOR: v2 stat lines decode to the same week-1 points as the v1 league-exact fixture", () => {
  const v1 = fixture("projections_v1.json");
  assert.ok(Number(PROJ.version) >= 2 && Array.isArray(PROJ.keys), "the fixture is v2");
  // Sleeper re-projects weeks 2+ between pulls, so only week 1 is comparable across two snapshots;
  // QB/K/DEF differ by design (the v1 fixture is pts_half_ppr, Boyball scores passing and kicking
  // its own way).
  let compared = 0;
  let worst = 0;
  for (const [id, points] of ctx.proj) {
    const player = PLAYERS.players[id];
    const old = v1.players[id];
    if (!player || !old || !["RB", "WR", "TE"].includes(player.pos)) continue;
    compared += 1;
    const delta = Math.abs((points[0] || 0) - (Number(old[0]) || 0));
    assert.ok(delta <= 0.25, `${player.name} week 1: v2 ${points[0]} vs v1 ${old[0]}`);
    worst = Math.max(worst, delta);
  }
  assert.ok(compared > 100, `${compared} skill players compared in both files`);
  assert.ok(worst < 0.25);
});

test("the v2 decoder is Σ value × scoring, checked against a hand-rolled loop", () => {
  const scoring = INPUT.league.scoring_settings;
  const pick = (pos) =>
    Object.keys(PROJ.players).find(
      (id) => PLAYERS.players[id] && PLAYERS.players[id].pos === pos && Array.isArray(PROJ.players[id][0])
    );
  for (const pos of ["QB", "K"]) {
    const id = pick(pos);
    assert.ok(id, `the fixture has a ${pos} with a week-1 stat line`);
    const entry = PROJ.players[id][0];
    // independent decode: no engine code, no shared helper
    let expected = 0;
    for (let i = 0; i < entry.length; i += 2) {
      const key = PROJ.keys[entry[i]];
      const rate = scoring[key];
      expected += entry[i + 1] * (rate === undefined ? 0 : rate);
    }
    assert.ok(Math.abs(ctx.proj.get(id)[0] - expected) < 1e-6, `${pos} ${id} week 1`);
    assert.ok(expected > 0, `${pos} ${id} scores something in week 1`);
  }
});

test("projectionPoints scores only the keys the league pays for, and still reads v1", () => {
  const v2 = {
    version: 2,
    weeks: [1, 2, 3],
    keys: ["rush_yd", "rush_td", "idp_tkl"],
    players: { a: [[0, 100, 1, 2], 0, [2, 9]] },
  };
  const scoring = { rush_yd: 0.1, rush_td: 6 }; // idp_tkl is unscored → worth 0
  const points = projectionPoints(v2, scoring);
  assert.deepEqual(points.get("a"), [22, 0, 0], "0 weeks score nothing; unknown keys score nothing");

  const v1 = { season: "2026", weeks: [1, 2], players: { a: [12.5, "3"] } };
  assert.deepEqual(projectionPoints(v1, scoring).get("a"), [12.5, 3], "v1 numeric vectors pass through");
  assert.deepEqual(projectionPoints(undefined, scoring).size, 0);
});

test("the same stat lines are worth different points in a different league", () => {
  const tePremium = JSON.parse(JSON.stringify(INPUT.league));
  tePremium.scoring_settings = { ...tePremium.scoring_settings, rec: 1, bonus_rec_te: 0.5 };
  const ppr = buildContext({ ...INPUT, league: tePremium }, {});
  let higher = 0;
  let total = 0;
  for (const [id, points] of ppr.proj) {
    const player = PLAYERS.players[id];
    if (!player || !["WR", "TE"].includes(player.pos)) continue;
    const base = ctx.proj.get(id) || [];
    total += 1;
    if ((points[0] || 0) > (base[0] || 0) + 1e-9) higher += 1;
  }
  assert.ok(total > 50 && higher > total / 2, "full PPR pays receivers more than half PPR");
  assert.equal(ppr.league.ppr, 1);
});

// ---------------------------------------------------------------------------------------------
// §10.3 — season shape from league settings
// ---------------------------------------------------------------------------------------------

test("Boyball's season shape is unchanged: playoffs 15-17, last scoring week 17", () => {
  assert.equal(ctx.lastWeek, 17);
  assert.deepEqual(ctx.playoffWeeks, [15, 16, 17]);
  assert.deepEqual(ctx.weeksLeft, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(ctx.league.playoffRounds, 3, "6 playoff teams = a 3-round bracket with two byes");
});

test("a 4-team bracket with a two-week championship runs one week longer", () => {
  const shape = seasonShape({ playoff_week_start: 15, playoff_teams: 4, playoff_round_type: 1 });
  assert.equal(shape.rounds, 2);
  assert.equal(shape.playoffWeekCount, 3, "two rounds, the last of them two weeks long");
  assert.equal(shape.lastWeek, 17);
  assert.deepEqual(shape.playoffWeeks, [15, 16, 17]);

  const league = { ...fixture("league.json") };
  league.settings = { ...league.settings, playoff_week_start: 15, playoff_teams: 4, playoff_round_type: 1 };
  const small = buildContext({ ...INPUT, league }, {});
  assert.equal(small.lastWeek, 17);
  assert.deepEqual(small.playoffWeeks, [15, 16, 17]);

  // every round two weeks long pushes the season to 18
  const twoWeek = seasonShape({ playoff_week_start: 15, playoff_teams: 4, playoff_round_type: 2 });
  assert.equal(twoWeek.playoffWeekCount, 4);
  assert.equal(twoWeek.lastWeek, 18, "capped at Sleeper's week 18");
  assert.deepEqual(twoWeek.playoffWeeks, [15, 16, 17, 18]);
});

test("playoff_week_start 0 means no playoffs at all", () => {
  const shape = seasonShape({ playoff_week_start: 0, playoff_teams: 6 });
  assert.equal(shape.playoffStart, 0);
  assert.deepEqual(shape.playoffWeeks, []);
  assert.equal(shape.lastWeek, 17);

  const league = { ...fixture("league.json") };
  league.settings = { ...league.settings, playoff_week_start: 0 };
  const flat = buildContext({ ...INPUT, league }, {});
  assert.deepEqual(flat.playoffWeeks, []);
  assert.equal(flat.lastWeek, 17);
  assert.equal(flat.weeksLeft[flat.weeksLeft.length - 1], 17);
  // nothing downstream may divide by an empty playoff window
  const deal = evaluateTrade(flat, { myRosterId: 3, theirRosterId: 4, give: ["4866"], get: ["2133"] });
  assert.ok(Number.isFinite(deal.verdict.deltaPlayoffPerWeek));
  assert.equal(deal.me.lineup.after.playoffAvg, 0);
  assert.ok(!deal.reasons.some((r) => /playoffs/.test(r.text)), "no playoff clause without playoffs");
});

test("no trade deadline: 99 and 0 both mean trades never close", () => {
  for (const value of [99, 0]) {
    const league = { ...fixture("league.json") };
    league.settings = { ...league.settings, trade_deadline: value };
    const open = buildContext({ ...INPUT, league }, { userId: "1394551386997272576" });
    assert.equal(open.league.tradeDeadlineWeek, 0);
    const late = { ...open, week: 16, weeksLeft: [16, 17] };
    const deal = evaluateTrade(late, { myRosterId: 3, theirRosterId: 4, give: ["4866"], get: ["2133"] });
    assert.ok(!deal.flags.some((f) => f.type === "deadline"), `trade_deadline ${value} raises no flag`);
  }
});

// ---------------------------------------------------------------------------------------------
// §10.3 — roster shapes: superflex, IDP, missing K/DEF
// ---------------------------------------------------------------------------------------------

/** Stat keys and scoring for the synthetic leagues below. */
const KEYS = ["pass_yd", "pass_td", "rush_yd", "rush_td", "rec", "rec_yd", "rec_td"];
const SCORING = { pass_yd: 0.04, pass_td: 4, rush_yd: 0.1, rush_td: 6, rec: 0.5, rec_yd: 0.1, rec_td: 6 };
/** A week entry worth exactly `pts` for that position (passing yards for QBs, yards otherwise). */
const line = (pos, pts) => (pos === "QB" ? [0, pts / 0.04] : [2, pts / 0.1]);

/**
 * A synthetic league with exactly the roster shape under test.
 * @param {{rosterPositions:string[], squads:Array<string[]>, roster:Array<{id,pos,pts}>,
 *          settings?:object, values?:object}} spec
 */
function mini(spec) {
  const players = {};
  const projections = { version: 2, weeks: [1], keys: KEYS, players: {} };
  const values = { fc_redraft: { kind: "redraft", values: {} } };
  for (const p of spec.roster) {
    players[p.id] = { id: p.id, name: p.id.toUpperCase(), pos: p.pos, team: "FA", inj: null, bye: null };
    projections.players[p.id] = new Array(18).fill(0).map(() => line(p.pos, p.pts));
    if (!["K", "DEF"].includes(p.pos)) values.fc_redraft.values[p.id] = { v: Math.round(p.pts * 100) };
  }
  return {
    league: {
      league_id: "mini",
      name: "Mini",
      season: "2026",
      roster_positions: spec.rosterPositions,
      scoring_settings: spec.scoring || SCORING,
      settings: { num_teams: spec.squads.length, playoff_week_start: 15, playoff_teams: 4, ...(spec.settings || {}) },
    },
    users: spec.squads.map((_, i) => ({ user_id: `u${i + 1}`, display_name: `owner${i + 1}`, metadata: {} })),
    rosters: spec.squads.map((ids, i) => ({
      roster_id: i + 1,
      owner_id: `u${i + 1}`,
      players: [...ids],
      starters: [...ids],
      reserve: [],
      taxi: [],
      settings: {},
    })),
    players: { players },
    projections,
    values: { sources: spec.values || values },
    schedule: { byes: {} },
    state: { week: 1, season: "2026", season_type: "regular" },
  };
}

test("SUPER_FLEX starts a second quarterback when he outscores the flex bodies", () => {
  const roster = [
    { id: "qb1", pos: "QB", pts: 22 },
    { id: "qb2", pos: "QB", pts: 15 },
    { id: "rb1", pos: "RB", pts: 18 },
    { id: "rb2", pos: "RB", pts: 8 },
    { id: "wr1", pos: "WR", pts: 16 },
    { id: "wr2", pos: "WR", pts: 6 },
  ];
  const positions = ["QB", "RB", "WR", "SUPER_FLEX", "BN"];
  const ids = roster.map((p) => p.id);
  const ctxSf = buildContext(mini({ rosterPositions: positions, squads: [ids, []], roster }), {});
  assert.equal(ctxSf.league.numQbs, 2, "QB + SUPER_FLEX");
  assert.ok(ctxSf.flexEligible.has("QB"), "a superflex league flexes quarterbacks");

  const lineup = bestLineup(ctxSf, ids, 1);
  const sf = lineup.slots.find((s) => s.slot === "SUPER_FLEX");
  assert.equal(sf.id, "qb2", "the spare QB (15) beats the spare RB (8) and WR (6)");
  assert.deepEqual(lineup.short, []);
  assert.equal(lineup.slots.find((s) => s.slot === "QB").id, "qb1");

  // …and does not when he is the worse option
  const weakQb = roster.map((p) => (p.id === "qb2" ? { ...p, pts: 5 } : p));
  const ctxWeak = buildContext(mini({ rosterPositions: positions, squads: [ids, []], roster: weakQb }), {});
  assert.equal(bestLineup(ctxWeak, ids, 1).slots.find((s) => s.slot === "SUPER_FLEX").id, "rb2");
});

test("IDP slots are ignored, reported in ctx.unsupported, and never break a lineup", () => {
  const roster = [
    { id: "qb1", pos: "QB", pts: 20 },
    { id: "rb1", pos: "RB", pts: 14 },
    { id: "wr1", pos: "WR", pts: 12 },
    { id: "te1", pos: "TE", pts: 9 },
  ];
  const ids = roster.map((p) => p.id);
  const positions = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "IDP_FLEX", "BN", "BN"];
  const idp = buildContext(mini({ rosterPositions: positions, squads: [ids, []], roster }), {});
  assert.deepEqual(idp.unsupported, ["IDP slots"]);
  assert.deepEqual(idp.slots, ["QB", "RB", "WR", "TE"], "defensive slots are dropped from the lineup");
  assert.equal(idp.league.maxRoster, positions.length, "they still occupy roster spots");
  const lineup = bestLineup(idp, ids, 1);
  assert.deepEqual(lineup.short, [], "no phantom shortfall from a slot we cannot score");
  assert.equal(lineup.total, 20 + 14 + 12 + 9);

  const plain = buildContext(mini({ rosterPositions: ["QB", "RB", "WR", "BN"], squads: [ids, []], roster }), {});
  assert.deepEqual(plain.unsupported, [], "a league without IDP reports nothing");
});

test("K and DEF may be absent from roster_positions entirely", () => {
  const roster = [
    { id: "qb1", pos: "QB", pts: 20 },
    { id: "rb1", pos: "RB", pts: 14 },
    { id: "rb2", pos: "RB", pts: 11 },
    { id: "wr1", pos: "WR", pts: 12 },
  ];
  const ids = roster.map((p) => p.id);
  const noK = buildContext(mini({ rosterPositions: ["QB", "RB", "WR", "FLEX", "BN"], squads: [ids, []], roster }), {});
  assert.ok(!noK.slots.includes("K") && !noK.slots.includes("DEF"));
  const lineup = bestLineup(noK, ids, 1);
  assert.deepEqual(lineup.short, []);
  assert.equal(lineup.slots.find((s) => s.slot === "FLEX").id, "rb2");
});

// ---------------------------------------------------------------------------------------------
// §10.2 — one role, several tables
// ---------------------------------------------------------------------------------------------

test("value roles resolve to the table that matches the league shape", () => {
  const roster = [
    { id: "qb1", pos: "QB", pts: 20 },
    { id: "rb1", pos: "RB", pts: 14 },
    { id: "wr1", pos: "WR", pts: 12 },
  ];
  const ids = roster.map((p) => p.id);
  const table = (kind, v) => ({ kind, values: { qb1: { v }, rb1: { v }, wr1: { v } } });
  const full = {
    fc_redraft: table("redraft", 100),
    fc_redraft_2qb: table("redraft", 300),
    fc_dynasty: table("dynasty", 90),
    fc_dynasty_2qb: table("dynasty", 280),
    dp_dynasty: table("dynasty", 80),
    dp_dynasty_2qb: table("dynasty", 260),
    bc_tiers_std: table("tiers", null),
    bc_tiers_half: table("tiers", null),
    bc_tiers_ppr: table("tiers", null),
  };
  const build = (rosterPositions, scoring, values) =>
    buildContext(mini({ rosterPositions, squads: [ids, []], roster, values, scoring }), {});

  const oneQb = build(["QB", "RB", "WR", "BN"], SCORING, full);
  assert.equal(oneQb.league.numQbs, 1);
  assert.equal(tableFor(oneQb, "fc_redraft"), "fc_redraft");
  assert.equal(tableFor(oneQb, "fc_dynasty"), "fc_dynasty");
  assert.equal(tableFor(oneQb, "dp_dynasty"), "dp_dynasty");

  const twoQb = build(["QB", "SUPER_FLEX", "RB", "WR", "BN"], SCORING, full);
  assert.equal(twoQb.league.numQbs, 2);
  assert.equal(tableFor(twoQb, "fc_redraft"), "fc_redraft_2qb");
  assert.equal(tableFor(twoQb, "fc_dynasty"), "fc_dynasty_2qb");
  assert.equal(tableFor(twoQb, "dp_dynasty"), "dp_dynasty_2qb");
  const trueQb = build(["QB", "QB", "RB", "WR", "BN"], SCORING, full);
  assert.equal(trueQb.league.numQbs, 2, "two dedicated QB slots count too");
  assert.equal(tableFor(trueQb, "fc_redraft"), "fc_redraft_2qb");

  // the tier table follows the league's PPR setting, to the nearest published variant
  assert.equal(tableFor(build(["QB", "RB", "WR", "BN"], { ...SCORING, rec: 0 }, full), "bc_tiers"), "bc_tiers_std");
  assert.equal(tableFor(build(["QB", "RB", "WR", "BN"], { ...SCORING, rec: 0.5 }, full), "bc_tiers"), "bc_tiers_half");
  assert.equal(tableFor(build(["QB", "RB", "WR", "BN"], { ...SCORING, rec: 1 }, full), "bc_tiers"), "bc_tiers_ppr");
  assert.equal(tableFor(build(["QB", "RB", "WR", "BN"], { ...SCORING, rec: 0.4 }, full), "bc_tiers"), "bc_tiers_half");

  // a pipeline that only shipped the plain tables still works everywhere
  const plain = { fc_redraft: full.fc_redraft, fc_dynasty: full.fc_dynasty, bc_tiers: table("tiers", null) };
  const legacy = build(["QB", "SUPER_FLEX", "RB", "WR", "BN"], SCORING, plain);
  assert.equal(tableFor(legacy, "fc_redraft"), "fc_redraft", "falls back to the 1QB table");
  assert.equal(tableFor(legacy, "bc_tiers"), "bc_tiers", "falls back to the plain tier table");
  assert.equal(tableFor(legacy, "dp_dynasty"), null, "a role no table covers resolves to nothing");
});

test("a 2QB league prices quarterbacks off the 2QB table", () => {
  const roster = [
    { id: "qb1", pos: "QB", pts: 20 },
    { id: "rb1", pos: "RB", pts: 14 },
    { id: "wr1", pos: "WR", pts: 12 },
  ];
  const ids = roster.map((p) => p.id);
  const values = {
    fc_redraft: { kind: "redraft", values: { qb1: { v: 1000 }, rb1: { v: 5000 }, wr1: { v: 4000 } } },
    fc_redraft_2qb: { kind: "redraft", values: { qb1: { v: 6000 }, rb1: { v: 5000 }, wr1: { v: 4000 } } },
  };
  const one = buildContext(mini({ rosterPositions: ["QB", "RB", "WR", "BN"], squads: [ids, []], roster, values }), {});
  const two = buildContext(
    mini({ rosterPositions: ["QB", "SUPER_FLEX", "RB", "WR", "BN"], squads: [ids, []], roster, values }),
    {}
  );
  assert.equal(one.values.fc_redraft.values.qb1.v, 1000);
  const oneQbValue = tableFor(one, "fc_redraft");
  const twoQbValue = tableFor(two, "fc_redraft");
  assert.equal(oneQbValue, "fc_redraft");
  assert.equal(twoQbValue, "fc_redraft_2qb");
  assert.equal(one.values[oneQbValue].values.qb1.v, 1000);
  assert.equal(two.values[twoQbValue].values.qb1.v, 6000);
});

// ---------------------------------------------------------------------------------------------
// §10.3 — viewer mode
// ---------------------------------------------------------------------------------------------

test("viewer mode: no user, no roster of my own, and nothing throws", () => {
  const viewer = buildContext(INPUT, {}); // settings.userId is empty
  assert.equal(viewer.myRosterId, null);

  // the finder and the evaluator take explicit roster ids, so both still work
  const deal = evaluateTrade(viewer, { myRosterId: 2, theirRosterId: 6, give: ["4866"], get: ["2133"] });
  assert.ok(["invalid", "fair", "steal", "clear_win", "slight_win", "slight_loss", "clear_loss", "fleeced", "needs_drop"].includes(deal.verdict.code));
  assert.equal(typeof deal.verdict.label, "string");

  const offers = findTrades(viewer, { myRosterId: 2, maxResults: 2 });
  assert.ok(Array.isArray(offers));
  for (const offer of offers) assert.ok(offer.result.verdict.label);

  // and with no side A at all the result is an ordinary invalid, not an exception
  const noSide = evaluateTrade(viewer, { theirRosterId: 6, give: [], get: ["2133"] });
  assert.equal(noSide.verdict.code, "invalid");
  assert.equal(sideNames(viewer, 2, 6).first, false, "nobody is 'you' in viewer mode");
});

test("resolveSlots keeps the flex family and drops what it cannot score", () => {
  const all = resolveSlots(["QB", "RB", "WR", "WRRB_FLEX", "REC_FLEX", "SUPER_FLEX", "LB", "BN", "IR", "TAXI"]);
  assert.deepEqual(all.slots, ["QB", "RB", "WR", "WRRB_FLEX", "REC_FLEX", "SUPER_FLEX"]);
  assert.deepEqual(all.unsupported, ["IDP slots"]);
  assert.deepEqual(all.flexEligible.sort(), ["QB", "RB", "TE", "WR"]);
  const wrrb = resolveSlots(["RB", "WR", "WRRB_FLEX", "BN"]);
  assert.deepEqual(wrrb.flexEligible.sort(), ["RB", "WR"], "WRRB_FLEX does not flex tight ends");
  const none = resolveSlots(["QB", "RB", "WR", "BN"]);
  assert.deepEqual(none.flexEligible.sort(), ["RB", "TE", "WR"], "no flex slot falls back to the default");
});
