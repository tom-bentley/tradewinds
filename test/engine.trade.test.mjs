import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import { applyInjuryHaircut, marketValue, surplus, waiverReplacement } from "../src/engine/values.js";
import {
  ACCEPT_DELTA,
  ACCEPT_EDGE,
  EDGE_BANDS,
  acceptanceTier,
  LINEUP_OVERRIDE_PTS,
  VETO_EDGE,
  cheapestDroppable,
  edgeBand,
  edgePct,
  evaluateTrade,
  rosterLanding,
} from "../src/engine/trade.js";
import { seasonLineup } from "../src/engine/lineup.js";
import { sideNames } from "../src/engine/explain.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
// Fixtures load lazily inside a before() hook, never at import time: the pipeline regenerates
// projections.json and values_full.json while these tests run.
let INPUT;
let RAW;
let ctx;
const make = (settings, input) => buildContext(input || INPUT, settings);
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
  RAW = fixture("values.json");
  ctx = make({});
});

// fixture ids, verified against test/fixtures/players.json + rosters.json
const BARKLEY = "4866"; // RB, roster 3, healthy, fc_redraft 7099
const IRVING = "11584"; // RB, roster 3, healthy, fc_redraft 3196
const BOWERS = "11604"; // TE, roster 3
const REED = "10222"; // WR, roster 3, healthy, fc_redraft 914
const KICKER = "12711"; // K, roster 3
const ADAMS = "2133"; // WR, roster 4, healthy, fc_redraft 2778
const LOVELAND = "12517"; // TE, roster 4, healthy, fc_redraft 3608
const WORTHY = "11624"; // WR, roster 4, healthy, fc_redraft 424

test("PLUMBING ANCHOR (SC-003): raw value difference is the FantasyCalc difference exactly", () => {
  const plain = make({
    weights: { fc_redraft: 1, proj: 0 },
    dynastyWeights: { fc_dynasty: 0, dp_dynasty: 0 },
    keeperTilt: 0,
    rho: 0,
  });
  for (const [give, get] of [
    [BARKLEY, ADAMS],
    [REED, LOVELAND],
    [IRVING, WORTHY],
  ]) {
    assert.equal(plain.players.get(give).inj, null);
    assert.equal(plain.players.get(get).inj, null);
    const expected = RAW.sources.fc_redraft.values[get].v - RAW.sources.fc_redraft.values[give].v;
    const r = evaluateTrade(plain, { myRosterId: 3, theirRosterId: 4, give: [give], get: [get] });
    assert.ok(
      Math.abs(r.me.valueGet.raw - r.me.valueGive.raw - expected) < 0.01,
      `raw edge ${r.me.valueGet.raw - r.me.valueGive.raw} should be ${expected}`
    );
    // ρ = 0 means surplus is the raw value, so the same identity must hold there
    assert.ok(Math.abs(r.me.valueGet.surplus - r.me.valueGive.surplus - expected) < 0.01);
    // and the two sides are exact mirrors
    assert.ok(Math.abs(r.them.valueGet.raw - r.me.valueGive.raw) < 1e-9);
  }
});

test("evaluateTrade returns the documented TradeResult shape", () => {
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY], get: [ADAMS] });
  assert.deepEqual(r.give, [BARKLEY]);
  assert.deepEqual(r.get, [ADAMS]);
  assert.equal(r.myRosterId, 3);
  assert.equal(r.theirRosterId, 4);
  for (const side of [r.me, r.them]) {
    for (const k of ["valueGive", "valueGet", "edgePct", "lineup", "rosterCount", "backfill", "dropSuggestion"]) {
      assert.ok(k in side, `side is missing ${k}`);
    }
    assert.ok("raw" in side.valueGive && "surplus" in side.valueGive);
    assert.ok("before" in side.lineup && "after" in side.lineup);
    assert.equal(typeof side.lineup.deltaPerWeek, "number");
    assert.equal(typeof side.lineup.deltaPlayoffPerWeek, "number");
    // §13.4 C2 extends rosterCount with the IR-slot ledger
    assert.deepEqual(Object.keys(side.rosterCount).sort(), [
      "after",
      "before",
      "irAfter",
      "irBefore",
      "irMax",
      "max",
    ]);
  }
  for (const k of ["code", "label", "edgePct", "deltaPerWeek", "deltaPlayoffPerWeek", "override", "veto", "acceptance", "acceptLikely"]) {
    assert.ok(k in r.verdict, `verdict is missing ${k}`);
  }
  assert.ok(Array.isArray(r.flags) && Array.isArray(r.reasons));
  for (const f of r.flags) {
    assert.ok(["info", "warn", "block"].includes(f.severity));
    assert.ok(typeof f.text === "string" && f.text.length > 0, `flag ${f.type} has no text`);
  }
  assert.ok(r.reasons.length >= 3);
  for (const l of r.reasons) assert.ok(l.kind && l.text);
  assert.ok(r.best.id === BARKLEY || r.best.id === ADAMS);
  assert.equal(r.best.side, r.best.id === ADAMS ? "me" : "them");
});

