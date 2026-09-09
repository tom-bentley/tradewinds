// Tradewinds — unit tests for the UI formatters (src/ui/format.js).
// Pure functions only: no DOM, no clock reads without an injected `now`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DASH, MINUS, fmtValue, fmtFull, fmtPct, fmtPts, fmtNum, fmtRosterPct,
  relTime, clockTime, toMs, initials, escapeHtml, posRankLabel, clip, byDesc,
  numQbsOf, qbLabel, pprOf, pprLabel, leagueShape, possessive, acceptPhrase,
} from "../src/ui/format.js";

test("fmtValue abbreviates thousands and survives junk", () => {
  assert.equal(fmtValue(10274), "10.3k");
  assert.equal(fmtValue(880), "880");
  assert.equal(fmtValue(999), "999");
  assert.equal(fmtValue(1000), "1.0k");
  assert.equal(fmtValue(0), "0");
  assert.equal(fmtValue(-1240), MINUS + "1.2k");
  assert.equal(fmtValue(263000), "263k");
  assert.equal(fmtValue(null), DASH);
  assert.equal(fmtValue(undefined), DASH);
  assert.equal(fmtValue(NaN), DASH);
  assert.equal(fmtValue("10274"), DASH, "strings are not silently coerced");
});

test("fmtFull groups thousands", () => {
  assert.equal(fmtFull(10274), "10,274");
  assert.equal(fmtFull(880.6), "881");
  assert.equal(fmtFull(null), DASH);
});

test("fmtPct always carries a sign except at zero", () => {
  assert.equal(fmtPct(12.43), "+12%");
  assert.equal(fmtPct(-3.2), MINUS + "3%");
  assert.equal(fmtPct(0), "0%");
  assert.equal(fmtPct(-0.4), "0%", "rounds to zero rather than showing a signed 0%");
  assert.equal(fmtPct(12.43, 1), "+12.4%");
  assert.equal(fmtPct(null), DASH);
});

test("fmtPts signs points and keeps one decimal", () => {
  assert.equal(fmtPts(1.53), "+1.5");
  assert.equal(fmtPts(-2.04), MINUS + "2.0");
  assert.equal(fmtPts(0.02), "0.0");
  assert.equal(fmtPts(null), DASH);
});

test("fmtNum leaves the sign alone", () => {
  assert.equal(fmtNum(141.44), "141.4");
  assert.equal(fmtNum(141.44, 0), "141");
  assert.equal(fmtNum(undefined), DASH);
});

test("fmtRosterPct accepts a fraction or a percentage", () => {
  assert.equal(fmtRosterPct(0.9827), "98%", "FantasyCalc ships 0-1");
  assert.equal(fmtRosterPct(98.27), "98%", "the design contract says 0-100");
  assert.equal(fmtRosterPct(1), "100%");
  assert.equal(fmtRosterPct(null), DASH);
});

test("relTime buckets from an injected now", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const at = (iso) => relTime(iso, now);
  assert.equal(at("2026-09-09T11:59:40Z"), "just now");
  assert.equal(at("2026-09-09T11:48:00Z"), "12m ago");
  assert.equal(at("2026-09-09T09:00:00Z"), "3h ago");
  assert.equal(at("2026-09-07T12:00:00Z"), "2d ago");
  assert.equal(at("2026-09-01T12:00:00Z"), "Sep 1");
  assert.equal(at("2026-09-09T12:05:00Z"), "just now", "clock skew never reads as the future");
  assert.equal(at(null), DASH);
  assert.equal(at("not a date"), DASH);
});

test("clockTime and toMs handle bad input", () => {
  assert.equal(clockTime(null), DASH);
  assert.equal(clockTime("nope"), DASH);
  assert.match(clockTime("2026-09-09T12:04:00Z"), /^\d{2}:\d{2}$/);
  assert.equal(toMs(1757419440000), 1757419440000);
  assert.equal(toMs("nope"), null);
});

test("initials fall back for avatars", () => {
  assert.equal(initials("Johnston Jackoffs"), "JJ");
  assert.equal(initials("Amon-Ra St. Brown"), "AR", "hyphens split like spaces — fine for avatars");
  assert.equal(initials("hobbezilla"), "HO");
  assert.equal(initials("Ja'Marr Chase"), "JM", "the apostrophe splits the first word");
  assert.equal(initials(""), "?");
  assert.equal(initials(null), "?");
});

