// data/research-queue.json helpers (004 design §2.5).
//
// The queue is the only shared state between three writers that never see each other: the alerts
// job (news transitions), the `research-queue.yml` workflow (the phone's `repository_dispatch`)
// and the research desk (which claims, works and completes rows from its own clone). Every
// function below is PURE over the parsed object — `readQueue`/`writeQueue` are the only fs touch —
// so the desk can replay a queue from git history and get the same answer.
//
// Conflict model: all three writers commit to `main`, so two writes in the same minute race. The
// loser rebases; because `appendRow` is idempotent on `(player_id, depth, sk)` and `claimRow`
// refuses a row already claimed, a replayed append or claim is a no-op rather than a duplicate.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { isoTimestamp } from "./util.mjs";
import { validateQueue } from "./contract.mjs";

export { validateQueue };

/** Schema version of data/research-queue.json (004 design §1). */
export const QUEUE_VERSION = 1;

/** Research depths, deepest first. */
export const QUEUE_DEPTHS = Object.freeze(["deep", "standard", "quick"]);

/** What put the row on the queue (design §2.5). */
export const QUEUE_REASONS = Object.freeze(["phone", "news", "roster", "trending", "league"]);

/** Row lifecycle. `failed` rows stay visible on purpose. */
export const QUEUE_STATUSES = Object.freeze(["queued", "claimed", "done", "failed"]);

/**
 * Priority ladder of design §2.5: 1 phone, 2 news (my roster), 3 roster sweep, 4 trending,
 * 5 news (rivals), 6 league quick. Lower number = drained first.
 */
export const QUEUE_PRIORITIES = Object.freeze({ MIN: 1, MAX: 6 });

/** A claim older than this is reclaimable — a desk that died mid-fill must not wedge the queue. */
export const CLAIM_STALE_MS = 30 * 60 * 1000;

/** `done` rows are pruned after a week. */
export const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard caps (design §2.5). */
export const MAX_ROWS = 200;
export const MAX_BYTES = 64 * 1024;

/** Three failures and the row stops being retried, but stays on the queue to be seen. */
export const MAX_ATTEMPTS = 3;

/** Same player, same status key, same UTC day ⇒ already asked. Debounces a flapping designation. */
const DEBOUNCE_DAY = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "");

/**
 * An empty, valid queue.
 * @param {{ now?: number|Date }} [options]
 * @returns {{v:number, updated_at:string, rows:object[]}}
 */
export function emptyQueue(options = {}) {
  return { v: QUEUE_VERSION, updated_at: stamp(options.now), rows: [] };
}

/**
 * @param {number|Date|undefined} now
 * @returns {string}
 */
function stamp(now) {
  if (now === undefined || now === null) return isoTimestamp();
  return isoTimestamp(now instanceof Date ? now : new Date(Number(now)));
}

/**
 * Read data/research-queue.json. A missing, unreadable or malformed file starts an empty queue
 * rather than throwing: the queue is a convenience, never a reason for a job to fail.
 * @param {string} file
 * @param {{ now?: number|Date }} [options]
 * @returns {{v:number, updated_at:string, rows:object[]}}
 */
export function readQueue(file, options = {}) {
  if (!existsSync(file)) return emptyQueue(options);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Number(parsed.v) !== QUEUE_VERSION) {
      return emptyQueue(options);
    }
    return {
      v: QUEUE_VERSION,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : stamp(options.now),
      rows: Array.isArray(parsed.rows) ? parsed.rows.filter((row) => row && typeof row === "object") : [],
    };
  } catch {
    return emptyQueue(options);
  }
}

/**
 * Write the queue, compact + trailing newline, exactly like every other pipeline file.
 * Refuses to write a queue the validator rejects — a broken queue file would block three jobs.
 * @param {string} file
 * @param {object} queue
 * @returns {{ bytes:number, written:boolean, problems:string[] }}
 */
