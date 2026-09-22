// data/stats.json and data/dvp.json — the transform, the contract and the last-good guard
// (004 design §2.1, §2.3). Fixtures are live pulls from 2026-09-22; nothing here touches the
// network and nothing reads a clock.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DVP_POSITIONS,
  STATS_VERSION,
  STAT_KEYS,
  buildDvp,
  buildStats,
  completedWeeks,
  decodeStatLine,
  encodeStatLine,
  gameIdsFromRows,
  teamTotalsFromRows,
  weekIsPartial,
} from "../pipeline/sources/sleeper-stats.mjs";
import { validateDvp, validateStats } from "../pipeline/contract.mjs";
import { resolveOptional, optionalRowCount } from "../pipeline/lastgood.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const RAW_WK2 = fixture("sleeper_stats_2026_wk2_raw.json");
const STATS = fixture("stats_2026.json");
const DVP = fixture("dvp_2026.json");
const SCHEDULE = fixture("schedule.json");
const AT = "2026-09-22T16:00:00Z";

test("STAT_KEYS is the 16-key vocabulary of design §2.1, in order", () => {
  assert.deepEqual(STAT_KEYS, [
    "off_snp", "tm_off_snp", "gp", "rec_tgt", "rec", "rec_yd", "rec_td", "rec_rz_tgt",
    "rush_att", "rush_yd", "rush_td", "rush_rz_att", "pass_att", "pass_yd", "pass_td", "pass_rz_att",
  ]);
  // A FIXED vocabulary, unlike projections v2: a week with no quarterbacks must never renumber it.
  assert.equal(STATS.keys.join(","), STAT_KEYS.join(","));
});

test("encodeStatLine emits sorted [keyIdx, value] pairs and drops zeros", () => {
  const entry = encodeStatLine({ rec_tgt: 13, rec: 9, off_snp: 69, tm_off_snp: 69, rec_drop: 2, pass_att: 0 });
  assert.deepEqual(entry, [0, 69, 1, 69, 3, 13, 4, 9]);
  // `rec_drop` is outside the vocabulary; `pass_att: 0` is the same as absent.
  assert.deepEqual(decodeStatLine(entry), { off_snp: 69, tm_off_snp: 69, rec_tgt: 13, rec: 9 });
});

test("encodeStatLine collapses an empty line to the scalar 0", () => {
  assert.equal(encodeStatLine({}), 0);
  assert.equal(encodeStatLine({ rec_drop: 3 }), 0);
  assert.equal(encodeStatLine(null), 0);
  assert.equal(encodeStatLine({ rec_tgt: Number.NaN }), 0);
});

test("teamTotalsFromRows sums targets, not pass attempts (R6 §Q6.3)", () => {
  const rows = [
    { team: "KC", stats: { rec_tgt: 5, pass_att: 0, rush_att: 2, tm_off_snp: 80 } },
    { team: "KC", stats: { rec_tgt: 8, pass_att: 47, rush_att: 0, tm_off_snp: 80 } },
    { team: "kc", stats: { rec_tgt: 1, tm_off_snp: 80 } },
  ];
  assert.deepEqual(teamTotalsFromRows(rows).KC, { tgt: 14, snp: 80, att: 47, rush: 2 });
});

test("weekIsPartial flags the Monday-game snap lag, not a complete week", () => {
  // R6 §Q6.3: LAR and NYG arrived with no off_snp/tm_off_snp at all ~5 h after the final whistle.
  const complete = [{ team: "KC", stats: { tm_off_snp: 80 } }, { team: "BUF", stats: { tm_off_snp: 71 } }];
  const lagging = [...complete, { team: "LAR", stats: { rec_tgt: 4 } }];
  assert.equal(weekIsPartial(complete), false);
  assert.equal(weekIsPartial(lagging), true);
  assert.equal(weekIsPartial([]), true);
});

