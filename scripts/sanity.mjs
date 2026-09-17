#!/usr/bin/env node
// scripts/sanity.mjs — eyeball check on the engine against the real committed data.
//
//   node scripts/sanity.mjs [leagueId]
//
// Reads the pipeline output in data/*.json and pulls league/users/rosters/state live from
// api.sleeper.app (cache-busted) for the league id given on the command line — Boyball by default.
// Anything unreachable falls back to the 2026-09-09 snapshots in test/fixtures/, so the script
// always prints — offline runs are just a little staler. Any other league id runs in viewer mode
// (no roster is "mine"), which is exactly what the app does for a league you only browse.
// Not a test: it prints, it never asserts. `node --test "test/*.test.mjs"` is the gate.

import { readFileSync } from "node:fs";

import { POSITIONS, SAMPLE_LEAGUE, SLEEPER, TRADEABLE } from "../src/config.js";
import {
  activePlayers,
  buildContext,
  irEligibleStatus,
  playerOf,
  rosPoints,
  rosterById,
  tradeablePlayers,
} from "../src/engine/context.js";
import { curveFit, marketValue, surplus, tableFor, waiverReplacement } from "../src/engine/values.js";
import { seasonLineup, weekVector } from "../src/engine/lineup.js";
import { evaluateTrade, rosterLanding } from "../src/engine/trade.js";
import { sideNames } from "../src/engine/explain.js";
import { findLeagueTrades, findTrades, tradePool } from "../src/engine/finder.js";
import { findFreeAgents, freeAgentPool, gradeTransaction } from "../src/engine/waiver.js";
import { applyStatuses } from "../src/engine/advisor.js";
import { IR_STATUSES } from "../src/engine/injuries.js";
// The alerts job is the reference implementation for "build a ctx from live Sleeper" (§13.4 C5);
// importing its parsers keeps this audit honest rather than re-deriving the same shapes.
import { projectionsUrl, statusRowsFromProjections } from "../pipeline/alerts.mjs";

const LEAGUE_ID = process.argv[2] || SAMPLE_LEAGUE.leagueId;
const USER_ID = LEAGUE_ID === SAMPLE_LEAGUE.leagueId ? SAMPLE_LEAGUE.userId : null;
const FETCH_TIMEOUT_MS = 8000;

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const pipeline = (name) => readJson(`../data/${name}`);
const snapshot = (name) => readJson(`../test/fixtures/${name}`);
/** An optional pipeline file — `data/history.json` only exists once WS-F has run (§13.6 F1). */
const optional = (name) => {
  try {
    return pipeline(name);
  } catch {
    return null;
  }
};

/**
 * Fetch one cache-busted Sleeper endpoint, falling back to a committed snapshot.
 * @param {string} path e.g. "/v1/league/123"
 * @param {string} fallbackFixture file under test/fixtures/
 * @param {string[]} notes collects a human-readable source note per payload
 * @returns {Promise<any>}
 */
async function live(path, fallbackFixture, notes) {
  const url = `${SLEEPER.base}${path}${path.includes("?") ? "&" : "?"}cb=${Date.now()}`;
  const label = fallbackFixture || path;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body || (Array.isArray(body) && !body.length)) throw new Error("empty body");
    notes.push(`${label} live`);
    return body;
  } catch (error) {
    notes.push(`${label} ${fallbackFixture ? "fixture" : "skipped"} (${error.message})`);
    // a week with no transactions is an empty list, not a failure — no snapshot needed
    return fallbackFixture ? snapshot(fallbackFixture) : [];
  }
}

/** data.js `normalizeTransaction` (design.md §5) — the shape the engine reads. */
const normalizeTxn = (raw, round) => ({
  id: String(raw?.transaction_id ?? ""),
  week: Number(raw?.leg ?? round) || round,
  type: raw?.type ?? "unknown",
  status: raw?.status ?? "unknown",
  created: Number(raw?.created ?? raw?.status_updated ?? 0),
  adds: raw?.adds ?? {},
  drops: raw?.drops ?? {},
  rosterIds: Array.isArray(raw?.roster_ids) ? raw.roster_ids : [],
  draftPicks: Array.isArray(raw?.draft_picks) ? raw.draft_picks : [],
});

