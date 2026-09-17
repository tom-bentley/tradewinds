// Tradewinds — Settings → Alerts (design §11.5).
//
// There is no server, so "turn on alerts" is really "pair this device with the GitHub Action
// that sends them": the app produces a pairing code and the code is pasted once into the
// repository secret `PUSH_SUBSCRIPTIONS`. Everything below exists to make that one paste
// obvious, and to say plainly why the button is disabled when iOS has not installed the app.

import { store, setIn } from "./store.js";
import { toast, openSheet, copyText, skeleton } from "./components.js";
import { escapeHtml, fmtNum, relTime, alertsStatusText, alertsStatusTone, alertsProblem } from "./format.js";

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

/* ------------------------------------------------- auto re-pair (design §13.3 B5) */

/**
 * The token that lets this phone re-pair itself. It is read through the service layer so tests and
 * demo mode can stand it in; a missing helper simply means the feature is not available.
 * @returns {string}
 */
function tokenOf() {
  try {
    return (env && env.svc.storedToken && env.svc.storedToken()) || "";
  } catch {
    return "";
  }
}

export const PAT_HELP =
  "Optional. With a fine-grained GitHub token (Repository access: only tom-bentley/tradewinds; " +
  "permission Contents: Read and write) this phone re-pairs itself whenever iOS changes its push " +
  "address — no copying codes. Copy the whole github_pat_… string from the page shown right after " +
  "you create the token; the token list only shows a shortened copy. The token is stored on this " +
  "phone only and is sent to api.github.com and nowhere else.";

export const PAT_URL = `${REPO}/settings/personal-access-tokens`;

/** The "Auto re-pair" field: masked when set, an input when not. */
function autoRepairBlock() {
  const token = tokenOf();
  const masked = (() => {
    try {
      return (env && env.svc.maskToken && env.svc.maskToken(token)) || "";
    } catch {
      return "";
    }
  })();

  return `<div class="al-pat">
    <p class="swrow-l">Auto re-pair</p>
    ${token
      ? `<div class="al-pat-set" style="display:flex;align-items:center;gap:8px">
          <code class="codeblock al-pat-mask">${escapeHtml(masked)}</code>
          <button type="button" class="btn btn-sm btn-ghost" data-act="al-pat-clear">Remove</button>
        </div>
        <p class="note">This phone will re-pair itself when its alert address changes.</p>`
      : `<div class="al-pat-set" style="display:flex;align-items:center;gap:8px">
          <input type="password" class="nin al-pat-in" id="al-pat" inputmode="text" autocomplete="off"
            spellcheck="false" placeholder="github_pat_…"
            style="width:100%;text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
          <button type="button" class="btn btn-sm" data-act="al-pat-save">Save</button>
        </div>
        <p class="note">${escapeHtml(PAT_HELP)}
          <a href="${PAT_URL}" target="_blank" rel="noopener">Create one</a>.</p>`}
  </div>`;
}

/* ---------------------------------------------------------------- render */

/** The whole card body. `store.alerts.status` is null until the async probe answers. */
export function alertsCard() {
  const st = store.alerts.status;
  if (!st) return `<div class="card">${skeleton(1, "sk-row")}</div>`;

  const on = st.subscribed && !!st.pairing;
  const blocked = !st.supported;
  const reason = blocked ? reasonTextOf(st.reason) : "";
  const prefs = prefsOf(st);
  const tone = alertsStatusTone(st);
  // The boot health check writes here; the card is the surface that shows it until app.js
  // (WS-A) hooks `store.alerts.problem` into the #banner.
  const problem = store.alerts.problem || alertsProblem(st);

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
    ${on && problem ? `<p class="note note-warn" id="al-problem">${escapeHtml(problem)}</p>` : ""}

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

    ${autoRepairBlock()}

    <div class="btn-col al-acts">
      <button type="button" class="btn btn-ghost" data-act="al-test">Test this phone</button>
      <button type="button" class="btn btn-ghost" data-act="al-diagnose">Diagnose</button>
      <button type="button" class="btn btn-ghost" data-act="al-code">Show pairing code</button>
      ${tokenOf()
        ? `<button type="button" class="btn btn-ghost" data-act="al-remote-test">Send test alert</button>`
        : `<a class="btn btn-ghost" href="${ACTIONS_URL}" target="_blank" rel="noopener">Send test alert</a>`}
      <button type="button" class="btn btn-ghost" data-act="al-disable">Disable alerts</button>
    </div>
    <p class="note">“Test this phone” raises a notification locally — no GitHub, no network — so
      it proves whether iOS will display one at all. “Send test alert” opens the Alerts workflow
      on GitHub: press <strong>Run workflow</strong>, set <strong>test</strong> to
      <code>true</code>, and this device should buzz within a minute.</p>` : ""}
  </div>`;
}