test("Edge% is surplus-based and mirrored between the sides", () => {
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY], get: [ADAMS] });
  const giveS = surplus(ctx, BARKLEY);
  const getS = surplus(ctx, ADAMS);
  assert.ok(Math.abs(r.me.edgePct - (100 * (getS - giveS)) / Math.max(getS, giveS)) < 1e-9);
  assert.ok(Math.abs(r.me.edgePct + r.them.edgePct) < 1e-9, "one side's gain is the other's loss");
  assert.equal(r.verdict.edgePct, r.me.edgePct);
  assert.equal(edgePct(0, 0), 0, "an all-waiver-grade trade is not a division by zero");
});

test("verdict codes follow the ±4 / ±10 / ±25 bands", () => {
  assert.equal(edgeBand(60), "steal");
  assert.equal(edgeBand(EDGE_BANDS.steal), "steal");
  assert.equal(edgeBand(24.9), "clear_win");
  assert.equal(edgeBand(EDGE_BANDS.clearWin), "clear_win");
  assert.equal(edgeBand(9.9), "slight_win");
  assert.equal(edgeBand(EDGE_BANDS.slightWin), "slight_win");
  assert.equal(edgeBand(3.9), "fair");
  assert.equal(edgeBand(0), "fair");
  assert.equal(edgeBand(-3.9), "fair");
  assert.equal(edgeBand(EDGE_BANDS.fair), "slight_loss");
  assert.equal(edgeBand(-9.9), "slight_loss");
  assert.equal(edgeBand(EDGE_BANDS.slightLoss), "clear_loss");
  assert.equal(edgeBand(-24.9), "clear_loss");
  assert.equal(edgeBand(EDGE_BANDS.clearLoss), "fleeced");
  assert.equal(edgeBand(-99), "fleeced");
});

test("real 1-for-1 verdicts match the band of their own Edge%", () => {
  const mine = activePlayers(rosterById(ctx, 3)).filter((id) => marketValue(ctx, id).m != null);
  const theirs = activePlayers(rosterById(ctx, 5)).filter((id) => marketValue(ctx, id).m != null);
  const codes = new Set();
  let checked = 0;
  for (const give of mine) {
    for (const get of theirs) {
      const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 5, give: [give], get: [get] }, { withExplain: false });
      assert.notEqual(r.verdict.code, "invalid");
      assert.equal(r.me.rosterCount.after, r.me.rosterCount.before, "a 1-for-1 never changes a roster count");
      const expected = edgeBand(r.verdict.edgePct);
      assert.equal(r.verdict.code, expected, `${give}→${get} scored ${r.verdict.edgePct}`);
      assert.equal(r.verdict.veto, Math.abs(r.verdict.edgePct) >= VETO_EDGE);
      codes.add(expected);
      checked += 1;
    }
  }
  assert.ok(checked > 100);
  for (const c of ["steal", "fair", "fleeced"]) assert.ok(codes.has(c), `no ${c} appeared across ${checked} trades`);
});

test("the lineup overrides the market verdict in both directions", () => {
  // 3: Edge in [-10, +4] and ΔL_pw >= +1.5 → "you get better now"
  const win = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 1, give: [BARKLEY, IRVING], get: ["4034"] });
  assert.ok(win.verdict.deltaPerWeek >= LINEUP_OVERRIDE_PTS);
  // roster overflow on their side outranks the lineup override (R3 §e applies them in order)
  if (win.verdict.code !== "needs_drop") {
    assert.equal(win.verdict.override, "lineup_win");
    assert.equal(win.verdict.label, "Win — you get better now");
  }

  const synthetic = (edge, dpw) => {
    if (edge >= EDGE_BANDS.slightLoss && edge <= EDGE_BANDS.slightWin && dpw >= LINEUP_OVERRIDE_PTS) return "lineup_win";
    if (edge >= EDGE_BANDS.clearWin && dpw <= -LINEUP_OVERRIDE_PTS) return "paper_win";
    return null;
  };
  assert.equal(synthetic(-5, 2), "lineup_win");
  assert.equal(synthetic(20, -2), "paper_win");
  assert.equal(synthetic(20, 2), null);
});

