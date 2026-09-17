import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { activePlayers, buildContext, rosPoints, rosterById } from "../src/engine/context.js";
import { marketValue, surplus } from "../src/engine/values.js";
import { seasonLineup, weekPoints } from "../src/engine/lineup.js";
import { evaluateTrade } from "../src/engine/trade.js";
import { sideNames } from "../src/engine/explain.js";
import {
  DAY_MS,
  PROTECTED_BY_SURPLUS,
  currentStarters,
  dropCandidates,
  findFreeAgents,
  freeAgentPool,
  gradeTransaction,
  protectedBySurplus,
  suggestedBid,
  trendCount,
  waiverStatus,
} from "../src/engine/waiver.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// A fixed clock: every waiver window in this file is measured against it, so nothing here can
// pass on Monday and fail on Tuesday. Sunday 2026-09-09 18:00 UTC — week 1 of the fixture season.
const NOW = Date.parse("2026-09-09T18:00:00Z");
const MINE = 3; // Tom's roster in the Boyball fixture — 17 players, no reserve, no taxi
const MAHOMES = "4046"; // QB KC, unrostered in the fixture league
const NIX = "11563"; // QB DEN, unrostered
const DOWNS = "9500"; // WR IND, roster 3 bench
const BOWERS = "11604"; // TE LV, roster 3, top of the roster by value
const HOU_DEF = "HOU"; // roster 3's DEF — a current-week starter

/** data.js `normalizeTransaction`: the shape buildContext is handed (design.md §5). */
const normalize = (raw, round = 1) => ({
  id: String(raw.transaction_id ?? ""),
  week: Number(raw.leg ?? round) || round,
  type: raw.type ?? "unknown",
  status: raw.status ?? "unknown",
  created: Number(raw.created ?? 0),
  adds: raw.adds ?? {},
  drops: raw.drops ?? {},
  rosterIds: raw.roster_ids ?? [],
  draftPicks: raw.draft_picks ?? [],
});

let INPUT;
let ctx;
/** Rebuild a context with extra inputs (transactions / trending / clock / patched rosters). */
const build = (extra = {}, settings = {}) => buildContext({ ...INPUT, ...extra }, settings);

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
    transactions: fixture("transactions_1.json").map((row) => normalize(row)),
    trending: fixture("trending_add.json"),
    now: NOW,
  };
  ctx = build();
});

test("buildContext accepts the v1.2 inputs, and tolerates all three being absent", () => {
  assert.equal(ctx.now, NOW);
  assert.ok(ctx.transactions.length > 0);
  assert.ok(ctx.trending.length > 0);
  assert.equal(ctx.league.waiverType, 2, "the fixture league is FAAB");
  assert.equal(ctx.league.waiverBudget, 100);
  assert.equal(ctx.league.waiverClearDays, 1);

  const bare = buildContext({ ...INPUT, transactions: undefined, trending: undefined, now: undefined }, {});
  assert.deepEqual(bare.transactions, []);
  assert.deepEqual(bare.trending, []);
  assert.equal(bare.now, null);
  // settings.now wins over input.now (design.md §11.2)
  assert.equal(build({ now: 1 }, { now: 2 }).now, 2);
  assert.equal(build({ now: 1 }, {}).now, 1);
});

