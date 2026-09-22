// data/research-queue.json — the helpers, the validator, the alerts trigger and the workflow's
// payload parser (004 design §2.5). Pure functions only; the two fs wrappers are exercised through
// a temp directory so nothing here touches data/.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as read } from "node:fs";

import {
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  QUEUE_VERSION,
  appendRow,
  claimRow,
  completeRow,
  emptyQueue,
  enqueueAll,
  failRow,
  pruneQueue,
  queueRowId,
  readQueue,
  writeQueue,
} from "../pipeline/queue.mjs";
import { validateQueue } from "../pipeline/contract.mjs";
import { researchRequests } from "../pipeline/alerts.mjs";
import { parseResearchPayload } from "../scripts/enqueue-research.mjs";

const fixture = (name) => JSON.parse(read(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const SAMPLE = fixture("queue_sample.json");
const DAY = Date.parse("2026-09-22T13:00:00Z");
const NEXT_DAY = Date.parse("2026-09-23T13:00:00Z");

const request = (patch = {}) => ({
  player_id: "11604",
  depth: "deep",
  reason: "news",
  sk: "Questionable|Knee|Surgery",
  requested_by: "alerts",
  priority: 2,
  ...patch,
});

test("the sample queue satisfies the contract", () => {
  assert.deepEqual(validateQueue(SAMPLE), []);
  assert.equal(SAMPLE.v, QUEUE_VERSION);
  assert.deepEqual(
    SAMPLE.rows.map((row) => row.status).sort(),
    ["claimed", "done", "failed", "queued"],
  );
});

test("appendRow writes the full row shape of design §2.5", () => {
  const { queue, row, skipped } = appendRow(emptyQueue({ now: DAY }), request({ now: DAY }));
  assert.equal(skipped, null);
  assert.equal(queue.rows.length, 1);
  assert.deepEqual(Object.keys(row).sort(), [
    "attempts", "claimed_at", "claimed_by", "depth", "done_at", "id", "last_error",
    "player_id", "priority", "queued_at", "reason", "requested_by", "sk", "status",
  ]);
  assert.equal(row.id, "q_20260922_1300_11604_deep");
  assert.equal(row.status, "queued");
  assert.deepEqual(validateQueue(queue), []);
});

test("appendRow dedupes a live (player_id, depth, sk) and debounces the same sk inside a day", () => {
  let queue = appendRow(emptyQueue({ now: DAY }), request({ now: DAY })).queue;

  // Same key while the row is still queued: dedupe.
  assert.equal(appendRow(queue, request({ now: DAY + 60_000 })).skipped, "dedupe");

  // Same player, same status key, DIFFERENT depth, same day: the flapping debounce still bites.
  assert.equal(appendRow(queue, request({ depth: "standard", now: DAY + 60_000 })).skipped, "debounce");

  // A different status key on the same day is a real transition and goes through.
  const moved = appendRow(queue, request({ sk: "Out|Knee|Surgery", now: DAY + 60_000 }));
  assert.equal(moved.skipped, null);
  queue = moved.queue;

  // Tomorrow the original key may be asked again, even though yesterday's row is done.
  queue = completeRow(queue, "q_20260922_1300_11604_deep", { now: DAY + 120_000 }).queue;
  assert.equal(appendRow(queue, request({ now: NEXT_DAY })).skipped, null);
});

test("appendRow refuses a row with no player or an unknown reason, and clamps priority", () => {
  const base = emptyQueue({ now: DAY });
  assert.equal(appendRow(base, request({ player_id: "" })).skipped, "invalid");
  assert.equal(appendRow(base, request({ reason: "vibes" })).skipped, "invalid");
  assert.equal(appendRow(base, request({ priority: 99, now: DAY })).row.priority, 6);
  assert.equal(appendRow(base, request({ priority: 0, now: DAY })).row.priority, 1);
  assert.equal(appendRow(base, request({ depth: "exhaustive", now: DAY })).row.depth, "standard");
});

test("queueRowId only suffixes on a real collision", () => {
  assert.equal(queueRowId([], "11604", "deep", "2026-09-22T13:00:00Z"), "q_20260922_1300_11604_deep");
  assert.equal(
    queueRowId([{ id: "q_20260922_1300_11604_deep" }], "11604", "deep", "2026-09-22T13:00:00Z"),
    "q_20260922_1300_11604_deep_2",
  );
});

test("claimRow takes the lowest priority first, then the oldest", () => {
  let queue = emptyQueue({ now: DAY });
  queue = appendRow(queue, request({ player_id: "a", priority: 5, sk: "a", now: DAY })).queue;
  queue = appendRow(queue, request({ player_id: "b", priority: 1, sk: "b", now: DAY + 1000 })).queue;
  queue = appendRow(queue, request({ player_id: "c", priority: 1, sk: "c", now: DAY + 2000 })).queue;

  const first = claimRow(queue, { by: "desk:pc", now: DAY + 3000 });
  assert.equal(first.row.player_id, "b");
  assert.equal(first.row.status, "claimed");
  assert.equal(first.row.claimed_by, "desk:pc");

  const second = claimRow(first.queue, { by: "desk:pc", now: DAY + 4000 });
  assert.equal(second.row.player_id, "c");
  assert.deepEqual(validateQueue(second.queue), []);
});

test("a claim older than 30 minutes is reclaimable; a fresh one is not", () => {
  const queue = appendRow(emptyQueue({ now: DAY }), request({ now: DAY })).queue;
  const claimed = claimRow(queue, { by: "desk:a", now: DAY }).queue;

  assert.equal(claimRow(claimed, { by: "desk:b", now: DAY + CLAIM_STALE_MS - 1000 }).row, null);
  const reclaimed = claimRow(claimed, { by: "desk:b", now: DAY + CLAIM_STALE_MS + 1000 });
  assert.equal(reclaimed.row.claimed_by, "desk:b");
  assert.equal(claimRow(emptyQueue({ now: DAY }), { by: "desk:a", now: DAY }).row, null);
});

test("failRow retries twice then retires the row, leaving it visible", () => {
  let queue = appendRow(emptyQueue({ now: DAY }), request({ now: DAY })).queue;
  const id = queue.rows[0].id;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    queue = failRow(queue, id, { error: `boom ${attempt}`, now: DAY }).queue;
    assert.equal(queue.rows[0].status, "queued", "still retryable");
    assert.equal(queue.rows[0].attempts, attempt);
    assert.equal(queue.rows[0].claimed_by, null);
  }
  queue = failRow(queue, id, { error: "boom 3", now: DAY }).queue;
  assert.equal(queue.rows[0].status, "failed");
  assert.equal(queue.rows[0].attempts, MAX_ATTEMPTS);
  assert.equal(queue.rows[0].last_error, "boom 3");
  assert.equal(claimRow(queue, { by: "desk", now: DAY }).row, null, "a failed row is not re-claimed");
  assert.deepEqual(validateQueue(queue), []);
  assert.equal(failRow(queue, "nope", { now: DAY }).row, null);
});

test("pruneQueue drops week-old done rows, caps the row count and keeps live work last", () => {
  const old = { ...SAMPLE.rows[2], done_at: "2026-09-01T00:00:00Z", queued_at: "2026-09-01T00:00:00Z" };
  const pruned = pruneQueue({ ...SAMPLE, rows: [...SAMPLE.rows, old] }, { now: DAY });
  assert.equal(pruned.dropped, 1);
  assert.ok(!pruned.queue.rows.some((row) => row.done_at === "2026-09-01T00:00:00Z"));

  // 30 settled rows against a cap of 5: the live rows survive, the oldest settled go.
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...SAMPLE.rows[2],
    id: `q_done_${i}`,
    player_id: String(1000 + i),
    queued_at: `2026-09-2${i % 2}T0${i % 8}:00:00Z`,
    done_at: "2026-09-21T12:00:00Z",
  }));
  const capped = pruneQueue({ ...SAMPLE, rows: [SAMPLE.rows[0], ...many] }, { now: DAY, maxRows: 5 });
  assert.equal(capped.queue.rows.length, 5);
  assert.ok(capped.queue.rows.some((row) => row.id === SAMPLE.rows[0].id), "the queued row survived");

  // The byte cap is the last resort and may take live rows with it.
  const tiny = pruneQueue(SAMPLE, { now: DAY, maxBytes: 400 });
  assert.ok(Buffer.byteLength(`${JSON.stringify(tiny.queue)}\n`) <= 400);
});

