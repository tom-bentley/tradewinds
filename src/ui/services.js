// Tradewinds — the single seam between the UI and everything it does not own.
//
// Normal load resolves `src/data.js` + `src/engine/*`. With `?mock=1` (or the sticky
// `tradewinds.mock` flag) it resolves `src/ui/mock.js`, which implements the same surface
// from the committed test fixtures. Nothing else in src/ui/ imports the engine directly, so
// the contract below is the complete list of what the UI expects other agents to ship.

const qs = new URLSearchParams(location.search);
export const MOCK =
  qs.get("mock") === "1" || (qs.get("mock") !== "0" && localStorage.getItem("tradewinds.mock") === "1");

if (qs.has("mock")) {
  try {
    if (qs.get("mock") === "1") localStorage.setItem("tradewinds.mock", "1");
    else localStorage.removeItem("tradewinds.mock");
  } catch { /* private mode */ }
}

export class ServicesError extends Error {
  constructor(message, missing) {
    super(message);
    this.name = "ServicesError";
    this.missing = missing || [];
  }
}

let pending = null;

/** Resolve (once) the whole service surface. Throws ServicesError if a module is missing. */
export function services() {
  if (!pending) pending = MOCK ? loadMock() : loadLive();
  return pending;
}

async function loadMock() {
  const m = await import("./mock.js");
  return { mode: "mock", ...m.api };
}

async function loadLive() {
  const specs = [
    ["data", "../data.js"],
    ["values", "../engine/values.js"],
    ["lineup", "../engine/lineup.js"],
    ["trade", "../engine/trade.js"],
    ["finder", "../engine/finder.js"],
    ["explain", "../engine/explain.js"],
  ];
  const settled = await Promise.allSettled(specs.map(([, p]) => import(/* @vite-ignore */ p)));
  const missing = [];
  const mods = {};
  settled.forEach((r, i) => {
    const [name, path] = specs[i];
    if (r.status === "fulfilled") mods[name] = r.value;
    else missing.push({ name, path, message: String(r.reason && r.reason.message) });
  });
  if (missing.length) {
    throw new ServicesError(
      "Some app modules could not be loaded: " + missing.map((m) => m.path).join(", "),
      missing
    );
  }

  // sleeper.js is optional here: data.js is expected to re-export the two lookup helpers,
  // but fall back to the raw client if it does not.
  let sleeper = null;
  if (!mods.data.lookupUser || !mods.data.listLeagues) {
    try { sleeper = await import("../sleeper.js"); } catch { /* optional */ }
  }

  return {
    mode: "live",

    // ---- src/data.js ------------------------------------------------------------------
    loadSettings: mods.data.loadSettings,
    saveSettings: mods.data.saveSettings,
    loadAll: mods.data.loadAll,
    refreshLive: mods.data.refreshLive,
    getTransactions: mods.data.getTransactions,
    lookupUser: mods.data.lookupUser || (sleeper && sleeper.getUser) || null,
    listLeagues: mods.data.listLeagues || (sleeper && sleeper.getUserLeagues) || null,
    clearCache: mods.data.clearCache || null,

    // ---- src/engine/values.js ---------------------------------------------------------
    marketValue: mods.values.marketValue,
    waiverReplacement: mods.values.waiverReplacement,
    sideValue: mods.values.sideValue,
    surplus: mods.values.surplus,

    // ---- src/engine/lineup.js ---------------------------------------------------------
    bestLineup: mods.lineup.bestLineup,
    seasonLineup: mods.lineup.seasonLineup,

    // ---- src/engine/{trade,finder,explain}.js -----------------------------------------
    evaluateTrade: mods.trade.evaluateTrade,
    findTrades: mods.finder.findTrades,
    explain: mods.explain.explain,
  };
}
