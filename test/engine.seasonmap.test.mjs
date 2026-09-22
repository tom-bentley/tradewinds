// test/engine.seasonmap.test.mjs — the season axis (004 design §3.5, contract R9 §Q9.5).
//
// Nothing here asserts a projection. Every number pinned below is either a DEFAULTS value, a
// property of the LIVE schedule fixture (pulled 2026-09-22, so it is evidence rather than a
// guess), or an identity that must hold whatever the fixtures say: probabilities lie in [0,1],
// a bye is a superset of a title, Φ is symmetric, two runs of a seeded simulator agree exactly.
//
// The fixture league is Boyball: 8 teams, 6 playoff berths, playoff_week_start 15, trade deadline
// week 10, FAAB $100. `state.json` is FROZEN at week 1 (R13 §Q13.3), so tests that need a live
// week patch the INPUT object rather than the file.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULTS } from "../src/config.js";
import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import {
  EQUITY_CANDIDATES,
  FAAB_MAX_SHARE,
  FAAB_PLAYOFF_RESERVE,
  HOLE_MIN_PTS,
  MAX_MOVES,
  TRADE_MIN_WEEKS,
  bracketShape,
  buildSchedule,
  erf,
  horizonBid,
  kindForHorizon,
  normalCdf,
  pWin,
  rankMoves,
  seasonMap,
  seedOrder,
  simulateSeason,
  weekStrength,
} from "../src/engine/seasonmap.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const MINE = 3; // Tom
const MATCHUPS = fixture("matchups_2026_w3-17.json");
const BRACKET = fixture("winners_bracket_2026.json");
/** The fixture covers weeks 3-17; week 3 was the live week when it was pulled. */
const FIRST = 3;

let INPUT;
let ctx;
let schedule;
before(() => {
  INPUT = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
    // The frozen fixture says week 1; the matchup fixture starts at week 3. Patching the INPUT
    // (never the file) is how every other 004 test moves the clock.
    state: { ...fixture("state.json"), week: FIRST, display_week: FIRST },
  };
  ctx = buildContext(INPUT, {});
  schedule = buildSchedule(MATCHUPS, BRACKET, ctx);
});

/** A ctx with patched player rows and/or settings — the same helper engine.risk.test.mjs uses. */
function build(patch = {}) {
  const players = { ...INPUT.players, players: { ...INPUT.players.players } };
  for (const [id, row] of Object.entries(patch.players || {})) {
    players.players[id] = { ...players.players[id], ...row };
  }
  return buildContext({ ...INPUT, players }, patch.settings || {});
}

// ---------------------------------------------------------------------------------------------
// DEFAULTS.seasonMap — the block other workstreams read
// ---------------------------------------------------------------------------------------------

test("DEFAULTS.seasonMap carries exactly the contract's keys and R9's calibrated values", () => {
  const cfg = DEFAULTS.seasonMap;
  assert.deepEqual(Object.keys(cfg).sort(), ["corr", "objective", "omega", "seed", "sims", "strong", "weak"]);
  assert.equal(cfg.objective, "bye");
  assert.equal(cfg.omega.bye, 2.0, "seeding ω — the same number lineup.js has always used");
  assert.equal(cfg.omega.title, 8.0, "R-16: a playoff-week point is worth 8-11× a regular one");
  assert.equal(cfg.strong, 0.6);
  assert.equal(cfg.weak, 0.4);
  assert.equal(cfg.sims, 20000);
  assert.equal(cfg.seed, 20260922);
  assert.equal(cfg.corr, 0);
  // The map owns ω for ITS OWN weighting only. lineup.js's playoffWeight is untouched, or every
  // other consumer in the engine silently changes its answers (design §3.5).
  assert.equal(DEFAULTS.playoffWeight, 2.0);
});

// ---------------------------------------------------------------------------------------------
// buildSchedule
// ---------------------------------------------------------------------------------------------

