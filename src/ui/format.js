// Tradewinds — pure display formatters. No DOM, no clock reads without an explicit `now`.
// Every function is total: bad input returns the em-dash placeholder rather than throwing.

export const DASH = "—"; // —
export const MINUS = "−"; // − (true minus, aligns with tabular-nums)

const NUM = new Intl.NumberFormat("en-US");

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 10274 -> "10.3k" · 880 -> "880" · -1240 -> "−1.2k" · null -> "—" */
export function fmtValue(v) {
  const n = num(v);
  if (n === null) return DASH;
  const a = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  if (a < 1000) return sign + String(Math.round(a));
  if (a < 100000) return sign + (a / 1000).toFixed(1).replace(/\.0$/, ".0") + "k";
  return sign + Math.round(a / 1000) + "k";
}

/** Full-precision value with thousands separators: 10274 -> "10,274" */
export function fmtFull(v) {
  const n = num(v);
  return n === null ? DASH : NUM.format(Math.round(n));
}

/** Edge percentage. 12.43 -> "+12%" · -3.2 -> "−3%" · 0 -> "0%" */
export function fmtPct(v, digits = 0) {
  const n = num(v);
  if (n === null) return DASH;
  const r = Number(n.toFixed(digits));
  if (r === 0) return "0%";
  return (r > 0 ? "+" : MINUS) + Math.abs(r).toFixed(digits) + "%";
}

/** Points, always signed: 1.53 -> "+1.5" · -0.04 -> "0.0" · null -> "—" */
export function fmtPts(v, digits = 1) {
  const n = num(v);
  if (n === null) return DASH;
  const r = Number(n.toFixed(digits));
  if (r === 0) return (0).toFixed(digits);
  return (r > 0 ? "+" : MINUS) + Math.abs(r).toFixed(digits);
}

/** Unsigned points: 12.34 -> "12.3" */
export function fmtNum(v, digits = 1) {
  const n = num(v);
  return n === null ? DASH : n.toFixed(digits);
}

/** 0.9827 or 98.27 -> "98%" — tolerates roster-percent given as a fraction or a percent. */
export function fmtRosterPct(v) {
  const n = num(v);
  if (n === null) return DASH;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct) + "%";
}

const MS = { m: 60000, h: 3600000, d: 86400000 };

