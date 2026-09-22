// test/engine.prognosis.test.mjs — the deterministic prognosis rubric (004 §3.3, R7 §6).
//
// Fixtures only, no network, no clock: `ctx.now` is injected from the same 2026-09-09 Boyball
// snapshot the advisor tests use, and `test/fixtures/dossiers_2026_sample.json` is a SYNTHETIC
// slice file — invented codes chosen to exercise the precedence rules, never real player facts.
//
// The four properties R7 §6.4 asks to be asserted are here as properties, not examples: totality
// over a sampled enum grid, stochastic dominance along the severity chain, idempotence, and
// determinism (the replay test, SC-103).

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildContext, playerOf } from "../src/engine/context.js";
import { advise, applyStatuses, statusKey } from "../src/engine/advisor.js";
import { SEASON_GAMES, absenceOf, availability } from "../src/engine/injuries.js";
import {
  ENUMS,
  PROGNOSIS_TABLES,
  RUBRIC_ID,
  SEVERITY_ORDER,
  dossierPrognosis,
  prognose,
  rampClassOf,
  rampFor,
  sliceIsValid,
} from "../src/engine/prognosis.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** Sunday 2026-09-09 18:00 UTC — week 1 of the fixture season, the advisor tests' clock. */
const NOW = Date.parse("2026-09-09T18:00:00Z");
const ME = "1394551386997272576"; // tommyteez
const MINE = 3;
const BOWERS = "11604"; // fresh dossier, statusKey matches
const OLAVE = "8144"; // fresh dossier, statusKey has moved on
const GOEDERT = "5022"; // dossier expired
const DOWNS = "9500"; // dossier written under a rubric this engine does not map
const JOHNSON = "7002"; // healthy, with a dossier that says so
const KRAFT = "9484"; // malformed slice row

let INPUT;
let DOSSIERS;

/** A context with the sample dossiers and a pinned clock. */
const withDossiers = (patch = {}, settings = {}) =>
  buildContext({ ...INPUT, dossiers: DOSSIERS, now: NOW, ...patch }, { userId: ME, ...settings });

/** The same context with no dossier file at all — the ordinary case, and the 0.4.x baseline. */
const bare = (patch = {}, settings = {}) =>
  buildContext({ ...INPUT, now: NOW, ...patch }, { userId: ME, ...settings });

/** players.json with one row overridden. */
const withPlayer = (id, row) => {
  const players = fixture("players.json");
  players.players[id] = { ...players.players[id], ...row };
  return players;
};

/** P(games missed ≤ k) — the CDF stochastic dominance is stated over. */
const cdf = (branches, k) => branches.filter((b) => b.games <= k).reduce((sum, b) => sum + b.p, 0);
const massAt = (branches, g) => (branches.find((b) => b.games === g) || { p: 0 }).p;
const sumOf = (branches) => branches.reduce((sum, b) => sum + b.p, 0);

before(() => {
  INPUT = {
    league: fixture("league.json"),
    users: fixture("users.json"),
    rosters: fixture("rosters.json"),
    state: fixture("state.json"),
    players: fixture("players.json"),
    projections: fixture("projections.json"),
    values: fixture("values.json"),
    schedule: fixture("schedule.json"),
  };
  DOSSIERS = fixture("dossiers_2026_sample.json");
});

// ---------------------------------------------------------------------------------------------
// R7 §6.4 properties
// ---------------------------------------------------------------------------------------------

