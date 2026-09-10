// test/engine.advisor.test.mjs — the v1.3 Advisor engine (design.md §12.2).
//
// Fixtures only, no network, no clock: every number below comes from the 2026-09-09 Boyball
// snapshot in ./fixtures with an injected `now`, so a test that passes today passes in February.
// The headline case is the one that triggered the release (design §12.0): Brock Bowers ruled
// Doubtful with a meniscus problem, ten minutes before Tom panic-dropped him.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { activePlayers, buildContext, playerOf, rosterById } from "../src/engine/context.js";
import { weekPoints } from "../src/engine/lineup.js";
import {
  HEADLINE_MAX,
  SUMMARY_MAX,
  advise,
  adviseAll,
  applyStatuses,
  applyWeekPoints,
  diffStatuses,
  irEligibility,
  irEligible,
  shortName,
  standingIssues,
  statusKey,
} from "../src/engine/advisor.js";
import { INJURY_RULES, absenceOf, availability, withAbsence } from "../src/engine/injuries.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** Sunday 2026-09-09 18:00 UTC — week 1 of the fixture season, the same clock waiver.js uses. */
const NOW = Date.parse("2026-09-09T18:00:00Z");
/** Tom's roster in the Boyball fixture: 17 players, no reserve, no taxi. */
const MINE = 3;
const ME = "1394551386997272576"; // tommyteez
const BOWERS = "11604"; // TE LV, roster 3, the current-week TE starter
const GOEDERT = "5022"; // TE PHI, roster 3 bench — the replacement
const OLAVE = "8144"; // WR NO, roster 3 starter
const DOWNS = "9500"; // WR IND, roster 3 bench, Questionable in the fixture
const KRAFT = "9484"; // TE GB, roster 1's current-week TE starter
const JOHNSON = "7002"; // TE NO, the best free tight end in this league
/** The real 2026-09-09 news, as the pipeline would deliver it. */
const NEWS_AT = 1788984945628;
const KNEE = { injPart: "Knee - Meniscus", injNotes: "Surgery" };

let INPUT;
let ctx;

/** Build a context, optionally patching the raw player rows or rosters first. */
const build = (patch = {}, settings = {}) =>
  buildContext({ ...INPUT, ...patch }, { userId: ME, ...settings });

/** players.json with one row overridden (v2.1 fields: injPart, injNotes, newsAt). */
const withPlayer = (id, row) => {
  const players = fixture("players.json");
  players.players[id] = { ...players.players[id], ...row };
  return players;
};

/** rosters.json with one roster overridden. */
const withRoster = (rosterId, row) =>
  fixture("rosters.json").map((r) => (r.roster_id === rosterId ? { ...r, ...row } : r));

/** The event the pipeline's diff would produce for a status change. */
const statusEvent = (id, after, before = { inj: null, injPart: null, injNotes: null }) => ({
  id,
  kind: "status",
  before,
  after,
  newsAt: NEWS_AT,
});

/** Everything a pure function must leave untouched (memo is a documented cache, so not this). */
const snapshot = (c) =>
  JSON.stringify({
    week: c.week,
    players: [...c.players].map(([id, p]) => [id, p]),
    proj: [...c.proj].map(([id, vec]) => [id, [...vec]]),
    rosters: c.rosters,
    league: c.league,
  });

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
    transactions: [],
    trending: fixture("trending_add.json"),
    now: NOW,
  };
  ctx = build();
});

test("buildContext exposes the league's own reserve rules, nothing hard-coded", () => {
  assert.equal(ctx.myRosterId, MINE);
  assert.equal(ctx.league.irSlots, 2, "Boyball runs reserve_slots 2");
  assert.deepEqual(ctx.league.reserveAllow, {
    out: true, // reserve_allow_out 1
    doubtful: false, // reserve_allow_doubtful 0 — the whole point of the Bowers case
    sus: false,
    cov: false,
    dnr: false,
    na: false,
  });
  // a league that allows Doubtful is a different answer, from the same code
  const permissive = build({
    league: { ...fixture("league.json"), settings: { ...fixture("league.json").settings, reserve_allow_doubtful: 1 } },
  });
  assert.equal(permissive.league.reserveAllow.doubtful, true);
  assert.equal(irEligible(permissive, "Doubtful"), true);
  assert.equal(irEligible(ctx, "Doubtful"), false);
  assert.equal(irEligible(ctx, "Out"), true);
  assert.equal(irEligible(ctx, "IR"), true, "IR and PUP never need permission");
  assert.equal(irEligible(ctx, "Questionable"), false);
  assert.equal(irEligible(ctx, null), false);
});