test("escapeHtml neutralises player names and hostile strings", () => {
  assert.equal(escapeHtml("Ja'Marr Chase"), "Ja&#39;Marr Chase");
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeHtml("A & B"), "A &amp; B");
  assert.equal(escapeHtml(null), "");
});

test("posRankLabel and clip", () => {
  assert.equal(posRankLabel("wr", 3), "WR3");
  assert.equal(posRankLabel("RB", null), "RB");
  assert.equal(clip("Amon-Ra St. Brown", 10), "Amon-Ra S…");
  assert.equal(clip("James Cook", 20), "James Cook");
});

test("byDesc sorts descending and pushes unknowns last", () => {
  const rows = [{ v: 3 }, { v: null }, { v: 10 }, { v: 7 }];
  rows.sort(byDesc((r) => r.v));
  assert.deepEqual(rows.map((r) => r.v), [10, 7, 3, null]);
});

/* ---------------------------------------------------------------- v1.1: any league */

test("numQbsOf counts QB and SUPER_FLEX slots", () => {
  assert.equal(numQbsOf(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN"]), 1);
  assert.equal(numQbsOf(["QB", "SUPER_FLEX", "RB", "WR"]), 2);
  assert.equal(numQbsOf(["QB", "QB", "RB"]), 2);
  assert.equal(numQbsOf([]), 1, "an unknown shape prices as 1QB");
  assert.equal(numQbsOf(undefined), 1);
});

test("qbLabel is the onboarding row's 1QB/2QB badge", () => {
  assert.equal(qbLabel(["QB", "RB", "WR", "FLEX"]), "1QB");
  assert.equal(qbLabel(["QB", "SUPER_FLEX", "RB"]), "2QB");
  assert.equal(qbLabel(null), "1QB");
});

test("pprOf snaps reception scoring to 0 / 0.5 / 1", () => {
  assert.equal(pprOf({ rec: 0 }), 0);
  assert.equal(pprOf({ rec: 0.5 }), 0.5);
  assert.equal(pprOf({ rec: 1 }), 1);
  assert.equal(pprOf({ rec: 0.4 }), 0.5, "0.4 PPR leagues price off the half-PPR table");
  assert.equal(pprOf({ rec: 0.8 }), 1);
  assert.equal(pprOf({}), 0, "no rec key is standard scoring");
  assert.equal(pprOf(undefined), 0);
  assert.equal(pprLabel({ rec: 0.5 }), "PPR 0.5");
});

test("leagueShape reads a raw Sleeper league or a built ctx.league", () => {
  assert.equal(
    leagueShape({ total_rosters: 8, roster_positions: ["QB", "RB", "WR", "FLEX"], scoring_settings: { rec: 0.5 } }),
    "8 teams · 1QB · PPR 0.5"
  );
  assert.equal(
    leagueShape({ numTeams: 12, rosterPositions: ["QB", "SUPER_FLEX", "RB"], scoring: { rec: 1 } }),
    "12 teams · 2QB · PPR 1"
  );
  assert.equal(leagueShape({}), "1QB · PPR 0", "an unknown league still renders");
});

test("possessive handles the s-ending team names Sleeper is full of", () => {
  assert.equal(possessive("hobbezilla"), "hobbezilla's");
  assert.equal(possessive("Okraneers"), "Okraneers'");
  assert.equal(possessive(""), "Their");
});

test("initials never throws on a punctuation-only team name", () => {
  assert.equal(initials("?"), "?");
  assert.equal(initials("🏈"), "?");
  assert.equal(initials("  --  "), "?");
});

test("acceptPhrase names side B when side names are supplied", () => {
  const names = { a: "hobbezilla", aPoss: "hobbezilla's", b: "speckledorf", first: false };
  assert.equal(acceptPhrase({ acceptance: "likely" }).long, "They'd likely accept");
  assert.equal(acceptPhrase({ acceptance: "likely" }, names).long, "speckledorf would likely accept");
  assert.equal(acceptPhrase({ acceptance: "possible" }, names).long, "speckledorf might accept");
  assert.equal(acceptPhrase({ acceptance: "unlikely" }, names).long, "speckledorf would likely decline");
  assert.equal(acceptPhrase({ acceptance: "likely" }, names).short, "likely accepts", "the short form is already name-prefixed by the caller");
  assert.equal(acceptPhrase({ acceptLikely: false }, names).cls, "no");
});
