import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { activePlayers, buildContext, rosterById, rosPoints, slotEligibility } from "../src/engine/context.js";
import {
  backfill,
  backfillPositions,
  bestLineup,
  freeAgentPoolByPos,
  isBye,
  seasonLineup,
  slotDemand,
  weekPoints,
} from "../src/engine/lineup.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
// Fixtures load lazily inside a before() hook, never at import time: the pipeline regenerates
// projections.json and values_full.json while these tests run.
let INPUT;
let ctx;
let MINE;
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
  MINE = activePlayers(rosterById(ctx, 3));
});

const HIGGINS = "6801"; // WR CIN, bye week 6, Questionable
const BOWERS = "11604"; // TE LV, bye week 13

test("bestLineup fills all 11 slots with eligible, non-repeated players", () => {
  for (const week of [1, 6, 15]) {
    const lu = bestLineup(ctx, MINE, week);
    assert.equal(lu.slots.length, 11);
    assert.deepEqual(lu.short, [], `week ${week} should be fillable from a 17-man roster`);

    const seen = new Set();
    for (const s of lu.slots) {
      assert.ok(s.id, `${s.slot} must be filled in week ${week}`);
      assert.ok(!seen.has(s.id), `${s.id} is used twice in week ${week}`);
      seen.add(s.id);
      const pos = ctx.players.get(s.id).pos;
      assert.ok(slotEligibility(s.slot).includes(pos), `${pos} is not eligible for ${s.slot}`);
      assert.ok(Math.abs(s.pts - weekPoints(ctx, s.id, week)) < 1e-9);
    }
    assert.ok(Math.abs(lu.total - lu.slots.reduce((a, s) => a + s.pts, 0)) < 1e-9);
    assert.equal(lu.bench.length, MINE.length - 11);
    for (const id of lu.bench) assert.ok(!seen.has(id));
  }
});

test("bestLineup beats every single-swap alternative (greedy is optimal here)", () => {
  const lu = bestLineup(ctx, MINE, 1);
  const starters = new Set(lu.slots.map((s) => s.id));
  for (const s of lu.slots) {
    for (const benched of lu.bench) {
      if (!slotEligibility(s.slot).includes(ctx.players.get(benched).pos)) continue;
      assert.ok(
        weekPoints(ctx, benched, 1) <= s.pts + 1e-9,
        `${benched} on the bench out-scores the ${s.slot} starter`
      );
    }
  }
  assert.equal(starters.size, 11);
});

test("a bye week excludes the player from that week only", () => {
  assert.equal(ctx.players.get(HIGGINS).bye, 6);
  assert.ok(isBye(ctx, HIGGINS, 6));
  assert.ok(!isBye(ctx, HIGGINS, 5));
  assert.equal(weekPoints(ctx, HIGGINS, 6), 0);
  assert.ok(weekPoints(ctx, HIGGINS, 5) > 0);

  const week5 = bestLineup(ctx, MINE, 5).slots.map((s) => s.id);
  const week6 = bestLineup(ctx, MINE, 6).slots.map((s) => s.id);
  assert.ok(week5.includes(HIGGINS), "he starts the week before his bye");
  assert.ok(!week6.includes(HIGGINS), "and is benched on it");

  assert.equal(weekPoints(ctx, BOWERS, 13), 0, "byes are read from the projection vector too");
  assert.ok(!bestLineup(ctx, MINE, 13).slots.map((s) => s.id).includes(BOWERS));
});

test("OUT-class statuses zero the current week but not future weeks", () => {
  const out = [...ctx.players.keys()].find((id) => {
    const p = ctx.players.get(id);
    return p.inj === "Out" && ctx.proj.has(id) && (ctx.proj.get(id)[0] || 0) > 0;
  });
  if (out) {
    assert.equal(weekPoints(ctx, out, 1), 0, "week 1 is zeroed for an Out player");
    const laterWeek = ctx.proj.get(out).findIndex((v, i) => i > 0 && v > 0) + 1;
    if (laterWeek > 1) assert.ok(weekPoints(ctx, out, laterWeek) > 0, "later weeks keep Sleeper's projection");
  }
  // Questionable is a market-axis discount, never a lineup zero
  assert.ok(weekPoints(ctx, HIGGINS, 1) > 0);
});

test("seasonLineup weights the playoff weeks and reports shortfalls", () => {
  const s = seasonLineup(ctx, MINE);
  assert.equal(s.perWeek.length, 17);
  assert.deepEqual(s.shortWeeks, []);
  assert.ok(Math.abs(s.total - s.perWeek.reduce((a, w) => a + w.total, 0)) < 1e-9);

  const omega = ctx.settings.playoffWeight;
  const weightSum = 14 + 3 * omega;
  const expectedWeighted = s.perWeek.reduce((a, w) => a + (w.week >= 15 ? omega : 1) * w.total, 0);
  assert.ok(Math.abs(s.weighted - expectedWeighted) < 1e-9);
  assert.ok(Math.abs(s.avgPerWeek - s.weighted / weightSum) < 1e-9);

  const playoffs = s.perWeek.filter((w) => w.week >= 15);
  assert.ok(Math.abs(s.playoffAvg - playoffs.reduce((a, w) => a + w.total, 0) / 3) < 1e-9);
  assert.ok(s.avgPerWeek > 100 && s.avgPerWeek < 220, `${s.avgPerWeek} pts/week is out of plausible range`);
});

