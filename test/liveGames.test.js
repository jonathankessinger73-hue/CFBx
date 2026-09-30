import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DATABASE_URL, freshDatabase } from "./helpers/db.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";
import { liveTick } from "../src/live/liveGames.js";
import { gameElapsed, liveMovePct, parseClock } from "../src/engine/pricing.js";
import { normalizeScoreboardGame } from "../src/cfbd/client.js";

const skip = !TEST_DATABASE_URL && "TEST_DATABASE_URL not set";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

test("live move math: elapsed time, clock parsing, scaled move", () => {
  assert.equal(parseClock("7:32"), 452);
  assert.equal(parseClock("00:07:32"), 452);
  assert.equal(parseClock(null), null);
  assert.equal(gameElapsed(1, "15:00"), 0);
  assert.equal(gameElapsed(2, "0:00"), 0.5);
  assert.equal(gameElapsed(3, "7:30"), 0.625);
  assert.equal(gameElapsed(5, "10:00"), 1);
  assert.equal(gameElapsed(null, null), 0);
  // Favored by 7, up 21 at halftime: beating the line by 14 -> half of 4.63%.
  assert.equal(liveMovePct(7, 21, 0.5), 2.32);
  assert.equal(liveMovePct(7, 0, 0.5), -1.19);
  assert.equal(liveMovePct(7, 0, 0), 0);
});

test("scoreboard games normalize from CFBD's shape", () => {
  const g = normalizeScoreboardGame({
    id: 9, status: "in_progress", period: 3, clock: "00:07:32", startDate: "2026-10-03T16:00:00.000Z",
    homeTeam: { name: "Georgia", classification: "fbs", points: 21 },
    awayTeam: { name: "Oklahoma", classification: "fbs", points: "17" },
  });
  assert.deepEqual(g, {
    id: 9, status: "in_progress", period: 3, clock: "00:07:32", startDate: "2026-10-03T16:00:00.000Z",
    home: "Georgia", away: "Oklahoma", homeClassification: "fbs", awayClassification: "fbs",
    homePoints: 21, awayPoints: 17,
  });
  assert.equal(normalizeScoreboardGame({ status: "final" }).status, "completed");
  assert.equal(normalizeScoreboardGame({ status: "scheduled" }).status, "scheduled");
});

let pool;
before(async () => {
  if (skip) return;
  pool = await freshDatabase();
  await writeSeed(
    pool,
    buildSeed({ teams: read("teams.json"), results: read("results-2026.json"), schedule: read("schedule-2026.json"), season: 2026 })
  );
});
after(async () => {
  if (pool) await pool.dropDatabase();
});

const team = async (id) =>
  (await pool.query("select fundamental_price, live_pct, live_status, current_price from teams where id = $1", [id])).rows[0];

test("live games: no calls outside game windows; live moves during a game; the final applies itself", { skip }, async () => {
  let calls = 0;
  const board = [];
  const cfbd = { scoreboard: async () => (calls++, board) };
  const now = new Date("2026-10-03T18:00:00Z");

  // Nothing kicking off around now: no scoreboard call.
  assert.deepEqual(await liveTick({ pool, cfbd, now, log: () => {} }), { polled: false, live: 0, finalized: 0 });
  assert.equal(calls, 0);

  // Week 4: UGA hosts OU, UGA favored by 14 (line -14), kicked off an hour ago.
  const { rows } = await pool.query(
    "update schedule set start_date = $1, line = -14 where week = 4 and home_team_id = 'UGA' and away_team_id = 'OU' returning id",
    [new Date(now.getTime() - 3600_000).toISOString()]
  );
  assert.equal(rows.length, 1);
  const [uga0, ou0] = [await team("UGA"), await team("OU")];

  // Halftime-ish: OU leads 17-10 (UGA 21 points worse than the line).
  board.push({
    id: 777, status: "in_progress", period: 2, clock: "0:00",
    homeTeam: { name: "Georgia", points: 10 }, awayTeam: { name: "Oklahoma", points: 17 },
  });
  const tick = await liveTick({ pool, cfbd, now, log: () => {} });
  assert.deepEqual(tick, { polled: true, live: 1, finalized: 0 });
  const [uga1, ou1] = [await team("UGA"), await team("OU")];
  assert.equal(uga1.live_pct, liveMovePct(14, -7, 0.5));
  assert.equal(ou1.live_pct, liveMovePct(-14, 7, 0.5));
  assert.equal(uga1.live_status, "Q2 0:00 · OU 17, UGA 10");
  assert.equal(uga1.fundamental_price, uga0.fundamental_price, "live moves don't touch the fundamental");
  assert.ok(uga1.current_price < uga0.current_price && ou1.current_price > ou0.current_price);

  // Final: the result applies right away and replaces the live move.
  board[0] = { ...board[0], status: "completed", period: 4, clock: "0:00", awayTeam: { name: "Oklahoma", points: 24 } };
  const final = await liveTick({ pool, cfbd, now, log: () => {} });
  assert.equal(final.finalized, 1);
  const uga2 = await team("UGA");
  assert.equal(uga2.live_pct, 0);
  assert.equal(uga2.live_status, null);
  assert.ok(uga2.fundamental_price < uga0.fundamental_price);
  const { rows: game } = await pool.query("select completed, home_score, away_score from schedule where id = $1", [rows[0].id]);
  assert.deepEqual(game[0], { completed: true, home_score: 10, away_score: 24 });

  // Once nothing's in the window, leftover live moves are cleared too.
  await pool.query("update teams set live_pct = 2, live_status = 'Q1 9:00 · X' where id = 'TEX'");
  await liveTick({ pool, cfbd, now: new Date("2026-12-25T12:00:00Z"), log: () => {} });
  assert.deepEqual(await pool.query("select live_pct, live_status from teams where id = 'TEX'").then((r) => r.rows[0]), {
    live_pct: 0,
    live_status: null,
  });
});