test("the injury table matches on status, body part and notes — most specific first", () => {
  const abs = (inj, injPart, injNotes) => absenceOf(ctx, { inj, injPart, injNotes });
  const sum = (a) => a.branches.reduce((s, b) => s + b.p, 0);

  // a season-ender outranks everything, including the status row
  const acl = abs("Out", "Knee", "Torn ACL");
  assert.equal(acl.key, "season");
  assert.equal(acl.seasonOver, true);
  assert.deepEqual(acl.branches, [{ games: 99, p: 1 }]);
  assert.equal(abs("IR", "Achilles", "Ruptured").key, "season", "IR-class takes max(table, irMin4)");

  // the case in the release trigger
  const meniscus = abs("Doubtful", KNEE.injPart, KNEE.injNotes);
  assert.equal(meniscus.key, "meniscus");
  assert.equal(meniscus.seasonOver, false);
  assert.equal(Math.round(meniscus.mean * 100) / 100, 2.55);
  assert.deepEqual(meniscus.branches[0], { games: 1, p: 0.3 });

  // ...and the same body part listed Questionable is a man who probably plays
  const soft = abs("Questionable", KNEE.injPart, KNEE.injNotes);
  assert.equal(soft.key, "meniscus");
  assert.equal(soft.branches[0].games, 0);
  assert.ok(Math.abs(soft.branches[0].p - 0.6) < 1e-9, "Questionable shifts 60% back to week zero");
  assert.ok(soft.mean < meniscus.mean);

  // reserve lists imply four games at minimum, whatever the body part says
  assert.equal(abs("IR", "Hamstring", "Strain").key, "irMin4");
  assert.equal(abs("PUP", null, null).branches[0].games, 4);

  // suspensions state their own length
  assert.deepEqual(abs("Sus", null, "3-game suspension").branches, [{ games: 3, p: 1 }]);
  assert.ok(Math.abs(abs("Sus", null, "violation of the personal conduct policy").mean - 1.9) < 1e-9);

  // bone breaks split by which bone
  assert.equal(abs("Out", "Foot", "Fractured").key, "fractureBig");
  assert.equal(abs("Out", "Thumb", "Broken").key, "fractureSmall");
  assert.ok(abs("Out", "Foot", "Fractured").mean > abs("Out", "Thumb", "Broken").mean);
  assert.equal(abs("Out", "Ankle", "High ankle sprain").key, "highAnkle");
  assert.equal(abs("Doubtful", "Knee", "MCL sprain").key, "mcl");
  assert.equal(abs("Out", "Hamstring", null).key, "softTissue");
  assert.equal(abs("Out", "Head", "Concussion protocol").key, "concussion");
  assert.equal(abs("Out", "Shoulder", null).key, "shoulder");

  // a known-minor part defers to the status; an unknown part falls all the way through to it
  assert.equal(abs("Out", "Ankle", null).key, "minor");
  assert.equal(abs("Out", "Wrist", null).key, "status:Out", "a part no rule names defers to the status");
  assert.deepEqual(abs("Out", "Ankle", null).branches, abs("Out", "Wrist", null).branches);
  assert.equal(abs("Doubtful", null, null).key, "status:Doubtful");
  assert.ok(Math.abs(abs("Doubtful", null, null).mean - 1.4) < 1e-9);
  assert.equal(abs("Questionable", null, null).branches[0].p, 0.7);

  // no status is no absence, however stale the body part left on the row
  const healthy = abs(null, "Knee", "Torn ACL");
  assert.equal(healthy.key, "none");
  assert.equal(healthy.mean, 0);
  assert.deepEqual(healthy.branches, [{ games: 0, p: 1 }]);

  // every distribution is a distribution
  for (const row of [acl, meniscus, soft, abs("IR", null, null), abs("Sus", null, "3-game"), healthy]) {
    assert.ok(Math.abs(sum(row) - 1) < 1e-9, `${row.key} sums to ${sum(row)}`);
    for (const branch of row.branches) assert.ok(branch.p > 0 && branch.games >= 0);
  }
  assert.ok(INJURY_RULES.length >= 12, "the shipped table covers the twelve documented rules");
});

