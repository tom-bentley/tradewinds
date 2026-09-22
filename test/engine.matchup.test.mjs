// 004 design §3.4 (WS-H eng-matchup), R8-matchup-science.md — the matchup module's own tests plus
// the skill-position invariance / DST-MAE evidence tests SC-105 asks for.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildContext } from "../src/engine/context.js";
import { weekVector } from "../src/engine/lineup.js";
import {
  oppFactor,
  teamImplied,
  oppImplied,
  streamingFactor,
  matchupGrade,
  matchupFlags,
  calibrationFactor,
} from "../src/engine/matchup.js";
import { DEFAULTS } from "../src/config.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// -------------------------------------------------------------------------------------------
// Fixture-backed contexts (lazy: loaded in before(), never at import time — see
// engine.lineup.test.mjs's note on projections.json/values_full.json being pipeline-regenerated)
// -------------------------------------------------------------------------------------------
let INPUT;
let ctxPlain; // no games.json input at all — schedule-only ctx.games (no odds), matches 0.4.x
let ctxGames; // + test/fixtures/games_sample.json (design §2.2 shape, real week-1 pairings)
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
  ctxPlain = buildContext(INPUT, {});
  ctxGames = buildContext({ ...INPUT, games: fixture("games_sample.json") }, {});
});

// -------------------------------------------------------------------------------------------
// A minimal hand-built ctx for precise, self-contained formula tests. matchup.js only ever reads
// ctx.players / ctx.games / ctx.gameOf / ctx.proj / ctx.week / ctx.lastWeek / ctx.settings /
// ctx.memo (via the real, imported playerOf/gameFor from context.js — nothing here is mocked).
// -------------------------------------------------------------------------------------------
function miniCtx({ id = "P1", pos, team, week: curWeek = 1, lastWeek = 17, game, settings, proj } = {}) {
  const players = new Map([[id, { id, name: id, pos, team, inj: null, bye: null }]]);
  const games = new Map();
  const gameOf = new Map();
  if (game) {
    games.set(game.id, game);
    gameOf.set(`${game.home}|${game.week}`, game.id);
    gameOf.set(`${game.away}|${game.week}`, game.id);
  }
  const projMap = new Map();
  if (proj) projMap.set(id, proj);
  return {
    players,
    games,
    gameOf,
    proj: projMap,
    week: curWeek,
    lastWeek,
    settings: settings || {},
    memo: {},
  };
}

const G = (over) => ({ id: "g1", week: 3, home: "AAA", away: "BBB", spread: -6, total: 44, roof: "outdoors", ...over });

// -------------------------------------------------------------------------------------------
// teamImplied / oppImplied
// -------------------------------------------------------------------------------------------

test("teamImplied/oppImplied: (total - spreadForTeam)/2, home spread sign, symmetric both sides", () => {
  const ctx = miniCtx({ pos: "DEF", team: "AAA", game: G() });
  // home (AAA) favoured by 6: gets the bigger half
  assert.equal(teamImplied(ctx, "AAA", 3), 25); // (44 - (-6)) / 2
  assert.equal(oppImplied(ctx, "AAA", 3), 19); // (44 + (-6)) / 2
  // away (BBB) symmetric: its own implied equals AAA's opponent-implied, and vice versa
  assert.equal(teamImplied(ctx, "BBB", 3), 19);
  assert.equal(oppImplied(ctx, "BBB", 3), 25);
  assert.equal(teamImplied(ctx, "AAA", 3) + teamImplied(ctx, "BBB", 3), 44, "both halves sum to the total");
});

test("teamImplied/oppImplied: null on an unknown team/week or missing lines", () => {
  const ctx = miniCtx({ pos: "DEF", team: "AAA", game: G() });
  assert.equal(teamImplied(ctx, "ZZZ", 3), null, "team not in this game");
  assert.equal(teamImplied(ctx, "AAA", 9), null, "no game that week");
  const noLines = miniCtx({ pos: "DEF", team: "AAA", game: G({ total: undefined, spread: undefined }) });
  assert.equal(teamImplied(noLines, "AAA", 3), null, "game exists but carries no odds");
  assert.equal(oppImplied(noLines, "AAA", 3), null);
});

