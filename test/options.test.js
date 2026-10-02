import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { TEST_DATABASE_URL, freshDatabase, createAuthUser } from "./helpers/db.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";

const skip = !TEST_DATABASE_URL && "TEST_DATABASE_URL not set";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

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

const q = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const newUser = async () => {
  const id = await createAuthUser(pool, randomUUID());
  await pool.query("insert into users (id) values ($1) on conflict do nothing", [id]);
  return id;
};
const cash = async (id) => (await q("select cash from users where id = $1", [id])).cash;
const setPrice = (id, price) =>
  pool.query("update teams set fundamental_price = $2, current_price = $2, hype = 0, live_pct = 0, live_status = null where id = $1", [id, price]);
const series = (team, kind, expiryKind = "weekly") =>
  all(
    "select id, strike from option_series where team_id = $1 and kind = $2 and expiry_kind = $3 and not settled order by strike",
    [team, kind, expiryKind]
  );
const trade = (user, seriesId, side, qty) => q("select execute_option_trade($1, $2, $3, $4) as r", [user, seriesId, side, qty]).then((r) => r.r);

test("weekly options expire Monday at noon Eastern, across daylight saving", { skip }, async () => {
  const at = async (ts) => (await q("select next_option_expiry($1)::text as t", [ts])).t;
  assert.equal(await at("2026-10-06T15:00:00Z"), "2026-10-12 16:00:00+00"); // Tue -> Mon noon EDT
  assert.equal(await at("2026-10-12T15:59:00Z"), "2026-10-12 16:00:00+00"); // Mon 11:59am -> same day
  assert.equal(await at("2026-10-12T16:00:00Z"), "2026-10-19 16:00:00+00"); // at noon -> next week
  assert.equal(await at("2026-11-04T15:00:00Z"), "2026-11-09 17:00:00+00"); // Mon noon EST
});

test("every team gets 5 weekly and 5 season strikes of calls and puts, near its price", { skip }, async () => {
  await setPrice("UGA", 50);
  const created = (await q("select ensure_option_series() as n")).n;
  assert.equal(created, 138 * 2 * 5 * 2);
  assert.equal((await q("select ensure_option_series() as n")).n, 0, "nothing new when strikes are near the price");
  assert.deepEqual((await series("UGA", "call")).map((s) => s.strike), [45, 47.5, 50, 52.5, 55]);
  assert.deepEqual((await series("UGA", "put", "season")).map((s) => s.strike), [40, 45, 50, 55, 60]);
  // A big move lists a fresh set around the new price.
  await setPrice("UGA", 60);
  assert.equal((await q("select ensure_option_series() as n")).n, 10); // weekly only: season 60 is still within 5%
  assert.ok((await series("UGA", "call")).some((s) => s.strike === 60));
  await setPrice("UGA", 50);
});

test("pricing: lower strikes cost more for calls, less for puts; put-call parity; a game this week costs more", { skip }, async () => {
  const quote = async (id) => q("select (option_quote($1)).*", [id]);
  const calls = await series("UGA", "call");
  const puts = await series("UGA", "put");
  const cq = await Promise.all(calls.map((s) => quote(s.id)));
  const pq = await Promise.all(puts.map((s) => quote(s.id)));
  for (let i = 1; i < cq.length; i++) {
    assert.ok(cq[i].fair <= cq[i - 1].fair, "call value falls as the strike rises");
    assert.ok(pq[i].fair >= pq[i - 1].fair, "put value rises with the strike");
  }
  for (let i = 0; i < cq.length; i++) {
    // C - P = S - K with no interest.
    assert.ok(Math.abs(cq[i].fair - pq[i].fair - (50 - calls[i].strike)) < 0.01, `parity at ${calls[i].strike}`);
    assert.ok(cq[i].ask > cq[i].fair && cq[i].bid <= cq[i].fair); // a $0 option buys back at $0
  }
  const atm = calls.find((s) => s.strike === 50).id;
  const before = await quote(atm);
  // Give UGA a game before this week's expiry.
  const { rows } = await pool.query(
    `update schedule set start_date = now() + interval '1 day'
      where id = (select id from schedule where not completed and 'UGA' in (home_team_id, away_team_id) order by week limit 1)
      returning id`
  );
  const withGame = await quote(atm);
  assert.equal(withGame.games_left, before.games_left + 1);
  assert.ok(withGame.fair > before.fair * 2, `${withGame.fair} vs ${before.fair}`);
  await pool.query("update schedule set start_date = null where id = $1", [rows[0].id]);
});

