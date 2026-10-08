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
  await writeSeed(
    pool,
    buildSeed({ teams: read("teams.json"), results: read("results-2026.json"), schedule: read("schedule-2026.json"), season: 2026 })
  );
});
after(async () => {
  if (pool) await pool.dropDatabase();
});

const q = async (sql, params) => (await pool.query(sql, params)).rows;
let n = 0;
async function player(name) {
  const id = await createAuthUser(pool, randomUUID());
  await store.getAccount(id);
  if (name !== null) await store.setDisplayName(id, name || `Fund ${++n}`);
  return id;
}
// A public competition starting in an hour, ending in a week.
async function upcoming(code, minTrades = 0) {
  await q(
    `insert into competitions (code, kind, name, starts_at, ends_at, min_trades)
     values ($1, 'event', $1, now() + interval '1 hour', now() + interval '7 days', $2)`,
    [code, minTrades]
  );
  return (await q("select id from competitions where code = $1", [code]))[0].id;
}
const startNow = (code) => q("update competitions set starts_at = now() - interval '1 second' where code = $1", [code]);
const endNow = (code) =>
  q("update competitions set starts_at = now() - interval '2 days', ends_at = now() where code = $1", [code]);

test("public competitions: join before the start, ranked by percent return, trade minimum, settled at the end", { skip }, async () => {
  const id = await upcoming("rivalry", 1);
  const a = await player("Alpha Fund");
  const b = await player("Bravo Fund");
  const c = await player("Charlie Fund");
  const nameless = await player(null);
  for (const u of [a, b, c]) await q("select join_competition($1, 'rivalry')", [u]);
  await assert.rejects(q("select join_competition($1, 'rivalry')", [nameless]), /display_name_required/);
  await assert.rejects(q("select join_competition($1, 'nope')", [a]), /unknown_competition/);
  await q("select join_competition($1, 'rivalry')", [a]); // joining twice is harmless

  // Before the start: the entry list, unranked.
  let s = await q("select * from competition_standings($1)", [id]);
  assert.equal(s.length, 3);
  assert.ok(s.every((r) => r.rank === null && r.return_pct === null));

  await startNow("rivalry");
  await q("select run_competitions()");
  const late = await player("Late Fund");
  await assert.rejects(q("select join_competition($1, 'rivalry')", [late]), /competition_closed/);
  await assert.rejects(q("select leave_competition($1, 'rivalry')", [a]), /competition_closed/);
  const starts = await q("select user_id, start_value from competition_entries where competition_id = $1", [id]);
  assert.ok(starts.every((r) => r.start_value === 10000));

  // A buys and gets a price rise; B buys too; C doesn't trade.
  await store.executeTrade(a, "TEX", "buy", 100);
  await store.executeTrade(b, "UGA", "buy", 10);
  await q("select move_price('TEX', 20, false)");
  s = await q("select * from competition_standings($1)", [id]);
  assert.deepEqual(s.map((r) => r.display_name), ["Alpha Fund", "Bravo Fund", "Charlie Fund"]);
  assert.deepEqual(s.map((r) => r.rank), [1, 2, null]);
  assert.equal(s[0].trades, 1);
  assert.equal(s[2].qualified, false, "no trades: listed, not ranked");
  assert.ok(s[0].return_pct > 0);
  const nw = (await q("select net_worth from user_net_worth where user_id = $1", [a]))[0].net_worth;
  assert.equal(s[0].return_pct, Math.round(((nw - 10000) / 10000) * 10000) / 100);

  await endNow("rivalry");
  await q("select run_competitions()");
  const [done] = await q("select finished from competitions where id = $1", [id]);
  assert.equal(done.finished, true);
  const finals = await q("select user_id, final_rank, final_value from competition_entries where competition_id = $1", [id]);
  assert.equal(finals.find((r) => r.user_id === a).final_rank, 1);
  assert.equal(finals.find((r) => r.user_id === c).final_rank, null);
  // Later price moves don't change a finished competition.
  const before = (await q("select * from competition_standings($1)", [id]))[0].return_pct;
  await q("select move_price('TEX', 30, false)");
  assert.equal((await q("select * from competition_standings($1)", [id]))[0].return_pct, before);
});