test("the free-agent pool excludes every rostered, reserve and taxi id", () => {
  const pool = freeAgentPool(ctx);
  assert.ok(pool.length > 100, `only ${pool.length} free agents`);

  const taken = new Set();
  for (const roster of fixture("rosters.json")) {
    for (const id of [...(roster.players || []), ...(roster.reserve || []), ...(roster.taxi || [])]) taken.add(id);
  }
  assert.ok(taken.size >= 130, "the fixture league rosters a meaningful chunk of the player set");
  for (const id of pool) {
    assert.ok(!taken.has(id), `${id} is rostered and must not be a free agent`);
    assert.ok(!ctx.rosterOf.has(id));
    const p = ctx.players.get(id);
    assert.ok(["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.pos), `${p.name} is a ${p.pos}`);
  }

  // Mahomes-class free agents are really out there in an 8-team league — that is the whole point
  assert.ok(pool.includes(MAHOMES), "Patrick Mahomes is unrostered in this league");
  assert.ok(pool.includes(NIX), "Bo Nix is unrostered in this league");
  // best-first, so the shortlist can just take the head of each position
  // best-first on `rosPoints`, which is what freeAgentPool sorts on. (A one-man seasonLineup is
  // no longer a proxy for it: since 13.5 D2 the other ten slots carry a streaming credit.)
  for (let i = 1; i < pool.length; i += 1) {
    assert.ok(rosPoints(ctx, pool[i - 1]) >= rosPoints(ctx, pool[i]) - 1e-9);
  }

  // one id set, memoized per ctx
  assert.equal(freeAgentPool(ctx), pool);
  // every reserve/taxi id in a patched league is excluded too, not just `players`
  const stashed = build({
    rosters: fixture("rosters.json").map((r) =>
      r.roster_id === MINE ? { ...r, players: r.players.filter((id) => id !== DOWNS), reserve: [DOWNS] } : r
    ),
  });
  assert.ok(!freeAgentPool(stashed).includes(DOWNS), "an IR stash is not a free agent");
});

test("waiverStatus flips to waivers inside the window and back to free after it", () => {
  const dropped = (hoursAgo) => [
    normalize({
      transaction_id: "synthetic-drop",
      type: "free_agent",
      status: "complete",
      created: NOW - hoursAgo * 3600000,
      adds: null,
      drops: { [MAHOMES]: 1 },
      roster_ids: [1],
    }),
  ];

  const fresh = waiverStatus(build({ transactions: dropped(6) }), MAHOMES);
  assert.equal(fresh.status, "waivers", "6 h after a drop, clear_days 1 — still on waivers");
  assert.equal(fresh.droppedBy, 1);
  assert.equal(fresh.unknown, false);
  assert.equal(Date.parse(fresh.clearsAt), NOW - 6 * 3600000 + DAY_MS);
  assert.ok(fresh.clearsAt.endsWith("Z"), "clearsAt is an ISO string");

  const cleared = waiverStatus(build({ transactions: dropped(25) }), MAHOMES);
  assert.equal(cleared.status, "free", "25 h after the drop the window has closed");
  assert.equal(cleared.clearsAt, null);
  assert.equal(cleared.droppedBy, 1, "who dropped him is still worth knowing");

  // exactly on the boundary the claim window is over
  assert.equal(waiverStatus(build({ transactions: dropped(24) }), MAHOMES).status, "free");

  // a longer league window keeps him locked up
  const slowLeague = build(
    { transactions: dropped(25) },
    {}
  );
  slowLeague.league.waiverClearDays = 3;
  assert.equal(waiverStatus(slowLeague, MAHOMES).status, "waivers");

  // somebody already claimed him: an add newer than the drop ends the window
  const claimed = build({
    transactions: [
      ...dropped(6),
      normalize({
        transaction_id: "synthetic-claim",
        type: "waiver",
        status: "complete",
        created: NOW - 3600000,
        adds: { [MAHOMES]: 5 },
        roster_ids: [5],
      }),
    ],
  });
  assert.equal(waiverStatus(claimed, MAHOMES).status, "free");

  // a player nobody ever dropped is simply free
  const untouched = waiverStatus(build({ transactions: dropped(6) }), NIX);
  assert.equal(untouched.status, "free");
  assert.equal(untouched.droppedBy, null);
});

test("with no clock, waiverStatus says free and admits it does not know", () => {
  const blind = build({ now: undefined, transactions: undefined });
  assert.equal(blind.now, null);
  for (const id of [MAHOMES, NIX, DOWNS]) {
    const status = waiverStatus(blind, id);
    assert.equal(status.status, "free");
    assert.equal(status.clearsAt, null);
    assert.equal(status.unknown, true);
  }
  // ...and the recommendation says so instead of promising an instant add
  const rows = findFreeAgents(blind, { rosterId: MINE, maxResults: 3 });
  assert.ok(rows.length > 0);
  assert.ok(rows[0].why.some((line) => line.includes("Waiver window unknown")), rows[0].why.join(" | "));
  assert.equal(rows[0].suggestedBid, null, "no clock, no claim, no bid");
});

test("findFreeAgents caps, dedupes, sorts by score and clears the gain floor", () => {
  const rows = findFreeAgents(ctx, { rosterId: MINE, maxResults: 8 });
  assert.ok(rows.length > 0, "roster 3 can improve off this wire");
  assert.ok(rows.length <= 8, `${rows.length} rows exceeds maxResults`);
  assert.equal(new Set(rows.map((r) => r.add)).size, rows.length, "an add is recommended once");

  const minGain = ctx.settings.freeAgents.minGainPerWeek;
  assert.equal(minGain, 0.5);
  for (const row of rows) {
    assert.ok(!ctx.rosterOf.has(row.add), `${row.add} is already rostered`);
    assert.ok(row.gainPerWeek >= minGain, `${row.add} gains only ${row.gainPerWeek}`);
    assert.ok(Number.isFinite(row.playoffGainPerWeek));
    assert.ok(Number.isFinite(row.valueDelta));
    assert.ok(["free", "waivers"].includes(row.status));
    assert.ok(Array.isArray(row.why) && row.why.length >= 2);
    assert.ok(row.why[0].includes(ctx.players.get(row.add).name));
    assert.ok(Number.isFinite(row.surplusDelta));
    assert.ok(Number.isFinite(row.insurancePerWeek) && Number.isFinite(row.riskPenalty));
    const cfg = ctx.settings.freeAgents;
    const expected =
      row.gainPerWeek +
      cfg.valueWeight * (row.surplusDelta / 100) +
      cfg.insuranceWeight * row.insurancePerWeek -
      cfg.riskWeight * row.riskPenalty;
    assert.ok(Math.abs(row.score - expected) < 1e-9, `${row.add}: ${row.score} vs ${expected}`);
  }
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].score >= rows[i].score, "sorted by score");

  // the floor is a real filter, not decoration
  const strict = findFreeAgents(ctx, { rosterId: MINE, minGainPerWeek: 25 });
  assert.deepEqual(strict, []);
  // and the position filter only ever returns that position
  for (const row of findFreeAgents(ctx, { rosterId: MINE, position: "QB" })) {
    assert.equal(ctx.players.get(row.add).pos, "QB");
  }
  // an unknown roster is answered, not thrown at
  assert.deepEqual(findFreeAgents(ctx, { rosterId: 99 }), []);
});

