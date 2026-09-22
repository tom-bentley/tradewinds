// test/engine.injuries.test.mjs — the two structural defects R7 §3.5 found in the duration table,
// and the reserve-list mechanisms R7 §3.2 separated.
//
// `test/engine.advisor.test.mjs` already covers the table's ordinary matching; this file is about
// the code paths, not the rows: the max-scan that only ever looked at one candidate, the substring
// matcher that read "avoided a torn ACL" as a torn ACL, and the reserve floor that never ran down.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildContext } from "../src/engine/context.js";
import { statusKey } from "../src/engine/advisor.js";
import {
  DOSSIER_RUBRIC,
  INJURY_RULES,
  IR_STATUSES,
  SEASON_GAMES,
  STATUS_BRANCHES,
  absenceOf,
  statusKeyOf,
} from "../src/engine/injuries.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const ME = "1394551386997272576";

let ctx;
const abs = (inj, injPart, injNotes, extra = {}) => absenceOf(ctx, { inj, injPart, injNotes, ...extra });
const meanOf = (branches) => branches.reduce((sum, b) => sum + b.games * b.p, 0);
const firstGames = (out) => out.branches[0].games;

before(() => {
  ctx = buildContext(
    {
      league: fixture("league.json"),
      users: fixture("users.json"),
      rosters: fixture("rosters.json"),
      state: fixture("state.json"),
      players: fixture("players.json"),
      projections: fixture("projections.json"),
      values: fixture("values.json"),
      schedule: fixture("schedule.json"),
    },
    { userId: ME }
  );
});

test("R7 §3.5 — the IR max-scan compares EVERY downstream candidate, not just the first", () => {
  // The bug: the `break` sat outside the `if`, so "IR-class statuses take max(table, floor)" was a
  // max over exactly one candidate — whichever non-status rule matched first. Because the shipped
  // table is ordered worst-first that was usually right, so the regression needs a table in which
  // a MILD rule sits above a SEVERE one. `ctx.settings.injuryTable` is the supported way to do it.
  const mildFirst = [
    { key: "irMin4", statuses: IR_STATUSES, branches: [{ games: 4, p: 1 }] },
    { key: "tweak", tokens: ["knee"], branches: [{ games: 1, p: 1 }] }, // mild, and it matches first
    { key: "catastrophe", tokens: ["acl"], branches: [{ games: SEASON_GAMES, p: 1 }] },
  ];
  const patched = buildContext(
    {
      league: fixture("league.json"),
      users: fixture("users.json"),
      rosters: fixture("rosters.json"),
      state: fixture("state.json"),
      players: fixture("players.json"),
      projections: fixture("projections.json"),
      values: fixture("values.json"),
      schedule: fixture("schedule.json"),
    },
    { userId: ME, injuryTable: mildFirst }
  );
  // Notes that match BOTH downstream rules. Before the fix the scan stopped at `tweak`, whose mean
  // of 1 is below the floor's 4, so the player read as a four-game absence; the torn ACL below it
  // was never even compared.
  const out = absenceOf(patched, { inj: "IR", injPart: "Knee", injNotes: "Torn ACL" });
  assert.equal(out.key, "catastrophe", "the severe rule two places down still wins the max");
  assert.deepEqual(out.branches, [{ games: SEASON_GAMES, p: 1 }]);
  assert.equal(out.seasonOver, true);

  // …and a genuinely milder body part still loses to the reserve floor, which is the whole point
  const mild = absenceOf(patched, { inj: "IR", injPart: "Knee", injNotes: "Bruise" });
  assert.equal(mild.key, "irMin4");
  assert.deepEqual(mild.branches, [{ games: 4, p: 1 }]);

  // the shipped table keeps the same invariant on the real rows
  assert.equal(abs("IR", "Achilles", "Ruptured").key, "season");
  assert.equal(abs("IR", "Knee - Meniscus", "Repair").key, "meniscusRepair");
  assert.equal(abs("IR", "Hamstring", "Strain").key, "irMin4", "a strain is milder than the floor");
});

