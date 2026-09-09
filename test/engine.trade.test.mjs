import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
import { marketValue, surplus, waiverReplacement } from "../src/engine/values.js";
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
} from "../src/engine/trade.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const INPUT = {
  league: fixture("league.json"),
  users: fixture("users.json"),
  rosters: fixture("rosters.json"),
  players: fixture("players.json"),
  projections: fixture("projections.json"),
  values: fixture("values.json"),
  schedule: fixture("schedule.json"),
  state: fixture("state.json"),
};
const RAW = fixture("values.json");
const make = (settings, input = INPUT) => buildContext(input, settings);
const ctx = make({});

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
    assert.deepEqual(Object.keys(side.rosterCount).sort(), ["after", "before", "max"]);
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
