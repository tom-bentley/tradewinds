// Tradewinds — the micro-visual primitives (004 design §4, R12 §Q12.3/§Q12.4).
//
// Every primitive is a pure `(data, opts) -> string`, so the whole visual vocabulary is checked
// here without a browser: the node budget R12 §R9 sets, the accessibility contract R12 §R7 sets,
// the four distinct null encodings R12 §R4 sets, and the shared-scale parameter that is the only
// reason one implementation can serve both a player card and a trade comparison.

import test from "node:test";
import assert from "node:assert/strict";

import {
  weekStrip, weekStripGroup, usageSparkline, matchupStrip, matchupNextChips,
  availabilityBar, seasonMap, valueBullet, synergyBadges, dossierCard, pctSafe, PITCH, BAR,
} from "../src/ui/sparkline.js";

/* ---------------------------------------------------------------- fixtures (synthetic) */

const WEEKS17 = Array.from({ length: 17 }, (_, i) => i + 1);
/** Synthetic, not a real player: a deterministic saw so the assertions never move. */
const ACTUAL17 = WEEKS17.map((w) => (w === 6 ? null : w === 9 ? 0 : 8 + ((w * 7) % 17)));
const PROJ17 = WEEKS17.map(() => 14.5);

/** Count the element nodes INSIDE an <svg>, which is what R12 §R9's budget is about. */
function svgOf(html) {
  const m = html.match(/<svg[\s\S]*?<\/svg>/);
  assert.ok(m, "the primitive rendered an <svg>");
  return m[0];
}
function nodes(html) {
  return (svgOf(html).match(/<(title|desc|path|rect|circle|line|polyline|polygon|g|use|defs|text|tspan|symbol|image)\b/g) || [])
    .map((s) => s.slice(1));
}
/** Data-carrying nodes = every <path> that is not one of the furniture classes. */
function marks(html) {
  return nodes(html).filter((n) => n === "path").length - furniture(html);
}
function furniture(html) {
  const s = svgOf(html);
  return (s.match(/class="(mv-track|mv-base|mv-mid|mv-band|mv-mean)"/g) || []).length;
}
function ariaLabelOf(html) {
  const svg = svgOf(html);
  const by = svg.match(/aria-labelledby="([^"]+)"/);
  if (!by) return null;
  const [t, d] = by[1].split(/\s+/);
  const title = html.match(new RegExp(`<title id="${t}">([^<]*)</title>`));
  const desc = html.match(new RegExp(`<desc id="${d}">([^<]*)</desc>`));
  return { title: title && title[1], desc: desc && desc[1] };
}

/* ---------------------------------------------------------------- P1 node budget (R12 §R9) */

test("a full 17-week strip is 4 mark nodes and 8 nodes in total, not 51", () => {
  const html = weekStrip({
    weeks: WEEKS17, actual: ACTUAL17, projected: PROJ17,
    byeWeeks: [6], currentWeek: 18, uid: "t1", name: "Synthetic Player",
  });
  const ns = nodes(html);
  assert.equal(ns.length, 8, `8 nodes, got ${ns.join(",")}`);
  assert.equal(marks(html), 4, "over, under, projection tick and the bye dot");
  assert.equal(furniture(html), 2, "the cell track and the baseline");
  assert.equal(ns.filter((n) => n === "title").length, 1);
  assert.equal(ns.filter((n) => n === "desc").length, 1);
});

test("the strip keeps the 20-unit week pitch so a short strip is not stretched", () => {
  const full = weekStrip({ weeks: WEEKS17, actual: ACTUAL17, projected: PROJ17, uid: "a" });
  const part = weekStrip({ weeks: [12, 13, 14], actual: [10, 12, 8], projected: [11, 11, 11], uid: "b" });
  assert.match(svgOf(full), new RegExp(`viewBox="0 0 ${17 * PITCH} 40"`));
  assert.match(svgOf(part), new RegExp(`viewBox="0 0 ${3 * PITCH} 40"`));
  assert.equal(BAR, 14, "14u of bar in a 20u pitch leaves 3u of air each side");
});