test("a table in settings replaces the built-in rules, an empty one does not", () => {
  const custom = build({}, { injuryTable: [{ key: "everything", tokens: ["knee"], branches: [{ games: 2, p: 1 }] }] });
  const hit = absenceOf(custom, { inj: "Doubtful", ...KNEE });
  assert.equal(hit.key, "everything");
  assert.deepEqual(hit.branches, [{ games: 2, p: 1 }]);
  // a table that does not match falls through to the status row, not to the built-ins
  assert.equal(absenceOf(custom, { inj: "Out", injPart: "Achilles", injNotes: "Ruptured" }).key, "status:Out");
  // ...and null/empty means "use the engine's own rules" (config.js ships injuryTable: null)
  assert.equal(ctx.settings.injuryTable, null);
  assert.equal(absenceOf(build({}, { injuryTable: [] }), { inj: "Doubtful", ...KNEE }).key, "meniscus");
});

test("availability counts GAMES, not weeks, so a bye pushes the return date out", () => {
  const absence = absenceOf(ctx, { inj: "Out", injPart: "Knee", injNotes: "Meniscus" });
  // he misses this week for certain, and is back with P = Σ p(games < k) on the k-th game
  assert.equal(availability(ctx, BOWERS, 1, absence), 0);
  assert.ok(Math.abs(availability(ctx, BOWERS, 2, absence) - 0.3) < 1e-9);
  assert.ok(Math.abs(availability(ctx, BOWERS, 3, absence) - 0.6) < 1e-9);
  assert.ok(Math.abs(availability(ctx, BOWERS, 4, absence) - 0.75) < 1e-9);
  assert.equal(availability(ctx, BOWERS, 8, absence), 1, "long past the tail he is simply back");
  assert.equal(availability(ctx, BOWERS, 0, absence), 1, "weeks already played are not in question");

  // the same absence, but his team is idle in week 2: every return probability slides a week
  const bye2 = build({ players: withPlayer(BOWERS, { bye: 2 }) });
  assert.equal(availability(bye2, BOWERS, 2, absence), 0, "he does not play in his bye either way");
  assert.ok(Math.abs(availability(bye2, BOWERS, 3, absence) - 0.3) < 1e-9);
  assert.ok(Math.abs(availability(bye2, BOWERS, 4, absence) - 0.6) < 1e-9);
});

test("withAbsence discounts the injured player's future weeks and never touches the input", () => {
  const absence = absenceOf(ctx, { inj: "Out", injPart: "Knee", injNotes: "Meniscus" });
  const beforeSnapshot = snapshot(ctx);
  const scen = withAbsence(ctx, BOWERS, absence);
  assert.equal(snapshot(ctx), beforeSnapshot, "the shared ctx is immutable");
  assert.notEqual(scen, ctx);
  assert.notEqual(scen.proj, ctx.proj);
  assert.deepEqual(scen.memo, {}, "memoized week vectors cache the old status");

  const raw = ctx.proj.get(BOWERS);
  const cut = scen.proj.get(BOWERS);
  assert.equal(cut[0], raw[0], "the current week is weekVector's job, not ours");
  // Sleeper still projects a full week 2 the morning after surgery (design §12.1) — we do not
  assert.ok(raw[1] > 12 && cut[1] < 5, `wk2 ${raw[1]} → ${cut[1]}`);
  assert.ok(cut[2] > cut[1] && cut[2] < raw[2], "the discount unwinds as he gets closer");
  // ...and on a ctx that also carries the status, weekVector zeroes the current week for us
  const hurt = applyStatuses(ctx, [{ id: BOWERS, inj: "Out", ...KNEE, newsAt: NEWS_AT }]);
  assert.equal(weekPoints(withAbsence(hurt, BOWERS, absence), BOWERS, ctx.week), 0);
  // everyone else is untouched, by identity
  assert.equal(scen.proj.get(GOEDERT), ctx.proj.get(GOEDERT));

  // an unknown id is answered with a fresh ctx rather than a throw
  const unknown = withAbsence(ctx, "no-such-player", absence);
  assert.deepEqual(unknown.memo, {});
  assert.equal(unknown.proj, ctx.proj);
});

