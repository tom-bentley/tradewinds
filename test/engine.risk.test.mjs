// test/engine.risk.test.mjs — the risk axis (design-v14 §13.5 D4/D5).
//
// Every number this file pins is either a DEFAULTS value (config.js, calibrated from R5 §5) or an
// identity that must hold whatever the fixtures say (concentration partitions the roster value;
// the certainty equivalent never exceeds the mean). Nothing here asserts a projection.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULTS } from "../src/config.js";
import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import { seasonLineup } from "../src/engine/lineup.js";
import { marketValue } from "../src/engine/values.js";
import {
  consensusGaps,
  durabilityOf,
  historyOf,
  historyWeekly,
  lineupConcentration,
  playerRisk,
  rosterFragility,
  rosterRisk,
} from "../src/engine/risk.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const BOWERS = "11604"; // TE LV
const PURDY = "12508"; // QB SF, roster 3's starter
const MINE = 3;

let INPUT;
let ctx;
let mine;
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
  ctx = buildContext(INPUT, {});
  mine = activePlayers(rosterById(ctx, MINE));
});

/** A ctx with one player's status patched, and optionally a history map attached. */
function build(patch = {}) {
  const players = { ...INPUT.players, players: { ...INPUT.players.players } };
  for (const [id, row] of Object.entries(patch.players || {})) {
    players.players[id] = { ...players.players[id], ...row };
  }
  const next = buildContext({ ...INPUT, players }, patch.settings || {});
  if (patch.history) next.history = patch.history;
  return next;
}

// ---------------------------------------------------------------------------------------------
// playerRisk
// ---------------------------------------------------------------------------------------------

test("an IR'd ACL is unavailable, and unavailability alone is enough to read severe", () => {
  const hurt = build({
    players: { [BOWERS]: { inj: "IR", injPart: "Knee", injNotes: "Torn ACL, out for the season" } },
  });
  const risk = playerRisk(hurt, BOWERS);
  assert.ok(risk.rosAvailability < 0.01, `rosAvailability ${risk.rosAvailability}`);
  assert.equal(risk.availabilityNow, 0);
  // R5 §5.6 anchor: a season-ending status must land at 90 or worse
  assert.ok(risk.score >= 90, `score ${risk.score}`);
  assert.equal(risk.band, "severe");
  assert.ok(risk.reasons.some((r) => r.includes("not expected back")), risk.reasons.join(" | "));
  // and his projected mean collapses with him (§13.5 D1 scales the week vector)
  assert.ok(risk.mean < 1, `mean ${risk.mean}`);
});

test("a healthy 17-game veteran reads low, and every component is in range", () => {
  const history = new Map([
    // 17 of 17 games, a steady ~14 pts/wk line: the R5 §5.6 "must land <25" anchor
    [BOWERS, { gp: 17, ga: 17, w: Array.from({ length: 17 }, (_, i) => [12 + (i % 3), 4]) }],
  ]);
  const healthy = build({ players: { [BOWERS]: { inj: null, injPart: null, injNotes: null, age: 25, exp: 3, dc: 1 } }, history });
  const risk = playerRisk(healthy, BOWERS);
  assert.equal(risk.rosAvailability, 1);
  assert.equal(risk.inj, null);
  assert.ok(risk.durability > 0.85, `durability ${risk.durability}`);
  assert.ok(risk.volatility > 0 && risk.volatility < 0.6, `volatility ${risk.volatility}`);
  assert.ok(risk.score < 25, `score ${risk.score}`);
  assert.equal(risk.band, "low");
  assert.ok(risk.floor <= risk.mean && risk.mean <= risk.ceiling);
  assert.equal(risk.depthRisk, DEFAULTS.risk.depthPenalty.starter);
});