test("marks are stroked verticals of bar width, never one rect per week", () => {
  const html = weekStrip({ weeks: WEEKS17, actual: ACTUAL17, projected: PROJ17, uid: "c" });
  assert.equal((svgOf(html).match(/<rect/g) || []).length, 0);
  assert.match(svgOf(html), /stroke-width="14"/);
});

/* ---------------------------------------------------------------- R7 accessibility */

const ALL = () => ({
  P1: weekStrip({ weeks: WEEKS17, actual: ACTUAL17, projected: PROJ17, byeWeeks: [6], uid: "p1" }),
  P2: usageSparkline({ weeks: [1, 2, 3, 4], values: [0.41, 0.5, 0.62, 0.68], kind: "snap share", uid: "p2" }),
  P3: matchupStrip({ weeks: [8, 9, 10, 11], grades: [{ bin: 4, conf: "high", adjusted: true }, { bin: 2, conf: "high", adjusted: true }, { bin: 5, conf: "high", adjusted: true }, { bin: 3, conf: "high", adjusted: true }], uid: "p3" }),
  P5: seasonMap({ cards: SEASON_CARDS, uid: "p5" }),
});

test("every SVG primitive is role=img with a non-empty sentence label", () => {
  for (const [name, html] of Object.entries(ALL())) {
    assert.match(svgOf(html), /role="img"/, `${name} is role=img`);
    assert.match(svgOf(html), /focusable="false"/, `${name} is not a tab stop`);
    const a = ariaLabelOf(html);
    assert.ok(a && a.title && a.title.length > 3, `${name} has a <title>`);
    assert.ok(a && a.desc && a.desc.length > 10, `${name} has a sentence <desc>`);
    assert.match(a.desc, /\.$/, `${name}'s desc is a sentence`);
    assert.ok(a.desc.length <= 200, `${name}'s desc stays short (${a.desc.length})`);
  }
});

test("the two DOM-only primitives carry role=img and a sentence of their own", () => {
  const p4 = availabilityBar({ weeks: [8, 9, 10], pAvailable: [0.62, 0.88, 0.97], expectedMissed: 1.8 });
  assert.match(p4, /role="img"/);
  assert.match(p4, /aria-label="Availability by week\.[^"]+"/);
  const p6 = valueBullet({ market: 1240, model: 1510 });
  assert.match(p6, /role="img"/);
  assert.match(p6, /aria-label="Model value [^"]*against market value [^"]*"/);
});

test("no primitive ships SMIL — <animate> slips past the reduced-motion block (R12 §R8)", () => {
  const all = Object.values(ALL()).join("")
    + availabilityBar({ weeks: [1, 2], pAvailable: [0.9, 0.9] })
    + valueBullet({ market: 100, model: 120 })
    + synergyBadges([{ kind: "handcuff", name: "A" }])
    + dossierCard(null, null);
  assert.doesNotMatch(all, /<animate/i);
  assert.doesNotMatch(all, /animateTransform|animateMotion|<set\b/i);
});

