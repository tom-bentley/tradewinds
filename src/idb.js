// Tradewinds — minimal promise wrapper over IndexedDB (database `tradewinds`, store `kv`).
//
// This is the "last good copy" drawer: pipeline files, Sleeper responses and FantasyCalc
// overlays are stashed here so the app still opens on the subway. Every function resolves —
// never rejects — so a caller can always `await` without a try/catch: in Safari private mode,
// or wherever IndexedDB is blocked, reads resolve `undefined` and writes resolve `false`.

const DB_NAME = "tradewinds";
const STORE = "kv";
const OPEN_TIMEOUT_MS = 3000;

/** @typedef {{ savedAt: string, payload: any }} IdbRecord */

/** @type {Promise<IDBDatabase|null>|null} */
let dbPromise = null;

/** @type {{get: Function, set: Function, del: Function, keys: Function}|null} */
let backendOverride = null;

/**
 * Swap the storage backend (tests, or a future non-IDB fallback). Pass `null` to restore
 * IndexedDB. The object needs `get(key)`, `set(key, payload)`, `del(key)`, `keys()`.
 * @param {{get: Function, set: Function, del: Function, keys: Function}|null} backend
 */
export function setIdbBackend(backend) {
  backendOverride = backend;
  dbPromise = null;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const factory = globalThis.indexedDB;
      if (!factory) return done(null);
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        } catch {
          /* a failed upgrade just means no cache */
        }
      };
      request.onsuccess = () => done(request.result);
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
      // Safari occasionally leaves an open request hanging forever; don't hang the app on it.
      setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    } catch {
      done(null);
    }
  });
  return dbPromise;
}

/**
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<any>} the request result, or undefined on any failure
 */
async function withStore(mode, run) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
      tx.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Read one record.
 * @param {string} key
 * @returns {Promise<IdbRecord|undefined>} `{ savedAt, payload }`, or undefined when missing.
 */
export async function idbGet(key) {
  if (backendOverride) return backendOverride.get(key);
  const record = await withStore("readonly", (store) => store.get(key));
  return record && typeof record === "object" && "payload" in record ? record : undefined;
}

/**
 * Write one record, stamped with the time it was saved.
 * @param {string} key
 * @param {any} payload
 * @returns {Promise<boolean>} true when it landed.
 */
export async function idbSet(key, payload) {
  if (backendOverride) return backendOverride.set(key, payload);
  const record = { savedAt: new Date().toISOString(), payload };
  const result = await withStore("readwrite", (store) => store.put(record, key));
  return result !== undefined;
}

/**
 * Delete one record.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function idbDelete(key) {
  if (backendOverride) return backendOverride.del(key);
  await withStore("readwrite", (store) => store.delete(key));
  return true;
}

/**
 * List every key currently cached (used by Settings → "clear cache").
 * @returns {Promise<string[]>}
 */
export async function idbKeys() {
  if (backendOverride) return backendOverride.keys();
  const keys = await withStore("readonly", (store) => store.getAllKeys());
  return Array.isArray(keys) ? keys.map(String) : [];
}

/** The bundle data.js uses, so a caller can inject a different store via `deps.idb`. */
export const idb = Object.freeze({
  get: idbGet,
  set: idbSet,
  del: idbDelete,
  keys: idbKeys,
});