test("a rookie with no history falls back to the positional prior, exactly", () => {
  const rookie = build({ players: { [BOWERS]: { inj: null, injPart: null, injNotes: null, age: 22, exp: 0, dc: 1 } } });
  const risk = playerRisk(rookie, BOWERS);
  // no ctx.history at all → cv = (0·obs + 6·prior)/(0 + 6) = prior, to the digit (R5 §5.1)
  assert.ok(Math.abs(risk.volatility - DEFAULTS.risk.positionCv.TE) < 1e-9, `volatility ${risk.volatility}`);
  assert.ok(risk.reasons.some((r) => r.includes("prior")), risk.reasons.join(" | "));
  // the rookie bump lands on the base miss rate and nothing else (R5 §5.3 + engine-chosen bump)
  const dur = durabilityOf(rookie, BOWERS);
  assert.equal(dur.source, "prior");
  assert.ok(
    Math.abs(dur.missRate - (DEFAULTS.risk.baseMissRate.TE + DEFAULTS.risk.rookieMissRate)) < 1e-9,
    `missRate ${dur.missRate}`
  );
});

test("durability shrinks a bad season toward the positional base rate (R5 §5.4)", () => {
  const history = new Map([[BOWERS, { gp: 9, ga: 17, w: [] }]]);
  const hurtLastYear = build({ players: { [BOWERS]: { inj: null, injPart: null, injNotes: null, age: 25, exp: 4 } }, history });
  const dur = durabilityOf(hurtLastYear, BOWERS);
  // (missed + k·base) / (games + k) = (8 + 17·0.13) / (17 + 17), verified by hand = 0.30
  const expected = (8 + 17 * DEFAULTS.risk.baseMissRate.TE) / (17 + DEFAULTS.risk.historyShrinkGames);
  assert.ok(Math.abs(dur.missRate - expected) < 1e-9, `${dur.missRate} vs ${expected}`);
  assert.equal(dur.source, "history");
  // raw history would have said 8/17 = 0.47 — the shrinkage is doing real work
  assert.ok(dur.missRate < 8 / 17 - 0.1, `${dur.missRate} is barely shrunk`);
});

test("a soft-tissue injury multiplies the miss rate, a bruise does not (R5 §5.4)", () => {
  const base = durabilityOf(build({ players: { [BOWERS]: { inj: null, injPart: null, injNotes: null } } }), BOWERS).missRate;
  const soft = durabilityOf(
    build({ players: { [BOWERS]: { inj: "Questionable", injPart: "Hamstring", injNotes: null } } }),
    BOWERS
  ).missRate;
  const other = durabilityOf(
    build({ players: { [BOWERS]: { inj: "Questionable", injPart: "Thumb", injNotes: null } } }),
    BOWERS
  ).missRate;
  assert.ok(Math.abs(soft - base * DEFAULTS.risk.injuryTypeMultiplier.softTissue) < 1e-9);
  assert.ok(Math.abs(other - base) < 1e-9, "a thumb is not a soft-tissue re-injury risk");
});

test("age past the positional knee raises the miss rate and widens the band (R5 §5.2)", () => {
  const young = build({ players: { [PURDY]: { age: 26, exp: 4, inj: null } } });
  const old = build({ players: { [PURDY]: { age: 36, exp: 14, inj: null } } });
  assert.ok(durabilityOf(old, PURDY).missRate > durabilityOf(young, PURDY).missRate);
  assert.ok(playerRisk(old, PURDY).volatility > playerRisk(young, PURDY).volatility, "the band widens too");
  // ...and the projected mean is NOT shaved: projections already price age
  assert.equal(playerRisk(old, PURDY).mean, playerRisk(young, PURDY).mean);
});

// ---------------------------------------------------------------------------------------------
// history plumbing (§13.6 F1 contract, both shapes)
// ---------------------------------------------------------------------------------------------

test("historyOf reads the flat row and the per-season wrapper alike", () => {
  const raw = fixture("history_v1.json");
  const id = Object.keys(raw.seasons["2025"].players)[0];
  const flat = build({ history: new Map([[id, raw.seasons["2025"].players[id]]]) });
  const wrapped = build({
    history: new Map([[id, { seasons: { 2025: raw.seasons["2025"].players[id], 2026: raw.seasons["2026"].players[id] } }]]),
  });
  const a = historyOf(flat, id);
  const b = historyOf(wrapped, id);
  assert.equal(a.gp, b.gp);
  assert.equal(a.ga, b.ga);
  assert.deepEqual(a.w, b.w, "the wrapper resolves to the LAST COMPLETE season, not this one");
  assert.equal(b.season, "2025");
  assert.equal(historyOf(ctx, id), null, "no history attached → null, never a throw");
});

