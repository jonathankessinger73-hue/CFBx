import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TEST_DATABASE_URL, freshDatabase } from "./helpers/db.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";
import { syncSeason } from "../src/jobs/syncSeason.js";
import { createTeamResolver } from "../src/cfbd/teamNames.js";
import { consensusSpread, cleanApiKey, createCfbdClient } from "../src/cfbd/client.js";

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
  assert.equal(summary.fcsGames, 1); // UGA over Montana: recorded, no price move
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

test("FCS games are recorded: wins don't move the price, losses cost a penalty", { skip }, async () => {
  const events = async (id) =>
    (
      await pool.query(
        `select week, opponent_id, opponent_name, team_score, opp_score, pct_change, price_after,
                is_real_line, vs_fcs, summary
           from price_events where team_id = $1 and vs_fcs order by week`,
        [id]
      )
    ).rows;
  const lsu = await price("LSU");
  const cfbd = {
    lines: async () => [],
    games: async () => [
      // LSU loses at home to an FCS team by 10 in week 6.
      { id: 601, season: 2026, week: 6, completed: true, homeTeam: "LSU", awayTeam: "McNeese",
        homeClassification: "fbs", awayClassification: "fcs", homePoints: 17, awayPoints: 27 },
      // Reported late: a week-1 FCS win. Charted at LSU's week-1 price.
      { id: 101, season: 2026, week: 1, completed: true, homeTeam: "Nicholls", awayTeam: "LSU",
        homeClassification: "fcs", awayClassification: "fbs", homePoints: 3, awayPoints: 52 },
      // An FBS name we can't map is reported, never treated as FCS.
      { id: 602, season: 2026, week: 6, completed: true, homeTeam: "LSU", awayTeam: "Some New FBS School",
        homeClassification: "fbs", awayClassification: "fbs", homePoints: 30, awayPoints: 0 },
    ],
  };
  const dry = await syncSeason({ pool, cfbd, season: 2026, dryRun: true, log: () => {} });
  assert.equal(dry.fcsGames, 2);
  assert.equal(await price("LSU"), lsu);

  const r = await syncSeason({ pool, cfbd, season: 2026, log: () => {} });
  assert.equal(r.fcsGames, 2);
  assert.deepEqual(r.unmatched, ["6: Some New FBS School @ LSU"]);
  const after = await price("LSU");
  assert.equal(after, Math.round(lsu * 0.8 * 100) / 100); // lost by 10: -20%

  const { rows: wk1 } = await pool.query(
    "select price_after from price_events where team_id = 'LSU' and week = 1 and not vs_fcs"
  );
  const [win, loss] = await events("LSU");
  assert.deepEqual(win, {
    week: 1, opponent_id: null, opponent_name: "Nicholls", team_score: 52, opp_score: 3,
    pct_change: 0, price_after: wk1[0].price_after, is_real_line: null, vs_fcs: true,
    summary: "FCS opponent, no line — price unchanged",
  });
  assert.ok(Math.abs(loss.pct_change + 20) < 0.02, `${loss.pct_change}`); // realized, after cent rounding
  assert.equal(loss.price_after, after);

  // The latest game (week 6 loss) drives the "last game" fields.
  const { rows: t } = await pool.query("select last_change_pct, last_covered, last_actual from teams where id = 'LSU'");
  assert.equal(t[0].last_change_pct, loss.pct_change);
  assert.deepEqual({ ...t[0], last_change_pct: 0 }, { last_change_pct: 0, last_covered: null, last_actual: -10 });

  // Records count FCS games; ATS doesn't (no line).
  const { createStore } = await import("../src/db/store.js");
  const store = createStore(pool);
  const before = (await store.listRecords(2026)).get("LSU");
  const detail = await store.getPriceEvents("LSU", 2026);
  assert.ok(detail.some((e) => e.vs_fcs && e.opponent_name === "McNeese"));
  const again = await syncSeason({ pool, cfbd, season: 2026, log: () => {} });
  assert.equal(again.fcsGames, 0);
  assert.equal(await price("LSU"), after);
  assert.deepEqual((await store.listRecords(2026)).get("LSU"), before);
  const fbsGames = detail.filter((e) => !e.vs_fcs);
  assert.equal(before.overall.wins + before.overall.losses, fbsGames.length + 2);
  assert.equal(
    before.ats.wins + before.ats.losses + before.ats.pushes,
    fbsGames.filter((e) => e.is_real_line).length
  );
});

test("sync stores CFBD's official records; a failing /records call doesn't fail the run", { skip }, async () => {
  const records = [
    { year: 2026, team: "Georgia", total: { games: 4, wins: 4, losses: 0, ties: 0 }, conferenceGames: { games: 2, wins: 2, losses: 0, ties: 0 } },
    { year: 2026, team: "Montana", total: { wins: 3, losses: 1, ties: 0 }, conferenceGames: { wins: 1, losses: 0, ties: 0 } },
  ];
  const base = { lines: async () => [], games: async () => [] };
  const rec = async () =>
    (await pool.query("select record_season, wins, losses, conf_wins, conf_losses from teams where id = 'UGA'")).rows[0];

  const dry = await syncSeason({ pool, cfbd: { ...base, records: async () => records }, season: 2026, dryRun: true, log: () => {} });
  assert.equal(dry.recordsUpdated, 1);
  assert.equal((await rec()).wins, null);

  const r = await syncSeason({ pool, cfbd: { ...base, records: async () => records }, season: 2026, log: () => {} });
  assert.equal(r.recordsUpdated, 1); // Montana isn't in the market
  assert.deepEqual(await rec(), { record_season: 2026, wins: 4, losses: 0, conf_wins: 2, conf_losses: 0 });

  const logs = [];
  const failing = await syncSeason({
    pool,
    cfbd: { ...base, records: async () => { throw new Error("CFBD /records failed: 500"); } },
    season: 2026,
    log: (m) => logs.push(m),
  });
  assert.equal(failing.recordsUpdated, 0);
  assert.ok(logs.some((m) => m.includes("records not updated")));
  assert.equal((await rec()).wins, 4);
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

test("CFBD keys are cleaned of quotes, spaces and a pasted Bearer prefix", async () => {
  for (const k of ["abc123", " abc123 ", '"abc123"', "Bearer abc123", "'Bearer abc123'", "bearer   abc123"]) {
    assert.equal(cleanApiKey(k), "abc123", k);
  }
  let sent;
  const cfbd = createCfbdClient({
    apiKey: "Bearer abc123",
    fetchImpl: async (url, opts) => {
      sent = opts.headers.Authorization;
      return new Response("{}", { status: 401 });
    },
  });
  await assert.rejects(cfbd.lines(2026), /rejected the API key \(401\).*6 characters/);
  assert.equal(sent, "Bearer abc123");
});
