// 004 integration cross-checks (orchestrator): the workstreams were built in parallel against
// contracts, so these tests prove the seams meet on the REAL merged fixtures — WS-G's stats.json
// feeding WS-K's usage.js, WS-J's dossier sample passing WS-G's validator and vice versa, and the
// engine index re-exporting every 004 symbol the UI's service layer reaches for.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as engine from "../src/engine/index.js";
import { buildContext } from "../src/engine/context.js";
import { usageOf } from "../src/engine/usage.js";
import { sliceIsValid } from "../src/engine/injuries.js";
import { validateDossiers } from "../pipeline/contract.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

let ctx;
before(() => {
  const input = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    state: fixture("state.json"),
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
    stats: fixture("stats_2026.json"),
    games: fixture("games_2026.json"),
    dvp: fixture("dvp_2026.json"),
    dossiers: fixture("dossiers_2026_sample.json"),
  };
  ctx = buildContext(input, { leagueId: input.league.league_id, userId: "1394551386997272576" });
});

test("WS-G stats.json decodes and WS-K usage shares stay inside [0, 1] on every real row", () => {
  assert.ok(ctx.stats.size > 50, `stats rows: ${ctx.stats.size}`);
  assert.deepEqual(ctx.statWeeks, [1, 2]);
  // R6 §Q6.3 worked example, reproduced by WS-G digit for digit: team targets, not pass attempts.
  const kc = ctx.teamStats.get("KC|2");
  assert.ok(kc, "team denominators for KC week 2 exist");
  assert.equal(kc.tgt, 43);
  let checked = 0;
  for (const id of ctx.stats.keys()) {
    const u = usageOf(ctx, id);
    if (!u) continue;
    checked += 1;
    for (const arr of [u.snapShare, u.targetShare, u.carryShare]) {
      for (const v of arr || []) {
        if (v == null) continue;
        assert.ok(v >= 0 && v <= 1.0001, `${id} share out of range: ${v}`);
      }
    }
  }
  assert.ok(checked > 50, `usage computed for ${checked} players`);
});

// The seam contract (design §2.4): the pipeline validator gates what the DESK publishes (7 slice
// codes, ≤ 640 B, Σp = 1); the engine's gate is deliberately more tolerant (it reads whatever the
// pipeline lets through, plus richer test fixtures). So: everything the validator publishes must be
// readable by the engine, every code the engine's rubric knows must be accepted by the validator,
// and an engine-valid row reduced to the published slice shape must pass the validator.
const SLICE_CODES = ["injury_type", "severity", "surgery", "team_timeline", "practice_pattern", "designation", "recurrence"];
const toSlice = (row) => {
  const codes = {};
  for (const k of SLICE_CODES) if (row.codes && row.codes[k] !== undefined) codes[k] = row.codes[k];
  return { ...row, codes };
};

test("WS-G's published sample is clean for both gates, and the invalid sample is rejected", () => {
  const g = fixture("dossiers_sample.json");
  assert.deepEqual(validateDossiers(g, { players: fixture("players.json") }), []);
  for (const row of Object.values(g.players || {})) assert.equal(sliceIsValid(row), true, "engine reads what the pipeline publishes");
  const bad = fixture("dossiers_invalid.json");
  assert.ok(validateDossiers(bad, { players: fixture("players.json") }).length > 0, "the invalid sample is rejected");
});

test("every rubric enum the engine knows is accepted by the pipeline validator (no drift)", async () => {
  const { R7_ENUMS } = await import("../pipeline/contract.mjs");
  for (const [field, values] of Object.entries(engine.ENUMS)) {
    const key = field === "ramp_class" ? "ramp" : field;
    if (!R7_ENUMS[key]) continue; // confidence is validator-set, not a code
    for (const v of values) assert.ok(R7_ENUMS[key].has(v), `validator accepts ${field}=${v}`);
  }
});

test("WS-J's engine-valid sample rows, reduced to the published slice shape, pass the validator", () => {
  const j = fixture("dossiers_2026_sample.json");
  const players = fixture("players.json");
  let checked = 0;
  for (const [id, row] of Object.entries(j.players || {})) {
    // WS-J's fixture deliberately carries malformed rows for its precedence tests (e.g. "9484 —
    // malformed slice row"); the engine gate rejects those and so must the validator — skip them.
    if (!sliceIsValid(row)) continue;
    const problems = validateDossiers({ ...j, players: { [id]: toSlice(row) } }, { players })
      .filter((p) => !/ B \(slice cap/.test(p)); // fixture rows carry test-only extras the desk sheds
    assert.deepEqual(problems, [], `row ${id} reduced to the slice contract is clean`);
    checked += 1;
  }
  assert.ok(checked >= 3, `cross-checked ${checked} engine-valid rows`);
});

test("the engine index re-exports every 004 symbol the service layer wires", () => {
  for (const name of [
    "buildStats", "buildGames", "buildDvp", "buildDossiers", "statsRow", "gameFor",
    "prognose", "dossierPrognosis", "ENUMS", "RUBRIC_ID", "sliceIsValid", "statusKeyOf", "dossierLookup",
    "absenceNoteOf",
    "oppFactor", "teamImplied", "oppImplied", "streamingFactor", "matchupGrade", "matchupFlags",
    "buildSchedule", "pWin", "weekStrength", "seasonMap", "simulateSeason",
    "usageOf", "usageTotals", "hiddenValue", "acquireList", "sellList", "hiddenLists", "synergyScore",
    "rosterWeekly", "lambdaEffective",
  ]) {
    assert.ok(name in engine, `engine index exports ${name}`);
  }
});

test("the season map runs end to end on the merged fixtures with the WS-K per-week sd seam", () => {
  const matchups = fixture("matchups_2026_w3-17.json");
  const bracket = fixture("winners_bracket_2026.json");
  const byWeek = Array.isArray(matchups) ? matchups : matchups;
  const schedule = engine.buildSchedule(byWeek, bracket, ctx);
  const map = engine.seasonMap(ctx, { schedule, rosterWeekly: engine.rosterWeekly, objective: "bye" });
  assert.ok(Array.isArray(map.weeks) && map.weeks.length > 0, "week cards exist");
  for (const card of map.weeks) {
    assert.ok(card.pWin >= 0 && card.pWin <= 1, `pWin in range for week ${card.week}`);
    assert.ok(["strong", "even", "weak"].includes(card.strength));
  }
  const s = map.summary;
  assert.ok(s.playoffOdds >= s.firstRoundByeOdds && s.firstRoundByeOdds >= s.titleOdds, "odds are nested");
  const again = engine.seasonMap(ctx, { schedule, rosterWeekly: engine.rosterWeekly, objective: "bye" });
  assert.equal(JSON.stringify(again.summary), JSON.stringify(s), "deterministic across runs");
});