test("R7 §6.4 — prognose is TOTAL: every enum combination resolves to a distribution", () => {
  // A sampled grid rather than the full cross product: 44 types x 6 severities x 6 surgeries x
  // 10 designations x 6 team timelines is 95,040 cells, which is a slow test for no extra signal.
  // Every type and every severity/surgery/designation value appears at least once below.
  let checked = 0;
  for (const injury_type of ENUMS.injury_type) {
    for (let i = 0; i < ENUMS.severity.length; i += 1) {
      const severity = ENUMS.severity[i];
      const surgery = ENUMS.surgery[i % ENUMS.surgery.length];
      const designation = ENUMS.designation[(i + checked) % ENUMS.designation.length];
      const team_timeline = ENUMS.team_timeline[(i + 1) % ENUMS.team_timeline.length];
      const practice_pattern = ENUMS.practice_pattern[i % ENUMS.practice_pattern.length];
      const out = prognose({ injury_type, severity, surgery, designation, team_timeline, practice_pattern });
      const label = `${injury_type}/${severity}/${surgery}/${designation}`;
      assert.ok(out.branches.length >= 1, `${label} produced nothing`);
      assert.ok(Math.abs(sumOf(out.branches) - 1) < 1e-9, `${label} sums to ${sumOf(out.branches)}`);
      for (const branch of out.branches) {
        assert.ok(branch.p > 0 && branch.p <= 1, `${label} p=${branch.p}`);
        assert.ok(Number.isInteger(branch.games) && branch.games >= 0 && branch.games <= SEASON_GAMES, label);
      }
      // strictly increasing games, so the CDF is well defined (R11 §Q11.3 validator rule 7)
      for (let k = 1; k < out.branches.length; k += 1) {
        assert.ok(out.branches[k].games > out.branches[k - 1].games, `${label} is not ordered`);
      }
      assert.ok(out.key.startsWith(`${RUBRIC_ID}:`), out.key);
      assert.ok(Array.isArray(out.provenance) && out.provenance.length >= 1, label);
      checked += 1;
    }
  }
  assert.ok(checked >= 250, `only ${checked} combinations sampled`);

  // ...and unknown input widens rather than throwing: "a field with no citable evidence must be
  // UNKNOWN — the function widens rather than guessing" (R7 §6.2).
  for (const junk of [null, undefined, {}, { injury_type: "SPRAINED_EGO", severity: 7, surgery: [] }]) {
    const out = prognose(junk);
    assert.ok(Math.abs(sumOf(out.branches) - 1) < 1e-9);
  }
  assert.deepEqual(prognose({}).branches, [{ games: 0, p: 1 }], "no evidence at all is no absence");
});

test("R7 §6.4 — prognose is MONOTONE in severity: stochastic dominance along the grade chain", () => {
  const points = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, SEASON_GAMES];
  let graded = 0;
  for (const injury_type of ENUMS.injury_type) {
    for (const surgery of ENUMS.surgery) {
      for (const designation of ["NONE", "Q", "D", "O", "IR", "IR_R", "SUS", "EXEMPT"]) {
        const rows = SEVERITY_ORDER.map(
          (severity) =>
            prognose({ injury_type, severity, surgery, designation, practice_pattern: "LP_LP_LP" }).branches
        );
        for (let i = 1; i < rows.length; i += 1) {
          for (const k of points) {
            const milder = cdf(rows[i - 1], k);
            const worse = cdf(rows[i], k);
            assert.ok(
              milder >= worse - 1e-9,
              `${injury_type}/${surgery}/${designation}: ${SEVERITY_ORDER[i - 1]} F(${k})=${milder} < ` +
                `${SEVERITY_ORDER[i]} F(${k})=${worse}`
            );
          }
        }
        if (cdf(rows[0], 2) !== cdf(rows[4], 2)) graded += 1;
      }
    }
  }
  assert.ok(graded > 0, "no type actually distinguishes grades — the property would be vacuous");
});

