// Trades between ANY two teams, explained in the right voice (design.md §10.3): second person for
// the user's own deals, both teams named for everybody else's — plus the league-wide sweep.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildContext, rosterById } from "../src/engine/context.js";
import { evaluateTrade, finalizeExplanation } from "../src/engine/trade.js";
import { explain, flagText, sideNames } from "../src/engine/explain.js";
import { findLeagueTrades, tradePool } from "../src/engine/finder.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** Anything that would give away that the reader is one of the two teams. */
const SECOND_PERSON = /\b(you|your|yours|we|us|our|ours|they|their|them)\b/i;
/** The whole-league sweep runs eight findTrades passes; on a phone that must still feel instant. */
const LEAGUE_BUDGET_MS = 6000;

// Fixtures load lazily inside a before() hook, never at import time: the pipeline regenerates
// projections.json and values_full.json while these tests run.
const TOMMY = "1394551386997272576";
let INPUT;
let ctx;
let A; // hobbezilla — a team that is not me
let B; // speckledorf — the other side
before(() => {
  INPUT = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values_full.json"),
    schedule: fixture("schedule.json"),
    state: fixture("state.json"),
  };
  ctx = buildContext(INPUT, { userId: TOMMY });
  A = ctx.rosters.find((r) => r.displayName === "hobbezilla").rosterId;
  B = ctx.rosters.find((r) => r.displayName === "speckledorf").rosterId;
});

/** A real 2-for-1 between two rosters, built from the best pieces each actually holds. */
function twoForOne(aRosterId, bRosterId) {
  return { give: tradePool(ctx, aRosterId).slice(0, 2), get: tradePool(ctx, bRosterId).slice(0, 1) };
}

/** Every rendered string in a result. */
function allText(result) {
  return [result.verdict.label, result.headline, ...result.reasons.map((r) => r.text), ...result.flags.map((f) => f.text)]
    .filter(Boolean)
    .join("\n");
}

test("sideNames speaks second person for my own trades and names both teams otherwise", () => {
  assert.equal(ctx.myRosterId, 3);
  assert.deepEqual(sideNames(ctx, 3, B), { a: "You", aPoss: "Your", b: "speckledorf", first: true });
  assert.deepEqual(sideNames(ctx, A, B), {
    a: "hobbezilla",
    aPoss: "hobbezilla's",
    b: "speckledorf",
    first: false,
  });
  // side B is named even when side A is me, and an unknown roster still reads as a sentence
  assert.equal(sideNames(ctx, 3, 999).b, "the other team");
  assert.equal(sideNames(ctx, 999, B).a, "Team A");
});

