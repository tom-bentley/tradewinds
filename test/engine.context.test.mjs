import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULTS } from "../src/config.js";
import {
  activeCount,
  activePlayers,
  buildContext,
  buildHistory,
  historyRow,
  historyWeekly,
  irEligibleStatus,
  isReserve,
  isTaxi,
  mergeSettings,
  playerOf,
  resolveMyRosterId,
  rosterById,
  rosPoints,
  rosteredIds,
  slotEligibility,
  tradeablePlayers,
} from "../src/engine/context.js";
import { STATUS_CHAIN, irEligible } from "../src/engine/advisor.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// Fixtures load lazily inside a before() hook, never at import time: the pipeline regenerates
// projections.json and values_full.json while these tests run.
/** tommyteez — settings.userId is empty by default now, so every ctx names its user. */
const TOMMY = "1394551386997272576";
let INPUT;
let ctx;
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
  ctx = buildContext(INPUT, { userId: TOMMY });
});

test("buildContext returns the documented ctx shape", () => {
  assert.equal(ctx.league.id, "1394476745138147328");
  assert.equal(ctx.league.name, "Boyball 🏈");
  assert.equal(ctx.league.numTeams, 8);
  assert.equal(ctx.league.maxRoster, 17, "roster_positions length, incl BN, excl IR");
  assert.equal(ctx.league.irSlots, 2);
  assert.equal(ctx.league.tradeDeadlineWeek, 10);
  assert.equal(ctx.league.vetoVotesNeeded, 5);
  assert.equal(ctx.league.tradeReviewDays, 1);
  assert.ok(Object.keys(ctx.league.scoring).length > 20);

  assert.equal(ctx.season, "2026");
  assert.equal(ctx.week, 1, "state.season_type is regular and state.week is 1");
  assert.equal(ctx.lastWeek, 17);
  assert.deepEqual(ctx.weeksLeft, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(ctx.playoffWeeks, [15, 16, 17]);
  assert.deepEqual(ctx.slots, ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"]);
  assert.deepEqual([...ctx.flexEligible].sort(), ["RB", "TE", "WR"]);

  assert.ok(ctx.players instanceof Map);
  assert.equal(ctx.players.size, 871);
  assert.ok(ctx.proj instanceof Map);
  assert.equal(ctx.proj.get("4866").length, 18);
  assert.deepEqual(Object.keys(ctx.values).sort(), ["fc_dynasty", "fc_redraft"]);
  assert.equal(ctx.byes.KC, 5);
  assert.equal(ctx.rosters.length, 8);
  assert.deepEqual(ctx.memo, {}, "memo starts empty");
});

test("myRosterId resolves to the configured user's roster", () => {
  assert.equal(ctx.myRosterId, 3);
  const mine = rosterById(ctx, 3);
  assert.equal(mine.ownerId, "1394551386997272576");
  assert.equal(mine.displayName, "tommyteez");
  assert.equal(mine.teamName, "Johnston Jackoffs");
  assert.equal(mine.players.length, 17);
  assert.equal(mine.starters.length, 11);
});

test("myRosterId is null for a user who is not in this league (viewer mode)", () => {
  const other = buildContext(INPUT, { userId: "nobody" });
  assert.equal(other.myRosterId, null, "no roster is 'mine' when I do not play in this league");
  const noUser = buildContext(INPUT, {});
  assert.equal(noUser.myRosterId, null, "settings.userId is empty until onboarding sets it");
  assert.equal(resolveMyRosterId([], "x"), null);
  assert.equal(resolveMyRosterId(ctx.rosters, null), null);
  // a co-owner counts as the owner
  const coOwned = ctx.rosters.map((r) => (r.rosterId === 5 ? { ...r, coOwners: ["co-1"] } : r));
  assert.equal(resolveMyRosterId(coOwned, "co-1"), 5);
});

test("active count is players minus reserve and taxi", () => {
  // rosters 1, 2 and 6 each stash one player on IR
  const stashed = ctx.rosters.filter((r) => r.reserve.length);
  assert.equal(stashed.length, 3);
  for (const r of stashed) {
    const parked = r.players.filter((id) => r.reserve.includes(id) || r.taxi.includes(id)).length;
    assert.equal(parked, 1, "the IR stash is listed inside players");
    assert.equal(activeCount(r), r.players.length - 1);
    assert.equal(activePlayers(r).length, activeCount(r));
    for (const id of r.reserve) assert.ok(!activePlayers(r).includes(id));
  }
  assert.equal(activeCount(rosterById(ctx, 3)), 17, "no IR stash, so all 17 count against the cap");
  assert.equal(activeCount(rosterById(ctx, 1)), 17, "18 rostered, 1 on IR");
});

test("tradeablePlayers is every id a team holds — roster spots, IR and taxi (§13.4 C1)", () => {
  const stashed = ctx.rosters.find((r) => r.reserve.length);
  const parked = stashed.reserve[0];
  assert.ok(!activePlayers(stashed).includes(parked), "an IR stash occupies no roster spot");
  assert.ok(tradeablePlayers(stashed).includes(parked), "but he is still tradeable");
  assert.equal(tradeablePlayers(stashed).length, stashed.players.length, "reserve is inside players");
  assert.equal(new Set(tradeablePlayers(stashed)).size, tradeablePlayers(stashed).length, "no duplicates");
  assert.ok(isReserve(stashed, parked));
  assert.ok(!isTaxi(stashed, parked));

  // a taxi id Sleeper did not also list in `players` still comes back exactly once
  const withTaxi = { ...stashed, taxi: [parked, "taxi-only"] };
  assert.equal(tradeablePlayers(withTaxi).filter((id) => id === parked).length, 1);
  assert.ok(tradeablePlayers(withTaxi).includes("taxi-only"));
  assert.ok(isTaxi(withTaxi, "taxi-only"));

  assert.deepEqual(tradeablePlayers(null), [], "never throws on a missing roster");
  assert.equal(isReserve(null, "x"), false);
  assert.equal(isTaxi(null, "x"), false);
});

test("irEligibleStatus reads the league's own reserve_allow_* rules", () => {
  assert.equal(irEligibleStatus(ctx, "IR"), true);
  assert.equal(irEligibleStatus(ctx, "PUP"), true);
  assert.equal(irEligibleStatus(ctx, "Reserve"), true);
  assert.equal(irEligibleStatus(ctx, "Out"), true, "Boyball runs reserve_allow_out 1");
  assert.equal(irEligibleStatus(ctx, "Doubtful"), false, "reserve_allow_doubtful 0");
  assert.equal(irEligibleStatus(ctx, "NA"), false, "reserve_allow_na 0");
  assert.equal(irEligibleStatus(ctx, "Questionable"), false);
  assert.equal(irEligibleStatus(ctx, null), false);
  assert.equal(irEligibleStatus({}, "IR"), true, "no league block is not a crash");

  const strict = buildContext(
    { ...INPUT, league: { ...INPUT.league, settings: { ...INPUT.league.settings, reserve_allow_out: 0 } } },
    {}
  );
  assert.equal(irEligibleStatus(strict, "Out"), false);
  const loose = buildContext(
    {
      ...INPUT,
      league: {
        ...INPUT.league,
        settings: { ...INPUT.league.settings, reserve_allow_doubtful: 1, reserve_allow_na: 1 },
      },
    },
    {}
  );
  assert.equal(irEligibleStatus(loose, "Doubtful"), true);
  assert.equal(irEligibleStatus(loose, "NA"), true);
});

test("irEligibleStatus never drifts from advisor.irEligible", () => {
  // context.js cannot import advisor.js (it is the base of the engine — the import would be
  // circular), so the two copies of the rule are pinned together here instead.
  const statuses = [
    ...STATUS_CHAIN,
    "PUP",
    "Reserve",
    "DNR",
    "NA",
    "COV",
    "Sus",
    "Suspended",
    "Probable",
    null,
    "",
  ];
  for (const permissive of [0, 1]) {
    const league = { ...INPUT.league, settings: { ...INPUT.league.settings } };
    for (const key of ["out", "doubtful", "sus", "cov", "dnr", "na"]) {
      league.settings[`reserve_allow_${key}`] = permissive;
    }
    const variant = buildContext({ ...INPUT, league }, {});
    for (const status of statuses) {
      assert.equal(
        irEligibleStatus(variant, status),
        irEligible(variant, status),
        `${status} disagrees with advisor.irEligible (reserve_allow_* = ${permissive})`
      );
    }
  }
});

test("ctx.history is an empty Map when no history file was loaded (§13.6 F1)", () => {
  assert.ok(ctx.history instanceof Map);
  assert.equal(ctx.history.size, 0);
  assert.equal(historyRow(ctx, "4866"), null);
  assert.deepEqual(historyWeekly(ctx, "4866"), []);
  for (const bad of [null, undefined, 42, "nope", {}, { seasons: null }, { seasons: 7 }]) {
    assert.equal(buildHistory(bad).size, 0);
  }
});

test("ctx.history carries last season and this season, scored this league's way", () => {
  const history = {
    version: 1,
    generated_at: "2026-09-17T00:00:00Z",
    scoring: { std: "pts_std", rec: "rec" },
    seasons: {
      2025: { weeks: 18, players: { 4866: { gp: 16, ga: 17, w: [[20.4, 4], null, [8, 2]] } } },
      2026: { weeks: 1, players: { 4866: { gp: 1, ga: 1, w: [[12, 6]] }, 11604: { gp: 1, ga: 1, w: [[9, 3]] } } },
    },
  };
  const withHistory = buildContext({ ...INPUT, history }, { userId: TOMMY });
  assert.equal(withHistory.history.size, 2);
  const row = historyRow(withHistory, "4866");
  assert.equal(row.id, "4866");
  assert.equal(row.latest, "2026", "the newest season on record");
  assert.equal(row.seasons["2025"].gp, 16);
  assert.equal(row.seasons["2025"].ga, 17);
  assert.equal(row.seasons["2025"].weeks, 18);

  // half-PPR: std + 0.5 × rec, and a week he missed stays null rather than becoming a zero
  assert.equal(withHistory.league.ppr, 0.5);
  assert.deepEqual(historyWeekly(withHistory, "4866", "2025"), [22.4, null, 9]);
  assert.deepEqual(historyWeekly(withHistory, "4866"), [15], "defaults to the newest season");
  assert.deepEqual(historyWeekly(withHistory, "11604", "2025"), [], "no 2025 rows for him");
  assert.deepEqual(historyWeekly(withHistory, "nobody"), []);

  // the same file read by a full-PPR league scores the same weeks differently
  const ppr = buildContext(
    {
      ...INPUT,
      history,
      league: { ...INPUT.league, scoring_settings: { ...INPUT.league.scoring_settings, rec: 1 } },
    },
    {}
  );
  assert.deepEqual(historyWeekly(ppr, "4866", "2025"), [24.4, null, 10]);
});

test("rosterOf indexes every rostered player exactly once", () => {
  const ids = rosteredIds(ctx);
  assert.equal(ids.size, 138, "8 rosters, 17 active + 3 stashed");
  for (const id of ids) assert.ok(ctx.rosterOf.has(id));
  assert.equal(ctx.rosterOf.get("4866"), 3);
});

test("playerOf never throws on an unknown id", () => {
  const stub = playerOf(ctx, "not-a-player");
  assert.equal(stub.id, "not-a-player");
  assert.equal(stub.pos, null);
});

test("rosPoints sums the remaining weeks only", () => {
  const vec = ctx.proj.get("4866");
  const expected = ctx.weeksLeft.reduce((a, w) => a + vec[w - 1], 0);
  assert.ok(Math.abs(rosPoints(ctx, "4866") - expected) < 1e-9);
  assert.equal(rosPoints(ctx, "no-projection-here"), 0);
});

test("week is clamped and only trusted during the regular season", () => {
  const preseason = buildContext({ ...INPUT, state: { ...INPUT.state, season_type: "pre", week: 3 } }, {});
  assert.equal(preseason.week, 1);
  const late = buildContext({ ...INPUT, state: { ...INPUT.state, week: 12 } }, {});
  assert.equal(late.week, 12);
  assert.deepEqual(late.weeksLeft, [12, 13, 14, 15, 16, 17]);
  const past = buildContext({ ...INPUT, state: { ...INPUT.state, week: 18 } }, {});
  assert.equal(past.week, 17);
});

test("settings merge one level deep over DEFAULTS", () => {
  const merged = mergeSettings({ keeperTilt: 0, weights: { fc_redraft: 1 }, finder: { perRival: 1 } });
  assert.equal(merged.keeperTilt, 0);
  assert.equal(merged.weights.fc_redraft, 1);
  assert.equal(merged.weights.proj, DEFAULTS.weights.proj, "untouched nested keys survive");
  assert.equal(merged.finder.perRival, 1);
  assert.equal(merged.finder.maxCandidates, DEFAULTS.finder.maxCandidates);
  assert.equal(merged.rho, DEFAULTS.rho);
  assert.deepEqual(mergeSettings().weights, { ...DEFAULTS.weights });
});

test("DEFAULTS carries the design §4 settings shape", () => {
  assert.deepEqual(DEFAULTS.weights, { fc_redraft: 0.8, proj: 0.2 });
  assert.deepEqual(DEFAULTS.dynastyWeights, { fc_dynasty: 0.7, dp_dynasty: 0.3 });
  assert.equal(DEFAULTS.keeperTilt, 0.15);
  assert.equal(DEFAULTS.rho, 1.0);
  assert.equal(DEFAULTS.playoffWeight, 2.0);
  assert.equal(DEFAULTS.injuryDiscount.Out, 0.15);
  assert.equal(DEFAULTS.injuryDiscount.IR, 0.35);
  assert.deepEqual(DEFAULTS.finder.shapes, ["1-1", "2-1", "1-2", "2-2"]);
  assert.equal(DEFAULTS.finder.acceptLikelyMaxLineupLoss, 1.5);
  assert.equal(DEFAULTS.finder.acceptPossibleMaxLineupLoss, 6);
  assert.equal(DEFAULTS.finder.acceptPossibleMinEdge, -6);
  assert.equal(DEFAULTS.finder.likelyBonus, 0.5);
});

test("slot eligibility is dedicated-subset-of-FLEX", () => {
  assert.deepEqual(slotEligibility("QB"), ["QB"]);
  assert.deepEqual(slotEligibility("FLEX"), ["RB", "WR", "TE"]);
  assert.deepEqual(slotEligibility("BN"), []);
});

test("v1.4 settings blocks merge key by key like the older ones", () => {
  const merged = mergeSettings({ streaming: { enabled: false }, risk: { lambda: 0.4 }, availability: {} });
  assert.equal(merged.streaming.enabled, false);
  assert.deepEqual(merged.streaming.frictionByPos, DEFAULTS.streaming.frictionByPos, "a partial patch keeps the friction table");
  assert.equal(merged.risk.lambda, 0.4);
  assert.equal(merged.availability.scaleFutureWeeks, DEFAULTS.availability.scaleFutureWeeks);
  assert.ok(Object.keys(merged.risk).length > 1, "the rest of the risk block survives");
});