const notes = [];
const [league, users, rosters, state] = await Promise.all([
  live(`/v1/league/${LEAGUE_ID}`, "league.json", notes),
  live(`/v1/league/${LEAGUE_ID}/users`, "users.json", notes),
  live(`/v1/league/${LEAGUE_ID}/rosters`, "rosters.json", notes),
  live("/v1/state/nfl", "state.json", notes),
]);

// §11.2 inputs: every scoring period so far (a drop's `created` is what starts the waiver clock)
// plus the 24 h trending adds. Scripts may read the clock; the engine may not, so it is injected.
const stateWeek = Math.max(1, Number(state?.week) || 1);
const rounds = Array.from({ length: stateWeek }, (_, i) => i + 1);
const [transactionRounds, trending] = await Promise.all([
  Promise.all(
    rounds.map((round) =>
      live(
        `/v1/league/${LEAGUE_ID}/transactions/${round}`,
        round === 1 ? "transactions_1.json" : null,
        notes
      ).then((rows) => (Array.isArray(rows) ? rows : []).map((row) => normalizeTxn(row, round)))
    )
  ),
  live(
    `/v1/players/nfl/trending/add?lookback_hours=${SLEEPER.trendingLookbackHours}&limit=50`,
    "trending_add.json",
    notes
  ),
]);
const transactions = transactionRounds.flat().sort((a, b) => b.created - a.created);

// §13.4 C5 freshness: `data/players.json` carries the statuses of its last pipeline run, and an
// audit of IR handling that reads yesterday's injury list is worthless. One position-filtered call
// to the projections endpoint reprices every status, exactly as `pipeline/alerts.mjs` does.
const history = optional("history.json");
const liveStatusRows = await (async () => {
  const season = String(league?.season || state?.season || SAMPLE_LEAGUE.season);
  const week = Math.max(1, Number(state?.week) || 1);
  const url = `${projectionsUrl(season, week)}&cb=${Date.now()}`;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { statuses } = statusRowsFromProjections(await response.json());
    notes.push(`statuses live (${statuses.length} rows)`);
    return statuses;
  } catch (error) {
    notes.push(`statuses from data/players.json (${error.message})`);
    return [];
  }
})();
notes.push(history ? "history.json loaded" : "history.json absent (WS-F pending)");

const rawCtx = buildContext(
  {
    league,
    users,
    rosters,
    state,
    transactions,
    trending,
    history,
    now: Date.now(),
    players: pipeline("players.json"),
    projections: pipeline("projections.json"),
    values: pipeline("values.json"),
    schedule: pipeline("schedule.json"),
  },
  { leagueId: LEAGUE_ID, userId: USER_ID }
);
const ctx = applyStatuses(rawCtx, liveStatusRows);

const nm = (id) => (ctx.players.get(id) || { name: id }).name;
const team = (rosterId) => {
  const r = ctx.rosters.find((x) => x.rosterId === rosterId);
  return r ? r.displayName : `roster ${rosterId}`;
};
const out = (line = "") => process.stdout.write(`${line}\n`);
const byName = (name) => (ctx.rosters.find((r) => r.displayName === name) || {}).rosterId;

const sideA = ctx.myRosterId != null ? ctx.myRosterId : ctx.rosters[0].rosterId;
const fit = curveFit(ctx);
const W = waiverReplacement(ctx);