// -------------------------------------------------------------------------------------------
// streamingFactor
// -------------------------------------------------------------------------------------------

test("streamingFactor: neutral {f:1,z:null,conf:none} for every non-K/DEF position", () => {
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const ctx = miniCtx({ pos, team: "AAA", game: G({ home: "AAA" }) });
    assert.deepEqual(streamingFactor(ctx, "P1", 3), { f: 1, z: null, conf: "none", indoorPts: 0 });
  }
});

test("streamingFactor: neutral when the game is missing, lines are missing, or the model is disabled", () => {
  const noGame = miniCtx({ pos: "DEF", team: "AAA" });
  assert.deepEqual(streamingFactor(noGame, "P1", 3), { f: 1, z: null, conf: "none", indoorPts: 0 });

  const noLines = miniCtx({ pos: "K", team: "AAA", game: G({ total: undefined, spread: undefined }) });
  assert.deepEqual(streamingFactor(noLines, "P1", 3), { f: 1, z: null, conf: "none", indoorPts: 0 });

  const disabled = miniCtx({
    pos: "DEF",
    team: "AAA",
    game: G(),
    settings: { streamingModel: { enabled: false } },
  });
  assert.deepEqual(streamingFactor(disabled, "P1", 3), { f: 1, z: null, conf: "none", indoorPts: 0 });
});

test("DST: f decreases monotonically as the OPPONENT's implied total rises, capped at ±0.40", () => {
  // z_impOpp = (oppImplied-22)/4; f = 1 + clip(-0.30*z, 0.40). Unclipped pair (|z|=1): 0.3 swing.
  const at = (oppImp) => {
    // total/2 fixed at 22 (own also 22) by choosing spread so oppImplied = oppImp exactly:
    // oppImplied = (total+spreadForTeam)/2 with team=AAA home, spreadForTeam=spread => spread = 2*oppImp - total
    const total = 44;
    const spread = 2 * oppImp - total;
    const ctx = miniCtx({ pos: "DEF", team: "AAA", game: G({ total, spread }) });
    return streamingFactor(ctx, "P1", 3);
  };
  const low = at(18); // z=-1 -> f=1.3
  const mid = at(22); // z=0 -> f=1
  const high = at(26); // z=+1 -> f=0.7
  assert.ok(Math.abs(low.f - 1.3) < 1e-9, `${low.f}`);
  assert.equal(mid.f, 1);
  assert.ok(Math.abs(high.f - 0.7) < 1e-9, `${high.f}`);
  assert.ok(low.f > mid.f && mid.f > high.f, "monotone decreasing in opponent implied total");
  assert.equal(mid.conf, "high");
  assert.equal(mid.z.wind, 0, "DST never carries a wind term");

  // cap: z=-3 -> raw 0.9, clipped to 0.40 -> f=1.40 (this is the exact number games_sample.json's
  // HOU/BUF row hits: opp implied 14.5 -> z=-1.875 -> raw 0.5625 -> clipped -> f=1.40)
  assert.ok(Math.abs(at(10).f - 1.4) < 1e-9, "clip caps the low-implied (great matchup) side");
  assert.ok(Math.abs(at(34).f - 0.6) < 1e-9, "clip caps the high-implied (bad matchup) side");
});

test("K: implied-total effect peaks/plateaus at impliedPeak (21-24), not at the top", () => {
  const at = (ownImp, extra) => {
    const total = 44;
    // teamImplied (home) = (total - spread)/2  =>  spread = total - 2*ownImp
    const spread = total - 2 * ownImp;
    const ctx = miniCtx({ pos: "K", team: "AAA", game: G({ total, spread, windMph: 0, ...extra }) });
    return streamingFactor(ctx, "P1", 3);
  };
  const low = at(14); // capped implied 14, z=-2, f = 1+0.06*-2 = 0.88
  const peak = at(22); // z=0, f=1
  const atCap = at(24); // z=0.5, f=1.03
  const aboveCap = at(30); // implied capped to 24 -> IDENTICAL to at(24)
  assert.ok(Math.abs(low.f - 0.88) < 1e-9, `${low.f}`);
  assert.equal(peak.f, 1);
  assert.ok(Math.abs(atCap.f - 1.03) < 1e-9, `${atCap.f}`);
  assert.equal(aboveCap.f, atCap.f, "implied total above impliedPeak plateaus (R8 §4.2)");
  assert.ok(low.f < peak.f, "a cold offence is a worse K matchup than a middling one");
});

