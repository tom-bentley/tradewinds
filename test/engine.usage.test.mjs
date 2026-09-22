// test/engine.usage.test.mjs — usage shares and trends (004 design §3.2, R10 §1).
//
// The stats payload here is INLINE and hand-built, decoded through the shipped `buildStats` so it
// is exactly the shape `data/stats.json` will arrive in (004 design §2.1). WS-G owns the real
// fixture; nothing in this file depends on it, and nothing here asserts a real 2026 usage number —
// every expectation is an identity that must hold whatever the file says.
//
// The load-bearing assertion is the target-share denominator: `rec_tgt / team targets`, never
// `pass_att`. Sacks, throwaways and scrambles make attempts and targets different populations, and
// R10 §1.1 S2 (team target share, the second-most stable stat tested) is only that stat if the
// denominator is right.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULTS } from "../src/config.js";
import { buildContext } from "../src/engine/context.js";
import { TREND_SLOPE_MIN, olsSlope, usageOf, usageTotals } from "../src/engine/usage.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const DOWNS = "9500"; // WR IND, roster 3 bench
const PIERCE = "8142"; // WR IND — a teammate, so the team RZ denominator is derivable
const BOWERS = "11604"; // TE LV, roster 3
const JEANTY = "12527"; // RB LV

/** design §2.1 key order, verbatim. */
const KEYS = [
  "off_snp",
  "tm_off_snp",
  "gp",
  "rec_tgt",
  "rec",
  "rec_yd",
  "rec_td",
  "rec_rz_tgt",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rush_rz_att",
  "pass_att",
  "pass_yd",
  "pass_td",
  "pass_rz_att",
];

/** {rec_tgt: 9, …} → the projections-v2 `[keyIdx, value, …]` pair list the file ships. */
const line = (row) => {
  if (row == null) return 0;
  const out = [];
  for (const [k, v] of Object.entries(row)) {
    const i = KEYS.indexOf(k);
    assert.ok(i >= 0, `unknown stat key ${k}`);
    out.push(i, v);
  }
  return out;
};

/**
 * @param {object} spec `{ weeks, partial, players: {id: [row|null, …]}, teams: {TM: {wk: {...}}} }`
 */
const statsFile = (spec) => ({
  version: 1,
  generated_at: "2026-09-22T12:00:00Z",
  season: "2026",
  weeks: spec.weeks,
  partial: spec.partial || [],
  keys: KEYS,
  players: Object.fromEntries(Object.entries(spec.players).map(([id, rows]) => [id, rows.map(line)])),
  std: {},
  teams: spec.teams || {},
});

/** A 2026 history block in `buildHistory` shape — `[pts_std, rec]` per week. */
const historyFile = (players, weeks) => ({
  seasons: { 2026: { weeks, players } },
});

let INPUT;
let bare;
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
  bare = buildContext(INPUT, {});
});

const build = (extra = {}, settings = {}) => buildContext({ ...INPUT, ...extra }, settings);