out(
  `ctx: ${ctx.league.name} — week ${ctx.week} of ${ctx.lastWeek}, weeksLeft ${ctx.weeksLeft.length}, ` +
    `playoffs ${ctx.playoffWeeks.length ? `${ctx.playoffWeeks[0]}-${ctx.playoffWeeks[ctx.playoffWeeks.length - 1]}` : "none"}`
);
out(
  `     ${ctx.league.numTeams} teams · ${ctx.league.numQbs}QB · PPR ${ctx.league.ppr} · maxRoster ${ctx.league.maxRoster} · ` +
    `deadline wk ${ctx.league.tradeDeadlineWeek || "none"} · veto ${ctx.league.vetoVotesNeeded || "commissioner"} · ` +
    `myRosterId ${ctx.myRosterId === null ? "null (viewer mode)" : `${ctx.myRosterId} (${team(ctx.myRosterId)})`}`
);
out(`     slots ${ctx.slots.join(" ")}${ctx.unsupported.length ? ` · unsupported: ${ctx.unsupported.join(", ")}` : ""}`);
out(
  `     tables ${["fc_redraft", "fc_dynasty", "dp_dynasty", "bc_tiers"]
    .map((role) => `${role}→${tableFor(ctx, role) || "—"}`)
    .join(" · ")}`
);
out(`sources: ${notes.join(" · ")}`);
out(`curveFit: A=${fit.A.toFixed(1)} k=${fit.k.toFixed(4)} (n=${fit.n})`);
out(
  `W[pos]: ${["QB", "RB", "WR", "TE"]
    .map((pos) => `${pos} ${W[pos].toFixed(0)}${W.best[pos] ? ` (${nm(W.best[pos].id)})` : ""}`)
    .join(" · ")} · FLEX ${W.FLEX.toFixed(0)}`
);
const base = seasonLineup(ctx, ctx.rosters.find((r) => r.rosterId === sideA).players);
out(`${team(sideA)} baseline lineup: ${base.avgPerWeek.toFixed(1)} pts/wk weighted, ${base.playoffAvg.toFixed(1)} in the playoffs`);

// §11.2 — the wire. Roster 3 is Tom's team in the sample league; any other league falls back to
// side A, so the section prints whatever league you point the script at.
const faRosterId = ctx.rosters.some((r) => r.rosterId === 3) ? 3 : sideA;
out(
  `\n=== findFreeAgents for ${team(faRosterId)} (top 8) === pool ${freeAgentPool(ctx).length} FAs · ` +
    `${transactions.length} txns wk 1-${stateWeek} · ${trending.length} trending · ` +
    `waiver ${ctx.league.waiverType === 2 ? `FAAB ${ctx.league.waiverBudget}` : `type ${ctx.league.waiverType}`}, ` +
    `clears in ${ctx.league.waiverClearDays} d`
);
const faStarted = process.hrtime.bigint();
const fas = findFreeAgents(ctx, { rosterId: faRosterId, maxResults: 8 });
out(`${fas.length} adds worth making in ${(Number(process.hrtime.bigint() - faStarted) / 1e6).toFixed(0)} ms\n`);
fas.forEach((fa, i) => {
  const bid = fa.suggestedBid ? `bid ${fa.suggestedBid.value}-${fa.suggestedBid.aggressive} of ${fa.suggestedBid.remaining}` : "no bid";
  const clears = fa.clearsAt ? ` until ${fa.clearsAt}` : "";
  out(
    `${i + 1}. ADD ${nm(fa.add)} (${fa.pos}) — DROP ${fa.drop ? nm(fa.drop) : "nobody (open spot)"} · ` +
      `+${fa.gainPerWeek.toFixed(2)} pts/wk (playoffs ${fa.playoffGainPerWeek >= 0 ? "+" : ""}${fa.playoffGainPerWeek.toFixed(2)}) · ` +
      `value ${fa.valueDelta >= 0 ? "+" : ""}${fa.valueDelta.toFixed(0)} · score ${fa.score.toFixed(2)}`
  );
  out(`   ${fa.status}${clears} · ${bid}${fa.trend != null ? ` · trending ${fa.trend}` : ""}`);
  fa.why.forEach((line) => out(`   · ${line}`));
});

out("\n=== gradeTransaction (most recent moves) ===");
const graded = transactions.slice(0, 6).map((txn) => [txn, gradeTransaction(ctx, txn)]);
const gradedTrades = graded.filter(([txn]) => txn.type === "trade");
for (const [txn, g] of gradedTrades.length ? gradedTrades.slice(0, 2) : graded.slice(0, 3)) {
  if (!g) continue;
  if (g.type === "trade") {
    out(`wk${g.week} trade: ${team(g.a)} gets ${g.get.map(nm).join(" + ")} ⇄ ${team(g.b)} gets ${g.give.map(nm).join(" + ")}`);
    out(`   ${team(g.a)}: ${g.labelA} (Edge ${g.edgeA.toFixed(1)}%, ΔL_pw ${g.deltaA.toFixed(2)})`);
    out(`   ${team(g.b)}: ${g.labelB} (Edge ${g.edgeB.toFixed(1)}%, ΔL_pw ${g.deltaB.toFixed(2)})`);
  } else {
    out(`wk${g.week} ${g.type}: ${g.why[0] || `${team(g.rosterId)} moved somebody`} (ΔL_pw ${g.gainPerWeek.toFixed(2)})`);
  }
}