test("K: wind term downgrades outdoors, is capped, and is zero indoors", () => {
  const base = { total: 44, spread: 44 - 2 * 22 }; // own implied 22 -> z_impK=0
  const calm = miniCtx({ pos: "K", team: "AAA", game: G({ ...base, windMph: 0 }) });
  const windy = miniCtx({ pos: "K", team: "AAA", game: G({ ...base, windMph: 20 }) });
  const indoor = miniCtx({ pos: "K", team: "AAA", game: G({ ...base, roof: "dome", windMph: 999 }) });

  assert.equal(streamingFactor(calm, "P1", 3).f, 1);
  // windTerm = -(20-10)/10 = -1.0; wWind*windTerm = -0.20 -> clipped to cap 0.15 -> f = 0.85
  assert.ok(Math.abs(streamingFactor(windy, "P1", 3).f - 0.85) < 1e-9);
  assert.equal(streamingFactor(windy, "P1", 3).conf, "high", "known wind is full confidence");
  // indoor ignores windMph entirely (windTerm forced 0) and adds indoorPts, not part of f
  const ind = streamingFactor(indoor, "P1", 3);
  assert.equal(ind.f, 1, "indoor with implied=22 has no implied or wind term left");
  assert.equal(ind.indoorPts, DEFAULTS.streamingModel.k.indoorPts);
  assert.equal(ind.z.indoor, true);
});

test("K: unknown (missing) outdoor wind is treated as 0 but LOWERS confidence to low", () => {
  const base = { total: 44, spread: 44 - 2 * 22 };
  const unknown = miniCtx({ pos: "K", team: "AAA", game: G({ ...base, roof: "outdoors" }) }); // no windMph key
  const r = streamingFactor(unknown, "P1", 3);
  assert.equal(r.f, 1, "treated as calm (0) numerically");
  assert.equal(r.conf, "low", "but we are guessing, so confidence drops");
});

test("K: indoorPts is additive, applied independently of the implied-total term", () => {
  const total = 44;
  const spread = total - 2 * 18; // own implied 18 -> z=-1 -> f = 1 - 0.06 = 0.94
  const ctx = miniCtx({ pos: "K", team: "AAA", game: G({ total, spread, roof: "dome" }) });
  const r = streamingFactor(ctx, "P1", 3);
  assert.ok(Math.abs(r.f - 0.94) < 1e-9, "the implied-total term still applies indoors");
  assert.equal(r.indoorPts, 0.5);
});

test("calibrationFactor: 1 (no-op) while off, the four measured multipliers when on", () => {
  const off = miniCtx({});
  for (const pos of ["QB", "RB", "WR", "TE"]) assert.equal(calibrationFactor(off, pos), 1);
  assert.equal(DEFAULTS.calibration.enabled, false, "ships off");

  const on = miniCtx({ settings: { calibration: { enabled: true } } });
  assert.equal(calibrationFactor(on, "QB"), DEFAULTS.calibration.QB);
  assert.equal(calibrationFactor(on, "RB"), DEFAULTS.calibration.RB);
  assert.equal(calibrationFactor(on, "WR"), DEFAULTS.calibration.WR);
  assert.equal(calibrationFactor(on, "TE"), DEFAULTS.calibration.TE);
  assert.equal(calibrationFactor(on, "K"), 1, "no measured K multiplier");
});

// -------------------------------------------------------------------------------------------
// oppFactor
// -------------------------------------------------------------------------------------------

