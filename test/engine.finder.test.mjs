import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import { marketValue, surplus, waiverReplacement } from "../src/engine/values.js";
import { acceptanceTier, evaluateTrade } from "../src/engine/trade.js";
import { DEFAULT_SHAPES, findTrades, positionalSurplus, tradePool } from "../src/engine/finder.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
// Fixtures load lazily inside a before() hook, never at import time: the pipeline regenerates
// projections.json and values_full.json while these tests run.
let INPUT;
const make = (settings) => buildContext(INPUT, settings);
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
});

/** The finder must stay inside a phone's patience budget: design target 1.5 s, CI slack 3 s. */
// Functional guard, not a benchmark (browser measures ~0.5 s); shared CI runners are slow.
const PERF_BUDGET_MS = Number(process.env.TW_PERF_BUDGET_MS) || 10000;

test("stage 0 prunes waiver-grade players and every K/DEF", () => {
  const ctx = make({});
  const pool = tradePool(ctx, 3);
  const roster = activePlayers(rosterById(ctx, 3));
  assert.ok(pool.length > 0 && pool.length < roster.length, "some players must be pruned");
  for (const id of pool) {
    const pos = ctx.players.get(id).pos;
    assert.ok(!["K", "DEF"].includes(pos));
    assert.ok(surplus(ctx, id) > 0, `${id} is waiver-grade and should have been pruned`);
  }
  const w = waiverReplacement(ctx);
  for (const id of roster) {
    if (pool.includes(id)) continue;
    const mv = marketValue(ctx, id);
    assert.ok(mv.m == null || mv.mAdj <= w[mv.pos] * ctx.settings.rho + 1e-9);
  }
  // sorted best-first
  for (let i = 1; i < pool.length; i += 1) {
    assert.ok((marketValue(ctx, pool[i - 1]).mAdj || 0) >= (marketValue(ctx, pool[i]).mAdj || 0));
  }
});

test("positional surplus counts startable bodies against slots", () => {
  const ctx = make({});
  const ps = positionalSurplus(ctx, 3);
  assert.deepEqual(Object.keys(ps).sort(), ["QB", "RB", "TE", "WR"]);
  for (const v of Object.values(ps)) assert.equal(typeof v, "number");
  assert.ok(Object.values(ps).some((v) => v > 0) || Object.values(ps).some((v) => v < 0));
});

test("findTrades returns a ranked, deduped, diversified shortlist inside budget", () => {
  const ctx = make({});
  const started = process.hrtime.bigint();
  const deals = findTrades(ctx, { myRosterId: 3, maxResults: 10, perRival: 2 });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < PERF_BUDGET_MS, `findTrades took ${elapsed.toFixed(0)} ms (budget ${PERF_BUDGET_MS} ms)`);

  assert.ok(deals.length > 0, "the fixture league must yield at least one proposal");
  assert.ok(deals.length <= 10);

  const perRival = new Map();
  const givers = new Set();
  const keys = new Set();
  for (let i = 0; i < deals.length; i += 1) {
    const d = deals[i];
    if (i > 0) assert.ok(deals[i - 1].score >= d.score, "results must be sorted by score, descending");

    // shape
    for (const k of ["theirRosterId", "give", "get", "shape", "score", "myEdgePct", "myDeltaPerWeek", "theirEdgePct", "theirDeltaPerWeek", "acceptance", "why", "result"]) {
      assert.ok(k in d, `result is missing ${k}`);
    }
    assert.ok(DEFAULT_SHAPES.includes(d.shape));
    const [nGive, nGet] = d.shape.split("-").map(Number);
    assert.equal(d.give.length, nGive);
    assert.equal(d.get.length, nGet);
    assert.notEqual(d.theirRosterId, 3);
    assert.ok(Array.isArray(d.why) && d.why.length > 0);
    for (const line of d.why) assert.equal(typeof line, "string");

    // the give side is mine, the get side is theirs, and nobody is a K/DEF
    const mine = new Set(activePlayers(rosterById(ctx, 3)));
    const theirs = new Set(activePlayers(rosterById(ctx, d.theirRosterId)));
    for (const id of d.give) {
      assert.ok(mine.has(id));
      assert.ok(marketValue(ctx, id).m != null);
    }
    for (const id of d.get) {
      assert.ok(theirs.has(id));
      assert.ok(marketValue(ctx, id).m != null);
    }

    // diversification: <= perRival per rival, <= 1 proposal per player I give
    perRival.set(d.theirRosterId, (perRival.get(d.theirRosterId) || 0) + 1);
    assert.ok(perRival.get(d.theirRosterId) <= 2, "no more than perRival proposals per rival");
    for (const id of d.give) {
      assert.ok(!givers.has(id), `${id} appears in two proposals`);
      givers.add(id);
    }

    // dedup
    const key = `${d.theirRosterId}|${[...d.give].sort()}|${[...d.get].sort()}`;
    assert.ok(!keys.has(key));
    keys.add(key);
  }
});

