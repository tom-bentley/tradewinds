#!/usr/bin/env node
// Tradewinds alerts doctor (design §13.3 B3) — the same diagnosis the Settings card shows, from a
// terminal, with no phone in the room.
//
//   node scripts/alerts-doctor.mjs                    # public state file + Actions API
//   node scripts/alerts-doctor.mjs --local            # read data/alerts-state.json from this clone
//   PUSH_SUBSCRIPTIONS='[…]' node scripts/alerts-doctor.mjs   # also check the paired devices
//   node scripts/alerts-doctor.mjs --json             # machine-readable
//
// THE ONE THING TO REMEMBER: a 2xx from web.push.apple.com is NOT delivery. Apple answers 201 for
// a subscription it has already thrown away (Apple Developer Forums 719990, reported 2022-11 and
// re-confirmed 2024-02 — research R5 §6.2). The job's "3/3 sent" therefore proves only that Apple
// accepted the bytes. The only evidence of delivery lives on the phone, in the service worker's
// receipt log, which this script cannot see. It says so, every time, rather than declaring health.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deviceIdOf, parseSubscriptions, parseWebhooks } from "../pipeline/alerts.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_REPO = "tom-bentley/tradewinds";
export const DEFAULT_PAGES = "https://tom-bentley.github.io/tradewinds/";

/** How long a run gap is worth mentioning: the cron is every ~10 min, GitHub delays are normal. */
export const RUN_GAP_WARN_MINUTES = 90;

/** After this long with no send at all, the job is healthy but the phone hears nothing. */
export const QUIET_WARN_HOURS = 48;

const stateUrl = (pages) => `${pages.replace(/\/?$/, "/")}data/alerts-state.json?cb=${Date.now()}`;
const runsUrl = (repo) =>
  `https://api.github.com/repos/${repo}/actions/workflows/alerts.yml/runs?per_page=5`;

/**
 * @param {string[]} argv
 * @returns {{json: boolean, local: boolean, repo: string, pages: string}}
 */
export function parseArgs(argv) {
  const args = { json: false, local: false, repo: DEFAULT_REPO, pages: DEFAULT_PAGES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--local") args.local = true;
    else if (arg === "--repo") args.repo = String(argv[++i] ?? args.repo);
    else if (arg === "--pages") args.pages = String(argv[++i] ?? args.pages);
  }
  return args;
}

const hours = (ms) => ms / 3600000;