test("oppFactor: null under 4 non-zero look-ahead weeks, null with no projection at all", () => {
  const threeWeeks = miniCtx({ pos: "WR", week: 15, lastWeek: 17, proj: new Array(17).fill(10) });
  assert.equal(oppFactor(threeWeeks, "P1", 15), null, "only weeks 15-17 are look-ahead here: n=3");

  const noProj = miniCtx({ pos: "WR", week: 1, lastWeek: 8 });
  assert.equal(oppFactor(noProj, "NOPE", 1), null);
});

test("oppFactor: that week's points over the mean of the player's non-zero look-ahead weeks", () => {
  // weeks 1-8 look-ahead (ctx.week=1); week1=20, weeks2-8=10 each (7 weeks). n=8, mean=(20+70)/8=11.25
  const proj = [20, 10, 10, 10, 10, 10, 10, 10];
  const ctx = miniCtx({ pos: "WR", week: 1, lastWeek: 8, proj });
  const r = oppFactor(ctx, "P1", 1);
  assert.equal(r.n, 8);
  assert.ok(Math.abs(r.f - 20 / 11.25) < 1e-9, `${r.f}`);
  // a week held at the population mean is dead on 1 (excluding self would not change this one)
  const r2 = oppFactor(ctx, "P1", 2);
  assert.ok(Math.abs(r2.f - 10 / 11.25) < 1e-9);
});

test("oppFactor: zero weeks (byes/no game) are excluded from both the mean and the >=4 count", () => {
  const proj = [10, 0, 10, 0, 10, 10, 10, 10]; // 6 non-zero weeks, mean=10
  const ctx = miniCtx({ pos: "WR", week: 1, lastWeek: 8, proj });
  const r = oppFactor(ctx, "P1", 1);
  assert.equal(r.n, 6);
  assert.equal(r.f, 1);
});

// -------------------------------------------------------------------------------------------
// matchupFlags
// -------------------------------------------------------------------------------------------

test("matchupFlags: K downgrade + WR flag at wind >= windFlagMph outdoors; RB is never flagged", () => {
  const windy = G({ windMph: 15, roof: "outdoors" });
  const kFlags = matchupFlags(miniCtx({ pos: "K", team: "AAA", game: windy }), "P1", 3);
  assert.ok(kFlags.some((f) => f.code === "wind_k_downgrade"));
  const wrFlags = matchupFlags(miniCtx({ pos: "WR", team: "AAA", game: windy }), "P1", 3);
  assert.ok(wrFlags.some((f) => f.code === "wind_wr"));
  const rbFlags = matchupFlags(miniCtx({ pos: "RB", team: "AAA", game: windy }), "P1", 3);
  assert.deepEqual(rbFlags, [], "R8 §5.5: RB's wind effect is positive/ns, never flagged");
});

test("matchupFlags: below threshold => no wind flags; indoor => K bonus flag only", () => {
  const calm = G({ windMph: 14.9, roof: "outdoors" });
  assert.deepEqual(matchupFlags(miniCtx({ pos: "K", team: "AAA", game: calm }), "P1", 3), []);
  assert.deepEqual(matchupFlags(miniCtx({ pos: "WR", team: "AAA", game: calm }), "P1", 3), []);

  const dome = G({ roof: "dome" });
  const kDome = matchupFlags(miniCtx({ pos: "K", team: "AAA", game: dome }), "P1", 3);
  assert.equal(kDome.length, 1);
  assert.equal(kDome[0].code, "indoor_k_bonus");
});

test("matchupFlags: [] with no game", () => {
  assert.deepEqual(matchupFlags(miniCtx({ pos: "K", team: "AAA" }), "P1", 3), []);
  assert.deepEqual(matchupFlags(miniCtx({ pos: "QB", team: "AAA", game: G() }), "P1", 3), []);
});

// -------------------------------------------------------------------------------------------
// matchupGrade
// -------------------------------------------------------------------------------------------

