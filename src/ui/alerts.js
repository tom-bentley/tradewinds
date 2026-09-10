// Tradewinds — Settings → Alerts (design §11.5).
//
// There is no server, so "turn on alerts" is really "pair this device with the GitHub Action
// that sends them": the app produces a pairing code and the code is pasted once into the
// repository secret `PUSH_SUBSCRIPTIONS`. Everything below exists to make that one paste
// obvious, and to say plainly why the button is disabled when iOS has not installed the app.

import { store, setIn } from "./store.js";
import { toast, openSheet, copyText, skeleton } from "./components.js";
import { escapeHtml, fmtNum, alertsStatusText } from "./format.js";

const REPO = "https://github.com/tom-bentley/tradewinds";
export const SECRETS_URL = `${REPO}/settings/secrets/actions`;
export const ACTIONS_URL = `${REPO}/actions/workflows/alerts.yml`;

/**
 * The one reason the design writes out verbatim (§11.5): on a Safari TAB the honest answer is
 * not "unsupported", it is "install it first". Every other reason comes from push.js's own
 * `reasonText`, which is the module that knows what it just refused.
 */
export const REASON_TEXT = {
  "not-installed":
    "Alerts only work from the Home Screen app. In Safari tap Share → Add to Home Screen, " +
    "then open Tradewinds from the icon.",
};

const FALLBACK_REASON_TEXT = {
  unsupported: "This browser cannot receive push notifications.",
  denied:
    "Notifications are blocked for Tradewinds. Turn them back on in Settings → Notifications " +
    "→ Tradewinds, then try again.",
  insecure: "Alerts need a secure (https) connection.",
};

// Advice leads: it is the only alert that arrives because something HAPPENED to a player of
// mine, and it is the one the job sends first when the per-run cap bites (design §12.1).
const PREF_TOGGLES = [
  { key: "advice", label: "Advice on my players' news", help: "A status change on someone you roster, with the move it calls for." },
  { key: "rivalNews", label: "Rivals' injury news", help: "The same for players other teams roster. Interesting, rarely actionable." },
  { key: "trades", label: "New trades in the league", help: "Someone in the league completes a trade." },
  { key: "deals", label: "New deals worth proposing", help: "The finder turns up an offer above your score floor." },
  { key: "freeAgents", label: "Free agents worth a drop", help: "The wire beats a player you are rostering." },
];

const PREF_NUMBERS = [
  { key: "minDealScore", label: "Minimum deal score", min: 0, max: 10, step: 0.5, help: "Below this a new offer stays quiet." },
  { key: "minFaGain", label: "Minimum free-agent gain", min: 0, max: 5, step: 0.1, unit: "pts/wk", help: "Below this a wire pickup stays quiet." },
];

const DEFAULT_PREFS = {
  advice: true, rivalNews: false, trades: true, deals: true, freeAgents: true,
  minDealScore: 2, minFaGain: 1,
};

/**
 * How long an alert really takes, said plainly (design §12.1). GitHub runs `schedule` workflows
 * when it has capacity — measured 120–309 minutes apart for a ten-minute cron on this repo —
 * so a promise of "within 30 minutes" would be a promise the app cannot keep.
 */
export const CADENCE_NOTE =
  "Alerts usually arrive within 10–30 minutes; GitHub can delay scheduled runs.";

let env = null;

/* ---------------------------------------------------------------- status */

function reasonTextOf(reason) {
  if (!reason) return "";
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  try {
    const fromPush = env && env.svc.reasonText && env.svc.reasonText(reason);
    if (fromPush) return fromPush;
  } catch { /* fall through */ }
  return FALLBACK_REASON_TEXT[reason] || String(reason);
}

/** "Off" · "On · paired 9/9" · "Permission denied" (design §11.5). Shaped in format.js so it
 *  can be unit-tested without a DOM. */
export const statusLine = alertsStatusText;

const prefsOf = (status) => ({ ...DEFAULT_PREFS, ...(status?.pairing?.prefs || {}) });

/* ---------------------------------------------------------------- render */

