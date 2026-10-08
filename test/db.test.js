import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { TEST_DATABASE_URL, freshDatabase, createAuthUser } from "./helpers/db.js";
import { createStore } from "../src/db/store.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";

const skip = !TEST_DATABASE_URL && "TEST_DATABASE_URL not set";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

let pool, store;

before(async () => {
  if (skip) return;
  pool = await freshDatabase();
  store = createStore(pool);
  const seed = buildSeed({
    teams: read("teams.json"),
    results: read("results-2026.json"),
    schedule: read("schedule-2026.json"),
    season: 2026,
  });
  await writeSeed(pool, seed);
});

after(async () => {
  if (pool) await pool.dropDatabase();
});

async function newUser() {
  return createAuthUser(pool, randomUUID());
}

async function setPrice(id, price) {
  await pool.query(
    "update teams set fundamental_price = $2, current_price = $2, hype = 0, hype_updated_at = now(), live_pct = 0 where id = $1",
    [id, price]
  );
}

const q = async (sql, params) => (await pool.query(sql, params)).rows[0];

test("seed loads teams, schedule and price history", { skip }, async () => {
  const teams = await store.listTeams();
  assert.equal(teams.length, 138);
  const { rows } = await pool.query("select count(*)::int as n from price_events");
  assert.equal(rows[0].n, read("results-2026.json").length * 2);
  await assert.rejects(writeSeed(pool, { teams: [], schedule: [], events: [] }), /refusing to re-seed/);
});

test("signing up creates an account with $10,000", { skip }, async () => {
  const id = await newUser();
  const acct = await store.getAccount(id);
  assert.equal(acct.cash, 10000);
  assert.equal(acct.net_worth, 10000);
});

test("trade_fill: orders walk the price along the curve, capped, plus the spread", { skip }, async () => {
  const fill = (base, hype, side, shares, depth) =>
    q("select amount, hype_after from trade_fill($1, $2, $3, $4, $5)", [base, hype, side, shares, depth]);
  // $50, no hype, $200k depth: 100 shares move hype 2.5%, filling at the
  // midpoint ($50.625), plus 0.25%.
  assert.deepEqual(await fill(50, 0, "buy", 100, 200000), { amount: 5075.16, hype_after: 0.025 });
  // Selling them straight back returns hype to 0; the round trip costs the spread.
  assert.deepEqual(await fill(50, 0.025, "sell", 100, 200000), { amount: 5049.84, hype_after: 0 });
  // 1,000 shares would push hype 25%: 600 fill on the curve up to the 15% cap,
  // the other 400 flat at the capped price.
  assert.deepEqual(await fill(50, 0, "buy", 1000, 200000), { amount: 55388.13, hype_after: 0.15 });
  assert.deepEqual(await fill(50, -0.15, "sell", 10, 200000), { amount: 423.94, hype_after: -0.15 });
  // Fills never go under the $3 floor.
  assert.deepEqual(await fill(3, -0.15, "sell", 10, 200000), { amount: 29.93, hype_after: -0.15 });
});

test("buy then sell moves the price and keeps books consistent", { skip }, async () => {
  const id = await newUser();
  await setPrice("UGA", 50);

  const quote = await store.quoteTrade("UGA", "buy", 10);
  const buy = await store.executeTrade(id, "UGA", "buy", 10);
  assert.equal(buy.amount, quote.amount);
  assert.equal(buy.price_after, quote.price_after);
  assert.ok(buy.price > 50 && buy.price < 50.5, `${buy.price}`);
  assert.equal(buy.cash, Math.round((10000 - buy.amount) * 100) / 100);
  assert.deepEqual(buy.holding, { shares: 10, avg_cost: Math.round((buy.amount / 10) * 100) / 100 });
  const team = await store.getTeam("UGA");
  assert.equal(team.current_price, buy.price_after);
  assert.ok(team.current_price > 50);

  const sell = await store.executeTrade(id, "UGA", "sell", 10);
  assert.equal(sell.holding, null);
  assert.equal((await store.getTeam("UGA")).current_price, 50, "selling it all back returns the price");
  const acct = await store.getAccount(id);
  assert.ok(acct.cash < 10000 && acct.cash > 9997, `round trip costs only the spread: ${acct.cash}`);

  // Replaying the ledger's exact amounts reproduces cash.
  const txs = await store.listTransactions(id);
  const replayed = txs.reduce((c, t) => c + (t.side === "buy" ? -1 : 1) * t.amount, 10000);
  assert.equal(Math.round(replayed * 100) / 100, acct.cash);
});

