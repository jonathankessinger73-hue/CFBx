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
      { id: 501, season: 2026, week: 5, completed: false, homeTeam: "Mississippi State", awayTeam: "Alabama",
        startDate: "2026-10-03T23:30:00.000Z" },
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
  // Kickoff times are stored for the live poller.
  const { rows: kick } = await pool.query("select start_date from schedule where cfbd_game_id = 501");
  assert.equal(kick[0].start_date.toISOString(), "2026-10-03T23:30:00.000Z");

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

const fundamental = async (id) =>
  (await pool.query("select fundamental_price from teams where id = $1", [id])).rows[0].fundamental_price;
const moves = async (kind) =>
  (await pool.query("select team_id, pct_change, summary from market_moves where kind = $1 order by id", [kind])).rows;

test("line moves before kickoff move both teams, once per change", { skip }, async () => {
  // The first test posted week 5 MSST (home) vs ALA at +10.5. It moves to +13.5:
  // MSST is 3 points more of an underdog.
  const base = { games: async () => [] };
  const lines = (spread) => async () => [
    { id: 501, week: 5, homeTeam: "Mississippi State", awayTeam: "Alabama", lines: [{ spread }] },
  ];
  const [msst, ala] = [await fundamental("MSST"), await fundamental("ALA")];

  const dry = await syncSeason({ pool, cfbd: { ...base, lines: lines(13.5) }, season: 2026, dryRun: true, log: () => {} });
  assert.equal(dry.lineMoves, 1);
  assert.equal(await fundamental("MSST"), msst);

  const r = await syncSeason({ pool, cfbd: { ...base, lines: lines(13.5) }, season: 2026, log: () => {} });
  assert.equal(r.lineMoves, 1);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.0002, `${a} vs ${b}`); // seed prices vary run to run
  near(await fundamental("MSST"), msst * 0.985);
  near(await fundamental("ALA"), ala * 1.015);
  assert.deepEqual(await moves("line"), [
    { team_id: "MSST", pct_change: -1.5, summary: "Line moved vs Alabama: now underdog by 13.5 (was underdog by 10.5)" },
    { team_id: "ALA", pct_change: 1.5, summary: "Line moved vs Mississippi State: now favored by 13.5 (was favored by 10.5)" },
  ]);
  const { rows } = await pool.query("select line, line_priced from schedule where cfbd_game_id = 501");
  assert.deepEqual(rows[0], { line: 13.5, line_priced: 13.5 });

  // Same line again, or a wobble under half a point: nothing.
  assert.equal((await syncSeason({ pool, cfbd: { ...base, lines: lines(13.5) }, season: 2026, log: () => {} })).lineMoves, 0);
  assert.equal((await syncSeason({ pool, cfbd: { ...base, lines: lines(13.8) }, season: 2026, log: () => {} })).lineMoves, 0);
  assert.equal((await moves("line")).length, 2);
});

