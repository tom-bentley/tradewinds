// Tradewinds — micro-visual primitives (004 design §4, R12 §Q12.3/§Q12.4).
//
// Every function here is PURE: `(data, opts) -> HTML string`. No DOM, no clock, no fetch — so
// the whole vocabulary is testable under `node --test` exactly like format.js is. The rules the
// research pinned, restated so a reader of this file never has to open R12:
//
//   R1  Author in `viewBox` units at a fixed 20-unit week pitch and let the strip scale to the
//       card. A week-12 strip and a week-3 strip therefore have identically sized cells.
//   R2  Furniture (tracks, baselines, midlines) is a hairline with `vector-effect:
//       non-scaling-stroke`; data marks carry no stroke of their own — 3u of air separates them.
//   R3  Tokens only, never a hex: `--mine` over, `--loss` under, `--ink-3` neutral/null,
//       `--ink-2` projection. `--theirs` (amber) is reserved for a counterparty or a caution and
//       never means "medium". `--mine` and `--ok` are perceptual twins under deuteranopia and
//       never appear in one graphic. Colour is always redundant with length, height or position.
//   R4  Zero, bye, DNP and "not played yet" are four different marks, never one gap.
//   R7  `role="img"` + `<title>`/`<desc>` via `aria-labelledby`, plus a table twin. The SVG is
//       one opaque node to assistive tech, so there is nothing to label per cell.
//   R8  No SMIL. `<animate>` slips straight through the stylesheet's reduced-motion block.
//   R9  Same-styled marks collapse into ONE `<path>` of stroked verticals: a 17-week strip is
//       4 mark nodes, not 51. No per-cell listeners — the whole strip is one tap target.
//   R10 Cells are never individually tappable; 17 cells cannot each hold 44 px.
//
// Two documented deviations from R12 §Q12.4, both forced by the "<= 8 element nodes per strip"
// budget that the same section sets:
//   D1  Week-number axis labels and the direct label on the season's best week are HTML siblings
//       of the <svg> (`.mv-axis`, `.mv-peak`), not SVG `<text>`. 5 `<text>` nodes would double
//       the strip's node count, and as HTML they also inherit the app's type scale and can carry
//       a literal "B" under a bye, which R12 §R4 asks for.
//   D2  R12 §R3b's three-stop diverging scale (over / at / under) is applied wherever a number
//       is printed (`signTone`, P6's readout). P1's BARS use the two-stop over/under split that
//       R12 §R9's own 4-node accounting mandates ("one path for at/over, one for under"), so an
//       exactly-on-projection week reads teal rather than grey.

import { escapeHtml, fmtNum, fmtPts, fmtValue, DASH, MINUS } from "./format.js";

/* ------------------------------------------------------------------ geometry + helpers */

/** Week pitch and bar width, shared by P1 and P3 so the two strips align cell-for-cell. */
export const PITCH = 20;
export const BAR = 14;

let seq = 0;
/** Unique-per-instance id stem. Tests pass `uid` explicitly; the app lets it count. */
function uid(prefix, given) {
  if (given != null && given !== "") return `${prefix}-${String(given).replace(/[^\w-]/g, "")}`;
  seq += 1;
  return `${prefix}-${seq}`;
}

/**
 * A finite number, or the fallback. The three explicit rejections matter: `Number(null)` is 0,
 * `Number("")` is 0 and `Number(false)` is 0, so without them a week with no data would draw a
 * bar on the baseline and an absent probability would print "1 %" — exactly the class of bug
 * R12 §R4 exists to prevent (a missing value must never be rendered as a zero).
 */
function fin(v, dflt = null) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function arr(v) { return Array.isArray(v) ? v : []; }

/** 1.234 -> "1.2"; never NaN, never "Infinity". Used for path coordinates. */
function u(n) {
  const v = fin(n, 0);
  return (Math.round(v * 10) / 10).toString();
}

/** A set from anything list-shaped, coerced to numbers. */
function weekSet(v) {
  const s = new Set();
  for (const w of arr(v)) {
    const n = fin(w);
    if (n != null) s.add(n);
  }
  return s;
}

/**
 * The one accessible wrapper every SVG primitive uses (R7). `title` is the graphic's name and
 * `desc` is one sentence of facts — points, weeks, byes — never a characterisation.
 */
function svgWrap({ id, vb, h, cls, title, desc, body, extra = "" }) {
  const t = `${id}-t`;
  const d = `${id}-d`;
  return `<svg class="mv ${cls}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img"
    focusable="false" aria-labelledby="${t} ${d}"${h ? ` style="--mv-h:${h}"` : ""}${extra}>
    <title id="${t}">${escapeHtml(title)}</title><desc id="${d}">${escapeHtml(desc)}</desc>
    ${body}</svg>`;
}

/**
 * One `<path>` of stroked verticals — the whole point of R9. `segs` is `[[x, y1, y2], …]` in
 * viewBox units; an empty list returns "" so the node disappears rather than drawing nothing.
 */
function vpath(segs, cls, width, { cap = "butt", op = null } = {}) {
  if (!segs.length) return "";
  const d = segs.map(([x, y1, y2]) => `M${u(x)} ${u(y1)}V${u(y2)}`).join("");
  return `<path class="${cls}" d="${d}" stroke-width="${width}" stroke-linecap="${cap}"${
    op != null ? ` opacity="${op}"` : ""} fill="none"/>`;
}

/** A hairline rule, drawn at 1 px on every viewport (R2). */
function rule(x1, y, x2, cls = "mv-base") {
  return `<path class="${cls}" d="M${u(x1)} ${u(y)}H${u(x2)}" stroke-width="1"
    vector-effect="non-scaling-stroke" shape-rendering="crispEdges" fill="none"/>`;
}