test("the finder never proposes something the rival would refuse", () => {
  const ctx = make({});
  const deals = findTrades(ctx, { myRosterId: 3 });
  const cfg = ctx.settings.finder;
  const tiers = new Set();
  for (const d of deals) {
    assert.notEqual(d.result.verdict.code, "invalid");
    assert.notEqual(d.acceptance, "unlikely", "stage 5 drops the unlikely tier outright");
    assert.equal(d.acceptance, d.result.verdict.acceptance);
    assert.equal(d.acceptance, acceptanceTier(ctx, d.theirEdgePct, d.theirDeltaPerWeek));
    assert.ok(d.result.verdict.acceptLikely);
    // no survivor may both lose the rival value and gut their lineup
    assert.ok(
      d.theirDeltaPerWeek >= -cfg.acceptPossibleMaxLineupLoss - 1e-9,
      `rival would lose ${d.theirDeltaPerWeek} pts/week`
    );
    assert.ok(d.theirEdgePct >= cfg.acceptPossibleMinEdge - 1e-9);
    assert.ok(d.myEdgePct >= cfg.minMyEdgePct - 1e-9, "stage 2 floors my own Edge%");
    tiers.add(d.acceptance);
  }
  assert.ok(tiers.size >= 1);
});

test("the score rewards a rival who actively wants the deal", () => {
  const ctx = make({});
  const deals = findTrades(ctx, { myRosterId: 3 });
  const cfg = ctx.settings.finder;
  for (const d of deals) {
    const bonus = d.acceptance === "likely" ? cfg.likelyBonus : 0;
    assert.ok(Math.abs(d.score - (d.myDeltaPerWeek + cfg.valueWeight * d.myEdgePct + bonus)) < 1e-9);
  }
  const noBonus = findTrades(make({ finder: { likelyBonus: 0 } }), { myRosterId: 3 });
  for (const d of noBonus) {
    assert.ok(Math.abs(d.score - (d.myDeltaPerWeek + cfg.valueWeight * d.myEdgePct)) < 1e-9);
  }
});

test("every shortlisted trade re-evaluates identically from scratch", () => {
  const ctx = make({});
  const deals = findTrades(ctx, { myRosterId: 3 });
  for (const d of deals) {
    const fresh = evaluateTrade(make({}), {
      myRosterId: 3,
      theirRosterId: d.theirRosterId,
      give: d.give,
      get: d.get,
    });
    assert.equal(fresh.verdict.code, d.result.verdict.code);
    assert.equal(fresh.verdict.acceptance, d.acceptance);
    assert.ok(Math.abs(fresh.verdict.edgePct - d.myEdgePct) < 1e-9);
    assert.ok(Math.abs(fresh.verdict.deltaPerWeek - d.myDeltaPerWeek) < 1e-9);
  }
});

test("maxResults and perRival are honoured", () => {
  const ctx = make({});
  const three = findTrades(ctx, { myRosterId: 3, maxResults: 3 });
  assert.ok(three.length <= 3);

  const one = findTrades(make({}), { myRosterId: 3, perRival: 1, maxResults: 10 });
  const counts = new Map();
  for (const d of one) counts.set(d.theirRosterId, (counts.get(d.theirRosterId) || 0) + 1);
  for (const c of counts.values()) assert.equal(c, 1);
});

test("restricting the shapes restricts the output", () => {
  const ctx = make({});
  const oneForOne = findTrades(ctx, { myRosterId: 3, shapes: ["1-1"] });
  for (const d of oneForOne) {
    assert.equal(d.shape, "1-1");
    assert.equal(d.give.length, 1);
    assert.equal(d.get.length, 1);
  }
});

test("the candidate cap short-circuits the sweep", () => {
  const capped = make({ finder: { maxCandidates: 25 } });
  const deals = findTrades(capped, { myRosterId: 3 });
  assert.ok(Array.isArray(deals));
  assert.ok(deals.length <= 10);
});

test("findTrades is deterministic", () => {
  const a = findTrades(make({}), { myRosterId: 3 });
  const b = findTrades(make({}), { myRosterId: 3 });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    assert.deepEqual(a[i].give, b[i].give);
    assert.deepEqual(a[i].get, b[i].get);
    assert.equal(a[i].score, b[i].score);
    assert.deepEqual(a[i].why, b[i].why);
  }
});

test("the finder works for every roster in the league", () => {
  for (const roster of make({}).rosters) {
    const ctx = make({});
    const deals = findTrades(ctx, { myRosterId: roster.rosterId, maxResults: 5 });
    assert.ok(Array.isArray(deals), `roster ${roster.rosterId} threw`);
    for (const d of deals) assert.notEqual(d.theirRosterId, roster.rosterId);
  }
});
