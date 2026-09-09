import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildContext } from "../src/engine/context.js";
import {
  curveFit,
  curveValue,
  injuryDiscount,
  marketValue,
  rosBaselines,
  rosRanks,
  scaleFactors,
  sideValue,
  surplus,
  waiverReplacement,
} from "../src/engine/values.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const INPUT = {
  league: fixture("league.json"),
  users: fixture("users.json"),
  rosters: fixture("rosters.json"),
  players: fixture("players.json"),
  projections: fixture("projections.json"),
  values: fixture("values.json"),
  schedule: fixture("schedule.json"),
  state: fixture("state.json"),
};
const RAW_VALUES = fixture("values.json");
const make = (settings) => buildContext(INPUT, settings);
const ctx = make({});

// fixture ids (verified against test/fixtures/players.json)
const BARKLEY = "4866"; // RB, healthy, priced by both FantasyCalc tables
const HIGGINS = "6801"; // WR, Questionable
const ADAMS = "2133"; // WR on roster 4, healthy
const KICKER = "12711"; // Tyler Loop, K on roster 3
const DEFENSE = "HOU"; // D/ST on roster 3

test("curveFit is a sane exponential value curve", () => {
  const { A, k, n } = curveFit(ctx);
  assert.equal(n, 120, "regression window is the top 120 remaining-season ranks");
  assert.ok(A > 5000 && A < 12000, `A=${A} should sit near the R3-measured 7734`);
  assert.ok(k > 0.012 && k < 0.035, `k=${k} should sit near the R3-measured 0.0202`);
  // the curve must be monotonically decreasing in rank
  assert.ok(A * Math.exp(-k * 1) > A * Math.exp(-k * 50));
  assert.equal(curveFit(ctx), curveFit(ctx), "memoized on ctx");
});

test("remaining-season ranks are replacement-adjusted, not raw points", () => {
  const { baseline, consumed } = rosBaselines(ctx);
  assert.equal(consumed.QB, 8, "1 QB slot x 8 teams");
  assert.ok(consumed.RB >= 16 && consumed.WR >= 24, "FLEX allocation is derived on top of the dedicated slots");
  assert.ok(baseline.QB > baseline.RB, "QBs out-score RBs in raw points, which is why ranking uses VORP");
  const ranks = rosRanks(ctx);
  const top = [...ranks].filter(([, r]) => r <= 5).map(([id]) => ctx.players.get(id).pos);
  assert.ok(!top.every((p) => p === "QB"), "a raw-points rank would put every QB on top");
});

test("marketValue of an FC-covered player is the documented blend", () => {
  const mv = marketValue(ctx, BARKLEY);
  const factors = scaleFactors(ctx);
  const fcRedraft = RAW_VALUES.sources.fc_redraft.values[BARKLEY].v;
  const fcDynasty = RAW_VALUES.sources.fc_dynasty.values[BARKLEY].v;
  const curve = curveValue(ctx, BARKLEY);

  const w = ctx.settings.weights;
  const expectedRedraft = (w.fc_redraft * fcRedraft + w.proj * curve) / (w.fc_redraft + w.proj);
  const expectedDynasty = fcDynasty * factors.fc_dynasty; // dp_dynasty absent → renormalized to 1
  const phi = ctx.settings.keeperTilt;
  const expectedM = (1 - phi) * expectedRedraft + phi * expectedDynasty;

  assert.ok(Math.abs(mv.redraft - expectedRedraft) < 1e-9);
  assert.ok(Math.abs(mv.dynasty - expectedDynasty) < 1e-9);
  assert.ok(Math.abs(mv.m - expectedM) < 1e-9);
  assert.equal(mv.fallback, "blend");
  assert.equal(mv.coverage, 1);
  assert.equal(mv.mAdj, mv.m, "healthy player takes no injury haircut");
  assert.equal(mv.sourcesRaw.fc_redraft, fcRedraft);
  assert.equal(mv.rank, RAW_VALUES.sources.fc_redraft.values[BARKLEY].r);
  assert.equal(mv.posRank, RAW_VALUES.sources.fc_redraft.values[BARKLEY].pr);
});

test("dynasty sources are median-of-ratios scale-matched onto fc_redraft", () => {
  const factors = scaleFactors(ctx);
  assert.equal(factors.fc_redraft, 1);
  assert.equal(factors.proj, 1);
  assert.ok(factors.fc_dynasty > 0.1 && factors.fc_dynasty < 5, "a real multiplier, not a fudge");

  const ratios = [];
  for (const [id, row] of Object.entries(RAW_VALUES.sources.fc_dynasty.values)) {
    const ref = RAW_VALUES.sources.fc_redraft.values[id];
    if (row.v > 0 && ref && ref.v > 0) ratios.push(ref.v / row.v);
  }
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const expected = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  assert.ok(Math.abs(factors.fc_dynasty - expected) < 1e-12);
});

test("K and DEF have no market value and never enter trade math", () => {
  for (const id of [KICKER, DEFENSE]) {
    const mv = marketValue(ctx, id);
    assert.equal(mv.m, null);
    assert.equal(mv.mAdj, null);
    assert.equal(mv.fallback, null);
    assert.equal(surplus(ctx, id), 0);
  }
  const side = sideValue(ctx, [KICKER, DEFENSE]);
  assert.equal(side.raw, 0);
  assert.equal(side.surplus, 0);
  assert.equal(side.best, null);
});