/** Circles collapsed into one path: a zero-length segment with a round cap is a dot (R9). */
function dots(points, cls, r, { op = null } = {}) {
  if (!points.length) return "";
  const d = points.map(([x, y]) => `M${u(x)} ${u(y)}v0`).join("");
  return `<path class="${cls}" d="${d}" stroke-width="${r * 2}" stroke-linecap="round"${
    op != null ? ` opacity="${op}"` : ""} fill="none"/>`;
}

/** The app's diverging mapper, re-declared here so sparkline.js never imports components.js. */
function tone(n, eps = 0.05) {
  const v = fin(n);
  if (v == null || Math.abs(v) < eps) return "even";
  return v > 0 ? "win" : "loss";
}

/** A whole percent, clamped for display to 1..99 — a model that says "certain" is lying (R6). */
export function pctSafe(v, { clampEnds = true } = {}) {
  const n = fin(v);
  if (n == null) return DASH;
  let p = n * 100;
  if (clampEnds) p = Math.min(99, Math.max(1, p));
  return `${Math.round(p)}%`;
}

/** "wk 7" / "wk 7, 9 and 12" — for a <desc> sentence. */
function listWeeks(ws) {
  const l = [...ws].sort((a, b) => a - b);
  if (!l.length) return "";
  if (l.length === 1) return `week ${l[0]}`;
  return `weeks ${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

/** The shared table-twin shell: a `.mini` table the strip's tap target reveals. */
function twin(caption, head, rows) {
  if (!rows.length) return "";
  return `<table class="mini mv-twin"><caption>${escapeHtml(caption)}</caption>
    <thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="mv-r"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i
      ? `<td class="num">${c == null ? DASH : escapeHtml(String(c))}</td>`
      : `<th scope="row">${escapeHtml(String(c ?? DASH))}</th>`)).join("")}</tr>`).join("")}</tbody></table>`;
}

/**
 * The tap target that opens a strip's table twin (R7, R10). One button, one `data-act`, no
 * listener below it. The twin markup rides along in a `<template>`-shaped hidden node so the
 * view can hand it straight to `openSheet` without rebuilding the numbers.
 */
function tappable(inner, { act, id, label, twinHtml }) {
  // The twin ships either way. With a tap target the view hands it straight to `openSheet`;
  // without one it is still the numbers, one `hidden` attribute from being shown, which is what
  // the dev gallery renders. What it is never is a second copy the caller has to keep in step.
  const twinNode = twinHtml ? `<div class="mv-twin-src" hidden>${twinHtml}</div>` : "";
  if (!act) return `${inner}${twinNode}`;
  return `<button type="button" class="mv-hit" data-act="${escapeHtml(act)}" data-id="${escapeHtml(String(id ?? ""))}"
    aria-label="${escapeHtml(label)}">${inner}</button>${twinNode}`;
}

/* ================================================================== P1 · week strip */

/**
 * Actual points against projection, week by week (R12 §Q12.4 P1).
 *
 * @param {object} o
 * @param {number[]} o.weeks          week numbers, ascending — the strip's x axis
 * @param {(number|null)[]} o.actual  points scored, `null` = not played / no data
 * @param {(number|null)[]} o.projected projected points, `null` = no projection
 * @param {number[]} [o.byeWeeks]     weeks this player's team is on bye
 * @param {number[]} [o.dnpWeeks]     weeks he was rostered but did not play
 * @param {number} [o.min]            shared scale floor (small multiples pass one)
 * @param {number} [o.max]            shared scale ceiling; default `ceil(peak/5)*5`
 * @param {number} [o.currentWeek]    weeks at or after this are "not yet played"
 * @param {string} [o.name]           the player, for the tap target's label
 * @param {object[]} [o.opponents]    optional `[{week, opp}]` for the table twin
 * @returns {string} HTML: `<figure class="mv-week">` with the strip, the axis and the twin
 */
