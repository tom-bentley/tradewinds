// Tradewinds — one mutable store plus a 20-line pub/sub. No framework, no proxies.
// Views read `store` directly and call `set()`/`emit()` to notify; app.js re-renders.

const subs = new Set();

export const store = {
  // boot
  status: "booting", // booting | ready | error
  bootStep: "",
  bootPct: 0,
  error: null,
  mode: "live", // live | mock

  // data
  settings: null,
  ctx: null,
  freshness: null,
  errors: [],

  // routing
  tab: "deals",

  // per-tab state (survives tab switches)
  deals: { status: "idle", results: [], filters: { rival: "", pos: "", shape: "" }, error: null },
  analyze: { theirRosterId: null, give: [], get: [], q: "", result: null, expanded: false, error: null },
  league: { txns: null, txnStatus: "idle" },
  players: { q: "", },
  settingsTab: { leagues: null, lookup: "idle", lookupError: null, username: "" },
};

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function emit(reason = "") {
  for (const fn of [...subs]) {
    try {
      fn(store, reason);
    } catch (e) {
      console.error("[store] subscriber failed", e);
    }
  }
}

export function set(patch, reason = "") {
  Object.assign(store, patch);
  emit(reason);
}

/** Shallow-merge into a nested slice, then notify. */
export function setIn(key, patch, reason = key) {
  store[key] = { ...store[key], ...patch };
  emit(reason);
}

/** Toggle an id inside store.analyze.give / .get; returns the new array. */
export function toggleSide(side, id) {
  const cur = store.analyze[side] || [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  store.analyze[side] = next;
  return next;
}

export function resetAnalyze(theirRosterId = store.analyze.theirRosterId) {
  store.analyze = { theirRosterId, give: [], get: [], q: "", result: null, expanded: false, error: null };
}