test("hype fades: half every day, and to zero when tiny", { skip }, async () => {
  await setPrice("LSU", 40);
  await pool.query("update teams set hype = 0.1, hype_updated_at = now() - interval '24 hours' where id = 'LSU'");
  await pool.query("update teams set hype = 0.0004, hype_updated_at = now() - interval '1 hour' where id = 'OU'");
  await pool.query("select decay_hype()");
  assert.deepEqual(await q("select hype, current_price from teams where id = 'LSU'"), { hype: 0.05, current_price: 42 });
  assert.equal((await q("select hype from teams where id = 'OU'")).hype, 0);
});

test("news moves apply to the price underneath the hype, once", { skip }, async () => {
  await setPrice("MICH", 40);
  await pool.query("update teams set hype = 0.1, current_price = 44 where id = 'MICH'");
  const apply = () =>
    q("select apply_news_move('MICH', 2026, 5, 'line', 'test-1', 5, 'line moved') as applied");
  assert.equal((await apply()).applied, true);
  assert.equal((await apply()).applied, false);
  const t = await q("select fundamental_price, current_price from teams where id = 'MICH'");
  assert.equal(t.fundamental_price, 42);
  assert.ok(Math.abs(t.current_price - 46.2) < 0.02, `${t.current_price}`);
  const move = await q("select pct_change, price_after, summary from market_moves where ref = 'test-1'");
  assert.deepEqual(move, { pct_change: 5, price_after: t.current_price, summary: "line moved" });
});

test("trades are rejected for insufficient funds or shares, with no side effects", { skip }, async () => {
  const id = await newUser();
  await setPrice("OSU", 100);
  await assert.rejects(store.executeTrade(id, "OSU", "buy", 100), /insufficient_funds/);
  await assert.rejects(store.executeTrade(id, "OSU", "sell", 1), /insufficient_shares/);
  const buy = await store.executeTrade(id, "OSU", "buy", 2);
  await assert.rejects(store.executeTrade(id, "OSU", "sell", 3), /insufficient_shares/);
  await assert.rejects(store.executeTrade(id, "NOPE", "buy", 1), /unknown_team/);
  await assert.rejects(store.executeTrade(id, "OSU", "hold", 1), /invalid_side/);
  await assert.rejects(store.executeTrade(id, "OSU", "buy", 0), /invalid_shares/);
  const acct = await store.getAccount(id);
  assert.equal(acct.cash, Math.round((10000 - buy.amount) * 100) / 100);
  assert.equal((await store.listTransactions(id)).length, 1);
  assert.equal((await store.getTeam("OSU")).current_price, buy.price_after, "rejected orders don't move the price");
});

test("concurrent buys cannot overdraw an account", { skip }, async () => {
  const id = await newUser();
  await setPrice("ALA", 1000);
  // Each buy costs a bit over $3,000 (and more as the price rises); only
  // three fit in $10,000.
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => store.executeTrade(id, "ALA", "buy", 3))
  );
  const filled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  assert.equal(filled.length, 3);
  const acct = await store.getAccount(id);
  const spent = filled.reduce((sum, r) => sum + r.amount, 0);
  assert.equal(acct.cash, Math.round((10000 - spent) * 100) / 100);
  assert.ok(acct.cash >= 0);
  const [h] = await store.getHoldings(id);
  assert.equal(h.shares, 9);
});

