// Tradewinds — the season map section (004 design §4, R9 §Q9.5). `seasonSection` is a pure
// `(SeasonMap, opts) -> string`, so the whole section is checked here against a SYNTHETIC map:
// what it leads with, how it degrades when the engine or the schedule is not there, and the two
// things the research told it never to do — rank moves by points per week, or let a weekly
// percentage imply more certainty than σ_margin allows.

import test from "node:test";
import assert from "node:assert/strict";

import {
  seasonSection, weekCard, diagnoseLine, strengthOf, pairUp,
  STRONG, WEAK, ELASTICITY_NOTE,
} from "../src/ui/season.js";

/* ---------------------------------------------------------------- a synthetic SeasonMap */

const card = (week, pWin, over = {}) => ({
  week,
  isPlayoffWeek: week >= 15,
  scheduleIsProvisional: week >= 15,
  me: { mean: 140.2, sd: 28.6, lineup: [], short: [] },
  opp: { rosterId: 4, teamName: `Team ${week}`, mean: 138.0, sd: 28.1, lineup: [], basis: "optimal" },
  margin: 2.2,
  pWin,
  strength: strengthOf(pWin),
  holes: [],
  moves: [],
  ...over,
});

const MAP = {
  weeks: [
    card(8, 0.453, {
      holes: [{ slot: "QB", cause: "injury", playerId: "111", weeks: [8, 9, 10], lossVsTypical: 6.1, coveredBy: "stream" }],
      moves: [
        { kind: "stream", addId: "222", dropId: "333", pointsPerWeek: 4.5, weeksCovered: [8], winEquity: 0.012, titleEquity: 0.0008, cost: { faab: 2 }, why: [] },
        { kind: "season-add", addId: "444", dropId: null, pointsPerWeek: 1.2, weeksCovered: [8, 9, 10, 11, 12], winEquity: 0.031, titleEquity: 0.004, cost: { faab: 24 }, why: [] },
        { kind: "trade", addId: "555", dropId: null, pointsPerWeek: 9.9, weeksCovered: [8], winEquity: 0.004, titleEquity: 0.0001, cost: {}, why: [] },
      ],
    }),
    card(9, 0.467),
    card(12, 0.670),
    card(15, 0.567),
  ],
  summary: {
    expectedWins: { regular: 6.74, total: 8.74, record: "8.7-5.3" },
    playoffOdds: 0.96, firstRoundByeOdds: 0.41, topSeedOdds: 0.22, titleOdds: 0.19,
    weakest: [{ week: 8, pWin: 0.453 }, { week: 9, pWin: 0.467 }],
    strongest: [{ week: 12, pWin: 0.670 }],
    faab: { remaining: 61, plannedByQuarter: null, reservedForPlayoffs: 20 },
    sigmaCalibration: { sigmaTeam: 29.0, ci95: [26.4, 31.9], n: 96, source: "history.json wk1..now", model: "positionCv" },
    objectiveAdvice: "Your berth is 96% safe; play for the bye.",
  },
};

const NAMES = { 111: "Hurt Starter", 222: "Streamer", 333: "Bench Guy", 444: "Season Add", 555: "Trade Target" };
const OPTS = { week: 8, objective: "bye", status: "ready", nameOf: (id) => NAMES[id] || String(id) };

/* ---------------------------------------------------------------- the happy path */

