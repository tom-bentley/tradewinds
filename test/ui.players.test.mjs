// Tradewinds — the Players sheet's one pure renderer: the live weekly stat table (004 §2.7).
//
// The fetch itself belongs to the browser, but the shape of what comes back does not, and that
// shape is the whole risk: Sleeper returns one key per week of the season with `null` for a week
// that has not happened, `stats: {}` for a week a player missed, and fifty fields per row of
// which a phone can show about eighteen. Everything here is a synthetic response.

import test from "node:test";
import assert from "node:assert/strict";

import { liveTable } from "../src/ui/players.js";

const wk = (stats) => ({ stats });

/** A synthetic two-week response: the shape, not a real player. */
const RESPONSE = {
  1: wk({ pts_half_ppr: 31.05, off_snp: 57, tm_off_snp: 77, rec_tgt: 5, rec: 4, rec_yd: 42, rush_att: 15, rush_yd: 81, rush_td: 1, pass_att: 0 }),
  2: wk({ pts_half_ppr: 20.3, off_snp: 54, tm_off_snp: 65, rec_tgt: 3, rec: 3, rec_yd: 19, rush_att: 12, rush_yd: 55, rush_td: 0, pass_att: 0 }),
  3: null,
  4: null,
};

test("the live table puts weeks in columns and stats in rows", () => {
  const html = liveTable(RESPONSE, "2026");
  assert.match(html, /<caption>Live from Sleeper, 2026<\/caption>/);
  assert.match(html, /<th scope="col" class="mv-r num">1<\/th><th scope="col" class="mv-r num">2<\/th>/);
  assert.doesNotMatch(html, />3<\/th>/, "a week that has not happened is not a column");
  assert.match(html, /<th scope="row">Points \(half PPR\)<\/th><td class="num">31\.1<\/td><td class="num">20\.3<\/td>/);
  assert.match(html, /<th scope="row">Offensive snaps<\/th>/);
});

test("stats print in reading order, and the ones nobody has are left out", () => {
  const html = liveTable(RESPONSE, "2026");
  const rows = [...html.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(rows.slice(0, 4), ["Points (half PPR)", "Offensive snaps", "Team offensive snaps", "Targets"]);
  assert.ok(!rows.includes("Passing yards"), "a running back does not get an empty passing block");
  assert.ok(rows.includes("Carries") && rows.indexOf("Carries") > rows.indexOf("Receptions"));
  // `pass_att: 0` is present in the payload and is a real zero, so its row IS shown.
  assert.ok(rows.includes("Attempts"));
});

test("a zero is printed, not blanked — it is a fact about the week", () => {
  const html = liveTable(RESPONSE, "2026");
  assert.match(html, /<th scope="row">Rushing TDs<\/th><td class="num">1<\/td><td class="num">0<\/td>/);
});

test("an empty, missing or malformed answer says so rather than drawing an empty grid", () => {
  assert.match(liveTable(null, "2026"), /Live stats unavailable/);
  assert.match(liveTable("oops", "2026"), /Live stats unavailable/);
  assert.match(liveTable({}, "2026"), /No weekly stat line yet for 2026/);
  assert.match(liveTable({ 1: null, 2: null }, "2026"), /No weekly stat line yet for 2026/);
  assert.match(liveTable({ 1: wk({}) }, "2026"), /The stat line came back empty/);
  assert.match(liveTable({ 1: wk({ some_field_we_do_not_show: 3 }) }, "2026"), /The stat line came back empty/);
});

test("the season label is escaped — it reaches the page from settings", () => {
  const html = liveTable({}, '<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("weeks sort numerically, not as strings", () => {
  const many = {};
  for (const w of [1, 2, 9, 10, 11]) many[w] = wk({ pts_half_ppr: w });
  const html = liveTable(many, "2026");
  const cols = [...html.matchAll(/<th scope="col" class="mv-r num">(\d+)<\/th>/g)].map((m) => Number(m[1]));
  assert.deepEqual(cols, [1, 2, 9, 10, 11]);
});
