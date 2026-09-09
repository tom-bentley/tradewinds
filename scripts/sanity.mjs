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

import { SAMPLE_LEAGUE, SLEEPER } from "../src/config.js";
import { buildContext } from "../src/engine/context.js";
import { curveFit, tableFor, waiverReplacement } from "../src/engine/values.js";
import { seasonLineup } from "../src/engine/lineup.js";
import { evaluateTrade } from "../src/engine/trade.js";
import { sideNames } from "../src/engine/explain.js";
import { findLeagueTrades, findTrades, tradePool } from "../src/engine/finder.js";

const LEAGUE_ID = process.argv[2] || SAMPLE_LEAGUE.leagueId;
const USER_ID = LEAGUE_ID === SAMPLE_LEAGUE.leagueId ? SAMPLE_LEAGUE.userId : null;
const FETCH_TIMEOUT_MS = 8000;

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const pipeline = (name) => readJson(`../data/${name}`);
const snapshot = (name) => readJson(`../test/fixtures/${name}`);

/**
 * Fetch one cache-busted Sleeper endpoint, falling back to a committed snapshot.
 * @param {string} path e.g. "/v1/league/123"
 * @param {string} fallbackFixture file under test/fixtures/
 * @param {string[]} notes collects a human-readable source note per payload
 * @returns {Promise<any>}
 */
async function live(path, fallbackFixture, notes) {
  const url = `${SLEEPER.base}${path}${path.includes("?") ? "&" : "?"}cb=${Date.now()}`;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body || (Array.isArray(body) && !body.length)) throw new Error("empty body");
    notes.push(`${fallbackFixture} live`);
    return body;
  } catch (error) {
    notes.push(`${fallbackFixture} fixture (${error.message})`);
    return snapshot(fallbackFixture);
  }
}

const notes = [];
const [league, users, rosters, state] = await Promise.all([
  live(`/v1/league/${LEAGUE_ID}`, "league.json", notes),
  live(`/v1/league/${LEAGUE_ID}/users`, "users.json", notes),
  live(`/v1/league/${LEAGUE_ID}/rosters`, "rosters.json", notes),
  live("/v1/state/nfl", "state.json", notes),
]);

const ctx = buildContext(
  {
    league,
    users,
    rosters,
    state,
    players: pipeline("players.json"),
    projections: pipeline("projections.json"),
    values: pipeline("values.json"),
    schedule: pipeline("schedule.json"),
  },
  { leagueId: LEAGUE_ID, userId: USER_ID }
);

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