test("the section renders the map, the mark, every week card and the disclosure", () => {
  const html = seasonSection(MAP, OPTS);
  assert.match(html, /<h2>Season map<\/h2>/);
  assert.match(html, /class="mv mv-season"/, "the P5 mark is drawn");
  assert.equal((html.match(/<li class="wcard/g) || []).length, 4, "one card per week");
  assert.match(html, new RegExp(ELASTICITY_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the summary leads with expected wins and the odds, not a weekly percentage", () => {
  const html = seasonSection(MAP, OPTS);
  const sum = html.slice(0, html.indexOf("mv-season"));
  assert.match(sum, /Projected record[\s\S]*8\.7-5\.3/);
  assert.match(sum, /First-round bye/, "the bye objective puts the bye first");
  assert.match(sum, /Your berth is 96% safe/);
  assert.match(html, /Strongest wk 12 \(67%\)\./);
  assert.match(html, /Weakest wk 8 \(45%\), wk 9 \(47%\)\./);
});

test("the title objective reorders the odds it leads with", () => {
  const html = seasonSection(MAP, { ...OPTS, objective: "title" });
  const first = html.indexOf("Title");
  const bye = html.indexOf("First-round bye");
  assert.ok(first > -1 && (bye === -1 || first < bye), "Title comes first when playing for the title");
  assert.match(html, /data-obj="title"[^>]*aria-pressed="true"/);
  assert.match(seasonSection(MAP, OPTS), /data-obj="bye"[^>]*aria-pressed="true"/);
});

/* ---------------------------------------------------------------- the week card */

test("a week card names the opponent, both means and P(win) with its strength class", () => {
  const html = weekCard(MAP.weeks[0], OPTS);
  assert.match(html, /wk 8/);
  assert.match(html, /Team 8/);
  assert.match(html, /μ <b class="num">140\.2<\/b>\s*against <b class="num">138\.0<\/b>/);
  // 0.453 is INSIDE R9's +/-1/4 sigma_margin band, so it is a coin flip and says so — the
  // compression the research warned about, shown rather than dressed up as a bad week.
  assert.match(html, /data-tone="even">45%<\/b>\s*a coin flip/);
  assert.match(weekCard(MAP.weeks[2], OPTS), /data-tone="win">67%<\/b>\s*favoured/);
  assert.match(weekCard(card(11, 0.36), OPTS), /data-tone="loss">36%<\/b>\s*against you/);
});

test("the strength thresholds are R9's measured 0.60 / 0.40, not round numbers", () => {
  assert.equal(STRONG, 0.6);
  assert.equal(WEAK, 0.4);
  assert.equal(strengthOf(0.6), "strong");
  assert.equal(strengthOf(0.599), "even");
  assert.equal(strengthOf(0.4), "weak");
  assert.equal(strengthOf(0.401), "even");
  assert.equal(strengthOf(null), "unknown");
});

test("a hole carries its CAUSE, because a bye and a knee are not the same zero", () => {
  const html = weekCard(MAP.weeks[0], OPTS);
  assert.match(html, /Holes: QB — Hurt Starter injured for 3 weeks/);
  const bye = weekCard(card(6, 0.5, { holes: [{ slot: "TE", cause: "bye", playerId: "111", weeks: [6] }] }), OPTS);
  assert.match(bye, /TE — Hurt Starter on a bye/);
  assert.doesNotMatch(weekCard(MAP.weeks[1], OPTS), /Holes:/, "no holes, no line");
});

test("moves rank by equity and never by points per week (R9 §Q9.5)", () => {
  const html = weekCard(MAP.weeks[0], OPTS);
  const order = [...html.matchAll(/<li><b>([a-z ]+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["season add", "stream", "trade"],
    "+0.031 win equity beats +0.012 beats +0.004, whatever the points say");
  assert.match(html, /9\.9 pts\/wk/, "the trade's big weekly number is still shown — as context");
  assert.match(html, /\+3\.1 pp<\/b> win/, "equity prints in percentage points");
  assert.match(html, /\$24 FAAB/);
  assert.match(html, /covers 5 weeks/);
});

test("the title objective re-ranks the same moves by title equity", () => {
  const html = weekCard(MAP.weeks[0], { ...OPTS, objective: "title" });
  const order = [...html.matchAll(/<li><b>([a-z ]+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["season add", "stream", "trade"]);
  assert.match(html, /pp<\/b> title/);
});

test("a provisional playoff opponent says so on the card", () => {
  assert.match(weekCard(MAP.weeks[3], OPTS), /opponent provisional/);
  assert.match(weekCard(MAP.weeks[3], OPTS), /playoff/);
  assert.doesNotMatch(weekCard(MAP.weeks[0], OPTS), /provisional/);
});

test("the current week is the only one marked as now", () => {
  const html = seasonSection(MAP, OPTS);
  assert.equal((html.match(/wcard-is-now/g) || []).length, 1);
});

/* ---------------------------------------------------------------- degradation */

test("no engine, no schedule, no map — three honest states, never a blank or a guess", () => {
  const loading = seasonSection(null, { status: "loading" });
  assert.match(loading, /Loading the league schedule/);
  assert.match(loading, /role="status"/);

  const err = seasonSection(null, { status: "error", error: "The league schedule could not be loaded, so the season map is unavailable." });
  assert.match(err, /note-warn/);
  assert.match(err, /could not be loaded/);

  const none = seasonSection(null, { status: "unavailable" });
  assert.match(none, /No schedule yet/);
  assert.match(none, /once the league schedule is published/);
  assert.doesNotMatch(none, /mv-season/, "no mark is drawn from nothing");
});

test("the section never throws on a malformed map", () => {
  for (const junk of [undefined, null, {}, { weeks: null }, { weeks: [null, undefined] }, { weeks: [{}] }]) {
    assert.doesNotThrow(() => seasonSection(junk, OPTS), JSON.stringify(junk));
  }
  assert.doesNotThrow(() => seasonSection(MAP, null));
  assert.equal(weekCard(null), "");
});

test("a card with no summary still renders its weeks", () => {
  const html = seasonSection({ weeks: MAP.weeks }, OPTS);
  assert.equal((html.match(/<li class="wcard/g) || []).length, 4);
  assert.doesNotMatch(html, /Projected record/);
});

/* ---------------------------------------------------------------- diagnose */

test("Diagnose states sigma with its sample and its provenance", () => {
  const line = diagnoseLine(MAP.summary);
  assert.match(line, /σ per team 29\.0 pts/);
  assert.match(line, /95 % CI 26\.4–31\.9/);
  assert.match(line, /n 96/);
  assert.match(line, /history\.json wk1\.\.now/);
  assert.match(line, /model positionCv/);
  assert.match(line, /10 percentage points/);
  assert.equal(diagnoseLine(null), "");
  assert.equal(diagnoseLine({}), "");
});

/* ---------------------------------------------------------------- schedule pairing */

test("matchup rows pair into rosterId -> opponentRosterId", () => {
  const rows = [
    { roster_id: 1, matchup_id: 1 }, { roster_id: 3, matchup_id: 1 },
    { roster_id: 2, matchup_id: 2 }, { roster_id: 4, matchup_id: 2 },
  ];
  assert.deepEqual(pairUp(rows), { 1: 3, 3: 1, 2: 4, 4: 2 });
});

test("an unpaired or matchup-less row is absent, never paired with itself", () => {
  assert.deepEqual(pairUp([{ roster_id: 1, matchup_id: 1 }]), null, "a lone row is not a matchup");
  assert.equal(pairUp([{ roster_id: 1, matchup_id: null }, { roster_id: 2, matchup_id: null }]), null);
  assert.deepEqual(
    pairUp([{ roster_id: 1, matchup_id: 1 }, { roster_id: 2, matchup_id: 1 }, { roster_id: 5, matchup_id: 9 }]),
    { 1: 2, 2: 1 },
  );
  assert.equal(pairUp(null), null);
  assert.equal(pairUp([]), null);
  assert.equal(pairUp("nope"), null);
});

test("camelCase rows from a different shim pair too", () => {
  assert.deepEqual(pairUp([{ rosterId: 7, matchupId: 3 }, { rosterId: 8, matchupId: 3 }]), { 7: 8, 8: 7 });
});

/* ---------------------------------------------------------------- injection */

test("a team name from the API cannot inject markup", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = weekCard(card(4, 0.5, { opp: { teamName: evil, mean: 100 } }), OPTS);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