test("applyStatuses patches rows on a new ctx, ignoring ids this league never heard of", () => {
  const beforeSnapshot = snapshot(ctx);
  const next = applyStatuses(ctx, [
    { id: BOWERS, inj: "Doubtful", ...KNEE, newsAt: NEWS_AT, dc: 1 },
    { id: "definitely-not-a-player", inj: "Out", injPart: null, injNotes: null, newsAt: 1 },
  ]);
  assert.equal(snapshot(ctx), beforeSnapshot, "the input ctx is untouched");
  assert.notEqual(next.players, ctx.players);
  assert.deepEqual(next.memo, {});
  assert.equal(next.players.size, ctx.players.size, "unknown ids are ignored, not invented");

  const row = next.players.get(BOWERS);
  assert.equal(row.inj, "Doubtful");
  assert.equal(row.injPart, KNEE.injPart);
  assert.equal(row.injNotes, KNEE.injNotes);
  assert.equal(row.newsAt, NEWS_AT);
  assert.equal(row.name, "Brock Bowers", "the rest of the player row survives");
  assert.equal(ctx.players.get(BOWERS).inj, null, "…and the original row is still healthy");
  assert.equal(weekPoints(ctx, BOWERS, 1) > 12, true);
  assert.equal(weekPoints(next, BOWERS, 1), 0, "the new ctx zeroes his week; the old one does not");

  // an explicit null is a null, not a zero — a real news_updated is never 0
  const cleared = applyStatuses(next, [{ id: BOWERS, inj: "Out", injPart: null, injNotes: null, newsAt: null }]);
  assert.equal(cleared.players.get(BOWERS).newsAt, null);
  assert.equal(cleared.players.get(BOWERS).dc, 1, "fields the row omits keep their old value");

  // clearing a status is a change too, and a no-op patch costs nothing
  assert.equal(applyStatuses(next, [{ id: BOWERS, inj: null, injPart: null, injNotes: null }]).players.get(BOWERS).inj, null);
  assert.equal(applyStatuses(ctx, []), ctx);
  assert.equal(applyStatuses(ctx, [{ id: GOEDERT, inj: null, injPart: null, injNotes: null }]), ctx);
});

test("applyWeekPoints only ever applies the current week", () => {
  const beforeSnapshot = snapshot(ctx);
  const next = applyWeekPoints(ctx, [
    { id: BOWERS, week: 1, pts: 0 },
    { id: GOEDERT, week: 2, pts: 99 },
    { id: "definitely-not-a-player", week: 1, pts: 42 },
  ]);
  assert.equal(snapshot(ctx), beforeSnapshot);
  assert.equal(next.proj.get(BOWERS)[0], 0, "the live current-week reprice lands");
  assert.equal(next.proj.get(BOWERS)[1], ctx.proj.get(BOWERS)[1], "future weeks are not the job's to set");
  assert.equal(next.proj.get(GOEDERT), ctx.proj.get(GOEDERT), "week 2 rows are dropped");
  assert.equal(next.players, ctx.players);
  assert.deepEqual(next.memo, {});
  assert.equal(applyWeekPoints(ctx, []), ctx);
});

test("statusKey and diffStatuses alert on what changed, never on when it was reported", () => {
  assert.equal(statusKey({ inj: "Doubtful", ...KNEE }), "Doubtful|Knee - Meniscus|Surgery");
  assert.equal(statusKey({}), "||");
  assert.equal(statusKey({ inj: "Out", injPart: null, injNotes: "" }), "Out||");

  const prev = { [BOWERS]: statusKey({ inj: null }), [DOWNS]: statusKey({ inj: "Questionable" }) };
  const next = {
    [BOWERS]: statusKey({ inj: "Doubtful", ...KNEE }),
    [DOWNS]: statusKey({ inj: "Questionable" }), // news_updated ticked; nothing to say
    [KRAFT]: statusKey({ inj: "Out" }), // first sighting: seeding a snapshot alerts nothing
  };
  const events = diffStatuses(prev, next);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, BOWERS);
  assert.equal(events[0].kind, "status");
  assert.deepEqual(events[0].before, { inj: null, injPart: null, injNotes: null });
  assert.deepEqual(events[0].after, { inj: "Doubtful", injPart: KNEE.injPart, injNotes: KNEE.injNotes });

  // an id that fell off the watch set is nobody's problem, and notes may contain a pipe
  assert.deepEqual(diffStatuses({ [BOWERS]: "Out||" }, {}), []);
  assert.deepEqual(diffStatuses({}, next), []);
  const piped = diffStatuses({ x: "Out|Knee|a" }, { x: "Out|Knee|a|b" });
  assert.equal(piped[0].after.injNotes, "a|b");
});