test("R7 §3.4 item 8 — the negation guard: 'avoided a torn ACL' is not a torn ACL", () => {
  // Surprises 8: a substring matcher reads "acl" in "avoided an ACL tear" and returns SEASON. It
  // was a live false positive on the highest-consequence row in the table, against a notes field
  // written by reporters.
  const negated = [
    "MRI showed he avoided a torn ACL",
    "Ruled out an ACL tear; day-to-day",
    "No torn ACL — he is week-to-week",
    "Tests found no structural damage to the ACL",
    "ACL intact, sprain only",
    "MRI clean — no ACL damage",
  ];
  for (const notes of negated) {
    const out = abs("Doubtful", "Knee", notes);
    assert.notEqual(out.key, "season", `"${notes}" still read as season-ending`);
    assert.ok(out.mean < 20, `"${notes}" mean ${out.mean}`);
  }

  // …and the guard is local: a real diagnosis in the same sentence still fires
  for (const notes of ["Torn ACL, out for the year", "ACL tear confirmed", "He avoided surgery but tore his ACL"]) {
    assert.equal(abs("Out", "Knee", notes).key, "season", `"${notes}" should be season-ending`);
  }
  // a negation of one thing does not clear another named in the same note
  assert.equal(abs("Out", "Knee", "No ACL damage, but the Achilles is ruptured").key, "season");
});

test("R7 §3.2 [32][33][35] — IR, IR-R and PUP are three mechanisms, and the floor runs down", () => {
  // IR with no return designation: the 4-game minimum, then a heavy tail because only EIGHT
  // designations exist per regular season and most in-season placements never get one.
  const ir = abs("IR", null, null);
  assert.equal(firstGames(ir), 4);
  assert.ok(ir.branches.some((b) => b.games === SEASON_GAMES && b.p >= 0.25));

  // …and it counts from PLACEMENT, not from ctx.week (R7 §5.3): three served leaves one to go.
  assert.equal(firstGames(abs("IR", null, null, { games_served: 3 })), 1);
  assert.equal(firstGames(abs("IR", null, null, { gamesServed: 3 })), 1, "camelCase is accepted too");
  assert.equal(firstGames(abs("IR", null, null, { games_served: 4 })), 0, "the minimum is fully served");
  assert.ok(abs("IR", null, null, { games_served: 3 }).mean < ir.mean, "served games shorten the estimate");
  assert.equal(firstGames(abs("IR", null, null, { games_served: "nonsense" })), 4, "junk reads as zero served");

  // IR-R: the 21-day activate-or-revert window is a hard cap of three games plus the revert mass
  const irr = abs("IR", null, "Designated to return, 21-day window is open");
  assert.ok(irr.branches.every((b) => b.games <= 3 || b.games === SEASON_GAMES), JSON.stringify(irr.branches));
  assert.ok(irr.mean < ir.mean / 2, "IR-R and IR differ by a factor of about four in expected absence");
  assert.equal(firstGames(abs("IR", null, "IR-R")), 0);

  // PUP/NFI: 4 games, then a 5-week practice window and 3 more to activate — a longer right tail
  const pup = abs("PUP", null, null);
  assert.equal(firstGames(pup), 4);
  assert.ok(pup.mean > ir.mean, "PUP's tail is heavier than IR's");

  // Sleeper's own feed codes with no official NFL equivalent take the generic IR row
  for (const code of ["Reserve", "DNR", "NA"]) assert.deepEqual(abs(code, null, null).branches, ir.branches);
});