test("an unpriced skill player falls back to the fitted curve", () => {
  const curveOnly = [...ctx.players.keys()].filter((id) => marketValue(ctx, id).fallback === "curve");
  assert.ok(curveOnly.length > 0, "the fixtures contain players no source prices");
  for (const id of curveOnly.slice(0, 25)) {
    const mv = marketValue(ctx, id);
    assert.equal(mv.coverage, 0);
    assert.ok(mv.m > 0, `${id} should still carry a positive curve value`);
    assert.ok(Math.abs(mv.m - mv.projV) < 1e-9, "with no market source the blend is the curve itself");
    assert.equal(mv.sourcesRaw.fc_redraft, undefined);
  }
});

test("the injury discount applies on the market axis only", () => {
  const mv = marketValue(ctx, HIGGINS);
  assert.equal(ctx.players.get(HIGGINS).inj, "Questionable");
  assert.equal(mv.discount, 0.03);
  assert.ok(Math.abs(mv.mAdj - mv.m * 0.97) < 1e-9);

  assert.equal(injuryDiscount(ctx, null), 0);
  assert.equal(injuryDiscount(ctx, "Out"), 0.15);
  assert.equal(injuryDiscount(ctx, "IR"), 0.35);
  assert.equal(injuryDiscount(ctx, "Suspended"), 0.25, "alias of Sus");
  assert.equal(injuryDiscount(ctx, "Bruised ego"), 0, "unknown statuses cost nothing");

  const noDiscount = make({ injuryDiscount: { Questionable: 0 } });
  assert.equal(marketValue(noDiscount, HIGGINS).mAdj, marketValue(noDiscount, HIGGINS).m);
});

test("waiverReplacement measures this league's live wire, position by position", () => {
  const w = waiverReplacement(ctx);
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    assert.ok(w[pos] > 0, `${pos} replacement must be priced`);
    assert.ok(w.best[pos] && w.best[pos].id, `${pos} needs a named best free agent`);
    assert.equal(ctx.players.get(w.best[pos].id).pos, pos);
    assert.ok(!ctx.rosterOf.has(w.best[pos].id), "the replacement must actually be a free agent");
  }
  assert.equal(w.FLEX, Math.max(w.RB, w.WR, w.TE));

  // R3 measured {QB 1359, RB 880, WR 764, TE 519} on 2026-09-09 raw FantasyCalc values
  assert.ok(w.QB > w.RB, "a free QB is the most valuable thing on an 8-team wire");
  assert.ok(w.RB > w.WR);
  assert.ok(w.WR > w.TE);
  assert.ok(w.QB > 800 && w.QB < 2200, `QB replacement ${w.QB}`);
  assert.ok(w.TE > 250 && w.TE < 1200, `TE replacement ${w.TE}`);
});

test("surplus is value above the wire, floored at zero", () => {
  const w = waiverReplacement(ctx);
  const mv = marketValue(ctx, BARKLEY);
  assert.ok(Math.abs(surplus(ctx, BARKLEY) - (mv.mAdj - w.RB)) < 1e-9);

  const waiverGrade = w.best.WR.id;
  const noRho = make({ rho: 0 });
  assert.ok(Math.abs(surplus(noRho, BARKLEY) - marketValue(noRho, BARKLEY).mAdj) < 1e-9, "ρ=0 disables the credit");
  assert.equal(surplus(ctx, waiverGrade), 0, "the wire itself has zero surplus by construction");
});

test("sideValue aggregates raw, surplus and the best player", () => {
  const side = sideValue(ctx, [BARKLEY, ADAMS, KICKER]);
  const a = marketValue(ctx, BARKLEY).mAdj;
  const b = marketValue(ctx, ADAMS).mAdj;
  assert.ok(Math.abs(side.raw - (a + b)) < 1e-9);
  assert.ok(Math.abs(side.surplus - (surplus(ctx, BARKLEY) + surplus(ctx, ADAMS))) < 1e-9);
  assert.equal(side.best, a > b ? BARKLEY : ADAMS);
});

test("the blend renormalizes when a source is missing entirely", () => {
  const noDynasty = buildContext({ ...INPUT, values: { sources: { fc_redraft: RAW_VALUES.sources.fc_redraft } } }, {});
  const mv = marketValue(noDynasty, BARKLEY);
  assert.equal(mv.dynasty, null);
  assert.ok(Math.abs(mv.m - mv.redraft) < 1e-9, "with no dynasty table the keeper tilt has nothing to tilt to");
  assert.ok(mv.m > 0);

  // an extra dynasty source that the fixtures do not carry must simply be renormalized away
  assert.equal(ctx.values.dp_dynasty, undefined);
  assert.equal(ctx.settings.dynastyWeights.dp_dynasty, 0.3);
  const withDp = buildContext(
    {
      ...INPUT,
      values: {
        sources: {
          ...RAW_VALUES.sources,
          dp_dynasty: { kind: "dynasty", label: "DynastyProcess", values: { [BARKLEY]: { v: 5000 } } },
        },
      },
    },
    {}
  );
  const both = marketValue(withDp, BARKLEY);
  assert.ok(both.dynasty !== marketValue(ctx, BARKLEY).dynasty, "a present third source changes the dynasty blend");
  assert.ok(both.sources.dp_dynasty > 0);
});