test("leaving before the start", { skip }, async () => {
  const id = await upcoming("leave-me");
  const a = await player();
  await q("select join_competition($1, 'leave-me')", [a]);
  assert.equal((await q("select leave_competition($1, 'leave-me') as left", [a]))[0].left, true);
  assert.equal((await q("select count(*)::int as n from competition_entries where competition_id = $1", [id]))[0].n, 0);
});

test("private leagues: start now, members join any time and are scored from joining", { skip }, async () => {
  const owner = await player("League Boss");
  const { code } = (await q("select create_league($1, '  Saturday   Crew ', 'season') as r", [owner]))[0].r;
  const [league] = await q("select * from competitions where code = $1", [code]);
  assert.equal(league.name, "Saturday Crew");
  assert.equal(league.is_private, true);
  assert.equal(league.kind, "league");
  assert.equal(league.started, true);

  await store.executeTrade(owner, "OSU", "buy", 20);
  const friend = await player("Friend Fund");
  await store.executeTrade(friend, "UGA", "buy", 10); // before joining: not counted
  await q("select join_competition($1, $2)", [friend, code]);
  const [entry] = await q("select start_value, scored_from from competition_entries where user_id = $1", [friend]);
  const nw = (await q("select net_worth from user_net_worth where user_id = $1", [friend]))[0].net_worth;
  assert.equal(entry.start_value, Math.round(nw * 100) / 100);
  const s = await q("select * from competition_standings($1)", [league.id]);
  assert.equal(s.find((r) => r.display_name === "Friend Fund").trades, 0);
  assert.equal(s.find((r) => r.display_name === "Friend Fund").qualified, true, "leagues have no trade minimum");

  // Members can leave a league any time.
  assert.equal((await q("select leave_competition($1, $2) as left", [friend, code]))[0].left, true);

  await assert.rejects(q("select create_league($1, 'ab', 'week')", [owner]), /invalid_league_name/);
  await assert.rejects(q("select create_league($1, 'Good Name', 'forever')", [owner]), /invalid_league_length/);
  const nameless = await player(null);
  await assert.rejects(q("select create_league($1, 'Good Name', 'week')", [nameless]), /display_name_required/);
  for (let i = 0; i < 4; i++) await q("select create_league($1, $2, 'week')", [owner, `League ${i}`]);
  await assert.rejects(q("select create_league($1, 'One Too Many', 'week')", [owner]), /league_limit/);
});

test("upcoming public competitions are listed automatically", { skip }, async () => {
  // Games in the next two Thursday-to-Sunday windows and next month.
  await q(`update schedule set start_date = null`);
  const ids = (await q("select id from schedule where season = 2026 and not completed order by id limit 3")).map((r) => r.id);
  await q(
    `with w as (select date_trunc('week', (now() at time zone 'America/New_York')::date)::date + 3 as thu)
     update schedule s set start_date = x.at
       from (select $1::bigint as id, ((select thu from w) + 7 + time '19:30') at time zone 'America/New_York' as at
             union all
             select $2::bigint, ((select thu from w) + 9 + time '15:30') at time zone 'America/New_York'
             union all
             select $3::bigint, ((date_trunc('month', now() at time zone 'America/New_York') + interval '1 month')::date + 10 + time '15:30')
                                at time zone 'America/New_York') x
      where s.id = x.id`,
    ids
  );
  await q("select ensure_competitions()");
  const rows = await q("select code, kind, name, min_trades, starts_at, ends_at from competitions where kind in ('week', 'month', 'season') order by starts_at");
  const week = rows.find((r) => r.kind === "week");
  assert.ok(week, "next week's sprint");
  assert.match(week.name, /^Week \d+ Sprint$/);
  assert.equal(week.ends_at - week.starts_at, 3 * 24 * 3600 * 1000);
  const etHour = (d) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d));
  assert.equal(etHour(week.starts_at), 12);
  const season = rows.find((r) => r.kind === "season");
  assert.equal(season?.code, "season-2026");
  assert.equal(season.min_trades, 10);
  assert.equal(week.min_trades, 3);
  const monthly = rows.find((r) => r.kind === "month");
  if (monthly) assert.equal(monthly.min_trades, 5);
  const month = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getMonth() + 1; // this month
  if ([8, 9, 10, 11, 12].includes(month)) assert.ok(rows.some((r) => r.kind === "month"), "next month's monthly");
  // Running again doesn't duplicate.
  const count = rows.length;
  await q("select ensure_competitions()");
  assert.equal((await q("select count(*)::int as n from competitions where kind in ('week', 'month', 'season')"))[0].n, count);
});