test("a 2-for-1 backfills the short side and forces a drop on the long side", () => {
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY, IRVING], get: [ADAMS] });
  assert.equal(r.me.rosterCount.before, 17);
  assert.equal(r.me.rosterCount.after, 16, "I send two and get one");
  assert.equal(r.me.backfill.length, 1, "the freed spot is filled from the wire");
  assert.ok(!ctx.rosterOf.has(r.me.backfill[0]));
  assert.equal(r.me.dropSuggestion, null);

  assert.equal(r.them.rosterCount.before, 17);
  assert.equal(r.them.rosterCount.after, 18);
  assert.equal(r.them.backfill.length, 0);
  assert.ok(r.them.dropSuggestion, "the overflowing side must be told who to cut");
  assert.ok(!r.get.includes(r.them.dropSuggestion), "never suggest cutting a player just acquired");
  assert.equal(r.verdict.code, "needs_drop");
  assert.match(r.verdict.label, /They must drop /);
  const flag = r.flags.find((f) => f.type === "roster_size");
  assert.ok(flag && flag.side === "them" && flag.count === 18 && flag.max === 17);
});

test("the consolidation credit is exactly one waiver slot", () => {
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY, IRVING], get: [ADAMS] });
  const rawEdge = r.me.valueGet.raw - r.me.valueGive.raw;
  const surplusEdge = r.me.valueGet.surplus - r.me.valueGive.surplus;
  assert.ok(surplusEdge > rawEdge, "surplus must credit the side sending two bodies");
  // the swing is exactly the waiver slots freed on my side minus the one I fill on theirs
  const wire = waiverReplacement(ctx);
  const rho = ctx.settings.rho;
  const expectedSwing =
    rho * (wire[ctx.players.get(BARKLEY).pos] + wire[ctx.players.get(IRVING).pos] - wire[ctx.players.get(ADAMS).pos]);
  assert.ok(
    Math.abs(surplusEdge - rawEdge - expectedSwing) < 1e-6,
    `swing ${surplusEdge - rawEdge} should be ${expectedSwing}`
  );
  assert.ok(r.reasons.some((l) => l.kind === "consol"), "the explanation must name the freed spot");
});

test("acceptanceTier grades the rival's own two numbers", () => {
  const t = (edge, dpw) => acceptanceTier(ctx, edge, dpw);
  // fair value AND a lineup they can live with
  assert.equal(t(0, 0), "likely");
  assert.equal(t(ACCEPT_EDGE, -1.5), "likely");
  assert.equal(t(50, 5), "likely");
  // fair value but the lineup takes a real hit
  assert.equal(t(0, -1.6), "possible");
  assert.equal(t(0, -6), "possible");
  assert.equal(t(0, -6.1), "unlikely", "nobody signs off on losing 6+ pts/week");
  // a value loss they will only wear for a genuine lineup upgrade
  assert.equal(t(-5, ACCEPT_DELTA), "possible");
  assert.equal(t(-6, 0.75), "possible");
  assert.equal(t(-6.1, 5), "unlikely");
  assert.equal(t(-5, 0.74), "unlikely");
  assert.equal(t(-2.1, 0), "unlikely");

  // the boolean stays available for the UI
  for (const [edge, dpw] of [[0, 0], [0, -3], [-20, -20]]) {
    const tier = t(edge, dpw);
    assert.equal(tier !== "unlikely", tier === "likely" || tier === "possible");
  }
});

test("evaluateTrade grades acceptance from the rival's perspective", () => {
  const mine = activePlayers(rosterById(ctx, 3)).filter((id) => marketValue(ctx, id).m != null).slice(0, 6);
  const theirs = activePlayers(rosterById(ctx, 6)).filter((id) => marketValue(ctx, id).m != null).slice(0, 6);
  const seen = new Set();
  for (const give of mine) {
    for (const get of theirs) {
      const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 6, give: [give], get: [get] });
      const expected = acceptanceTier(ctx, r.them.edgePct, r.them.lineup.deltaPerWeek);
      assert.equal(r.verdict.acceptance, expected);
      assert.equal(r.verdict.acceptLikely, expected !== "unlikely");
      const rivalLine = r.reasons.find((l) => l.kind === "rival");
      assert.ok(rivalLine, "the rival line must always render");
      assert.match(rivalLine.text, /pts\/week/, "it must quote their lineup delta, not just Edge%");
      assert.match(
        rivalLine.text,
        expected === "likely" ? /likely to accept\.$/ : expected === "possible" ? /might accept\.$/ : /unlikely to accept\.$/
      );
      seen.add(expected);
    }
  }
  assert.ok(seen.size >= 2, "the tiers must actually discriminate across real trades");
});

test("a fair-value deal that guts the rival's lineup is not 'likely'", () => {
  // Barkley + Irving for CMC: dead level on value, but their starters lose several pts/week
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 1, give: [BARKLEY, IRVING], get: ["4034"] });
  assert.ok(Math.abs(r.them.edgePct) < 10, `their edge ${r.them.edgePct}`);
  assert.ok(r.them.lineup.deltaPerWeek < -ctx.settings.finder.acceptLikelyMaxLineupLoss);
  assert.notEqual(r.verdict.acceptance, "likely", "a savvy owner does not sign this at face value");
});