test("a trade between two other teams is explained without a second person anywhere", () => {
  const { give, get } = twoForOne(A, B);
  assert.ok(give.length === 2 && get.length === 1, "the fixture rosters have tradeable depth");
  const names = sideNames(ctx, A, B);
  const result = evaluateTrade(ctx, { myRosterId: A, theirRosterId: B, give, get }, { names });

  assert.notEqual(result.verdict.code, "invalid");
  const text = allText(result);
  const leak = text.split("\n").filter((line) => SECOND_PERSON.test(line));
  assert.deepEqual(leak, [], "third-person copy must not address the reader");
  assert.ok(text.includes("hobbezilla"), "side A is named");
  assert.ok(text.includes("speckledorf"), "side B is named");

  const kinds = result.reasons.map((r) => r.kind);
  for (const kind of ["headline", "best", "consol", "lineup", "rival"]) {
    assert.ok(kinds.includes(kind), `${kind} line renders in third person too`);
  }
  const headline = result.reasons[0].text;
  assert.ok(
    /hobbezilla (wins|loses) by [\d.]+% on value|even on value/.test(headline),
    `verb agreement in the headline: ${headline}`
  );
  assert.ok(/hobbezilla's starters (gain|lose)/.test(result.reasons.find((r) => r.kind === "lineup").text));
  assert.ok(result.reasons.find((r) => r.kind === "rival").text.startsWith("speckledorf "), "the rival line names side B");
});

test("the same trade for my own team keeps the second-person copy", () => {
  const { give, get } = twoForOne(3, B);
  const result = evaluateTrade(ctx, { myRosterId: 3, theirRosterId: B, give, get });
  const text = allText(result);
  assert.ok(/\byou\b/i.test(text) || /\byour\b/i.test(text), "my own deals still speak to me");
  assert.ok(!text.includes("tommyteez"), "I am 'you', never my own handle");
  assert.ok(result.reasons.find((r) => r.kind === "lineup").text.startsWith("Your starters "));
  assert.ok(result.reasons.find((r) => r.kind === "rival").text.startsWith("speckledorf "));
  const headline = result.reasons[0].text;
  assert.ok(/you (win|lose) by [\d.]+% on value|even on value/.test(headline), headline);
});

test("verdict labels and flags follow the voice, and re-render for a later reader", () => {
  const { give, get } = twoForOne(A, B);
  const names = sideNames(ctx, A, B);
  // the finder scores with no voice in mind…
  const result = evaluateTrade(ctx, { myRosterId: A, theirRosterId: B, give, get }, { withExplain: false });
  assert.ok(result.verdict.labelParts, "the label keeps its ingredients");
  // …and the label is re-rendered when the deal is finally shown to somebody
  finalizeExplanation(ctx, result, names);
  assert.ok(!SECOND_PERSON.test(result.verdict.label), `label still addresses a reader: ${result.verdict.label}`);
  assert.ok(result.headline.startsWith(result.verdict.label));

  // flags speak the same language
  const third = { names };
  assert.equal(
    flagText(ctx, { type: "short", side: "me", slot: "RB", week: 4 }, names),
    "Invalid — leaves hobbezilla short at RB in week 4."
  );
  assert.equal(
    flagText(ctx, { type: "short", side: "them", slot: "RB", week: 4 }, names),
    "Invalid — leaves speckledorf short at RB in week 4."
  );
  assert.equal(flagText(ctx, { type: "short", side: "me", slot: "RB", week: 4 }), "Invalid — leaves you short at RB in week 4.");
  assert.match(flagText(ctx, { type: "unsettled", side: "me" }, names), /^Prices unsettled on hobbezilla's side/);
  assert.match(flagText(ctx, { type: "unsettled", side: "them" }), /^Prices unsettled on their side/);
  assert.match(
    flagText(ctx, { type: "roster_size", side: "them", count: 18, max: 17, drop: give[0] }, names),
    /^speckledorf must drop .+ — speckledorf's roster would hold 18 of 17\.$/
  );
  assert.match(
    flagText(ctx, { type: "roster_size", side: "me", count: 18, max: 17, drop: give[0] }),
    /^Requires dropping .+ — your roster would hold 18 of 17\.$/
  );
  assert.ok(third.names.first === false);
});

test("a veto-worthy trade names the review rule the league actually uses", () => {
  const give = tradePool(ctx, A).slice(-1); // the cheapest thing hobbezilla can trade
  const get = tradePool(ctx, B).slice(0, 1); // for the best thing speckledorf holds
  const names = sideNames(ctx, A, B);
  const lopsided = evaluateTrade(ctx, { myRosterId: A, theirRosterId: B, give, get }, { names });
  assert.ok(lopsided.verdict.veto, "give a scrub, get a star: that is a veto");
  const veto = lopsided.reasons.find((r) => r.kind === "veto");
  assert.match(veto.text, /^Lopsided — 5 of 8 owners can veto within 24 hours\.$/);

  // a league with no veto vote says so instead of printing "0 of 8 owners"
  const league = JSON.parse(JSON.stringify(INPUT.league));
  league.settings.veto_votes_needed = 0;
  const commish = buildContext({ ...INPUT, league }, { userId: TOMMY });
  const same = evaluateTrade(commish, { myRosterId: A, theirRosterId: B, give, get }, { names });
  const commishVeto = same.reasons.find((r) => r.kind === "veto");
  assert.match(commishVeto.text, /commissioner review/);
  assert.ok(!/\b0 of\b/.test(commishVeto.text), "no vote count when there is no vote");
});

test("evaluateTrade never reads ctx.myRosterId behind the caller's back", () => {
  const { give, get } = twoForOne(A, B);
  const mine = evaluateTrade(ctx, { myRosterId: A, theirRosterId: B, give, get }, { withExplain: false });
  const viewer = buildContext(INPUT, {}); // nobody's league
  const asViewer = evaluateTrade(viewer, { myRosterId: A, theirRosterId: B, give, get }, { withExplain: false });
  const other = buildContext(INPUT, { userId: "1395453350245306368" }); // speckledorf reading it
  const asRival = evaluateTrade(other, { myRosterId: A, theirRosterId: B, give, get }, { withExplain: false });
  for (const [label, run] of [["viewer", asViewer], ["rival", asRival]]) {
    assert.equal(run.verdict.code, mine.verdict.code, `${label}: same verdict`);
    assert.equal(run.verdict.edgePct.toFixed(6), mine.verdict.edgePct.toFixed(6), `${label}: same edge`);
    assert.equal(run.verdict.deltaPerWeek.toFixed(6), mine.verdict.deltaPerWeek.toFixed(6), `${label}: same ΔL_pw`);
    assert.equal(run.them.edgePct.toFixed(6), mine.them.edgePct.toFixed(6), `${label}: same rival edge`);
  }
  // "me" in the result shape means side A, whoever that is
  assert.equal(mine.myRosterId, A);
  assert.deepEqual(mine.give, give);
});

test("explain takes its voice from the caller, not from the result", () => {
  const { give, get } = twoForOne(A, B);
  const result = evaluateTrade(ctx, { myRosterId: A, theirRosterId: B, give, get }, { withExplain: false });
  const second = explain(ctx, result);
  const third = explain(ctx, result, { names: sideNames(ctx, A, B) });
  assert.ok(SECOND_PERSON.test(second.lines.map((l) => l.text).join("\n")), "the default voice is second person");
  assert.ok(!SECOND_PERSON.test(third.lines.map((l) => l.text).join("\n")));
  assert.equal(second.lines.length, third.lines.length, "same lines, different pronouns");
  // partial overrides fill in from the default
  const custom = explain(ctx, result, { names: { a: "Alpha", b: "Beta", first: false } });
  const text = custom.lines.map((l) => l.text).join("\n");
  assert.ok(text.includes("Alpha") && text.includes("Beta"));
  assert.ok(text.includes("Alpha's starters"), "the possessive is derived when it is not passed");
});

test("findLeagueTrades sweeps every team, tags, dedupes and ranks inside budget", () => {
  const seen = [];
  const started = process.hrtime.bigint();
  const deals = findLeagueTrades(ctx, {
    perTeam: 3,
    maxResults: 20,
    onTeam: (rosterId, index, total) => seen.push([rosterId, index, total]),
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < LEAGUE_BUDGET_MS, `league sweep took ${elapsed.toFixed(0)} ms`);

  assert.equal(seen.length, ctx.rosters.length, "onTeam fires once per team, before its sweep");
  seen.forEach(([rosterId, index, total], i) => {
    assert.equal(index, i);
    assert.equal(total, ctx.rosters.length);
    assert.equal(rosterId, ctx.rosters[i].rosterId);
  });

  assert.ok(deals.length > 0 && deals.length <= 20);
  const perTeam = new Map();
  const keys = new Set();
  for (const deal of deals) {
    assert.ok(deal.forRosterId != null, "every candidate names the team it is for");
    assert.notEqual(deal.forRosterId, deal.theirRosterId);
    assert.ok(rosterById(ctx, deal.forRosterId), "…and it is a real roster");
    perTeam.set(deal.forRosterId, (perTeam.get(deal.forRosterId) || 0) + 1);
    const mine = `${deal.forRosterId}:${[...deal.give].sort().join(",")}`;
    const theirs = `${deal.theirRosterId}:${[...deal.get].sort().join(",")}`;
    const key = mine < theirs ? `${mine}|${theirs}` : `${theirs}|${mine}`;
    assert.ok(!keys.has(key), "the same swap must not appear from both sides");
    keys.add(key);
  }
  for (const [rosterId, count] of perTeam) assert.ok(count <= 3, `roster ${rosterId} kept ${count} offers`);
  assert.ok(perTeam.size > 1, "the sweep covers more than one team");
  for (let i = 1; i < deals.length; i += 1) assert.ok(deals[i - 1].score >= deals[i].score, "ranked by score");

  // each candidate is explained in the voice of the team it is for
  for (const deal of deals) {
    const text = deal.why.join("\n");
    if (deal.forRosterId === ctx.myRosterId) {
      assert.ok(/\byou\b|\byour\b/i.test(text), "my own offers speak to me");
    } else {
      const owner = rosterById(ctx, deal.forRosterId).displayName;
      assert.ok(!SECOND_PERSON.test(text), `offer for ${owner} addresses a reader: ${text}`);
      assert.ok(text.includes(owner), `offer for ${owner} names him`);
    }
  }
});

test("findLeagueTrades honours maxResults and works in viewer mode", () => {
  const viewer = buildContext(INPUT, {});
  const deals = findLeagueTrades(viewer, { perTeam: 2, maxResults: 5 });
  assert.ok(deals.length <= 5);
  for (const deal of deals) {
    assert.ok(deal.forRosterId != null);
    assert.ok(!SECOND_PERSON.test(deal.why.join("\n")), "nobody is 'you' in viewer mode");
  }
});