export function writeQueue(file, queue) {
  const problems = validateQueue(queue);
  const text = `${JSON.stringify(queue)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (problems.length > 0) return { bytes, written: false, problems };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return { bytes, written: true, problems };
}

/**
 * `q_20260922_1338_11604_deep`, with a `_2`… suffix only if that exact id is already taken.
 * @param {object[]} rows
 * @param {string} playerId
 * @param {string} depth
 * @param {string} at ISO timestamp
 * @returns {string}
 */
export function queueRowId(rows, playerId, depth, at) {
  const compact = at.replace(/[-:]/g, "");
  const base = `q_${compact.slice(0, 8)}_${compact.slice(9, 13)}_${playerId}_${depth}`;
  const taken = new Set(rows.map((row) => row?.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Append one research request, or decline to.
 *
 * Two guards, both from design §2.5:
 *  - **dedupe** on `(player_id, depth, sk)` while an identical row is still `queued` or `claimed`;
 *  - **same-day debounce** on `(player_id, sk)` across EVERY status, so a designation that flips
 *    Questionable → Out → Questionable inside one day is researched once, not three times.
 * @param {object} queue parsed queue (not mutated)
 * @param {{player_id:string, depth?:string, reason:string, sk?:string|null,
 *          requested_by?:string, priority?:number, now?:number|Date}} request
 * @returns {{queue:object, row:object|null, skipped:"dedupe"|"debounce"|"invalid"|null}}
 */
export function appendRow(queue, request) {
  const rows = Array.isArray(queue?.rows) ? queue.rows : [];
  const base = { v: QUEUE_VERSION, updated_at: stamp(request.now), rows };
  const playerId = request.player_id == null ? "" : String(request.player_id);
  const depth = QUEUE_DEPTHS.includes(request.depth) ? request.depth : "standard";
  const reason = QUEUE_REASONS.includes(request.reason) ? request.reason : null;
  if (playerId === "" || !reason) return { queue: base, row: null, skipped: "invalid" };

  const sk = typeof request.sk === "string" && request.sk !== "" ? request.sk : null;
  const at = stamp(request.now);
  const day = DEBOUNCE_DAY(at);

  for (const row of rows) {
    if (String(row.player_id) !== playerId) continue;
    const sameSk = (row.sk ?? null) === sk;
    if (sameSk && row.depth === depth && (row.status === "queued" || row.status === "claimed")) {
      return { queue: base, row: null, skipped: "dedupe" };
    }
    if (sk !== null && sameSk && DEBOUNCE_DAY(row.queued_at) === day) {
      return { queue: base, row: null, skipped: "debounce" };
    }
  }

  const priority = clampPriority(request.priority);
  const row = {
    id: queueRowId(rows, playerId, depth, at),
    player_id: playerId,
    depth,
    reason,
    sk,
    queued_at: at,
    requested_by: typeof request.requested_by === "string" ? request.requested_by : "pipeline",
    priority,
    status: "queued",
    claimed_by: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
    done_at: null,
  };
  return { queue: { ...base, updated_at: at, rows: [...rows, row] }, row, skipped: null };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampPriority(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return QUEUE_PRIORITIES.MAX;
  return Math.min(QUEUE_PRIORITIES.MAX, Math.max(QUEUE_PRIORITIES.MIN, n));
}

/**
 * Claim the next row for a worker: lowest `priority`, then oldest `queued_at`. A `claimed` row
 * whose claim is older than `CLAIM_STALE_MS` is reclaimable (design §2.5) — the previous desk
 * died and nobody else will finish it.
 * @param {object} queue
 * @param {{by:string, now?:number|Date, id?:string, staleMs?:number}} options
 * @returns {{queue:object, row:object|null}}
 */
export function claimRow(queue, options) {
  const rows = Array.isArray(queue?.rows) ? queue.rows : [];
  const at = stamp(options.now);
  const nowMs = Date.parse(at);
  const staleMs = Number.isFinite(options.staleMs) ? Number(options.staleMs) : CLAIM_STALE_MS;
  const claimable = (row) => {
    if (row.status === "queued") return true;
    if (row.status !== "claimed") return false;
    const since = Date.parse(row.claimed_at ?? "");
    return !Number.isFinite(since) || nowMs - since >= staleMs;
  };

  const candidates = rows.filter(
    (row) => claimable(row) && (options.id === undefined || row.id === options.id),
  );
  if (candidates.length === 0) return { queue: { ...queue, rows }, row: null };
  candidates.sort(
    (a, b) => a.priority - b.priority || String(a.queued_at).localeCompare(String(b.queued_at)),
  );
  const target = candidates[0];
  const claimed = { ...target, status: "claimed", claimed_by: String(options.by), claimed_at: at };
  return {
    queue: { ...queue, v: QUEUE_VERSION, updated_at: at, rows: rows.map((row) => (row.id === target.id ? claimed : row)) },
    row: claimed,
  };
}

/**
 * Mark a row done.
 * @param {object} queue
 * @param {string} id
 * @param {{now?:number|Date}} [options]
 * @returns {{queue:object, row:object|null}}
 */
export function completeRow(queue, id, options = {}) {
  return patchRow(queue, id, options.now, (row) => ({
    ...row,
    status: "done",
    done_at: stamp(options.now),
    last_error: null,
  }));
}

/**
 * Record a failed attempt. `attempts >= MAX_ATTEMPTS` retires the row as `failed`; anything less
 * goes back on the queue for the next desk run.
 * @param {object} queue
 * @param {string} id
 * @param {{error?:string, now?:number|Date}} [options]
 * @returns {{queue:object, row:object|null}}
 */
export function failRow(queue, id, options = {}) {
  return patchRow(queue, id, options.now, (row) => {
    const attempts = (Number(row.attempts) || 0) + 1;
    return {
      ...row,
      attempts,
      status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      claimed_by: null,
      claimed_at: null,
      last_error: options.error ? String(options.error).slice(0, 200) : "unknown error",
      done_at: attempts >= MAX_ATTEMPTS ? stamp(options.now) : null,
    };
  });
}

/**
 * @param {object} queue
 * @param {string} id
 * @param {number|Date|undefined} now
 * @param {(row:object)=>object} patch
 * @returns {{queue:object, row:object|null}}
 */
function patchRow(queue, id, now, patch) {
  const rows = Array.isArray(queue?.rows) ? queue.rows : [];
  const target = rows.find((row) => row.id === id);
  if (!target) return { queue: { ...queue, rows }, row: null };
  const next = patch(target);
  return {
    queue: { ...queue, v: QUEUE_VERSION, updated_at: stamp(now), rows: rows.map((row) => (row.id === id ? next : row)) },
    row: next,
  };
}

/**
 * Bound the file (design §2.5): `done` rows older than 7 days go; then the newest `MAX_ROWS`
 * survive; then, if the JSON is still over `MAX_BYTES`, the oldest settled rows go until it fits.
 * Live work (`queued`/`claimed`) is dropped last and only under the byte cap, because losing a
 * claimed row would strand a desk mid-fill.
 * @param {object} queue
 * @param {{now?:number|Date, maxRows?:number, maxBytes?:number}} [options]
 * @returns {{queue:object, dropped:number}}
 */
export function pruneQueue(queue, options = {}) {
  const rows = Array.isArray(queue?.rows) ? [...queue.rows] : [];
  const before = rows.length;
  const at = stamp(options.now);
  const nowMs = Date.parse(at);
  const maxRows = Number.isFinite(options.maxRows) ? Number(options.maxRows) : MAX_ROWS;
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : MAX_BYTES;

  let kept = rows.filter((row) => {
    if (row.status !== "done") return true;
    const done = Date.parse(row.done_at ?? row.queued_at ?? "");
    return !Number.isFinite(done) || nowMs - done < DONE_TTL_MS;
  });

  const age = (row) => Date.parse(row.queued_at ?? "") || 0;
  const settled = (row) => row.status === "done" || row.status === "failed";
  if (kept.length > maxRows) {
    const live = kept.filter((row) => !settled(row));
    const rest = kept.filter(settled).sort((a, b) => age(b) - age(a));
    kept = [...live, ...rest.slice(0, Math.max(0, maxRows - live.length))];
  }

  const size = (list) => Buffer.byteLength(`${JSON.stringify({ ...queue, rows: list })}\n`, "utf8");
  while (kept.length > 0 && size(kept) > maxBytes) {
    const settledRows = kept.filter(settled);
    const victim = (settledRows.length > 0 ? settledRows : kept).reduce((oldest, row) =>
      age(row) < age(oldest) ? row : oldest,
    );
    kept = kept.filter((row) => row !== victim);
  }

  // Keep the file in queue order (oldest first) so a diff reads as an append.
  kept.sort((a, b) => age(a) - age(b) || String(a.id).localeCompare(String(b.id)));
  return {
    queue: { v: QUEUE_VERSION, updated_at: at, rows: kept },
    dropped: before - kept.length,
  };
}

/**
 * Convenience for the two jobs that only ever append: read, append many, prune, write.
 * @param {string} file
 * @param {Array<object>} requests
 * @param {{now?:number|Date}} [options]
 * @returns {{added:number, skipped:number, bytes:number, written:boolean, problems:string[]}}
 */
export function enqueueAll(file, requests, options = {}) {
  let queue = readQueue(file, options);
  let added = 0;
  let skipped = 0;
  for (const request of requests) {
    const result = appendRow(queue, { ...request, now: options.now });
    queue = result.queue;
    if (result.row) added += 1;
    else skipped += 1;
  }
  const pruned = pruneQueue(queue, options).queue;
  const write = writeQueue(file, pruned);
  return { added, skipped, ...write };
}