export function weekStrip(o = {}) {
  if (!o || typeof o !== "object") o = {};
  const weeks = arr(o.weeks).map((w) => fin(w)).filter((w) => w != null);
  const act = arr(o.actual);
  const prj = arr(o.projected);
  const byes = weekSet(o.byeWeeks);
  const dnps = weekSet(o.dnpWeeks);
  const cur = fin(o.currentWeek);
  const id = uid("mvw", o.uid);
  const name = o.name ? String(o.name) : "";

  if (!weeks.length) return "";

  // Shared scale. A caller that is drawing small multiples passes {min, max}; a lone strip
  // computes its own from the greater of what happened and what was expected.
  let peak = 0;
  for (let i = 0; i < weeks.length; i += 1) {
    peak = Math.max(peak, fin(act[i], 0), fin(prj[i], 0));
  }
  const min = fin(o.min, 0);
  const max = fin(o.max, Math.max(5, Math.ceil(peak / 5) * 5));
  const span = max - min || 1;

  const W = weeks.length * PITCH;
  const H = 40;
  const TOP = 4;
  const BASE = 34;
  const y = (v) => BASE - ((Math.min(max, Math.max(min, v)) - min) / span) * (BASE - TOP);

  const tracks = [];
  const over = [];
  const under = [];
  const ticks = [];
  const byeDots = [];
  const rows = [];
  let best = null;
  let worst = null;

  weeks.forEach((w, i) => {
    const cx = i * PITCH + PITCH / 2;
    tracks.push([cx, TOP, BASE]);
    const a = fin(act[i]);
    const p = fin(prj[i]);
    const isBye = byes.has(w);
    const isFuture = cur != null && w >= cur;
    const isDnp = dnps.has(w) || (!isBye && !isFuture && a == null);

    if (isBye) {
      byeDots.push([cx, TOP + (BASE - TOP) * 0.6]);
      rows.push([`wk ${w}`, oppOf(o, w), p == null ? null : fmtNum(p), "bye", null]);
      return;
    }
    // A projection tick is drawn for every week we have one for — past or future. On a future
    // week it is the ONLY mark, which is exactly how R4 says "not played yet" should read.
    if (p != null) ticks.push([cx, y(p), y(p) - 2]);

    if (isDnp || (isFuture && a == null)) {
      rows.push([`wk ${w}`, oppOf(o, w), p == null ? null : fmtNum(p), isFuture ? DASH : "did not play", null]);
      return;
    }
    if (a == null) { rows.push([`wk ${w}`, oppOf(o, w), p == null ? null : fmtNum(p), DASH, null]); return; }

    // Zero is a genuine under-performance, not a gap: a 2u stub on the baseline (R4).
    const top = a === 0 ? BASE - 2 : y(a);
    const diff = p == null ? 0 : a - p;
    (diff < -0.05 || a === 0 ? under : over).push([cx, BASE, top]);
    if (best == null || a > best.v) best = { v: a, w, d: diff };
    if (worst == null || a < worst.v) worst = { v: a, w };
    rows.push([`wk ${w}`, oppOf(o, w), p == null ? null : fmtNum(p), fmtNum(a),
      p == null ? null : fmtPts(diff)]);
  });

  const body = [
    vpath(tracks, "mv-track", BAR),
    rule(0, BASE + 0.5, W),
    vpath(over, "mv-over", BAR),
    vpath(under, "mv-under", BAR),
    vpath(ticks, "mv-tick", BAR, { op: 0.8 }),
    dots(byeDots, "mv-null", 1.5, { op: 0.7 }),
  ].filter(Boolean).join("");

  const sentence = [
    `Weeks ${weeks[0]} to ${weeks[weeks.length - 1]}.`,
    best ? `Best ${fmtNum(best.v)} in week ${best.w}${
      Math.abs(best.d) >= 0.05 ? `, ${fmtNum(Math.abs(best.d))} ${best.d > 0 ? "over" : "under"} projection` : ""}.` : "",
    worst && best && worst.w !== best.w ? `Lowest ${fmtNum(worst.v)} in week ${worst.w}.` : "",
    byes.size ? `Bye in ${listWeeks(byes)}.` : "",
  ].filter(Boolean).join(" ");

  const svg = svgWrap({
    id, cls: "mv-week", vb: `0 0 ${W} ${H}`,
    title: "Weekly points against projection",
    desc: sentence,
    body,
  });

  const twinHtml = twin(
    `${name ? `${name} — ` : ""}week by week`,
    ["Week", "Opp", "Proj", "Actual", "Diff"], rows,
  );
  const label = `Open the week-by-week table${name ? ` for ${name}` : ""}`;
  return `<figure class="mv-fig mv-fig-week">
    ${tappable(svg, { act: o.act || null, id: o.id, label, twinHtml })}
    ${weekAxis(weeks, byes, o.axisEvery)}
    ${best ? `<figcaption class="mv-peak">Best <b class="num">${escapeHtml(fmtNum(best.v))}</b> in week ${best.w}${
      o.scaleNote ? ` <span class="dim">· ${escapeHtml(o.scaleNote)}</span>` : ""}</figcaption>` : ""}
  </figure>`;
}

function oppOf(o, w) {
  const row = arr(o.opponents).find((x) => fin(x && x.week) === w);
  return row && row.opp ? String(row.opp) : null;
}

/**
 * The week axis, as HTML rather than SVG `<text>` (deviation D1). Every 4th week is numbered
 * and a bye prints a literal "B", which is what R12 §R4 asks the axis to carry.
 */
function weekAxis(weeks, byes, every = 4) {
  const n = Math.max(1, fin(every, 4));
  return `<div class="mv-axis" aria-hidden="true">${weeks.map((w, i) => {
    const t = byes.has(w) ? "B" : (i % n === 0 || i === weeks.length - 1 ? String(w) : "");
    return `<span class="mv-ax">${escapeHtml(t)}</span>`;
  }).join("")}</div>`;
}

/**
 * P1 as small multiples on ONE shared scale (R12 §Q12.4, "the stack up view"). The scale is
 * stated once above the group and never repeated; past 4 panels the caller falls back to the
 * table twin, so the cap is enforced here rather than trusted to the caller.
 *
 * @param {Array<object>} panels each the argument object `weekStrip` takes, minus {min,max}
 * @param {{cap?:number, unit?:string}} [opts]
 */
export function weekStripGroup(panels, opts = {}) {
  const list = arr(panels).filter(Boolean).slice(0, fin(opts.cap, 4));
  if (!list.length) return "";
  let peak = 0;
  let lo = 0;
  for (const p of list) {
    for (const v of [...arr(p.actual), ...arr(p.projected)]) {
      const n = fin(v);
      if (n != null) { peak = Math.max(peak, n); lo = Math.min(lo, n); }
    }
  }
  const min = Math.min(0, lo);
  const max = Math.max(5, Math.ceil(peak / 5) * 5);
  const unit = opts.unit || "pts";
  return `<div class="mv-multi">
    <p class="mv-scale">All strips ${escapeHtml(String(min))}–${escapeHtml(String(max))} ${escapeHtml(unit)}, one shared scale.</p>
    ${list.map((p) => `<div class="mv-panel">
      ${p.name ? `<p class="mv-panel-n">${escapeHtml(String(p.name))}</p>` : ""}
      ${weekStrip({ ...p, min, max })}
    </div>`).join("")}
  </div>`;
}

/* ================================================================== P2 · usage sparkline */

/**
 * "Is the role growing?" — the one mark allowed in a list row (R12 §Q12.4 P2).
 *
 * @param {object} o
 * @param {number[]} o.weeks     week numbers
 * @param {(number|null)[]} o.values  the share, as a FRACTION (0.68 = 68 %)
 * @param {string} [o.kind]      what the share is of — named in the aria text (S9)
 * @param {number[]} [o.partialWeeks] weeks whose stat line is still filling in (Monday lag)
 * @param {(number|null)[]} [o.second] a second series (sheet only, never a row)
 * @param {string} [o.secondKind]
 * @param {boolean} [o.row]      true = the fixed 56x18 list-row size
 */