/** The whole card body. `store.alerts.status` is null until the async probe answers. */
export function alertsCard() {
  const st = store.alerts.status;
  if (!st) return `<div class="card">${skeleton(1, "sk-row")}</div>`;

  const on = st.subscribed && !!st.pairing;
  const blocked = !st.supported;
  const reason = blocked ? reasonTextOf(st.reason) : "";
  const prefs = prefsOf(st);
  const tone = st.permission === "denied" ? "bad" : on ? "ok" : "mute";

  return `<div class="card alerts">
    <div class="al-top">
      <span class="dot ${tone === "ok" ? "ok" : tone === "bad" ? "bad" : ""}"></span>
      <p class="al-status">${escapeHtml(statusLine(st))}</p>
      ${on ? `<span class="tag tag-mute">${escapeHtml(st.pairing.label || "this device")}</span>` : ""}
    </div>

    ${on ? "" : `<button type="button" class="btn" data-act="al-enable"${blocked ? " disabled aria-disabled=\"true\"" : ""}>
      ${store.alerts.busy ? "Asking…" : "Enable alerts"}</button>`}
    ${reason ? `<p class="note note-warn" id="al-reason">${escapeHtml(reason)}</p>` : ""}
    ${store.alerts.error && !reason ? `<p class="note note-warn">${escapeHtml(store.alerts.error)}</p>` : ""}

    ${on ? `<div class="al-prefs">
      ${PREF_TOGGLES.map((t) => `<label class="swrow">
        <span class="swrow-t"><span class="swrow-l">${escapeHtml(t.label)}</span>
          <span class="swrow-h">${escapeHtml(t.help)}</span></span>
        <input type="checkbox" class="sw" data-pref="${t.key}"${prefs[t.key] ? " checked" : ""}>
      </label>`).join("")}
      ${PREF_NUMBERS.map((n) => `<label class="nrow">
        <span class="swrow-t"><span class="swrow-l">${escapeHtml(n.label)}</span>
          <span class="swrow-h">${escapeHtml(n.help)}</span></span>
        <span class="nrow-in"><input type="number" class="nin num" data-pref="${n.key}" inputmode="decimal"
          min="${n.min}" max="${n.max}" step="${n.step}" value="${escapeHtml(fmtNum(Number(prefs[n.key]), n.step >= 1 ? 0 : 1))}">
          ${n.unit ? `<span class="nrow-u">${escapeHtml(n.unit)}</span>` : ""}</span>
      </label>`).join("")}
      <p class="note">${escapeHtml(CADENCE_NOTE)} Changing these only changes the copy on this
        phone — re-paste the code into GitHub for the alert job to honour them.</p>
    </div>

    <div class="btn-col al-acts">
      <button type="button" class="btn btn-ghost" data-act="al-code">Show pairing code</button>
      <a class="btn btn-ghost" href="${ACTIONS_URL}" target="_blank" rel="noopener">Send test alert</a>
      <button type="button" class="btn btn-ghost" data-act="al-disable">Disable alerts</button>
    </div>
    <p class="note">“Send test alert” opens the Alerts workflow on GitHub — press <strong>Run
      workflow</strong>, set <strong>test</strong> to <code>true</code>, and this device should
      buzz within a minute.</p>` : ""}
  </div>`;
}

/** Re-render just the card, in place. */
export function paintAlerts() {
  const host = document.getElementById("st-alerts-body");
  if (host) host.innerHTML = alertsCard();
}

/** Probe the real state (async in push.js: it asks the SW whether a subscription is live). */
export async function refreshStatus(e) {
  env = e || env;
  try {
    const status = await Promise.resolve(env.svc.alertsStatus());
    setIn("alerts", { status });
  } catch (err) {
    console.warn("[alerts] status failed", err);
    setIn("alerts", { status: { supported: false, reason: "unsupported", permission: "default", subscribed: false, pairing: null } });
  }
  paintAlerts();
}

/* ---------------------------------------------------------------- pairing sheet */