test("buildSchedule yields 15 weeks of pairings from the live fixture", () => {
  const weeks = Object.keys(schedule.byWeek).map(Number).sort((a, b) => a - b);
  assert.deepEqual(weeks, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  for (const w of weeks) {
    const row = schedule.byWeek[w];
    assert.equal(Object.keys(row).length, 8, `week ${w} pairs all eight rosters`);
    for (const [a, b] of Object.entries(row)) {
      assert.ok(Number.isFinite(b), `roster ${a} has an opponent in week ${w}`);
      assert.notEqual(Number(a), b, "nobody plays themselves");
      assert.equal(row[b], Number(a), "the pairing is symmetric");
    }
  }
  assert.equal(schedule.source, "sleeper:/matchups");
  assert.equal(schedule.pulledAt, MATCHUPS.pulled_at);
  assert.deepEqual(schedule.playoffWeeks, [15, 16, 17]);
});

test("the schedule is a double round-robin: weeks 10-14 repeat weeks 3-7 exactly", () => {
  // R9 §Q9.2 Finding 2. The fixture starts at week 3, so the verifiable half of the property is
  // the second meeting: week w+7 is the same rival as week w for every w the fixture covers.
  for (let w = FIRST; w <= 7; w += 1) {
    assert.equal(
      schedule.byWeek[w + 7][MINE],
      schedule.byWeek[w][MINE],
      `week ${w + 7} is roster 3's rematch with week ${w}`,
    );
  }
  // …and across weeks 3-14 roster 3 meets seven distinct rivals, none more than twice.
  const seen = new Map();
  for (let w = FIRST; w <= 14; w += 1) {
    const foe = schedule.byWeek[w][MINE];
    seen.set(foe, (seen.get(foe) || 0) + 1);
  }
  assert.equal(seen.size, 7, "seven rivals in an eight-team league");
  for (const [foe, n] of seen) assert.ok(n <= 2, `roster ${foe} appears ${n} times, more than twice`);
  assert.equal([...seen.values()].reduce((a, b) => a + b, 0), 12);
});

test("weeks 15-17 have matchup rows, but the bracket overrides them and says it is provisional", () => {
  for (const w of [15, 16, 17]) assert.ok(Number.isFinite(schedule.byWeek[w][MINE]), `week ${w} still has a row`);
  assert.equal(schedule.bracket.provisional, true, "no game is resolved, so no seed is real");
  assert.equal(schedule.bracket.asOfWeek, FIRST);
  assert.deepEqual(schedule.bracket.rounds.map((r) => r.week), [15, 16, 17]);
  // Round 1 is the two first-round games; the two byes are named directly in round 2.
  assert.equal(schedule.bracket.rounds[0].games.length, 2);
  for (const round of schedule.bracket.rounds) {
    for (const game of round.games) {
      assert.ok(Number.isFinite(game.m));
      // `Number(null)` is 0 — an unresolved slot must stay null or it enters as a phantom roster.
      assert.ok(game.t1 === null || game.t1 > 0, "no phantom roster 0");
      assert.ok(game.t2 === null || game.t2 > 0, "no phantom roster 0");
    }
  }
});

test("completed weeks keep their real points; unplayed weeks contribute no results", () => {
  // The fixture was pulled during week 3, so nothing in weeks 3-17 is scored yet.
  assert.deepEqual(schedule.results, {});
  const played = buildSchedule({ 1: [
    { roster_id: 1, matchup_id: 1, points: 121.5 },
    { roster_id: 2, matchup_id: 1, points: 98.2 },
  ] }, [], ctx);
  assert.deepEqual(played.results, { 1: { 1: 121.5, 2: 98.2 } });
  assert.equal(played.byWeek[1][1], 2);
});

test("an unpaired roster maps to null rather than vanishing", () => {
  const odd = buildSchedule({ 5: [
    { roster_id: 1, matchup_id: 1 },
    { roster_id: 2, matchup_id: 1 },
    { roster_id: 3, matchup_id: 2 },
  ] }, [], ctx);
  assert.equal(odd.byWeek[5][1], 2);
  assert.equal(odd.byWeek[5][3], null, "a bye week is still a week");
});

test("malformed or missing input degrades to an empty schedule, never a throw", () => {
  for (const bad of [null, undefined, {}, [], { weeks: null }]) {
    const out = buildSchedule(bad, null, ctx);
    assert.deepEqual(out.byWeek, {});
    assert.deepEqual(out.bracket.rounds, []);
    assert.equal(out.bracket.provisional, true);
  }
});

// ---------------------------------------------------------------------------------------------
// bracketShape / seedOrder — read the league's structure, never assume it
// ---------------------------------------------------------------------------------------------

test("the bracket's entrant count is read off the live rows: 6 of 8, two byes", () => {
  const shape = bracketShape(ctx, schedule);
  assert.equal(shape.teams, 6, "four seeded into round 1 plus two named directly in round 2");
  assert.equal(shape.rounds, 3);
  assert.equal(shape.byes, 2, "seeds 1 and 2 skip week 15");
  assert.equal(shape.slots, 8);
  assert.equal(shape.seedType, 0);
});

test("seedOrder reproduces the standard bracket, and Boyball's live pairings fall out of it", () => {
  assert.deepEqual(seedOrder(1), [1, 2]);
  assert.deepEqual(seedOrder(2), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(3), [1, 8, 4, 5, 2, 7, 3, 6]);
  // With 6 teams, seeds 7 and 8 are absent: round 1 is 4v5 and 3v6, and the semis are
  // 1 v winner(4v5) and 2 v winner(3v6) — exactly the shape /winners_bracket returned live.
  const order = seedOrder(3);
  const round1 = [];
  for (let i = 0; i < order.length; i += 2) {
    const pair = [order[i], order[i + 1]].filter((s) => s <= 6);
    if (pair.length === 2) round1.push(pair);
  }
  assert.deepEqual(round1, [[4, 5], [3, 6]]);
});

// ---------------------------------------------------------------------------------------------
// pWin / weekStrength
// ---------------------------------------------------------------------------------------------

test("erf and Φ match their published values to the approximation's error bound", () => {
  // A&S 7.1.26 is a rational APPROXIMATION: its coefficients sum to 0.999999999, so erf(0) is
  // ~1e-9 rather than 0. Asserting the published bound is the honest test; special-casing zero in
  // the engine would hide the approximation instead of documenting it.
  assert.ok(Math.abs(erf(0)) < 1.5e-7);
  assert.ok(Math.abs(erf(1) - 0.8427007929) < 1.5e-7);
  assert.ok(Math.abs(erf(-1) + 0.8427007929) < 1.5e-7, "odd function");
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1.5e-7);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.645) - 0.05) < 1e-4);
});