test("nothing is coloured with a literal hex — tokens only, so light mode is free (R3f)", () => {
  const all = Object.values(ALL()).join("") + valueBullet({ market: 100, model: 120 });
  assert.doesNotMatch(all, /#[0-9a-fA-F]{3,8}\b/);
});

test("--mine and --ok never appear in one graphic (they are twins under deuteranopia)", () => {
  for (const html of Object.values(ALL())) {
    assert.doesNotMatch(html, /--ok\b/);
  }
});

test("one tap target per strip, and no listener below it (R12 §R10)", () => {
  const html = weekStrip({ weeks: WEEKS17, actual: ACTUAL17, projected: PROJ17, act: "weeks", id: "4046", name: "X", uid: "t" });
  assert.equal((html.match(/data-act=/g) || []).length, 1);
  assert.match(html, /class="mv-hit"/);
  assert.match(html, /aria-label="Open the week-by-week table for X"/);
  // Untapped strips carry no button at all rather than an inert one.
  const plain = weekStrip({ weeks: [1, 2], actual: [3, 4], projected: [3, 3], uid: "u" });
  assert.doesNotMatch(plain, /data-act=/);
});

/* ---------------------------------------------------------------- R4 null encodings */

test("zero, bye, did-not-play and not-yet-played are four different marks", () => {
  const html = weekStrip({
    weeks: [1, 2, 3, 4], actual: [0, null, null, null], projected: [12, 12, 12, 12],
    byeWeeks: [2], dnpWeeks: [3], currentWeek: 4, uid: "n",
  });
  const svg = svgOf(html);
  // week 1 scored zero -> a stub on the baseline, in the "under" path
  assert.match(svg, /class="mv-under" d="M10 34V32"/, "a zero is a 2u stub on the baseline, not a gap");
  // week 2 is a bye -> the null dot path exists and carries exactly one dot
  const nullPath = svg.match(/class="mv-null" d="([^"]+)"/);
  assert.ok(nullPath, "the bye draws a dot");
  assert.equal((nullPath[1].match(/M/g) || []).length, 1, "only the bye week gets a dot");
  // week 3 DNP and week 4 future both leave the track empty; the projection tick still prints
  const tick = svg.match(/class="mv-tick" d="([^"]+)"/);
  assert.equal((tick[1].match(/M/g) || []).length, 3, "every week but the bye keeps its projection");
  // and the four states read differently in the table twin
  assert.match(html, />bye</);
  assert.match(html, />did not play</);
});

test("the axis prints B under a bye and the twin spells the states out as words", () => {
  const html = weekStrip({ weeks: [5, 6, 7], actual: [12, null, 9], projected: [11, 11, 11], byeWeeks: [6], uid: "ax" });
  assert.match(html, /<span class="mv-ax">B<\/span>/);
  assert.doesNotMatch(html, /stroke-dasharray/, "a gap is never dashed or hatched (R12 §R4)");
});

test("an empty strip renders nothing rather than an empty box", () => {
  assert.equal(weekStrip({ weeks: [], actual: [], projected: [] }), "");
  assert.equal(weekStrip({}), "");
  assert.equal(usageSparkline({ weeks: [1], values: [0.5] }), "", "one point is not a trend");
  assert.equal(matchupStrip({ weeks: [8, 9], grades: [null, null] }), "");
  assert.equal(seasonMap({ cards: [] }), "");
});

/* ---------------------------------------------------------------- shared scale */