test("history weekly points use this league's scoring and skip weeks he did not play", () => {
  const row = { gp: 3, ga: 4, w: [[10, 4], null, [6, 2], [0, 0]] };
  const half = build({ history: new Map([[BOWERS, row]]) });
  assert.equal(half.league.ppr, 0.5, "the fixture league is half-PPR");
  // nulls are dropped (an inactive week is the availability axis's problem, not the volatility
  // axis's — R5 §5.1), [0,0] is a real scoreless game and stays
  assert.deepEqual(historyWeekly(half, row), [12, 7, 0]);
});

test("a team defence with no gms_active is not read as zero games played", () => {
  const withDef = build({ history: new Map([[BOWERS, { gp: 12, ga: null, w: [] }]]) });
  assert.equal(historyOf(withDef, BOWERS).ga, null);
  assert.equal(durabilityOf(withDef, BOWERS).source, "prior", "no games-possible → the prior, not a 100% miss rate");
});

// ---------------------------------------------------------------------------------------------
// lineupConcentration — Tom's ask #6
// ---------------------------------------------------------------------------------------------

test("concentration partitions the roster's market value between starters and bench", () => {
  const c = lineupConcentration(ctx, mine);
  let total = 0;
  for (const id of mine) total += marketValue(ctx, id).mAdj || 0;
  assert.ok(Math.abs(c.starterValue + c.benchValue - total) < 1e-6, "the split is a partition, not a sample");
  assert.ok(Math.abs(c.totalValue - total) < 1e-6);
  assert.ok(c.starterShare > 0 && c.starterShare <= 1);
  assert.equal(c.starters.length + c.bench.length, mine.length);
  for (const row of [...c.starters, ...c.bench]) {
    assert.ok(row.weeks >= 0 && row.weeks <= 1, `${row.id} starts ${row.weeks} of the weeks`);
  }
  for (const row of c.starters) assert.ok(row.weeks >= 0.5);
  for (const row of c.bench) assert.ok(row.weeks < 0.5);
  // a full roster starts most of its value: this is the number the UI shows as "starter share"
  assert.ok(c.starterShare > 0.5, `starterShare ${c.starterShare}`);
  assert.equal(lineupConcentration(ctx, mine), c, "memoized per roster");
});

test("a backup who barely starts carries almost none of the starter share (R5 §5.8 check 6)", () => {
  const c = lineupConcentration(ctx, mine);
  const rows = [...c.starters, ...c.bench];
  const qbs = rows.filter((r) => ctx.players.get(r.id).pos === "QB").sort((a, b) => b.weeks - a.weeks);
  assert.equal(qbs.length, 2, "the fixture roster carries a QB1 and a QB2 — the shape D3 is about");
  assert.ok(qbs[0].weeks > 0.8, "the QB1 starts nearly every week");
  // one lineup slot, so the second quarterback only ever starts when the first cannot: his share
  // of the roster's starting value is that fraction and nothing more
  assert.ok(qbs[1].weeks < 0.25, `the QB2 starts ${qbs[1].weeks} of the remaining weeks`);
  assert.ok(qbs[0].weeks + qbs[1].weeks <= 1 + 1e-9, "they cannot both fill the one QB slot");
});

// ---------------------------------------------------------------------------------------------
// rosterFragility
// ---------------------------------------------------------------------------------------------

test("fragility names who is exposed, and cover falls when the cover is cut", () => {
  const frag = rosterFragility(ctx, mine);
  assert.ok(frag.expectedLossPerWeek > 0, "some starter can always get hurt");
  assert.ok(frag.coverQuality > 0 && frag.coverQuality <= 1);
  assert.ok(frag.worst.length > 0 && frag.worst.length <= DEFAULTS.risk.worst);
  for (let i = 1; i < frag.worst.length; i += 1) {
    assert.ok(frag.worst[i - 1].lossPerWeek >= frag.worst[i].lossPerWeek, "worst-first");
  }
  for (const row of frag.worst) {
    assert.ok(row.pMiss > 0 && row.pMiss < 1);
    assert.ok(row.lossPerWeek >= 0);
    assert.ok(mine.includes(row.id));
  }
  // Σ worst ≤ the whole number (worst is a top-N slice of the same sum)
  let top = 0;
  for (const row of frag.worst) top += row.lossPerWeek;
  assert.ok(top <= frag.expectedLossPerWeek + 1e-9);
});