test("standingIssues finds the problems that were already there", () => {
  // (a) a status that zeroes a week — the fixture ships two Questionable receivers
  const issues = standingIssues(ctx, MINE);
  const kinds = new Map(issues.map((e) => [e.id, e.kind]));
  assert.equal(kinds.get(DOWNS), "status");
  assert.equal(kinds.get("6801"), "status", "Tee Higgins is Questionable in the fixture");
  for (const issue of issues) {
    assert.equal(issue.before, null);
    assert.ok(issue.after && "inj" in issue.after && "injPart" in issue.after && "injNotes" in issue.after);
  }
  assert.ok(!kinds.has(BOWERS), "a healthy starter is not an issue");

  // (b) a reserve player who no longer qualifies — Sleeper blocks every move until he is activated
  const stashed = build({
    rosters: withRoster(MINE, {
      players: fixture("rosters.json").find((r) => r.roster_id === MINE).players,
      reserve: [GOEDERT],
    }),
  });
  const activate = standingIssues(stashed, MINE).find((e) => e.id === GOEDERT);
  assert.ok(activate, "a healthy player parked on IR is an issue");
  assert.equal(activate.kind, "activate");
  assert.ok(!activePlayers(rosterById(stashed, MINE)).includes(GOEDERT), "…and he is off the active roster");
  // ...and the advice is to activate him, not to wait for an IR window that will never open
  const fix = advise(stashed, { rosterId: MINE, event: activate });
  assert.equal(fix.kind, "activate");
  assert.equal(fix.headline, "Dallas Goedert no longer qualifies for IR");
  assert.equal(fix.moves[0].type, "activate");
  assert.equal(fix.moves[0].add, GOEDERT);
  assert.equal(fix.moves.some((m) => m.type === "ir"), false);
  assert.equal(fix.severity, "med", "a bench player is not an emergency");
  // a legally stashed player is NOT an issue: Boyball allows Out
  const legal = build({
    players: withPlayer(GOEDERT, { inj: "Out" }),
    rosters: withRoster(MINE, { reserve: [GOEDERT] }),
  });
  assert.equal(standingIssues(legal, MINE).some((e) => e.id === GOEDERT), false);

  // (c) a current-week starter on a bye
  const bye = build({ players: withPlayer(OLAVE, { bye: 1 }) });
  const onBye = standingIssues(bye, MINE).find((e) => e.id === OLAVE);
  assert.ok(onBye);
  assert.equal(onBye.kind, "bye");
  assert.deepEqual(standingIssues(ctx, 99), [], "an unknown roster is answered, not thrown at");
});

test("irEligibility says whether the window is open and, if not, when it opens", () => {
  const doubtful = build({ players: withPlayer(BOWERS, { inj: "Doubtful", ...KNEE }) });
  const closed = irEligibility(doubtful, MINE, BOWERS);
  assert.deepEqual(
    { eligibleNow: closed.eligibleNow, slotsFree: closed.slotsFree, opensWhen: closed.opensWhen },
    { eligibleNow: false, slotsFree: 2, opensWhen: "Out" }
  );
  assert.equal(closed.text, "IR opens when his status becomes Out — 2 slots free.");

  const out = irEligibility(build({ players: withPlayer(BOWERS, { inj: "Out", ...KNEE }) }), MINE, BOWERS);
  assert.equal(out.eligibleNow, true);
  assert.equal(out.opensWhen, null);
  assert.equal(out.text, "IR-eligible now — 2 slots free.");

  // slots are counted from the roster's own reserve list
  const oneUsed = build({
    players: withPlayer(BOWERS, { inj: "Out", ...KNEE }),
    rosters: withRoster(MINE, { reserve: [GOEDERT] }),
  });
  assert.equal(irEligibility(oneUsed, MINE, BOWERS).slotsFree, 1);
  assert.equal(irEligibility(oneUsed, MINE, BOWERS).text, "IR-eligible now — 1 slot free.");

  // a league with no reserve slots at all, and one that allows nothing downstream
  const noIr = build({
    league: { ...fixture("league.json"), settings: { ...fixture("league.json").settings, reserve_slots: 0 } },
    players: withPlayer(BOWERS, { inj: "Doubtful", ...KNEE }),
  });
  assert.equal(irEligibility(noIr, MINE, BOWERS).slotsFree, 0);
  assert.equal(irEligibility(noIr, MINE, BOWERS).text, "This league has no IR slots.");
  const strict = build({
    league: { ...fixture("league.json"), settings: { ...fixture("league.json").settings, reserve_allow_out: 0 } },
    players: withPlayer(BOWERS, { inj: "Doubtful", ...KNEE }),
  });
  assert.equal(irEligibility(strict, MINE, BOWERS).opensWhen, "IR", "with Out barred, only true IR opens it");
});

