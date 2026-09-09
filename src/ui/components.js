// Tradewinds — shared render helpers. Functions return HTML strings unless named `mount*`.
// Sheets and toasts own real DOM because they manage focus.

import {
  escapeHtml, fmtValue, fmtFull, fmtPct, fmtPts, initials, clip, posRankLabel, fmtRosterPct,
} from "./format.js";
import { SLEEPER } from "../config.js";

/* ------------------------------------------------------------------ icons */

const ICONS = {
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  search: '<circle cx="9" cy="9" r="6"/><path d="M13.5 13.5L18 18"/>',
  refresh: '<path d="M17 10a7 7 0 1 1-2.1-5"/><path d="M17 3v4h-4"/>',
  chevron: '<path d="M7 4l6 6-6 6"/>',
  star: '<path d="M10 2.5l2.3 4.9 5.2.7-3.8 3.7 1 5.2-4.7-2.6-4.7 2.6 1-5.2L2.5 8.1l5.2-.7z"/>',
  warn: '<path d="M10 3l7.5 13.5h-15z"/><path d="M10 8.5v3.5M10 14.4v.2"/>',
};

export function icon(name, cls = "") {
  const d = ICONS[name];
  if (!d) return "";
  return `<svg class="ic ${cls}" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

/* ------------------------------------------------------------------ avatars */

export function avatar(roster, size = 34) {
  const name = roster?.teamName || roster?.displayName || "?";
  const src = roster?.avatar ? SLEEPER.avatar(roster.avatar) : "";
  const ini = escapeHtml(initials(name));
  const st = `width:${size}px;height:${size}px`;
  if (!src) return `<span class="av" style="${st}" aria-hidden="true">${ini}</span>`;
  // The initials sit behind the image; on a 404 we only hide the image (removing it first
  // would null out parentNode inside the handler).
  return `<span class="av" style="${st}" aria-hidden="true"><i>${ini}</i><img src="${escapeHtml(src)}" alt="" loading="lazy"
    onerror="this.style.display='none'"></span>`;
}

export function teamName(roster) {
  return escapeHtml(roster?.teamName || roster?.displayName || `Roster ${roster?.rosterId ?? "?"}`);
}

/* ------------------------------------------------------------------ players */

const OUTISH = new Set(["Out", "IR", "PUP", "Sus", "DNR", "NA", "Doubtful"]);

export function injuryTag(inj) {
  if (!inj) return "";
  const short = { Questionable: "Q", Doubtful: "D", Out: "OUT", IR: "IR", PUP: "PUP", Sus: "SUS", NA: "NA", DNR: "DNR" }[inj] || inj;
  const sev = OUTISH.has(inj) ? "bad" : "warn";
  return `<span class="tag tag-${sev}" title="${escapeHtml(inj)}">${escapeHtml(short)}</span>`;
}

/**
 * A selectable roster row for the Analyze columns.
 * mv may be null (K/DEF or unpriced) — the row then reads "no market value".
 */
export function playerRow(ctx, id, { side, selected, mv, compact = false }) {
  const p = ctx.players.get(id) || { id, name: id, pos: "", team: "" };
  const val = mv && mv.m != null ? fmtValue(mv.m) : "—";
  const bye = ctx.byes && p.team ? ctx.byes[p.team] : null;
  const byeTag = bye ? `<span class="tag tag-mute">bye ${bye}</span>` : "";
  return `<button type="button" class="prow${selected ? " is-sel" : ""}" data-act="pick" data-side="${side}" data-id="${escapeHtml(id)}"
    aria-pressed="${selected ? "true" : "false"}">
    <span class="prow-main">
      <span class="prow-name">${escapeHtml(clip(p.name, compact ? 15 : 20))}</span>
      <span class="prow-meta">${escapeHtml(p.pos || "")}<span class="dim">${escapeHtml(p.team ? " " + p.team : "")}</span>${injuryTag(p.inj)}${compact ? "" : byeTag}</span>
    </span>
    <span class="prow-val num">${val}</span>
  </button>`;
}

/** Compact non-interactive chip used in deal cards and the verdict panel. */
export function playerChip(ctx, id, side, mv) {
  const p = ctx.players.get(id) || { id, name: id, pos: "", team: "" };
  const v = mv && mv.m != null ? fmtValue(mv.m) : "—";
  return `<span class="chip chip-${side}"><span class="chip-name">${escapeHtml(clip(p.name, 17))}</span>
    <span class="chip-pos">${escapeHtml(p.pos || "")}</span><span class="chip-val num">${v}</span></span>`;
}

export function positionGroups(ctx, ids, order = ["QB", "RB", "WR", "TE", "K", "DEF"]) {
  const groups = new Map(order.map((p) => [p, []]));
  for (const id of ids) {
    const pos = ctx.players.get(id)?.pos || "?";
    if (!groups.has(pos)) groups.set(pos, []);
    groups.get(pos).push(id);
  }
  return [...groups.entries()].filter(([, list]) => list.length);
}

/* ------------------------------------------------------------------ verdict */

export const VERDICT_LABEL = {
  steal: "Steal", clear_win: "Clear win", slight_win: "Slight win", fair: "Fair",
  slight_loss: "Slight loss", clear_loss: "Clear loss", fleeced: "Fleeced",
  invalid: "Invalid", needs_drop: "Needs a drop",
};

export const VERDICT_TONE = {
  steal: "win", clear_win: "win", slight_win: "win-dim", fair: "even",
  slight_loss: "loss-dim", clear_loss: "loss", fleeced: "loss",
  invalid: "block", needs_drop: "block",
};

export function verdictTone(code) {
  return VERDICT_TONE[code] || "even";
}

export function verdictWord(v) {
  const code = v?.code || "fair";
  // Long engine labels ("Requires dropping X", "Invalid — X is not …") carry their detail in the
  // flag chips and headline; the big word stays short so the panel never wraps three lines.
  const SHORT = { needs_drop: "Needs a drop", invalid: "Invalid" };
  const label = SHORT[code] || v?.label || VERDICT_LABEL[code] || "Fair";
  return `<span class="verdict-word" data-tone="${verdictTone(code)}">${escapeHtml(label)}</span>`;
}

/**
 * Opposed value bars. Both sides share one scale; the winning bar carries a parity hairline
 * at the losing side's length, so the surplus edge reads as a notch rather than only a number.
 */
export function valueBars(me) {
  const gs = num(me?.valueGive?.surplus), ns = num(me?.valueGet?.surplus);
  const gr = num(me?.valueGive?.raw), nr = num(me?.valueGet?.raw);
  const max = Math.max(gs, ns, 1);
  const gp = (gs / max) * 100, np = (ns / max) * 100;
  const markGive = gs > ns ? `<i class="bar-mark" style="left:${np}%"></i>` : "";
  const markGet = ns > gs ? `<i class="bar-mark" style="left:${gp}%"></i>` : "";
  return `<div class="bars">
    <div class="bar-line"><span class="bar-lab"><i class="dot theirs"></i>You give</span><span class="bar-num num">${fmtFull(gs)}</span></div>
    <div class="bar-track"><div class="bar-fill f-theirs" style="width:${gp}%"></div>${markGive}</div>
    <div class="bar-line"><span class="bar-lab"><i class="dot mine"></i>You get</span><span class="bar-num num">${fmtFull(ns)}</span></div>
    <div class="bar-track"><div class="bar-fill f-mine" style="width:${np}%"></div>${markGet}</div>
    <p class="bar-raw">raw <span class="num">${fmtFull(gr)}</span> against <span class="num">${fmtFull(nr)}</span></p>
  </div>`;
}

function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

export function bestBadge(ctx, best, mv) {
  if (!best || !best.id) return "";
  const p = ctx.players.get(best.id);
  if (!p) return "";
  const side = best.side === "me" ? "mine" : "theirs";
  const who = best.side === "me" ? "you get him" : "they get him";
  const tier = mv && mv.tier ? ` · tier ${mv.tier}` : "";
  return `<p class="best best-${side}">${icon("star", "ic-star")}<strong>${escapeHtml(p.name)}</strong>
    <span class="dim">${escapeHtml(posRankLabel(p.pos, mv && mv.posRank))}${escapeHtml(tier)}</span>
    is the best player in the deal — ${who}.</p>`;
}

/** Short labels for info-level flags: the panel shows the signal, Details carries the sentence. */
const FLAG_LABEL = {
  injury: "injury", bye: "bye clash", deadline: "deadline", roster_size: "roster size",
  coverage: "thin pricing", short: "lineup gap", unsettled: "unsettled price",
  free_elsewhere: "free elsewhere", trend: "market moving",
};

export function flagChips(flags) {
  if (!flags || !flags.length) return "";
  const rank = { block: 0, warn: 1, info: 2 };
  const loud = flags.filter((f) => f.severity === "block" || f.severity === "warn")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  // Blocks and warnings say the whole thing; notes collapse to one counted chip per kind.
  const quiet = new Map();
  for (const f of flags) {
    if (f.severity === "block" || f.severity === "warn") continue;
    const k = f.type || "note";
    quiet.set(k, (quiet.get(k) || 0) + 1);
  }
  const out = [
    ...loud.map((f) => `<li class="flag flag-${escapeHtml(f.severity)}">${icon("warn")}<span>${escapeHtml(f.text)}</span></li>`),
    ...[...quiet].map(([k, n]) => `<li class="flag flag-info"><span>${escapeHtml(FLAG_LABEL[k] || k)}${n > 1 ? ` ×${n}` : ""}</span></li>`),
  ];
  return `<ul class="flags">${out.join("")}</ul>`;
}

/** "+14%" / "+2.1 pts/wk" / "+2.8 playoffs" stat strip. */
export function statStrip(v) {
  return `<div class="stats">
    <div class="stat"><span class="stat-k">Edge</span><span class="stat-v num" data-tone="${signTone(v?.edgePct, 0.5)}">${fmtPct(v?.edgePct)}</span></div>
    <div class="stat"><span class="stat-k">Starters</span><span class="stat-v num" data-tone="${signTone(v?.deltaPerWeek)}">${fmtPts(v?.deltaPerWeek)}</span><span class="stat-u">pts/wk</span></div>
    <div class="stat"><span class="stat-k">Weeks 15–17</span><span class="stat-v num" data-tone="${signTone(v?.deltaPlayoffPerWeek)}">${fmtPts(v?.deltaPlayoffPerWeek)}</span><span class="stat-u">pts/wk</span></div>
  </div>`;
}

export function signTone(n, eps = 0.05) {
  if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) < eps) return "even";
  return n > 0 ? "win" : "loss";
}

/* ------------------------------------------------------------------ misc bits */

export function skeleton(rows = 4, cls = "sk-card") {
  return `<div class="sk-wrap" aria-hidden="true">${Array.from({ length: rows }, () => `<div class="${cls}"></div>`).join("")}</div>`;
}

export function empty(title, body, action) {
  return `<div class="empty"><p class="empty-t">${escapeHtml(title)}</p><p class="empty-b">${escapeHtml(body)}</p>${
    action ? `<button type="button" class="btn" data-act="${escapeHtml(action.act)}">${escapeHtml(action.label)}</button>` : ""
  }</div>`;
}

export function sectionHead(title, right = "") {
  return `<div class="sec-head"><h2>${escapeHtml(title)}</h2>${right}</div>`;
}

export function trendArrow(t) {
  if (typeof t !== "number" || !Number.isFinite(t) || Math.abs(t) < 1) return `<span class="trend even">flat</span>`;
  const up = t > 0;
  return `<span class="trend ${up ? "win" : "loss"}">${up ? "▲" : "▼"} ${fmtValue(Math.abs(t))}</span>`;
}

export function rosterPctWarning(mv) {
  const rp = mv?.rosterPct;
  if (typeof rp !== "number") return "";
  const pct = rp <= 1 ? rp * 100 : rp;
  if (pct >= 50) return "";
  return `<p class="note note-warn">Rostered in only ${fmtRosterPct(rp)} of leagues — probably free on your wire.</p>`;
}

/* ------------------------------------------------------------------ sheet */

let sheetStack = [];

export function openSheet({ title, body, onMount, onClose }) {
  const host = document.getElementById("sheet-host");
  const opener = document.activeElement;
  host.hidden = false;

  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet-scrim" data-act="close-sheet"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="sheet-head">
        <h2 class="sheet-title">${escapeHtml(title)}</h2>
        <button type="button" class="icon-btn sheet-x" data-act="close-sheet" aria-label="Close">${icon("close")}</button>
      </header>
      <div class="sheet-body">${body}</div>
    </section>`;
  host.appendChild(wrap);

  const close = () => {
    wrap.removeEventListener("keydown", onKey);
    wrap.remove();
    sheetStack = sheetStack.filter((s) => s !== close);
    if (!host.children.length) host.hidden = true;
    if (opener && opener.isConnected) opener.focus();
    onClose && onClose();
  };

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...wrap.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  wrap.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (t && t.dataset.act === "close-sheet") { e.preventDefault(); close(); }
  });

  sheetStack.push(close);
  wrap.querySelector(".sheet-x").focus();
  onMount && onMount(wrap.querySelector(".sheet-body"), close);
  return close;
}