test("transactions are append-only", { skip }, async () => {
  const id = await newUser();
  await store.executeTrade(id, "TEX", "buy", 1);
  await assert.rejects(pool.query("update transactions set price = 0 where user_id = $1", [id]), /append-only/);
  await assert.rejects(pool.query("delete from transactions where user_id = $1", [id]), /append-only/);
});

test("anon and authenticated roles cannot call write functions or read other players", { skip }, async () => {
  const client = await pool.connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      await assert.rejects(
        client.query("select execute_trade($1, 'UGA', 'buy', 1)", [randomUUID()]),
        /permission denied/
      );
      await client.query("rollback");
      for (const sql of ["select * from leaderboard", "select * from user_net_worth"]) {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        await assert.rejects(client.query(sql), /permission denied/, `${role}: ${sql}`);
        await client.query("rollback");
      }
    }
  } finally {
    client.release();
  }
});

test("apply_game_result is atomic, idempotent and applies moves to the current price", { skip }, async () => {
  const {
    rows: [game],
  } = await pool.query("select * from schedule where not completed order by week, id limit 1");
  const [homeId, awayId] = [game.home_team_id, game.away_team_id];
  await setPrice(homeId, 40);
  await setPrice(awayId, 20);
  // A trade and a live in-game move land after the job read the prices; the
  // result still applies cleanly, and the live move is cleared.
  await pool.query("update teams set hype = 0.05, live_pct = 3, current_price = market_price(20, 0.05, 3) where id = $1", [awayId]);
  const teams = [homeId, awayId].map((id, i) => ({
    id,
    pct: i === 0 ? 10 : -10,
    last_covered: i === 0,
    last_expected: 0,
    last_actual: i === 0 ? 7 : -7,
    last_line_is_real: false,
  }));
  const events = [homeId, awayId].map((id, i) => ({
    team_id: id,
    opponent_id: i === 0 ? awayId : homeId,
    team_score: i === 0 ? 28 : 21,
    opp_score: i === 0 ? 21 : 28,
    expected_margin: 0,
    actual_margin: i === 0 ? 7 : -7,
    is_real_line: false,
    summary: "test",
  }));
  const apply = (teamsJson) =>
    pool.query("select apply_game_result($1, 28, 21, 999, $2, $3) as applied", [
      game.id,
      JSON.stringify(teamsJson),
      JSON.stringify(events),
    ]);

  // Atomic: an unknown team fails the whole thing.
  await assert.rejects(apply([{ ...teams[0], id: "NOPE" }, teams[1]]), /unknown_team/);
  const { rows: stillOpen } = await pool.query("select completed from schedule where id = $1", [game.id]);
  assert.equal(stillOpen[0].completed, false);

  assert.equal((await apply(teams)).rows[0].applied, true);
  assert.equal((await apply(teams)).rows[0].applied, false);

  const home = await q("select fundamental_price, current_price, last_change_pct from teams where id = $1", [homeId]);
  assert.deepEqual(home, { fundamental_price: 44, current_price: 44, last_change_pct: 10 });
  const away = await q("select fundamental_price, hype, live_pct, current_price from teams where id = $1", [awayId]);
  assert.equal(away.fundamental_price, 18);
  assert.equal(away.live_pct, 0);
  assert.ok(Math.abs(away.current_price - 18 * (1 + away.hype)) < 0.01);
  const ev = await q("select pct_change, price_after from price_events where schedule_id = $1 and team_id = $2", [game.id, homeId]);
  assert.deepEqual(ev, { pct_change: 10, price_after: 44 });
  const { rows } = await pool.query("select * from schedule where id = $1", [game.id]);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].cfbd_game_id, 999);
});

