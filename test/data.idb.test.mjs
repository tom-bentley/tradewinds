import test from "node:test";
import assert from "node:assert/strict";

import { idb, idbDelete, idbGet, idbKeys, idbSet, setIdbBackend } from "../src/idb.js";
import { clearCache } from "../src/data.js";
import { makeMemoryIdb } from "./shims/idb-shim.mjs";

test("with no IndexedDB (Node, or Safari private mode) every call resolves quietly", async (t) => {
  setIdbBackend(null); // clear any memoized handle
  t.after(() => setIdbBackend(null));

  assert.equal(await idbGet("pipeline:players.json"), undefined);
  assert.equal(await idbSet("pipeline:players.json", { a: 1 }), false);
  assert.equal(await idbDelete("pipeline:players.json"), true);
  assert.deepEqual(await idbKeys(), []);
});

test("an IndexedDB that throws on open is treated as no IndexedDB", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    value: {
      open() {
        throw new Error("blocked by the browser");
      },
    },
    configurable: true,
    writable: true,
  });
  setIdbBackend(null);
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else delete globalThis.indexedDB;
    setIdbBackend(null);
  });

  assert.equal(await idbGet("k"), undefined);
  assert.equal(await idbSet("k", 1), false);
});

test("the backend hook stores { savedAt, payload } records", async (t) => {
  const memory = makeMemoryIdb();
  setIdbBackend(memory);
  t.after(() => setIdbBackend(null));

  await idbSet("sleeper:league:1", { name: "Boyball" });
  const record = await idbGet("sleeper:league:1");

  assert.deepEqual(record.payload, { name: "Boyball" });
  assert.match(record.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await idbKeys(), ["sleeper:league:1"]);
  await idbDelete("sleeper:league:1");
  assert.deepEqual(await idbKeys(), []);
});

test("the exported idb bundle is what data.js injects", () => {
  assert.deepEqual(Object.keys(idb).sort(), ["del", "get", "keys", "set"]);
});

test("clearCache empties every cached key", async () => {
  const memory = makeMemoryIdb({ "pipeline:players.json": { count: 1 }, "sleeper:league:1": {} });
  const removed = await clearCache({ deps: { idb: memory } });
  assert.equal(removed, 2);
  assert.equal(memory.store.size, 0);
});