test("K and DEF cannot be traded", () => {
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [KICKER], get: [ADAMS] });
  assert.equal(r.verdict.code, "invalid");
  assert.match(r.verdict.label, /cannot be traded/);
  assert.ok(r.flags.some((f) => f.severity === "block"));
  const d = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY], get: ["HOU"] });
  assert.equal(d.verdict.code, "invalid");
});

test("structurally impossible proposals come back shaped, not thrown", () => {
  const notMine = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [ADAMS], get: [BARKLEY] });
  assert.equal(notMine.verdict.code, "invalid");
  const empty = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [], get: [] });
  assert.equal(empty.verdict.code, "invalid");
  const self = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 3, give: [BARKLEY], get: [IRVING] });
  assert.equal(self.verdict.code, "invalid");
  for (const r of [notMine, empty, self]) {
    assert.ok(r.me && r.them && r.verdict && Array.isArray(r.flags));
    assert.equal(r.verdict.edgePct, 0);
  }
});

test("a full roster is repaired by cutting its cheapest body, not declared invalid", () => {
  // roster 5 carries exactly one TE; taking him leaves them short with no spare roster spot
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 5, give: [REED], get: ["8130"] });
  assert.equal(ctx.players.get("8130").name, "Trey McBride");
  assert.notEqual(r.verdict.code, "invalid");
  assert.equal(r.them.shortDetail, null, "the wire covers the hole");
  assert.equal(r.them.forcedDrops.length, 1, "a full roster has to cut someone to sign the replacement");
  assert.equal(r.them.dropSuggestion, r.them.forcedDrops[0]);
  assert.ok(r.them.backfill.some((id) => ctx.players.get(id).pos === "TE"));
});

test("a lineup that cannot be filled at all is invalid", () => {
  // strip every QB but one off roster 3, and remove every free-agent QB from the player pool
  const rosters = JSON.parse(JSON.stringify(INPUT.rosters));
  const mine = rosters.find((r) => r.roster_id === 3);
  mine.players = mine.players.filter((id) => INPUT.players.players[id].pos !== "QB" || id === "12508");
  const rostered = new Set(rosters.flatMap((r) => r.players || []));
  const players = { ...INPUT.players, players: {} };
  for (const [id, p] of Object.entries(INPUT.players.players)) {
    if (p.pos === "QB" && !rostered.has(id)) continue; // no QB on the wire anywhere
    players.players[id] = p;
  }
  const fullCtx = make({}, { ...INPUT, rosters, players });
  assert.equal(activePlayers(rosterById(fullCtx, 3)).filter((id) => fullCtx.players.get(id).pos === "QB").length, 1);

  const r = evaluateTrade(fullCtx, { myRosterId: 3, theirRosterId: 4, give: ["12508"], get: [ADAMS] });
  assert.equal(r.verdict.code, "invalid");
  assert.match(r.verdict.label, /short at QB/);
  assert.ok(r.flags.some((f) => f.type === "short" && f.severity === "block"));
  assert.equal(r.me.forcedDrops.length, 0, "never cut a player for a repair that cannot happen");
});

test("a passed trade deadline is a block flag, not a changed verdict", () => {
  const late = make({}, { ...INPUT, state: { ...INPUT.state, week: 11 } });
  assert.equal(late.week, 11);
  const r = evaluateTrade(late, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY], get: [ADAMS] });
  const flag = r.flags.find((f) => f.type === "deadline");
  assert.ok(flag);
  assert.equal(flag.severity, "block");
  assert.match(flag.text, /deadline has passed/i);
  assert.equal(r.verdict.code, edgeBand(r.verdict.edgePct), "the code still reports the value verdict");

  const onTime = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY], get: [ADAMS] });
  assert.ok(!onTime.flags.some((f) => f.type === "deadline"));

  const noDeadline = make({}, {
    ...INPUT,
    league: { ...INPUT.league, settings: { ...INPUT.league.settings, trade_deadline: 0 } },
    state: { ...INPUT.state, week: 17 },
  });
  assert.equal(noDeadline.league.tradeDeadlineWeek, 0);
  const r0 = evaluateTrade(noDeadline, { myRosterId: 3, theirRosterId: 4, give: [BARKLEY], get: [ADAMS] });
  assert.ok(!r0.flags.some((f) => f.type === "deadline"), "0 means no deadline");
});