test("pWin is a coin flip at equal means and symmetric about it", () => {
  assert.ok(Math.abs(pWin(140, 29, 140, 29) - 0.5) < 1.5e-7, "equal means is a coin flip");
  const up = pWin(150, 29, 140, 29);
  const down = pWin(140, 29, 150, 29);
  assert.ok(Math.abs(up + down - 1) < 1e-9, "P(A beats B) + P(B beats A) = 1");
  assert.ok(up > 0.5 && up < 0.65, `a 10-point edge is worth ~12 pp, not a certainty (got ${up})`);
});

test("pWin is compressed — the product's most important honest message", () => {
  // R9 §Q9.3: σ_margin ≈ 29 dwarfs every realistic weekly edge, so even a 20-point favourite is
  // nowhere near a lock. If this ever reads like a certainty, the model has been mis-specified.
  const huge = pWin(160, 20.5, 140, 20.5);
  assert.ok(huge < 0.76, `a 20-point edge should stay under ~0.76, got ${huge}`);
  // …and one projected point buys about 1.3 pp at a coin flip (the manager's exchange rate).
  const perPoint = pWin(141, 20.5, 140, 20.5) - 0.5;
  assert.ok(perPoint > 0.01 && perPoint < 0.02, `expected ~1.3 pp per point, got ${perPoint * 100} pp`);
});

test("pWin clamps, never divides by zero, and honours the correlation dial", () => {
  assert.equal(pWin(150, 0, 140, 0), 1, "no variance at all is a certainty");
  assert.equal(pWin(140, 0, 150, 0), 0);
  assert.equal(pWin(140, 0, 140, 0), 0.5, "no variance and no edge short-circuits to exactly 0.5");
  assert.equal(pWin(NaN, NaN, NaN, NaN), 0.5);
  // Positive correlation shrinks the margin's variance, so the same edge reads as a bigger lead.
  assert.ok(pWin(150, 29, 140, 29, 0.5) > pWin(150, 29, 140, 29, 0));
  for (const p of [pWin(300, 1, 100, 1), pWin(100, 1, 300, 1)]) assert.ok(p >= 0 && p <= 1);
});

test("weekStrength splits on the derived 0.60/0.40 thresholds, not round numbers", () => {
  assert.equal(weekStrength(0.75), "strong");
  assert.equal(weekStrength(0.6), "strong", "the boundary is inclusive");
  assert.equal(weekStrength(0.5999), "even");
  assert.equal(weekStrength(0.45), "even");
  assert.equal(weekStrength(0.4), "weak", "the boundary is inclusive");
  assert.equal(weekStrength(0.2), "weak");
  assert.equal(weekStrength(0.5, { strong: 0.52, weak: 0.48 }), "even");
  assert.equal(weekStrength(0.55, { strong: 0.52, weak: 0.48 }), "strong");
});

// ---------------------------------------------------------------------------------------------
// simulateSeason
// ---------------------------------------------------------------------------------------------

test("simulateSeason is deterministic — two runs of the same ctx agree exactly", () => {
  const a = simulateSeason(buildContext(INPUT, {}), schedule, { rosterId: MINE, n: 4000 });
  const b = simulateSeason(buildContext(INPUT, {}), schedule, { rosterId: MINE, n: 4000 });
  assert.deepEqual(a, b, "a pure engine may not return different odds for the same input");
  // …and a different seed genuinely moves it, so the determinism above is not a frozen constant.
  const c = simulateSeason(buildContext(INPUT, {}), schedule, { rosterId: MINE, n: 4000, seed: 7 });
  assert.notDeepEqual(a, c);
});

test("every odd is a probability, and playoff ⊇ bye ⊇ title", () => {
  const odds = simulateSeason(ctx, schedule, { rosterId: MINE });
  for (const key of ["playoffOdds", "firstRoundByeOdds", "topSeedOdds", "titleOdds"]) {
    assert.ok(odds[key] >= 0 && odds[key] <= 1, `${key} = ${odds[key]} is not a probability`);
  }
  assert.ok(odds.playoffOdds >= odds.firstRoundByeOdds, "a bye implies a berth");
  assert.ok(odds.firstRoundByeOdds >= odds.topSeedOdds, "the top seed is one of the two byes");
  assert.ok(odds.firstRoundByeOdds >= odds.titleOdds, "you cannot win it more often than you are seeded 1-2… in this league");
  assert.ok(odds.expectedWins >= 0 && odds.expectedWins <= 12, "12 regular-season games remain from week 3");
  assert.equal(odds.n, DEFAULTS.seasonMap.sims);
  assert.equal(odds.seed, DEFAULTS.seasonMap.seed);
});

