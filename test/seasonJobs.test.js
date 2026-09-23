import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DATABASE_URL, freshDatabase } from "./helpers/db.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";
import { refreshStrength } from "../src/jobs/refreshStrength.js";
import { applyPrestige, buildPrestige } from "../src/prestige/rebuild.js";

const skip = !TEST_DATABASE_URL && "TEST_DATABASE_URL not set";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const teams = read("teams.json");

let pool;
before(async () => {
  if (skip) return;
  pool = await freshDatabase();
  await writeSeed(pool, buildSeed({ teams, results: read("results-2026.json"), schedule: read("schedule-2026.json"), season: 2026 }));
});
after(async () => {
  if (pool) await pool.dropDatabase();
});

const strengthOf = async (id) => (await pool.query("select strength from teams where id = $1", [id])).rows[0].strength;
// SP+ ratings for every team: linear from -30 (first team) to +30 (last), plus
// the national-averages row CFBD includes.
const spFor = (list) => async () => [
  ...list.map((t, i) => ({ year: 2026, team: t.name, rating: -30 + (60 * i) / (list.length - 1) })),
  { year: 2026, team: "nationalAverages", rating: 0 },
];

test("weekly strength refresh rescales SP+ to 10-95 and records history", { skip }, async () => {
  const logs = [];
  const r = await refreshStrength({ pool, cfbd: { spRatings: spFor(teams) }, season: 2026, log: (m) => logs.push(m) });
  assert.equal(r.skipped, false);
  assert.equal(r.rated, 138);
  assert.equal(r.week, 3); // latest completed week in the seed
  assert.deepEqual(r.unrated, []);
  assert.equal(await strengthOf(teams[0].id), 10);
  assert.equal(await strengthOf(teams[137].id), 95);

  const { rows } = await pool.query("select count(*)::int as n, min(week) as w from strength_history where season = 2026");
  assert.deepEqual(rows[0], { n: 138, w: 3 });

  // Same week again with new ratings: history row is replaced, not duplicated.
  const reversed = [...teams].reverse();
  await refreshStrength({ pool, cfbd: { spRatings: spFor(reversed) }, season: 2026, log: () => {} });
  assert.equal(await strengthOf(teams[0].id), 95);
  const { rows: again } = await pool.query("select count(*)::int as n from strength_history");
  assert.equal(again[0].n, 138);
  const { rows: hist } = await pool.query("select strength from strength_history where team_id = $1", [teams[0].id]);
  assert.equal(hist[0].strength, 95);
});

test("a thin SP+ pull leaves strengths alone; dry run writes nothing", { skip }, async () => {
  const before = await strengthOf("UGA");
  const thin = await refreshStrength({ pool, cfbd: { spRatings: spFor(teams.slice(0, 50)) }, season: 2026, log: () => {} });
  assert.equal(thin.skipped, true);
  assert.equal(await strengthOf("UGA"), before);

  const dry = await refreshStrength({ pool, cfbd: { spRatings: spFor(teams) }, season: 2026, dryRun: true, log: () => {} });
  assert.equal(dry.skipped, false);
  assert.equal(await strengthOf("UGA"), before);
});

test("teams missing from a week's SP+ keep their strength", { skip }, async () => {
  const without = teams.filter((t) => t.id !== "NDSU");
  await pool.query("update teams set strength = 42 where id = 'NDSU'");
  const r = await refreshStrength({ pool, cfbd: { spRatings: spFor(without) }, season: 2026, log: () => {} });
  assert.deepEqual(r.unrated, ["NDSU"]);
  assert.equal(await strengthOf("NDSU"), 42);
});

function prestigeResult(season, overrides = {}) {
  return {
    season,
    missing: [],
    rows: teams.map((t, i) => ({
      ticker: t.id,
      manual: t.id === "SACST",
      price: t.id === "SACST" ? 13 : 13 + i * 0.25,
      raw: t.id === "SACST" ? null : i,
      prestige: t.id === "SACST" ? null : 10 + i * 0.5,
      components: t.id === "SACST" ? null : { win_value: i },
    })),
    ...overrides,
  };
}