// ---------------------------------------------------------------------------------------------
// the payload every share test reads. IND: Downs's targets climb, the team's total does not, so
// his SHARE climbs. Week 4 is `partial` — the Monday snap counts have not landed (R6 §Q6.2).
// ---------------------------------------------------------------------------------------------
const WEEKS = [1, 2, 3, 4];
const USAGE_SPEC = {
  weeks: WEEKS,
  partial: [4],
  players: {
    [DOWNS]: [
      { off_snp: 30, tm_off_snp: 60, gp: 1, rec_tgt: 3, rec_rz_tgt: 1, rush_att: 0 },
      { off_snp: 39, tm_off_snp: 60, gp: 1, rec_tgt: 6, rec_rz_tgt: 1, rush_att: 1 },
      { off_snp: 48, tm_off_snp: 60, gp: 1, rec_tgt: 9, rec_rz_tgt: 2, rush_att: 0 },
      // week 4 has no tm_off_snp of its own — the team-week snap total is the fallback
      { off_snp: 51, gp: 1, rec_tgt: 12, rec_rz_tgt: 2, rush_att: 0 },
    ],
    [PIERCE]: [
      { off_snp: 45, tm_off_snp: 60, gp: 1, rec_tgt: 7, rec_rz_tgt: 3 },
      { off_snp: 45, tm_off_snp: 60, gp: 1, rec_tgt: 5, rec_rz_tgt: 1 },
      null, // did not play
      { off_snp: 45, gp: 1, rec_tgt: 4, rec_rz_tgt: 2 },
    ],
    // LV ships no red-zone opportunity at all, so his RZ share has no denominator to stand on
    [BOWERS]: [
      { off_snp: 55, tm_off_snp: 62, gp: 1, rec_tgt: 8 },
      { off_snp: 55, tm_off_snp: 62, gp: 1, rec_tgt: 8 },
      { off_snp: 55, tm_off_snp: 62, gp: 1, rec_tgt: 8 },
      { off_snp: 55, tm_off_snp: 62, gp: 1, rec_tgt: 8 },
    ],
    [JEANTY]: [
      { off_snp: 40, tm_off_snp: 62, gp: 1, rush_att: 18, rec_tgt: 2 },
      { off_snp: 40, tm_off_snp: 62, gp: 1, rush_att: 16, rec_tgt: 2 },
      { off_snp: 40, tm_off_snp: 62, gp: 1, rush_att: 20, rec_tgt: 3 },
      { off_snp: 40, tm_off_snp: 62, gp: 1, rush_att: 19, rec_tgt: 2 },
    ],
  },
  teams: {
    // `att` (pass attempts) is deliberately far from `tgt` (targets) in every week
    IND: {
      1: { tgt: 30, snp: 60, att: 44, rush: 24 },
      2: { tgt: 30, snp: 60, att: 41, rush: 22 },
      3: { tgt: 30, snp: 60, att: 47, rush: 25 },
      4: { tgt: 30, snp: 60, att: 40, rush: 23 },
    },
    LV: {
      1: { tgt: 32, snp: 62, att: 38, rush: 26 },
      2: { tgt: 32, snp: 62, att: 35, rush: 27 },
      3: { tgt: 32, snp: 62, att: 40, rush: 25 },
      4: { tgt: 32, snp: 62, att: 36, rush: 28 },
    },
  },
};

let ctx;
before(() => {
  ctx = build({ stats: statsFile(USAGE_SPEC) });
});

// ---------------------------------------------------------------------------------------------
// absence
// ---------------------------------------------------------------------------------------------

test("usageOf returns null when no stats file is loaded, and for a player it does not list", () => {
  assert.equal(bare.stats.size, 0, "the 0.4-era fixture set ships no stats.json");
  assert.equal(usageOf(bare, DOWNS), null);
  assert.equal(usageTotals(bare, DOWNS), null);

  // a loaded file that simply does not carry him is the same answer: no usage, not zero usage
  assert.ok(usageOf(ctx, DOWNS));
  assert.equal(usageOf(ctx, "4046"), null, "Mahomes is not in this payload");

  // and a malformed file collapses to empty, exactly like every other optional input (I10)
  const junk = build({ stats: { version: 9, players: "nope" } });
  assert.equal(junk.stats.size, 0);
  assert.equal(usageOf(junk, DOWNS), null);
});

// ---------------------------------------------------------------------------------------------
// shares
// ---------------------------------------------------------------------------------------------

test("snap share is off_snp / tm_off_snp, falling back to the team-week snap total", () => {
  const u = usageOf(ctx, DOWNS);
  assert.deepEqual(u.weeks, WEEKS);
  assert.deepEqual(u.played, [true, true, true, true]);
  assert.equal(u.playedWeeks, 4);
  assert.ok(Math.abs(u.snapShare[0] - 30 / 60) < 1e-12);
  assert.ok(Math.abs(u.snapShare[2] - 48 / 60) < 1e-12);
  // week 4 carries no tm_off_snp — ctx.teamStats["IND|4"].snp = 60 covers it
  assert.ok(Math.abs(u.snapShare[3] - 51 / 60) < 1e-12);
});

