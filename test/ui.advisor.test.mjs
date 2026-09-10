// Tradewinds — the Advisor tab's copy (design §12.5). Every line a card prints is shaped by a
// pure function in src/ui/format.js so it can be checked without a browser and without a clock;
// the view itself only ever concatenates the strings these produce.

import test from "node:test";
import assert from "node:assert/strict";

import {
  absencePhrase,
  feedAgeLine,
  headline,
  statusMetaLine,
  thisWeekLine,
  whenChipText,
} from "../src/ui/format.js";

const NOW = Date.parse("2026-09-10T14:00:00Z");
/** Local wall-clock date, so the waiver assertions do not depend on the runner's timezone. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

/* ---------------------------------------------------------------- absence phrase */

test("absencePhrase names the likely run and the tail separately", () => {
  // The meniscus row from design §12.2 — the Bowers case this release exists for.
  const meniscus = { branches: [{ games: 1, p: 0.3 }, { games: 2, p: 0.3 }, { games: 3, p: 0.15 }, { games: 4, p: 0.15 }, { games: 6, p: 0.1 }] };
  assert.equal(absencePhrase(meniscus), "Likely 1–2 games, tail to 6+");

  // Doubtful with no keyword: most of the mass is one game, but three is still on the table.
  assert.equal(
    absencePhrase({ branches: [{ games: 1, p: 0.7 }, { games: 2, p: 0.2 }, { games: 3, p: 0.1 }] }),
    "Likely 1 game, tail to 3+",
  );

  // Out: no single week carries 60 %, so the phrase widens instead of pretending to be precise.
  assert.equal(
    absencePhrase({ branches: [{ games: 1, p: 0.5 }, { games: 2, p: 0.3 }, { games: 3, p: 0.1 }, { games: 4, p: 0.1 }] }),
    "Likely 1–2 games, tail to 4+",
  );
});

test("absencePhrase says the two things that are not a game count", () => {
  assert.equal(absencePhrase({ seasonOver: true, branches: [{ games: 99, p: 1 }] }), "Out for the season");
  assert.equal(absencePhrase({ branches: [{ games: 99, p: 1 }] }), "Out for the season", "99 games is the marker");
  assert.equal(absencePhrase({ branches: [{ games: 0, p: 0.7 }, { games: 1, p: 0.3 }] }), "Probable to play");
  assert.equal(absencePhrase({ branches: [{ games: 0, p: 1 }] }), "Probable to play");
});

test("absencePhrase carries an IR-class tail all the way to the season", () => {
  assert.equal(
    absencePhrase({ branches: [{ games: 4, p: 0.4 }, { games: 6, p: 0.3 }, { games: 8, p: 0.2 }, { games: 99, p: 0.1 }] }),
    "Likely 4–6 games, could be the season",
  );
});

test("absencePhrase is total: junk in, empty string out", () => {
  assert.equal(absencePhrase(null), "");
  assert.equal(absencePhrase({}), "");
  assert.equal(absencePhrase({ branches: [] }), "");
  assert.equal(absencePhrase({ branches: [{ games: "x", p: null }] }), "");
});

/* ---------------------------------------------------------------- when chip */

test("whenChipText keeps the fact and drops the grammar", () => {
  assert.equal(whenChipText({ when: "now" }), "now");
  assert.equal(whenChipText({}), "now", "a move with no window is available now");
  assert.equal(whenChipText({ when: "when status = Out" }), "when Out");
  assert.equal(whenChipText({ when: "when his status becomes Out" }), "when Out");
  assert.equal(whenChipText({ when: "when the status is Doubtful" }), "when Doubtful");
});

test("whenChipText prints the day a waiver claim clears", () => {
  const monday = at(2026, 9, 7, 12);
  const wed3am = new Date(at(2026, 9, 9, 3)).toISOString();
  assert.equal(whenChipText({ when: "after waivers clear", clearsAt: wed3am }, monday), "after waivers Wed 3 AM");
  assert.equal(whenChipText({ status: "waivers", clearsAt: wed3am }, monday), "after waivers Wed 3 AM",
    "a waiver add with no `when` still says it is not instant");
  assert.equal(whenChipText({ status: "waivers" }, monday), "after waivers", "no clear time, no empty segment");
  assert.equal(whenChipText({ when: "after waivers clear Wednesday" }, monday), "after waivers Wednesday",
    "a window with no clock still says which day");
});