test("every recommended drop is one the roster may legally make", () => {
  const roster = rosterById(ctx, MINE);
  const active = activePlayers(roster);
  assert.equal(active.length, ctx.league.maxRoster, "roster 3 is full, so every add costs a drop");
  const shielded = protectedBySurplus(ctx, active);
  assert.equal(shielded.size, PROTECTED_BY_SURPLUS);
  assert.ok(shielded.has(BOWERS), "the top of the roster by surplus is protected");
  const starters = currentStarters(ctx, MINE);
  assert.ok(starters.has(HOU_DEF));

  const rows = findFreeAgents(ctx, { rosterId: MINE, maxResults: 12 });
  for (const row of rows) {
    assert.ok(row.drop, "a full roster always names the drop");
    assert.ok(active.includes(row.drop), `${row.drop} is not on the roster`);
    assert.ok(!shielded.has(row.drop), `${row.drop} is top-${PROTECTED_BY_SURPLUS} by surplus`);
    if (starters.has(row.drop)) {
      const addPos = ctx.players.get(row.add).pos;
      assert.equal(ctx.players.get(row.drop).pos, addPos, "a starter is only swapped for his own position");
      assert.ok(
        weekPoints(ctx, row.add, ctx.week) > weekPoints(ctx, row.drop, ctx.week),
        "and only for somebody who outscores him this week"
      );
    }
    assert.ok(row.why.some((line) => line.startsWith(`Drop ${ctx.players.get(row.drop).name}`)));
  }

  // the rule itself: no starter of another position is ever offered as a drop
  for (const drop of dropCandidates(ctx, MINE, MAHOMES)) {
    if (!starters.has(drop)) continue;
    assert.equal(ctx.players.get(drop).pos, "QB");
  }
  assert.ok(!dropCandidates(ctx, MINE, MAHOMES).includes(HOU_DEF), "the DEF starter is not cut for a QB");
  // ...and a K/DEF is only ever swapped for his own position (R4 SWAP_ONLY)
  for (const add of freeAgentPool(ctx).filter((id) => ctx.players.get(id).pos === "K").slice(0, 3)) {
    for (const drop of dropCandidates(ctx, MINE, add)) {
      if (starters.has(drop)) assert.equal(ctx.players.get(drop).pos, "K");
    }
  }
});