export function closeTopSheet() {
  const fn = sheetStack[sheetStack.length - 1];
  if (fn) fn();
}

/** Any route change closes open sheets — an iOS back-swipe must never leave one stranded. */
export function closeAllSheets() {
  while (sheetStack.length) sheetStack[sheetStack.length - 1]();
}

/* ------------------------------------------------------------------ toast */

export function toast(message, { action, onAction, timeout = 4000, tone = "" } = {}) {
  const host = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast" + (tone ? " toast-" + tone : "");
  el.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span>${
    action ? `<button type="button" class="toast-act">${escapeHtml(action)}</button>` : ""
  }<button type="button" class="toast-x" aria-label="Dismiss">${icon("close")}</button>`;
  host.appendChild(el);
  let timer = null;
  const kill = () => { if (timer) clearTimeout(timer); el.remove(); };
  el.querySelector(".toast-x").addEventListener("click", kill);
  const act = el.querySelector(".toast-act");
  if (act) act.addEventListener("click", () => { kill(); onAction && onAction(); });
  if (timeout > 0) timer = setTimeout(kill, timeout);
  return kill;
}

/** Clipboard with a synchronous fallback for older iOS Safari. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ theme */

export const THEMES = ["dark", "system", "light"];

export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return THEMES.includes(t) ? t : "dark";
}

export function resolvedTheme() {
  const t = currentTheme();
  if (t !== "system") return t;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setTheme(v) {
  if (!THEMES.includes(v)) return;
  document.documentElement.dataset.theme = v;
  try { localStorage.setItem("tradewinds.theme", v); } catch { /* private mode */ }
  syncThemeColor();
}

export function syncThemeColor() {
  const meta = document.getElementById("meta-theme");
  if (meta) meta.setAttribute("content", resolvedTheme() === "light" ? "#F3F6FC" : "#0B1220");
}

matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (currentTheme() === "system") syncThemeColor();
});
syncThemeColor();
