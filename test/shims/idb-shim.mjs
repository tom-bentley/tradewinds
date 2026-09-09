// In-memory stand-in for src/idb.js — the same four calls (get/set/del/keys), same
// `{ savedAt, payload }` record shape, injected through `deps.idb` so no globals are touched.

/**
 * @param {Record<string, any>} seed key → payload, or key → `{ savedAt, payload }` to control
 *   the save time (used by the offline and "reuse recent pipeline copy" tests).
 * @param {{ savedAt?: string, fail?: boolean }} [options] `fail: true` makes every call behave
 *   like a browser with IndexedDB blocked (reads undefined, writes false).
 */
export function makeMemoryIdb(seed = {}, options = {}) {
  const { savedAt: defaultSavedAt = new Date().toISOString(), fail = false } = options;
  const store = new Map();
  for (const [key, value] of Object.entries(seed)) {
    const record =
      value && typeof value === "object" && "payload" in value
        ? { savedAt: value.savedAt ?? defaultSavedAt, payload: value.payload }
        : { savedAt: defaultSavedAt, payload: value };
    store.set(key, record);
  }

  const calls = [];
  const idb = {
    async get(key) {
      calls.push(["get", key]);
      if (fail) return undefined;
      return store.get(key);
    },
    async set(key, payload) {
      calls.push(["set", key]);
      if (fail) return false;
      store.set(key, { savedAt: new Date().toISOString(), payload });
      return true;
    },
    async del(key) {
      calls.push(["del", key]);
      if (fail) return false;
      store.delete(key);
      return true;
    },
    async keys() {
      calls.push(["keys"]);
      if (fail) return [];
      return [...store.keys()];
    },
    store,
    calls,
  };
  return idb;
}