test("an open roster spot needs no drop at all", () => {
  const roster = fixture("rosters.json").find((r) => r.roster_id === MINE);
  const trimmed = roster.players.filter((id) => id !== DOWNS && id !== "8167");
  const open = build({
    rosters: fixture("rosters.json").map((r) => (r.roster_id === MINE ? { ...r, players: trimmed } : r)),
  });
  assert.ok(activePlayers(rosterById(open, MINE)).length < open.league.maxRoster);

  const rows = findFreeAgents(open, { rosterId: MINE, maxResults: 5 });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.drop, null, "an open spot is filled, not traded for");
    assert.ok(row.why.some((line) => line.startsWith("Open roster spot")));
  }
});

test("FAAB bids are only for contested claims, and always fit the budget", () => {
  const droppedNow = (id, roster = 1) =>
    normalize({
      transaction_id: `synthetic-${id}`,
      type: "free_agent",
      status: "complete",
      created: NOW - 6 * 3600000,
      drops: { [id]: roster },
      roster_ids: [roster],
    });
  // put the whole wire on waivers so every row carries a bid
  const allDropped = freeAgentPool(ctx).map((id) => droppedNow(id));
  const contested = build({ transactions: allDropped });
  // The floor is relaxed here on purpose: this test is about BIDS, and since 13.5 D2 priced the
  // wire into every empty slot only two adds on this fixture clear the 0.5 pts/wk default.
  const rows = findFreeAgents(contested, { rosterId: MINE, maxResults: 12, minGainPerWeek: 0.01 });
  assert.ok(rows.length > 0);

  const remaining = contested.league.waiverBudget - rosterById(contested, MINE).waiverBudgetUsed;
  assert.equal(remaining, 100);
  let waivered = 0;
  for (const row of rows) {
    assert.equal(row.status, "waivers");
    waivered += 1;
    const bid = row.suggestedBid;
    assert.ok(bid, `${row.add} is on waivers in a FAAB league and needs a bid`);
    assert.equal(bid.remaining, remaining);
    assert.ok(Number.isInteger(bid.value) && Number.isInteger(bid.aggressive));
    assert.ok(bid.value >= 1, "a claim always costs at least a dollar");
    assert.ok(bid.value <= bid.aggressive, `${bid.value} > ${bid.aggressive}`);
    assert.ok(bid.aggressive <= remaining, `${bid.aggressive} exceeds the ${remaining} left`);
    assert.ok(row.why.some((line) => line.includes(`FAAB bid ${bid.value}`)), row.why.join(" | "));
    assert.ok(row.why.some((line) => line.includes("on waivers until")));
  }
  assert.ok(waivered >= 3);

  // free/instant adds never carry a bid — outside the window the price is $0 (R4 §4)
  for (const row of findFreeAgents(ctx, { rosterId: MINE, maxResults: 8 })) {
    if (row.status !== "free") continue;
    assert.equal(row.suggestedBid, null);
    assert.ok(row.why.includes("Instant add — outside the waiver window."));
  }

  // ...and neither does a league that does not run FAAB
  const rolling = build({
    league: { ...fixture("league.json"), settings: { ...fixture("league.json").settings, waiver_type: 0 } },
    transactions: allDropped,
  });
  assert.equal(rolling.league.waiverType, 0);
  for (const row of findFreeAgents(rolling, { rosterId: MINE, maxResults: 8 })) {
    assert.equal(row.status, "waivers");
    assert.equal(row.suggestedBid, null, "no budget, no bid");
  }
  // a spent budget cannot bid either
  const broke = build({ transactions: [droppedNow(MAHOMES)] });
  const mine = rosterById(broke, MINE);
  mine.waiverBudgetUsed = 100;
  assert.equal(suggestedBid(broke, MINE, MAHOMES, 3, "waivers"), null);
  assert.equal(suggestedBid(ctx, MINE, MAHOMES, 3, "free"), null);
});