test("SC-007 — Bowers Doubtful: start Goedert, IR opens at Out, nothing on the wire beats him", () => {
  const doubtful = build({ players: withPlayer(BOWERS, { inj: "Doubtful", ...KNEE, newsAt: NEWS_AT }) });
  const beforeSnapshot = snapshot(doubtful);
  const advisory = advise(doubtful, { rosterId: MINE, event: statusEvent(BOWERS, { inj: "Doubtful", ...KNEE }) });
  assert.equal(snapshot(doubtful), beforeSnapshot, "advise() is pure");

  assert.equal(advisory.key, `${BOWERS}:Doubtful|Knee - Meniscus|Surgery`);
  assert.equal(advisory.kind, "status");
  assert.equal(advisory.owner, MINE);
  assert.equal(advisory.pos, "TE");
  assert.equal(advisory.severity, "high", "he was a current-week starter");
  assert.equal(advisory.newsAt, NEWS_AT);
  assert.equal(advisory.url, "#advisor");
  assert.equal(advisory.absence.key, "meniscus");

  // this week: the TE slot is his, it is now worth nothing, and Goedert is the answer
  assert.equal(advisory.thisWeek.started, true);
  assert.equal(advisory.thisWeek.slot, "TE");
  assert.equal(advisory.thisWeek.now, 0);
  assert.ok(advisory.thisWeek.was > 12, "he projected 12.7 before the news");
  assert.equal(advisory.thisWeek.replacement, GOEDERT);
  assert.ok(advisory.thisWeek.lineupDelta < 0, "the news costs points");
  assert.ok(Math.abs(advisory.thisWeek.gain - advisory.thisWeek.replacementPts) < 1e-9);

  // IR is the free move, but not yet: Boyball bars Doubtful
  assert.equal(advisory.ir.eligibleNow, false);
  assert.equal(advisory.ir.opensWhen, "Out");
  assert.equal(advisory.ir.slotsFree, 2);

  // the moves, in the order design §12.0 puts them
  assert.equal(advisory.moves[0].type, "start");
  assert.equal(advisory.moves[0].when, "now");
  assert.deepEqual(advisory.moves.map((m) => m.type), ["start", "ir", "hold"]);
  assert.equal(advisory.moves[1].when, "when status = Out");
  const addsAtTe = advisory.moves.filter(
    (m) => m.type === "add" && m.add && playerOf(doubtful, m.add).pos === "TE" && m.deltaPerWeek > 0.05
  );
  assert.deepEqual(addsAtTe, [], "no free tight end is worth a roster spot here");
  assert.equal(advisory.moves[2].add, JOHNSON, "the hold move still names the best free tight end");
  assert.ok(advisory.moves[2].text.includes("Juwan Johnson"), advisory.moves[2].text);

  // the strings that go on a lock screen (design §12.0's acceptance case, modulo numbers)
  assert.ok(advisory.headline.length <= HEADLINE_MAX, `${advisory.headline.length} chars`);
  assert.equal(advisory.headline, "Brock Bowers → Doubtful (knee - meniscus · surgery)");
  assert.ok(advisory.summary.length <= SUMMARY_MAX, `${advisory.summary.length} chars`);
  assert.ok(advisory.summary.includes("Goedert"), advisory.summary);
  assert.equal(
    advisory.summary,
    "Start Goedert at TE (7.9). IR opens when his status becomes Out — 2 slots free. " +
      "Hold: no free TE beats Goedert (best: Juwan Johnson 7.4/wk)."
  );

  // the alternatives table: same position, best-first, every owner named
  assert.equal(advisory.alternatives.length, 6);
  assert.ok(!advisory.alternatives.some((row) => row.id === BOWERS));
  for (const row of advisory.alternatives) {
    assert.equal(playerOf(doubtful, row.id).pos, "TE");
    assert.ok(row.name && row.owner);
    assert.ok(Number.isFinite(row.thisWeek) && Number.isFinite(row.next4) && Number.isFinite(row.ros));
  }
  for (let i = 1; i < advisory.alternatives.length; i += 1) {
    assert.ok(advisory.alternatives[i - 1].thisWeek >= advisory.alternatives[i].thisWeek);
  }
  const owners = new Set(advisory.alternatives.map((r) => r.owner));
  assert.ok([...owners].every((o) => o === "mine" || o === "free" || o === "waivers" || typeof o === "string"));
});

