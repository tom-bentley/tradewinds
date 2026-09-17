// Tradewinds — the pure helpers the v1.4 wave-2 risk surfaces are built from (design §13.8
// step 2). Every string the League strip, the Analyze risk section, the free-agent components
// line and the Players risk block print comes out of these, so they can be checked without a
// browser and the four surfaces cannot drift apart.

import test from "node:test";
import assert from "node:assert/strict";

import {
  bandTone, bandLabel, bandChip, pct01, lineupPool, riskStripText, starterBar, irLedger,
  faComponents, faComponentsText, isStreamable,
} from "../src/ui/components.js";

/* ---------------------------------------------------------------- bands */

test("bandTone maps the engine's four bands onto the existing palette", () => {
  assert.equal(bandTone("low"), "win");
  assert.equal(bandTone("moderate"), "even");
  assert.equal(bandTone("high"), "loss-dim");
  assert.equal(bandTone("severe"), "loss");
});

test("bandTone is total: an unknown band is neutral, never a crash", () => {
  assert.equal(bandTone(undefined), "even");
  assert.equal(bandTone(null), "even");
  assert.equal(bandTone("catastrophic"), "even");
  assert.equal(bandTone("LOW"), "win", "the engine's casing is not the UI's problem");
});

test("bandLabel and bandChip stay empty for a band the engine did not give", () => {
  assert.equal(bandLabel("severe"), "Severe");
  assert.equal(bandChip("low"), '<span class="band" data-tone="win">Low</span>');
  assert.equal(bandChip("high", "risk"), '<span class="band" data-tone="loss-dim">High risk</span>');
  assert.equal(bandLabel(null), "");
  assert.equal(bandChip(null), "", "no band, no chip — callers concatenate this blind");
});

/* ---------------------------------------------------------------- percentages */

test("pct01 reads a fraction, not an already-multiplied percent", () => {
  assert.equal(pct01(0.7748800058721962), "77%");
  assert.equal(pct01(0.7548, 1), "75.5%");
  assert.equal(pct01(1), "100%");
  assert.equal(pct01(0), "0%");
  assert.equal(pct01(null), "—");
  assert.equal(pct01("nonsense"), "—");
});

/* ---------------------------------------------------------------- lineup pool */

test("lineupPool is roster spots plus IR, never the taxi squad", () => {
  // Sleeper repeats reserve and taxi ids inside `players`, which is the trap this guards.
  const roster = { players: ["1", "2", "3", "4"], reserve: ["3"], taxi: ["4"] };
  assert.deepEqual(lineupPool(roster), ["1", "2", "3"]);
});

test("lineupPool keeps an IR body Sleeper left out of players, and dedupes", () => {
  assert.deepEqual(lineupPool({ players: ["1", "2"], reserve: ["9"], taxi: [] }), ["1", "2", "9"]);
  assert.deepEqual(lineupPool({ players: ["1", "1", "2"], reserve: ["2"], taxi: [] }), ["1", "2"]);
});

test("lineupPool is total: a roster with nothing on it is an empty pool", () => {
  assert.deepEqual(lineupPool(null), []);
  assert.deepEqual(lineupPool({}), []);
  assert.deepEqual(lineupPool({ players: ["1"] }), ["1"]);
});

/* ---------------------------------------------------------------- roster strip */

// The live Boyball numbers for roster 3 on 2026-09-17, straight off rosterRisk().
const RR = {
  concentration: { starterValue: 35324.42812456852, benchValue: 10262.53741444773, starterShare: 0.7748800058721962 },
  fragility: { expectedLossPerWeek: 2.6525446794497367, coverQuality: 0.7986404090935577 },
  weekly: { mean: 137.189, sd: 23.9656, cv: 0.1747 },
  certaintyEquivalent: 131.1976,
  score: 39.33,
  band: "moderate",
  notes: ["77% of this roster's value starts; 10263 sits on the bench"],
};

test("riskStripText says share, exposure and band in one line", () => {
  assert.equal(riskStripText(RR), "Starters hold 77% of value · exposure 2.7 pts/wk · Moderate");
});

test("riskStripText has a compact wording for a standings row", () => {
  // The full sentence plus the band chip is ~370 px against a 354 px cell at 390 px, so every
  // team wrapped to a second line; the compact form is what the row actually prints.
  assert.equal(riskStripText(RR, { compact: true }), "77% of value starts · 2.7 pts/wk at risk · Moderate");
  assert.ok(
    riskStripText(RR, { compact: true }).length < riskStripText(RR).length,
    "compact must actually be shorter, or it fixes nothing",
  );
});