test("simulateSeason runs 20 000 seasons inside the budget", () => {
  const fresh = buildContext(INPUT, {});
  simulateSeason(fresh, schedule, { rosterId: MINE, n: 1 }); // warm the μ/σ grid, which is shared
  const started = process.hrtime.bigint();
  simulateSeason(fresh, schedule, { rosterId: MINE, n: 20000, seed: 1 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Soft budget: the design target is 300 ms, and CI machines are slower than a dev box.
  assert.ok(ms < 1500, `20 000 seasons took ${ms.toFixed(0)} ms`);
});

test("a stronger roster wins more often — the simulator responds to its inputs", () => {
  const base = simulateSeason(buildContext(INPUT, {}), schedule, { rosterId: MINE, n: 8000 });
  const boosted = simulateSeason(buildContext(INPUT, {}), schedule, {
    rosterId: MINE,
    n: 8000,
    // +10 pts/wk everywhere, which R9 §4.7 measures at +14 pp of title.
    bump: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i + FIRST, 10])),
  });
  assert.ok(boosted.expectedWins > base.expectedWins);
  assert.ok(boosted.titleOdds > base.titleOdds);
  assert.ok(boosted.firstRoundByeOdds > base.firstRoundByeOdds);
});

// ---------------------------------------------------------------------------------------------
// seasonMap — the week cards
// ---------------------------------------------------------------------------------------------

test("seasonMap returns one card per week from..17, each with the contract's fields", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  assert.equal(map.weeks.length, 15);
  assert.deepEqual(map.weeks.map((c) => c.week), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

  for (const card of map.weeks) {
    assert.deepEqual(Object.keys(card).sort(), [
      "holes", "isPlayoffWeek", "margin", "me", "moves", "opp", "pWin", "scheduleIsProvisional", "strength", "week",
    ]);
    assert.equal(card.isPlayoffWeek, card.week >= 15);
    assert.equal(card.scheduleIsProvisional, card.week >= 15, "weeks 15-17 are bracket weeks, not scheduled ones");
    assert.equal(card.me.lineup.length, ctx.slots.length);
    assert.ok(card.me.mean > 0 && card.me.sd > 0);
    assert.ok(Array.isArray(card.me.short));
    assert.ok(card.opp.rosterId !== MINE);
    assert.ok(card.opp.mean > 0);
    assert.ok(["optimal", "set"].includes(card.opp.basis));
    assert.ok(Math.abs(card.margin - (card.me.mean - card.opp.mean)) < 0.11, "margin is me − opp");
    assert.ok(card.pWin > 0 && card.pWin < 1);
    assert.equal(card.strength, weekStrength(card.pWin, DEFAULTS.seasonMap));
    assert.ok(card.moves.length <= MAX_MOVES);
  }
});

test("the live week is read against the opponent's SET lineup; future weeks against his optimal", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  assert.equal(map.weeks[0].week, ctx.week);
  assert.equal(map.weeks[0].opp.basis, "set", "this week his lineup is locked in — read what he set");
  for (const card of map.weeks.slice(1)) {
    assert.equal(card.opp.basis, "optimal", "he gets a Wednesday to fix every future week");
  }
});

test("the opponent each week is the one the live schedule names", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  for (const card of map.weeks) {
    assert.equal(card.opp.rosterId, schedule.byWeek[card.week][MINE]);
    assert.equal(card.opp.teamName, rosterById(ctx, card.opp.rosterId).teamName);
  }
});

test("strength classes partition the season and follow the thresholds", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  const counts = { strong: 0, even: 0, weak: 0 };
  for (const card of map.weeks) counts[card.strength] += 1;
  assert.equal(counts.strong + counts.even + counts.weak, 15);
  // The compression message again, now on the real schedule: nothing should read as a lock.
  for (const card of map.weeks) assert.ok(card.pWin > 0.2 && card.pWin < 0.85, `week ${card.week} P=${card.pWin}`);
  assert.ok(counts.even >= 5, "σ_margin swamps most weekly edges — most weeks are genuinely even");
});