test("target share divides by TEAM TARGETS, never by pass attempts (R10 §1.1 S2)", () => {
  const u = usageOf(ctx, DOWNS);
  for (let i = 0; i < WEEKS.length; i += 1) {
    const tgt = USAGE_SPEC.players[DOWNS][i].rec_tgt;
    const team = USAGE_SPEC.teams.IND[WEEKS[i]];
    assert.ok(Math.abs(u.targetShare[i] - tgt / team.tgt) < 1e-12, `week ${WEEKS[i]}`);
    assert.ok(
      Math.abs(u.targetShare[i] - tgt / team.att) > 1e-6,
      `week ${WEEKS[i]} must not read the pass-attempt denominator`
    );
  }
  // carries divide by the team's rush attempts
  const j = usageOf(ctx, JEANTY);
  assert.ok(Math.abs(j.carryShare[0] - 18 / USAGE_SPEC.teams.LV[1].rush) < 1e-12);
  // and a receiver with no carries reads 0 share, not null — he played, he just never ran
  assert.equal(u.carryShare[0], 0);
});

test("red-zone share is derived over the team's own RZ opportunities, else reported per game", () => {
  const u = usageOf(ctx, DOWNS);
  assert.equal(u.rzBasis, "team");
  // week 1: Downs 1 + Pierce 3 = 4 team RZ opportunities
  assert.ok(Math.abs(u.rzShare[0] - 1 / 4) < 1e-12);
  // week 3: Pierce did not play, so Downs is the whole denominator
  assert.ok(Math.abs(u.rzShare[2] - 1) < 1e-12);
  assert.deepEqual(u.rzPerGame, [1, 1, 2, 2]);

  // LV ships no red-zone opportunity at all: no denominator, so no share — and the raw per-game
  // count is still there to be read
  const b = usageOf(ctx, BOWERS);
  assert.equal(b.rzBasis, "perGame");
  assert.deepEqual(b.rzShare, [null, null, null, null]);
  assert.deepEqual(b.rzPerGame, [0, 0, 0, 0]);
});

test("a week he did not play is null everywhere and is not counted as played", () => {
  const p = usageOf(ctx, PIERCE);
  assert.deepEqual(p.played, [true, true, false, true]);
  assert.equal(p.playedWeeks, 3);
  assert.equal(p.snapShare[2], null);
  assert.equal(p.targetShare[2], null);
  assert.equal(p.rzShare[2], null);
  assert.equal(p.touches[2], null);
  assert.equal(p.xfp[2], null);
  assert.equal(p.gap[2], null);
  assert.equal(p.opportunities, 7 + 5 + 4);
});

// ---------------------------------------------------------------------------------------------
// xFP and the usage gap
// ---------------------------------------------------------------------------------------------

test("xFP uses the DEFAULTS.hidden.xfp weights, with the RZ terms marginal on top", () => {
  const { xfp } = DEFAULTS.hidden;
  // R10 §1.1 S5: the RZ target coefficient is ≈5.7× a plain target
  assert.ok(Math.abs(xfp.rzTgt / xfp.tgt - 5.7) < 0.1, `${xfp.rzTgt}/${xfp.tgt}`);

  const u = usageOf(ctx, DOWNS);
  const w3 = USAGE_SPEC.players[DOWNS][2];
  const expected = xfp.tgt * w3.rec_tgt + xfp.rzTgt * w3.rec_rz_tgt;
  assert.ok(Math.abs(u.xfp[2] - expected) < 1e-12);

  const j = usageOf(ctx, JEANTY);
  const jw = USAGE_SPEC.players[JEANTY][0];
  assert.ok(Math.abs(j.xfp[0] - (xfp.tgt * jw.rec_tgt + xfp.carry * jw.rush_att)) < 1e-12);
});