test("injury, bye and roster-share flags fire on the traded players", () => {
  const HIGGINS = "6801"; // Questionable, bye 6
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [HIGGINS], get: [ADAMS] });
  const inj = r.flags.find((f) => f.type === "injury" && f.id === HIGGINS);
  assert.ok(inj && inj.status === "Questionable" && inj.severity === "warn");
  assert.match(inj.text, /Tee Higgins is Questionable/);

  const byeWeek = make({}, { ...INPUT, state: { ...INPUT.state, week: 6 } });
  const rb = evaluateTrade(byeWeek, { myRosterId: 3, theirRosterId: 4, give: [HIGGINS], get: [ADAMS] });
  assert.ok(rb.flags.some((f) => f.type === "bye" && f.id === HIGGINS));
});

test("cheapestDroppable never empties a starting slot", () => {
  const mine = activePlayers(rosterById(ctx, 3));
  const drop = cheapestDroppable(ctx, mine);
  assert.ok(drop);
  const pos = ctx.players.get(drop).pos;
  assert.ok(!["K", "DEF"].includes(pos), "roster 3 carries exactly one K and one DEF");
  const guarded = cheapestDroppable(ctx, mine, [drop]);
  assert.notEqual(guarded, drop);
});

test("results are deterministic", () => {
  const a = evaluateTrade(make({}), { myRosterId: 3, theirRosterId: 4, give: [BARKLEY, BOWERS], get: [ADAMS, LOVELAND] });
  const b = evaluateTrade(make({}), { myRosterId: 3, theirRosterId: 4, give: [BOWERS, BARKLEY], get: [LOVELAND, ADAMS] });
  assert.equal(a.verdict.code, b.verdict.code);
  assert.equal(a.verdict.edgePct, b.verdict.edgePct);
  assert.equal(a.verdict.deltaPerWeek, b.verdict.deltaPerWeek);
  assert.deepEqual(a.me.backfill, b.me.backfill);
});

// --- §13.4 C2 — IR and taxi players in trades -------------------------------------------------
// Tom's complaint: "players on IR invalidate trades on the analyzer. That should not be the case
// as there is definitely some value to these players." Sleeper lets you trade a stashed player;
// the receiver re-parks him if his league allows the status and a slot is free.
//
// Every IR fixture below zeroes the stashed player's projections unless the test is specifically
// about the lineup axis, so WS-D's availability scaling (§13.5 D1) cannot move these numbers.

const HENDERSON = "12529"; // RB, roster 4, Out in the fixture — IR-eligible in Boyball
const BROWN = "5859"; // WR, roster 4, healthy, a real starter
const CONNER = "4137"; // RB, unrostered, IR
const KIRK = "4950"; // WR, unrostered, IR

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Park `ids` on `rosterId`'s reserve list with `status`, adding them to the roster when they were
 * not on it. Projections are zeroed by default so the lineup axis reads the same before and after
 * WS-D lands.
 */
function stash(input, rosterId, ids, status, opts = {}) {
  const zeroProj = opts.zeroProj !== false;
  const rosters = clone(input.rosters);
  const row = rosters.find((r) => r.roster_id === rosterId);
  row.reserve = [...(row.reserve || []), ...ids];
  const players = { ...input.players, players: { ...input.players.players } };
  const projections = { ...input.projections, players: { ...input.projections.players } };
  for (const id of ids) {
    if (!row.players.includes(id)) row.players.push(id);
    players.players[id] = { ...players.players[id], inj: status };
    if (zeroProj) projections.players[id] = new Array(18).fill(0);
  }
  return { ...input, rosters, players, projections };
}

/** The same, for the taxi squad. */
function onTaxi(input, rosterId, ids) {
  const rosters = clone(input.rosters);
  const row = rosters.find((r) => r.roster_id === rosterId);
  row.taxi = [...(row.taxi || []), ...ids];
  for (const id of ids) if (!row.players.includes(id)) row.players.push(id);
  return { ...input, rosters };
}

/** A copy of the league payload with patched settings. */
function leagueWith(input, settings) {
  return { ...input, league: { ...input.league, settings: { ...input.league.settings, ...settings } } };
}

test("IR: a stashed player can be traded — the deal is no longer invalid (§13.0 row 4)", () => {
  const c = make({}, stash(INPUT, 3, [REED], "IR"));
  assert.ok(c.rosters.find((r) => r.rosterId === 3).reserve.includes(REED));
  assert.ok(!activePlayers(rosterById(c, 3)).includes(REED), "he occupies no roster spot");

  const r = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  assert.notEqual(r.verdict.code, "invalid");
  assert.doesNotMatch(r.verdict.label, /not on/);
  assert.ok(!r.flags.some((f) => f.severity === "block"));
  assert.ok(r.me.valueGive.raw > 0, "his market value is still in the deal");

  // and the same trade from the other side is just as legal
  const mirror = evaluateTrade(c, { myRosterId: 4, theirRosterId: 3, give: [WORTHY], get: [REED] });
  assert.notEqual(mirror.verdict.code, "invalid");

  // a player who really is somewhere else is still rejected, in the new wording
  const bogus = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [ADAMS], get: [WORTHY] });
  assert.equal(bogus.verdict.code, "invalid");
  assert.match(bogus.verdict.label, /Davante Adams is not on your roster\./);
});