test("portfolio returns: saved daily values, rebuilt history, and players who joined mid-period", { skip }, async () => {
  const id = await newUser();
  await setPrice("UGA", 60);
  await pool.query("update users set created_at = now() - interval '40 days', cash = 9480 where id = $1", [id]);
  // Bought 10 at $52 twenty days ago; a news move took UGA to $55 five days ago.
  await pool.query(
    `insert into transactions (user_id, team_id, side, shares, price, amount, created_at)
     values ($1, 'UGA', 'buy', 10, 52, 520, now() - interval '20 days')`,
    [id]
  );
  await pool.query("insert into holdings (user_id, team_id, shares, avg_cost) values ($1, 'UGA', 10, 52)", [id]);
  await pool.query(
    `insert into market_moves (team_id, season, kind, ref, pct_change, price_after, summary, created_at)
     values ('UGA', 2026, 'news', 'test-nw', 5, 55, 'test', now() - interval '5 days')`
  );

  assert.equal((await q("select net_worth_at($1, now() - interval '30 days') as v", [id])).v, 10000);
  assert.equal((await q("select net_worth_at($1, now() - interval '10 days') as v", [id])).v, 10000);
  assert.equal((await q("select net_worth_at($1, now() - interval '1 day') as v", [id])).v, 10030);

  // A saved value wins over the rebuilt estimate.
  await pool.query(
    `insert into net_worth_history (user_id, day, net_worth)
     values ($1, (now() at time zone 'America/New_York')::date - 7, 9800)`,
    [id]
  );
  const now = (await q("select net_worth from user_net_worth where user_id = $1", [id])).net_worth;
  const rows = await store.getReturns(id);
  assert.deepEqual(rows.map((r) => r.period), ["week", "month", "3months", "season", "ytd", "all"]);
  const by = Object.fromEntries(rows.map((r) => [r.period, r]));
  assert.equal(by.week.start_value, 9800);
  assert.equal(by.week.joined, false);
  assert.equal(by.week.gain, Math.round((now - 9800) * 100) / 100);
  assert.equal(by.week.gain_pct, Math.round(((now - 9800) / 9800) * 10000) / 100);
  assert.equal(by.month.start_value, 10000);
  assert.equal(by.month.joined, false);
  for (const p of ["3months", "ytd", "all"]) {
    assert.equal(by[p].joined, true, p);
    assert.equal(by[p].start_value, 10000, p);
    assert.equal(by[p].gain, Math.round((now - 10000) * 100) / 100, p);
  }
  assert.match(by.week.since, /^\d{4}-\d{2}-\d{2}$/);
  const joinedOn = (await q("select to_char((created_at at time zone 'America/New_York')::date, 'YYYY-MM-DD') as d from users where id = $1", [id])).d;
  assert.equal(by.all.since, joinedOn);
  assert.equal(by.ytd.since, joinedOn, "joined mid-period: measured from the day they joined");
  assert.notEqual(by.month.since, joinedOn);

  // Today's value is saved for every player.
  await pool.query("select record_net_worth()");
  const today = await q(
    "select net_worth from net_worth_history where user_id = $1 and day = (now() at time zone 'America/New_York')::date",
    [id]
  );
  assert.equal(today.net_worth, Math.round(now * 100) / 100);
});

test("this season starts at Week 0, even when early kickoff times weren't saved", { skip }, async () => {
  const day = async () => (await q("select to_char(season_start_day(2026), 'YYYY-MM-DD') as d")).d;
  // Only a later game has a kickoff time: fall back to the last Saturday of August.
  await pool.query("update schedule set start_date = null where season = 2026");
  await pool.query(
    "update schedule set start_date = '2026-10-02T23:00:00Z' where id = (select max(id) from schedule where season = 2026 and season_type = 'regular')"
  );
  assert.equal(await day(), "2026-08-29");
  assert.equal((await q("select to_char(season_start_day(2027), 'YYYY-MM-DD') as d")).d, "2027-08-28");
  // A known first-week kickoff wins (7pm ET on Aug 28).
  await pool.query(
    `update schedule set start_date = '2026-08-28T23:00:00Z'
      where id = (select min(id) from schedule where season = 2026 and season_type = 'regular'
                    and week = (select min(week) from schedule where season = 2026 and season_type = 'regular'))`
  );
  assert.equal(await day(), "2026-08-28");
  await pool.query("update schedule set start_date = null where season = 2026");
});
