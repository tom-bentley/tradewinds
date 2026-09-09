// Live-shape coverage: the committed pipeline output carries four sources, not two —
// dp_dynasty (with `ecr`), bc_tiers (kind "tiers", sparse `r`, no `v`), signed `sd`, and roster
// share already on a 0-100 scale. The engine must handle all of it, plus value ids that the
// player table does not know and players that no source prices.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import {
  curveFit,
  marketValue,
  rosterPctScale,
  scaleFactors,
  sideValue,
  surplus,
  waiverReplacement,
} from "../src/engine/values.js";
import { bestLineup, seasonLineup } from "../src/engine/lineup.js";
import { evaluateTrade } from "../src/engine/trade.js";
import { findTrades } from "../src/engine/finder.js";
import { MAX_MEANINGFUL_TIER } from "../src/engine/explain.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const FULL = fixture("values_full.json");
const INPUT = {
  league: fixture("league.json"),
  users: fixture("users.json"),
  rosters: fixture("rosters.json"),
  players: fixture("players.json"),
  projections: fixture("projections.json"),
  values: FULL,
  schedule: fixture("schedule.json"),
  state: fixture("state.json"),
};
const make = (settings) => buildContext(INPUT, settings || {});
const ctx = make();

test("the full source table carries the four live sources", () => {
  assert.deepEqual(Object.keys(ctx.values).sort(), ["bc_tiers", "dp_dynasty", "fc_dynasty", "fc_redraft"]);
  assert.equal(ctx.values.bc_tiers.kind, "tiers");
  assert.equal(ctx.values.dp_dynasty.kind, "dynasty");
  assert.ok(Object.values(ctx.values.dp_dynasty.values).some((r) => r.ecr != null));
  assert.ok(Object.values(ctx.values.bc_tiers.values).every((r) => r.v == null), "bc_tiers prices nothing");
  const bcRanks = Object.values(ctx.values.bc_tiers.values).filter((r) => r.r != null).length;
  assert.ok(bcRanks > 0 && bcRanks < Object.keys(ctx.values.bc_tiers.values).length, "bc_tiers `r` is sparse");
});

test("a tiers-only source is scale-matched into nothing and never priced into the blend", () => {
  const factors = scaleFactors(ctx);
  assert.equal(factors.fc_redraft, 1);
  assert.equal(factors.bc_tiers, undefined, "a source with no `v` gets no scale factor");
  assert.ok(factors.dp_dynasty > 0 && Number.isFinite(factors.dp_dynasty));
  assert.ok(factors.fc_dynasty > 0 && Number.isFinite(factors.fc_dynasty));

  // every priced player's blend draws only from sources that actually publish a value
  for (const id of Object.keys(FULL.sources.bc_tiers.values).slice(0, 40)) {
    const mv = marketValue(ctx, id);
    assert.equal(mv.sources.bc_tiers, undefined);
    assert.equal(mv.sourcesRaw.bc_tiers, undefined);
  }
});

test("dp_dynasty joins the dynasty blend and moves the keeper tilt", () => {
  const twoSource = buildContext(
    { ...INPUT, values: { sources: { fc_redraft: FULL.sources.fc_redraft, fc_dynasty: FULL.sources.fc_dynasty } } },
    {}
  );
  const shared = Object.keys(FULL.sources.dp_dynasty.values).filter(
    (id) => FULL.sources.fc_dynasty.values[id] && ctx.players.has(id) && marketValue(ctx, id).m != null
  );
  assert.ok(shared.length > 50, "the two dynasty tables overlap heavily");
  let moved = 0;
  for (const id of shared) {
    const withDp = marketValue(ctx, id);
    const withoutDp = marketValue(twoSource, id);
    assert.ok(withDp.sources.dp_dynasty > 0);
    if (Math.abs(withDp.dynasty - withoutDp.dynasty) > 1e-9) moved += 1;
  }
  assert.ok(moved > shared.length / 2, "the third source has to change the dynasty number");
});

test("roster share is read on the scale each source published", () => {
  assert.equal(rosterPctScale(ctx, "fc_redraft"), 1, "the live tables are already 0-100");
  const rps = [];
  for (const id of Object.keys(FULL.sources.fc_redraft.values)) {
    const mv = marketValue(ctx, id);
    if (mv.rosterPct != null) rps.push(mv.rosterPct);
  }
  assert.ok(rps.length > 100);
  assert.ok(Math.max(...rps) <= 100 && Math.min(...rps) >= 0);
  assert.ok(Math.max(...rps) > 50, "a widely rostered player must read as a big percentage");

  // Jack Strand is rostered in 0.59% of dynasty leagues: a per-player <=1 test would read that
  // as 59% and turn the deepest waiver flyer in the table into a widely held asset.
  assert.equal(FULL.sources.fc_dynasty.values["13602"].rp, 0.59);
  assert.equal(rosterPctScale(ctx, "fc_dynasty"), 1);
  assert.ok(Math.abs(marketValue(ctx, "13602").rosterPct - 0.59) < 1e-9);

  // the older 0-1 snapshot must still be read correctly
  const oldShape = buildContext({ ...INPUT, values: fixture("values.json") }, {});
  assert.equal(rosterPctScale(oldShape, "fc_redraft"), 100);
  const old = marketValue(oldShape, "4866");
  assert.ok(old.rosterPct > 1 && old.rosterPct <= 100);
});

