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
  await pool.query("update teams set current_price = $2 where id = $1", [id, price]);
}

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

test("buy then sell uses the server price and keeps books consistent", { skip }, async () => {
  const id = await newUser();
  await setPrice("UGA", 50);

  const buy1 = await store.executeTrade(id, "UGA", "buy", 10);
  assert.equal(buy1.price, 50);
  assert.equal(buy1.cash, 9500);
  assert.deepEqual(buy1.holding, { shares: 10, avg_cost: 50 });

  await setPrice("UGA", 60);
  const buy2 = await store.executeTrade(id, "UGA", "buy", 10);
  assert.equal(buy2.cash, 8900);
  assert.deepEqual(buy2.holding, { shares: 20, avg_cost: 55 });

  const sell1 = await store.executeTrade(id, "UGA", "sell", 5);
  assert.equal(sell1.cash, 9200);
  assert.deepEqual(sell1.holding, { shares: 15, avg_cost: 55 });

  const sell2 = await store.executeTrade(id, "UGA", "sell", 15);
  assert.equal(sell2.cash, 10100);
  assert.equal(sell2.holding, null);
  assert.deepEqual(await store.getHoldings(id), []);

  const txs = await store.listTransactions(id);
  assert.deepEqual(
    txs.map((t) => [t.side, t.shares, t.price]),
    [
      ["sell", 15, 60],
      ["sell", 5, 60],
      ["buy", 10, 60],
      ["buy", 10, 50],
    ]
  );

  // Replaying the ledger reproduces cash.
  const replayed = txs.reduce((c, t) => c + (t.side === "buy" ? -1 : 1) * t.shares * t.price, 10000);
  assert.equal(replayed, (await store.getAccount(id)).cash);
});

test("trades are rejected for insufficient funds or shares, with no side effects", { skip }, async () => {
  const id = await newUser();
  await setPrice("OSU", 100);
  await assert.rejects(store.executeTrade(id, "OSU", "buy", 101), /insufficient_funds/);
  await assert.rejects(store.executeTrade(id, "OSU", "sell", 1), /insufficient_shares/);
  await store.executeTrade(id, "OSU", "buy", 2);
  await assert.rejects(store.executeTrade(id, "OSU", "sell", 3), /insufficient_shares/);
  await assert.rejects(store.executeTrade(id, "NOPE", "buy", 1), /unknown_team/);
  await assert.rejects(store.executeTrade(id, "OSU", "hold", 1), /invalid_side/);
  await assert.rejects(store.executeTrade(id, "OSU", "buy", 0), /invalid_shares/);
  const acct = await store.getAccount(id);
  assert.equal(acct.cash, 9800);
  assert.equal((await store.listTransactions(id)).length, 1);
});

test("concurrent buys cannot overdraw an account", { skip }, async () => {
  const id = await newUser();
  await setPrice("ALA", 1000);
  // Each buy costs $3,000; only three fit in $10,000.
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => store.executeTrade(id, "ALA", "buy", 3))
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  const acct = await store.getAccount(id);
  assert.equal(acct.cash, 1000);
  const [h] = await store.getHoldings(id);
  assert.equal(h.shares, 9);
});

test("transactions are append-only", { skip }, async () => {
  const id = await newUser();
  await store.executeTrade(id, "TEX", "buy", 1);
  await assert.rejects(pool.query("update transactions set price = 0 where user_id = $1", [id]), /append-only/);
  await assert.rejects(pool.query("delete from transactions where user_id = $1", [id]), /append-only/);
});

test("anon and authenticated roles cannot call the write functions", { skip }, async () => {
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
    }
  } finally {
    client.release();
  }
});

test("apply_game_result is atomic, idempotent and rejects stale prices", { skip }, async () => {
  const {
    rows: [game],
  } = await pool.query("select * from schedule where not completed order by week, id limit 1");
  const teams = await Promise.all([store.getTeam(game.home_team_id), store.getTeam(game.away_team_id)]);
  const payload = (prevPrices) =>
    teams.map((t, i) => ({
      id: t.id,
      prev_price: prevPrices[i],
      current_price: t.current_price + 1,
      last_change_pct: 1,
      last_covered: i === 0,
      last_expected: 0,
      last_actual: i === 0 ? 7 : -7,
      last_line_is_real: false,
    }));
  const events = teams.map((t, i) => ({
    team_id: t.id,
    opponent_id: teams[1 - i].id,
    team_score: i === 0 ? 28 : 21,
    opp_score: i === 0 ? 21 : 28,
    pct_change: 1,
    price_after: t.current_price + 1,
    expected_margin: 0,
    actual_margin: i === 0 ? 7 : -7,
    is_real_line: false,
    summary: "test",
  }));
  const apply = (prev) =>
    pool.query("select apply_game_result($1, 28, 21, 999, $2, $3) as applied", [
      game.id,
      JSON.stringify(payload(prev)),
      JSON.stringify(events),
    ]);

  await assert.rejects(apply([0, 0]), /stale_price/);
  const { rows: stillOpen } = await pool.query("select completed from schedule where id = $1", [game.id]);
  assert.equal(stillOpen[0].completed, false);

  const prev = teams.map((t) => t.current_price);
  assert.equal((await apply(prev)).rows[0].applied, true);
  assert.equal((await apply(prev)).rows[0].applied, false);

  const after = await store.getTeam(teams[0].id);
  assert.equal(after.current_price, teams[0].current_price + 1);
  const { rows } = await pool.query("select * from schedule where id = $1", [game.id]);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].cfbd_game_id, 999);
});