test("fund card: realized gains against average cost, win rate, drawdown, favorite team", { skip }, async () => {
  const id = await player("Stats Fund");
  await store.executeTrade(id, "ALA", "buy", 10);
  await q("select move_price('ALA', 10, false)");
  await store.executeTrade(id, "ALA", "sell", 10); // a winner
  await store.executeTrade(id, "ALA", "buy", 5);
  await store.executeTrade(id, "UGA", "buy", 5);
  await q("select move_price('UGA', -10, false)");
  await store.executeTrade(id, "UGA", "sell", 5); // a loser
  await q(
    `insert into net_worth_history (user_id, day, net_worth) values
       ($1, current_date - 3, 10000), ($1, current_date - 2, 12000), ($1, current_date - 1, 9000)`,
    [id]
  );
  const f = await store.fundStats(id);
  assert.equal(f.display_name, "Stats Fund");
  assert.equal(f.trades, 5);
  assert.equal(f.closed_trades, 2);
  assert.equal(f.win_rate, 50);
  assert.equal(f.best_trade.team_id, "ALA");
  assert.ok(f.best_trade.gain > 0 && f.best_trade.gain_pct > 5, JSON.stringify(f.best_trade));
  assert.equal(f.favorite_team, "ALA");
  assert.equal(f.max_drawdown_pct, 25); // 12,000 -> 9,000
  assert.equal(f.competition_wins, 0);
});

test("league lengths: until each week through championship weekend; finished weeks drop off", { skip }, async () => {
  // Put weeks 11-13 of the schedule on upcoming Saturdays, week 13 holding the
  // conference title games, and week 4 in the past. Week 15 (after the
  // championships) shouldn't be offered.
  await q("update schedule set start_date = null");
  const sat = `(date_trunc('week', (now() at time zone 'America/New_York')::date)::date + 5)`;
  for (const [week, offset] of [[4, -21], [11, 7], [12, 14], [13, 21], [15, 28]]) {
    await q(
      `update schedule set start_date = ((${sat} + ${offset}) + time '15:30') at time zone 'America/New_York'
        where season = 2026 and season_type = 'regular' and week = $1`,
      [week]
    );
  }
  await q(
    `update schedule set notes = 'SEC Championship'
      where id = (select min(id) from schedule where season = 2026 and season_type = 'regular' and week = 13)`
  );
  // A week-11 game moved weeks later doesn't stretch week 11.
  await q(
    `update schedule set start_date = start_date + interval '35 days'
      where id = (select max(id) from schedule where season = 2026 and season_type = 'regular' and week = 11)`
  );
  const opts = await store.leagueOptions();
  assert.deepEqual(opts.map((o) => o.value), ["week", "w11", "w12", "w13", "season"]);
  assert.deepEqual(opts.map((o) => o.label), ["1 week", "Until Week 11", "Until Week 12", "Until Championship Weekend", "Rest of the season"]);
  const et = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" }).format(d);
  const w11 = opts.find((o) => o.value === "w11");
  assert.equal(et(w11.ends_at).replace(",", ""), "Sun 12", "ends the Sunday noon after the week's games");
  assert.ok(opts.find((o) => o.value === "w12").ends_at - w11.ends_at === 7 * 24 * 3600 * 1000, "the moved game didn't stretch week 11");

  const owner = await player("Week Picker");
  const { code } = (await q("select create_league($1, 'Thru Week 12', 'w12') as r", [owner]))[0].r;
  const [league] = await q("select ends_at from competitions where code = $1", [code]);
  assert.equal(+league.ends_at, +opts.find((o) => o.value === "w12").ends_at);
  await assert.rejects(q("select create_league($1, 'Past Week', 'w4')", [owner]), /invalid_league_length/);
  await assert.rejects(q("select create_league($1, 'After Champs', 'w15')", [owner]), /invalid_league_length/);
  await assert.rejects(q("select create_league($1, 'Old Option', 'month')", [owner]), /invalid_league_length/);
  await q("update schedule set start_date = null, notes = null");
});