out("\n=== findTrades (top 5) ===");
const started = process.hrtime.bigint();
const deals = findTrades(ctx, { myRosterId: sideA, maxResults: 10, perRival: 2 });
const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
out(`${deals.length} results in ${elapsed.toFixed(0)} ms\n`);
deals.slice(0, 5).forEach((d, i) => {
  out(`${i + 1}. [${d.shape}] with ${team(d.theirRosterId)} — score ${d.score.toFixed(2)} · ${d.acceptance}`);
  out(`   GIVE ${d.give.map(nm).join(" + ")}  →  GET ${d.get.map(nm).join(" + ")}`);
  out(
    `   me: Edge ${d.myEdgePct.toFixed(1)}%  ΔL_pw ${d.myDeltaPerWeek.toFixed(2)}   ` +
      `them: Edge ${d.theirEdgePct.toFixed(1)}%  ΔL_pw ${d.theirDeltaPerWeek.toFixed(2)}`
  );
  d.why.forEach((line) => out(`   · ${line}`));
  out("");
});

out("=== evaluateTrade sample ===");
const sample = deals[0];
if (sample) {
  const r = evaluateTrade(ctx, {
    myRosterId: sideA,
    theirRosterId: sample.theirRosterId,
    give: sample.give,
    get: sample.get,
  });
  out(`${sample.give.map(nm).join(" + ")}  ⇄  ${sample.get.map(nm).join(" + ")} (vs ${team(sample.theirRosterId)})`);
  out(`verdict: ${r.verdict.code} — ${r.verdict.label}`);
  out(
    `Edge ${r.verdict.edgePct.toFixed(1)}%  ΔL_pw ${r.verdict.deltaPerWeek.toFixed(2)}  ` +
      `ΔL_po ${r.verdict.deltaPlayoffPerWeek.toFixed(2)}  override ${r.verdict.override}  ` +
      `veto ${r.verdict.veto}  acceptance ${r.verdict.acceptance}`
  );
  out(
    `value  give raw ${r.me.valueGive.raw.toFixed(0)} / surplus ${r.me.valueGive.surplus.toFixed(0)}   ` +
      `get raw ${r.me.valueGet.raw.toFixed(0)} / surplus ${r.me.valueGet.surplus.toFixed(0)}`
  );
  out(
    `roster ${r.me.rosterCount.before} → ${r.me.rosterCount.after} of ${r.me.rosterCount.max}   ` +
      `backfill [${r.me.backfill.map(nm).join(", ")}]   drop ${r.me.dropSuggestion ? nm(r.me.dropSuggestion) : "—"}`
  );
  out(
    `them   roster ${r.them.rosterCount.before} → ${r.them.rosterCount.after}   ` +
      `backfill [${r.them.backfill.map(nm).join(", ")}]   drop ${r.them.dropSuggestion ? nm(r.them.dropSuggestion) : "—"}`
  );
  r.reasons.forEach((l) => out(`  [${l.kind}] ${l.text}`));
  r.flags.forEach((f) => out(`  FLAG ${f.severity}/${f.type}: ${f.text}`));
} else {
  out("no proposals survived the acceptance gate — nothing to sample");
}

// A trade between two teams that are NOT me: every line must read in the third person.
out("\n=== third-party verdict (nobody is 'you') ===");
const others = ctx.rosters.filter((r) => r.rosterId !== ctx.myRosterId).map((r) => r.rosterId);
const thirdA = byName("hobbezilla") ?? others[0];
const thirdB = byName("speckledorf") ?? others.find((id) => id !== thirdA);
if (thirdA != null && thirdB != null) {
  const give = tradePool(ctx, thirdA).slice(0, 2);
  const get = tradePool(ctx, thirdB).slice(0, 1);
  const names = sideNames(ctx, thirdA, thirdB);
  const third = evaluateTrade(ctx, { myRosterId: thirdA, theirRosterId: thirdB, give, get }, { names });
  out(`${team(thirdA)} sends ${give.map(nm).join(" + ")}  ⇄  ${team(thirdB)} sends ${get.map(nm).join(" + ")}`);
  out(`names: ${JSON.stringify(names)}`);
  out(`verdict: ${third.verdict.code} — ${third.verdict.label}`);
  third.reasons.forEach((l) => out(`  [${l.kind}] ${l.text}`));
} else {
  out("not enough teams for a third-party sample");
}