test("matchupGrade DST: all 5 measured buckets, high confidence, adjusted true", () => {
  const grade = (oppImp) => {
    const total = 44;
    const spread = 2 * oppImp - total;
    const ctx = miniCtx({ pos: "DEF", team: "AAA", game: G({ total, spread }) });
    return matchupGrade(ctx, "P1", 3);
  };
  // <18, 18-21, 21-24, 24-27, 27+ -> bins 5,4,3,2,1 (R8 §4.1: best matchup = lowest opp implied)
  assert.equal(grade(10).bin, 5);
  assert.equal(grade(19).bin, 4);
  assert.equal(grade(22).bin, 3);
  assert.equal(grade(25).bin, 2);
  assert.equal(grade(29).bin, 1);
  const g = grade(10);
  assert.equal(g.conf, "high");
  assert.equal(g.adjusted, true);
  assert.ok(g.why.length > 0);
});

test("matchupGrade K: buckets ranked by measured points (peaks at 21-24), wind downgrades one bin", () => {
  const grade = (ownImp, extra) => {
    const total = 44;
    // teamImplied (home) = (total - spread)/2  =>  spread = total - 2*ownImp
    const spread = total - 2 * ownImp;
    const ctx = miniCtx({ pos: "K", team: "AAA", game: G({ total, spread, ...extra }) });
    return matchupGrade(ctx, "P1", 3);
  };
  assert.equal(grade(10, { windMph: 0 }).bin, 1, "<18 is the worst K bucket by measured points");
  assert.equal(grade(19, { windMph: 0 }).bin, 2);
  assert.equal(grade(22, { windMph: 0 }).bin, 5, "21-24 is the peak bucket");
  assert.equal(grade(25, { windMph: 0 }).bin, 3);
  assert.equal(grade(29, { windMph: 0 }).bin, 4);

  const calm = grade(22, { windMph: 0 });
  const windy = grade(22, { windMph: 20 });
  assert.equal(calm.bin, 5);
  assert.equal(windy.bin, 4, "wind >= windFlagMph downgrades the K grade by one bin");
  assert.ok(windy.why.some((w) => /[Ww]ind/.test(w)));
});

test("matchupGrade: neutral bin 3 / conf low / adjusted false when K or DEF has no game odds", () => {
  const ctx = miniCtx({ pos: "DEF", team: "AAA" });
  const g = matchupGrade(ctx, "P1", 3);
  assert.equal(g.bin, 3);
  assert.equal(g.conf, "low");
  assert.equal(g.adjusted, false);
});

test("matchupGrade skill positions: conf low, adjusted false always, and carries the exact priced-in copy", () => {
  const proj = [20, 10, 10, 10, 10, 10, 10, 10];
  const ctx = miniCtx({ pos: "WR", week: 1, lastWeek: 8, proj });
  const g = matchupGrade(ctx, "P1", 1);
  assert.equal(g.conf, "low");
  assert.equal(g.adjusted, false);
  assert.ok(
    g.why.includes("already priced in — matchup context moves scoring by under 1 %"),
    "the exact R8 §5.5 confidence line must be present",
  );
});

test("matchupGrade skill positions: bin from oppFactor quintiles (R8 §2.3 position SD), 3 when unknown", () => {
  // WR SD = 0.0671. A big week (f well above 1) should out-rank a flat week (f=1).
  const hot = miniCtx({ pos: "WR", week: 1, lastWeek: 8, proj: [20, 10, 10, 10, 10, 10, 10, 10] });
  const flat = miniCtx({ pos: "WR", week: 1, lastWeek: 8, proj: [10, 10, 10, 10, 10, 10, 10, 10] });
  assert.ok(matchupGrade(hot, "P1", 1).bin > matchupGrade(flat, "P1", 1).bin);
  assert.equal(matchupGrade(flat, "P1", 1).bin, 3, "f=1 (z=0) lands in the middle quintile");

  const tooFewWeeks = miniCtx({ pos: "WR", week: 15, lastWeek: 17, proj: new Array(17).fill(10) });
  assert.equal(matchupGrade(tooFewWeeks, "P1", 15).bin, 3, "unknown -> neutral, not a guess");
});

// -------------------------------------------------------------------------------------------
// Integration: the lineup.js hook, on real fixtures (SC-105 / design §3.4)
// -------------------------------------------------------------------------------------------

