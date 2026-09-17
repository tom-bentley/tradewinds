// Tradewinds — unit tests for the UI formatters (src/ui/format.js).
// Pure functions only: no DOM, no clock reads without an injected `now`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DASH, MINUS, fmtValue, fmtFull, fmtPct, fmtPts, fmtNum, fmtRosterPct,
  relTime, clockTime, toMs, initials, escapeHtml, posRankLabel, clip, byDesc,
  numQbsOf, qbLabel, pprOf, pprLabel, leagueShape, possessive, acceptPhrase,
  alertsStatusText, alertsStatusTone, alertsProblem,
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

/* ─────────────── the alerts status line tells the truth (design §13.3 B2) ─────────────── */

const NOW = Date.parse("2026-09-17T16:30:00Z");

/** A fully probed status: paired locally, paired on the server, receipts arriving. */
const healthy = (over = {}) => ({
  supported: true,
  reason: null,
  permission: "granted",
  subscribed: true,
  pairing: { createdAt: "2026-09-09T10:00:00Z", label: "iPhone" },
  deviceId: "11b2551101563b49",
  pairedDeviceId: "11b2551101563b49",
  endpointChanged: false,
  serverPaired: true,
  server: { lastSentAt: "2026-09-17T12:11:48Z", lastNotifiedAt: "2026-09-17T12:11:48Z", sentCount: 80, lastResult: { status: 201, at: "2026-09-17T12:11:48Z" }, expired: false },
  lastRunAt: "2026-09-17T12:11:00Z",
  receipts: { source: "sw", count: 12, count24h: 3, lastAt: Date.parse("2026-09-17T12:11:50Z"), lastShown: true, failed: 0, items: [], subscriptionChange: null },
  probed: true,
  ...over,
});

test("alertsStatusText: the pre-v1.4 shape keeps the old wording", () => {
  // A cached status, mock mode, or the fast local-only probe: nothing was asked of the sender,
  // so nothing may be claimed about it.
  const legacy = { permission: "granted", subscribed: true, pairing: { createdAt: "2026-09-09T10:00:00Z" } };
  assert.equal(alertsStatusText(legacy, NOW), "On · paired 9/9");
  assert.equal(alertsStatusTone(legacy, NOW), "ok");
  assert.equal(alertsProblem(legacy, NOW), null);
});

test("alertsStatusText: receipts arriving reads as On, with the time of the last one", () => {
  const status = healthy();
  assert.match(alertsStatusText(status, NOW), /^On · paired · last alert \d{1,2}:\d\d (AM|PM)$/);
  assert.equal(alertsStatusTone(status, NOW), "ok");
  assert.equal(alertsProblem(status, NOW), null);
});

test("alertsStatusText: the sender delivering into a phone that shows nothing is the headline bug", () => {
  // 2026-09-09..17: ~80 accepted pushes, none shown. The old card said "On · paired 9/9".
  const status = healthy({ receipts: { source: "sw", count: 0, count24h: 0, lastAt: null, lastShown: null, failed: 0, items: [], subscriptionChange: null } });
  assert.equal(
    alertsStatusText(status, NOW),
    "Paired · sender delivered 80 alerts, none shown on this phone — check iOS notification settings",
  );
  assert.equal(alertsStatusTone(status, NOW), "bad");
  assert.match(alertsProblem(status, NOW), /Notifications → Tradewinds/);
  assert.match(alertsProblem(status, NOW), /Scheduled Summary/);
});

test("alertsStatusText: receipts older than the last send by more than a day also count as stale", () => {
  const status = healthy({
    receipts: { source: "sw", count: 4, count24h: 0, lastAt: Date.parse("2026-09-10T18:00:00Z"), lastShown: true, failed: 0, items: [], subscriptionChange: null },
  });
  assert.match(alertsStatusText(status, NOW), /none shown on this phone/);
  assert.equal(alertsStatusTone(status, NOW), "bad");
});

test("alertsStatusText: a rotated endpoint says re-pair, and dates it when the worker logged it", () => {
  const changed = healthy({
    endpointChanged: true,
    receipts: { source: "sw", count: 0, count24h: 0, lastAt: null, lastShown: null, failed: 0, items: [], subscriptionChange: { at: Date.parse("2026-09-14T15:00:00Z") } },
  });
  assert.equal(alertsStatusText(changed, NOW), "This phone's alert address changed on 9/14 — re-pair");
  assert.equal(alertsStatusTone(changed, NOW), "bad");
  assert.match(alertsProblem(changed, NOW), /paste the new code into GitHub/);

  // Undated rotation (the worker's log was unreadable) still says the important half.
  const undated = healthy({ endpointChanged: true, receipts: { source: null, count: 0, count24h: 0, lastAt: null, lastShown: null, failed: 0, items: [], subscriptionChange: null } });
  assert.equal(alertsStatusText(undated, NOW), "This phone's alert address changed — re-pair");
});