out("\n=== findLeagueTrades (whole league, top 5) ===");
const swept = process.hrtime.bigint();
const leagueDeals = findLeagueTrades(ctx, {
  perTeam: 3,
  maxResults: 20,
  // the UI shows this as "3 of 8 teams…"; here it only clutters a piped log
  onTeam: (rosterId, index, total) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  sweeping ${index + 1} of ${total} (${team(rosterId)})…      `);
  },
});
const sweepMs = Number(process.hrtime.bigint() - swept) / 1e6;
if (process.stdout.isTTY) process.stdout.write("\r                                             \r");
out(`${leagueDeals.length} deals across the league in ${sweepMs.toFixed(0)} ms\n`);
leagueDeals.slice(0, 5).forEach((d, i) => {
  out(`${i + 1}. for ${team(d.forRosterId)} with ${team(d.theirRosterId)} — [${d.shape}] score ${d.score.toFixed(2)} · ${d.acceptance}`);
  out(`   GIVE ${d.give.map(nm).join(" + ")}  →  GET ${d.get.map(nm).join(" + ")}`);
  out(`   ${d.why[0]}`);
  const rival = d.result.reasons.find((line) => line.kind === "rival");
  if (rival) out(`   ${rival.text}`);
});

// --- §13.4 C5 · analyzer audit on live data ----------------------------------------------------
// Everything below is an AUDIT: it prints what the engine believes and names anything that looks
// wrong, so a number nobody can defend cannot ship quietly. Anomalies are collected as they are
// found and printed together at the end.

/** @type {string[]} */
const anomalies = [];
const flag = (line) => anomalies.push(line);
const finite = (n) => Number.isFinite(Number(n));
const pct = (a, b) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : "n/a");
/** IR-class in the Sleeper sense: on a reserve list, or eligible for one in this league. */
const isStashable = (id) => {
  const inj = playerOf(ctx, id).inj;
  return !!inj && (IR_STATUSES.includes(inj) || irEligibleStatus(ctx, inj));
};
const parkedIds = new Set();
for (const r of ctx.rosters) for (const id of r.reserve || []) parkedIds.add(id);

out("\n=== replacement levels W[pos] (R3 §b) — priced off THIS league's wire ===");
const faPool = freeAgentPool(ctx);
const faCount = {};
for (const id of faPool) {
  const pos = playerOf(ctx, id).pos;
  if (pos) faCount[pos] = (faCount[pos] || 0) + 1;
}
for (const pos of TRADEABLE) {
  const best = W.best[pos];
  const line =
    `  ${pos.padEnd(4)} W ${String(Math.round(W[pos])).padStart(5)}` +
    `  best free agent: ${best ? `${nm(best.id)} (${Math.round(best.m)})` : "none"}` +
    `  · ${faCount[pos] || 0} free`;
  out(line);
  if (!finite(W[pos])) flag(`W[${pos}] is not a finite number (${W[pos]}) — values.js waiverReplacement`);
  if (!W[pos]) flag(`W[${pos}] is 0 — every ${pos} on the wire is unpriced, so surplus is raw value`);
}
out(`  FLEX W ${Math.round(W.FLEX)} (= max of RB/WR/TE) · pool ${faPool.length} players`);
for (const pos of ["K", "DEF"]) {
  if (W[pos] != null) flag(`W has a ${pos} entry — K/DEF must never be valued (R3 §f stage 0)`);
}

out("\n=== top-10 market values vs FantasyCalc raw ===");
out("  #  player                    pos  m      mAdj   fc_redraft  Δ vs raw  inj      cover  src");
const priced = [];
for (const [id, p] of ctx.players) {
  if (!p || !TRADEABLE.includes(p.pos)) continue;
  const mv = marketValue(ctx, id);
  if (mv.m == null) continue;
  priced.push([id, mv]);
}
priced.sort((a, b) => b[1].m - a[1].m || (a[0] < b[0] ? -1 : 1));
for (const [i, [id, mv]] of priced.slice(0, 10).entries()) {
  const raw = mv.sourcesRaw && mv.sourcesRaw.fc_redraft != null ? mv.sourcesRaw.fc_redraft : null;
  out(
    `  ${String(i + 1).padStart(2)}  ${nm(id).padEnd(24).slice(0, 24)}  ${String(playerOf(ctx, id).pos).padEnd(3)}  ` +
      `${String(Math.round(mv.m)).padStart(6)} ${String(Math.round(mv.mAdj)).padStart(6)}  ` +
      `${raw == null ? "     —    " : String(Math.round(raw)).padStart(10)}  ${
        raw == null ? "   n/a  " : pct(mv.m, raw).padStart(8)
      }  ${String(mv.inj || "—").padEnd(7)}  ${mv.coverage}/${Object.keys(mv.sources).length}  ${
        mv.fallback || "blend"
      }`
  );
}
out("  blend: m = (1−keeperTilt)·redraft + keeperTilt·dynasty, redraft = weights over the present sources");
for (const [id, mv] of priced.slice(0, 3)) {
  out(
    `    ${nm(id).padEnd(22).slice(0, 22)} redraft ${Math.round(mv.redraft)} · dynasty ${
      mv.dynasty == null ? "—" : Math.round(mv.dynasty)
    } · projV ${mv.projV == null ? "—" : Math.round(mv.projV)} → m ${Math.round(mv.m)}` +
      ` (rank ${mv.rank}, ${playerOf(ctx, id).pos}${mv.posRank})`
  );
}
{
  const missing = priced.slice(0, 10).filter(([, mv]) => mv.sourcesRaw.fc_redraft == null);
  if (missing.length) {
    flag(`${missing.length} of the top 10 have no fc_redraft price — the blend is running on the curve`);
  }
  const drifted = priced
    .slice(0, 10)
    .filter(([, mv]) => mv.sourcesRaw.fc_redraft != null && Math.abs(mv.m - mv.sourcesRaw.fc_redraft) / mv.sourcesRaw.fc_redraft > 0.5);
  for (const [id, mv] of drifted) {
    flag(`${nm(id)}: m ${Math.round(mv.m)} is ${pct(mv.m, mv.sourcesRaw.fc_redraft)} off fc_redraft ${Math.round(mv.sourcesRaw.fc_redraft)}`);
  }
}

out("\n=== IR / reserve players in this league (the §13.0 row-4 case) ===");
const stashes = [];
for (const r of ctx.rosters) {
  for (const id of tradeablePlayers(r)) {
    if (!parkedIds.has(id) && !isStashable(id)) continue;
    const mv = marketValue(ctx, id);
    if (mv.m == null) continue;
    stashes.push({ id, rosterId: r.rosterId, parked: parkedIds.has(id), mv });
  }
}
stashes.sort((a, b) => (b.mv.mAdj || 0) - (a.mv.mAdj || 0));
if (!stashes.length) out("  nobody in the league is hurt enough to matter today");
for (const s of stashes.slice(0, 12)) {
  const ros = rosPoints(ctx, s.id);
  const vec = weekVector(ctx, s.id);
  let rest = 0;
  for (const w of ctx.weeksLeft) rest += vec[w];
  const p = playerOf(ctx, s.id);
  out(
    `  ${nm(s.id).padEnd(22).slice(0, 22)} ${String(p.pos).padEnd(3)} ${String(p.inj).padEnd(4)} ` +
      `${team(s.rosterId).padEnd(14).slice(0, 14)} ${s.parked ? "on IR " : "active"} ` +
      `m ${String(Math.round(s.mv.m)).padStart(5)} → mAdj ${String(Math.round(s.mv.mAdj)).padStart(5)} ` +
      `(−${Math.round((s.mv.discount || 0) * 100)}%) · ROS proj ${ros.toFixed(0)} · lineup-visible ${rest.toFixed(0)}` +
      `${irEligibleStatus(ctx, p.inj) ? " · IR-eligible" : " · NOT IR-eligible here"}`
  );
  // The known gap until §13.5 D1 lands: the lineup axis zeroes the CURRENT week only, so a man
  // who is out for two months still projects full points from next week on.
  if (rest > 0.9 * ros && ros > 0 && IR_STATUSES.includes(p.inj)) {
    flag(
      `${nm(s.id)} (${p.inj}) still projects ${rest.toFixed(0)} of ${ros.toFixed(0)} remaining pts at full value ` +
        `— availability scaling is WS-D's lineup.js/injuries.js (§13.5 D1)`
    );
  }
  // R3 §d puts the injury discount on the market axis because "market values lag". When the
  // market has ALREADY crashed him, δ lands on top of a price that priced the same news.
  const raw = s.mv.sourcesRaw && s.mv.sourcesRaw.fc_redraft;
  if (s.mv.trend != null && s.mv.trend <= -1000 && (s.mv.discount || 0) > 0) {
    flag(
      `${nm(s.id)}: FantasyCalc has already repriced him (${Math.round(s.mv.trend)} over 30 days, now ` +
        `${raw == null ? "—" : Math.round(raw)}) and the engine takes another ${Math.round(s.mv.discount * 100)}% ` +
        `— possible double count of one injury (values.js injuryDiscount, R3 §d)`
    );
  }
}

