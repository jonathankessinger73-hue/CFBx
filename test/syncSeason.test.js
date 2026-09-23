import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DATABASE_URL, freshDatabase } from "./helpers/db.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";
import { syncSeason } from "../src/jobs/syncSeason.js";
import { createTeamResolver } from "../src/cfbd/teamNames.js";
import { consensusSpread } from "../src/cfbd/client.js";

const skip = !TEST_DATABASE_URL && "TEST_DATABASE_URL not set";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const teams = read("teams.json");

test("CFBD names resolve to tickers, including accent and alias variants", () => {
  const resolve = createTeamResolver(teams);
  assert.equal(resolve("Georgia"), "UGA");
  assert.equal(resolve("San José State"), "SJSU");
  assert.equal(resolve("San Jose State"), "SJSU");
  assert.equal(resolve("Hawai'i"), "HAW");
  assert.equal(resolve("Hawaii"), "HAW");
  assert.equal(resolve("Miami (OH)"), "MIAOH");
  assert.equal(resolve("Miami"), "MIA");
  assert.equal(resolve("Sam Houston State"), "SHSU");
  assert.equal(resolve("Montana"), null);
});

test("consensus spread averages numeric provider spreads", () => {
  assert.equal(consensusSpread({ lines: [{ spread: -3 }, { spread: "-4" }, { spread: null }] }), -3.5);
  assert.equal(consensusSpread({ lines: [] }), null);
});

let pool;
before(async () => {
  if (skip) return;
  pool = await freshDatabase();
  await writeSeed(
    pool,
    buildSeed({ teams, results: read("results-2026.json"), schedule: read("schedule-2026.json"), season: 2026 })
  );
});
after(async () => {
  if (pool) await pool.dropDatabase();
});

const price = async (id) => (await pool.query("select current_price from teams where id = $1", [id])).rows[0].current_price;

test("sync posts missing lines and applies completed games exactly once", { skip }, async () => {
  // Week 4: UGA hosts OU (line posted); week 5: MSST hosts ALA (no line yet).
  const cfbd = {
    lines: async () => [
      { id: 501, week: 5, homeTeam: "Mississippi State", awayTeam: "Alabama", lines: [{ spread: 10 }, { spread: 11 }] },
      { id: 401, week: 4, homeTeam: "Georgia", awayTeam: "Oklahoma", lines: [{ spread: -14 }] },
    ],
    games: async () => [
      // UGA favored by 14, wins by 3: misses, should drop.
      { id: 401, season: 2026, week: 4, completed: true, homeTeam: "Georgia", awayTeam: "Oklahoma", homePoints: 24, awayPoints: 21 },
      // Reported with home/away flipped relative to our schedule (TEX @ TENN).
      { id: 402, season: 2026, week: 4, completed: true, homeTeam: "Texas", awayTeam: "Tennessee", homePoints: 30, awayPoints: 10 },
      { id: 403, season: 2026, week: 4, completed: true, homeTeam: "Georgia", awayTeam: "Montana", homePoints: 70, awayPoints: 0 },
      { id: 501, season: 2026, week: 5, completed: false, homeTeam: "Mississippi State", awayTeam: "Alabama" },
    ],
  };
  const ugaBefore = await price("UGA");
  const ouBefore = await price("OU");
  const logs = [];
  const summary = await syncSeason({ pool, cfbd, season: 2026, log: (m) => logs.push(m), random: () => 0.5 });

  assert.equal(summary.linesPosted, 1);
  assert.equal(summary.gamesApplied, 2);
  assert.ok((await price("UGA")) < ugaBefore);
  assert.ok((await price("OU")) > ouBefore);

  const { rows: msst } = await pool.query(
    "select line, cfbd_game_id from schedule where week = 5 and home_team_id = 'MSST' and away_team_id = 'ALA'"
  );
  assert.deepEqual(msst[0], { line: 10.5, cfbd_game_id: 501 });

  const { rows: tenn } = await pool.query(
    "select home_score, away_score, completed from schedule where week = 4 and home_team_id = 'TENN'"
  );
  assert.deepEqual(tenn[0], { home_score: 10, away_score: 30, completed: true });

  const { rows: ev } = await pool.query(
    "select expected_margin, actual_margin, is_real_line from price_events where team_id = 'UGA' and week = 4"
  );
  assert.deepEqual(ev[0], { expected_margin: 14, actual_margin: 3, is_real_line: true });

  // Second run is a no-op.
  const ugaAfter = await price("UGA");
  const again = await syncSeason({ pool, cfbd, season: 2026, log: () => {} });
  assert.equal(again.gamesApplied, 0);
  // Games that were already applied aren't reported as unmatched.
  assert.deepEqual(again.unmatched, []);
  assert.equal(again.linesPosted, 0);
  assert.equal(await price("UGA"), ugaAfter);
});

test("dry run writes nothing", { skip }, async () => {
  const cfbd = {
    lines: async () => [],
    games: async () => [
      { id: 404, season: 2026, week: 4, completed: true, homeTeam: "Ohio State", awayTeam: "Illinois", homePoints: 3, awayPoints: 42 },
    ],
  };
  const before = await price("OSU");
  const summary = await syncSeason({ pool, cfbd, season: 2026, dryRun: true, log: () => {} });
  assert.equal(summary.gamesApplied, 1);
  assert.equal(await price("OSU"), before);
});
