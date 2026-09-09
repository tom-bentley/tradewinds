import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { activePlayers, buildContext, rosterById } from "../src/engine/context.js";
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
  const ros = (id) => seasonLineup(ctx, [id]).total;
  for (let i = 1; i < pool.length; i += 1) assert.ok(ros(pool[i - 1]) >= ros(pool[i]) - 1e-9);

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
    assert.ok(Math.abs(row.score - (row.gainPerWeek + 0.05 * (row.valueDelta / 100))) < 1e-9);
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
  const rows = findFreeAgents(contested, { rosterId: MINE, maxResults: 12 });
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
    assert.equal(row.score, row.gainPerWeek, "so their score is pure lineup gain");
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