test("gap is xFP − this season's actual points, in the league's own scoring basis", () => {
  // half-PPR fixture league: historyWeekly gives pts_std + 0.5 × rec
  const withHistory = build({
    stats: statsFile(USAGE_SPEC),
    history: historyFile({ [DOWNS]: { gp: 4, ga: 4, w: [[4, 2], [6, 4], [3, 3], [9, 6]] } }, 4),
  });
  assert.equal(withHistory.league.ppr, 0.5);
  const u = usageOf(withHistory, DOWNS);
  assert.deepEqual(
    u.actual.map((v) => Math.round(v * 100) / 100),
    [5, 8, 4.5, 12]
  );
  for (let i = 0; i < WEEKS.length; i += 1) {
    assert.ok(Math.abs(u.gap[i] - (u.xfp[i] - u.actual[i])) < 1e-12);
  }

  const totals = usageTotals(withHistory, DOWNS);
  assert.equal(totals.playedWeeks, 4);
  assert.equal(totals.gapWeeks, 4);
  assert.equal(totals.opportunities, 3 + 7 + 9 + 12); // targets + carries
  assert.ok(Math.abs(totals.xfpMatched - totals.xfp) < 1e-12, "every played week has an actual here");
  assert.ok(Math.abs(totals.gap - (totals.xfpMatched - totals.actual)) < 1e-12);
  assert.ok(Math.abs(totals.perWeek - totals.gap / 4) < 1e-12);
  // opportunity-weighted, not the mean of weekly shares
  assert.ok(Math.abs(totals.targetShare - 30 / 120) < 1e-12);

  // with no history for him the gap is unknown, never zero
  const u2 = usageOf(ctx, DOWNS);
  assert.deepEqual(u2.actual.slice(1), [null, null, null]);
  assert.deepEqual(u2.gap.slice(1), [null, null, null]);
});

test("the gap is differenced on the MATCHED window only, never across a history lag", () => {
  // stats.json ships a trailing window of completed weeks; history.json is regenerated on its own
  // cadence. When history is a week behind, an xFP summed over 4 weeks against points summed over 2
  // is not a regression signal — it is a lag artefact that reads as a huge buy on everybody at once.
  const lagged = build({
    stats: statsFile(USAGE_SPEC),
    history: historyFile({ [DOWNS]: { gp: 2, ga: 2, w: [[4, 2], [6, 4]] } }, 2),
  });
  const t = usageTotals(lagged, DOWNS);
  assert.equal(t.playedWeeks, 4, "he played all four weeks of the stats window");
  assert.equal(t.gapWeeks, 2, "but only two of them have points on file");
  assert.ok(t.xfpMatched < t.xfp, "the matched xFP is the shorter window");
  assert.ok(Math.abs(t.gap - (t.xfpMatched - t.actual)) < 1e-12);
  assert.ok(Math.abs(t.perWeek - t.gap / 2) < 1e-12, "per-week divides by the weeks it actually compared");

  // and the unmatched window would have produced a materially different, wrong answer
  assert.ok(Math.abs(t.xfp - t.actual - t.gap) > 1e-6);
});

// ---------------------------------------------------------------------------------------------
// trends
// ---------------------------------------------------------------------------------------------

test("olsSlope is a plain least-squares fit and needs two points", () => {
  assert.equal(olsSlope([1], [0.5]), null);
  assert.equal(olsSlope([2, 2, 2], [0.1, 0.2, 0.3]), null, "no spread in x");
  assert.ok(Math.abs(olsSlope([1, 2, 3], [0.1, 0.2, 0.3]) - 0.1) < 1e-12);
  assert.ok(Math.abs(olsSlope([1, 2, 3], [0.3, 0.2, 0.1]) + 0.1) < 1e-12);
});