test("seasonMap never mutates ctx beyond its memo, and is stable under repetition", () => {
  const fresh = buildContext(INPUT, {});
  const before = { week: fresh.week, lastWeek: fresh.lastWeek, rosters: fresh.rosters.length };
  const a = seasonMap(fresh, { rosterId: MINE, from: FIRST, to: 17, schedule });
  const b = seasonMap(fresh, { rosterId: MINE, from: FIRST, to: 17, schedule });
  assert.deepEqual(a, b, "memoized and pure");
  assert.deepEqual({ week: fresh.week, lastWeek: fresh.lastWeek, rosters: fresh.rosters.length }, before);
  assert.deepEqual(
    activePlayers(rosterById(fresh, MINE)).sort(),
    activePlayers(rosterById(buildContext(INPUT, {}), MINE)).sort(),
  );
});

test("a window narrower than the season is honoured", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: 5, to: 8, schedule });
  assert.deepEqual(map.weeks.map((c) => c.week), [5, 6, 7, 8]);
});

test("a roster that does not exist yields an empty map rather than throwing", () => {
  const map = seasonMap(ctx, { rosterId: 99, from: FIRST, to: 17, schedule });
  assert.deepEqual(map.weeks, []);
  assert.equal(map.summary.playoffOdds, 0);
});

// ---------------------------------------------------------------------------------------------
// holes — by cause
// ---------------------------------------------------------------------------------------------

test("a starter's bye opens a one-week hole at his slot, named as a bye", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  const byes = map.weeks.flatMap((c) => c.holes.filter((h) => h.cause === "bye").map((h) => ({ week: c.week, ...h })));
  assert.ok(byes.length > 0, "a 17-man roster always has a bye-week hole somewhere");
  for (const hole of byes) {
    assert.deepEqual(hole.weeks, [hole.week], "a bye is exactly one week — that is its whole horizon");
    assert.ok(hole.playerId, "the bye names who is missing");
    assert.equal(Number(ctx.players.get(hole.playerId).bye ?? ctx.byes[ctx.players.get(hole.playerId).team]), hole.week);
    assert.ok(hole.lossVsTypical >= HOLE_MIN_PTS);
    assert.ok([null, "bench", "stream"].includes(hole.coveredBy));
  }
});

test("a season-ending injury is a hole for the rest of the map, not a new normal", () => {
  // The trap this guards: a player who is out for the SEASON never starts, so a rule that compares
  // a slot to its own average would see no deviation and report the roster's biggest hole as fine.
  const TE = "11604"; // Brock Bowers, roster 3's starting tight end
  const hurt = build({ players: { [TE]: { inj: "IR", injPart: "Knee", injNotes: "Torn ACL, out for the season" } } });
  const map = seasonMap(hurt, { rosterId: MINE, from: FIRST, to: 17, schedule: buildSchedule(MATCHUPS, BRACKET, hurt) });

  const injured = map.weeks.flatMap((c) => c.holes.filter((h) => h.cause === "injury"));
  assert.ok(injured.length >= 5, `expected the TE hole to persist, saw ${injured.length} weeks`);
  assert.ok(injured.every((h) => h.playerId === TE), "the cause names the player who is hurt");
  assert.ok(injured.every((h) => h.slot === "TE"));
  assert.ok(injured.every((h) => h.weeks.length >= 1 && h.weeks.every((w) => w >= FIRST && w <= 17)));
  // A healthy roster has no injury holes at all, so the test above is measuring the patch.
  const healthy = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  assert.equal(healthy.weeks.flatMap((c) => c.holes.filter((h) => h.cause === "injury")).length, 0);
});

test("a suspension is its own cause, with a horizon the engine can be certain about", () => {
  const RB = "8138"; // James Cook
  const sus = build({ players: { [RB]: { inj: "Sus", injPart: null, injNotes: "Suspended 4 games" } } });
  const map = seasonMap(sus, { rosterId: MINE, from: FIRST, to: 17, schedule: buildSchedule(MATCHUPS, BRACKET, sus) });
  const holes = map.weeks.flatMap((c) => c.holes);
  const suspended = holes.filter((h) => h.cause === "suspension");
  assert.ok(suspended.length > 0, "a suspension must not be filed as an injury");
  assert.ok(suspended.every((h) => h.playerId === RB));
  assert.equal(holes.filter((h) => h.cause === "injury" && h.playerId === RB).length, 0);
});

test("every hole names a cause from the contract's vocabulary and carries its own horizon", () => {
  const hurt = build({ players: { 11604: { inj: "IR", injPart: "Knee", injNotes: "Torn ACL" } } });
  const map = seasonMap(hurt, { rosterId: MINE, from: FIRST, to: 17, schedule: buildSchedule(MATCHUPS, BRACKET, hurt) });
  const causes = new Set();
  for (const card of map.weeks) {
    for (const hole of card.holes) {
      assert.deepEqual(Object.keys(hole).sort(), ["cause", "coveredBy", "lossVsTypical", "playerId", "slot", "weeks"]);
      assert.ok(["bye", "injury", "suspension", "empty", "thin"].includes(hole.cause), hole.cause);
      assert.ok(ctx.slots.includes(hole.slot));
      assert.ok(hole.weeks.includes(card.week), "the card's week is inside its own hole's horizon");
      assert.ok(hole.lossVsTypical >= 0);
      causes.add(hole.cause);
    }
  }
  assert.ok(causes.has("bye") && causes.has("injury"), `saw ${[...causes]}`);
});