/** Re-render just the card, in place. */
export function paintAlerts() {
  const host = document.getElementById("st-alerts-body");
  if (host) host.innerHTML = alertsCard();
}

const OFFLINE_STATUS = {
  supported: false, reason: "unsupported", permission: "default", subscribed: false, pairing: null,
};

/**
 * Probe the real state. Two passes on purpose (design §13.3 B2): the local-only probe answers in
 * milliseconds so the card paints immediately, then the full probe fetches the sender's device
 * list, the Actions API and this phone's receipt log and repaints with the truth.
 */
export async function refreshStatus(e) {
  env = e || env;
  try {
    const fast = await Promise.resolve(env.svc.alertsStatus({ network: false }));
    setIn("alerts", { status: fast, problem: alertsProblem(fast) });
    paintAlerts();
  } catch (err) {
    console.warn("[alerts] local status failed", err);
    setIn("alerts", { status: OFFLINE_STATUS, problem: null });
    paintAlerts();
    return;
  }
  await checkAlertsHealth(env);
}

/**
 * The full probe: does the SENDER know this phone, and has anything actually been shown here?
 * Writes `store.alerts.problem` — a one-sentence "what to do" string, or null. app.js belongs to
 * WS-A, so the banner hook is theirs to add; the Settings card renders the same string today.
 *
 * Safe to call from anywhere (boot, Settings mount, the Diagnose sheet): it never throws.
 * @param {object} [e] the services env
 * @returns {Promise<string|null>} the problem text, or null when there is nothing to report
 */
export async function checkAlertsHealth(e) {
  env = e || env;
  if (!env || !env.svc || !env.svc.alertsStatus) return null;
  try {
    // 1. Heal what can be healed without asking (design §13.3 B5). iOS does not reliably fire
    //    `pushsubscriptionchange` and subscriptions carry no expiry, so a subscription can simply
    //    disappear; an idempotent re-subscribe on boot is the recovery the research recommends
    //    (research R5 §6.2/§6.4). Permission is already granted here, so no gesture is needed.
    const healed = await ensureLiveSubscription();

    // 2. Ask the sender what it believes, now that the local side is as good as it gets.
    const status = await Promise.resolve(env.svc.alertsStatus());
    const problem = alertsProblem(status);
    setIn("alerts", { status, problem });
    paintAlerts();

    // 3. If this phone's address moved, or the sender has never heard of it, hand over the new
    //    pairing ourselves — when a token allows it. Otherwise the banner asks for the paste.
    if (healed.rotated || status.endpointChanged || status.serverPaired === false) await autoRepair(status);
    return store.alerts.problem ?? problem;
  } catch (err) {
    console.warn("[alerts] health check failed", err);
    return null;
  }
}

/** Re-create a subscription iOS threw away. Never throws; returns what changed. */
async function ensureLiveSubscription() {
  const none = { subscription: null, resubscribed: false, rotated: false, pairing: null, error: null };
  if (!env.svc.ensureSubscription) return none;
  try {
    return (await Promise.resolve(env.svc.ensureSubscription())) || none;
  } catch (err) {
    console.warn("[alerts] ensureSubscription failed", err);
    return none;
  }
}

/**
 * Push this phone's (new) pairing to the sender over `repository_dispatch`. Only possible with a
 * saved token — without one this is a no-op and `store.alerts.problem` keeps asking for the paste.
 * @returns {Promise<boolean>} true when the sender was told
 */