test("buy options, sell them back; round trip costs the spread; net worth counts them", { skip }, async () => {
  const user = await newUser();
  const atm = (await series("UGA", "call", "season")).find((s) => s.strike === 50).id;
  const quote = await q("select (option_quote($1)).*", [atm]);
  const buy = await trade(user, atm, "buy", 20);
  assert.equal(buy.price, quote.ask);
  assert.equal(buy.amount, Math.round(quote.ask * 20 * 100) / 100);
  assert.equal(await cash(user), Math.round((10000 - buy.amount) * 100) / 100);
  assert.deepEqual(buy.position, { qty: 20, avg_cost: quote.ask });

  const nw = await q("select options_value, net_worth from user_net_worth where user_id = $1", [user]);
  assert.equal(nw.options_value, Math.round(quote.bid * 20 * 100) / 100);
  assert.ok(nw.net_worth < 10000, "valued at the buy-back price");

  await assert.rejects(trade(user, atm, "sell", 21), /insufficient_options/);
  const sell = await trade(user, atm, "sell", 20);
  assert.equal(sell.price, quote.bid);
  assert.equal(sell.position, null);
  assert.ok((await cash(user)) < 10000);
  assert.equal((await all("select side from option_trades where user_id = $1 order by id", [user])).map((r) => r.side).join(), "buy,sell");
});

test("limits: 25% of net worth in options, 1,000 options per team, 1,000 shares per team", { skip }, async () => {
  const user = await newUser();
  const atm = (await series("UGA", "call", "season")).find((s) => s.strike === 50).id;
  const ask = (await q("select (option_quote($1)).ask", [atm])).ask;
  const affordable = Math.floor(2500 / ask);
  await assert.rejects(trade(user, atm, "buy", affordable + 5), /options_limit/);
  await trade(user, atm, "buy", Math.min(affordable - 5, 900));

  // 1,000 options per team, across all of the team's series.
  await setPrice("NMSU", 4);
  // A cheap, far out-of-the-money put (listed here: automatic strikes depend on the seed price).
  const cheap = (
    await q(
      `insert into option_series (team_id, kind, strike, expiry_kind, season, expires_at)
       values ('NMSU', 'put', 3.5, 'weekly', 2026, next_option_expiry(now())) returning id`
    )
  ).id;
  const rich = await newUser();
  await pool.query("update users set cash = 1000000 where id = $1", [rich]);
  await trade(rich, cheap, "buy", 1000);
  await assert.rejects(trade(rich, cheap, "buy", 1), /position_limit/);

  // 1,000 shares of one team.
  await pool.query("select execute_trade($1, 'NMSU', 'buy', 1000)", [rich]);
  await assert.rejects(pool.query("select execute_trade($1, 'NMSU', 'buy', 1)", [rich]), /position_limit/);
  await pool.query("select execute_trade($1, 'NMSU', 'sell', 10)", [rich]); // selling down is always fine
});

