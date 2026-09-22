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
  streamBudget,
  weekPoints,
} from "../src/engine/lineup.js";
import { absenceOf, withAbsence } from "../src/engine/injuries.js";
import { DEFAULTS } from "../src/config.js";

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

test("OUT-class statuses zero the current week and DISCOUNT the ones after it", () => {
  const out = [...ctx.players.keys()].find((id) => {
    const p = ctx.players.get(id);
    return p.inj === "Out" && ctx.proj.has(id) && (ctx.proj.get(id)[0] || 0) > 0;
  });
  if (out) {
    assert.equal(weekPoints(ctx, out, 1), 0, "week 1 is zeroed for an Out player");
    const laterWeek = ctx.proj.get(out).findIndex((v, i) => i > 0 && v > 0) + 1;
    if (laterWeek > 1) {
      // §13.5 D1: Sleeper still projects him in full, the duration table does not. The Out row
      // is [{1,.5},{2,.3},{3,.1},{4,.1}], so week 2 is P(misses fewer than 2 games) = 0.5.
      const raw = ctx.proj.get(out)[laterWeek - 1];
      assert.ok(weekPoints(ctx, out, laterWeek) > 0, "he is not written off either");
      assert.ok(weekPoints(ctx, out, laterWeek) < raw, "but he is no longer worth Sleeper's number");
    }
  }
  // Questionable plays 70% of the time (STATUS_BRANCHES.Questionable), so his current week is
  // worth 70% of the projection — not zero, and not the full number either.
  const rawNow = ctx.proj.get(HIGGINS)[ctx.week - 1];
  assert.ok(Math.abs(weekPoints(ctx, HIGGINS, ctx.week) - rawNow * 0.7) < 1e-9, "Questionable = 0.7 × proj");
  assert.ok(weekPoints(ctx, HIGGINS, ctx.week + 1) > weekPoints(ctx, HIGGINS, ctx.week));
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

// ---------------------------------------------------------------------------------------------
// §13.5 D1 — availability-scaled week vectors
// ---------------------------------------------------------------------------------------------

test("D1: the live status discounts future weeks exactly as withAbsence would", () => {
  const players = { ...INPUT.players, players: { ...INPUT.players.players } };
  players.players[BOWERS] = {
    ...players.players[BOWERS],
    inj: "Out",
    injPart: "Knee - Meniscus",
    injNotes: "Surgery",
  };
  const hurt = buildContext({ ...INPUT, players }, {});
  const absence = absenceOf(hurt, hurt.players.get(BOWERS));
  const scen = withAbsence(hurt, BOWERS, absence);

  // the scenario ctx carries the stamp that stops the discount being applied twice
  assert.ok(scen.absenceApplied.has(BOWERS));
  assert.ok(scen.memo.absenceApplied.has(BOWERS));
  for (const w of hurt.weeksLeft) {
    assert.ok(
      Math.abs(weekPoints(hurt, BOWERS, w) - weekPoints(scen, BOWERS, w)) < 1e-9,
      `week ${w}: ${weekPoints(hurt, BOWERS, w)} vs ${weekPoints(scen, BOWERS, w)} — discounted twice`
    );
  }
  // ...and it is a real discount, not a no-op
  const raw = hurt.proj.get(BOWERS);
  assert.equal(weekPoints(hurt, BOWERS, hurt.week), 0, "Out zeroes the current week outright");
  assert.ok(weekPoints(hurt, BOWERS, hurt.week + 1) < raw[hurt.week] * 0.8, "and discounts the next one");
  assert.ok(
    weekPoints(hurt, BOWERS, hurt.week + 3) > weekPoints(hurt, BOWERS, hurt.week + 1),
    "the discount unwinds as he gets closer"
  );
});

test("D1: scaleFutureWeeks false restores the current-week-only rule", () => {
  const players = { ...INPUT.players, players: { ...INPUT.players.players } };
  players.players[BOWERS] = { ...players.players[BOWERS], inj: "Out", injPart: "Knee", injNotes: "Meniscus" };
  const off = buildContext({ ...INPUT, players }, { availability: { scaleFutureWeeks: false } });
  const raw = off.proj.get(BOWERS);
  assert.equal(weekPoints(off, BOWERS, off.week), 0);
  for (const w of off.weeksLeft.slice(1)) {
    if (isBye(off, BOWERS, w)) continue;
    assert.ok(Math.abs(weekPoints(off, BOWERS, w) - raw[w - 1]) < 1e-9, `week ${w} should be untouched`);
  }
});

// ---------------------------------------------------------------------------------------------
// §13.5 D2 — streaming credit for empty slots (R5 §5.5)
// ---------------------------------------------------------------------------------------------

/** The best free agent at `pos` in `week`, straight from the pool — the streamer's raw value. */
function bestFreeAt(context, pos, week) {
  let best = 0;
  for (const id of freeAgentPoolByPos(context)[pos] || []) {
    const pts = weekPoints(context, id, week);
    if (pts > best) best = pts;
  }
  return best;
}

test("D2: an empty slot is credited with the wire, a filled one never is", () => {
  const noKicker = MINE.filter((id) => ctx.players.get(id).pos !== "K");
  const lu = bestLineup(ctx, noKicker, 1);
  const kSlot = lu.slots.find((s) => s.slot === "K");
  assert.equal(kSlot.id, null, "the roster still has nobody there");
  assert.deepEqual(lu.short, ["K"], "and the slot is still reported short");
  assert.equal(lu.streamed.length, 1);
  assert.equal(lu.streamed[0].slot, "K");

  const wire = bestFreeAt(ctx, "K", 1);
  const friction = DEFAULTS.streaming.frictionByPos.K;
  assert.ok(Math.abs(kSlot.pts - wire * friction) < 1e-9, `${kSlot.pts} vs ${wire} x ${friction}`);
  assert.ok(kSlot.pts < wire, "friction is a discount, never a bonus");
  assert.equal(kSlot.streamed, lu.streamed[0].id, "the slot names the free agent it borrowed");

  // every slot the roster CAN fill is untouched
  for (const s of lu.slots) {
    if (s.slot === "K") continue;
    assert.equal(s.streamed, undefined, `${s.slot} was topped up although it has a body`);
    assert.ok(Math.abs(s.pts - weekPoints(ctx, s.id, 1)) < 1e-9);
  }
  assert.ok(Math.abs(lu.total - lu.slots.reduce((a, s) => a + s.pts, 0)) < 1e-9, "total still sums the slots");
});

test("D2: the credit is per position — a QB hole is worth more of the wire than a WR hole", () => {
  const f = DEFAULTS.streaming.frictionByPos;
  assert.ok(f.QB > f.TE && f.TE > f.DEF && f.DEF > f.K && f.K > f.WR, "R5 section 5.5 ordering");
  const noQb = MINE.filter((id) => ctx.players.get(id).pos !== "QB");
  const qbSlot = bestLineup(ctx, noQb, 1).slots.find((s) => s.slot === "QB");
  assert.ok(Math.abs(qbSlot.pts - bestFreeAt(ctx, "QB", 1) * f.QB) < 1e-9);
});

test("D2: a bye-heavy week is streamed at most twice, and never by the same body twice", () => {
  // strip the K, the DEF and every quarterback: three holes, one waiver run (R5 section 5.5 rule 2)
  const gutted = MINE.filter((id) => !["K", "DEF", "QB"].includes(ctx.players.get(id).pos));
  const lu = bestLineup(ctx, gutted, 1);
  assert.deepEqual([...lu.short].sort(), ["DEF", "K", "QB"], "three slots have nobody in them");
  assert.equal(lu.streamed.length, DEFAULTS.streaming.maxSlotsPerWeek, "only two of them get covered");
  assert.equal(new Set(lu.streamed.map((s) => s.id)).size, lu.streamed.length, "two different players");
  // the best hole is the one that gets covered first
  assert.ok(new Set(lu.streamed.map((s) => s.slot)).has("QB"), "a QB hole outscores a K hole");
});

test("D2: the k-th streamed slot takes the k-th-best free agent (R5 section 5.5 rule 1)", () => {
  // two FLEX-eligible holes at once: without rule 1 both would book the same best body
  const two = MINE.filter((id) => !["WR", "RB", "TE"].includes(ctx.players.get(id).pos));
  const lu = bestLineup(ctx, two, 1);
  assert.equal(lu.streamed.length, DEFAULTS.streaming.maxSlotsPerWeek);
  const [first, second] = lu.streamed;
  assert.notEqual(first.id, second.id);
  assert.ok(first.pts >= second.pts, "best body first");
});

test("D2: the roster's own players are never its streamers", () => {
  const noKicker = MINE.filter((id) => ctx.players.get(id).pos !== "K");
  for (const s of bestLineup(ctx, noKicker, 1).streamed) {
    assert.ok(!noKicker.includes(s.id), `${s.id} is on the roster and cannot also be on the wire`);
    assert.ok(!ctx.rosterOf.has(s.id), `${s.id} is rostered somewhere in the league`);
  }
});

test("D2: seasonLineup reports every streamed week, and streaming can be switched off", () => {
  const noKicker = MINE.filter((id) => ctx.players.get(id).pos !== "K");
  const s = seasonLineup(ctx, noKicker);
  const kicked = s.streamed.filter((row) => row.slot === "K");
  assert.equal(kicked.length, s.perWeek.length, "the K slot is empty in every remaining week");
  for (const row of s.streamed) {
    assert.ok(row.week >= ctx.week && row.pts > 0);
    assert.ok(ctx.slots.includes(row.slot));
  }
  // a bye can open a second hole in a week; the per-week cap still holds everywhere
  const perWeek = new Map();
  for (const row of s.streamed) perWeek.set(row.week, (perWeek.get(row.week) || 0) + 1);
  for (const [, n] of perWeek) assert.ok(n <= DEFAULTS.streaming.maxSlotsPerWeek);
  assert.equal(s.shortWeeks.length, 17, "a streamed slot is still a slot the roster cannot fill");

  const off = buildContext(INPUT, { streaming: { enabled: false } });
  const plain = seasonLineup(off, noKicker);
  assert.deepEqual(plain.streamed, []);
  assert.ok(plain.avgPerWeek < s.avgPerWeek, "the credit is worth real points");
  const delta = s.avgPerWeek - plain.avgPerWeek;
  assert.ok(delta > 3 && delta < 9, `a streamed kicker is worth ${delta.toFixed(2)} pts/wk`);
});

test("D2: the streaming budget is what the roster could actually sign", () => {
  assert.equal(streamBudget(ctx, MINE), DEFAULTS.streaming.maxSlotsPerWeek, "a 17-man roster can cut two");
  const skeleton = MINE.slice(0, ctx.slots.length); // exactly 11 bodies, no bench
  assert.equal(streamBudget(ctx, skeleton), DEFAULTS.streaming.maxSlotsPerWeek, "and it has open spots");
  const off = buildContext(INPUT, { streaming: { enabled: false } });
  assert.equal(streamBudget(off, MINE), 0);
});

// ---------------------------------------------------------------------------------------------
// 004 §3.4 — the K/DEF streaming-model hook (src/engine/matchup.js), exercised through the full
// bestLineup pipeline, not just weekVector in isolation. A LOCAL ctx built with games.json input,
// never the shared module-level `ctx` above (which stays games-less so every number above holds).
// ---------------------------------------------------------------------------------------------

test("004 §3.4: bestLineup's DEF slot value moves with the streaming model once ctx.games carries odds", () => {
  const gamesInput = JSON.parse(readFileSync(new URL("./fixtures/games_sample.json", import.meta.url), "utf8"));
  const withGames = buildContext({ ...INPUT, games: gamesInput }, {});
  const plain = buildContext(INPUT, {});

  assert.equal(weekPoints(plain, "HOU", 1), weekPoints(ctx, "HOU", 1), "sanity: plain matches the shared ctx");
  assert.notEqual(weekPoints(withGames, "HOU", 1), weekPoints(plain, "HOU", 1), "the odds actually move the number");

  const rosterWithHou = MINE; // roster 3 already carries HOU at DEF
  const defSlotPts = (context) => bestLineup(context, rosterWithHou, 1).slots.find((s) => s.slot === "DEF").pts;
  assert.equal(defSlotPts(withGames), weekPoints(withGames, "HOU", 1), "the lineup reads the adjusted value");
  assert.notEqual(defSlotPts(withGames), defSlotPts(plain), "the whole pipeline carries the adjustment through");

  // skill positions in the same lineup are untouched end-to-end
  const qbSlotPts = (context) => bestLineup(context, rosterWithHou, 1).slots.find((s) => s.slot === "QB").pts;
  assert.equal(qbSlotPts(withGames), qbSlotPts(plain), "R8 §5.4: no skill-position adjustment, ever");
});