test("weekStrip honours an explicit {min,max} so panels can share one scale", () => {
  const own = weekStrip({ weeks: [1, 2], actual: [10, 20], projected: [10, 10], uid: "s1" });
  const shared = weekStrip({ weeks: [1, 2], actual: [10, 20], projected: [10, 10], min: 0, max: 40, uid: "s2" });
  const barTop = (html) => svgOf(html).match(/class="mv-over" d="M10 34V([\d.]+)/)[1];
  assert.notEqual(barTop(own), barTop(shared), "the same 10 points sit at a different height");
  // 10 of 40 over a 30-unit drawing area = 24 units from the 34 baseline
  assert.equal(barTop(shared), "26.5");
});

test("small multiples compute ONE scale, state it once, and cap at four panels", () => {
  const panel = (name, a) => ({ name, weeks: [1, 2, 3], actual: a, projected: [10, 10, 10], uid: name });
  const html = weekStripGroup([
    panel("A", [8, 12, 9]), panel("B", [30, 22, 18]), panel("C", [5, 6, 7]),
    panel("D", [11, 11, 11]), panel("E", [99, 99, 99]),
  ]);
  assert.equal((html.match(/mv-scale/g) || []).length, 1, "the scale is stated once, above the group");
  assert.match(html, /All strips 0–30 pts, one shared scale\./);
  assert.equal((html.match(/mv-fig-week/g) || []).length, 4, "cap at 4 panels (R12 §Q12.4)");
  assert.doesNotMatch(html, /Panel E|>E</, "the fifth panel falls back to the table twin");
  // every panel drew against the group max, so B's 30 is the only full-height bar
  assert.equal((html.match(/class="mv-over" d="M10 34V4/g) || []).length, 1);
});

/* ---------------------------------------------------------------- P2 usage */

test("the list-row sparkline is 56x18 with three marks and no axis", () => {
  const html = usageSparkline({ weeks: [1, 2, 3, 4], values: [0.41, 0.52, 0.6, 0.68], row: true, uid: "r" });
  assert.match(html, /viewBox="0 0 56 18"/);
  assert.match(html, /width="56" height="18"/);
  const ns = nodes(html);
  assert.equal(ns.length, 5, `title, desc, mean rule, line, end dot — got ${ns.join(",")}`);
  assert.doesNotMatch(html, /mv-axis/);
  assert.doesNotMatch(html, /mv-line2/, "a second series is never drawn in a row");
});

test("the sheet sparkline may carry a second series, and names its denominator", () => {
  const html = usageSparkline({
    weeks: [1, 2, 3, 4], values: [0.41, 0.52, 0.6, 0.68], kind: "target share of team pass attempts",
    second: [0.2, 0.22, 0.25, 0.24], secondKind: "red-zone share", uid: "sh",
  });
  assert.match(html, /viewBox="0 0 340 44"/);
  assert.match(html, /mv-line2/);
  const a = ariaLabelOf(html);
  assert.match(a.desc, /target share of team pass attempts/i);
  assert.match(a.desc, /41% to 68%, rising/);
});

test("a partial week is flagged rather than pretending to be final", () => {
  const html = usageSparkline({ weeks: [1, 2, 3], values: [0.4, 0.5, 0.3], partialWeeks: [3], uid: "pw" });
  assert.match(html, /mv-dot-partial/);
  assert.match(ariaLabelOf(html).desc, /still filling in/);
});

/* ---------------------------------------------------------------- P3 matchup */

test("matchup difficulty is a height with three colour bins, never a heat map (R12 §R3a)", () => {
  const grades = [5, 4, 3, 2, 1].map((bin) => ({ bin, conf: "high", adjusted: true }));
  const html = matchupStrip({ weeks: [8, 9, 10, 11, 12], grades, uid: "m" });
  const svg = svgOf(html);
  assert.equal((svg.match(/class="mv-bin[123]"/g) || []).length, 3, "exactly three bins");
  assert.doesNotMatch(svg, /fill-opacity="0\.[0-4]/, "no sub-3:1 alpha ramp");
  // bars grow downward from the top, so the strip reads as P1's opposite axis
  assert.match(svg, /class="mv-bin3" d="M10 3V29/, "bin 5 is full height, drawn down from the top");
  assert.equal(marks(html), 3, "three bin paths; no bye here");
});

test("a skill-position grade says it is already priced in (R8 §5.4)", () => {
  const low = matchupStrip({ weeks: [8, 9], grades: [{ bin: 4, conf: "low", adjusted: false }, { bin: 2, conf: "low", adjusted: false }], uid: "lo" });
  assert.match(low, /already priced in/i);
  const high = matchupStrip({ weeks: [8, 9], grades: [{ bin: 4, conf: "high", adjusted: true }, { bin: 2, conf: "high", adjusted: true }], uid: "hi" });
  assert.doesNotMatch(high, /already priced in/i);
});

test("matchup and week strips share a pitch so their cells line up", () => {
  const w = weekStrip({ weeks: [8, 9, 10], actual: [1, 2, 3], projected: [2, 2, 2], uid: "w" });
  const m = matchupStrip({ weeks: [8, 9, 10], grades: [{ bin: 3 }, { bin: 4 }, { bin: 1 }], uid: "mm" });
  assert.match(svgOf(w), /viewBox="0 0 60 40"/);
  assert.match(svgOf(m), /viewBox="0 0 60 32"/);
});

test("the next-three chips name the opponent above the strip", () => {
  const grades = [{ opp: "@DET" }, { opp: "vs CHI" }, null, { opp: "@GB" }];
  const chips = matchupNextChips([8, 9, 10, 11], grades, { byeWeeks: [10] });
  assert.match(chips, /WK 8 @DET/);
  assert.match(chips, /WK 10 BYE/);
  assert.doesNotMatch(chips, /WK 11/, "three chips, not four");
});

test("an unknown opponent is blank, never BYE — the engine supplies no opp field", () => {
  // `matchupGrade` returns {bin, conf, adjusted, why}. An `opp || \"BYE\"` fallback would print
  // BYE on every chip of every player, inventing a bye week out of a missing field.
  const chips = matchupNextChips([8, 9, 10], [{ bin: 4 }, { bin: 2 }, { bin: 5 }]);
  assert.doesNotMatch(chips, /BYE/);
  assert.match(chips, /WK 8<\/span>/);
  // A caller that CAN resolve the opponent passes a lookup instead.
  const named = matchupNextChips([8, 9], [{ bin: 4 }, { bin: 2 }], { oppOf: (w) => `@T${w}` });
  assert.match(named, /WK 8 @T8/);
  // and the strip's table twin uses the same lookup
  const strip = matchupStrip({ weeks: [8, 9], grades: [{ bin: 4, conf: "high" }, { bin: 2, conf: "high" }], oppOf: (w) => `@T${w}`, uid: "op" });
  assert.match(strip, /@T8/);
});

/* ---------------------------------------------------------------- P4 availability */

test("availability is 17 cells with a 0.35 opacity floor and no SVG", () => {
  const weeks = Array.from({ length: 17 }, (_, i) => i + 1);
  const html = availabilityBar({ weeks, pAvailable: weeks.map((w) => (w < 9 ? 0.62 : 0.97)), expectedMissed: 1.8 });
  assert.doesNotMatch(html, /<svg/);
  assert.equal((html.match(/mv-av-c/g) || []).length, 17);
  assert.match(html, /opacity:0\.75/, "0.62 maps to 0.35 + 0.65 x 0.62, well above the floor");
  assert.match(html, /expected games missed <b class="num">1\.8<\/b> of 17/);
  const zero = availabilityBar({ weeks: [1], pAvailable: [0] });
  assert.match(zero, /opacity:0\.35/, "a zero week is still visible against the track");
});

test("amber on the availability bar means a decision, never a magnitude (R3c)", () => {
  const plain = availabilityBar({ weeks: [1, 2], pAvailable: [0.5, 0.9] });
  assert.doesNotMatch(plain, /mv-av-dec/);
  const dec = availabilityBar({ weeks: [1, 2], pAvailable: [0.5, 0.9], decisionWeeks: [1] });
  assert.equal((dec.match(/mv-av-dec/g) || []).length, 1);
});

/* ---------------------------------------------------------------- P5 season map */

const SEASON_CARDS = [
  { week: 3, pWin: 0.485, strength: "even", me: { mean: 141.0 }, opp: { mean: 142.5, teamName: "Okraneers" }, isPlayoffWeek: false, scheduleIsProvisional: false },
  { week: 4, pWin: 0.496, strength: "even", me: { mean: 135.4 }, opp: { mean: 135.9, teamName: "Black Ops" }, isPlayoffWeek: false, scheduleIsProvisional: false },
  { week: 5, pWin: 0.750, strength: "strong", me: { mean: 142.6 }, opp: { mean: 116.9, teamName: "Loveland" }, isPlayoffWeek: false, scheduleIsProvisional: false },
  { week: 15, pWin: 0.567, strength: "even", me: { mean: 141.8 }, opp: { mean: 135.0, teamName: "speckledorf" }, isPlayoffWeek: true, scheduleIsProvisional: true },
];

test("the season map is a dumbbell per week plus a P(win) bar under the midline", () => {
  const html = seasonMap({ cards: SEASON_CARDS, currentWeek: 3, uid: "sm" });
  const svg = svgOf(html);
  for (const cls of ["mv-conn", "mv-mine-dot", "mv-opp-dot", "mv-over", "mv-under", "mv-mid", "mv-band", "mv-ring"]) {
    assert.match(svg, new RegExp(`class="${cls}"`), `${cls} is drawn`);
  }
  assert.ok(nodes(html).length <= 12, "the page-level object still stays lean");
  assert.match(ariaLabelOf(html).desc, /2 weeks favoured, 2 against/);
  assert.match(ariaLabelOf(html).desc, /Playoff opponents are provisional\./);
});

test("the season map's twin carries the numbers the strip cannot print", () => {
  const html = seasonMap({ cards: SEASON_CARDS, act: "season", uid: "sm2" });
  assert.match(html, /<caption>Season map<\/caption>/);
  assert.match(html, /Okraneers/);
  assert.match(html, />wk 15\*</, "a playoff week is marked in the table");
  assert.match(html, />49%</, "P(win) prints as a whole percent");
});

test("a modelled probability never prints 0 % or 100 % (R12 §R6)", () => {
  assert.equal(pctSafe(0), "1%");
  assert.equal(pctSafe(1), "99%");
  assert.equal(pctSafe(0.5), "50%");
  assert.equal(pctSafe(null), "—");
  assert.equal(pctSafe(0.68, { clampEnds: false }), "68%");
});

/* ---------------------------------------------------------------- P6 value bullet */

test("the value bullet is the shipped bar idiom: model fill, market tick, no new SVG", () => {
  const html = valueBullet({ market: 1240, model: 1510 });
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /class="bar-fill f-mine mv-bul-fill" style="width:/);
  assert.match(html, /class="bar-mark" style="left:/);
  assert.match(html, /undervalued/);
  assert.match(html, /data-tone="win"/);
});

test("the bullet takes a shared {min,max} so two players can be compared", () => {
  const solo = valueBullet({ market: 1240, model: 1510 });
  const shared = valueBullet({ market: 1240, model: 1510, min: 0, max: 5000 });
  const width = (h) => h.match(/mv-bul-fill" style="width:([\d.]+)%/)[1];
  assert.equal(width(solo), "90.9");
  assert.equal(width(shared), "30.2");
});

test("the bullet stands down for an unpriced player rather than drawing a phantom", () => {
  assert.equal(valueBullet({ market: null, model: null }), "");
  assert.match(valueBullet({ market: null, model: 900 }), /—/, "half a pair still reads honestly");
});

test("an overvalued player tones rose, a fairly priced one stays neutral", () => {
  assert.match(valueBullet({ market: 1500, model: 1100 }), /data-tone="loss"/);
  assert.match(valueBullet({ market: 1500, model: 1500 }), /data-tone="even"/);
  assert.match(valueBullet({ market: 1000, model: 1200, compact: true }), /mv-bul-c/);
});

test("the compact bullet is span-only, because Deals and FA cards are one <button>", () => {
  const html = valueBullet({ market: 1000, model: 1200, compact: true });
  assert.doesNotMatch(html, /<div|<p\b|<ul|<table/);
});

/* ---------------------------------------------------------------- P7 synergy */

test("synergy badges speak the four kinds and amber only the bye clash", () => {
  const html = synergyBadges([
    { kind: "handcuff", name: "Kyren Williams", delta: 0.8 },
    { kind: "stack", name: "Jayden Daniels", delta: 0.4 },
    { kind: "bye_clash", week: 5, delta: -1.2 },
    { kind: "complement", name: "Nico Collins", delta: 0.2 },
  ]);
  assert.match(html, /handcuff for Kyren Williams/);
  assert.match(html, /stacks with Jayden Daniels/);
  assert.match(html, /bye clash wk 5/);
  assert.match(html, /schedule complements Nico Collins/);
  assert.equal((html.match(/flag-warn/g) || []).length, 1, "only the clash is amber");
  assert.doesNotMatch(html, /<svg/, "no icons — the word is the signal");
});

test("synergy badges collapse a long tail and vanish when there is nothing to say", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ kind: "stack", name: `P${i}`, delta: 1 - i * 0.1 }));
  assert.match(synergyBadges(many), /\+3 more/);
  assert.equal(synergyBadges([]), "");
  assert.equal(synergyBadges(null), "");
});

test("a signed badge prints a true minus so it lines up under tabular-nums", () => {
  const html = synergyBadges([{ kind: "bye_clash", week: 9, delta: -1.4 }], { signed: true });
  assert.match(html, /−1\.4/);
});

/* ---------------------------------------------------------------- P8 dossier */

const FULL = {
  as_of: "2026-09-22T13:38:00Z", depth: "deep", confidence: "med",
  role: { notes: "18 of 23 routes from the slot in wk2", snap_share_trend: { src: 3 } },
  matchup_notes: [{ text: "WAS 27th in points allowed to tight ends", src: 3 }],
  contradictions: [{ claim: "reported on IR", against_src: 4, resolved: "no — day-to-day per the beat", severity: "high" }],
  sources: [
    { i: 3, url: "https://example.com/a", outlet: "Beat Writer", published: "2026-09-22" },
    { i: 4, url: "not-a-url", outlet: "Aggregator", published: "2026-09-21" },
  ],
  consensus: { n: 3 },
};

test("no claim renders without a dated source row", () => {
  const html = dossierCard({ as_of: FULL.as_of, depth: "deep", conf: "med", n: 3 }, FULL,
    { now: Date.parse("2026-09-22T15:00:00Z") });
  assert.match(html, /WAS 27th in points allowed to tight ends/);
  assert.match(html, /Beat Writer, 2026-09-22/);
  // A claim whose source index does not resolve is dropped and counted, never shown bare.
  const orphan = { ...FULL, matchup_notes: [{ text: "unsourced rumour", src: 99 }] };
  const html2 = dossierCard(null, orphan, { now: Date.parse("2026-09-22T15:00:00Z") });
  assert.doesNotMatch(html2, /unsourced rumour/);
  assert.match(html2, /withheld — no dated source/);
});

test("the dossier card states staleness in words, and links only real URLs", () => {
  const fresh = dossierCard({ as_of: FULL.as_of, depth: "deep" }, FULL, { now: Date.parse("2026-09-22T15:00:00Z") });
  assert.doesNotMatch(fresh, /is out of date/);
  assert.match(fresh, /filed 2026-09-22/);
  const stale = dossierCard({ as_of: FULL.as_of, depth: "deep", flags: ["stale"] }, FULL, { now: Date.parse("2026-09-22T15:00:00Z") });
  assert.match(stale, /fchip is-warn/);
  assert.match(stale, /is out of date/);
  // an aged-out report is stale even without the flag
  const old = dossierCard({ as_of: FULL.as_of }, FULL, { now: Date.parse("2026-09-30T15:00:00Z") });
  assert.match(old, /stale · \d+ h old/);
  assert.match(fresh, /<a href="https:\/\/example\.com\/a"/);
  assert.doesNotMatch(fresh, /href="not-a-url"/);
});

test("the dossier card says what it is: depth, fills and confidence", () => {
  const html = dossierCard({ depth: "deep", conf: "med", n: 3 }, FULL, { now: Date.parse("2026-09-22T15:00:00Z") });
  assert.match(html, /deep report · 3 fills · med confidence/);
});

test("nothing filed yet is a direction, not a blank", () => {
  const html = dossierCard(null, null);
  assert.match(html, /Nothing filed yet/);
  assert.match(html, /land here as they are published/);
});

/* ---------------------------------------------------------------- injection */

test("every string that reaches the page goes through escapeHtml", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = weekStrip({ weeks: [1, 2], actual: [1, 2], projected: [1, 1], name: evil, act: "weeks", id: evil, uid: "x" })
    + synergyBadges([{ kind: "handcuff", name: evil, reason: evil }])
    + dossierCard(null, { ...FULL, sources: [{ i: 3, outlet: evil, published: evil }], matchup_notes: [{ text: evil, src: 3 }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("junk in, empty or honest out — no primitive throws", () => {
  const junk = [undefined, null, {}, { weeks: "x" }, { weeks: [1, 2], actual: "no" }];
  for (const j of junk) {
    assert.doesNotThrow(() => weekStrip(j));
    assert.doesNotThrow(() => usageSparkline(j));
    assert.doesNotThrow(() => matchupStrip(j));
    assert.doesNotThrow(() => availabilityBar(j));
    assert.doesNotThrow(() => seasonMap(j));
    assert.doesNotThrow(() => valueBullet(j));
    assert.doesNotThrow(() => synergyBadges(j));
    assert.doesNotThrow(() => dossierCard(j, j));
  }
  assert.doesNotThrow(() => weekStripGroup(null));
  assert.equal(weekStripGroup([]), "");
});