// ---------------------------------------------------------------------------------------------
// moves — GapFill, equity ranking, the horizon gate
// ---------------------------------------------------------------------------------------------

test("kindForHorizon implements R9's four horizons", () => {
  assert.equal(kindForHorizon(1), "stream");
  assert.equal(kindForHorizon(2), "short-add");
  assert.equal(kindForHorizon(4), "short-add");
  assert.equal(kindForHorizon(5), "season-add");
  assert.equal(kindForHorizon(14), "season-add");
});

test("every GapFill carries the contract's fields, and its kind matches the hole's horizon", () => {
  const hurt = build({ players: { 11604: { inj: "IR", injPart: "Knee", injNotes: "Torn ACL" } } });
  const map = seasonMap(hurt, { rosterId: MINE, from: FIRST, to: 17, schedule: buildSchedule(MATCHUPS, BRACKET, hurt) });
  const cards = map.weeks.filter((c) => c.moves.length);
  assert.ok(cards.length > 0, "an IR'd starter must generate at least one recommendation");

  for (const card of cards) {
    for (const move of card.moves) {
      assert.deepEqual(Object.keys(move).sort(), [
        "addId", "cost", "dropId", "kind", "pointsPerWeek", "titleEquity", "totalPoints",
        "weeksCovered", "why", "window", "winEquity",
      ].sort());
      assert.ok(["stream", "short-add", "season-add", "trade"].includes(move.kind));
      assert.ok(move.addId);
      assert.ok(Array.isArray(move.weeksCovered) && move.weeksCovered.length > 0);
      assert.ok(Number.isFinite(move.pointsPerWeek) && Number.isFinite(move.totalPoints));
      assert.ok(Number.isFinite(move.winEquity));
      assert.ok(move.cost && Number.isFinite(move.cost.rosterSpotWeeks));
      assert.ok(move.window && Number.isFinite(move.window.availableFrom));
      assert.ok(Array.isArray(move.why) && move.why.length >= 2, "every move explains itself");
      assert.ok(move.why.some((line) => /win probability|title odds/.test(line)), "…including what it is ranked on");
      // The add is never someone this roster already holds.
      assert.ok(!activePlayers(rosterById(hurt, MINE)).includes(move.addId));
    }
  }
});

test("moves are ranked by equity, never by points, and the horizon gate outranks equity", () => {
  // Pinned on the comparator itself: a fixture cannot be relied on to produce the exact pair of
  // candidates this rule exists to separate.
  const matched = { addId: "A", _fit: true, winEquity: 0.01, titleEquity: 0.001, totalPoints: 3, pointsPerWeek: 3 };
  const sprawling = { addId: "B", _fit: false, winEquity: 0.09, titleEquity: 0.009, totalPoints: 40, pointsPerWeek: 3 };
  const [first, second] = rankMoves([sprawling, matched], "bye");
  assert.equal(first.addId, "A", "a fill longer than the hole ranks below a matched one, whatever its equity");
  assert.equal(second.addId, "B");

  // Within one fit band the objective's equity decides — and points do not.
  const lowPtsHighEquity = { addId: "C", _fit: true, winEquity: 0.05, titleEquity: 0.0002, totalPoints: 4, pointsPerWeek: 4 };
  const highPtsLowEquity = { addId: "D", _fit: true, winEquity: 0.02, titleEquity: 0.0090, totalPoints: 60, pointsPerWeek: 5 };
  assert.equal(rankMoves([highPtsLowEquity, lowPtsHighEquity], "bye")[0].addId, "C", "bye ranks on winEquity");
  assert.equal(rankMoves([lowPtsHighEquity, highPtsLowEquity], "title")[0].addId, "D", "title ranks on titleEquity");
});

test("a one-week bye hole is priced as a stream, not as a season-long add", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  const card = map.weeks.find((c) => c.holes.some((h) => h.cause === "bye" && h.weeks.length === 1) && c.moves.length);
  if (!card) return; // the wire may already cover every bye on this roster — that is a valid answer
  for (const move of card.moves.filter((m) => m.kind !== "trade")) {
    assert.equal(move.kind, "stream");
    if (move.cost.faab != null) {
      assert.ok(move.cost.faab <= 5, `a one-week hole must never cost more than a few dollars, got $${move.cost.faab}`);
    }
  }
});

