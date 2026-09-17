// In-memory stand-in for the raw IndexedDB API the service worker uses (design §13.3 B1).
//
// sw.js is a classic script and cannot import src/idb.js, so it talks to `self.indexedDB`
// directly: open/onupgradeneeded, createObjectStore (keyPath + autoIncrement, and out-of-line),
// transaction/objectStore, add/put/get/getAll/getAllKeys/delete, and the transaction's
// `oncomplete`. This shim implements exactly that surface — enough to prove the receipt log
// works, small enough to read in one sitting.
//
// Faithful in the two ways that matter: request callbacks fire ASYNCHRONOUSLY (the caller
// assigns `onsuccess` after the call returns), and a read-write transaction fires `oncomplete`
// only after its last request settled.

/** A request whose handlers are assigned after it is returned, like the real thing. */
function makeRequest(run) {
  const request = { onsuccess: null, onerror: null, result: undefined, error: null };
  queueMicrotask(() => {
    try {
      request.result = run();
      if (typeof request.onsuccess === "function") request.onsuccess({ target: request });
    } catch (error) {
      request.error = error;
      if (typeof request.onerror === "function") request.onerror({ target: request });
    }
  });
  return request;
}

class MemoryObjectStore {
  /** @param {{name: string, keyPath?: string|null, autoIncrement?: boolean}} options */
  constructor({ name, keyPath = null, autoIncrement = false }) {
    this.name = name;
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
    /** @type {Map<any, any>} insertion order is key order here: keys only ever grow. */
    this.rows = new Map();
    this.nextKey = 1;
  }
}

/** One live transaction. `pending` keeps it open until every request it issued has settled. */
class MemoryTransaction {
  constructor(db, storeNames, mode) {
    this.db = db;
    this.mode = mode;
    this.storeNames = storeNames;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.pending = 0;
    this.finished = false;
    this.scheduled = false;
  }

  objectStore(name) {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`NotFoundError: no object store "${name}"`);
    return wrapStore(store, this);
  }

  /** Commit once the microtask queue drains with nothing outstanding. */
  schedule() {
    if (this.scheduled || this.finished) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      if (typeof this.oncomplete === "function") this.oncomplete({ target: this });
    });
  }

  track(run) {
    this.pending += 1;
    const request = makeRequest(() => {
      try {
        return run();
      } finally {
        this.pending -= 1;
        this.schedule();
      }
    });
    this.schedule();
    return request;
  }
}

/** The IDBObjectStore face of a store, bound to one transaction. */
function wrapStore(store, tx) {
  const readonly = tx.mode !== "readwrite";
  const guard = () => {
    if (readonly) throw new Error("ReadOnlyError: the transaction is read-only");
  };
  const keyFor = (value, explicitKey) => {
    if (explicitKey !== undefined) return explicitKey;
    if (store.keyPath && value && typeof value === "object" && value[store.keyPath] !== undefined) {
      return value[store.keyPath];
    }
    if (store.autoIncrement) {
      const key = store.nextKey;
      store.nextKey += 1;
      if (store.keyPath && value && typeof value === "object") value[store.keyPath] = key;
      return key;
    }
    throw new Error("DataError: no key and the store is not auto-incrementing");
  };
  return {
    name: store.name,
    keyPath: store.keyPath,
    add: (value, key) =>
      tx.track(() => {
        guard();
        const k = keyFor(value, key);
        if (store.rows.has(k)) throw new Error("ConstraintError: key exists");
        store.rows.set(k, value);
        return k;
      }),
    put: (value, key) =>
      tx.track(() => {
        guard();
        const k = keyFor(value, key);
        store.rows.set(k, value);
        return k;
      }),
    get: (key) => tx.track(() => store.rows.get(key)),
    getAll: () => tx.track(() => [...store.rows.values()]),
    getAllKeys: () => tx.track(() => [...store.rows.keys()]),
    delete: (key) =>
      tx.track(() => {
        guard();
        store.rows.delete(key);
        return undefined;
      }),
    count: () => tx.track(() => store.rows.size),
  };
}

class MemoryDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    /** @type {Map<string, MemoryObjectStore>} */
    this.stores = new Map();
    this.closed = false;
  }
  get objectStoreNames() {
    const names = [...this.stores.keys()];
    return { contains: (name) => this.stores.has(name), length: names.length, ...names };
  }
  createObjectStore(name, options = {}) {
    const store = new MemoryObjectStore({ name, ...options });
    this.stores.set(name, store);
    return store;
  }
  transaction(names, mode = "readonly") {
    if (this.closed) throw new Error("InvalidStateError: the database is closed");
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
      if (!this.stores.has(name)) throw new Error(`NotFoundError: no object store "${name}"`);
    }
    return new MemoryTransaction(this, list, mode);
  }
  close() {
    this.closed = true;
  }
}

/**
 * A fake `indexedDB` factory whose data survives `close()` — the same database is handed back on
 * every open, which is what a persistent store does.
 *
 * @param {{fail?: boolean, blocked?: boolean}} [options] `fail` rejects every open (IDB disabled,
 *   the Safari-private-mode case); `blocked` fires `onblocked` instead.
 * @returns {{open: Function, databases: Map<string, MemoryDatabase>}}
 */
export function makeMemoryIndexedDb(options = {}) {
  const { fail = false, blocked = false } = options;
  /** @type {Map<string, MemoryDatabase>} */
  const databases = new Map();

  const open = (name, version = 1) => {
    const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: undefined, error: null };
    queueMicrotask(() => {
      if (fail) {
        request.error = new Error("IndexedDB is disabled");
        if (typeof request.onerror === "function") request.onerror({ target: request });
        return;
      }
      if (blocked) {
        if (typeof request.onblocked === "function") request.onblocked({ target: request });
        return;
      }
      let db = databases.get(name);
      const fresh = !db || db.version < version;
      if (!db) {
        db = new MemoryDatabase(name, version);
        databases.set(name, db);
      }
      db.closed = false;
      request.result = db;
      if (fresh) {
        db.version = version;
        if (typeof request.onupgradeneeded === "function") request.onupgradeneeded({ target: request });
      }
      if (typeof request.onsuccess === "function") request.onsuccess({ target: request });
    });
    return request;
  };

  return { open, databases };
}