export function usageSparkline(o = {}) {
  if (!o || typeof o !== "object") o = {};
  const weeks = arr(o.weeks).map((w) => fin(w)).filter((w) => w != null);
  const vals = arr(o.values).map((v) => fin(v));
  const played = vals.filter((v) => v != null);
  // The row simply omits the sparkline — no placeholder box, no dash (R12 P2 empty state).
  if (weeks.length < 2 || played.length < 2) return "";

  const isRow = o.row !== false && o.row !== undefined ? !!o.row : false;
  const W = isRow ? 56 : 340;
  const H = isRow ? 18 : 44;
  const PAD = isRow ? 3 : 5;
  const id = uid("mvu", o.uid);
  const second = arr(o.second).map((v) => fin(v));
  const hasSecond = !isRow && second.filter((v) => v != null).length >= 2;
  const partial = weekSet(o.partialWeeks);

  // y scaled 0 -> max(series, 0.5) so a 12 % share is not flattered into a full-height line.
  let top = 0.5;
  for (const v of [...vals, ...(hasSecond ? second : [])]) if (v != null) top = Math.max(top, v);
  const x = (i) => PAD + (i / Math.max(1, weeks.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - (Math.min(top, Math.max(0, v)) / top) * (H - PAD * 2);

  const line = (series, cls) => {
    const pts = [];
    series.forEach((v, i) => { if (v != null) pts.push(`${u(x(i))} ${u(y(v))}`); });
    if (pts.length < 2) return "";
    return `<path class="${cls}" d="M${pts.join("L")}" fill="none" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>`;
  };

  const lastIdx = vals.reduce((acc, v, i) => (v != null ? i : acc), -1);
  const mean = played.reduce((a, b) => a + b, 0) / played.length;
  const endPartial = lastIdx >= 0 && partial.has(weeks[lastIdx]);

  const body = [
    rule(PAD, y(mean), W - PAD, "mv-mean"),
    line(vals, "mv-line"),
    hasSecond ? line(second, "mv-line2") : "",
    lastIdx >= 0 ? dots([[x(lastIdx), y(vals[lastIdx])]],
      endPartial ? "mv-dot-partial" : "mv-dot", isRow ? 2 : 3) : "",
  ].filter(Boolean).join("");

  const first = played[0];
  const last = played[played.length - 1];
  const dir = last - first > 0.03 ? "rising" : last - first < -0.03 ? "falling" : "flat";
  const kind = o.kind ? String(o.kind) : "snap share";
  const sentence = `${cap1(kind)} over ${played.length} week${played.length === 1 ? "" : "s"}, ${
    pctSafe(first, { clampEnds: false })} to ${pctSafe(last, { clampEnds: false })}, ${dir}.${
    hasSecond && o.secondKind ? ` Second line: ${o.secondKind}.` : ""}${
    endPartial ? " The latest week is still filling in." : ""}`;

  return svgWrap({
    id, cls: `mv-usage${isRow ? " mv-usage-row" : ""}`, vb: `0 0 ${W} ${H}`,
    title: `${cap1(kind)} trend`, desc: sentence, body,
    extra: isRow ? ` width="${W}" height="${H}"` : "",
  });
}

function cap1(s) { const t = String(s || ""); return t ? t[0].toUpperCase() + t.slice(1) : t; }

/* ================================================================== P3 · matchup strip */

/**
 * Remaining-schedule difficulty (R12 §Q12.4 P3). Deliberately NOT a heat map: R12 §R3a measured
 * that a `--mine` ramp on this surface clears 3:1 only from 58 % alpha up, so a dark-surface
 * heat strip supports three legible steps. Height carries the resolution; the three colour bins
 * are the redundant channel. Bars grow DOWNWARD from the top so the strip reads as the opposite
 * axis to P1 sitting above it, on the same 20u pitch so the cells line up.
 *
 * @param {object} o
 * @param {number[]} o.weeks
 * @param {Array<{bin:number, conf:string, adjusted:boolean, opp?:string, why?:string[]}|null>} o.grades
 * @param {number} [o.currentWeek]
 * @param {number[]} [o.byeWeeks]
 * @param {boolean} [o.compact] advisor-card size
 */
export function matchupStrip(o = {}) {
  if (!o || typeof o !== "object") o = {};
  const weeks = arr(o.weeks).map((w) => fin(w)).filter((w) => w != null);
  const grades = arr(o.grades);
  const byes = weekSet(o.byeWeeks);
  if (!weeks.length || !grades.some((g) => g && fin(g.bin) != null)) return "";

  const id = uid("mvm", o.uid);
  const oppLookup = typeof o.oppOf === "function" ? (w) => o.oppOf(w) || null : () => null;
  const W = weeks.length * PITCH;
  const H = o.compact ? 22 : 32;
  const TOP = 3;
  const FLOOR = H - 3;
  const bins = [[], [], []];   // low / mid / high, three legible steps only (R3a)
  const tracks = [];
  const byeDots = [];
  const rows = [];
  let easiest = null;
  let hardest = null;
  let adjusted = false;
  let anyLowConf = false;

  weeks.forEach((w, i) => {
    const cx = i * PITCH + PITCH / 2;
    tracks.push([cx, TOP, FLOOR]);
    if (byes.has(w)) { byeDots.push([cx, TOP + (FLOOR - TOP) * 0.4]); rows.push([`wk ${w}`, "bye", null, null]); return; }
    const g = grades[i];
    const opp = (g && g.opp) || oppLookup(w);
    const bin = g ? fin(g.bin) : null;
    if (bin == null) { rows.push([`wk ${w}`, opp, DASH, null]); return; }
    const b = Math.min(5, Math.max(1, bin));
    if (g.adjusted) adjusted = true;
    if (g.conf === "low") anyLowConf = true;
    // easier = taller; the bar grows down from the top edge
    const h = (b / 5) * (FLOOR - TOP);
    const slot = b >= 4 ? 2 : b === 3 ? 1 : 0;
    bins[slot].push([cx, TOP, TOP + h]);
    if (easiest == null || b > easiest.b) easiest = { b, w };
    if (hardest == null || b < hardest.b) hardest = { b, w };
    rows.push([`wk ${w}`, opp, `${b} of 5`, g.conf === "low" ? "low" : "high"]);
  });

  const body = [
    vpath(tracks, "mv-track", BAR),
    rule(0, TOP - 0.5, W),
    vpath(bins[0], "mv-bin1", BAR),
    vpath(bins[1], "mv-bin2", BAR),
    vpath(bins[2], "mv-bin3", BAR),
    dots(byeDots, "mv-null", 1.5, { op: 0.7 }),
  ].filter(Boolean).join("");

  const sentence = [
    `Matchup difficulty weeks ${weeks[0]} to ${weeks[weeks.length - 1]}, taller is easier.`,
    easiest ? `Easiest week ${easiest.w}.` : "",
    hardest && easiest && hardest.w !== easiest.w ? `Hardest week ${hardest.w}.` : "",
    byes.size ? `Bye in ${listWeeks(byes)}.` : "",
  ].filter(Boolean).join(" ");

  const svg = svgWrap({
    id, cls: `mv-matchup${o.compact ? " mv-compact" : ""}`, vb: `0 0 ${W} ${H}`,
    title: "Matchup difficulty by week", desc: sentence, body,
  });

  const name = o.name ? String(o.name) : "";
  const twinHtml = twin(`${name ? `${name} — ` : ""}remaining schedule`,
    ["Week", "Opp", "Grade", "Confidence"], rows);

  // R8 §5.4: a skill-position grade is display-only — Sleeper has already priced the defence in.
  const note = !adjusted && anyLowConf
    ? `<p class="mv-note">Already priced in — matchup context moves scoring by under 1 %.</p>`
    : "";

  return `<figure class="mv-fig mv-fig-matchup">
    ${tappable(svg, { act: o.act || null, id: o.id, label: `Open the matchup table${name ? ` for ${name}` : ""}`, twinHtml })}
    ${o.compact ? "" : weekAxis(weeks, byes, o.axisEvery)}
    ${o.compact ? "" : note}
  </figure>`;
}

/**
 * The `.fchip` row R12 P3 asks for above the strip: the next three weeks, named.
 *
 * "BYE" is printed ONLY for a week in `byeWeeks`. The engine's `matchupGrade` returns
 * `{bin, conf, adjusted, why}` and no opponent, so an unknown opponent is an unknown opponent —
 * printing "BYE" for it (which an `opp || "BYE"` fallback would do on every single chip) would
 * be the app inventing a bye week out of a missing field.
 *
 * @param {number[]} weeks
 * @param {Array<{opp?:string}|null>} grades
 * @param {{n?:number, byeWeeks?:number[], oppOf?:(week:number)=>string|null}} [opts]
 */
export function matchupNextChips(weeks, grades, opts = {}) {
  const o = typeof opts === "number" ? { n: opts } : (opts || {});
  const n = fin(o.n, 3);
  const byes = weekSet(o.byeWeeks);
  const oppOf = typeof o.oppOf === "function" ? o.oppOf : () => null;
  const out = [];
  const ws = arr(weeks);
  for (let i = 0; i < ws.length && out.length < n; i += 1) {
    const w = fin(ws[i]);
    if (w == null) continue;
    const g = arr(grades)[i];
    const opp = byes.has(w) ? "BYE" : ((g && g.opp) || oppOf(w) || null);
    out.push(`<span class="fchip mv-chip">WK ${escapeHtml(String(w))}${opp ? ` ${escapeHtml(String(opp))}` : ""}</span>`);
  }
  return out.length ? `<div class="mv-chips">${out.join("")}</div>` : "";
}

/* ================================================================== P4 · availability bar */

/**
 * The prognosis made temporal (R12 §Q12.4 P4). No SVG: a 17-cell grid inside the `.bar-track`
 * the app already ships. Opacity carries P(play) with a 0.35 floor so a bad week is still
 * visible against `--surface2`, and the numbers live in the risk table twin beside it.
 *
 * @param {object} o
 * @param {number[]} o.weeks
 * @param {(number|null)[]} o.pAvailable fractions
 * @param {number[]} [o.decisionWeeks] weeks that are a decision for the manager — amber is
 *        licensed here and only here (R3c: caution is one of its two meanings)
 * @param {number} [o.expectedMissed]
 */
export function availabilityBar(o = {}) {
  if (!o || typeof o !== "object") o = {};
  const weeks = arr(o.weeks).map((w) => fin(w)).filter((w) => w != null);
  const ps = arr(o.pAvailable).map((v) => fin(v));
  if (!weeks.length || !ps.some((p) => p != null)) return "";
  const decisions = weekSet(o.decisionWeeks);

  let lowest = null;
  let firstSafe = null;
  weeks.forEach((w, i) => {
    const p = ps[i];
    if (p == null) return;
    if (lowest == null || p < lowest.p) lowest = { p, w };
    if (firstSafe == null && p >= 0.95) firstSafe = w;
  });

  const cells = weeks.map((w, i) => {
    const p = ps[i];
    if (p == null) return `<i class="mv-av-c mv-av-na" data-w="${escapeHtml(String(w))}"></i>`;
    const op = 0.35 + 0.65 * Math.min(1, Math.max(0, p));
    return `<i class="mv-av-c${decisions.has(w) ? " mv-av-dec" : ""}" style="opacity:${op.toFixed(2)}" data-w="${escapeHtml(String(w))}"></i>`;
  }).join("");

  const label = [
    "Availability by week.",
    firstSafe != null ? `95 % or higher from week ${firstSafe}.` : "",
    lowest ? `Lowest ${pctSafe(lowest.p)} in week ${lowest.w}.` : "",
  ].filter(Boolean).join(" ");

  const missed = fin(o.expectedMissed);
  return `<div class="mv-avail">
    <div class="bar-track mv-av-track" role="img" aria-label="${escapeHtml(label)}"
      style="--mv-n:${weeks.length}">${cells}</div>
    <p class="mv-av-key"><span class="mv-ax">wk ${escapeHtml(String(weeks[0]))}</span>
      ${missed != null ? `<span class="mv-av-x">expected games missed <b class="num">${escapeHtml(fmtNum(missed))}</b> of ${weeks.length}</span>` : ""}
      <span class="mv-ax">wk ${escapeHtml(String(weeks[weeks.length - 1]))}</span></p>
  </div>`;
}

/* ================================================================== P5 · season map */

/**
 * My projected points against the opponent's, week by week, with P(win) underneath
 * (R12 §Q12.4 P5). A dumbbell rather than two lines: two converging 17-point series on 340 u
 * collide exactly where the labels would go. The honest message the research insisted on — that
 * P(win) is compressed into roughly 0.45–0.75 because σ_margin dwarfs any weekly edge — is the
 * caller's line to print; this primitive just never exaggerates the bar.
 *
 * @param {object} o
 * @param {Array<{week:number, pWin:number, strength:string, me:{mean:number},
 *                opp:{mean:number, teamName:string}, isPlayoffWeek:boolean,
 *                scheduleIsProvisional:boolean}>} o.cards
 * @param {number} [o.currentWeek]
 */
export function seasonMap(o = {}) {
  if (!o || typeof o !== "object") o = {};
  const cards = arr(o.cards).filter((c) => c && fin(c.week) != null);
  if (!cards.length) return "";
  const id = uid("mvs", o.uid);
  const cur = fin(o.currentWeek);

  const W = Math.max(cards.length, 1) * PITCH;
  const H = 72;
  const TOP = 5;
  const MID = 42;          // points area bottom / P(win) hairline
  const PBOT = 66;         // P(win) floor
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of cards) {
    for (const v of [fin(c.me && c.me.mean), fin(c.opp && c.opp.mean)]) {
      if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const pad = Math.max(2, (hi - lo) * 0.15);
  const min = lo - pad;
  const span = (hi + pad) - min || 1;
  const y = (v) => MID - 6 - ((v - min) / span) * (MID - 6 - TOP);

  const conn = [];
  const mineD = [];
  const oppD = [];
  const pWin = [];
  const pLoss = [];
  const ring = [];
  const bands = [];
  const rows = [];
  let favoured = 0;
  let against = 0;

  cards.forEach((c, i) => {
    const cx = i * PITCH + PITCH / 2;
    const mine = fin(c.me && c.me.mean);
    const them = fin(c.opp && c.opp.mean);
    if (c.isPlayoffWeek) bands.push(cx);
    if (mine != null && them != null) {
      conn.push([cx, y(mine), y(them)]);
      mineD.push([cx, y(mine)]);
      oppD.push([cx, y(them)]);
    }
    const p = fin(c.pWin);
    if (p != null) {
      const h = Math.min(1, Math.max(0, p)) * (PBOT - MID);
      (p >= 0.5 ? pWin : pLoss).push([cx, MID, MID + h]);
      if (p > 0.5) favoured += 1; else if (p < 0.5) against += 1;
    }
    if (cur != null && fin(c.week) === cur) ring.push([cx, y(mine != null ? mine : 0)]);
    rows.push([`wk ${c.week}${c.isPlayoffWeek ? "*" : ""}`,
      (c.opp && c.opp.teamName) || null,
      mine == null ? null : fmtNum(mine),
      them == null ? null : fmtNum(them),
      p == null ? null : pctSafe(p)]);
  });

  const bandRects = bands.length
    ? `<path class="mv-band" d="${bands.map((cx) => `M${u(cx - PITCH / 2)} ${TOP - 3}h${PITCH}v${PBOT - TOP + 3}h-${PITCH}z`).join("")}" stroke="none"/>`
    : "";

  const body = [
    bandRects,
    // The hairline sits at P = 0.5, not at the top of the band. That is what keeps colour from
    // being the only channel for the sign (R12 §R3d): a bar that stops short of the rule is a
    // week you are behind in, one that crosses it is a week you are ahead in, and the teal/rose
    // fill only reinforces what the length against the reference already said.
    rule(0, MID + (PBOT - MID) / 2, W, "mv-mid"),
    vpath(conn, "mv-conn", 1.5),
    dots(ring, "mv-ring", 5.5),
    dots(oppD, "mv-opp-dot", 3),
    dots(mineD, "mv-mine-dot", 3.5),
    vpath(pWin, "mv-over", BAR),
    vpath(pLoss, "mv-under", BAR),
  ].filter(Boolean).join("");

  const provisional = cards.some((c) => c.scheduleIsProvisional);
  const sentence = `Projected points by week, mine against the opponent, with win probability. ${
    favoured} week${favoured === 1 ? "" : "s"} favoured, ${against} against.${
    provisional ? " Playoff opponents are provisional." : ""}`;

  const svg = svgWrap({
    id, cls: "mv-season", vb: `0 0 ${W} ${H}`,
    title: "Season map", desc: sentence, body,
  });

  const twinHtml = twin("Season map", ["Week", "Opp", "Mine", "Theirs", "P(win)"], rows);
  return `<figure class="mv-fig mv-fig-season">
    ${tappable(svg, { act: o.act || null, id: o.id, label: "Open the week-by-week season table", twinHtml })}
    ${weekAxis(cards.map((c) => fin(c.week)), new Set(), o.axisEvery)}
    <figcaption class="mv-legend"><span class="mv-k mv-k-mine"></span>mine
      <span class="mv-k mv-k-opp"></span>opponent
      <span class="dim">· bars are P(win); the rule is a coin flip</span></figcaption>
  </figure>`;
}

/* ================================================================== P6 · value-gap bullet */

/**
 * Few's bullet graph (R12 §Q12.4 P6), rebuilt from the `.bar-track` / `.bar-fill` / `.bar-mark`
 * trio the app already ships — zero new SVG. Bar = the model's number, tick = the market's.
 * Few's three grey qualitative bands are dropped on purpose: on a 340 px dark card they would be
 * three more surfaces competing with `--surface`, `--surface2` and `--raised`.
 *
 * Markup is span-only so the same string is legal inside the Deals and Free-agent cards, whose
 * whole body is one `<button>` (a `<div>` there would be invalid HTML).
 *
 * @param {object} o
 * @param {number} o.market  the market's price
 * @param {number} o.model   the model's price
 * @param {number} [o.min]   shared scale floor
 * @param {number} [o.max]   shared scale ceiling; default `max(market, model) * 1.1`
 * @param {string} [o.label]
 * @param {boolean} [o.compact] one line, no raw readout — for an Advisor / Deals / FA card
 */
export function valueBullet(o = {}) {
  if (!o || typeof o !== "object") o = {};
  const market = fin(o.market);
  const model = fin(o.model);
  // K/DEF are unpriced by every trade source — the block is omitted, and the sheet already
  // says why (players.js "No market value"). Never draw a bullet against a phantom.
  if (market == null && model == null) return "";
  const lo = fin(o.min, 0);
  const hi = fin(o.max, Math.max(1, (Math.max(market ?? 0, model ?? 0)) * 1.1));
  const span = hi - lo || 1;
  const pos = (v) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));

  const gap = market != null && model != null ? model - market : null;
  const pct = gap != null && market ? (gap / market) * 100 : null;
  const t = tone(gap, Math.max(1, (market || 0) * 0.02));
  const word = pct == null ? "" : pct > 0 ? "undervalued" : pct < 0 ? "overvalued" : "fairly priced";

  const aria = model != null && market != null
    ? `Model value ${fmtValue(model)} against market value ${fmtValue(market)}${
      pct != null ? ` — ${Math.abs(pct).toFixed(0)} percent ${word}` : ""}.`
    : `Model value ${model != null ? fmtValue(model) : "unknown"}, market value ${market != null ? fmtValue(market) : "unknown"}.`;

  const track = `<span class="bar-track mv-bul-track" role="img" aria-label="${escapeHtml(aria)}">
      ${model != null ? `<span class="bar-fill f-mine mv-bul-fill" style="width:${pos(model).toFixed(1)}%"></span>` : ""}
      ${market != null ? `<i class="bar-mark" style="left:${pos(market).toFixed(1)}%"></i>` : ""}
    </span>`;

  if (o.compact) {
    return `<span class="mv-bul mv-bul-c">${track}
      <span class="mv-bul-raw">model <b class="num">${escapeHtml(model != null ? fmtValue(model) : DASH)}</b>
        <span class="dim">vs market</span> <b class="num">${escapeHtml(market != null ? fmtValue(market) : DASH)}</b>${
        pct != null ? ` <b class="num" data-tone="${t}">${pct > 0 ? "+" : MINUS}${Math.abs(pct).toFixed(0)}%</b>` : ""}</span>
    </span>`;
  }

  return `<span class="mv-bul">
      <span class="bar-line"><span class="bar-lab">${escapeHtml(o.label || "Model value")}</span>
        <span class="bar-num num">${escapeHtml(model != null ? fmtValue(model) : DASH)}</span></span>
      ${track}
      <span class="bar-raw">market <b class="num">${escapeHtml(market != null ? fmtValue(market) : DASH)}</b>
        · model <b class="num">${escapeHtml(model != null ? fmtValue(model) : DASH)}</b>${
        pct != null ? ` · <b class="num" data-tone="${t}">${pct > 0 ? "+" : MINUS}${Math.abs(pct).toFixed(0)}%</b> ${escapeHtml(word)}` : ""}</span>
    </span>`;
}

/* ================================================================== P7 · synergy badges */

const SYNERGY_TEXT = {
  handcuff: (p) => `handcuff for ${p.name || "a starter"}`,
  stack: (p) => `stacks with ${p.name || "my QB"}`,
  bye: (p) => (p.week ? `bye clash wk ${p.week}` : "bye clash"),
  bye_clash: (p) => (p.week ? `bye clash wk ${p.week}` : "bye clash"),
  schedule: (p) => `schedule complements ${p.name || "my starter"}`,
  complement: (p) => `schedule complements ${p.name || "my starter"}`,
  scarcity: (p) => `${p.pos || "position"} the wire cannot replace`,
};

/**
 * Handcuff / stack / bye clash / schedule complement, as `.flag` pills (R12 §Q12.4 P7). Pure
 * composition — `flagChips` already does 90 % of this, so the only new thing is the vocabulary.
 * Amber (`.flag-warn`) is used for a bye clash and nothing else: a clash IS caution, which is one
 * of amber's two licensed meanings (R3c). No icons — the word is the signal.
 *
 * @param {Array<{kind:string, delta?:number, reason?:string, name?:string, week?:number, pos?:string}>} parts
 * @param {{max?:number, signed?:boolean}} [opts]
 */
export function synergyBadges(parts, opts = {}) {
  const list = arr(parts).filter((p) => p && p.kind);
  if (!list.length) return "";
  const max = fin(opts.max, 4);
  const sorted = [...list].sort((a, b) => Math.abs(fin(b.delta, 0)) - Math.abs(fin(a.delta, 0)));
  const shown = sorted.slice(0, max);
  const rest = sorted.length - shown.length;
  const chips = shown.map((p) => {
    const kind = String(p.kind);
    const text = (SYNERGY_TEXT[kind] || (() => kind.replace(/_/g, " ")))(p);
    const warn = kind === "bye" || kind === "bye_clash";
    const d = fin(p.delta);
    const tail = opts.signed && d != null && Math.abs(d) >= 0.05
      ? ` ${d > 0 ? "+" : MINUS}${Math.abs(d).toFixed(1)}`
      : "";
    return `<li class="flag${warn ? " flag-warn" : ""}"${p.reason ? ` title="${escapeHtml(String(p.reason))}"` : ""}>
      <span>${escapeHtml(text)}${escapeHtml(tail)}</span></li>`;
  });
  if (rest > 0) chips.push(`<li class="flag flag-info"><span>+${rest} more</span></li>`);
  return `<ul class="flags mv-syn">${chips.join("")}</ul>`;
}

/* ================================================================== P8 · dossier card */

/**
 * Claims plus dated sources (R12 §Q12.4 P8) — the credibility primitive.
 *
 * The hard rule: **no claim renders without a dated source row.** A claim whose `src` index does
 * not resolve to a dated source is dropped, not shown bare. Freshness reuses the header's chip
 * idiom (`.fchip.is-warn` past 72 h), and the engine's `stale` flag — set when the slice has
 * expired or its status key no longer matches the live row — is stated in words, never implied.
 *
 * @param {object|null} slice the `data/dossiers.json` row (as_of, depth, conf, n, flags…)
 * @param {object|null} [full] the lazily fetched `data/dossiers/{id}.json`
 * @param {{now?:number, cap?:number}} [opts]
 */
export function dossierCard(slice, full = null, opts = {}) {
  const s = slice && typeof slice === "object" ? slice : null;
  const f = full && typeof full === "object" ? full : null;
  if (!s && !f) {
    return `<div class="empty mv-dossier-empty"><p class="empty-t">Nothing filed yet</p>
      <p class="empty-b">Reports and their sources land here as they are published.</p></div>`;
  }
  const now = fin(opts.now, Date.now());
  const cap = fin(opts.cap, 3);
  const asOf = (f && f.as_of) || (s && s.as_of) || null;
  const asOfMs = asOf ? Date.parse(asOf) : NaN;
  const ageH = Number.isFinite(asOfMs) ? (now - asOfMs) / 3_600_000 : null;
  const stale = !!(s && (s.stale || arr(s.flags).includes("stale"))) || (ageH != null && ageH > 72);
  const depth = (f && f.depth) || (s && s.depth) || null;
  const conf = (f && f.confidence) || (s && s.conf) || null;
  const n = fin((f && f.consensus && f.consensus.n) ?? (s && s.n) ?? (f && arr(f.fills).length));

  const sources = arr(f && f.sources).filter((x) => x && x.published);
  const byIdx = new Map(sources.map((x) => [fin(x.i), x]));

  // Claims. Each must carry a source index that resolves to a DATED source (the rule above).
  const raw = [];
  for (const m of arr(f && f.matchup_notes)) if (m && m.text) raw.push({ text: m.text, src: fin(m.src) });
  for (const c of arr(f && f.contradictions)) {
    if (c && c.claim) raw.push({ text: `${c.claim} — ${c.resolved || "unresolved"}`, src: fin(c.against_src), warn: true });
  }
  if (f && f.role && f.role.notes) raw.push({ text: f.role.notes, src: fin(f.role.snap_share_trend && f.role.snap_share_trend.src) });
  const claims = raw.filter((c) => byIdx.has(c.src)).slice(0, Math.max(cap, 0));
  const dropped = raw.length - claims.length;

  const srcRows = sources.slice(0, 6).map((x) => {
    const outlet = escapeHtml(String(x.outlet || "source"));
    const date = escapeHtml(String(x.published));
    const href = typeof x.url === "string" && /^https?:\/\//i.test(x.url) ? x.url : null;
    return `<tr><th scope="row">${href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${outlet}</a>`
      : outlet}</th><td class="num">${date}</td></tr>`;
  });

  const meta = [
    depth ? `${escapeHtml(String(depth))} report` : "",
    n != null && n > 0 ? `${n} fill${n === 1 ? "" : "s"}` : "",
    conf ? `${escapeHtml(String(conf))} confidence` : "",
  ].filter(Boolean).join(" · ");

  return `<div class="card mv-dossier">
    <div class="mv-dos-head">
      <p class="mv-dos-m">${meta || "Report"}</p>
      ${stale ? `<span class="fchip is-warn">stale${ageH != null ? ` · ${Math.round(ageH)} h old` : ""}</span>`
        : asOf ? `<span class="fchip">filed ${escapeHtml(String(asOf).slice(0, 10))}</span>` : ""}
    </div>
    ${stale ? `<p class="note note-warn">This report is out of date — the engine is using its own table until a fresh one lands.</p>` : ""}
    ${claims.length ? `<ul class="reasons mv-dos-claims">${claims.map((c) => {
      const src = byIdx.get(c.src);
      return `<li${c.warn ? ` class="mv-dos-warn"` : ""}>${escapeHtml(String(c.text))}
        <span class="mv-dos-src">${escapeHtml(String(src.outlet || "source"))}, ${escapeHtml(String(src.published))}</span></li>`;
    }).join("")}</ul>` : `<p class="note">No claim here carries a dated source yet.</p>`}
    ${dropped > 0 ? `<p class="mv-dos-drop dim">${dropped} further note${dropped === 1 ? "" : "s"} withheld — no dated source.</p>` : ""}
    ${srcRows.length ? `<table class="mini mv-dos-srcs"><caption>Sources</caption><tbody>${srcRows.join("")}</tbody></table>` : ""}
  </div>`;
}