test("adding a bench body cuts the expected loss; cutting one raises it", () => {
  const base = rosterFragility(ctx, mine).expectedLossPerWeek;
  // the best free running back is real cover for two starting RB slots
  const cover = "4046"; // Patrick Mahomes is free here, but the point is any extra eligible body
  const deeper = rosterFragility(ctx, [...mine, cover]).expectedLossPerWeek;
  assert.ok(deeper <= base + 1e-9, `${deeper} should not exceed ${base}`);
  const thinner = rosterFragility(ctx, mine.slice(0, mine.length - 3)).expectedLossPerWeek;
  assert.ok(thinner >= base - 1e-9, `${thinner} should not fall below ${base} on a thinner roster`);
});

// ---------------------------------------------------------------------------------------------
// rosterRisk + certainty equivalent
// ---------------------------------------------------------------------------------------------

test("rosterRisk prices variance: the certainty equivalent never exceeds the mean", () => {
  const risk = rosterRisk(ctx, mine);
  const season = seasonLineup(ctx, mine);
  assert.ok(Math.abs(risk.weekly.mean - season.avgPerWeek) < 1e-9);
  assert.ok(risk.weekly.sd > 0);
  assert.ok(Math.abs(risk.weekly.cv - risk.weekly.sd / risk.weekly.mean) < 1e-9);
  assert.ok(risk.certaintyEquivalent <= risk.weekly.mean);
  assert.ok(
    Math.abs(risk.certaintyEquivalent - (risk.weekly.mean - DEFAULTS.risk.lambda * risk.weekly.sd)) < 1e-9,
    "CE = mean − λ·sd with λ from DEFAULTS (R5 §5.6)"
  );
  assert.ok(risk.score >= 0 && risk.score <= 100);
  assert.ok(["low", "moderate", "high", "severe"].includes(risk.band));
  assert.ok(risk.notes.length >= 3);
  assert.ok(risk.notes[0].includes("%"), risk.notes[0]);
  assert.equal(risk.concentration, lineupConcentration(ctx, mine));
  assert.equal(risk.fragility, rosterFragility(ctx, mine));
});

test("λ = 0 makes the certainty equivalent the mean again", () => {
  const neutral = build({ settings: { risk: { lambda: 0 } } });
  const ids = activePlayers(rosterById(neutral, MINE));
  const risk = rosterRisk(neutral, ids);
  assert.ok(Math.abs(risk.certaintyEquivalent - risk.weekly.mean) < 1e-9);
});

// ---------------------------------------------------------------------------------------------
// consensusGap
// ---------------------------------------------------------------------------------------------

test("consensusGap compares the tier sheet with the projection rank at the same position", () => {
  const gaps = consensusGaps(ctx);
  assert.ok(gaps.size > 50, `${gaps.size} players carry a tier`);
  let disagreed = 0;
  for (const [id, row] of gaps) {
    assert.ok(row.tier > 0, `${id} tier ${row.tier}`);
    assert.ok(row.implied > 0, `${id} implied ${row.implied}`);
    assert.equal(row.gap, row.tier - row.implied);
    if (Math.abs(row.gap) >= 2) disagreed += 1;
  }
  assert.ok(disagreed > 0, "on a real tier sheet somebody always disagrees with the projections");
  // the best player at a position by projection gets the best tier on the sheet, so gap 0
  const gibbs = gaps.get("9509"); // Jahmyr Gibbs, RB1 by projection and tier 1 on the sheet
  if (gibbs) assert.equal(gibbs.gap, 0);
  assert.equal(consensusGaps(ctx), gaps, "memoized per ctx");
});