out("\n=== three canonical trades ===");
/** The n best assets on a roster by injury-adjusted market value. */
const bestOf = (rosterId, n, filter = () => true) =>
  tradePool(ctx, rosterId)
    .filter(filter)
    .slice(0, n);
/** The cheapest tradeable bodies on a roster — the "benchers" of the star-for-two case. */
const benchOf = (rosterId, n) => {
  const pool = tradePool(ctx, rosterId);
  return pool.slice(Math.max(0, pool.length - n));
};
const posOf = (id) => playerOf(ctx, id).pos;
const rival = ctx.rosters.find((r) => r.rosterId !== sideA).rosterId;

/** Print one graded trade in full. */
const grade = (title, theirRosterId, give, get) => {
  out(`\n— ${title}`);
  if (!give.length || !get.length || theirRosterId == null) {
    out("  (no such pair exists in this league today)");
    return null;
  }
  const r = evaluateTrade(ctx, { myRosterId: sideA, theirRosterId, give, get });
  out(
    `  ${team(sideA)} sends ${give.map(nm).join(" + ")}  ⇄  ${team(theirRosterId)} sends ${get.map(nm).join(" + ")}`
  );
  out(`  verdict: ${r.verdict.code} — ${r.verdict.label}`);
  out(
    `  Edge ${r.verdict.edgePct.toFixed(1)}%  ΔL_pw ${r.verdict.deltaPerWeek.toFixed(2)}  ` +
      `ΔL_po ${r.verdict.deltaPlayoffPerWeek.toFixed(2)}  acceptance ${r.verdict.acceptance}  ` +
      `override ${r.verdict.override || "none"}`
  );
  out(
    `  value: give raw ${r.me.valueGive.raw.toFixed(0)} / surplus ${r.me.valueGive.surplus.toFixed(0)}  ·  ` +
      `get raw ${r.me.valueGet.raw.toFixed(0)} / surplus ${r.me.valueGet.surplus.toFixed(0)}`
  );
  const c = r.me.rosterCount;
  const t = r.them.rosterCount;
  out(
    `  roster: me ${c.before}→${c.after} of ${c.max}, IR ${c.irBefore}→${c.irAfter} of ${c.irMax}  ·  ` +
      `them ${t.before}→${t.after} of ${t.max}, IR ${t.irBefore}→${t.irAfter} of ${t.irMax}`
  );
  if (r.me.backfill.length) out(`  backfill: ${r.me.backfill.map(nm).join(", ")}`);
  if (r.me.dropSuggestion) out(`  drop: ${nm(r.me.dropSuggestion)}`);
  r.reasons.forEach((l) => out(`    [${l.kind}] ${l.text}`));
  r.flags.filter((f) => f.type === "ir_slot").forEach((f) => out(`    FLAG ${f.severity}/${f.type}: ${f.text}`));

  for (const [label, n] of [
    ["edgePct", r.verdict.edgePct],
    ["deltaPerWeek", r.verdict.deltaPerWeek],
    ["deltaPlayoffPerWeek", r.verdict.deltaPlayoffPerWeek],
    ["me.valueGet.surplus", r.me.valueGet.surplus],
    ["them.edgePct", r.them.edgePct],
  ]) {
    if (!finite(n)) flag(`${title}: ${label} is ${n}`);
  }
  if (c.after > c.max && r.verdict.code !== "needs_drop") {
    flag(`${title}: ${c.after} of ${c.max} on my roster but the verdict is ${r.verdict.code}`);
  }
  if (c.irAfter > c.irMax || t.irAfter > t.irMax) flag(`${title}: IR slots oversubscribed`);
  return r;
};