test("R7 §6.4 — prognose is IDEMPOTENT and deterministic: same schema in, same bytes out", () => {
  const schema = {
    injury_type: "ANKLE_HIGH", severity: "GRADE_2", surgery: "NONE", team_timeline: "MULTI_WEEK",
    reporter_timeline_weeks: [3, 5], practice_pattern: "DNP_LP_LP", designation: "Q",
    games_served: 0, days_since_injury: 9,
  };
  const once = prognose(schema);
  const twice = prognose(schema);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));

  // re-running on a schema rebuilt from its own output changes nothing: the derived `ramp_class`
  // is stored so it is auditable (R7 §6.2), never so it can feed back in.
  const again = prognose({ ...schema, ramp_class: once.rampClass });
  assert.equal(JSON.stringify(again), JSON.stringify(once));

  // key order is stable, and the tables are not reachable for mutation
  assert.throws(() => {
    once.branches.push({ games: 1, p: 1 });
  });
  assert.equal(JSON.stringify(prognose(schema, PROGNOSIS_TABLES)), JSON.stringify(once));
});

// ---------------------------------------------------------------------------------------------
// R7 §3 and §5 — the numbers the rubric exists to get right
// ---------------------------------------------------------------------------------------------

test("R7 §3.3 row 6 [11][12] — a meniscus TRIM and a meniscus REPAIR are different injuries", () => {
  const codes = { injury_type: "MENISCUS", designation: "Q", practice_pattern: "DNP_LP_LP" };
  const trim = prognose({ ...codes, surgery: "ARTHROSCOPIC" });
  const repair = prognose({ ...codes, surgery: "RECONSTRUCTION" });

  // trim: mean 2.1 mo, RTS 98.2% — he comes back this season
  assert.equal(massAt(trim.branches, SEASON_GAMES), 0, "a trim does not end a season");
  assert.ok(massAt(trim.branches, 0) > 0.5, "Questionable off a DNP/LP/LP week still usually plays");
  // repair: mean 5.8 mo — it does, and the hard override means no designation argues it back
  assert.deepEqual(repair.branches, [{ games: SEASON_GAMES, p: 1 }]);
  assert.ok(repair.provenance.some((line) => line.includes("reconstruction")), repair.provenance.join(" | "));
  // ...which is the 3.5-month separation one table row could not express
  const mean = (br) => br.reduce((sum, b) => sum + b.games * b.p, 0);
  assert.ok(mean(repair.branches) > 10 * mean(trim.branches));
  assert.equal(rampClassOf({ injury_type: "MENISCUS", surgery: "ARTHROSCOPIC" }), "RAMP_SURGICAL");
});

test("R7 §3.2 [32] — the reserve floor runs down: games_served = 3 leaves max(0, 4 − 3) = 1", () => {
  const codes = { injury_type: "CONCUSSION", designation: "IR", practice_pattern: "UNKNOWN" };
  const fresh = prognose({ ...codes, games_served: 0 });
  const served3 = prognose({ ...codes, games_served: 3 });
  const served4 = prognose({ ...codes, games_served: 4 });

  assert.equal(fresh.branches[0].games, 4, "a fresh IR placement owes the whole four games");
  assert.equal(served3.branches[0].games, 1, "three served, one to go");
  assert.ok(served3.provenance.some((l) => l.includes("max(0, 4 - 3 served)")), served3.provenance.join(" | "));
  // once the minimum is served the floor stops binding and the injury itself decides
  assert.equal(served4.branches[0].games, 0);
  assert.equal(JSON.stringify(served4.branches), JSON.stringify(prognose({ ...codes, games_served: 9 }).branches));
  // ...and the floor never shortens anything: it only ever moves mass to the right
  for (const k of [0, 1, 2, 3, 4, 6]) assert.ok(cdf(fresh.branches, k) <= cdf(served3.branches, k) + 1e-9);

  // IR-R is a different mechanism: the 21-day window caps the non-season mass at three games
  const irr = prognose({ injury_type: "KNEE_UNSPEC", designation: "IR_R", return_designation_used: true });
  assert.ok(irr.branches.every((b) => b.games <= 3 || b.games === SEASON_GAMES));
  assert.ok(massAt(irr.branches, 3) > 0.1, "the revert-or-activate deadline piles mass on the cap");
});

