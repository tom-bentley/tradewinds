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
  tab: "advisor",

  // per-tab state (survives tab switches)
  // advisor.items are the Advisory objects the engine produced for MY roster this session;
  // advisor.unseen holds the keys the tab dot is lit for (cleared once the cards are on screen).
  advisor: {
    status: "idle", items: [], error: null, at: null, failed: [], unseen: [], ms: null,
  },
  // deals.scope: "team" (offers for one roster) | "league" (whole-league scan).
  // deals.forRosterId is the team the offers are FOR — my roster by default, any roster in
  // viewer mode or when the picker is used.
  // deals.tab: "trades" (offer tickets) | "fa" (the wire). The segmented control writes it
  // here so switching tabs and recomputing never loses the choice.
  deals: {
    tab: "trades",
    status: "idle", results: [], filters: { rival: "", pos: "", shape: "" }, error: null,
    scope: "team", forRosterId: null, progress: null,
    // Free agents are computed for `forRosterId` only — "whole league" is a Trades-only scope.
    fa: { status: "idle", results: [], pos: "", error: null, ms: null },
  },
  // analyze.aRosterId is side A (the side the verdict is written from); theirRosterId is side B.
  analyze: { aRosterId: null, theirRosterId: null, give: [], get: [], q: "", result: null, expanded: false, error: null },
  // league.newTradeIds drives the dot on the League tab; the League view clears it when shown.
  league: { txns: null, txnStatus: "idle", newTradeIds: [] },
  players: { q: "", },
  // alerts mirrors src/push.js state so Settings can re-render without re-reading localStorage.
  alerts: { status: null, busy: false, error: null },
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