test("SC-007 — the same news as Out: IR opens, and the freed spot takes the best free agent", () => {
  const out = build({ players: withPlayer(BOWERS, { inj: "Out", ...KNEE, newsAt: NEWS_AT }) });
  const advisory = advise(out, {
    rosterId: MINE,
    event: statusEvent(BOWERS, { inj: "Out", ...KNEE }, { inj: "Doubtful", ...KNEE }),
  });

  assert.equal(advisory.ir.eligibleNow, true);
  assert.equal(advisory.ir.opensWhen, null);
  assert.equal(advisory.ir.slotsFree, 2);
  assert.equal(advisory.severity, "high");
  assert.deepEqual(advisory.before, { inj: "Doubtful", injPart: KNEE.injPart, injNotes: KNEE.injNotes });

  assert.equal(advisory.moves[0].type, "start");
  assert.equal(advisory.thisWeek.replacement, GOEDERT);
  const ir = advisory.moves.find((m) => m.type === "ir");
  assert.ok(ir, "IR is a move now, not a date");
  assert.equal(ir.when, "now");
  assert.equal(ir.drop, BOWERS);
  assert.ok(ir.text.startsWith("Move Bowers to IR"), ir.text);

  const add = advisory.moves.find((m) => m.type === "add");
  assert.ok(add, "the freed bench spot is worth filling");
  assert.equal(add.drop, null, "a spot freed by IR costs no drop");
  assert.ok(add.deltaPerWeek > 0.05);
  assert.ok(add.text.includes("freed spot"), add.text);
  assert.ok(add.why.length >= 2, "the wire's own reasoning rides along");
  assert.ok(advisory.summary.length <= SUMMARY_MAX);
  assert.ok(advisory.headline.length <= HEADLINE_MAX);
});

test("a bye is advice too: the starter is named, the bench is searched", () => {
  const bye = build({ players: withPlayer(OLAVE, { bye: 1 }) });
  const [issue] = standingIssues(bye, MINE).filter((e) => e.kind === "bye");
  const advisory = advise(bye, { rosterId: MINE, event: issue });
  assert.equal(advisory.kind, "bye");
  assert.equal(advisory.headline, "Chris Olave is on bye in week 1");
  assert.equal(advisory.absence.key, "none", "a bye is not an injury");
  assert.equal(advisory.thisWeek.bye, true);
  assert.equal(advisory.moves[0].type, "start");
  assert.ok(advisory.thisWeek.replacement && advisory.thisWeek.replacement !== OLAVE);
  assert.equal(weekPoints(bye, OLAVE, 1), 0);
});

