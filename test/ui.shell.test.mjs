// Tradewinds — the pure helpers behind the v1.4 shell fit and the Analyze verdict bar
// (design §13.2 A1/A2/A3). The CSS itself is verified with playwright (the numbers are in the
// commit body and in outputs/tradewinds/v14/ui/evidence.md); what can be checked without a
// browser is checked here: when the app decides the keyboard is up, and every string the
// one-row verdict bar prints.

import test from "node:test";
import assert from "node:assert/strict";

import { keyboardState, verdictBarText, slotTag } from "../src/ui/components.js";

/* ---------------------------------------------------------------- keyboardState */

test("keyboardState is false while the visual viewport matches the layout viewport", () => {
  assert.equal(keyboardState(844, 844), false);
  assert.equal(keyboardState(667, 667), false);
});

test("keyboardState ignores the Safari toolbar shrinking the visual viewport", () => {
  // A 390x844 iPhone in a Safari tab: the visual viewport loses ~90 px to the toolbars, far
  // short of a keyboard. Treating that as "keyboard open" would hide the tab bar while reading.
  assert.equal(keyboardState(754, 844), false);
  assert.equal(keyboardState(600, 667), false);
});

test("keyboardState is true for a real on-screen keyboard", () => {
  // iPhone 14 Pro, keyboard up: visualViewport.height ≈ 508 of 844.
  assert.equal(keyboardState(508, 844), true);
  // The smallest case that still has to trip: iPhone SE, ~44 % of the screen left.
  assert.equal(keyboardState(370, 667), true);
});

test("keyboardState draws the line at exactly three quarters", () => {
  assert.equal(keyboardState(633, 844), false, "633 === 0.75 * 844 is not yet open");
  assert.equal(keyboardState(632, 844), true);
  assert.equal(keyboardState(600, 844, 0.5), false, "the ratio is overridable");
  assert.equal(keyboardState(400, 844, 0.5), true);
});

test("keyboardState is total: junk in, closed out", () => {
  assert.equal(keyboardState(undefined, 844), false);
  assert.equal(keyboardState(null, null), false);
  assert.equal(keyboardState(NaN, 844), false);
  assert.equal(keyboardState(0, 844), false, "a zero height is a browser between states, not a keyboard");
  assert.equal(keyboardState(-10, 844), false);
  assert.equal(keyboardState(400, 0), false);
  assert.equal(keyboardState("400", "844"), true, "numeric strings are still numbers");
});

/* ---------------------------------------------------------------- verdictBarText */

const WIN = {
  code: "clear_win",
  label: "Clear win — you get better now",
  edgePct: 14.2,
  deltaPerWeek: 2.13,
  deltaPlayoffPerWeek: 2.8,
  acceptance: "possible",
};

test("verdictBarText prints the short word, the edge and the weekly delta", () => {
  const t = verdictBarText(WIN);
  assert.equal(t.word, "Clear win", "the engine's long label stays in the sheet");
  assert.equal(t.edge, "+14%");
  assert.equal(t.delta, "+2.1");
  assert.equal(t.unit, "pts/wk");
  assert.equal(t.invalid, false);
});

test("verdictBarText carries the tones the bar colours itself with", () => {
  const t = verdictBarText(WIN);
  assert.equal(t.tone, "win");
  assert.equal(t.edgeTone, "win");
  assert.equal(t.deltaTone, "win");

  const loss = verdictBarText({ code: "clear_loss", edgePct: -11, deltaPerWeek: -1.7 });
  assert.equal(loss.tone, "loss");
  assert.equal(loss.edgeTone, "loss");
  assert.equal(loss.deltaTone, "loss");

  const fair = verdictBarText({ code: "fair", edgePct: 0.2, deltaPerWeek: 0.01 });
  assert.equal(fair.tone, "even");
  assert.equal(fair.edgeTone, "even", "half a percent is not an edge");
  assert.equal(fair.deltaTone, "even");
});

test("verdictBarText names side B in the acceptance phrase", () => {
  assert.equal(verdictBarText(WIN).accept, "might accept");
  assert.equal(verdictBarText(WIN).acceptCls, "maybe");
  assert.equal(
    verdictBarText({ ...WIN, acceptance: "likely" }, { a: "me", b: "hobbezilla", first: false }).accept,
    "likely accepts",
    "the short phrase is side-neutral — the bar has no room for a name",
  );
  assert.equal(verdictBarText({ ...WIN, acceptance: "unlikely" }).acceptCls, "no");
});

test("verdictBarText trades the numbers for the reason when the engine refuses", () => {
  const t = verdictBarText({
    code: "invalid",
    label: "Invalid — Puka Nacua is not on your active roster.",
    labelParts: { kind: "problem", text: "Puka Nacua is not on your active roster." },
    edgePct: 0,
    deltaPerWeek: 0,
  });
  assert.equal(t.invalid, true);
  assert.equal(t.word, "Invalid");
  assert.equal(t.edge, "", "an invalid result's zeroes are not a verdict");
  assert.equal(t.delta, "");
  assert.equal(t.accept, "");
  assert.equal(t.reason, "Puka Nacua is not on your active roster.");
});

test("verdictBarText strips the Invalid prefix and clips a long reason", () => {
  const long = "Amon-Ra St. Brown is not on the Concerned Ostriches active roster right now.";
  const t = verdictBarText({ code: "invalid", label: `Invalid — ${long}` });
  assert.ok(!t.reason.startsWith("Invalid"), `the word is already the bar's first cell: ${t.reason}`);
  assert.ok(t.reason.length <= 46, `reason must fit one row, got ${t.reason.length}`);
  assert.ok(t.reason.endsWith("…"));
});

test("verdictBarText keeps the numbers for needs_drop — it is a real evaluation", () => {
  const t = verdictBarText({ code: "needs_drop", edgePct: 8, deltaPerWeek: 1.2 });
  assert.equal(t.invalid, false);
  assert.equal(t.word, "Needs a drop");
  assert.equal(t.tone, "block");
  assert.equal(t.edge, "+8%");
});

test("verdictBarText is total: no verdict at all still renders a bar", () => {
  const t = verdictBarText(null);
  assert.equal(t.word, "Fair");
  assert.equal(t.tone, "even");
  assert.equal(t.edge, "—", "a missing number prints the dash, never NaN");
  assert.equal(t.delta, "—");
});

/* ---------------------------------------------------------------- slotTag */

test("slotTag marks an IR or taxi row in the Analyze column", () => {
  assert.equal(slotTag("Taxi", null), '<span class="tag tag-mute">Taxi</span>');
  assert.equal(slotTag("IR", "Questionable"), '<span class="tag tag-mute">IR</span>');
});

test("slotTag stands down when the injury chip already says IR", () => {
  assert.equal(slotTag("IR", "IR"), "", "one IR chip per row is enough");
  assert.equal(slotTag("", "IR"), "", "an active player carries no slot chip");
  assert.equal(slotTag(null, null), "");
});
