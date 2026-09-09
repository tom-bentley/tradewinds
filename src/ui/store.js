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
  lastLiveAt: 0, // ms timestamp of the last successful live Sleeper/FantasyCalc load
  errors: [],

  // routing
  tab: "deals",

  // per-tab state (survives tab switches)
  // deals.scope: "team" (offers for one roster) | "league" (whole-league scan).
  // deals.forRosterId is the team the offers are FOR — my roster by default, any roster in
  // viewer mode or when the picker is used.
  deals: {
    status: "idle", results: [], filters: { rival: "", pos: "", shape: "" }, error: null,
    scope: "team", forRosterId: null, progress: null,
  },
  // analyze.aRosterId is side A (the side the verdict is written from); theirRosterId is side B.
  analyze: { aRosterId: null, theirRosterId: null, give: [], get: [], q: "", result: null, expanded: false, error: null },
  league: { txns: null, txnStatus: "idle" },
  players: { q: "", },
  setup: { status: "idle", username: "", userId: null, leagues: null, error: null, byId: false, leagueId: "", season: null },
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

export function resetAnalyze(theirRosterId = store.analyze.theirRosterId, aRosterId = store.analyze.aRosterId) {
  store.analyze = { aRosterId, theirRosterId, give: [], get: [], q: "", result: null, expanded: false, error: null };
}