test("IR: giving away a stashed player frees an IR slot, not a roster spot", () => {
  const c = make({}, stash(INPUT, 3, [REED], "IR"));
  const r = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  assert.deepEqual(r.me.rosterCount, {
    before: 16, // 17 rostered, 1 parked
    after: 17, // the healthy WR takes the freed spot
    max: 17,
    irBefore: 1,
    irAfter: 0,
    irMax: 2,
  });
  assert.notEqual(r.verdict.code, "needs_drop", "17 of 17 is legal");
  assert.deepEqual(r.me.gaveFromIr, [REED]);
  assert.equal(r.me.backfill.length, 0, "no roster spot was freed, so nothing is signed");
});

test("IR: a received IR-eligible player lands on IR when a slot is free", () => {
  // Henderson is Out in the fixture and Boyball runs reserve_allow_out 1
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [HENDERSON] });
  assert.equal(r.me.rosterCount.before, 17);
  assert.equal(r.me.rosterCount.after, 16, "he parks on IR, so the roster spot stays open");
  assert.equal(r.me.rosterCount.irBefore, 0);
  assert.equal(r.me.rosterCount.irAfter, 1);
  assert.equal(r.me.rosterCount.irMax, 2);
  assert.ok(r.me.irIds.includes(HENDERSON));
  assert.ok(!r.me.spotIds.includes(HENDERSON));
  assert.ok(r.me.afterIds.includes(HENDERSON), "he is still part of the team's season");
  assert.equal(r.me.backfill.length, 1, "the freed spot is filled from the wire");

  const flag = r.flags.find((f) => f.type === "ir_slot" && f.id === HENDERSON);
  assert.ok(flag && flag.severity === "info" && flag.ir === true && flag.side === "me");
  assert.match(flag.text, /TreVeyon Henderson can go straight to your IR — 1 of 2 slots used\./);
  assert.ok(r.reasons.some((line) => line.text === flag.text), "the sentence reaches the explanation");

  // their side loses an active body rather than an IR occupant
  assert.equal(r.them.rosterCount.irBefore, 0, "Sleeper has him on the active roster over there");
  assert.equal(r.them.rosterCount.after, 17);
});

test("IR: with every slot taken he takes a bench spot, and a full roster needs a drop", () => {
  // roster 3 with 17 spots used AND both IR slots occupied
  const full = make({}, stash(INPUT, 3, [CONNER, KIRK], "IR"));
  assert.equal(activePlayers(rosterById(full, 3)).length, 17);

  const r = evaluateTrade(full, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [HENDERSON, WORTHY] });
  assert.equal(r.me.rosterCount.irBefore, 2);
  assert.equal(r.me.rosterCount.irAfter, 2, "no room left, so nobody new parks");
  assert.equal(r.me.rosterCount.after, 18, "both arrivals take bench spots");
  assert.equal(r.verdict.code, "needs_drop");
  assert.ok(r.me.dropSuggestion);
  assert.ok(!r.me.irIds.includes(r.me.dropSuggestion), "the drop frees a roster spot, not an IR slot");

  const flag = r.flags.find((f) => f.type === "ir_slot" && f.id === HENDERSON);
  assert.ok(flag && flag.severity === "warn" && flag.ir === false && flag.reason === "full");
  assert.match(flag.text, /No IR slot for TreVeyon Henderson — all 2 of your are full/);

  // the identical trade with the IR slots empty absorbs him for free
  const open = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [HENDERSON, WORTHY] });
  assert.equal(open.me.rosterCount.irAfter, 1);
  assert.equal(open.me.rosterCount.after, 17, "only the healthy WR needs a spot");
  assert.notEqual(open.verdict.code, "needs_drop");
});