test("a rival's news is graded from my side of the table, and never shouts", () => {
  // his TE starter is out: the hole is real, so the answer is a trade toward that team
  const hurt = { inj: "Out", injPart: "Hamstring", injNotes: "Strain" };
  const rival = build({ players: withPlayer(KRAFT, { ...hurt, newsAt: NEWS_AT }) });
  const advisory = advise(rival, { rosterId: MINE, event: statusEvent(KRAFT, hurt) });
  assert.equal(advisory.owner, 1);
  assert.equal(advisory.severity, "low", "a rival's injury is interesting, not urgent");
  assert.equal(advisory.absence.key, "softTissue");
  assert.equal(advisory.moves.length, 1, "one move, or one note — never a lineup instruction");
  assert.ok(["trade", "note"].includes(advisory.moves[0].type), advisory.moves[0].type);
  assert.equal(advisory.moves[0].type, "trade", "the fixture league does have a deal with roster 1");
  assert.ok(advisory.moves[0].text.startsWith("Trade "), advisory.moves[0].text);
  assert.ok(advisory.summary.length <= SUMMARY_MAX);
  assert.ok(advisory.headline.length <= HEADLINE_MAX);

  // a rival's BENCH player is just news: no hole, no move
  const benched = fixture("rosters.json").find((r) => r.roster_id === 1);
  const spare = benched.players.find((id) => !benched.starters.includes(id));
  const quiet = advise(build({ players: withPlayer(spare, { inj: "Out", injPart: "Ankle", injNotes: null }) }), {
    rosterId: MINE,
    event: statusEvent(spare, { inj: "Out", injPart: "Ankle", injNotes: null }),
  });
  assert.equal(quiet.severity, "low");
  assert.deepEqual(quiet.moves.map((m) => m.type), ["note"]);
  assert.ok(quiet.moves[0].text.endsWith("no move for you."), quiet.moves[0].text);
  assert.ok(quiet.moves[0].text.startsWith("I love black ops II's"), quiet.moves[0].text);

  // a bench player of MINE is worth a card, but a quieter one
  const mineBench = advise(build({ players: withPlayer(GOEDERT, { inj: "Out", injPart: "Ankle", injNotes: null }) }), {
    rosterId: MINE,
    event: statusEvent(GOEDERT, { inj: "Out", injPart: "Ankle", injNotes: null }),
  });
  assert.equal(mineBench.severity, "med");
});

test("adviseAll merges events with standing issues, dedupes on key and sorts by urgency", () => {
  const patched = build({
    players: withPlayer(BOWERS, { inj: "Doubtful", ...KNEE, newsAt: NEWS_AT }),
  });
  const event = statusEvent(BOWERS, { inj: "Doubtful", ...KNEE });
  const mine = adviseAll(patched, { rosterId: MINE, events: [event] });

  const keys = mine.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "an advisory appears once");
  assert.equal(keys.filter((k) => k.startsWith(`${BOWERS}:`)).length, 1, "the event and its standing issue are one card");
  const bowers = mine.find((a) => a.id === BOWERS);
  assert.deepEqual(bowers.before, { inj: null, injPart: null, injNotes: null }, "the real event wins over the synthetic one");
  assert.equal(mine[0].id, BOWERS, "high severity first");
  for (let i = 1; i < mine.length; i += 1) {
    const rank = (a) => ["high", "med", "low"].indexOf(a.severity);
    assert.ok(rank(mine[i - 1]) <= rank(mine[i]), "sorted by severity");
  }
  assert.ok(mine.every((a) => a.owner === MINE), "rivals are opt-in");

  // a rival's event is dropped unless asked for (a bench body, so no trade sweep is needed)
  const rival = fixture("rosters.json").find((r) => r.roster_id === 1);
  const spare = rival.players.find((id) => !rival.starters.includes(id));
  const rivalEvent = statusEvent(spare, { inj: "Out", injPart: "Ankle", injNotes: null });
  const rivalCtx = build({ players: withPlayer(spare, { inj: "Out", injPart: "Ankle", injNotes: null }) });
  assert.equal(adviseAll(rivalCtx, { rosterId: MINE, events: [rivalEvent] }).some((a) => a.id === spare), false);
  const withRivals = adviseAll(rivalCtx, { rosterId: MINE, events: [rivalEvent], includeRivals: true });
  assert.equal(withRivals.some((a) => a.id === spare), true);
  assert.equal(withRivals[withRivals.length - 1].id, spare, "…and it sorts below my own roster");
  assert.deepEqual(adviseAll(build(), { rosterId: 99, events: [] }), [], "an unknown roster has no issues");
});

test("shortName keeps move texts inside a push body", () => {
  assert.equal(shortName("Dallas Goedert"), "Goedert");
  assert.equal(shortName("Brock Bowers", "TE"), "Bowers");
  assert.equal(shortName("Marvin Harrison Jr.", "WR"), "Harrison Jr.");
  assert.equal(shortName("HOU D/ST", "DEF"), "HOU D/ST");
  assert.equal(shortName("Cher"), "Cher");
  assert.equal(shortName(""), "");
});
