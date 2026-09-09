// Tradewinds — unit tests for the v1.2 UI copy (design §11.5): the free-agent status chip and
// the Settings → Alerts status line. Both are pure string shapers in src/ui/format.js precisely
// so they can be checked without a browser; every clock read is injected.

import test from "node:test";
import assert from "node:assert/strict";

import { fmtClears, fmtBid, waiverChipText, alertsStatusText } from "../src/ui/format.js";

/** Local wall-clock date, so the assertions do not depend on the runner's timezone. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

/* ---------------------------------------------------------------- fmtClears */

test("fmtClears names the weekday and a bare hour", () => {
  const wed3am = at(2026, 9, 9, 3); // 2026-09-09 is a Wednesday
  const monday = at(2026, 9, 7, 12);
  assert.equal(fmtClears(new Date(wed3am).toISOString(), monday), "Wed 3 AM");
});

test("fmtClears keeps the minutes only when there are any", () => {
  const monday = at(2026, 9, 7, 12);
  assert.equal(fmtClears(new Date(at(2026, 9, 9, 3, 30)).toISOString(), monday), "Wed 3:30 AM");
  assert.equal(fmtClears(new Date(at(2026, 9, 9, 15)).toISOString(), monday), "Wed 3 PM");
  assert.equal(fmtClears(new Date(at(2026, 9, 9, 0)).toISOString(), monday), "Wed 12 AM");
  assert.equal(fmtClears(new Date(at(2026, 9, 9, 12)).toISOString(), monday), "Wed 12 PM");
});

test("fmtClears says today rather than naming the current weekday", () => {
  const now = at(2026, 9, 9, 1);
  assert.equal(fmtClears(new Date(at(2026, 9, 9, 3)).toISOString(), now), "today 3 AM");
});

test("fmtClears is total: junk in, empty string out", () => {
  assert.equal(fmtClears(null), "");
  assert.equal(fmtClears(undefined), "");
  assert.equal(fmtClears("not a date"), "");
});

/* ---------------------------------------------------------------- fmtBid */

test("fmtBid renders the FAAB range the engine suggests", () => {
  assert.equal(fmtBid({ value: 12, aggressive: 18 }), "12–18");
  assert.equal(fmtBid({ value: 12.4, aggressive: 18.5 }), "12–19");
});

test("fmtBid collapses to one number when there is no headroom", () => {
  assert.equal(fmtBid({ value: 7, aggressive: 7 }), "7");
  assert.equal(fmtBid({ value: 7, aggressive: 4 }), "7", "an aggressive bid below the base is not a range");
});

test("fmtBid is empty for a non-FAAB league", () => {
  assert.equal(fmtBid(null), "");
  assert.equal(fmtBid(undefined), "");
  assert.equal(fmtBid({ value: 0, aggressive: 0 }), "");
  assert.equal(fmtBid({}), "");
});

/* ---------------------------------------------------------------- status chip */

test("waiverChipText reads instant for a player nobody just dropped", () => {
  assert.equal(waiverChipText({ status: "free", clearsAt: null }), "Free agent · instant");
  assert.equal(waiverChipText({}), "Free agent · instant", "an unknown status is not a waiver claim");
});

test("waiverChipText carries the clear time and the bid when the league is FAAB", () => {
  const monday = at(2026, 9, 7, 12);
  const row = {
    status: "waivers",
    clearsAt: new Date(at(2026, 9, 9, 3)).toISOString(),
    suggestedBid: { value: 12, aggressive: 18 },
  };
  assert.equal(waiverChipText(row, monday), "Waivers · clears Wed 3 AM · bid 12–18");
});

test("waiverChipText drops the parts a league does not have", () => {
  const monday = at(2026, 9, 7, 12);
  assert.equal(
    waiverChipText({ status: "waivers", clearsAt: new Date(at(2026, 9, 9, 3)).toISOString() }, monday),
    "Waivers · clears Wed 3 AM",
    "no FAAB, no bid",
  );
  assert.equal(
    waiverChipText({ status: "waivers", clearsAt: null, suggestedBid: { value: 5, aggressive: 8 } }, monday),
    "Waivers · bid 5–8",
    "an unknown clear time must not print an empty segment",
  );
  assert.equal(waiverChipText({ status: "waivers" }, monday), "Waivers");
});

/* ---------------------------------------------------------------- alerts status */

test("alertsStatusText reports the three states from design §11.5", () => {
  assert.equal(alertsStatusText(null), "Checking…");
  assert.equal(alertsStatusText({ permission: "default", subscribed: false, pairing: null }), "Off");
  assert.equal(alertsStatusText({ permission: "denied", subscribed: true, pairing: {} }), "Permission denied",
    "a blocked permission outranks a stale pairing");
  assert.equal(
    alertsStatusText({
      permission: "granted",
      subscribed: true,
      pairing: { createdAt: new Date(at(2026, 9, 9, 10)).toISOString() },
    }),
    "On · paired 9/9",
  );
});

test("alertsStatusText survives a pairing with no usable date", () => {
  assert.equal(alertsStatusText({ permission: "granted", subscribed: true, pairing: {} }), "On");
  assert.equal(
    alertsStatusText({ permission: "granted", subscribed: true, pairing: { createdAt: "nonsense" } }),
    "On",
  );
});

test("alertsStatusText is Off when the pairing outlived its subscription", () => {
  assert.equal(
    alertsStatusText({ permission: "granted", subscribed: false, pairing: { createdAt: "2026-09-09T10:00:00Z" } }),
    "Off",
  );
});