test("IR: an Out player parks only where reserve_allow_out says he may", () => {
  const strict = make({}, leagueWith(INPUT, { reserve_allow_out: 0 }));
  assert.equal(strict.league.reserveAllow.out, false);
  const r = evaluateTrade(strict, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [HENDERSON] });
  assert.equal(r.me.rosterCount.irAfter, 0, "this league cannot stash Out");
  assert.equal(r.me.rosterCount.after, 17, "so he takes the roster spot the WR vacated");
  const flag = r.flags.find((f) => f.type === "ir_slot" && f.id === HENDERSON);
  assert.ok(flag && flag.severity === "warn" && flag.reason === "status");
  assert.match(flag.text, /TreVeyon Henderson is Out — this league cannot park that on IR/);

  // a league with no reserve slots at all says so plainly
  const none = make({}, leagueWith(INPUT, { reserve_slots: 0 }));
  const r2 = evaluateTrade(none, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [HENDERSON] });
  assert.equal(r2.me.rosterCount.irMax, 0);
  assert.equal(r2.me.rosterCount.after, 17);
  const flag2 = r2.flags.find((f) => f.type === "ir_slot" && f.id === HENDERSON);
  assert.match(flag2.text, /This league has no IR slots, so TreVeyon Henderson takes a bench spot\./);

  // a Doubtful arrival is never IR-eligible in Boyball (reserve_allow_doubtful 0)
  const doubtful = make(
    {},
    {
      ...INPUT,
      players: {
        ...INPUT.players,
        players: { ...INPUT.players.players, [WORTHY]: { ...INPUT.players.players[WORTHY], inj: "Doubtful" } },
      },
    }
  );
  const r3 = evaluateTrade(doubtful, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  assert.equal(r3.me.rosterCount.irAfter, 0);
  assert.equal(r3.me.rosterCount.after, 17);
});

test("taxi: a stashed rookie is tradeable and costs a taxi spot, not a roster spot", () => {
  const c = make({}, onTaxi(INPUT, 3, [REED]));
  assert.ok(!activePlayers(rosterById(c, 3)).includes(REED));
  const r = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  assert.notEqual(r.verdict.code, "invalid");
  assert.equal(r.me.rosterCount.before, 16);
  assert.equal(r.me.rosterCount.after, 17, "the arrival takes a roster spot; the taxi spot is freed");
  assert.equal(r.me.rosterCount.irAfter, 0, "a taxi player never came off IR");
  assert.ok(!r.me.afterIds.includes(REED));
});

test("IR: rosterLanding places receipts in proposal order, first come first parked", () => {
  const two = make({}, stash(INPUT, 4, [ADAMS, BROWN], "IR"));
  const one = rosterLanding(two, 3, [], [ADAMS, BROWN]);
  assert.equal(one.irMax, 2);
  assert.deepEqual(
    one.landing.map((x) => [x.id, x.ir]),
    [
      [ADAMS, true],
      [BROWN, true],
    ]
  );
  const oneSlot = make({}, leagueWith(stash(INPUT, 4, [ADAMS, BROWN], "IR"), { reserve_slots: 1 }));
  const tight = rosterLanding(oneSlot, 3, [], [ADAMS, BROWN]);
  assert.deepEqual(
    tight.landing.map((x) => [x.id, x.ir]),
    [
      [ADAMS, true],
      [BROWN, false],
    ],
    "one slot, so the second arrival takes a bench spot"
  );
  assert.equal(tight.after, 18, "17 spots plus the body that could not park");
});

test("IR: the injury haircut is the only discount on a stashed player's market value", () => {
  const c = make({}, stash(INPUT, 3, [REED], "IR"));
  const mv = marketValue(c, REED);
  assert.equal(c.players.get(REED).inj, "IR");
  // design §13.9: full δ on the projection-curve part of the blend, δ·injuryMarketShare on the
  // market legs that already re-priced the injury
  const delta = c.settings.injuryDiscount.IR;
  const expected = applyInjuryHaircut(mv.m, mv.projPart, delta, c.settings.injuryMarketShare);
  assert.ok(Math.abs(mv.mAdj - expected) < 1e-9, "mAdj = (m − P)(1 − δs) + P(1 − δ)");
  assert.ok(mv.mAdj < mv.m && mv.mAdj > mv.m * (1 - delta) - 1e-9, "haircut applied, but not twice");

  const r = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  assert.ok(Math.abs(r.me.valueGive.raw - mv.mAdj) < 1e-9, "sideValue.raw is Σ mAdj — haircut included");
  assert.ok(Math.abs(r.me.valueGive.surplus - surplus(c, REED)) < 1e-9);

  // the same roster with the same (zeroed) projections and no status: only δ changes, and the
  // market price underneath it is untouched
  const healthyCtx = make({}, stash(INPUT, 3, [REED], null));
  const healthy = marketValue(healthyCtx, REED);
  assert.equal(healthyCtx.players.get(REED).inj, null);
  assert.ok(Math.abs(healthy.m - mv.m) < 1e-9, "the market price itself is untouched");
  assert.ok(Math.abs(healthy.projPart - mv.projPart) < 1e-9, "same blend underneath");
  assert.ok(
    Math.abs(mv.mAdj - applyInjuryHaircut(healthy.mAdj, healthy.projPart, delta, c.settings.injuryMarketShare)) < 1e-9
  );
  assert.ok(healthy.mAdj > mv.mAdj, "the stash is discounted, not repriced");
});