test("alertsStatusText: a rotation is reported even from the fast local-only probe", () => {
  // The local probe knows nothing about the sender, but comparing the live endpoint with the
  // paired one needs no network at all — and it is the fix Tom has to make.
  const local = { permission: "granted", subscribed: true, pairing: { createdAt: "2026-09-09T10:00:00Z" }, endpointChanged: true, probed: false };
  assert.equal(alertsStatusText(local, NOW), "This phone's alert address changed — re-pair");
  assert.equal(alertsStatusTone(local, NOW), "bad");
});

test("alertsStatusText: not in the sender's device list, and written off by it", () => {
  const unpaired = healthy({ serverPaired: false, server: null });
  assert.equal(alertsStatusText(unpaired, NOW), "Subscribed, but NOT paired with the sender — re-pair");
  assert.equal(alertsStatusTone(unpaired, NOW), "bad");
  assert.match(alertsProblem(unpaired, NOW), /PUSH_SUBSCRIPTIONS/);

  const expired = healthy({ server: { ...healthy().server, expired: true } });
  assert.equal(alertsStatusText(expired, NOW), "The sender marked this phone dead — re-pair");
  assert.equal(alertsStatusTone(expired, NOW), "bad");
});

test("alertsStatusText: pushes that arrived but could not be displayed are their own case", () => {
  const status = healthy({
    receipts: { source: "sw", count: 3, count24h: 3, lastAt: Date.parse("2026-09-17T12:11:50Z"), lastShown: false, failed: 2, items: [], subscriptionChange: null },
  });
  assert.equal(alertsStatusText(status, NOW), "On · paired · 2 alerts arrived but could not be shown");
  assert.equal(alertsStatusTone(status, NOW), "warn");
  assert.match(alertsProblem(status, NOW), /Reopen the app/);
});

test("alertsStatusText: an unreadable receipt log is admitted, not papered over", () => {
  const blind = healthy({ receipts: { source: null, count: 0, count24h: 0, lastAt: null, lastShown: null, failed: 0, items: [], subscriptionChange: null } });
  assert.match(alertsStatusText(blind, NOW), /^On · paired · sender last sent .* · this phone keeps no receipts$/);
  assert.equal(alertsStatusTone(blind, NOW), "warn");
  assert.equal(alertsProblem(blind, NOW), null, "nothing to DO about it — it is a blind spot, not a fault");
});

test("alertsStatusText: paired but nothing sent yet is fine, and an unreachable sender says so", () => {
  const quiet = healthy({ server: { lastSentAt: null, lastNotifiedAt: null, sentCount: 0, lastResult: null, expired: false }, receipts: { source: "sw", count: 0, count24h: 0, lastAt: null, lastShown: null, failed: 0, items: [], subscriptionChange: null } });
  assert.equal(alertsStatusText(quiet, NOW), "On · paired · nothing sent yet");
  assert.equal(alertsStatusTone(quiet, NOW), "ok");

  const offline = healthy({ serverPaired: null, server: null, receipts: { source: "sw", count: 0, count24h: 0, lastAt: null, lastShown: null, failed: 0, items: [], subscriptionChange: null } });
  assert.equal(alertsStatusText(offline, NOW), "On · paired 9/9 · sender not reachable");
  assert.equal(alertsStatusTone(offline, NOW), "warn");
});

test("alertsStatusText: off and denied outrank every diagnosis", () => {
  assert.equal(alertsStatusText(null, NOW), "Checking…");
  assert.equal(alertsStatusText(healthy({ subscribed: false }), NOW), "Off");
  assert.equal(alertsStatusTone(healthy({ subscribed: false }), NOW), "mute");
  assert.equal(alertsStatusText(healthy({ permission: "denied", endpointChanged: true }), NOW), "Permission denied");
  assert.equal(alertsStatusTone(healthy({ permission: "denied" }), NOW), "bad");
  assert.match(alertsProblem(healthy({ permission: "denied" }), NOW), /Allow Notifications|turn them back on|Notifications → Tradewinds/i);
  assert.equal(alertsProblem(null, NOW), null);
});