/* ---------------------------------------------------------------- meta line */

test("statusMetaLine reads status, part, notes and how old the news is", () => {
  const line = statusMetaLine({
    after: { inj: "Doubtful", injPart: "Knee - Meniscus", injNotes: "Surgery Tuesday." },
    newsAt: NOW - 3 * 3600 * 1000,
  }, NOW);
  assert.equal(line, "Doubtful · Knee - Meniscus · Surgery Tuesday. · news 3h ago");
});

test("statusMetaLine drops the parts an advisory does not have", () => {
  assert.equal(statusMetaLine({ after: { inj: "Out" } }, NOW), "Out");
  assert.equal(statusMetaLine({ inj: "Questionable", injPart: "Ankle" }, NOW), "Questionable · Ankle",
    "a bare status row works as well as a full advisory");
  assert.equal(statusMetaLine({ newsAt: NOW - 60000 }, NOW), "news 1m ago");
  assert.equal(statusMetaLine({}, NOW), "", "a bye-week advisory has no status at all");
  assert.equal(statusMetaLine({ after: { inj: "Out" }, newsAt: "nonsense" }, NOW), "Out");
});

test("statusMetaLine clips a long injury note instead of wrapping the card", () => {
  const notes = "Bowers underwent a procedure to trim the meniscus in his left knee on Tuesday and is expected back after the bye.";
  const line = statusMetaLine({ after: { inj: "Doubtful", injPart: "Knee", injNotes: notes } }, NOW);
  assert.ok(line.length < 110, `meta line stays on one line (${line.length})`);
  assert.ok(line.endsWith("…"));
});

/* ---------------------------------------------------------------- this week */

test("thisWeekLine names the slot, the replacement and what the lineup loses", () => {
  assert.equal(
    thisWeekLine({ wasStarter: true, slot: "TE", replacement: { id: "5022", name: "Dallas Goedert", pts: 8.8 }, lineupDelta: -4.3 }, "Brock Bowers"),
    "TE: Dallas Goedert 8.8 replaces Brock Bowers · lineup −4.3",
  );
});

test("thisWeekLine states the hole without contradicting the moves", () => {
  // An unnamed replacement means the engine covered the slot by reshuffling, not that nobody
  // can play there — move 1 names whoever actually starts, so this line must not claim otherwise.
  assert.equal(
    thisWeekLine({ wasStarter: true, slot: "FLEX", replacement: null, lineupDelta: -12 }, "Brock Bowers"),
    "FLEX: Brock Bowers is out of your lineup · lineup −12.0",
  );
  assert.equal(thisWeekLine(null, "Brock Bowers"), "", "a bench player has no this-week line");
  assert.equal(
    thisWeekLine({ slot: "TE", replacement: { name: "Dallas Goedert", pts: 8.8 }, lineupDelta: 0 }, "Brock Bowers"),
    "TE: Dallas Goedert 8.8 replaces Brock Bowers",
    "a lineup that does not move says nothing about the lineup",
  );
});

/* ---------------------------------------------------------------- headline + feed age */

test("headline never exceeds the 60 characters a push notification allows", () => {
  const long = "Brock Bowers is Doubtful with a meniscus problem and will probably miss time";
  assert.ok(headline(long).length <= 60);
  assert.ok(headline(long).endsWith("…"));
  assert.equal(headline("Bowers → Doubtful (knee)"), "Bowers → Doubtful (knee)", "a short headline is untouched");
  assert.equal(headline(null), "");
});

test("feedAgeLine says when the job last ran, and nothing when it never has", () => {
  assert.equal(feedAgeLine(new Date(NOW - 12 * 60000).toISOString(), NOW), "job ran 12m ago");
  assert.equal(feedAgeLine(null, NOW), "");
  assert.equal(feedAgeLine("nonsense", NOW), "");
});