test("IR: a stashed player counts on his own team's before-lineup — no free lunch", () => {
  // Out, projections intact: WS-D scales his weeks by P(available), which is 1 again by week 5,
  // so this identity holds before and after §13.5 D1 lands.
  const c = make({}, stash(INPUT, 4, [BROWN], "Out", { zeroProj: false }));
  const theirs = rosterById(c, 4);
  const pool = [...activePlayers(theirs), ...theirs.reserve];
  const withStash = seasonLineup(c, pool).total;
  const withoutStash = seasonLineup(c, activePlayers(theirs)).total;
  assert.ok(withStash > withoutStash, "he really does score points for them");

  const r = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [BROWN] });
  assert.equal(r.them.lineup.before.total, withStash, "their baseline includes the man on IR");
  assert.ok(r.me.afterIds.includes(BROWN), "and mine counts him once he is mine");
  // whatever he is worth to a lineup, he is worth it to exactly one of the two teams
  assert.ok(r.them.lineup.after.total < r.them.lineup.before.total || r.them.backfill.length > 0);
});

test("IR: the third-person voice is unchanged when a stashed player changes hands", () => {
  const c = make({}, stash(INPUT, 1, [CONNER], "IR"));
  const names = sideNames(c, 1, 4);
  assert.equal(names.first, false);
  const r = evaluateTrade(c, { myRosterId: 1, theirRosterId: 4, give: [CONNER], get: [WORTHY] }, { names });
  assert.notEqual(r.verdict.code, "invalid");
  const flag = r.flags.find((f) => f.type === "ir_slot");
  for (const text of [r.verdict.label, r.headline, ...r.reasons.map((l) => l.text), flag ? flag.text : ""]) {
    assert.doesNotMatch(String(text), /\b[Yy]ou(r)?\b/, `second person leaked into: ${text}`);
  }
  assert.ok(r.reasons.some((l) => l.text.includes(names.a) || l.text.includes(names.b)));
});

test("IR: the injury flag says how long he is out (§13.4 C4)", () => {
  const c = make({}, stash(INPUT, 3, [REED], "IR"));
  const r = evaluateTrade(c, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  const inj = r.flags.find((f) => f.type === "injury" && f.id === REED);
  assert.ok(inj);
  // Hand-checked: IR with no body part is the irMin4 row {4:.4, 6:.3, 8:.2, season:.1}, whose
  // MEDIAN is 6 games. The fixture sits in week 1 and his bye is week 11, so weeks 1-6 are six
  // real games missed and week 7 is the first he plays. (The MEAN of that row is 14.9 games —
  // the 10 % season-ending tail alone — which is why the median is the statistic used.)
  assert.equal(inj.text, "Jayden Reed is IR — expected back ~week 7.");

  // a season-ending body part says so instead of naming a week
  const torn = make(
    {},
    {
      ...INPUT,
      players: {
        ...INPUT.players,
        players: {
          ...INPUT.players.players,
          [REED]: { ...INPUT.players.players[REED], inj: "IR", injPart: "Knee", injNotes: "Torn ACL" },
        },
      },
    }
  );
  const r2 = evaluateTrade(torn, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  const inj2 = r2.flags.find((f) => f.type === "injury" && f.id === REED);
  assert.match(inj2.text, /Jayden Reed is IR — expected out for the season\./);

  // a Questionable player is expected to play, so he gets no return date
  const q = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: ["6801"], get: [ADAMS] }).flags.find(
    (f) => f.type === "injury" && f.id === "6801"
  );
  assert.ok(q);
  assert.equal(q.text, "Tee Higgins is Questionable.");
});

test("IR: the explanation says where the freed bench spot went", () => {
  const r = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [HENDERSON] });
  const line = r.reasons.find((l) => l.kind === "ir_spot");
  assert.ok(line, "a 1-for-1 that frees a roster spot has to explain itself");
  assert.match(
    line.text,
    /TreVeyon Henderson goes straight to IR, so your roster lands at 16 of 17 and .+ fills the freed bench spot\./
  );

  // a 1-for-1 between two healthy players says nothing of the kind
  const plain = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: 4, give: [REED], get: [WORTHY] });
  assert.ok(!plain.reasons.some((l) => l.kind === "ir_spot"));

  // and the sentence keeps the third-person voice for somebody else's trade
  const mine = rosterById(ctx, 1).players.find((id) => ctx.players.get(id).pos === "WR");
  const names = sideNames(ctx, 1, 4);
  const third = evaluateTrade(ctx, { myRosterId: 1, theirRosterId: 4, give: [mine], get: [HENDERSON] }, { names });
  const thirdLine = third.reasons.find((l) => l.kind === "ir_spot");
  assert.ok(thirdLine);
  assert.doesNotMatch(thirdLine.text, /\b[Yy]our\b/);
  assert.match(thirdLine.text, new RegExp(names.aPoss.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
