#!/usr/bin/env node
// Append one phone-requested research row to data/research-queue.json (004 design §2.5, §5).
//
//   RESEARCH_PAYLOAD='{"v":1,"id":"11604","depth":"deep"}' node scripts/enqueue-research.mjs
//
// Run by .github/workflows/research-queue.yml from a `repository_dispatch: research` event, whose
// `client_payload` arrives as the RESEARCH_PAYLOAD env var. Everything about the request except
// the player id is optional; anything unusable exits 0 with a log line, because a malformed
// dispatch from a phone with a flaky connection must not leave a red run in the history.
//
// Exits 0 always. queue.mjs is the only thing that decides whether the row is actually added.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { QUEUE_DEPTHS, enqueueAll } from "../pipeline/queue.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE_FILE = join(REPO_ROOT, "data", "research-queue.json");

/** The phone is priority 1 — a human is holding the device waiting for the answer (§2.5). */
const PHONE_PRIORITY = 1;

/**
 * @param {string|undefined} raw
 * @returns {{ id: string, depth: string, sk: string|null }|null}
 */
export function parseResearchPayload(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  // `toJson(github.event.client_payload)` is "{}" for anything but a research dispatch.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = payload.id == null ? "" : String(payload.id).trim();
  if (!/^[A-Za-z0-9]{1,16}$/.test(id)) return null;
  return {
    id,
    depth: QUEUE_DEPTHS.includes(payload.depth) ? payload.depth : "standard",
    sk: typeof payload.sk === "string" && payload.sk !== "" ? payload.sk : null,
  };
}

/** Append the row RESEARCH_PAYLOAD describes. Split from the parser so tests can import it. */
export function main() {
  const request = parseResearchPayload(process.env.RESEARCH_PAYLOAD);
  if (!request) {
    process.stdout.write("research: no usable client_payload — nothing queued\n");
    return;
  }
  const result = enqueueAll(QUEUE_FILE, [
    {
      player_id: request.id,
      depth: request.depth,
      reason: "phone",
      sk: request.sk,
      requested_by: "phone",
      priority: PHONE_PRIORITY,
    },
  ]);
  if (!result.written) {
    process.stdout.write(`research: queue rejected (${result.problems[0]}) — left alone\n`);
  } else if (result.added === 0) {
    process.stdout.write(`research: ${request.id} ${request.depth} already queued — nothing added\n`);
  } else {
    process.stdout.write(`research: queued ${request.id} ${request.depth} (${result.bytes} B)\n`);
  }
}

// Importing this file (the tests do) must never write to data/.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