test("trades appear only for a hole worth one, and only before the deadline", () => {
  const hurt = build({ players: { 11604: { inj: "IR", injPart: "Knee", injNotes: "Torn ACL" } } });
  const map = seasonMap(hurt, { rosterId: MINE, from: FIRST, to: 17, schedule: buildSchedule(MATCHUPS, BRACKET, hurt) });
  for (const card of map.weeks) {
    const holes = card.holes;
    for (const move of card.moves.filter((m) => m.kind === "trade")) {
      assert.equal(move.window.tradeDeadlineWeek, ctx.league.tradeDeadlineWeek);
      assert.ok(
        holes.some((h) => h.weeks.length >= TRADE_MIN_WEEKS && h.weeks[0] <= ctx.league.tradeDeadlineWeek),
        `week ${card.week} proposed a trade with no hole long enough to justify one`,
      );
      assert.equal(move.cost.faab, null, "a trade is not a claim");
    }
  }
});

test("the title objective re-ranks on title equity and scores only the front runners", () => {
  const hurt = build({ players: { 11604: { inj: "IR", injPart: "Knee", injNotes: "Torn ACL" } } });
  const sched = buildSchedule(MATCHUPS, BRACKET, hurt);
  const map = seasonMap(hurt, { rosterId: MINE, from: FIRST, to: 17, schedule: sched, objective: "title" });
  assert.equal(map.summary.objective, "title");
  assert.equal(map.summary.omega, DEFAULTS.seasonMap.omega.title);
  const scored = map.weeks.flatMap((c) => c.moves).filter((m) => m.titleEquity != null);
  assert.ok(scored.length > 0, "the title objective must actually run the simulation");
  for (const card of map.weeks) {
    assert.ok(card.moves.length <= Math.min(MAX_MOVES, EQUITY_CANDIDATES * 4));
    const equities = card.moves.map((m) => (m.titleEquity != null ? m.titleEquity : m.winEquity));
    for (let i = 1; i < equities.length; i += 1) {
      assert.ok(equities[i] <= equities[i - 1] + 1e-9, "the card's moves are sorted by title equity");
    }
  }
  // The bye objective is the default and must differ in what it weights.
  const bye = seasonMap(buildContext(INPUT, {}), { rosterId: MINE, from: FIRST, to: 17, schedule });
  assert.equal(bye.summary.objective, "bye");
  assert.equal(bye.summary.omega, DEFAULTS.seasonMap.omega.bye);
});

test("the objective can also be set through ctx.settings rather than the call", () => {
  const titled = buildContext(INPUT, { seasonMap: { objective: "title" } });
  const map = seasonMap(titled, { rosterId: MINE, from: 15, to: 17, schedule: buildSchedule(MATCHUPS, BRACKET, titled) });
  assert.equal(map.summary.objective, "title");
  assert.equal(map.summary.omega, 8);
});

// ---------------------------------------------------------------------------------------------
// FAAB — Δ × weeks started, not a phase multiplier
// ---------------------------------------------------------------------------------------------

test("horizonBid prices a claim on what it buys, and FALLS as the horizon shortens", () => {
  // R9 §4.3 R-8: waiver.js's phase term makes the same player a $10 bid in week 1 and $27 in
  // week 17. These four points are the sourced curve (R5 §2.3, 4for4 [R11], Fantasy Upside [R12]).
  assert.equal(horizonBid(94, 3), 2, "one week of +3 is a $1-2 stream, no exceptions");
  assert.equal(horizonBid(94, 12), 9, "a 3-week bridge at +4 is a mid-tier bid");
  assert.equal(horizonBid(94, 36), 28, "+3 for the rest of the season is the big bid");
  assert.equal(horizonBid(94, 400), Math.round(94 * FAAB_MAX_SHARE), "never more than the cap on one claim");
  // Monotone in total points, and always at least a dollar while there is budget.
  assert.ok(horizonBid(94, 3) <= horizonBid(94, 12));
  assert.ok(horizonBid(94, 12) <= horizonBid(94, 36));
  assert.equal(horizonBid(94, 0), 1);
  assert.equal(horizonBid(0, 50), 0, "no budget, no bid");
  // The phase term survives only where unspent money is a pure loss.
  assert.ok(horizonBid(94, 3, true) > horizonBid(94, 3, false));
});

// ---------------------------------------------------------------------------------------------
// SeasonSummary
// ---------------------------------------------------------------------------------------------

test("the summary carries every field the contract names", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  const s = map.summary;
  for (const key of [
    "expectedWins", "playoffOdds", "firstRoundByeOdds", "topSeedOdds", "titleOdds",
    "weakest", "strongest", "faab", "sigmaCalibration", "objectiveAdvice",
  ]) {
    assert.ok(key in s, `summary is missing ${key}`);
  }
  assert.ok(s.expectedWins.regular > 0 && s.expectedWins.regular <= 12);
  assert.equal(s.expectedWins.total, s.expectedWins.regular, "the fixture roster is 0-0, so total = regular");
  assert.match(s.expectedWins.record, /^\d+\.\d-\d+\.\d$/);
  // The record's two halves add up to the games that will have been played.
  const [w, l] = s.expectedWins.record.split("-").map(Number);
  assert.ok(Math.abs(w + l - 12) < 0.11, `record ${s.expectedWins.record} does not total 12 games`);

  assert.equal(s.weakest.length, 3);
  assert.equal(s.strongest.length, 3);
  assert.ok(s.weakest[0].pWin <= s.weakest[1].pWin && s.weakest[1].pWin <= s.weakest[2].pWin);
  assert.ok(s.strongest[0].pWin >= s.strongest[1].pWin && s.strongest[1].pWin >= s.strongest[2].pWin);
  assert.ok(s.strongest[0].pWin >= s.weakest[0].pWin);
  assert.ok(typeof s.objectiveAdvice === "string" && s.objectiveAdvice.length > 20);
});