test("a team's options pause during its game and reopen after the final", { skip }, async () => {
  const user = await newUser();
  const id = (await series("TEX", "call"))[2].id;
  await pool.query("update teams set live_status = 'Q2 3:00 · TEX 7, OU 3' where id = 'TEX'");
  assert.equal((await q("select (option_quote($1)).paused", [id])).paused, true);
  await assert.rejects(trade(user, id, "buy", 1), /options_paused/);
  // Also paused from kickoff even before the first live update.
  await pool.query("update teams set live_status = null where id = 'TEX'");
  const { rows } = await pool.query(
    `update schedule set start_date = now() - interval '10 minutes'
      where id = (select id from schedule where not completed and 'TEX' in (home_team_id, away_team_id) order by week limit 1)
      returning id`
  );
  await assert.rejects(trade(user, id, "buy", 1), /options_paused/);
  await pool.query("update schedule set completed = true where id = $1", [rows[0].id]);
  assert.equal((await trade(user, id, "buy", 1)).qty, 1, "open again after the final");
});

test("expired options settle in cash on the football price, then fresh ones are listed", { skip }, async () => {
  const user = await newUser();
  await setPrice("LSU", 40);
  // Our own $38 call and put: the automatic listing's strikes depend on the
  // seed price, which varies from run to run.
  const listed = async (kind) =>
    (
      await q(
        `insert into option_series (team_id, kind, strike, expiry_kind, season, expires_at)
         values ('LSU', $1, 38, 'weekly', 2026, next_option_expiry(now())) returning id`,
        [kind]
      )
    ).id;
  const call38 = await listed("call");
  const put38 = await listed("put");
  await trade(user, call38, "buy", 10);
  await trade(user, put38, "buy", 10);
  const cashBefore = await cash(user);

  // Trading hype doesn't count: settlement uses the football price ($44).
  await pool.query("update teams set fundamental_price = 44, hype = 0.1, current_price = 48.4 where id = 'LSU'");
  await pool.query("update option_series set expires_at = now() - interval '1 minute' where id in ($1, $2)", [call38, put38]);
  assert.equal((await q("select settle_options() as n")).n, 2);
  assert.equal(await cash(user), Math.round((cashBefore + 10 * 6) * 100) / 100); // call pays 44 - 38; put pays 0
  assert.deepEqual(await all("select series_id from option_positions where user_id = $1", [user]), []);
  const settled = await q("select settled, settle_price from option_series where id = $1", [call38]);
  assert.deepEqual(settled, { settled: true, settle_price: 44 });
  const payouts = await all(
    "select series_id, qty, price, amount from option_trades where user_id = $1 and side = 'settle' order by series_id",
    [user]
  );
  assert.deepEqual(payouts, [
    { series_id: call38, qty: 10, price: 6, amount: 60 },
    { series_id: put38, qty: 10, price: 0, amount: 0 }, // expired worthless, still on record
  ]);
  await assert.rejects(trade(user, call38, "buy", 1), /option_expired/);
  assert.equal((await q("select settle_options() as n")).n, 0);
});

test("season options settle the Monday after the national title game is paid", { skip }, async () => {
  const user = await newUser();
  await setPrice("OSU", 60);
  const s = (await series("OSU", "call", "season"))[0].id;
  await trade(user, s, "buy", 1);
  await pool.query("select settle_options()");
  assert.equal((await q("select expires_at from option_series where id = $1", [s])).expires_at, null);
  await pool.query(
    "insert into dividends (team_id, season, kind, pct, per_share, shares_paid, total_paid, summary, paid_at) values ('OSU', 2026, 'national_title', 20, 12, 0, 0, 'x', now() - interval '8 days')"
  );
  await pool.query("select settle_options()");
  const row = await q("select settled from option_series where id = $1", [s]);
  assert.equal(row.settled, true, "the Monday noon after the title game has passed, so it settled");
  // No new season series once the season is over.
  const before = (await all("select count(*)::int as n from option_series where expiry_kind = 'season' and not settled"))[0].n;
  await setPrice("OSU", 90);
  await pool.query("select ensure_option_series()");
  assert.equal((await all("select count(*)::int as n from option_series where expiry_kind = 'season' and not settled"))[0].n, before);
});