test("seasonLineup reports a short slot when the roster cannot cover one", () => {
  const noKicker = MINE.filter((id) => ctx.players.get(id).pos !== "K");
  const s = seasonLineup(ctx, noKicker);
  assert.equal(s.shortWeeks.length, 17);
  assert.deepEqual(s.shortWeeks[0].short, ["K"]);
});

test("free agents are ranked by remaining points and are genuinely unrostered", () => {
  const pool = freeAgentPoolByPos(ctx);
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    assert.ok(pool[pos] && pool[pos].length, `${pos} needs free agents`);
    for (const id of pool[pos]) assert.ok(!ctx.rosterOf.has(id));
    for (let i = 1; i < pool[pos].length; i += 1) {
      assert.ok(rosPoints(ctx, pool[pos][i - 1]) >= rosPoints(ctx, pool[pos][i]));
    }
  }
});

test("backfill restores the roster count from the wire", () => {
  const short = MINE.slice(0, MINE.length - 2);
  const filled = backfill(ctx, short, MINE.length);
  assert.equal(filled.ids.length, MINE.length);
  assert.equal(filled.added.length, 2);
  for (const add of filled.added) {
    assert.ok(!ctx.rosterOf.has(add.id), "signed a rostered player");
    assert.ok(!short.includes(add.id));
    assert.equal(ctx.players.get(add.id).pos, add.pos);
  }
  assert.notEqual(filled.added[0].id, filled.added[1].id);

  const excluded = backfill(ctx, short, MINE.length, [filled.added[0].id]);
  assert.ok(!excluded.added.some((a) => a.id === filled.added[0].id), "exclude list is honoured");
});

test("backfill never exceeds the roster cap and is a no-op when full", () => {
  const full = backfill(ctx, MINE, 25);
  assert.equal(full.ids.length, ctx.league.maxRoster);
  assert.equal(backfill(ctx, MINE, MINE.length).added.length, 0);
});

test("backfill never signs a spare K or DEF for a freed spot", () => {
  // K and DEF out-score every flex body in raw points, so an unguarded fallback signs a kicker.
  // Free two WR spots on a roster that still has its K and DEF, so no position is truly short.
  const spare = MINE.filter((id) => ctx.players.get(id).pos === "WR").slice(-2);
  const short = MINE.filter((id) => !spare.includes(id));
  assert.equal(short.length, MINE.length - 2);
  assert.ok(short.some((id) => ctx.players.get(id).pos === "K"));
  assert.ok(short.some((id) => ctx.players.get(id).pos === "DEF"));
  const filled = backfill(ctx, short, MINE.length);
  assert.equal(filled.added.length, 2);
  for (const add of filled.added) {
    assert.ok(!["K", "DEF"].includes(add.pos), `signed a spare ${add.pos}`);
    assert.ok(["QB", "RB", "WR", "TE"].includes(add.pos));
  }
  // ...unless the roster genuinely has none
  const noKicker = MINE.filter((id) => ctx.players.get(id).pos !== "K");
  const repaired = backfill(ctx, noKicker, noKicker.length + 1);
  assert.equal(repaired.added[0].pos, "K", "an empty K slot is a real shortfall");
});

test("backfill prefers a position the roster is actually short at", () => {
  const noQb = MINE.filter((id) => ctx.players.get(id).pos !== "QB");
  const filled = backfill(ctx, noQb, noQb.length + 1);
  assert.equal(filled.added.length, 1);
  assert.equal(filled.added[0].pos, "QB", "one QB slot with zero QBs is the biggest shortfall");
});

test("backfillPositions covers a named hole", () => {
  const noKicker = MINE.filter((id) => ctx.players.get(id).pos !== "K");
  const repaired = backfillPositions(ctx, noKicker, ["K"]);
  assert.equal(repaired.added.length, 1);
  assert.equal(repaired.added[0].pos, "K");
  assert.deepEqual(seasonLineup(ctx, repaired.ids).shortWeeks, []);
});

test("slot demand spreads the FLEX slots over the flex-eligible positions", () => {
  const demand = slotDemand(ctx);
  assert.equal(demand.QB, 1);
  assert.equal(demand.K, 1);
  assert.equal(demand.DEF, 1);
  assert.ok(demand.RB > 2 && demand.WR > 3 && demand.TE > 1, "each picks up a share of the two FLEX slots");
  const flexTotal = demand.RB + demand.WR + demand.TE;
  assert.ok(Math.abs(flexTotal - 8) < 1e-9, "2 RB + 3 WR + 1 TE + 2 FLEX = 8");
});