test("completedWeeks is every week strictly before Sleeper's state week", () => {
  assert.deepEqual(completedWeeks(1), []);
  assert.deepEqual(completedWeeks(3), [1, 2]);
  assert.deepEqual(completedWeeks(19), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.deepEqual(completedWeeks("bad"), []);
});

test("buildStats keeps only the allowed ids and the trailing window", () => {
  const weeks = [1, 2, 3, 4].map((week) => ({
    week,
    rows: [
      { player_id: "4046", team: "KC", stats: { rec_tgt: week, tm_off_snp: 70 } },
      { player_id: "9999", team: "KC", stats: { rec_tgt: 1, tm_off_snp: 70 } },
    ],
  }));
  const built = buildStats({ weeks, allowedIds: new Set(["4046"]), season: 2026, generatedAt: AT, window: 2 });
  assert.deepEqual(built.weeks, [3, 4]);
  assert.deepEqual(Object.keys(built.players), ["4046"]);
  assert.equal(built.players["4046"].length, 2);
  assert.deepEqual(decodeStatLine(built.players["4046"][1]), { tm_off_snp: 70, rec_tgt: 4 });
  // `std` is season-to-date over EVERY completed week, not just the window: 1+2+3+4 targets.
  assert.deepEqual(decodeStatLine(built.std["4046"]), { tm_off_snp: 280, rec_tgt: 10 });
  // Team denominators cover the window weeks only — that is what a share needs.
  assert.deepEqual(Object.keys(built.teams.KC), ["3", "4"]);
});

test("buildStats is deterministic and drops a player with no non-empty week", () => {
  const weeks = [{ week: 1, rows: [{ player_id: "1", team: "KC", stats: { rec_drop: 2, def_snp: 31 } }] }];
  const built = buildStats({ weeks, allowedIds: null, season: 2026, generatedAt: AT });
  assert.deepEqual(built.players, {});
  assert.equal(JSON.stringify(built), JSON.stringify(buildStats({ weeks, allowedIds: null, season: 2026, generatedAt: AT })));
});

test("the committed stats fixture satisfies the contract", () => {
  assert.equal(STATS.version, STATS_VERSION);
  assert.deepEqual(validateStats(STATS), []);
  assert.deepEqual(STATS.weeks, [1, 2]);
  assert.equal(Object.keys(STATS.teams).length, 32);
  // Every player row is as long as `weeks`, and the engine's "0 = no game" convention holds.
  for (const list of Object.values(STATS.players)) {
    assert.equal(list.length, STATS.weeks.length);
    assert.ok(list.some((entry) => Array.isArray(entry)));
  }
});

test("validateStats rejects a renumbered, gappy or oversized file", () => {
  const bad = (patch) => validateStats({ ...STATS, ...patch });
  assert.ok(bad({ version: 2 }).some((p) => p.includes("version")));
  assert.ok(bad({ weeks: [2, 1] }).some((p) => p.includes("strictly increasing")));
  assert.ok(bad({ partial: [9] }).some((p) => p.includes("not in stats.weeks")));
  assert.ok(
    validateStats({ ...STATS, players: { ...STATS.players, zz: [0, 0] } }).some((p) => p.includes("no non-empty week")),
  );
  assert.ok(
    validateStats({ ...STATS, teams: {} }).some((p) => p.includes("covers no team-week")),
  );
});

test("the fixture's snap counts are internally consistent", () => {
  // `off_snp <= tm_off_snp` on every line, and every `tm_off_snp` a player carries is one of the
  // 32 team snap counts for that week — the denominators and the numerators come from one file.
  const week = STATS.weeks.indexOf(2);
  const teamSnaps = new Set(
    Object.values(STATS.teams)
      .map((byWeek) => byWeek["2"]?.snp)
      .filter((snp) => typeof snp === "number" && snp > 0),
  );
  let checked = 0;
  for (const [id, list] of Object.entries(STATS.players)) {
    const line = decodeStatLine(list[week]);
    if (!line.tm_off_snp) continue;
    assert.ok(line.tm_off_snp > 0, `${id} has a non-positive team snap count`);
    assert.ok((line.off_snp ?? 0) <= line.tm_off_snp, `${id} played more snaps than his team`);
    assert.ok(teamSnaps.has(line.tm_off_snp), `${id} carries a team snap count no team reports`);
    checked += 1;
  }
  assert.ok(checked > 60, `only ${checked} players checked`);
});

test("the fixture's target denominators bound every player's targets", () => {
  // R6 §Q6.3: the share denominator is Σ rec_tgt, so no player may exceed his team's total.
  const totals = Object.fromEntries(
    Object.entries(STATS.teams).map(([team, byWeek]) => [team, byWeek["2"]?.tgt ?? 0]),
  );
  const biggest = Math.max(...Object.values(totals));
  const week = STATS.weeks.indexOf(2);
  for (const [id, list] of Object.entries(STATS.players)) {
    const line = decodeStatLine(list[week]);
    if (!line.rec_tgt) continue;
    assert.ok(line.rec_tgt <= biggest, `${id} has ${line.rec_tgt} targets, above every team total`);
  }
  assert.ok(biggest >= 25 && biggest <= 70, `a team-week target total of ${biggest} is implausible`);
});

test("buildDvp attributes points to the OPPONENT, in half-PPR", () => {
  const weeks = [
    {
      week: 1,
      rows: [
        { player_id: "a", team: "KC", opponent: "BUF", player: { position: "WR" }, stats: { pts_half_ppr: 12.5, pts_ppr: 15 } },
        { player_id: "b", team: "KC", opponent: "BUF", player: { position: "WR" }, stats: { pts_half_ppr: 7.5, pts_ppr: 9 } },
        { player_id: "BUF", team: "BUF", opponent: "KC", player: { position: "DEF" }, stats: { fan_pts_allow_wr: 24, pts_half_ppr: 6 } },
      ],
    },
  ];
  const dvp = buildDvp({ weeks, season: 2026, generatedAt: AT });
  assert.equal(dvp.scoring, "half_ppr");
  assert.equal(dvp.teams.BUF.allowed.WR[0], 20);
  assert.equal(dvp.teams.BUF.std.WR, 20);
  // Sleeper's own number is FULL PPR (R6 §Q6.4) and is only ever provenance.
  assert.equal(dvp.teams.BUF.ppr_ref.WR, 24);
  assert.notEqual(dvp.teams.BUF.ppr_ref.WR, dvp.teams.BUF.std.WR);
  assert.equal(dvp.teams.KC.allowed.DEF[0], 6);
  assert.equal(dvp.teams.BUF.gp, 1);
});

test("buildDvp falls back to the schedule when a row carries no opponent", () => {
  const weeks = [
    { week: 1, rows: [{ player_id: "a", team: "SEA", player: { position: "RB" }, stats: { pts_half_ppr: 9 } }] },
  ];
  const withSchedule = buildDvp({ weeks, season: 2026, generatedAt: AT, schedule: SCHEDULE });
  const opponent = SCHEDULE.games.find((g) => g.w === 1 && (g.home === "SEA" || g.away === "SEA"));
  const defense = opponent.home === "SEA" ? opponent.away : opponent.home;
  assert.equal(withSchedule.teams[defense].allowed.RB[0], 9);
  // Without a schedule there is nothing to attribute to, so the row is skipped rather than guessed.
  assert.deepEqual(Object.keys(buildDvp({ weeks, season: 2026, generatedAt: AT }).teams), []);
});

test("the committed dvp fixture satisfies the contract", () => {
  assert.deepEqual(validateDvp(DVP), []);
  assert.equal(Object.keys(DVP.teams).length, 32);
  for (const row of Object.values(DVP.teams)) {
    for (const pos of DVP_POSITIONS) {
      assert.equal(row.allowed[pos].length, DVP.weeks.length);
      const sum = row.allowed[pos].reduce((t, v) => t + (v ?? 0), 0);
      assert.ok(Math.abs(row.std[pos] - sum) < 0.05);
    }
    // Full PPR is >= half-PPR for every reception-scoring position.
    for (const pos of ["RB", "WR", "TE"]) assert.ok(row.ppr_ref[pos] >= row.std[pos] - 0.01);
    // R6 §Q6.4: QB and K score identically in all three currencies.
    for (const pos of ["QB", "K"]) assert.ok(Math.abs(row.ppr_ref[pos] - row.std[pos]) < 0.01);
  }
});

test("validateDvp catches a std that does not match its allowed row", () => {
  const broken = structuredClone(DVP);
  broken.teams.KC.std.WR += 5;
  assert.ok(validateDvp(broken).some((p) => p.includes("dvp.teams[\"KC\"].std.WR")));
  const short = structuredClone(DVP);
  delete short.teams.KC;
  assert.ok(validateDvp(short).some((p) => p.includes("31 teams")));
});

test("the raw week-2 sample transforms without the network", () => {
  const weeks = [{ week: 2, rows: RAW_WK2 }];
  const stats = buildStats({ weeks, allowedIds: null, season: 2026, generatedAt: AT });
  assert.equal(stats.weeks.length, 1);
  assert.ok(Object.keys(stats.players).length > 40);
  assert.deepEqual(validateStats(stats), []);
  const dvp = buildDvp({ weeks, season: 2026, generatedAt: AT });
  assert.ok(Object.keys(dvp.teams).length >= 30);
  // `game_id` on the rich rows is the Sleeper id the schedule uses: "202610204" style.
  const ids = gameIdsFromRows(weeks);
  assert.ok(ids.size >= 30);
  for (const id of ids.values()) assert.match(id, /^\d{9}$/);
});

test("last-good keeps the committed file when a rebuild loses more than 20 %", () => {
  assert.equal(optionalRowCount("stats", STATS), Object.keys(STATS.players).length);
  const thin = { ...STATS, players: Object.fromEntries(Object.entries(STATS.players).slice(0, 40)) };

  const lost = resolveOptional({ name: "stats", next: thin, previous: STATS });
  assert.equal(lost.kept, true);
  assert.equal(lost.file, STATS);
  assert.match(lost.note, /kept the committed file/);

  const fine = { ...STATS, players: Object.fromEntries(Object.entries(STATS.players).slice(0, 130)) };
  assert.equal(resolveOptional({ name: "stats", next: fine, previous: STATS }).kept, false);
});

test("last-good never overwrites a good file with an empty one, and publishes a first run", () => {
  const empty = resolveOptional({ name: "dvp", next: null, previous: DVP, error: "sleeper down" });
  assert.equal(empty.kept, true);
  assert.equal(empty.file, DVP);
  assert.match(empty.note, /sleeper down/);

  const first = resolveOptional({ name: "dvp", next: DVP, previous: null });
  assert.equal(first.kept, false);
  assert.equal(first.file, DVP);

  const nothing = resolveOptional({ name: "dvp", next: null, previous: null, error: "no week" });
  assert.equal(nothing.file, null);
  assert.equal(nothing.kept, false);
});