test("R7 §3.1 [1][30][31] — the replaced status rows", () => {
  // Doubtful: 5.9% of Doubtful players played, 2017-2023, n > 2,000. The old row said 0% and then
  // invented a two- and three-game tail out of a designation that says nothing about week 2+.
  const doubtful = abs("Doubtful", null, null);
  assert.deepEqual(doubtful.branches, [{ games: 0, p: 0.06 }, { games: 1, p: 0.94 }]);
  assert.deepEqual(STATUS_BRANCHES.Doubtful, doubtful.branches);

  // Questionable is the best-calibrated row in the file and is untouched: 71% played.
  assert.deepEqual(abs("Questionable", null, null).branches, [{ games: 0, p: 0.7 }, { games: 1, p: 0.3 }]);

  // Suspensions: the prior was inverted. The NFL's schedule clusters at 4-6 games.
  const sus = abs("Sus", null, "violation of the personal conduct policy");
  assert.ok(meanOf(sus.branches) > 4, `mean ${meanOf(sus.branches)} should sit in the 4-6 band`);
  const modal = sus.branches.reduce((best, b) => (b.p > best.p ? b : best));
  assert.equal(modal.games, 6, "test manipulation is six games, and it is the modal outcome");
  // …but a stated count still beats the prior outright (R7 §5.2)
  assert.deepEqual(abs("Sus", null, "suspended 10 games").branches, [{ games: 10, p: 1 }]);
});

test("R7 §3.3 rows 6 and 8 — the meniscus split and the knee row", () => {
  // One row could not hold a trim (mean 2.1 mo) and a repair (mean 5.8 mo) at once.
  assert.equal(abs("Out", "Knee - Meniscus", "Meniscus repair scheduled").key, "meniscusRepair");
  assert.deepEqual(abs("Out", "Knee - Meniscus", "Repair").branches, [{ games: SEASON_GAMES, p: 1 }]);
  assert.equal(abs("Out", "Knee - Meniscus", "Arthroscopic trim").key, "meniscusTrim");
  assert.equal(abs("Out", "Knee - Meniscus", "Partial meniscectomy").key, "meniscusTrim");
  assert.ok(abs("Out", "Knee", "Meniscus, procedure TBD").key === "meniscus", "no procedure word is the mixture");

  const trim = abs("Out", "Knee - Meniscus", "Arthroscopic trim");
  const mix = abs("Out", "Knee", "Meniscus");
  assert.equal(trim.branches.some((b) => b.games === SEASON_GAMES), false, "a trim does not end a season");
  assert.ok(mix.branches.some((b) => b.games === SEASON_GAMES), "the mixture carries the repair's risk");
  assert.ok(meanOf(mix.branches) > meanOf(trim.branches));

  // the knee row: the QB bucket averages 5.0 wk with 48% missing 5+, so mass past four games is
  // not optional — the old row had none at all
  const knee = abs("Out", "Knee", "Sore");
  assert.ok(knee.branches.filter((b) => b.games > 4).reduce((s, x) => s + x.p, 0) >= 0.25, JSON.stringify(knee.branches));
});

test("the dossier seam is inert without dossiers, and statusKeyOf is THE formula", () => {
  assert.equal(ctx.dossiers.size, 0);
  const out = abs("Out", "Hamstring", "Strain");
  assert.equal(out.source, "table");
  assert.equal(out.stale, false);
  assert.equal(out.reason, "");
  assert.equal(DOSSIER_RUBRIC, "r7-v1");

  // advisor.statusKey and injuries.statusKeyOf must never drift: the alert diff and the dossier
  // freshness gate are asking the same question.
  for (const row of [
    { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery" },
    { inj: null, injPart: null, injNotes: null },
    { inj: "Out", injPart: "", injNotes: "notes | with | pipes" },
    {},
  ]) {
    assert.equal(statusKeyOf(row), statusKey(row), JSON.stringify(row));
  }
  assert.equal(statusKeyOf(null), "||");

  // the shipped table still documents every rule it ships
  const keys = INJURY_RULES.map((rule) => rule.key);
  assert.equal(new Set(keys).size, keys.length, "rule keys are unique");
  assert.ok(keys.includes("meniscusRepair") && keys.includes("meniscusTrim") && keys.includes("meniscus"));
  assert.ok(
    keys.indexOf("meniscusRepair") < keys.indexOf("meniscusTrim") &&
      keys.indexOf("meniscusTrim") < keys.indexOf("meniscus"),
    "first match wins, so the procedure rows must precede the mixture"
  );
});