test("skill-position invariance: weekVector is byte-identical with and without ctx.games (R8 §5.4)", () => {
  let checked = 0;
  for (const [id, row] of ctxGames.players) {
    if (!["QB", "RB", "WR", "TE"].includes(row.pos)) continue;
    if (!ctxGames.proj.has(id)) continue;
    const withGames = JSON.stringify(Array.from(weekVector(ctxGames, id)));
    const withoutGames = JSON.stringify(Array.from(weekVector(ctxPlain, id)));
    assert.equal(withGames, withoutGames, `${id} (${row.pos}) differs when ctx.games carries odds`);
    checked += 1;
  }
  assert.ok(checked > 100, `expected a real population of skill players, got ${checked}`);
});

test("K/DEF weekVector actually changes once ctx.games carries real odds (positive control)", () => {
  // HOU (DEF) vs BUF, games_sample.json: total 38, spread -9 => opponent (BUF) implied 14.5,
  // z=-1.875, clipped to the +0.40 cap => f = 1.40 exactly.
  const houPlain = weekVector(ctxPlain, "HOU")[1];
  const houGames = weekVector(ctxGames, "HOU")[1];
  assert.ok(Math.abs(houGames - houPlain * 1.4) < 1e-6, `${houGames} vs ${houPlain}*1.4`);
  assert.notEqual(houGames, houPlain);

  // BAL (K, away @ IND), games_sample.json: total 45, spread -3 (IND favoured) => BAL implied 21,
  // z=-0.25, f = 1 + 0.06*-0.25 = 0.985; roof "closed" with no explicit `indoor` derives indoor
  // true => +0.5 indoorPts.
  const balPlain = weekVector(ctxPlain, "12711")[1];
  const balGames = weekVector(ctxGames, "12711")[1];
  assert.ok(Math.abs(balGames - (balPlain * 0.985 + 0.5)) < 1e-6, `${balGames} vs ${balPlain}*0.985+0.5`);
});

test("DST MAE: a Vegas-only implied-total rule beats Sleeper's own DST projection (R8 §4.1, SC-105)", () => {
  const sample = fixture("dst_2025_sample.json");
  const rows = sample.rows; // [team,week,opp,oppImplied,ownImplied,spread,total,indoor01,windMph,actual,sleeperProj]
  assert.ok(rows.length > 400, `expected the full 2025 DST season, got n=${rows.length}`);
  assert.equal(sample._provenance.season, "2025");

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const acts = rows.map((r) => r[9]);
  const imps = rows.map((r) => r[3]);
  const projs = rows.map((r) => r[10]);
  const mx = mean(imps);
  const my = mean(acts);
  const sxx = imps.reduce((a, x) => a + (x - mx) ** 2, 0);
  const b = imps.reduce((a, x, i) => a + (x - mx) * (acts[i] - my), 0) / sxx;
  const maeVegas = mean(acts.map((a, i) => Math.abs(a - (my + b * (imps[i] - mx)))));
  const maeSleeper = mean(acts.map((a, i) => Math.abs(a - projs[i])));

  // The sample carries only half-PPR actual/projected points (no raw sack/turnover/points-allowed
  // components), so per the brief's documented fallback this is asserted AS-IS, default-scored,
  // not re-scored under Boyball's scoring_settings (see fixture _provenance.scoring).
  assert.ok(
    maeVegas <= maeSleeper,
    `Vegas-rule MAE ${maeVegas.toFixed(3)} should be <= Sleeper projection MAE ${maeSleeper.toFixed(3)}`,
  );
  // Reproduces R8 §4.1's own cited figures exactly on this full-season (weeks 1-18) window.
  assert.ok(Math.abs(maeVegas - 4.577) < 0.01, `${maeVegas}`);
  assert.ok(Math.abs(maeSleeper - 4.629) < 0.01, `${maeSleeper}`);
});

test("streamingModel.enabled=false at the ctx level turns the hook off end to end", () => {
  const off = buildContext({ ...INPUT, games: fixture("games_sample.json") }, { streamingModel: { enabled: false } });
  const houOff = weekVector(off, "HOU")[1];
  const houPlain = weekVector(ctxPlain, "HOU")[1];
  assert.ok(Math.abs(houOff - houPlain) < 1e-9, "no odds-driven adjustment once disabled");
});