test("readQueue and writeQueue round-trip, and a broken file starts fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-queue-"));
  const file = join(dir, "research-queue.json");

  assert.deepEqual(readQueue(file, { now: DAY }).rows, [], "absent is an empty queue");
  const write = writeQueue(file, SAMPLE);
  assert.equal(write.written, true);
  assert.deepEqual(readQueue(file).rows.map((row) => row.id), SAMPLE.rows.map((row) => row.id));

  writeFileSync(file, "<!doctype html>404", "utf8");
  assert.deepEqual(readQueue(file, { now: DAY }).rows, [], "a 404 page is not a queue");
  writeFileSync(file, JSON.stringify({ v: 9, rows: [{}] }), "utf8");
  assert.deepEqual(readQueue(file, { now: DAY }).rows, [], "a future version is not read");

  // writeQueue refuses to publish a file the validator rejects.
  const refused = writeQueue(file, { v: 1, updated_at: "nope", rows: [] });
  assert.equal(refused.written, false);
  assert.ok(refused.problems.length > 0);
});

test("enqueueAll appends, dedupes and prunes in one pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-queue-"));
  const file = join(dir, "research-queue.json");
  const result = enqueueAll(file, [request(), request(), request({ player_id: "99", sk: "Out|Hip|" })], { now: DAY });
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.written, true);
  assert.deepEqual(validateQueue(JSON.parse(readFileSync(file, "utf8"))), []);
});