test("R7 §3.1 [30][31] — SUS: a stated count wins, and a reporter range moves the prior to it", () => {
  // the PED penalty schedule prior, with no number anywhere: modal at 4-6, not at 1-2
  const prior = prognose({ injury_type: "NONE", designation: "SUS" });
  assert.ok(massAt(prior.branches, 4) + massAt(prior.branches, 6) > 0.6, JSON.stringify(prior.branches));

  // "out four weeks" from a quote pulls the mass onto 4 — a blend, so the prior is still visible
  const reported = prognose({ injury_type: "NONE", designation: "SUS", reporter_timeline_weeks: [4, 4] });
  assert.ok(Math.abs(massAt(reported.branches, 4) - 0.5) < 1e-9, JSON.stringify(reported.branches));
  const modal = reported.branches.reduce((best, b) => (b.p > best.p ? b : best));
  assert.equal(modal.games, 4, "the reported length is the modal outcome");

  // ...and a number the league itself published replaces the prior outright (R7 §5.2)
  const stated = prognose({ injury_type: "NONE", designation: "SUS", suspension_games: 6 });
  assert.deepEqual(stated.branches, [{ games: 6, p: 1 }]);
  assert.deepEqual(
    prognose({ injury_type: "NONE", designation: "SUS", suspension_games: 6, games_served: 2 }).branches,
    [{ games: 4, p: 1 }],
    "…less what he has already sat out"
  );
});

test("R7 §2.2 [24] — the ramp is by injury CLASS, never by weeks out", () => {
  // Surprises 2: games missed does not predict post-return production (R² = 0.0047, n = 2,523).
  const short = prognose({ injury_type: "CONCUSSION", days_since_injury: 0 });
  const long = prognose({ injury_type: "CONCUSSION", days_since_injury: 40 });
  assert.deepEqual(long.ramp, short.ramp, "a longer absence does not deepen the ramp");
  assert.equal(short.rampClass, "RAMP_MODERATE");
  assert.equal(prognose({ injury_type: "ANKLE_LOW" }).rampClass, "RAMP_NONE");
  assert.equal(prognose({ injury_type: "ACL" }).rampClass, "RAMP_SURGICAL");
  assert.equal(prognose({ injury_type: "HAND_FINGER", surgery: "ORIF" }).rampClass, "RAMP_SURGICAL");

  // the position tilt scales the DECLINE, not the multiplier (QB 1.6, TE 0.6)
  const base = PROGNOSIS_TABLES.ramp.RAMP_MODERATE;
  assert.ok(Math.abs(rampFor(base, "QB")[0].share - (1 - 0.15 * 1.6)) < 1e-9);
  assert.ok(Math.abs(rampFor(base, "TE")[0].share - (1 - 0.15 * 0.6)) < 1e-9);
  assert.deepEqual(rampFor(base, "K"), base, "a position with no published tilt is not invented one");

  // the hazard is returned separately so availability() can apply it week by week (R7 §6.4 step 8)
  assert.equal(prognose({ injury_type: "HAMSTRING" }).hazard, 0.27);
  assert.equal(prognose({ injury_type: "ELBOW" }).hazard, 0);
});

test("R7 §6.4 steps 3-5 — evidence, then the clock, in that order", () => {
  const codes = { injury_type: "ANKLE_HIGH", designation: "NONE", team_timeline: "MULTI_WEEK" };
  const fresh = prognose({ ...codes, days_since_injury: 0 });
  const old = prognose({ ...codes, days_since_injury: 16 });
  // floor(16 / 7) = 2 games already burned, so every branch slides two left
  assert.ok(old.provenance.some((l) => l.includes("clock -2")), old.provenance.join(" | "));
  for (const k of [0, 1, 2, 3, 4, 6]) assert.ok(cdf(old.branches, k) >= cdf(fresh.branches, k) - 1e-9);

  // a team timeline moves the answer but never replaces it (weight 0.35)
  const quiet = prognose({ injury_type: "ANKLE_HIGH", team_timeline: "UNKNOWN" });
  const dayToDay = prognose({ injury_type: "ANKLE_HIGH", team_timeline: "DAY_TO_DAY" });
  assert.ok(cdf(dayToDay.branches, 1) > cdf(quiet.branches, 1), "day-to-day pulls the mass forward");
  assert.ok(cdf(dayToDay.branches, 1) < 0.35 + 1e-9, "…by the blend weight, not by replacement");
});