async function autoRepair(status) {
  if (!tokenOf() || !env.svc.sendPairing) return false;
  try {
    const result = await Promise.resolve(env.svc.sendPairing({ pairing: status?.pairing }));
    if (result && result.ok) {
      setIn("alerts", { problem: null });
      toast("Alerts re-paired — the sender updates within a minute.");
      paintAlerts();
      return true;
    }
    const reason = (result && result.reason) || "GitHub refused the re-pair.";
    setIn("alerts", { problem: `${reason} Use “Show pairing code” and paste it into the secret instead.` });
    paintAlerts();
  } catch (err) {
    console.warn("[alerts] auto re-pair failed", err);
  }
  return false;
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

/* ---------------------------------------------------------------- diagnose sheet */

const YES = "yes";
const NO = "no";
const UNKNOWN = "could not check";

/**
 * One evidence row. Built out of the same `.swrow` markup the preference toggles use, so it is
 * styled by the existing sheet CSS — styles.css belongs to WS-A and this card adds nothing to it.
 */
const row = (label, value, note) =>
  `<div class="swrow dg-row"><span class="swrow-t">
    <span class="swrow-l">${escapeHtml(label)}</span>
    ${note ? `<span class="swrow-h">${escapeHtml(note)}</span>` : ""}
  </span><span class="tag tag-mute">${escapeHtml(String(value))}</span></div>`;

/** iOS version out of the UA string — the one thing the app cannot ask for directly. */
export function iosVersion(ua = (typeof navigator !== "undefined" && navigator.userAgent) || "") {
  const m = String(ua).match(/(?:iPhone |CPU )OS (\d+)[._](\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Everything the app knows about why alerts are or are not arriving, with the next step spelled
 * out. Pure: takes a status and returns HTML, so it is rendered the same from the card and from
 * a future banner.
 * @param {object} st from `alertsStatus()`
 * @returns {string}
 */
export function diagnoseBody(st, now = Date.now()) {
  const receipts = (st && st.receipts) || {};
  const server = (st && st.server) || null;
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const standalone =
    (typeof navigator !== "undefined" && navigator.standalone === true) ||
    (typeof matchMedia === "function" && (() => { try { return matchMedia("(display-mode: standalone)").matches; } catch { return false; } })());

  const serverPaired = st.serverPaired === true ? YES : st.serverPaired === false ? NO : UNKNOWN;
  const steps = nextSteps(st);

  const items = (receipts.items || []).slice(0, 10);
  const log = items.length
    ? items
        .map((r) =>
          row(
            r.title || "(no title)",
            relTime(r.at, now),
            [r.kind || "?", r.shown === false ? "NOT SHOWN" : null, r.error || null].filter(Boolean).join(" · "),
          ),
        )
        .join("")
    : `<p class="note note-warn">This phone has no record of ever receiving a push${
        receipts.source ? "" : " (and its receipt log could not be read)"
      }.</p>`;

  return `<div class="pair diagnose">
    ${steps.length ? `<ol class="steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>` : `<p class="pair-lead">Alerts are arriving on this phone. Nothing to fix.</p>`}

    <p class="swrow-l">This phone</p>
    <div class="al-prefs dg-group">
      ${row("Device id", st.deviceId || UNKNOWN, "the id the alert job files this phone under")}
      ${row("Notification permission", st.permission || UNKNOWN)}
      ${row("Installed to Home Screen", standalone ? YES : NO, standalone ? "" : "iOS only pushes to installed web apps")}
      ${row("iOS version", iosVersion(ua) || UNKNOWN)}
      ${row("Push subscription live", st.subscribed ? YES : NO)}
      ${row("Address changed since pairing", st.endpointChanged ? YES : NO, st.endpointChanged ? "re-pair to fix" : "")}
    </div>

    <p class="swrow-l">The sender</p>
    <div class="al-prefs dg-group">
      ${row("Knows this phone", serverPaired, st.serverPaired === false ? "paste the pairing code into PUSH_SUBSCRIPTIONS" : "")}
      ${row("Last sent to it", server && server.lastSentAt ? relTime(server.lastSentAt, now) : "never")}
      ${row("Pushes sent all-time", server && server.sentCount != null ? server.sentCount : UNKNOWN)}
      ${row(
        "Last result",
        server && server.lastResult ? `${server.lastResult.status ?? "?"} · ${relTime(server.lastResult.at, now)}` : UNKNOWN,
      )}
      ${row("Marked dead", server && server.expired ? YES : NO)}
      ${row("Alerts workflow last ran", st.lastRunAt ? relTime(st.lastRunAt, now) : UNKNOWN, st.lastRun && st.lastRun.conclusion ? String(st.lastRun.conclusion) : "")}
    </div>

    <p class="swrow-l">Shown on this phone (last 10)</p>
    <p class="note">${escapeHtml(
      `${receipts.count24h || 0} in the last 24 hours · ${receipts.count || 0} on record${
        receipts.failed ? ` · ${receipts.failed} could not be displayed` : ""
      }`,
    )}</p>
    ${log}

    <div class="btn-col">
      <button type="button" class="btn" data-act="al-test">Test this phone</button>
      ${tokenOf() ? `<button type="button" class="btn btn-ghost" data-act="al-repair">Re-pair this phone now</button>` : ""}
      <button type="button" class="btn btn-ghost" data-act="al-code">Show pairing code</button>
      <button type="button" class="btn btn-ghost" data-act="dg-refresh">Check again</button>
    </div>
  </div>`;
}

/**
 * Plain English, in the order Tom should try them. The first entry is always the one thing that
 * would fix the current diagnosis.
 * @param {object} st
 * @returns {string[]}
 */
export function nextSteps(st) {
  const steps = [];
  if (!st) return steps;
  if (st.permission === "denied") {
    steps.push("iOS Settings → Notifications → Tradewinds → turn Allow Notifications back on, then reopen the app.");
    return steps;
  }
  if (st.endpointChanged || st.serverPaired === false || (st.server && st.server.expired)) {
    steps.push("Tap “Show pairing code”, Copy, then paste it into GitHub → repo Settings → Secrets → PUSH_SUBSCRIPTIONS (replacing the old entry). That is the whole fix.");
    steps.push("Wait for the next Alerts run (about 10 minutes) and check this screen again.");
    return steps;
  }
  // Ordered by how often each one is the answer (research R5 §6.4 item 4).
  const receipts = st.receipts || {};
  const server = st.server || null;
  const sentAt = Date.parse(String(server?.lastSentAt ?? server?.lastNotifiedAt ?? ""));
  const lastReceipt = receipts.lastAt != null && Number.isFinite(Number(receipts.lastAt)) ? Number(receipts.lastAt) : null;
  const notDelivering = !Number.isNaN(sentAt) && (lastReceipt === null || lastReceipt < sentAt - 24 * 3600 * 1000);
  if (notDelivering) {
    steps.push("Turn off Do Not Disturb and any Focus mode, then tap “Test this phone”. DND is the single most common cause.");
    steps.push("iOS Settings → Notifications → Tradewinds: Allow Notifications, Lock Screen, Banners and Sounds all on.");
    steps.push("iOS Settings → Notifications → Scheduled Summary: Tradewinds must NOT be in a summary.");
    steps.push("On iOS 18.4 or later, check the per-app Apple Intelligence notification settings — they can delay or summarise these.");
    steps.push("If “Test this phone” DOES show a notification, re-pair: Show pairing code → paste it into the PUSH_SUBSCRIPTIONS secret. The sender is pushing to an address this phone no longer uses.");
    steps.push("Still nothing? Delete the Tradewinds icon from the Home Screen and add it again — that rebuilds the service worker.");
    return steps;
  }
  if (receipts.failed) {
    steps.push("Some pushes arrived but could not be shown. Close and reopen Tradewinds from the Home Screen icon, then tap “Test this phone”.");
  }
  if (st.serverPaired === null) {
    steps.push("The sender's device list could not be read (offline, or the site has not rebuilt yet). Try again when this phone is online.");
  }
  return steps;
}

export function openDiagnoseSheet(e) {
  env = e || env;
  const st = store.alerts.status;
  if (!st) return;
  openSheet({
    title: "Alerts diagnosis",
    body: diagnoseBody(st),
    onMount(el) {
      el.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-act]");
        if (!b) return;
        if (b.dataset.act === "al-test") { await testThisPhone(); return; }
        if (b.dataset.act === "al-repair") { await repairNow(); return; }
        if (b.dataset.act === "al-code") {
          const p = store.alerts.status && store.alerts.status.pairing;
          if (p) openPairingSheet(p, env);
          return;
        }
        if (b.dataset.act === "dg-refresh") {
          try { if (env.svc.clearProbeCache) env.svc.clearProbeCache(); } catch { /* optional */ }
          await checkAlertsHealth(env);
          const host = el.querySelector(".diagnose");
          if (host && store.alerts.status) host.outerHTML = diagnoseBody(store.alerts.status);
        }
      });
    },
  });
}

/** The one check that needs no GitHub: can this phone display a notification at all? */
async function testThisPhone() {
  try {
    const result = await Promise.resolve(env.svc.testNotification());
    if (result && result.ok) {
      toast("Sent — look for “Tradewinds test” on this phone.");
      return;
    }
    const why = result && result.reason;
    toast(
      why === "denied"
        ? "iOS is blocking notifications for Tradewinds. Settings → Notifications → Tradewinds."
        : why === "no-service-worker"
          ? "The app's service worker is not ready — reopen Tradewinds from the Home Screen icon."
          : "This phone refused to show a notification. Check Settings → Notifications → Tradewinds.",
      { tone: "warn" },
    );
  } catch (err) {
    console.warn("[alerts] test notification failed", err);
    toast("Could not raise a test notification.", { tone: "warn" });
  }
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
  if (act === "al-test") { testThisPhone(); return true; }
  if (act === "al-diagnose") { openDiagnoseSheet(env); return true; }
  if (act === "al-pat-save") { saveTokenFromField(); return true; }
  if (act === "al-pat-clear") { clearSavedToken(); return true; }
  if (act === "al-remote-test") { remoteTest(); return true; }
  if (act === "al-repair") { repairNow(); return true; }
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

/* ------------------------------------------------- auto re-pair actions (§13.3 B5) */

function saveTokenFromField() {
  const field = document.getElementById("al-pat");
  const token = field ? String(field.value || "").trim() : "";
  if (!token) return toast("Paste the token first.", { tone: "warn" });
  // Catch the shortened-copy and wrong-string mistakes before GitHub answers 401 to them.
  try {
    const shape = env.svc.tokenLooksValid ? env.svc.tokenLooksValid(token) : { ok: true };
    if (shape && shape.ok === false) {
      setIn("alerts", { problem: shape.reason });
      paintAlerts();
      return toast("That does not look like a complete token.", { tone: "warn" });
    }
  } catch { /* the shape check is advisory */ }
  if (!env.svc.saveToken || !env.svc.saveToken(token)) {
    return toast("This phone would not store the token.", { tone: "warn" });
  }
  paintAlerts();
  // Prove it works immediately rather than at the next rotation, which could be weeks away.
  repairNow();
}

function clearSavedToken() {
  try {
    if (env.svc.saveToken) env.svc.saveToken("");
  } catch (err) {
    console.warn("[alerts] token remove failed", err);
  }
  toast("Token removed from this phone.");
  paintAlerts();
}

/** Send the current pairing to the workflow now. */
async function repairNow() {
  if (!tokenOf()) return toast("Save a GitHub token first.", { tone: "warn" });
  try {
    const result = await Promise.resolve(env.svc.sendPairing({ pairing: store.alerts.status?.pairing }));
    if (result && result.ok) {
      setIn("alerts", { problem: null });
      toast("Sent — the sender updates within a minute.");
    } else {
      toast((result && result.reason) || "GitHub refused the re-pair.", { tone: "warn" });
    }
  } catch (err) {
    console.warn("[alerts] re-pair failed", err);
    toast("Could not reach GitHub.", { tone: "warn" });
  }
  paintAlerts();
}

/** "Send test alert" without leaving the app — the workflow link stays for the tokenless case. */
async function remoteTest() {
  try {
    const result = await Promise.resolve(
      env.svc.dispatchToGithub({ event: "alerts", payload: { test: true } }),
    );
    toast(
      result && result.ok
        ? "Asked GitHub for a test push — it should arrive within a minute."
        : (result && result.reason) || "GitHub refused the request.",
      { tone: result && result.ok ? "" : "warn" },
    );
  } catch (err) {
    console.warn("[alerts] remote test failed", err);
    toast("Could not reach GitHub.", { tone: "warn" });
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