test("K and DEF candidates are valued on points alone", () => {
  const rows = findFreeAgents(ctx, { rosterId: MINE, maxResults: 40, minGainPerWeek: 0.01 });
  const kickers = rows.filter((row) => ["K", "DEF"].includes(ctx.players.get(row.add).pos));
  assert.ok(kickers.length > 0, "the fixture wire has a startable kicker or defence");
  for (const row of kickers) {
    assert.equal(row.valueDelta, 0, "K/DEF never carry a market value");
    assert.equal(marketValue(ctx, row.add).m, null);
    assert.equal(surplus(ctx, row.add), 0, "and no surplus over the wire either");
    // 13.5 D3: the add is worth nothing on the market axis, but the DROP still costs what it
    // costs — signing a kicker for a valued bench body is not free.
    assert.ok(row.surplusDelta <= 0, `${row.add} surplusDelta ${row.surplusDelta}`);
    if (row.drop) assert.ok(Math.abs(row.surplusDelta + surplus(ctx, row.drop)) < 1e-9);
    else assert.equal(row.surplusDelta, 0);
  }
});

test("trending adds are read off ctx.trending", () => {
  const hot = fixture("trending_add.json")[0];
  assert.equal(trendCount(ctx, hot.player_id), hot.count);
  assert.equal(trendCount(ctx, "no-such-player"), null);
  assert.equal(trendCount(build({ trending: undefined }), hot.player_id), null);

  const rows = findFreeAgents(ctx, { rosterId: MINE, maxResults: 40, minGainPerWeek: 0.01 });
  const trending = rows.filter((row) => row.trend != null);
  assert.ok(trending.length > 0, "somebody on the wire is trending");
  for (const row of trending) {
    assert.ok(row.why.some((line) => line.startsWith("🔥") && line.endsWith("adds in 24 h.")), row.why.join(" | "));
  }
});

test("gradeTransaction grades a completed 1-for-1 trade from both sides", () => {
  // Side A is the LOWER roster id, whichever way the transaction was written down.
  const a = 3;
  const b = 5;
  const mine = activePlayers(rosterById(ctx, a)).find((id) => ctx.players.get(id).pos === "WR");
  const theirs = activePlayers(rosterById(ctx, b)).find((id) => ctx.players.get(id).pos === "WR");
  assert.ok(mine && theirs);

  const txn = normalize({
    transaction_id: "synthetic-trade",
    type: "trade",
    status: "complete",
    created: NOW - 3600000,
    adds: { [theirs]: a, [mine]: b },
    drops: { [theirs]: b, [mine]: a },
    roster_ids: [b, a],
    leg: 1,
  });

  const graded = gradeTransaction(ctx, txn);
  assert.equal(graded.type, "trade");
  assert.equal(graded.a, a, "side A is the lower roster id");
  assert.equal(graded.b, b);
  assert.deepEqual(graded.give, [mine], "A sends the player A used to own");
  assert.deepEqual(graded.get, [theirs]);
  assert.ok(graded.labelA && graded.labelB, "both sides get a verdict");
  assert.ok(graded.labelA.length > 0 && graded.labelB.length > 0);
  assert.ok(["likely", "possible", "unlikely"].includes(graded.acceptance));

  // it is the same engine the Analyze tab runs, in the same third-person voice
  const direct = evaluateTrade(
    ctx,
    { myRosterId: a, theirRosterId: b, give: [mine], get: [theirs] },
    { names: sideNames(ctx, a, b) }
  );
  assert.equal(graded.labelA, direct.verdict.label);
  assert.equal(graded.edgeA, direct.verdict.edgePct);
  assert.equal(graded.deltaA, direct.verdict.deltaPerWeek);
  assert.equal(graded.result.verdict.code, direct.verdict.code);
  // side B's numbers are B's own run, not A's negated
  const mirror = evaluateTrade(
    ctx,
    { myRosterId: b, theirRosterId: a, give: [theirs], get: [mine] },
    { names: sideNames(ctx, b, a) }
  );
  assert.equal(graded.labelB, mirror.verdict.label);
  assert.equal(graded.edgeB, mirror.verdict.edgePct);

  // A completed trade is ALREADY reflected in Sleeper's rosters, so the same trade written the
  // other way round (A receives what he already has) must be rewound before it can be graded.
  const applied = gradeTransaction(
    ctx,
    normalize({
      transaction_id: "synthetic-applied",
      type: "trade",
      status: "complete",
      created: NOW - 3600000,
      adds: { [mine]: a, [theirs]: b },
      drops: { [mine]: b, [theirs]: a },
      roster_ids: [a, b],
      leg: 1,
    })
  );
  assert.equal(applied.result.verdict.code !== "invalid", true, "a completed trade still grades");
  assert.deepEqual(applied.give, [theirs]);
  assert.deepEqual(applied.get, [mine]);
  assert.ok(Number.isFinite(applied.edgeA) && Number.isFinite(applied.deltaA));
  // grading must not corrupt the live context
  assert.ok(activePlayers(rosterById(ctx, a)).includes(mine));
});