// ---------------------------------------------------------------------------------------------
// 004 §2.4 / R11 §Q11.3 — precedence
// ---------------------------------------------------------------------------------------------

test("004 §2.4 — a fresh dossier whose statusKey still matches beats the table", () => {
  const ctx = withDossiers({ players: withPlayer(BOWERS, { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery" }) });
  const slice = ctx.dossiers.get(BOWERS);
  assert.equal(slice.sk, statusKey(playerOf(ctx, BOWERS)), "the fixture is set up as a match");

  const out = dossierPrognosis(ctx, BOWERS);
  assert.equal(out.source, "dossier");
  assert.equal(out.stale, false);
  assert.equal(out.reason, "");
  assert.equal(out.asOf, "2026-09-09T12:00:00Z");
  assert.deepEqual(out.branches, slice.prog.branches);
  assert.equal(out.hazard, 0.1);
  assert.deepEqual(out.ramp, PROGNOSIS_TABLES.ramp.RAMP_SURGICAL, "a class name resolves to the table's steps");

  // …and the whole engine sees it: absenceOf, and therefore weekVector and risk, read the dossier
  const absence = absenceOf(ctx, playerOf(ctx, BOWERS));
  assert.equal(absence.source, "dossier");
  assert.deepEqual(absence.branches, slice.prog.branches);
  // Doubtful per the dossier = 6% he plays this week, where the table said 0%
  assert.ok(Math.abs(availability(ctx, BOWERS, 1, absence) - 0.06) < 1e-9);

  // nothing was mutated on the way through
  assert.deepEqual(ctx.dossiers.get(BOWERS).prog.branches, slice.prog.branches);
  out.branches.push({ games: 1, p: 1 });
  assert.equal(ctx.dossiers.get(BOWERS).prog.branches.length, slice.prog.branches.length);
});

test("004 §2.4 — statusKey moved ⇒ stale by definition, whatever the clock says", () => {
  // the dossier was written while he was Questionable with a hamstring; he is now Out
  const ctx = withDossiers({ players: withPlayer(OLAVE, { inj: "Out", injPart: "Hamstring", injNotes: "Strain" }) });
  assert.notEqual(ctx.dossiers.get(OLAVE).sk, statusKey(playerOf(ctx, OLAVE)));

  const out = dossierPrognosis(ctx, OLAVE);
  assert.equal(out.source, "table");
  assert.equal(out.stale, true);
  assert.equal(out.reason, "dossier is stale (status changed)");
  assert.deepEqual(out.branches, absenceOf(bare(), { inj: "Out", injPart: "Hamstring", injNotes: "Strain" }).branches);
});

test("004 §2.4 — an expired dossier falls back to the table and says which date lapsed", () => {
  const ctx = withDossiers({ players: withPlayer(GOEDERT, { inj: "Questionable", injPart: "Ankle", injNotes: "Sprain" }) });
  const out = dossierPrognosis(ctx, GOEDERT);
  assert.equal(out.source, "table");
  assert.equal(out.stale, true);
  assert.equal(out.reason, "dossier expired 2026-09-08");

  // …and with no injected clock a fixture replays as written: null `now` means "treat as fresh",
  // which is what makes a git checkout reproducible (R11 §Q11.3, FR-109).
  const noClock = buildContext(
    { ...INPUT, dossiers: DOSSIERS, players: withPlayer(GOEDERT, { inj: "Questionable", injPart: "Ankle", injNotes: "Sprain" }) },
    { userId: ME }
  );
  assert.equal(noClock.now, null);
  assert.equal(dossierPrognosis(noClock, GOEDERT).source, "dossier");
});

test("004 §2.4 — a row under an unknown rubric is ignored, and a malformed row is not a crash", () => {
  const ctx = withDossiers({
    players: withPlayer(DOWNS, { inj: "Questionable", injPart: "Ankle", injNotes: "Limited" }),
  });
  const unknown = dossierPrognosis(ctx, DOWNS);
  assert.equal(unknown.source, "table");
  assert.ok(unknown.reason.includes("r9-v1"), unknown.reason);
  assert.equal(unknown.stale, false, "a rubric bump is not staleness — it is a row this engine cannot read");

  // the malformed row: branches that do not sum to 1
  assert.equal(sliceIsValid(ctx.dossiers.get(KRAFT)), false);
  assert.equal(sliceIsValid(ctx.dossiers.get(BOWERS)), true);
  const broken = dossierPrognosis(ctx, KRAFT);
  assert.equal(broken.source, "table");
  assert.equal(broken.reason, "dossier slice row is malformed");

  // a healthy player with a dossier that says he is healthy reads as a dossier, not as an absence
  const healthy = dossierPrognosis(ctx, JOHNSON);
  assert.equal(healthy.source, "dossier");
  assert.deepEqual(healthy.branches, [{ games: 0, p: 1 }]);

  // a player the file never mentions
  const absent = dossierPrognosis(ctx, "1"); // a rostered id with no dossier
  assert.equal(absent.stale, false);
  assert.equal(absent.reason, "no dossier for this player");
});

test("004 §2.4 — sliceIsValid is a shape guard, not a taste test", () => {
  const good = fixture("dossiers_2026_sample.json").players[BOWERS];
  assert.equal(sliceIsValid(good), true);
  for (const bad of [
    null,
    undefined,
    "a string",
    { ...good, sk: 7 },
    { ...good, as_of: "not a date" },
    { ...good, expires_at: good.as_of }, // must be strictly after
    { ...good, prog: null },
    { ...good, prog: { ...good.prog, branches: [] } },
    { ...good, prog: { ...good.prog, branches: [{ games: -1, p: 1 }] } },
    { ...good, prog: { ...good.prog, branches: [{ games: 1, p: 0 }] } },
    { ...good, prog: { ...good.prog, branches: [{ games: 1, p: 0.5 }, { games: 2, p: 0.2 }] } },
  ]) {
    assert.equal(sliceIsValid(bad), false, JSON.stringify(bad && bad.prog));
  }
  // the season sentinel is a legal `games` value (R11 §Q11.3 validator rule 7)
  assert.equal(sliceIsValid({ ...good, prog: { ...good.prog, branches: [{ games: SEASON_GAMES, p: 1 }] } }), true);
});

test("DEFAULTS.dossier — the TTL and the enable switch are honoured from settings", () => {
  const players = withPlayer(BOWERS, { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery" });
  assert.equal(withDossiers({ players }).settings.dossier.rubric, RUBRIC_ID);
  assert.deepEqual(withDossiers({ players }).settings.dossier.ttlHours, { deep: 48, standard: 72, quick: 168 });

  // switched off, the whole layer is inert
  const off = withDossiers({ players }, { dossier: { enabled: false } });
  assert.equal(dossierPrognosis(off, BOWERS).source, "table");
  assert.equal(dossierPrognosis(off, BOWERS).reason, "");

  // a row that outlives its depth's TTL was not written to the contract, so it is not trusted
  const overlong = withDossiers({ players }, { dossier: { ttlHours: { deep: 1 } } });
  assert.equal(dossierPrognosis(overlong, BOWERS).source, "table");
  assert.ok(dossierPrognosis(overlong, BOWERS).reason.includes("TTL"), "the reason names the rule");

  // a rubric the settings do not recognise drops every row
  const bumped = withDossiers({ players }, { dossier: { rubric: "r8-v1" } });
  assert.equal(dossierPrognosis(bumped, BOWERS).source, "table");
});

// ---------------------------------------------------------------------------------------------
// SC-103 / FR-109 — replay
// ---------------------------------------------------------------------------------------------

test("SC-103 — two runs over the same fixtures and dossiers produce byte-identical advice", () => {
  const patch = { players: withPlayer(BOWERS, { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery" }) };
  const run = () => {
    // a fresh parse of every fixture each time: nothing may survive between runs but the bytes
    const input = {
      league: fixture("league.json"),
      users: fixture("users.json"),
      rosters: fixture("rosters.json"),
      state: fixture("state.json"),
      players: patch.players,
      projections: fixture("projections.json"),
      values: fixture("values.json"),
      schedule: fixture("schedule.json"),
      dossiers: fixture("dossiers_2026_sample.json"),
      now: NOW,
    };
    const ctx = buildContext(input, { userId: ME });
    const events = [
      { id: BOWERS, kind: "status", after: { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery" } },
      { id: OLAVE, kind: "status", after: { inj: "Out", injPart: "Hamstring", injNotes: "Strain" } },
      { id: GOEDERT, kind: "status", after: { inj: "Questionable", injPart: "Ankle", injNotes: "Sprain" } },
    ];
    return JSON.stringify(events.map((event) => advise(ctx, { rosterId: MINE, event, now: NOW })));
  };
  const first = run();
  assert.equal(run(), first, "the engine is a pure function of its inputs (FR-109)");
  assert.ok(first.length > 1000, "the advisories are not empty");
  // and the dossier is visible in the advice, dated
  assert.ok(first.includes("How long he is out is per dossier (as of 2026-09-09)."), first.slice(0, 400));
  assert.ok(first.includes("Table estimate — dossier is stale (status changed)."), "the stale case says so");
});

test("FR-103 — with no dossiers the engine is byte-identical to 0.4.x", () => {
  const rows = [
    { inj: "Questionable", injPart: "Hamstring", injNotes: "Strain" },
    { inj: "Out", injPart: "Hamstring", injNotes: "Strain" },
    { inj: "Out", injPart: "Head", injNotes: "Concussion protocol" },
    { inj: "Out", injPart: "Shoulder", injNotes: null },
    { inj: "Out", injPart: "Ankle", injNotes: "High ankle sprain" },
    { inj: "Doubtful", injPart: "Knee", injNotes: "MCL sprain" },
    { inj: "Out", injPart: "Foot", injNotes: "Fractured" },
    { inj: "Out", injPart: "Thumb", injNotes: "Broken" },
    { inj: "Out", injPart: "Knee", injNotes: "Torn ACL" },
    { inj: "Out", injPart: "Ankle", injNotes: null },
    { inj: "Questionable", injPart: null, injNotes: null },
    { inj: "COV", injPart: null, injNotes: null },
    { inj: null, injPart: "Knee", injNotes: "Torn ACL" },
  ];
  // The 0.4.2 branch lists for the rows R7 §3 does NOT replace, transcribed from the shipped table.
  const v042 = [
    [{ games: 0, p: 0.6 }, { games: 1, p: 0.16 }, { games: 2, p: 0.14 }, { games: 3, p: 0.06 }, { games: 4, p: 0.04 }],
    [{ games: 1, p: 0.4 }, { games: 2, p: 0.35 }, { games: 3, p: 0.15 }, { games: 4, p: 0.1 }],
    [{ games: 1, p: 0.75 }, { games: 2, p: 0.25 }],
    [{ games: 1, p: 0.4 }, { games: 2, p: 0.3 }, { games: 3, p: 0.2 }, { games: 4, p: 0.1 }],
    [{ games: 2, p: 0.3 }, { games: 3, p: 0.3 }, { games: 4, p: 0.25 }, { games: 6, p: 0.15 }],
    [{ games: 2, p: 0.3 }, { games: 3, p: 0.3 }, { games: 4, p: 0.25 }, { games: 6, p: 0.15 }],
    [{ games: 4, p: 0.3 }, { games: 6, p: 0.4 }, { games: 8, p: 0.3 }],
    [{ games: 1, p: 0.3 }, { games: 2, p: 0.4 }, { games: 4, p: 0.3 }],
    [{ games: SEASON_GAMES, p: 1 }],
    [{ games: 1, p: 0.5 }, { games: 2, p: 0.3 }, { games: 3, p: 0.1 }, { games: 4, p: 0.1 }],
    [{ games: 0, p: 0.7 }, { games: 1, p: 0.3 }],
    [{ games: 1, p: 0.6 }, { games: 2, p: 0.4 }],
    [{ games: 0, p: 1 }],
  ];
  const ctx = bare();
  assert.equal(ctx.dossiers.size, 0, "no dossier file, no dossiers");
  /** 0.4.x renormalizes in floating point, so parity is to 1e-12, not to the bit. */
  const same = (got, want, label) => {
    assert.equal(got.length, want.length, label);
    got.forEach((branch, k) => {
      assert.equal(branch.games, want[k].games, `${label} games`);
      assert.ok(Math.abs(branch.p - want[k].p) < 1e-12, `${label}: ${branch.p} vs ${want[k].p}`);
    });
  };
  rows.forEach((row, i) => {
    const out = absenceOf(ctx, { ...row, id: BOWERS });
    same(out.branches, v042[i], `row ${i}: ${JSON.stringify(row)}`);
    // the new fields are inert, so nothing downstream reads anything it did not read before
    assert.equal(out.source, "table");
    assert.equal(out.stale, false);
    assert.equal(out.reason, "");
    same(absenceOf(ctx, row).branches, out.branches, "an id-less row answers the same");
  });

  // …and the advice itself gains no new sentence
  const hurt = applyStatuses(ctx, [{ id: BOWERS, inj: "Out", injPart: "Hamstring", injNotes: "Strain" }]);
  const advisory = advise(hurt, {
    rosterId: MINE,
    event: { id: BOWERS, kind: "status", after: { inj: "Out", injPart: "Hamstring", injNotes: "Strain" } },
    now: NOW,
  });
  assert.equal(advisory.absenceNote, "");
  assert.equal(advisory.prognosis.source, "table");
  for (const m of advisory.moves) {
    for (const line of m.why || []) assert.ok(!/dossier/i.test(line), line);
  }
});

test("dossierPrognosis memoizes per ctx and per status, and never mutates the shared ctx", () => {
  const players = withPlayer(BOWERS, { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery" });
  const ctx = withDossiers({ players });
  const first = dossierPrognosis(ctx, BOWERS);
  assert.equal(dossierPrognosis(ctx, BOWERS), first, "the second call is the cached object");

  // a different live status is a different cache key even on the same ctx (I3)
  const moved = dossierPrognosis(ctx, BOWERS, { inj: "Out", injPart: "Knee - Meniscus", injNotes: "Surgery" });
  assert.notEqual(moved, first);
  assert.equal(moved.source, "table");
  assert.equal(moved.stale, true);

  // a scenario ctx gets a fresh memo, so it can never inherit the previous status's answer
  const scen = applyStatuses(ctx, [{ id: BOWERS, inj: "Out", injPart: "Knee - Meniscus", injNotes: "Surgery" }]);
  assert.notEqual(scen.memo, ctx.memo);
  assert.equal(dossierPrognosis(scen, BOWERS).source, "table");
  assert.equal(dossierPrognosis(ctx, BOWERS).source, "dossier", "the original answer is untouched");
});