const STEPS = [
  "Add Tradewinds to your Home Screen: Share → Add to Home Screen.",
  "Open Tradewinds from the Home Screen icon — not from a Safari tab.",
  "Tap “Enable alerts” here and allow notifications.",
  "Copy the code above with the Copy button.",
  "Paste it into GitHub → repo Settings → Secrets and variables → Actions → " +
    "PUSH_SUBSCRIPTIONS. The secret is a JSON array, so one device is [ code ] and a second is " +
    "added after a comma.",
];

export function openPairingSheet(pairing, e) {
  env = e || env;
  let code = "";
  try { code = env.svc.pairingCode(pairing) || ""; }
  catch { code = pairing ? JSON.stringify(pairing) : ""; }

  const body = `<div class="pair">
    <p class="pair-lead">This device is subscribed. One paste finishes the job — the alert job
      reads its device list from a repository secret, so it has to be told about this phone.</p>

    <div class="pair-code">
      <pre class="codeblock" id="pair-code" tabindex="0">${escapeHtml(code)}</pre>
      <button type="button" class="btn btn-sm" data-act="pair-copy">Copy</button>
    </div>

    <ol class="steps">${STEPS.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>

    <a class="btn" href="${SECRETS_URL}" target="_blank" rel="noopener">Open the GitHub secret</a>
    <p class="note">${escapeHtml(CADENCE_NOTE)}</p>
  </div>`;

  openSheet({
    title: "Pair this device",
    body,
    onMount(el) {
      el.addEventListener("click", async (ev) => {
        const b = ev.target.closest('[data-act="pair-copy"]');
        if (!b) return;
        const ok = await copyText(code);
        toast(ok ? "Copied" : "Could not copy — select the code and copy it by hand.", { tone: ok ? "" : "warn" });
      });
    },
  });
}

/* ---------------------------------------------------------------- events */

/** @returns {boolean} true when the click belonged to the Alerts card. */
export function alertsClick(ev, e) {
  env = e || env;
  const t = ev.target.closest("[data-act]");
  if (!t) return false;
  const act = t.dataset.act;

  if (act === "al-enable") {
    if (t.disabled) return true;
    enable();
    return true;
  }
  if (act === "al-disable") { disable(); return true; }
  if (act === "al-code") {
    const p = store.alerts.status && store.alerts.status.pairing;
    if (p) openPairingSheet(p, env);
    else toast("Nothing paired on this device yet.", { tone: "warn" });
    return true;
  }
  return false;
}

/** Permission must be requested straight out of the click — no await before this call. */
async function enable() {
  setIn("alerts", { busy: true, error: null });
  paintAlerts();
  try {
    const pairing = await env.svc.enableAlerts({
      settings: store.settings || {},
      prefs: (store.settings && store.settings.alerts) || undefined,
    });
    setIn("alerts", { busy: false, error: null });
    await refreshStatus(env);
    openPairingSheet(pairing, env);
  } catch (err) {
    console.warn("[alerts] enable failed", err);
    const reason = err && err.reason;
    const text = reasonTextOf(reason) || (err && err.message) || "Alerts could not be turned on.";
    setIn("alerts", { busy: false });
    // refreshStatus repaints from a clean probe, so the failure text is written AFTER it —
    // otherwise the reason the user just hit disappears in the same frame it was raised.
    await refreshStatus(env);
    setIn("alerts", { error: text });
    paintAlerts();
  }
}

async function disable() {
  try {
    await env.svc.disableAlerts();
    toast("Alerts off on this device.");
  } catch (err) {
    console.warn("[alerts] disable failed", err);
    toast("Could not turn alerts off.", { tone: "warn" });
  }
  await refreshStatus(env);
}

/** Toggles and thresholds both land here. @returns {boolean} true when handled. */
export function alertsInput(ev, e) {
  env = e || env;
  const el = ev.target.closest("[data-pref]");
  if (!el) return false;
  const key = el.dataset.pref;
  const value = el.type === "checkbox" ? el.checked : Number(el.value);
  if (el.type !== "checkbox" && !Number.isFinite(value)) return true;
  try {
    const next = env.svc.updatePrefs({ [key]: value });
    if (next) setIn("alerts", { status: { ...store.alerts.status, pairing: next } });
  } catch (err) {
    console.warn("[alerts] updatePrefs failed", err);
  }
  return true;
}
