#!/usr/bin/env node
// scripts/sanity.mjs — eyeball check on the engine against the real committed data.
//
//   node scripts/sanity.mjs
//
// Reads the pipeline output in data/*.json and pulls league/users/rosters/state live from
// api.sleeper.app (cache-busted). Anything unreachable falls back to the 2026-09-09 snapshots in
// test/fixtures/, so the script always prints — offline runs are just a little staler.
// Not a test: it prints, it never asserts. `node --test "test/*.test.mjs"` is the gate.

import { readFileSync } from "node:fs";

import { DEFAULTS, SLEEPER } from "../src/config.js";
import { buildContext } from "../src/engine/context.js";
import { curveFit, waiverReplacement } from "../src/engine/values.js";
import { seasonLineup } from "../src/engine/lineup.js";
import { evaluateTrade } from "../src/engine/trade.js";
import { findTrades } from "../src/engine/finder.js";

const LEAGUE_ID = process.env.TRADEWINDS_LEAGUE_ID || DEFAULTS.leagueId;
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
  {}
);

const nm = (id) => (ctx.players.get(id) || { name: id }).name;
const team = (rosterId) => (ctx.rosters.find((r) => r.rosterId === rosterId) || {}).teamName;
const out = (line = "") => process.stdout.write(`${line}\n`);

const fit = curveFit(ctx);
const W = waiverReplacement(ctx);
out(
  `ctx: week ${ctx.week}, weeksLeft ${ctx.weeksLeft.length}, myRosterId ${ctx.myRosterId} (${team(ctx.myRosterId)}), ` +
    `maxRoster ${ctx.league.maxRoster}, deadline wk ${ctx.league.tradeDeadlineWeek}`
);
out(`sources: ${notes.join(" · ")}`);
out(`curveFit: A=${fit.A.toFixed(1)} k=${fit.k.toFixed(4)} (n=${fit.n})`);
out(
  `W[pos]: QB ${W.QB.toFixed(0)} (${nm(W.best.QB.id)}) · RB ${W.RB.toFixed(0)} (${nm(W.best.RB.id)}) · ` +
    `WR ${W.WR.toFixed(0)} (${nm(W.best.WR.id)}) · TE ${W.TE.toFixed(0)} (${nm(W.best.TE.id)}) · FLEX ${W.FLEX.toFixed(0)}`
);
const base = seasonLineup(ctx, ctx.rosters.find((r) => r.rosterId === ctx.myRosterId).players);
out(`my baseline lineup: ${base.avgPerWeek.toFixed(1)} pts/wk weighted, ${base.playoffAvg.toFixed(1)} in wk15-17`);

out("\n=== findTrades (top 5) ===");
const started = process.hrtime.bigint();
const deals = findTrades(ctx, { maxResults: 10, perRival: 2 });
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
    myRosterId: ctx.myRosterId,
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
