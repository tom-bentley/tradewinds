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
 * @param {{acceptance?: string, acceptLikely?: boolean}} verdict
 * @returns {{tier: string, short: string, long: string, cls: string}}
 */
export function acceptPhrase(verdict = {}) {
  const tier = verdict.acceptance || (verdict.acceptLikely ? "likely" : "unlikely");
  if (tier === "likely") return { tier, short: "likely accepts", long: "They'd likely accept", cls: "yes" };
  if (tier === "possible") return { tier, short: "might accept", long: "They might accept", cls: "maybe" };
  return { tier, short: "unlikely to accept", long: "They'd likely decline", cls: "no" };
}