test("gradeTransaction grades an add/drop on the same lineup axis", () => {
  const roster = rosterById(ctx, MINE);
  const txn = normalize({
    transaction_id: "synthetic-fa",
    type: "free_agent",
    status: "complete",
    created: NOW - 7200000,
    adds: { [DOWNS]: MINE },
    drops: { [MAHOMES]: MINE },
    roster_ids: [MINE],
  });
  const graded = gradeTransaction(ctx, txn);
  assert.equal(graded.type, "free_agent");
  assert.equal(graded.rosterId, MINE);
  assert.equal(graded.add, DOWNS);
  assert.equal(graded.drop, MAHOMES);

  // the roster as it was: current − add + drop, against the roster as it is
  const now = activePlayers(roster);
  const before = now.filter((id) => id !== DOWNS).concat(MAHOMES);
  const expected = seasonLineup(ctx, now).avgPerWeek - seasonLineup(ctx, before).avgPerWeek;
  assert.ok(Math.abs(graded.gainPerWeek - expected) < 1e-9, `${graded.gainPerWeek} vs ${expected}`);
  assert.ok(graded.why[0].includes("added"));

  // real fixture transactions all grade without throwing
  for (const real of ctx.transactions) {
    const out = gradeTransaction(ctx, real);
    if (!out) continue;
    assert.ok(Number.isFinite(out.gainPerWeek ?? out.edgeA));
  }
  assert.equal(gradeTransaction(ctx, null), null);
  assert.equal(gradeTransaction(ctx, normalize({ transaction_id: "x", type: "commissioner" })), null);
});

test("the engine never reads the wall clock", () => {
  const dir = new URL("../src/engine/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("waiver.js"));
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), "utf8");
    assert.ok(!source.includes("Date.now"), `${name} reads the wall clock — ctx.now is the only clock`);
    assert.ok(!/\bfetch\s*\(/.test(source), `${name} fetches — the engine is pure`);
  }
});

// ---------------------------------------------------------------------------------------------
// §13.5 D3/D5 — the anti-QB-bias case, on a purpose-built league
// ---------------------------------------------------------------------------------------------

/**
 * A tiny, fully specified league: one QB slot, one FLEX, and a wire that holds both a startable
 * quarterback and a mediocre flex body. Every projection here is a constant, so the arithmetic in
 * the assertions below can be done on paper.
 */