// 1 — star for two benchers: the classic "they consolidate, I get depth" shape
const star = bestOf(rival, 1)[0] || null;
grade("star for two benchers (2-for-1 against me)", rival, benchOf(sideA, 2), star ? [star] : []);

// 2 — IR star for a healthy WR2: the case Tom reported as broken
const irTarget = stashes.find((s) => s.rosterId !== sideA && (s.parked || isStashable(s.id))) || null;
const myWrs = bestOf(sideA, 99, (id) => posOf(id) === "WR");
const myWr2 = myWrs[1] || myWrs[0] || null;
grade(
  `IR star for a healthy WR2${irTarget ? ` (${nm(irTarget.id)} is ${playerOf(ctx, irTarget.id).inj})` : ""}`,
  irTarget ? irTarget.rosterId : null,
  myWr2 ? [myWr2] : [],
  irTarget ? [irTarget.id] : []
);

// 3 — 2-for-1 consolidation: I send two, I get their best
const mine2 = bestOf(sideA, 3).slice(1, 3);
grade("2-for-1 consolidation (I send two, I get their best)", rival, mine2, star ? [star] : []);

out("\n=== anomalies ===");
// league-wide sweeps that do not belong to any one trade
let negativeSurplus = 0;
let nanValues = 0;
let valuedKickers = 0;
for (const [id, p] of ctx.players) {
  if (!p) continue;
  const mv = marketValue(ctx, id);
  if (["K", "DEF"].includes(p.pos)) {
    if (mv.m != null) {
      valuedKickers += 1;
      if (valuedKickers <= 3) flag(`${nm(id)} (${p.pos}) carries a market value of ${Math.round(mv.m)}`);
    }
    continue;
  }
  if (mv.m != null && (!finite(mv.m) || !finite(mv.mAdj))) {
    nanValues += 1;
    if (nanValues <= 3) flag(`${nm(id)}: m=${mv.m} mAdj=${mv.mAdj}`);
  }
  const s = surplus(ctx, id);
  if (s < 0 || !finite(s)) {
    negativeSurplus += 1;
    if (negativeSurplus <= 3) flag(`${nm(id)}: surplus ${s}`);
  }
}
if (valuedKickers > 3) flag(`…and ${valuedKickers - 3} more valued K/DEF`);
for (const r of ctx.rosters) {
  const spots = activePlayers(r).length;
  if (spots > ctx.league.maxRoster) flag(`${team(r.rosterId)} holds ${spots} of ${ctx.league.maxRoster} roster spots`);
  if ((r.reserve || []).length > ctx.league.irSlots) {
    flag(`${team(r.rosterId)} has ${r.reserve.length} on IR but the league allows ${ctx.league.irSlots}`);
  }
  for (const id of r.reserve || []) {
    if (!irEligibleStatus(ctx, playerOf(ctx, id).inj)) {
      flag(
        `${team(r.rosterId)} has ${nm(id)} (${playerOf(ctx, id).inj || "healthy"}) parked on IR, which this ` +
          `league does not allow — Sleeper will block their next move`
      );
    }
  }
  // the landing arithmetic must agree with itself for a no-op trade
  const noop = rosterLanding(ctx, r.rosterId, [], []);
  if (noop.before !== activePlayers(r).length || noop.irBefore !== (r.reserve || []).length) {
    flag(`rosterLanding disagrees with the roster for ${team(r.rosterId)}`);
  }
}
if (!anomalies.length) out("  none — every number above is defensible");
for (const line of anomalies) out(`  ! ${line}`);
out(
  `\nsummary: ${priced.length} priced players · ${stashes.length} hurt-enough-to-stash · ` +
    `${anomalies.length} anomaly(ies) · history ${history ? "loaded" : "absent"}`
);