test("value ids the player table does not know are simply ignored", () => {
  const unknown = Object.keys(FULL.sources.dp_dynasty.values).filter((id) => !ctx.players.has(id));
  assert.ok(unknown.length > 0, "the live tables price players our filtered dump drops");
  for (const id of unknown.slice(0, 25)) {
    const mv = marketValue(ctx, id);
    assert.equal(mv.m, null, "an unknown id has no position, so it is not tradeable");
    assert.equal(surplus(ctx, id), 0);
  }
  const w = waiverReplacement(ctx);
  for (const pos of ["QB", "RB", "WR", "TE"]) assert.ok(ctx.players.has(w.best[pos].id));
});

test("players no source prices still get a curve value", () => {
  const priced = new Set();
  for (const src of Object.values(FULL.sources)) for (const id of Object.keys(src.values)) priced.add(id);
  const unpriced = [...ctx.players.keys()].filter(
    (id) => !priced.has(id) && ["QB", "RB", "WR", "TE"].includes(ctx.players.get(id).pos) && ctx.proj.has(id)
  );
  assert.ok(unpriced.length > 0);
  let curved = 0;
  for (const id of unpriced) {
    const mv = marketValue(ctx, id);
    if (mv.fallback === "curve") {
      assert.ok(mv.m > 0);
      assert.equal(mv.coverage, 0);
      curved += 1;
    }
  }
  assert.ok(curved > 0);
});

test("curveFit and the wire stay sane on the live table", () => {
  const { A, k } = curveFit(ctx);
  assert.ok(A > 5000 && A < 12000, `A=${A}`);
  assert.ok(k > 0.012 && k < 0.035, `k=${k}`);
  const w = waiverReplacement(ctx);
  const shape = JSON.stringify({ QB: w.QB, RB: w.RB, WR: w.WR, TE: w.TE });
  // RB and WR trade places between snapshots; what holds structurally in an 8-team league is
  // that a startable QB sits on the wire and TE is the thinnest position.
  assert.ok(w.QB > Math.max(w.RB, w.WR, w.TE), `QB should top the wire: ${shape}`);
  assert.ok(w.TE < Math.min(w.RB, w.WR), `TE should be the thinnest: ${shape}`);
  assert.ok(Math.min(w.QB, w.RB, w.WR, w.TE) > 250, shape);
  assert.equal(w.FLEX, Math.max(w.RB, w.WR, w.TE));
});

test("the moving std-dev is signed and only ever banded on its magnitude", () => {
  const sds = [];
  for (const id of Object.keys(FULL.sources.fc_redraft.values)) {
    const mv = marketValue(ctx, id);
    if (mv.sd != null) sds.push(mv.sd);
  }
  assert.ok(sds.some((v) => v < 0), "the live table publishes negative std-devs");
  assert.ok(sds.some((v) => v > 0));

  // an unsettled flag must never fire off cancelling signs, and never off a raw-value band
  const mine = activePlayers(rosterById(ctx, 3)).filter((id) => marketValue(ctx, id).m != null);
  const theirs = activePlayers(rosterById(ctx, 4)).filter((id) => marketValue(ctx, id).m != null);
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [mine[0]], get: [theirs[0]] });
  for (const flag of r.flags.filter((f) => f.type === "unsettled")) {
    const side = flag.side === "me" ? r.me : r.them;
    assert.ok(flag.sd > 0);
    assert.ok(flag.sd > 0.05 * side.valueGet.surplus, "the band is 5% of surplus, on |sd|");
  }
});

test("tiers deeper than the meaningful cut are never shown", () => {
  const deep = [...ctx.players.keys()].find((id) => {
    const mv = marketValue(ctx, id);
    return mv.tier != null && mv.tier > MAX_MEANINGFUL_TIER && mv.posRank != null;
  });
  assert.ok(deep, "the live table runs tiers well past 12");
  const shallow = [...ctx.players.keys()].find((id) => {
    const mv = marketValue(ctx, id);
    return mv.tier != null && mv.tier <= MAX_MEANINGFUL_TIER;
  });
  assert.ok(shallow);
  assert.ok(marketValue(ctx, deep).tier > MAX_MEANINGFUL_TIER, "marketValue still carries the raw tier");
});

test("lineups, trades and the finder all run against the live table", () => {
  const mineRoster = activePlayers(rosterById(ctx, 3));
  const lu = bestLineup(ctx, mineRoster, 1);
  assert.deepEqual(lu.short, []);
  assert.ok(lu.total > 50);
  assert.ok(seasonLineup(ctx, mineRoster).avgPerWeek > 100);

  const mine = mineRoster.filter((id) => marketValue(ctx, id).m != null);
  const theirs = activePlayers(rosterById(ctx, 4)).filter((id) => marketValue(ctx, id).m != null);
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [mine[0], mine[1]], get: [theirs[0]] });
  assert.ok(["steal", "clear_win", "slight_win", "fair", "slight_loss", "clear_loss", "fleeced", "needs_drop"].includes(r.verdict.code));
  assert.ok(["likely", "possible", "unlikely"].includes(r.verdict.acceptance));
  assert.ok(r.reasons.length >= 3);
  for (const f of r.flags) assert.ok(typeof f.text === "string" && f.text.length > 0);
  assert.ok(sideValue(ctx, [mine[0], mine[1]]).raw > 0);

  const started = process.hrtime.bigint();
  const deals = findTrades(make(), { myRosterId: 3 });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < 3000, `findTrades took ${elapsed.toFixed(0)} ms on the live table`);
  assert.ok(deals.length > 0);
  for (const d of deals) {
    assert.notEqual(d.acceptance, "unlikely");
    assert.ok(d.why.some((line) => /accept/.test(line)));
  }
});