test("prestige apply is refused once the season has started", { skip }, async () => {
  await assert.rejects(applyPrestige(pool, prestigeResult(2026)), /already has \d+ completed games/);
  const { rows } = await pool.query("select count(*)::int as n from prestige_scores");
  assert.equal(rows[0].n, 0);
});

test("prestige apply sets next season's opening prices and records the scores", { skip }, async () => {
  const n = await applyPrestige(pool, prestigeResult(2027));
  assert.equal(n, 138);
  const { rows } = await pool.query(
    "select ipo_price, current_price, last_change_pct, last_covered from teams where id = $1",
    [teams[10].id]
  );
  assert.deepEqual(rows[0], { ipo_price: 15.5, current_price: 15.5, last_change_pct: 0, last_covered: null });
  const { rows: scores } = await pool.query(
    "select count(*)::int as n, count(*) filter (where manual)::int as manual from prestige_scores where season = 2027"
  );
  assert.deepEqual(scores[0], { n: 138, manual: 1 });
  // Re-applying before any 2027 game overwrites cleanly.
  await applyPrestige(pool, prestigeResult(2027));
});

test("prestige apply refuses results that leave a team unpriced", { skip }, async () => {
  await assert.rejects(applyPrestige(pool, prestigeResult(2027, { missing: ["NDSU"] })), /no price for NDSU/);
  const partial = prestigeResult(2027);
  partial.rows = partial.rows.filter((r) => r.ticker !== "UGA");
  await assert.rejects(applyPrestige(pool, partial), /no price for UGA/);
});

test("buildPrestige reads raw CFBD responses (v1 and v2 shapes) and falls back to last year's talent", { skip }, async () => {
  const calls = [];
  const cfbd = {
    games: async (year, type) => {
      calls.push(`games ${year} ${type}`);
      if (year === 2025 && type === "regular") {
        return [
          // v2 (camelCase)
          { id: 1, season: 2025, week: 1, seasonType: "regular", neutralSite: false, homeId: 61, homeTeam: "Georgia",
            homeConference: "SEC", homeClassification: "fbs", homePoints: 45, awayId: 9001, awayTeam: "Tennessee Tech",
            awayConference: "OVC", awayClassification: "fcs", awayPoints: 7 },
          // v1 (snake_case)
          { id: 2, season: 2025, week: 2, season_type: "regular", neutral_site: false, home_id: 333, home_team: "Alabama",
            home_conference: "SEC", home_division: "fbs", home_points: 31, away_id: 61, away_team: "Georgia",
            away_conference: "SEC", away_division: "fbs", away_points: 28 },
        ];
      }
      return [];
    },
    talent: async (year) => {
      calls.push(`talent ${year}`);
      return year === 2025 ? [{ year: 2025, school: "Alabama", talent: 990 }, { year: 2025, team: "Georgia", talent: 1000 }] : [];
    },
  };
  const r = await buildPrestige({ pool, cfbd, season: 2026, log: () => {} });
  assert.deepEqual(r.window, { start: 2014, end: 2025 });
  assert.equal(r.talentYear, 2025);
  assert.ok(calls.includes("talent 2026") && calls.includes("talent 2025"));
  assert.equal(calls.filter((c) => c.startsWith("games")).length, 24);

  const uga = r.rows.find((x) => x.ticker === "UGA");
  const ala = r.rows.find((x) => x.ticker === "ALA");
  // Georgia beat an FCS team; Alabama beat Georgia (1-1 -> quality 1.0).
  assert.ok(Math.abs(uga.components.win_value - 6 * 1.45 * 0.3 * 1.15) < 0.01);
  assert.ok(Math.abs(ala.components.win_value - 6 * 1.45 * 1.0 * 1.15) < 0.01);
  assert.equal(uga.components.talent, 18);
  // With two teams, talent spans 0..18: Georgia 3.0 + 18 beats Alabama 10.0 + 0.
  assert.equal(uga.price, 58);
  assert.equal(ala.price, 13);
  assert.equal(typeof uga.change_vs_current_ipo, "number");
  // Only UGA/ALA have history here; the newcomers get manual prices, the rest are reported.
  assert.equal(r.rows.find((x) => x.ticker === "SACST").price, 13);
  assert.equal(r.missing.length, 138 - 4);
  await assert.rejects(applyPrestige(pool, { ...r, season: 2028 }), /no price for/);
});