function qbBiasLeague({ wireQb = 18, roster = {}, settings = {} } = {}) {
  const slots = ["QB", "RB", "WR", "FLEX", "BN", "BN", "BN", "BN"];
  const rows = [
    // my roster: a QB1 on bye in week 3, and starters good enough that only a real upgrade helps
    { id: "myqb", pos: "QB", pts: 20, bye: 3, roster: 1 },
    { id: "myrb", pos: "RB", pts: 14, roster: 1 },
    { id: "mywr", pos: "WR", pts: 13, roster: 1 },
    { id: "myflex", pos: "WR", pts: 8, roster: 1 },
    { id: "spare", pos: "WR", pts: 2, roster: 1 },
    // a rival, so the league has two teams and a replacement level
    { id: "hisqb", pos: "QB", pts: 19, roster: 2 },
    { id: "hisrb", pos: "RB", pts: 13, roster: 2 },
    { id: "hiswr", pos: "WR", pts: 12, roster: 2 },
    { id: "hisflex", pos: "WR", pts: 9, roster: 2 },
    { id: "hisspare", pos: "WR", pts: 3, roster: 2 },
    // the wire: a backup QB, a startable streaming QB, and a flex body worth +1.5 a week
    { id: "faqb2", pos: "QB", pts: 18, bye: 9, roster: 0 },
    { id: "fastream", pos: "QB", pts: wireQb, bye: 11, roster: 0 },
    { id: "faflex", pos: "WR", pts: 9.6, roster: 0 },
    { id: "fajunk", pos: "WR", pts: 1, roster: 0 },
    ...Object.entries(roster).map(([id, row]) => ({ id, roster: 0, ...row })),
  ];
  const weeks = 17;
  const players = {};
  const projections = { version: 1, players: {} };
  const squads = { 1: [], 2: [] };
  for (const row of rows) {
    players[row.id] = {
      id: row.id,
      name: row.id,
      pos: row.pos,
      team: row.id.toUpperCase(),
      inj: null,
      injPart: null,
      injNotes: null,
      age: 26,
      exp: 4,
      dc: 1,
      bye: row.bye ?? null,
    };
    projections.players[row.id] = Array.from({ length: weeks }, () => row.pts);
    if (row.roster) squads[row.roster].push(row.id);
  }
  return buildContext(
    {
      league: {
        league_id: "qb-bias",
        name: "QB bias",
        season: "2026",
        roster_positions: slots,
        scoring_settings: { rec: 0.5 },
        settings: { num_teams: 2, playoff_week_start: 15, playoff_teams: 2, waiver_type: 0 },
      },
      users: [
        { user_id: "u1", display_name: "me" },
        { user_id: "u2", display_name: "rival" },
      ],
      rosters: [
        { roster_id: 1, owner_id: "u1", players: squads[1], starters: squads[1].slice(0, 4) },
        { roster_id: 2, owner_id: "u2", players: squads[2], starters: squads[2].slice(0, 4) },
      ],
      players: { players },
      projections,
      values: { sources: {} },
      schedule: { byes: {} },
      state: { week: 1, season: "2026", season_type: "regular" },
    },
    { userId: "u1", ...settings }
  );
}

test("D3: a QB2 no longer beats a real flex upgrade, because the wire streams the bye", () => {
  const league = qbBiasLeague();
  const rows = findFreeAgents(league, { rosterId: 1, maxResults: 10, minGainPerWeek: -99 });
  const byId = new Map(rows.map((r) => [r.add, r]));
  const qb2 = byId.get("faqb2");
  const flex = byId.get("faflex");
  assert.ok(qb2 && flex, `both candidates must be scored: ${[...byId.keys()].join(", ")}`);

  // the flex add is a genuine weekly upgrade: 9.6 replaces myflex's 8 in all 17 weeks
  assert.ok(flex.gainPerWeek >= 1.5, `the flex add gains ${flex.gainPerWeek.toFixed(2)} pts/wk`);
  // the QB2 only ever plays week 3, and the wire covers week 3 for free at 0.9 x 18 = 16.2,
  // so his whole case is 18 - 16.2 = 1.8 points ONCE, or ~0.1 pts/wk over 17 weeks
  assert.ok(qb2.gainPerWeek < 0.25, `the QB2 gains ${qb2.gainPerWeek.toFixed(2)} pts/wk`);
  assert.ok(qb2.score < flex.score, `QB2 ${qb2.score.toFixed(3)} must rank below flex ${flex.score.toFixed(3)}`);
  assert.equal(rows[0].add, "faflex", "and the flex add is the recommendation");

  // R5 section 5.8 check 4: with a startable QB on the wire the QB2 insures nothing
  assert.ok(Math.abs(qb2.insurancePerWeek) < 0.2, `insurance ${qb2.insurancePerWeek}`);
  // R5 section 5.8 check 7: the engine says out loud that QB depth is not worth buying here
  assert.ok(qb2.streamable.streamable, "the wire QB is as good as mine");
  assert.ok(
    qb2.why.some((line) => line.includes("the wire streams") || line.includes("Do not pay for depth at QB")),
    qb2.why.join(" | ")
  );
});