/** "3h 12m ago" · "just now" · "—" */
export function ago(iso, now) {
  const at = Date.parse(String(iso ?? ""));
  if (Number.isNaN(at)) return "—";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/**
 * The whole diagnosis, as data. Pure — every input is passed in, so the report is a unit test.
 *
 * @param {{state: object|null, runs: object[]|null, devices: object[], now: number}} input
 * @returns {{lines: string[], problems: string[], devices: object[], runs: object|null}}
 */
export function diagnose(input) {
  const { state, runs, devices, now } = input;
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const problems = [];

  // --- the sender ------------------------------------------------------------------------------
  if (!Array.isArray(runs) || !runs.length) {
    lines.push("Workflow      could not read the Actions API (rate limit, offline, or private repo)");
  } else {
    const latest = runs[0];
    const at = latest.run_started_at ?? latest.created_at ?? null;
    const gap = Date.parse(String(at));
    lines.push(
      `Workflow      last run ${ago(at, now)} · ${latest.conclusion ?? latest.status ?? "?"} · ${runs.length} of the last runs read`,
    );
    if (!Number.isNaN(gap) && (now - gap) / 60000 > RUN_GAP_WARN_MINUTES) {
      problems.push(
        `The Alerts workflow has not run for ${ago(at, now)}. GitHub delays scheduled runs; fire one with ` +
          "`gh workflow run alerts.yml` or the repository_dispatch ping.",
      );
    }
    const failed = runs.filter((run) => run.conclusion && run.conclusion !== "success").length;
    if (failed) problems.push(`${failed} of the last ${runs.length} Alerts runs did not succeed.`);
  }

  // --- the state file --------------------------------------------------------------------------
  if (!state) {
    lines.push("State         data/alerts-state.json could not be read");
    problems.push("Without the state file nothing can be said about which devices the job knows.");
    return { lines, problems, devices: [], pairings: [], runs: runs?.[0] ?? null };
  }

  const stateDevices = state.devices && typeof state.devices === "object" ? state.devices : {};
  const ids = Object.keys(stateDevices);
  const pairings = state.pairings && typeof state.pairings === "object" ? state.pairings : {};
  const live = Object.keys(pairings).filter((id) => !pairings[id].supersededBy);
  lines.push(
    `State         ${ids.length} device entr${ids.length === 1 ? "y" : "ies"} · ${Object.keys(state.leagues ?? {}).length} league(s)` +
      (Object.keys(pairings).length ? ` · ${live.length} self-paired (${Object.keys(pairings).length - live.length} superseded)` : ""),
  );

  /** @type {object[]} */
  const report = [];
  for (const id of ids) {
    const entry = stateDevices[id] || {};
    const lastSent = entry.lastSentAt ?? entry.lastNotifiedAt ?? null;
    report.push({
      id,
      known: true,
      paired: null,
      label: null,
      lastSentAt: lastSent,
      sentCount: entry.sentCount ?? null,
      lastResult: entry.lastResult ?? null,
      expired: entry.expired === true,
      seenDeals: (entry.seenDeals || []).length,
      seenFa: (entry.seenFa || []).length,
      seenAdvice: (entry.seenAdvice || []).length,
      lastKindAt: entry.lastKindAt ?? null,
    });
    if (entry.expired === true) {
      problems.push(`Device ${id} is marked expired — its pairing code has to be pasted into PUSH_SUBSCRIPTIONS again.`);
    }
    const at = Date.parse(String(lastSent ?? ""));
    if (!Number.isNaN(at) && hours(now - at) > QUIET_WARN_HOURS) {
      problems.push(`Device ${id} has heard nothing for ${ago(lastSent, now)} — check the thresholds and the cooldowns.`);
    }
  }

  // --- what the secret says, when we were given it ----------------------------------------------
  for (const device of devices) {
    const row = report.find((entry) => entry.id === device.id);
    if (row) {
      row.paired = true;
      row.label = device.label;
    } else {
      report.push({
        id: device.id,
        known: false,
        paired: true,
        label: device.label,
        lastSentAt: null,
        sentCount: null,
        lastResult: null,
        expired: false,
      });
      problems.push(
        `${device.label} (${device.id}) is in PUSH_SUBSCRIPTIONS but has no entry in the state file — ` +
          "it has never been sent anything. Check that the job reaches its league.",
      );
    }
  }
  for (const row of report) {
    // A device that filed its own pairing (§13.3 B5) is reachable without ever appearing in the
    // secret, so its absence there is not a fault.
    if (pairings[row.id] && !pairings[row.id].supersededBy) {
      row.paired = true;
      row.label = row.label ?? pairings[row.id].label ?? null;
      row.selfPaired = true;
      continue;
    }
    if (row.paired === null && devices.length) {
      row.paired = false;
      problems.push(
        `Device ${row.id} is in the state file but NOT in PUSH_SUBSCRIPTIONS — the phone re-subscribed, ` +
          "or the secret was edited. Whatever it was, that device is no longer being sent to.",
      );
    }
  }

  // --- self-filed pairings (§13.3 B5) ------------------------------------------------------------
  /** @type {object[]} */
  const pairingRows = [];
  for (const id of Object.keys(pairings).sort()) {
    const entry = pairings[id] || {};
    pairingRows.push({
      id,
      label: entry.label ?? null,
      userId: entry.userId ?? null,
      leagueId: entry.leagueId ?? null,
      createdAt: entry.createdAt ?? null,
      supersededBy: entry.supersededBy ?? null,
    });
  }
  for (const row of pairingRows) {
    if (row.supersededBy || report.some((entry) => entry.id === row.id)) continue;
    problems.push(
      `Pairing ${row.label ?? row.id} (${row.id}) was filed by the phone but has never been sent to — ` +
        "check that VAPID_PRIVATE_KEY can open it and that its league is reachable.",
    );
  }

  return { lines, problems, devices: report, pairings: pairingRows, runs: runs?.[0] ?? null };
}

/** The printable report. */
export function render(result, { now, devicesKnown }) {
  const out = [...result.lines, ""];
  out.push("Devices");
  if (!result.devices.length) {
    out.push("  (none — nothing has ever been paired, or the state file is empty)");
  }
  for (const device of result.devices) {
    const name = device.label ? `${device.label} (${device.id})` : device.id;
    const paired = device.selfPaired
      ? "self-paired by the phone"
      : device.paired === true
        ? "in the secret"
        : device.paired === false
          ? "NOT in the secret"
          : "secret not supplied";
    out.push(`  ${name}`);
    out.push(`    pairing     ${paired}${device.expired ? " · marked expired" : ""}`);
    out.push(
      `    accepted    ${device.sentCount ?? "?"} push(es) all-time · last ${ago(device.lastSentAt, now)}` +
        (device.lastResult ? ` · ${device.lastResult.status ?? "?"}` : ""),
    );
    if (device.seenDeals != null) {
      out.push(`    remembered  ${device.seenDeals} deals · ${device.seenFa} free agents · ${device.seenAdvice} advisories`);
    }
    if (device.lastKindAt) {
      const cooldowns = Object.entries(device.lastKindAt).map(([kind, at]) => `${kind} ${ago(at, now)}`);
      out.push(`    cooldowns   ${cooldowns.join(" · ")}`);
    }
  }

  if ((result.pairings || []).length) {
    out.push("");
    out.push("Self-filed pairings (ciphertext in the state file; only VAPID_PRIVATE_KEY opens them)");
    for (const row of result.pairings) {
      out.push(
        `  ${row.label ?? "(unlabelled)"} (${row.id})` +
          `  league ${row.leagueId ?? "?"} · filed ${ago(row.createdAt, now)}` +
          (row.supersededBy ? ` · superseded by ${row.supersededBy}` : ""),
      );
    }
  }

  out.push("");
  out.push("Problems");
  if (!result.problems.length) out.push("  none that this script can see from outside the phone");
  for (const problem of result.problems) out.push(`  - ${problem}`);

  out.push("");
  out.push("What this script CANNOT tell you");
  out.push("  Whether any of it was ever displayed. web.push.apple.com answers 201 for a subscription");
  out.push("  it has already discarded (Apple Developer Forums 719990; research R5 §6.2), so every");
  out.push("  \"sent\" above means \"accepted by Apple\", never \"shown on the phone\".");
  out.push("  The only delivery evidence is the service worker's receipt log:");
  out.push("  open the app → Settings → Alerts → Diagnose.");
  if (!devicesKnown) {
    out.push("");
    out.push("  Tip: PUSH_SUBSCRIPTIONS='<the secret>' node scripts/alerts-doctor.mjs cross-checks the");
    out.push("  paired devices against the state file, which is how a rotated endpoint shows up here.");
  }
  return out.join("\n");
}

/**
 * @param {{argv?: string[], env?: Record<string, string|undefined>, fetchImpl?: Function,
 *   log?: (line: string) => void, now?: number}} [options]
 * @returns {Promise<number>}
 */
export async function main(options = {}) {
  const args = parseArgs(options.argv ?? process.argv.slice(2));
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  const get = async (url, init) => {
    try {
      const response = await fetchImpl(url, init);
      if (!response?.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  };

  let state = null;
  if (args.local) {
    try {
      state = JSON.parse(readFileSync(join(REPO_ROOT, "data", "alerts-state.json"), "utf8"));
    } catch {
      state = null;
    }
  } else {
    state = await get(stateUrl(args.pages), { headers: { "cache-control": "no-cache" } });
  }

  const runsBody = await get(runsUrl(args.repo), { headers: { Accept: "application/vnd.github+json" } });
  const runs = Array.isArray(runsBody?.workflow_runs) ? runsBody.workflow_runs : null;

  const parsed = parseSubscriptions(env.PUSH_SUBSCRIPTIONS);
  const hooks = parseWebhooks(env.ALERT_WEBHOOKS);
  const devices = [...parsed.devices, ...hooks.webhooks];

  const result = diagnose({ state, runs, devices, now });

  if (args.json) {
    log(JSON.stringify({ at: new Date(now).toISOString(), ...result }, null, 2));
    return result.problems.length ? 1 : 0;
  }

  log(`tradewinds alerts doctor — ${new Date(now).toISOString()} — ${args.repo}`);
  for (const problem of [...parsed.problems, ...hooks.problems]) log(`  ! ${problem}`);
  log("");
  log(render(result, { now, devicesKnown: devices.length > 0 }));
  return result.problems.length ? 1 : 0;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`alerts-doctor crashed: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}

export { deviceIdOf };