test("poll moves: first run is a baseline, then entries, exits and moves; each release once", { skip }, async () => {
  const base = { lines: async () => [], games: async () => [] };
  const release = (week, poll, schools) => ({
    season: 2026, seasonType: "regular", week,
    polls: [{ poll, ranks: schools.map((school, i) => ({ rank: i + 1, school })) }],
  });
  const week4 = release(4, "AP Top 25", ["Georgia", "Alabama", "Ohio State"]);
  const week5 = release(5, "AP Top 25", ["Alabama", "Georgia", "Texas"]);
  const cfp5 = release(5, "Playoff Committee Rankings", ["Georgia"]);
  const run = (weeks) => syncSeason({ pool, cfbd: { ...base, rankings: async () => weeks }, season: 2026, log: () => {} });

  const first = await run([week4]);
  assert.equal(first.pollMoves, 0);
  const { rows } = await pool.query("select count(*)::int as n from poll_ranks");
  assert.equal(rows[0].n, 3);

  const osu = await fundamental("OSU");
  const second = await run([week4, week5, cfp5]);
  assert.equal(second.pollMoves, 5);
  assert.deepEqual(
    (await moves("poll")).map((m) => [m.team_id, m.pct_change, m.summary]).sort(),
    [
      ["ALA", 0.25, "Up 1 spot to No. 1 in the AP poll"],
      ["OSU", -4, "Dropped out of the AP poll (was No. 3)"],
      ["TEX", 4, "Entered the AP poll at No. 3"],
      ["UGA", -0.25, "Down 1 spot to No. 2 in the AP poll"],
      ["UGA", 4, "Entered the CFP rankings at No. 1"],
    ]
  );
  assert.ok(Math.abs((await fundamental("OSU")) - osu * 0.96) < 0.0002);

  assert.equal((await run([week4, week5, cfp5])).pollMoves, 0);
  assert.equal((await moves("poll")).length, 5);
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
  assert.ok(Math.abs(after - lsu * 0.8) < 0.011, `${after} vs ${lsu * 0.8}`); // lost by 10: -20%

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

test("sync stores ESPN logo URLs from CFBD, preferring https", { skip }, async () => {
  const base = { lines: async () => [], games: async () => [] };
  const fbsTeams = async () => [
    { id: 61, school: "Georgia", logos: ["http://a.espncdn.com/i/teamlogos/ncaa/500/61.png", "http://a.espncdn.com/i/teamlogos/ncaa/500-dark/61.png"] },
    { id: 333, school: "Alabama", logos: ["https://a.espncdn.com/i/teamlogos/ncaa/500/333.png"] },
    { id: 999, school: "Nowhere Tech", logos: ["https://a.espncdn.com/i/teamlogos/ncaa/500/999.png"] },
    { id: 2, school: "Auburn", logos: null },
  ];
  const logo = async (id) =>
    (await pool.query("select logo_url, logo_dark_url from teams where id = $1", [id])).rows[0];

  const dry = await syncSeason({ pool, cfbd: { ...base, fbsTeams }, season: 2026, dryRun: true, log: () => {} });
  assert.equal(dry.logosUpdated, 2);
  assert.deepEqual(await logo("UGA"), { logo_url: null, logo_dark_url: null });

  const r = await syncSeason({ pool, cfbd: { ...base, fbsTeams }, season: 2026, log: () => {} });
  assert.equal(r.logosUpdated, 2);
  assert.deepEqual(await logo("UGA"), {
    logo_url: "https://a.espncdn.com/i/teamlogos/ncaa/500/61.png",
    logo_dark_url: "https://a.espncdn.com/i/teamlogos/ncaa/500-dark/61.png",
  });
  assert.deepEqual(await logo("ALA"), { logo_url: "https://a.espncdn.com/i/teamlogos/ncaa/500/333.png", logo_dark_url: null });
  assert.deepEqual(await logo("AUB"), { logo_url: null, logo_dark_url: null });

  // Unchanged logos aren't rewritten; a failing call doesn't fail the run.
  assert.equal((await syncSeason({ pool, cfbd: { ...base, fbsTeams }, season: 2026, log: () => {} })).logosUpdated, 0);
  const logs = [];
  const failing = await syncSeason({
    pool,
    cfbd: { ...base, fbsTeams: async () => { throw new Error("CFBD /teams/fbs failed: 500"); } },
    season: 2026,
    log: (m) => logs.push(m),
  });
  assert.equal(failing.logosUpdated, 0);
  assert.ok(logs.some((m) => m.includes("logos not updated")));
});

test("title games and playoff games get added and priced; milestones pay shareholders once", { skip }, async () => {
  // A long-time UGA and OSU holder, and someone who bought OSU just now.
  const holder = "33333333-3333-3333-3333-333333333333";
  const latecomer = "44444444-4444-4444-4444-444444444444";
  await pool.query("insert into auth.users (id) values ($1), ($2)", [holder, latecomer]);
  await pool.query("insert into holdings (user_id, team_id, shares, avg_cost) values ($1, 'UGA', 10, 50), ($1, 'OSU', 4, 50)", [holder]);
  await pool.query("select execute_trade($1, 'OSU', 'buy', 5)", [latecomer]);
  const cash = async (id) => (await pool.query("select cash from users where id = $1", [id])).rows[0].cash;
  const [holderCash, lateCash] = [await cash(holder), await cash(latecomer)];

  const cfbd = {
    lines: async () => [],
    games: async () => [
      // Not in the seeded schedule; UGA and ALA also meet in week 6 (still open).
      { id: 1501, season: 2026, week: 15, completed: true, homeTeam: "Georgia", awayTeam: "Alabama",
        homePoints: 31, awayPoints: 24, homeConference: "SEC", awayConference: "SEC", notes: "SEC Championship" },
    ],
    postseasonGames: async () => [
      { id: 1601, season: 2026, week: 1, completed: false, homeTeam: "Georgia", awayTeam: "Ohio State",
        notes: "College Football Playoff Quarterfinal at the Rose Bowl", startDate: "2027-01-01T21:00:00.000Z" },
    ],
  };
  const r = await syncSeason({ pool, cfbd, season: 2026, log: () => {}, random: () => 0.5 });
  assert.equal(r.gamesAdded, 2);
  assert.equal(r.gamesApplied, 1);
  assert.equal(r.dividendsPaid, 3); // UGA title, UGA berth, OSU berth

  const { rows: added } = await pool.query(
    "select week, season_type, home_team_id, away_team_id, completed, notes from schedule where cfbd_game_id in (1501, 1601) order by cfbd_game_id"
  );
  assert.deepEqual(added, [
    { week: 15, season_type: "regular", home_team_id: "UGA", away_team_id: "ALA", completed: true, notes: "SEC Championship" },
    { week: 1, season_type: "postseason", home_team_id: "UGA", away_team_id: "OSU", completed: false,
      notes: "College Football Playoff Quarterfinal at the Rose Bowl" },
  ]);
  const { rows: week6 } = await pool.query(
    "select completed from schedule where season_type = 'regular' and week = 6 and 'UGA' in (home_team_id, away_team_id) and 'ALA' in (home_team_id, away_team_id)"
  );
  assert.deepEqual(week6, [{ completed: false }], "the title game didn't overwrite the regular-season meeting");

  const { rows: divs } = await pool.query("select team_id, kind, pct, per_share, shares_paid from dividends order by id");
  assert.deepEqual(divs.map((d) => [d.team_id, d.kind, d.pct]), [
    ["UGA", "conf_title", 8],
    ["UGA", "playoff_berth", 8],
    ["OSU", "playoff_berth", 8],
  ]);
  const osuBerth = divs[2];
  assert.equal(osuBerth.shares_paid, 4, "shares bought in the last 24 hours don't count");
  const expected = Math.round((holderCash + 10 * divs[0].per_share + 10 * divs[1].per_share + 4 * osuBerth.per_share) * 100) / 100;
  assert.equal(await cash(holder), expected);
  assert.equal(await cash(latecomer), lateCash);

  // Idempotent.
  const again = await syncSeason({ pool, cfbd, season: 2026, log: () => {} });
  assert.deepEqual([again.gamesAdded, again.gamesApplied, again.dividendsPaid], [0, 0, 0]);
  assert.equal(await cash(holder), expected);
});

test("recruiting: weekly snapshots in signing season; each moves teams by class rank change", { skip }, async () => {
  let calls = 0;
  let board = [];
  const cfbd = {
    lines: async () => [],
    games: async () => [],
    recruitingTeams: async (year) => (calls++, assert.equal(year, 2027), board),
  };
  const run = (date) => syncSeason({ pool, cfbd, season: 2026, now: new Date(date), log: () => {} });

  assert.equal((await run("2026-10-01T12:00:00Z")).recruitingMoves, 0);
  assert.equal(calls, 0, "no calls outside signing season");

  board = [{ team: "Alabama", rank: 1 }, { team: "Georgia", rank: 3 }, { team: "Texas", rank: 10 }];
  assert.equal((await run("2026-11-02T12:00:00Z")).recruitingMoves, 0); // baseline
  assert.equal((await run("2026-11-05T12:00:00Z")).recruitingMoves, 0);
  assert.equal(calls, 1, "no call within a week of the last snapshot");

  board = [{ team: "Georgia", rank: 1 }, { team: "Alabama", rank: 4 }, { team: "Texas", rank: 10 }];
  assert.equal((await run("2026-11-10T12:00:00Z")).recruitingMoves, 2);
  assert.deepEqual(
    (await moves("recruiting")).map((m) => [m.team_id, m.pct_change, m.summary]).sort(),
    [
      ["ALA", -0.45, "2027 recruiting class down 3 spots to No. 4"],
      ["UGA", 0.3, "2027 recruiting class up 2 spots to No. 1"],
    ]
  );
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

test("the news script posts a manual move, and validates its input", { skip }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${pool.databaseName}`;
  const env = { ...process.env, DATABASE_URL: url.toString(), DATABASE_CA_CERT: "", DATABASE_CA_CERT_FILE: "" };
  const script = new URL("../scripts/news.js", import.meta.url).pathname;
  const before = await fundamental("TCU");

  await assert.rejects(run("node", [script, "--team", "TCU", "--pct", "40", "--summary", "Too big a move"], { env }), /between -15 and 15/);
  const dry = await run("node", [script, "--team", "tcu", "--pct", "-5", "--summary", "Head coach leaves", "--dry-run"], { env });
  assert.match(dry.stdout, /\[dry run\] TCU/);
  assert.equal(await fundamental("TCU"), before);

  const out = await run("node", [script, "--team", "tcu", "--pct", "-5", "--summary", "Head coach leaves"], { env });
  assert.match(out.stdout, /^TCU -5%/);
  assert.ok(Math.abs((await fundamental("TCU")) - before * 0.95) < 0.0002);
  assert.deepEqual((await moves("news")).map((m) => [m.team_id, m.pct_change, m.summary]), [["TCU", -5, "Head coach leaves"]]);
});
