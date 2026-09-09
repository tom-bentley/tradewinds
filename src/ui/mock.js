// Tradewinds — MOCK service layer (`?mock=1` only).
//
// Implements the exact surface of src/data.js + src/engine/* described in design.md §4/§5,
// backed by the committed 2026-09-09 fixtures in test/fixtures/. It exists so the UI can be
// built and screenshotted before the engine and data agents land; the real modules replace it
// wholesale through src/ui/services.js. The arithmetic follows R3 Part 2 closely enough that
// the numbers on screen are plausible, but this is NOT the engine of record.

import { DEFAULTS, STORAGE_KEY, LAST_SCORING_WEEK } from "../config.js";

const FIX = (name) => new URL(`../../test/fixtures/${name}`, import.meta.url).href;

const INJURY_DISCOUNT = { Questionable: 0.03, Doubtful: 0.1, Out: 0.15, IR: 0.35, PUP: 0.4, NA: 0.4, Sus: 0.25, DNR: 0.4 };
const OUT_SET = new Set(["Out", "IR", "PUP", "Sus", "DNR", "NA", "Doubtful"]);
const CURVE = { A: 7734, k: 0.0202 };
const TRADEABLE = new Set(["QB", "RB", "WR", "TE"]);

/* ============================================================ settings */

function normalizeSettings(raw = {}) {
  const w = raw.weights || {};
  return {
    leagueId: raw.leagueId || DEFAULTS.leagueId,
    userId: raw.userId || DEFAULTS.userId,
    username: raw.username || DEFAULTS.username,
    season: raw.season || DEFAULTS.season,
    weights: { fc_redraft: num(w.fc_redraft, 0.8), proj: num(w.proj, 0.2) },
    dynastyWeights: { fc_dynasty: 0.7, dp_dynasty: 0.3 },
    keeperTilt: num(raw.keeperTilt ?? raw.keeperWeight, 0.15),
    rho: num(raw.rho ?? raw.riskAversion, 1.0),
    playoffWeight: num(raw.playoffWeight, 2.0),
    injuryDiscount: { ...INJURY_DISCOUNT, ...(raw.injuryDiscount || {}) },
    finder: {
      shapes: (raw.finder && raw.finder.shapes) || ["1-1", "2-1", "1-2"],
      perRival: num(raw.finder && (raw.finder.perRival ?? raw.finder.maxPerRival), 2),
      maxResults: num(raw.finder && raw.finder.maxResults, 10),
    },
  };
}

function num(v, d) { return typeof v === "number" && Number.isFinite(v) ? v : d; }

export function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { /* ignore */ }
  return normalizeSettings({ ...DEFAULTS, ...stored });
}

export function saveSettings(patch) {
  const next = normalizeSettings({ ...loadSettings(), ...patch });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

export function clearCache() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  return Promise.resolve(true);
}

/* ============================================================ loading */

let raw = null;

async function fetchFixtures(onProgress) {
  if (raw) return raw;
  const files = [
    ["league", "league.json"], ["users", "users.json"], ["rosters", "rosters.json"],
    ["players", "players.json"], ["projections", "projections.json"], ["values", "values.json"],
    ["schedule", "schedule.json"], ["state", "state.json"], ["trending", "trending_add.json"],
    ["transactions", "transactions_1.json"], ["meta", "meta.json"],
  ];
  const out = {};
  let done = 0;
  await Promise.all(files.map(async ([key, file]) => {
    const r = await fetch(FIX(file), { cache: "no-store" });
    if (!r.ok) throw new Error(`fixture ${file}: HTTP ${r.status}`);
    out[key] = await r.json();
    done += 1;
    onProgress && onProgress({ step: "Reading league data", pct: Math.round((done / files.length) * 70) });
  }));
  raw = out;
  return out;
}