test("expected wins is the sum of the regular-season weeks' P(win), and excludes the bracket", () => {
  const map = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  const regular = map.weeks.filter((c) => !c.isPlayoffWeek);
  assert.equal(regular.length, 12, "weeks 3-14");
  const sum = regular.reduce((a, c) => a + c.pWin, 0);
  assert.ok(Math.abs(map.summary.expectedWins.regular - sum) < 0.02);
});

test("the FAAB plan front-loads what is left and reserves for the playoff weeks", () => {
  const { faab } = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule }).summary;
  assert.equal(faab.remaining, 100, "the fixture roster has spent nothing");
  assert.equal(faab.reservedForPlayoffs, Math.round(100 * FAAB_PLAYOFF_RESERVE));
  assert.ok(faab.plannedByQuarter.length >= 1);
  for (const q of faab.plannedByQuarter) {
    assert.ok(q.to >= ctx.week, "a quarter already behind us is not a plan");
    assert.ok(q.budget >= 0 && q.budget <= faab.remaining);
  }
  const planned = faab.plannedByQuarter.reduce((a, q) => a + q.budget, 0);
  assert.ok(planned + faab.reservedForPlayoffs <= faab.remaining + 2, "the plan never exceeds the budget");
});

test("sigma calibration reports the model, its sample size, and what was measured against it", () => {
  const { sigmaCalibration: cal } = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule }).summary;
  assert.equal(cal.model, "positionCv");
  assert.ok(cal.sigmaTeam > 0);
  assert.ok(Math.abs(cal.sigmaMargin - cal.sigmaTeam * Math.SQRT2) < 0.02, "σ_margin = √2 · σ_team");
  // Nothing in weeks 3-17 has been played, so there is no residual sample and none is invented.
  assert.equal(cal.n, 0);
  assert.equal(cal.measuredSigmaTeam, null);
  assert.equal(cal.ci95, null);
  assert.match(cal.source, /model only/);
  assert.match(cal.note, /R9/, "the note cites where the measured range comes from");
});

test("sigma calibration measures real residuals once completed weeks are in the schedule", () => {
  const withResults = buildSchedule(
    {
      ...MATCHUPS.weeks,
      1: ctx.rosters.map((r, i) => ({ roster_id: r.rosterId, matchup_id: 1 + (i >> 1), points: 120 + i * 4 })),
      2: ctx.rosters.map((r, i) => ({ roster_id: r.rosterId, matchup_id: 1 + (i >> 1), points: 135 - i * 3 })),
    },
    BRACKET,
    ctx,
  );
  const { sigmaCalibration: cal } = seasonMap(buildContext(INPUT, {}), {
    rosterId: MINE, from: FIRST, to: 17, schedule: withResults,
  }).summary;
  assert.ok(cal.n > 0, "16 team-weeks of real points must be used, not ignored");
  assert.ok(cal.measuredSigmaTeam > 0);
  assert.ok(Array.isArray(cal.ci95) && cal.ci95[0] <= cal.measuredSigmaTeam && cal.ci95[1] >= cal.measuredSigmaTeam);
  assert.match(cal.source, /wk1\.\.wk2/);
});

test("the advice leads with the bye when the berth is already bought", () => {
  const { summary } = seasonMap(ctx, { rosterId: MINE, from: FIRST, to: 17, schedule });
  // R-15: at ~90 % playoff odds the berth is not the live question, the bye is.
  if (summary.playoffOdds >= 0.9 && summary.firstRoundByeOdds < 0.9) {
    assert.match(summary.objectiveAdvice, /bye/i);
  }
  assert.ok(summary.objectiveAdvice.includes("%"), "the advice quotes the number it is based on");
});

// ---------------------------------------------------------------------------------------------
// the WS-K seam
// ---------------------------------------------------------------------------------------------

test("an injected rosterWeekly overrides the local sigma, ready for WS-K's export", () => {
  const rosterWeekly = (_ctx, rosterId) => {
    assert.equal(rosterId, MINE);
    return Array.from({ length: 15 }, (_, i) => ({ week: i + FIRST, mean: 150, sd: 10 }));
  };
  const map = seasonMap(buildContext(INPUT, {}), {
    rosterId: MINE, from: FIRST, to: 17, schedule, rosterWeekly,
  });
  for (const card of map.weeks) {
    assert.equal(card.me.mean, 150);
    assert.equal(card.me.sd, 10);
  }
});