test("validateQueue names a duplicate live row, a bad status and a bad priority", () => {
  const dupe = { ...SAMPLE, rows: [SAMPLE.rows[0], { ...SAMPLE.rows[0], id: "other" }] };
  assert.ok(validateQueue(dupe).some((p) => p.includes("duplicates a live row")));
  const bad = { ...SAMPLE, rows: [{ ...SAMPLE.rows[0], status: "pending" }] };
  assert.ok(validateQueue(bad).some((p) => p.includes(".status is \"pending\"")));
  const prio = { ...SAMPLE, rows: [{ ...SAMPLE.rows[0], priority: 9 }] };
  assert.ok(validateQueue(prio).some((p) => p.includes(".priority is 9")));
  const unclaimed = { ...SAMPLE, rows: [{ ...SAMPLE.rows[0], status: "claimed" }] };
  assert.ok(validateQueue(unclaimed).some((p) => p.includes("claimed with no claimed_by")));
  assert.deepEqual(validateQueue(null), ["queue: not an object"]);
});

// ── the alerts trigger (design §2.5 (ii)) ──────────────────────────────────────────────────────

const ctxWith = (owners) => ({ rosterOf: new Map(Object.entries(owners)) });
const event = (id, inj) => ({ id, kind: "status", after: { inj, injPart: "Knee", injNotes: null } });

test("researchRequests asks deep for my roster and standard for a rival's", () => {
  const ctx = ctxWith({ 1: 3, 2: 7, 3: 3 });
  const mine = researchRequests(ctx, [event("1", "Questionable"), event("2", "Out")], {
    rosterId: 3,
    includeRivals: true,
  });
  assert.deepEqual(
    mine.map((row) => [row.player_id, row.depth, row.priority, row.reason, row.requested_by]),
    [
      ["1", "deep", 2, "news", "alerts"],
      ["2", "standard", 5, "news", "alerts"],
    ],
  );
  // `sk` is the post-transition statusKey — the freshness oracle a dossier is stamped with.
  assert.equal(mine[0].sk, "Questionable|Knee|");
});

test("researchRequests drops rivals without rivalNews and free agents always", () => {
  const ctx = ctxWith({ 1: 3, 2: 7 });
  const own = researchRequests(ctx, [event("1", "Out"), event("2", "Out")], { rosterId: 3 });
  assert.deepEqual(own.map((row) => row.player_id), ["1"]);

  const fa = researchRequests(ctx, [event("404", "Out")], { rosterId: 3, includeRivals: true });
  assert.deepEqual(fa, [], "the desk's trending sweep owns the unrostered market");

  assert.deepEqual(researchRequests(ctx, [], { rosterId: 3 }), []);
  assert.deepEqual(researchRequests(ctx, null, { rosterId: 3 }), []);
  assert.deepEqual(researchRequests({}, [event("1", "Out")], { rosterId: 3 }), []);
});

test("researchRequests emits at most one row per player and keeps the deeper one", () => {
  const ctx = ctxWith({ 1: 3 });
  const rows = researchRequests(ctx, [event("1", "Questionable"), event("1", "Out")], {
    rosterId: 3,
    includeRivals: true,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depth, "deep");
});

// ── the workflow's payload parser (design §5) ──────────────────────────────────────────────────

test("parseResearchPayload accepts a dispatch and refuses everything else", () => {
  assert.deepEqual(parseResearchPayload('{"v":1,"id":"11604","depth":"deep","sk":"Q|Knee|"}'), {
    id: "11604",
    depth: "deep",
    sk: "Q|Knee|",
  });
  // A schedule or workflow_dispatch run sends "{}"; a malformed body must not fail the job.
  assert.equal(parseResearchPayload("{}"), null);
  assert.equal(parseResearchPayload("not json"), null);
  assert.equal(parseResearchPayload(undefined), null);
  assert.equal(parseResearchPayload('{"id":"../../etc/passwd"}'), null);
  assert.equal(parseResearchPayload('{"id":"11604"}').depth, "standard", "depth defaults");
  assert.equal(parseResearchPayload('{"id":"11604","depth":"nonsense"}').depth, "standard");
  assert.equal(parseResearchPayload('{"id":"11604"}').sk, null);
});