test("partial weeks are excluded from the trend fit (R6 §Q6.2 Monday lag)", () => {
  // Downs's target share climbs 0.10 → 0.20 → 0.30 → 0.40. Week 4 is partial, so the fit runs on
  // weeks 1–3 only and the slope is exactly 0.10/week whatever week 4 says.
  const u = usageOf(ctx, DOWNS);
  assert.equal(u.trend.tgt.weeks, 3);
  assert.ok(Math.abs(u.trend.tgt.slope - 0.1) < 1e-12);

  // prove it by making the partial week a crash: the fit must not move
  const crashed = JSON.parse(JSON.stringify(USAGE_SPEC));
  crashed.players[DOWNS][3] = { off_snp: 4, gp: 1, rec_tgt: 0 };
  const crashedCtx = build({ stats: statsFile(crashed) });
  const c = usageOf(crashedCtx, DOWNS);
  assert.ok(Math.abs(c.trend.tgt.slope - u.trend.tgt.slope) < 1e-12, "a partial week cannot bend the line");

  // and once the same week is NOT flagged partial it counts, and the line bends
  const counted = JSON.parse(JSON.stringify(crashed));
  counted.partial = [];
  const t = usageOf(build({ stats: statsFile(counted) }), DOWNS);
  assert.equal(t.trend.tgt.weeks, DEFAULTS.hidden.trendWeeks);
  assert.ok(t.trend.tgt.slope < u.trend.tgt.slope, "the crash pulls the slope down");
});

test("a trend is only REAL at 3+ played weeks and a slope over the position's bar", () => {
  const u = usageOf(ctx, DOWNS);
  assert.equal(u.pos, "WR");
  assert.ok(u.trend.tgt.slope >= TREND_SLOPE_MIN.WR);
  assert.equal(u.trend.tgt.real, true);
  assert.equal(u.trend.snap.real, true);

  // flat usage is not a trend however many weeks there are
  const b = usageOf(ctx, BOWERS);
  assert.ok(Math.abs(b.trend.tgt.slope) < 1e-12);
  assert.equal(b.trend.tgt.real, false);

  // two played weeks can never be real, however steep (R10 §1.3: 3–4 games)
  const twoWeeks = {
    weeks: [1, 2],
    partial: [],
    players: { [DOWNS]: [{ off_snp: 10, tm_off_snp: 60, gp: 1, rec_tgt: 1 }, { off_snp: 55, tm_off_snp: 60, gp: 1, rec_tgt: 15 }] },
    teams: { IND: { 1: { tgt: 30, snp: 60, att: 44, rush: 24 }, 2: { tgt: 30, snp: 60, att: 40, rush: 22 } } },
  };
  const short = usageOf(build({ stats: statsFile(twoWeeks) }), DOWNS);
  assert.equal(short.playedWeeks, 2);
  assert.ok(Math.abs(short.trend.tgt.slope) > TREND_SLOPE_MIN.WR, "the slope is enormous");
  assert.equal(short.trend.tgt.real, false, "two weeks is never a trend");
});

// ---------------------------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------------------------

test("usageOf is pure and memoized: same object back, ctx untouched outside memo", () => {
  const fresh = build({ stats: statsFile(USAGE_SPEC) });
  const before = JSON.stringify({
    weeks: fresh.statWeeks,
    keys: fresh.statKeys,
    stats: [...fresh.stats.keys()].sort(),
    teams: [...fresh.teamStats.keys()].sort(),
  });
  const a = usageOf(fresh, DOWNS);
  const b = usageOf(fresh, DOWNS);
  assert.equal(a, b, "memoized on ctx.memo");
  assert.equal(usageOf(fresh, "4046"), null);
  assert.equal(usageOf(fresh, "4046"), null, "a null answer is memoized too");
  const after = JSON.stringify({
    weeks: fresh.statWeeks,
    keys: fresh.statKeys,
    stats: [...fresh.stats.keys()].sort(),
    teams: [...fresh.teamStats.keys()].sort(),
  });
  assert.equal(after, before);
});