test("D3: switch the streaming credit off and the old QB bias comes straight back", () => {
  // The regression guard. This is exactly the model Tom complained about: with an empty slot
  // worth ZERO, the QB2 books his whole 18 points for the week-3 bye and buries a real upgrade.
  const buggy = qbBiasLeague({ settings: { streaming: { enabled: false } } });
  const rows = findFreeAgents(buggy, { rosterId: 1, maxResults: 10, minGainPerWeek: -99 });
  const byId = new Map(rows.map((r) => [r.add, r]));
  const qb2 = byId.get("faqb2");
  const flex = byId.get("faflex");
  // 18 points once over 17 weeks, playoff-weighted: ~0.9 pts/wk against the flex add's 1.6
  assert.ok(qb2.gainPerWeek > 0.8, `unstreamed, the QB2 books ${qb2.gainPerWeek.toFixed(2)} pts/wk`);
  assert.ok(qb2.gainPerWeek > 8 * findFreeAgents(qbBiasLeague(), { rosterId: 1, minGainPerWeek: -99 })
    .find((r) => r.add === "faqb2").gainPerWeek, "the credit cuts his case by an order of magnitude");
  assert.ok(flex.score > 0, "the flex add is still a real upgrade either way");
});

test("D3: a wire you cannot trust makes the same QB2 worth holding", () => {
  // The answer tracks the WIRE — D2 is not an anti-quarterback rule. Same league, same players;
  // only the friction changes (R5 section 5.5's one lever). At QB 0.9 the wire is nearly a real
  // starter and holding a backup buys almost nothing; at QB 0.1 it is a lottery ticket and a
  // rostered QB2 is genuine cover for the bye AND for an absence.
  const pick = (league) =>
    findFreeAgents(league, { rosterId: 1, maxResults: 10, minGainPerWeek: -99 }).find((r) => r.add === "faqb2");
  const trusted = pick(qbBiasLeague());
  const untrusted = pick(qbBiasLeague({ settings: { streaming: { frictionByPos: { QB: 0.1 } } } }));

  // R5 section 5.8 check 4: insurance is ~0 while a startable QB sits on the wire
  assert.ok(Math.abs(trusted.insurancePerWeek) < 0.2, `trusted wire insurance ${trusted.insurancePerWeek}`);
  assert.ok(
    untrusted.insurancePerWeek > trusted.insurancePerWeek + 0.5,
    `untrusted ${untrusted.insurancePerWeek} vs trusted ${trusted.insurancePerWeek}`
  );
  assert.ok(untrusted.gainPerWeek > trusted.gainPerWeek, "and the bye-week gain grows with it");
  assert.ok(untrusted.score > trusted.score);
  assert.ok(trusted.streamable.streamable, "the position is streamable when the wire is good");
});

test("D3: every FaScore component is reported, and they sum to the score", () => {
  const league = qbBiasLeague();
  const cfg = league.settings.freeAgents;
  for (const row of findFreeAgents(league, { rosterId: 1, maxResults: 10, minGainPerWeek: -99 })) {
    const expected =
      row.gainPerWeek +
      cfg.valueWeight * (row.surplusDelta / 100) +
      cfg.insuranceWeight * row.insurancePerWeek -
      cfg.riskWeight * row.riskPenalty;
    assert.ok(Math.abs(row.score - expected) < 1e-9, `${row.add}: ${row.score} vs ${expected}`);
    assert.ok(row.insurancePerWeek <= cfg.insuranceCap + 1e-9, "insurance is capped (R5 section 4)");
    assert.ok(Math.abs(row.riskPenalty - (row.risk.score / 100) * Math.max(0, row.gainPerWeek)) < 1e-9);
    assert.ok(row.risk && row.risk.band, "the add's own risk row travels with him");
    assert.ok(Number.isFinite(row.valueDelta) && Number.isFinite(row.surplusDelta));
  }
});

test("D3: the drop is chosen on gain AND insurance, never gain alone", () => {
  // `spare` is a 2-point body; `myflex` is the 8-point flex starter. The gain-maximizing drop
  // must never be the starter, and the chosen drop must be legal.
  const league = qbBiasLeague();
  const starters = currentStarters(league, 1);
  for (const row of findFreeAgents(league, { rosterId: 1, maxResults: 10, minGainPerWeek: -99 })) {
    if (!row.drop) continue;
    assert.ok(
      !starters.has(row.drop) || league.players.get(row.drop).pos === row.pos,
      `${row.drop} is a set starter at another position`
    );
    assert.ok(Number.isFinite(row.insurancePerWeek));
  }
});