test("riskStripText drops the parts the engine could not compute", () => {
  assert.equal(
    riskStripText({ concentration: {}, fragility: { expectedLossPerWeek: 4.2 }, band: "high" }),
    "exposure 4.2 pts/wk · High",
  );
  assert.equal(riskStripText({ concentration: { starterShare: 0.5 }, fragility: {} }), "Starters hold 50% of value");
  assert.equal(riskStripText(null), "", "no risk module (demo mode) means no strip at all");
  assert.equal(riskStripText({}), "");
  assert.equal(riskStripText(null, { compact: true }), "");
});

test("starterBar sizes the starting segment by value share", () => {
  const html = starterBar(RR.concentration);
  assert.match(html, /width:77\.5%/, html);
  assert.match(html, /aria-label="77% of roster value starts"/);
  assert.equal(starterBar({ starterValue: 0, benchValue: 0 }), "", "an empty roster draws nothing");
  assert.equal(starterBar(null), "");
});

/* ---------------------------------------------------------------- IR ledger */

test("irLedger reads the trade's landing, before to after of max", () => {
  assert.deepEqual(irLedger({ irBefore: 1, irAfter: 2, irMax: 2 }), {
    shown: true, before: 1, after: 2, max: 2, text: "IR 1 → 2 of 2",
  });
});

test("irLedger stays silent in a league with no IR slots", () => {
  assert.equal(irLedger({ irBefore: 0, irAfter: 0, irMax: 0 }).shown, false);
  assert.equal(irLedger({ irBefore: 0, irAfter: 0, irMax: 0 }).text, "");
  assert.equal(irLedger({}).shown, false);
  assert.equal(irLedger(null).shown, false);
});

/* ---------------------------------------------------------------- FA components */

test("faComponents breaks the score into the parts that earned it", () => {
  // Shape from a live findFreeAgents row (Patrick Mahomes on the Boyball wire).
  assert.deepEqual(
    faComponents({ gainPerWeek: 1.62, insurancePerWeek: 0.22, riskPenalty: 0.11, valueDelta: 21 }),
    ["+1.6 lineup", "+0.2 insurance", "−0.1 risk", "value +21"],
  );
  assert.equal(
    faComponentsText({ gainPerWeek: 1.62, insurancePerWeek: 0.22, riskPenalty: 0.11, valueDelta: 21 }),
    "+1.6 lineup · +0.2 insurance · −0.1 risk · value +21",
  );
});

test("faComponents keeps a negative insurance term — losing cover is the point of the line", () => {
  const parts = faComponents({ gainPerWeek: 0.74, insurancePerWeek: -0.0586, riskPenalty: 0.0764, valueDelta: 1347 });
  assert.deepEqual(parts, ["+0.7 lineup", "value +1.3k"], "0.06 and 0.08 are below the noise floor");
  const louder = faComponents({ gainPerWeek: 0.74, insurancePerWeek: -0.22, riskPenalty: 0.3, valueDelta: 1347 });
  assert.deepEqual(louder, ["+0.7 lineup", "−0.2 insurance", "−0.3 risk", "value +1.3k"]);
});

test("faComponents always subtracts risk, however the engine signs it", () => {
  assert.deepEqual(faComponents({ riskPenalty: 0.4 }), ["−0.4 risk"]);
  assert.deepEqual(faComponents({ riskPenalty: -0.4 }), ["−0.4 risk"], "a penalty never reads as a bonus");
});

test("faComponents is total and stays quiet on an all-zero row", () => {
  assert.deepEqual(faComponents({}), []);
  assert.deepEqual(faComponents(null), []);
  assert.deepEqual(faComponents({ gainPerWeek: 0, insurancePerWeek: 0, riskPenalty: 0, valueDelta: 0 }), []);
  assert.equal(faComponentsText(null), "");
});

test("isStreamable reads the engine's object, not its truthiness", () => {
  assert.equal(isStreamable({ streamable: { mine: 7.2, wire: 8.0, share: 1.11, streamable: true } }), true);
  assert.equal(isStreamable({ streamable: { mine: 17.3, wire: 12.0, share: 0.69, streamable: false } }), false,
    "the object is always there — only its flag says the slot is streamable");
  assert.equal(isStreamable({}), false);
  assert.equal(isStreamable(null), false);
});