/** "just now" · "12m ago" · "3h ago" · "2d ago" · "Sep 2" */
export function relTime(iso, now = Date.now()) {
  const t = toMs(iso);
  if (t === null) return DASH;
  const d = now - t;
  if (d < 0) return "just now";
  if (d < MS.m) return "just now";
  if (d < MS.h) return Math.floor(d / MS.m) + "m ago";
  if (d < MS.d) return Math.floor(d / MS.h) + "h ago";
  if (d < 7 * MS.d) return Math.floor(d / MS.d) + "d ago";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Local wall clock, 24h-agnostic: "12:04 PM" -> "12:04" */
export function clockTime(iso) {
  const t = toMs(iso);
  if (t === null) return DASH;
  const d = new Date(t);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function toMs(iso) {
  if (iso == null) return null;
  if (typeof iso === "number") return Number.isFinite(iso) ? iso : null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "Amon-Ra St. Brown" -> "AS" · "hobbezilla" -> "HO" · "" -> "?" */
export function initials(name) {
  const s = String(name ?? "").trim();
  if (!s) return "?";
  const words = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  // "?" and emoji-only team names split to nothing — viewer mode renders an empty avatar rather
  // than throwing on words[0].
  if (!words.length) return "?";
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape for interpolation into HTML strings (player names carry apostrophes). */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENT[c]);
}

/** "QB" | "RB2" style position rank, or the bare position when rank is unknown. */
export function posRankLabel(pos, posRank) {
  const p = String(pos ?? "").toUpperCase();
  const n = num(posRank);
  return n === null ? p : p + Math.round(n);
}

/** Truncate for a fixed-width chip without breaking mid-entity. */
export function clip(s, max = 18) {
  const t = String(s ?? "");
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Sort helper: descending by numeric field, nulls last. */
export function byDesc(get) {
  return (a, b) => {
    const x = num(get(a)),
      y = num(get(b));
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
}

/**
 * Map the engine's rival-acceptance tier to a phrase + CSS tone class.
 * Falls back to the boolean `acceptLikely` for older result objects.
 *
 * The long form always names the side being asked to accept: with no `names` it keeps the
 * second-person wording, with `names` from `sideNames()` it says "speckledorf would likely
 * accept" — the acceptance line is the one place a third-party trade must never say "they".
 * @param {{acceptance?: string, acceptLikely?: boolean}} verdict
 * @param {{b?: string}} [names] side names from the engine's `sideNames(ctx, aId, bId)`
 * @returns {{tier: string, short: string, long: string, cls: string}}
 */
export function acceptPhrase(verdict = {}, names = null) {
  const tier = verdict.acceptance || (verdict.acceptLikely ? "likely" : "unlikely");
  const b = names && names.b ? String(names.b) : null;
  const long = (withName, plain) => (b ? `${b} ${withName}` : plain);
  if (tier === "likely") {
    return { tier, short: "likely accepts", long: long("would likely accept", "They'd likely accept"), cls: "yes" };
  }
  if (tier === "possible") {
    return { tier, short: "might accept", long: long("might accept", "They might accept"), cls: "maybe" };
  }
  return { tier, short: "unlikely to accept", long: long("would likely decline", "They'd likely decline"), cls: "no" };
}

/* ---------------------------------------------------------------- league shape */

/** numQbs = QB slots + SUPER_FLEX slots (design §10.2). Unknown input reads as 1QB. */
export function numQbsOf(rosterPositions) {
  const list = Array.isArray(rosterPositions) ? rosterPositions : [];
  let n = 0;
  for (const slot of list) {
    const s = String(slot ?? "").toUpperCase();
    if (s === "QB" || s === "SUPER_FLEX" || s === "SUPERFLEX") n += 1;
  }
  return n >= 2 ? n : 1;
}

/** "1QB" / "2QB" — anything above two QB slots still reads as 2QB (superflex market). */
export function qbLabel(rosterPositions) {
  return numQbsOf(rosterPositions) >= 2 ? "2QB" : "1QB";
}

/** Reception points snapped to the three markets FantasyCalc and Boris Chen publish. */
export function pprOf(scoringSettings) {
  const rec = Number(scoringSettings?.rec);
  if (!Number.isFinite(rec) || rec <= 0.25) return 0;
  if (rec < 0.75) return 0.5;
  return 1;
}

/** "PPR 0" / "PPR 0.5" / "PPR 1" */
export function pprLabel(scoringSettings) {
  return "PPR " + pprOf(scoringSettings);
}

/**
 * One-line shape of a Sleeper league, for the onboarding rows and Settings.
 * Accepts a raw Sleeper league object or the engine's `ctx.league`.
 * @returns {string} e.g. "8 teams · 1QB · PPR 0.5"
 */
export function leagueShape(league) {
  const rp = league?.roster_positions || league?.rosterPositions;
  const sc = league?.scoring_settings || league?.scoring;
  const teams = league?.total_rosters ?? league?.numTeams ?? league?.settings?.num_teams;
  const bits = [];
  if (Number.isFinite(Number(teams))) bits.push(`${Number(teams)} teams`);
  bits.push(qbLabel(rp));
  bits.push(pprLabel(sc));
  return bits.join(" · ");
}

/** "hobbezilla" -> "hobbezilla's" · "Travis" -> "Travis's" · "Bucs" -> "Bucs'" */
export function possessive(name) {
  const s = String(name ?? "").trim();
  if (!s) return "Their";
  return /s$/i.test(s) ? s + "'" : s + "'s";
}

/* ---------------------------------------------------------------- waivers */

/**
 * When a waiver claim clears, in the shortest form that is still unambiguous on a chip:
 * "Wed 3 AM" · "today 3 AM" when it is the same calendar day. Bad input -> "".
 * @param {string|number|null} iso
 * @param {number} [now]
 */
export function fmtClears(iso, now = Date.now()) {
  const t = toMs(iso);
  if (t === null) return "";
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const clock = m ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
  const nd = new Date(now);
  const sameDay = d.getFullYear() === nd.getFullYear() && d.getMonth() === nd.getMonth() && d.getDate() === nd.getDate();
  if (sameDay) return `today ${clock}`;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
}

/** "12–18" from `{ value, aggressive }`, or "" when the league is not FAAB. */
export function fmtBid(bid) {
  if (!bid) return "";
  const v = Number(bid.value);
  const a = Number(bid.aggressive);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (!Number.isFinite(a) || a <= v) return String(Math.round(v));
  return `${Math.round(v)}–${Math.round(a)}`;
}

/**
 * The free-agent status chip's text (design §11.5). Teal "instant" or amber "waivers", with the
 * clear time and the suggested FAAB range when the league has them.
 * @param {{status?: string, clearsAt?: string|number|null, suggestedBid?: object|null}} row
 * @param {number} [now]
 * @returns {string}
 */
export function waiverChipText(row = {}, now = Date.now()) {
  if (row.status !== "waivers") return "Free agent · instant";
  const bits = ["Waivers"];
  const clears = fmtClears(row.clearsAt, now);
  if (clears) bits.push("clears " + clears);
  const bid = fmtBid(row.suggestedBid);
  if (bid) bits.push("bid " + bid);
  return bits.join(" · ");
}

/**
 * The Settings → Alerts status line: "Off" · "On · paired 9/9" · "Permission denied".
 * @param {{permission?: string, subscribed?: boolean, pairing?: object|null}|null} status
 * @returns {string}
 */
export function alertsStatusText(status) {
  if (!status) return "Checking…";
  if (status.permission === "denied") return "Permission denied";
  if (!status.subscribed || !status.pairing) return "Off";
  const t = toMs(status.pairing.createdAt);
  if (t === null) return "On";
  const d = new Date(t);
  return `On · paired ${d.getMonth() + 1}/${d.getDate()}`;
}