function buildContext(input, settings) {
  const { league, users, rosters, players, projections, values, schedule, state } = input;
  const userById = new Map(users.map((u) => [u.user_id, u]));
  const rosterPositions = league.roster_positions || [];
  const slots = rosterPositions.filter((p) => p !== "BN" && p !== "IR");
  const week = Math.max(1, Number(state.week) || 1);

  const pMap = new Map(Object.entries(players.players));
  const projMap = new Map(Object.entries(projections.players));

  const normRosters = rosters.map((r) => {
    const u = userById.get(r.owner_id) || {};
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      displayName: u.display_name || `Roster ${r.roster_id}`,
      teamName: (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${r.roster_id}`,
      avatar: u.avatar || null,
      players: (r.players || []).slice(),
      starters: (r.starters || []).slice(),
      reserve: (r.reserve || []).slice(),
      taxi: (r.taxi || []).slice(),
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      fpts: (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100,
      waiverBudgetUsed: r.settings?.waiver_budget_used ?? 0,
    };
  }).sort((a, b) => a.rosterId - b.rosterId);

  const rosterOf = new Map();
  for (const r of normRosters) for (const id of r.players) rosterOf.set(id, r.rosterId);

  const mine = normRosters.find((r) => r.ownerId === settings.userId) || normRosters[0];

  const weeksLeft = [];
  for (let w = week; w <= LAST_SCORING_WEEK; w += 1) weeksLeft.push(w);

  return {
    league: {
      id: league.league_id,
      name: league.name,
      numTeams: league.settings?.num_teams ?? normRosters.length,
      rosterPositions,
      maxRoster: rosterPositions.filter((p) => p !== "IR").length,
      irSlots: rosterPositions.filter((p) => p === "IR").length,
      tradeDeadlineWeek: league.settings?.trade_deadline ?? 10,
      vetoVotesNeeded: league.settings?.veto_votes_needed ?? 5,
      tradeReviewDays: league.settings?.trade_review_days ?? 1,
      scoring: league.scoring_settings || {},
      playoffWeekStart: league.settings?.playoff_week_start ?? 15,
    },
    season: state.season,
    week,
    lastWeek: LAST_SCORING_WEEK,
    weeksLeft,
    playoffWeeks: [15, 16, 17],
    slots,
    flexEligible: new Set(["RB", "WR", "TE"]),
    players: pMap,
    proj: projMap,
    values: values.sources,
    byes: schedule.byes || {},
    rosters: normRosters,
    rosterOf,
    myRosterId: mine.rosterId,
    settings,
    trending: (input.trending || []).slice(0, 12).map((t) => ({ id: t.player_id, count: t.count })),
    meta: { pipeline: input.meta?.generated_at || null, players: players.generated_at, values: values.generated_at },
    memo: {},
  };
}

export async function loadAll({ settings, onProgress } = {}) {
  const s = normalizeSettings(settings || loadSettings());
  onProgress && onProgress({ step: "Loading cached values", pct: 8 });
  const input = await fetchFixtures(onProgress);
  onProgress && onProgress({ step: "Reading live rosters", pct: 82 });
  await sleep(120);
  onProgress && onProgress({ step: "Building the trade context", pct: 94 });
  const ctx = buildContext(input, s);
  return {
    ctx,
    freshness: {
      pipeline: input.meta?.generated_at || null,
      live: new Date().toISOString(),
      values: "pipeline",
      offline: false,
      stale: false,
      mock: true,
    },
    errors: [{ source: "mock", message: "Demo data — fixtures from 2026-09-09, not a live league read." }],
  };
}

export async function refreshLive(settings) {
  const out = await loadAll({ settings });
  out.freshness.live = new Date().toISOString();
  out.freshness.values = "live";
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================ values.js */

function rosPoints(ctx, id) {
  const wk = ctx.proj.get(id);
  if (!wk) return 0;
  let t = 0;
  for (const w of ctx.weeksLeft) t += wk[w - 1] || 0;
  return t;
}

function rosRanks(ctx) {
  if (ctx.memo.rosRank) return ctx.memo.rosRank;
  const rows = [];
  for (const [id, p] of ctx.players) {
    if (!TRADEABLE.has(p.pos)) continue;
    const pts = rosPoints(ctx, id);
    if (pts > 0) rows.push([id, pts]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  const m = new Map();
  rows.forEach(([id], i) => m.set(id, i + 1));
  ctx.memo.rosRank = m;
  return m;
}

export function marketValue(ctx, id) {
  const cache = ctx.memo.mv || (ctx.memo.mv = new Map());
  if (cache.has(id)) return cache.get(id);

  const p = ctx.players.get(id);
  const out = {
    m: null, mAdj: null, redraft: null, dynasty: null, projV: null, sources: {},
    coverage: 0, fallback: null, rank: null, posRank: null, tier: null, trend: null,
    rosterPct: null, tradeFreq: null, sd: null,
  };
  if (!p || !TRADEABLE.has(p.pos)) { cache.set(id, out); return out; }

  const fc = ctx.values.fc_redraft?.values?.[id];
  const fd = ctx.values.fc_dynasty?.values?.[id];
  const rank = rosRanks(ctx).get(id);
  const projV = rank ? Math.round(CURVE.A * Math.exp(-CURVE.k * rank)) : null;

  const w = ctx.settings.weights;
  let numr = 0, den = 0;
  if (fc && fc.v != null) { out.sources.fc_redraft = fc.v; numr += w.fc_redraft * fc.v; den += w.fc_redraft; }
  if (projV != null) { out.sources.proj = projV; numr += w.proj * projV; den += w.proj; }
  out.projV = projV;
  out.redraft = den > 0 ? numr / den : null;
  out.dynasty = fd && fd.v != null ? fd.v : null;
  if (fd && fd.v != null) out.sources.fc_dynasty = fd.v;

  if (out.redraft == null) { cache.set(id, out); return out; }
  out.coverage = (fc ? 1 : 0) / 1;
  out.fallback = fc ? "blend" : "curve";

  const phi = ctx.settings.keeperTilt;
  out.m = Math.round((1 - phi) * out.redraft + phi * (out.dynasty ?? out.redraft));
  const disc = p.inj ? ctx.settings.injuryDiscount[p.inj] || 0 : 0;
  out.mAdj = Math.round(out.m * (1 - disc));
  out.rank = fc?.r ?? null;
  out.posRank = fc?.pr ?? null;
  out.tier = fc?.tier ?? null;
  out.trend = fc?.t ?? null;
  out.rosterPct = fc?.rp ?? null;
  out.tradeFreq = fc?.tf ?? null;
  out.sd = fc?.sd ?? null;

  cache.set(id, out);
  return out;
}

export function waiverReplacement(ctx) {
  if (ctx.memo.waiver) return ctx.memo.waiver;
  const best = {};
  for (const [id, p] of ctx.players) {
    if (!TRADEABLE.has(p.pos)) continue;
    if (ctx.rosterOf.has(id)) continue;
    const mv = marketValue(ctx, id);
    if (mv.mAdj == null) continue;
    if (!best[p.pos] || mv.mAdj > best[p.pos].m) best[p.pos] = { id, m: mv.mAdj };
  }
  const val = (pos) => best[pos]?.m ?? 0;
  const out = {
    QB: val("QB"), RB: val("RB"), WR: val("WR"), TE: val("TE"),
    FLEX: Math.max(val("RB"), val("WR"), val("TE")),
    best,
  };
  ctx.memo.waiver = out;
  return out;
}

export function surplus(ctx, id) {
  const mv = marketValue(ctx, id);
  if (mv.mAdj == null) return 0;
  const pos = ctx.players.get(id)?.pos;
  const W = waiverReplacement(ctx);
  return Math.max(mv.mAdj - ctx.settings.rho * (W[pos] ?? 0), 0);
}

export function sideValue(ctx, ids) {
  let rawV = 0, sur = 0, best = null, bestV = -1;
  for (const id of ids || []) {
    const mv = marketValue(ctx, id);
    if (mv.mAdj != null) {
      rawV += mv.mAdj;
      if (mv.mAdj > bestV) { bestV = mv.mAdj; best = id; }
    }
    sur += surplus(ctx, id);
  }
  return { raw: Math.round(rawV), surplus: Math.round(sur), best };
}

/* ============================================================ lineup.js */

export function bestLineup(ctx, ids, week) {
  const pool = [];
  for (const id of ids) {
    const p = ctx.players.get(id);
    if (!p) continue;
    let pts = ctx.proj.get(id)?.[week - 1] || 0;
    if (week === ctx.week && p.inj && OUT_SET.has(p.inj)) pts = 0;
    pool.push({ id, pos: p.pos, pts });
  }
  pool.sort((a, b) => b.pts - a.pts);
  const used = new Set();
  const filled = [];
  const short = [];
  const dedicated = ctx.slots.filter((s) => s !== "FLEX");
  const flexes = ctx.slots.filter((s) => s === "FLEX");

  for (const slot of dedicated) {
    const pick = pool.find((x) => !used.has(x.id) && x.pos === slot);
    if (pick) { used.add(pick.id); filled.push({ slot, id: pick.id, pts: pick.pts }); }
    else { filled.push({ slot, id: null, pts: 0 }); short.push(slot); }
  }
  for (const slot of flexes) {
    const pick = pool.find((x) => !used.has(x.id) && ctx.flexEligible.has(x.pos));
    if (pick) { used.add(pick.id); filled.push({ slot, id: pick.id, pts: pick.pts }); }
    else { filled.push({ slot, id: null, pts: 0 }); short.push(slot); }
  }
  const total = filled.reduce((s, f) => s + f.pts, 0);
  return { slots: filled, total, short, bench: pool.filter((x) => !used.has(x.id)).map((x) => x.id) };
}

export function seasonLineup(ctx, ids, { weeks = ctx.weeksLeft, playoffWeight = ctx.settings.playoffWeight } = {}) {
  const perWeek = [];
  let total = 0, weighted = 0, wsum = 0, poTotal = 0, poCount = 0;
  const shortWeeks = [];
  for (const w of weeks) {
    const L = bestLineup(ctx, ids, w);
    const om = ctx.playoffWeeks.includes(w) ? playoffWeight : 1;
    perWeek.push({ week: w, total: L.total, short: L.short });
    total += L.total;
    weighted += om * L.total;
    wsum += om;
    if (ctx.playoffWeeks.includes(w)) { poTotal += L.total; poCount += 1; }
    if (L.short.length) shortWeeks.push(w);
  }
  return {
    total, weighted, perWeek,
    avgPerWeek: wsum ? weighted / wsum : 0,
    playoffAvg: poCount ? poTotal / poCount : 0,
    shortWeeks,
  };
}

export function backfill(ctx, ids, targetCount, exclude = []) {
  const have = new Set(ids);
  const skip = new Set(exclude);
  const added = [];
  const need = targetCount - ids.length;
  if (need <= 0) return { ids: ids.slice(), added };
  const free = [];
  for (const [id, p] of ctx.players) {
    if (!TRADEABLE.has(p.pos) || ctx.rosterOf.has(id) || have.has(id) || skip.has(id)) continue;
    const mv = marketValue(ctx, id);
    if (mv.mAdj == null) continue;
    free.push({ id, pos: p.pos, m: mv.mAdj, pts: rosPoints(ctx, id) });
  }
  free.sort((a, b) => b.pts - a.pts || b.m - a.m);
  const out = ids.slice();
  for (let i = 0; i < need && i < free.length; i += 1) {
    out.push(free[i].id);
    added.push({ id: free[i].id, pos: free[i].pos, m: free[i].m });
  }
  return { ids: out, added };
}

/* ============================================================ trade.js */

const THRESHOLDS = [
  [25, "steal", "Steal — accept now"],
  [10, "clear_win", "Clear win"],
  [4, "slight_win", "Slight win"],
  [-4, "fair", "Fair"],
  [-10, "slight_loss", "Slight loss"],
  [-25, "clear_loss", "Clear loss — decline"],
];

function labelFor(edge) {
  for (const [t, code, label] of THRESHOLDS) if (edge >= t) return { code, label };
  return { code: "fleeced", label: "Fleeced — decline" };
}

function edgeOf(giveS, getS) {
  const denom = Math.max(giveS, getS);
  return denom > 0 ? (100 * (getS - giveS)) / denom : 0;
}

function sideFor(ctx, roster, give, get) {
  const before = roster.players.slice();
  let afterIds = before.filter((id) => !give.includes(id)).concat(get);
  const bf = backfill(ctx, afterIds, before.length, [...give]);
  afterIds = bf.ids;
  const valueGive = sideValue(ctx, give);
  const valueGet = sideValue(ctx, get);
  const lb = seasonLineup(ctx, before);
  const la = seasonLineup(ctx, afterIds);
  const ir = (roster.reserve || []).length;
  const count = { before: before.length - ir, after: before.length - ir - give.length + get.length, max: ctx.league.maxRoster };
  let dropSuggestion = null;
  if (count.after > count.max) {
    const cands = afterIds
      .filter((id) => !get.includes(id))
      .map((id) => ({ id, s: surplus(ctx, id), pts: rosPoints(ctx, id) }))
      .sort((a, b) => a.s - b.s || a.pts - b.pts);
    dropSuggestion = cands[0]?.id ?? null;
  }
  return {
    valueGive, valueGet,
    edgePct: edgeOf(valueGive.surplus, valueGet.surplus),
    lineup: {
      before: lb, after: la,
      deltaPerWeek: la.avgPerWeek - lb.avgPerWeek,
      deltaPlayoffPerWeek: la.playoffAvg - lb.playoffAvg,
    },
    rosterCount: count,
    backfill: bf.added.map((a) => a.id),
    backfillDetail: bf.added,
    dropSuggestion,
    afterIds,
  };
}

export function evaluateTrade(ctx, { myRosterId, theirRosterId, give, get }) {
  const mine = ctx.rosters.find((r) => r.rosterId === myRosterId);
  const theirs = ctx.rosters.find((r) => r.rosterId === theirRosterId);
  if (!mine || !theirs) throw new Error("Unknown roster");

  const me = sideFor(ctx, mine, give, get);
  const them = sideFor(ctx, theirs, get, give);

  let { code, label } = labelFor(me.edgePct);
  let override = null;
  const flags = [];

  if (ctx.week > ctx.league.tradeDeadlineWeek) {
    flags.push({ type: "deadline", severity: "block", text: `Trade deadline passed after week ${ctx.league.tradeDeadlineWeek}.` });
  }
  if (me.lineup.after.shortWeeks.length && !me.lineup.before.shortWeeks.length) {
    code = "invalid"; label = `Invalid — leaves you short in week ${me.lineup.after.shortWeeks[0]}`;
    flags.push({ type: "short", severity: "block", text: `No legal lineup in week ${me.lineup.after.shortWeeks[0]}.` });
  } else if (me.rosterCount.after > me.rosterCount.max) {
    code = "needs_drop";
    const dp = ctx.players.get(me.dropSuggestion);
    label = "Requires a drop";
    flags.push({ type: "roster_size", severity: "block", text: `Roster would hold ${me.rosterCount.after} of ${me.rosterCount.max}. Cheapest drop: ${dp ? dp.name : "—"}.` });
  } else if (me.edgePct >= -10 && me.edgePct <= 4 && me.lineup.deltaPerWeek >= 1.5) {
    code = "clear_win"; label = "Win — you get better now"; override = "lineup_win";
  } else if (me.edgePct >= 10 && me.lineup.deltaPerWeek <= -1.5) {
    code = "fair"; label = "Fair — you win on paper, lose on the field"; override = "paper_win";
  }

  const veto = Math.abs(me.edgePct) >= 40;
  if (veto) flags.push({ type: "deadline", severity: "warn", text: `Lopsided — ${ctx.league.vetoVotesNeeded} of ${ctx.league.numTeams} owners can veto within 24 hours.` });

  for (const id of [...give, ...get]) {
    const p = ctx.players.get(id);
    if (!p) continue;
    const mv = marketValue(ctx, id);
    if (p.inj) flags.push({ type: "injury", severity: OUT_SET.has(p.inj) ? "warn" : "info", text: `${p.name} is ${p.inj}.` });
    const rp = mv.rosterPct == null ? null : mv.rosterPct <= 1 ? mv.rosterPct * 100 : mv.rosterPct;
    if (rp != null && rp < 50) flags.push({ type: "free_elsewhere", severity: "warn", text: `${p.name} is rostered in only ${Math.round(rp)}% of leagues — probably free on the wire.` });
    if (mv.trend != null && Math.abs(mv.trend) >= 350) {
      flags.push({ type: "trend", severity: "info", text: `${p.name} is ${mv.trend > 0 ? "up" : "down"} ${Math.abs(mv.trend)} over 30 days — the market is ${mv.trend > 0 ? "chasing" : "fleeing"} him.` });
    }
    if (mv.m == null) flags.push({ type: "coverage", severity: "warn", text: `${p.name} has no market value — K and DEF are not priced.` });
  }
  const byeGet = get.map((id) => ctx.byes?.[ctx.players.get(id)?.team]).filter(Boolean);
  if (byeGet.length > 1 && new Set(byeGet).size === 1) {
    flags.push({ type: "bye", severity: "info", text: `Both incoming players are on bye in week ${byeGet[0]}.` });
  }

  const acceptLikely = them.edgePct >= -2 || them.lineup.deltaPerWeek >= 0.75;

  const bg = sideValue(ctx, give), bn = sideValue(ctx, get);
  const bestId = (marketValue(ctx, bn.best).mAdj ?? -1) >= (marketValue(ctx, bg.best).mAdj ?? -1) ? bn.best : bg.best;
  const best = bestId ? { id: bestId, side: get.includes(bestId) ? "me" : "them" } : null;

  const result = {
    give: give.slice(), get: get.slice(), myRosterId, theirRosterId,
    me: strip(me), them: strip(them),
    verdict: {
      code, label,
      edgePct: me.edgePct,
      deltaPerWeek: me.lineup.deltaPerWeek,
      deltaPlayoffPerWeek: me.lineup.deltaPlayoffPerWeek,
      override, veto, acceptLikely,
    },
    flags, reasons: [], best,
  };
  result.reasons = explain(ctx, result).lines;
  return result;
}

function strip(s) {
  const { afterIds, ...rest } = s;
  return { ...rest, afterIds };
}

/* ============================================================ finder.js */

export function findTrades(ctx, { myRosterId, perRival, maxResults } = {}) {
  const mine = ctx.rosters.find((r) => r.rosterId === (myRosterId ?? ctx.myRosterId));
  const cap = perRival ?? ctx.settings.finder.perRival ?? 2;
  const limit = maxResults ?? ctx.settings.finder.maxResults ?? 10;
  const W = waiverReplacement(ctx);

  const tradeable = (r) => r.players
    .map((id) => ({ id, p: ctx.players.get(id), mv: marketValue(ctx, id) }))
    .filter((x) => x.p && TRADEABLE.has(x.p.pos) && x.mv.mAdj != null && x.mv.mAdj > (W[x.p.pos] ?? 0))
    .sort((a, b) => b.mv.mAdj - a.mv.mAdj)
    .slice(0, 9);

  const myPool = tradeable(mine);
  const out = [];

  for (const rival of ctx.rosters) {
    if (rival.rosterId === mine.rosterId) continue;
    const theirPool = tradeable(rival);
    const shapes = [];
    for (const a of myPool) for (const b of theirPool) shapes.push([[a.id], [b.id]]);
    for (const a of myPool) for (let i = 0; i < theirPool.length; i += 1) for (let j = i + 1; j < theirPool.length; j += 1) shapes.push([[a.id], [theirPool[i].id, theirPool[j].id]]);
    for (let i = 0; i < myPool.length; i += 1) for (let j = i + 1; j < myPool.length; j += 1) for (const b of theirPool) shapes.push([[myPool[i].id, myPool[j].id], [b.id]]);

    // Stage 2: cheap surplus filter before any lineup work.
    const shortlist = shapes
      .map(([give, get]) => {
        const g = sideValue(ctx, give), n = sideValue(ctx, get);
        return { give, get, myEdge: edgeOf(g.surplus, n.surplus), theirEdge: edgeOf(n.surplus, g.surplus) };
      })
      .filter((c) => c.myEdge >= -6 && c.theirEdge >= -8)
      .sort((a, b) => b.myEdge + b.theirEdge * 0.5 - (a.myEdge + a.theirEdge * 0.5))
      .slice(0, 10);

    const scored = [];
    for (const c of shortlist) {
      let res;
      try { res = evaluateTrade(ctx, { myRosterId: mine.rosterId, theirRosterId: rival.rosterId, give: c.give, get: c.get }); }
      catch { continue; }
      if (res.verdict.code === "invalid") continue;
      if (!res.verdict.acceptLikely) continue;
      if (res.verdict.deltaPerWeek <= 0 && res.verdict.edgePct <= 2) continue;
      scored.push({
        theirRosterId: rival.rosterId,
        give: c.give, get: c.get,
        shape: `${c.give.length}-${c.get.length}`,
        score: res.verdict.deltaPerWeek + 0.05 * res.verdict.edgePct,
        myEdgePct: res.verdict.edgePct,
        myDeltaPerWeek: res.verdict.deltaPerWeek,
        theirEdgePct: res.them.edgePct,
        theirDeltaPerWeek: res.them.lineup.deltaPerWeek,
        why: explain(ctx, res).lines.map((l) => l.text),
        result: res,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const seenGive = new Set();
    for (const s of scored) {
      if (out.filter((o) => o.theirRosterId === rival.rosterId).length >= cap) break;
      const key = s.give.join(",");
      if (seenGive.has(key)) continue;
      seenGive.add(key);
      out.push(s);
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/* ============================================================ explain.js */

export function explain(ctx, result) {
  const v = result.verdict;
  const lines = [];
  const name = (id) => ctx.players.get(id)?.name || id;
  const win = v.edgePct >= 0;
  const headline = `${v.label}: you ${win ? "win" : "lose"} by ${Math.abs(v.edgePct).toFixed(0)}% and ${v.deltaPerWeek >= 0 ? "gain" : "lose"} ${Math.abs(v.deltaPerWeek).toFixed(1)} pts/week.`;

  if (result.best) {
    const mv = marketValue(ctx, result.best.id);
    lines.push({ kind: "best", text: `${name(result.best.id)} (${ctx.players.get(result.best.id)?.pos}${mv.posRank ?? ""}${mv.tier ? `, tier ${mv.tier}` : ""}) is the best player in the deal — ${result.best.side === "me" ? "you" : "they"} get him.` });
  }
  if (result.give.length !== result.get.length) {
    const W = waiverReplacement(ctx);
    const freed = Math.abs(result.give.length - result.get.length);
    const pos = ctx.players.get(result.get[0])?.pos || "RB";
    const fa = W.best[pos];
    lines.push({ kind: "consol", text: `You send ${result.give.length} and get ${result.get.length}; the ${freed} freed spot${freed > 1 ? "s are" : " is"} worth about ${Math.round(W[pos] || 0)} here, where the best free ${pos} is ${fa ? name(fa.id) : "unclaimed"}.` });
  }
  lines.push({ kind: "lineup", text: `Your starters ${v.deltaPerWeek >= 0 ? "gain" : "lose"} ${Math.abs(v.deltaPerWeek).toFixed(1)} pts/week, ${Math.abs(v.deltaPlayoffPerWeek).toFixed(1)} in the weeks 15–17 playoffs.` });

  const rival = ctx.rosters.find((r) => r.rosterId === result.theirRosterId);
  const te = result.them.edgePct;
  lines.push({ kind: "rival", text: `${rival?.teamName || "They"} ${te >= 0 ? "gain" : "lose"} ${Math.abs(te).toFixed(0)}% — likely to ${v.acceptLikely ? "accept" : "decline"}.` });

  for (const f of result.flags) if (f.severity !== "info") lines.push({ kind: "risk", text: f.text });

  return { headline, lines };
}

/* ============================================================ transactions */

export function getTransactions(ctx) {
  const list = (raw?.transactions || []).map((t) => ({
    id: t.transaction_id,
    week: t.leg,
    type: t.type,
    status: t.status,
    created: t.created,
    adds: t.adds || {},
    drops: t.drops || {},
    rosterIds: t.roster_ids || [],
  }));

  // MOCK ONLY: the fixture week-1 transaction log holds no completed trade, so synthesize one
  // from two real rosters to exercise the "completed trades" render path.
  if (ctx && !list.some((t) => t.type === "trade")) {
    const a = ctx.rosters[0], b = ctx.rosters[4] || ctx.rosters[1];
    const val = (r) => r.players
      .map((id) => ({ id, m: marketValue(ctx, id).mAdj, pos: ctx.players.get(id)?.pos }))
      .filter((x) => x.m != null && x.m > 2000 && x.pos !== ctx.players.get(r.players[0])?.pos0);
    let pa = null, pb = null, bestGap = Infinity;
    for (const x of val(a)) for (const y of val(b)) {
      const gap = Math.abs(x.m - y.m);
      if (gap > 0 && gap < bestGap && x.pos !== y.pos) { bestGap = gap; pa = x.id; pb = y.id; }
    }
    if (pa && pb) {
      list.unshift({
        id: "mock-trade-1", week: 1, type: "trade", status: "complete",
        created: Date.now() - 36e5 * 20,
        adds: { [pa]: b.rosterId, [pb]: a.rosterId },
        drops: { [pa]: a.rosterId, [pb]: b.rosterId },
        rosterIds: [a.rosterId, b.rosterId],
      });
    }
  }
  return list.sort((x, y) => y.created - x.created);
}

/* ============================================================ user lookup */

export async function lookupUser(username) {
  await sleep(200);
  const u = (raw?.users || []).find((x) => x.display_name.toLowerCase() === String(username).toLowerCase());
  if (!u) throw new Error(`No Sleeper user named "${username}".`);
  return { user_id: u.user_id, username: u.display_name, display_name: u.display_name, avatar: u.avatar };
}

export async function listLeagues(userId, season) {
  await sleep(200);
  const l = raw?.league;
  return l ? [{ league_id: l.league_id, name: l.name, season: season || l.season, total_rosters: l.total_rosters, avatar: l.avatar, status: l.status }] : [];
}

/* ============================================================ export surface */

export const api = {
  loadSettings, saveSettings, loadAll, refreshLive, getTransactions, lookupUser, listLeagues, clearCache,
  marketValue, waiverReplacement, sideValue, surplus,
  bestLineup, seasonLineup, backfill,
  evaluateTrade, findTrades, explain,
};
