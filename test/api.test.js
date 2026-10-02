import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { TEST_DATABASE_URL, freshDatabase, createAuthUser } from "./helpers/db.js";
import { createStore } from "../src/db/store.js";
import { createApp } from "../src/api/app.js";
import { supabaseBaseUrl } from "../src/api/auth.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";

const skip = !TEST_DATABASE_URL && "TEST_DATABASE_URL not set";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

let pool, app;
const tokens = new Map(); // fake token -> user id

before(async () => {
  if (skip) return;
  pool = await freshDatabase();
  await writeSeed(
    pool,
    buildSeed({
      teams: read("teams.json"),
      results: read("results-2026.json"),
      schedule: read("schedule-2026.json"),
      season: 2026,
    })
  );
  app = createApp({
    store: createStore(pool),
    verifyToken: async (t) => tokens.get(t) || null,
    allowedOrigins: ["https://cfbx.example"],
    web: {
      dir: new URL("../web", import.meta.url).pathname,
      config: { apiUrl: "", supabaseUrl: "https://proj.supabase.co", supabaseAnonKey: "anon" },
    },
  });
});

after(async () => {
  if (pool) await pool.dropDatabase();
});

async function login() {
  const id = await createAuthUser(pool, randomUUID());
  const token = `tok-${id}`;
  tokens.set(token, id);
  return { id, auth: `Bearer ${token}` };
}

test("GET /teams is public and lists all teams", { skip }, async () => {
  const res = await request(app).get("/teams").expect(200);
  assert.equal(res.body.teams.length, 138);
  assert.equal(res.body.season, 2026);
  assert.equal(res.body.week, 3);
  const uga = res.body.teams.find((t) => t.id === "UGA");
  const detail = await request(app).get("/teams/UGA").expect(200);
  assert.deepEqual(uga.history, detail.body.price_history);
  assert.equal(uga.mascot, "Bulldogs");
  assert.equal(typeof uga.current_price, "number");
  assert.equal(typeof uga.last_covered, "boolean");
});

test("records: overall, conference and ATS from played games, official numbers preferred", { skip }, async () => {
  const byId = async () => new Map((await request(app).get("/teams").expect(200)).body.teams.map((t) => [t.id, t]));
  let teams = await byId();
  // Georgia: beat WKU 70-20 (line -40.3) and SEC foe Arkansas 45-17 (line -24.5): covered both.
  assert.deepEqual(teams.get("UGA").records, {
    overall: { wins: 2, losses: 0, ties: 0 },
    conference: { wins: 1, losses: 0, ties: 0 },
    ats: { wins: 2, losses: 0, pushes: 0 },
    official: false,
  });
  // TCU: lost to UNC as a 7.5-point favorite, beat Arkansas State by 24 as an 18.8 favorite.
  assert.deepEqual(teams.get("TCU").records.overall, { wins: 1, losses: 1, ties: 0 });
  assert.deepEqual(teams.get("TCU").records.conference, { wins: 0, losses: 0, ties: 0 });
  assert.deepEqual(teams.get("TCU").records.ats, { wins: 1, losses: 1, pushes: 0 });
  // Independents have no conference record.
  assert.equal(teams.get("ND").records.conference, null);

  // Once the daily sync stores CFBD's official record (which counts FCS games), it wins.
  await pool.query(
    "update teams set record_season = 2026, wins = 3, losses = 0, ties = 0, conf_wins = 1, conf_losses = 0, conf_ties = 0 where id = 'UGA'"
  );
  try {
    teams = await byId();
    assert.deepEqual(teams.get("UGA").records.overall, { wins: 3, losses: 0, ties: 0 });
    assert.equal(teams.get("UGA").records.official, true);
    assert.deepEqual(teams.get("UGA").records.ats, { wins: 2, losses: 0, pushes: 0 }); // ATS stays computed
    const detail = await request(app).get("/teams/UGA").expect(200);
    assert.deepEqual(detail.body.team.records.overall, { wins: 3, losses: 0, ties: 0 });
    // A record stored for another season is ignored.
    await pool.query("update teams set record_season = 2025 where id = 'UGA'");
    teams = await byId();
    assert.deepEqual(teams.get("UGA").records.overall, { wins: 2, losses: 0, ties: 0 });
  } finally {
    await pool.query("update teams set record_season = null, wins = null, losses = null, ties = null, conf_wins = null, conf_losses = null, conf_ties = null where id = 'UGA'");
  }
});

test("GET /teams/:id returns history, game log and upcoming games", { skip }, async () => {
  const res = await request(app).get("/teams/uga").expect(200);
  assert.equal(res.body.team.id, "UGA");
  assert.equal(res.body.price_history[0], res.body.team.ipo_price);
  assert.equal(res.body.price_history.at(-1), res.body.team.current_price);
  assert.equal(res.body.game_log.length, res.body.price_history.length - 1);
  // Week 4: UGA hosts OU, favored by 14 (CFBD line -14).
  const ou = res.body.upcoming.find((g) => g.week === 4);
  assert.equal(ou.opponent_id, "OU");
  assert.equal(ou.line, -14);
  assert.equal(ou.expected_margin, 14);
  assert.equal(ou.line_is_real, true);
  // From Oklahoma's side the same line is +14 underdog.
  const ouRes = await request(app).get("/teams/OU").expect(200);
  assert.equal(ouRes.body.upcoming.find((g) => g.week === 4).expected_margin, -14);

  await request(app).get("/teams/NOPE").expect(404);
});

test("authenticated endpoints require a valid token", { skip }, async () => {
  await request(app).get("/me").expect(401);
  await request(app).get("/me").set("Authorization", "Bearer bogus").expect(401);
  await request(app).post("/trade").send({ team_id: "UGA", side: "buy", shares: 1 }).expect(401);
});

test("POST /trade ignores client-supplied prices and updates /me", { skip }, async () => {
  const { auth } = await login();
  const { body: team } = await request(app).get("/teams/TEX");
  const price = team.team.current_price;
  const { body: quote } = await request(app).get("/quote?team_id=tex&side=buy&shares=10").expect(200);

  const res = await request(app)
    .post("/trade")
    .set("Authorization", auth)
    .send({ team_id: "tex", side: "buy", shares: 10, price: 0.01 })
    .expect(200);
  // Fills at the quoted price: a bit above the listed price (the order walks
  // the price up as it fills, plus the spread), never the client's price.
  assert.equal(res.body.amount, quote.amount);
  assert.equal(res.body.price, quote.avg_price);
  assert.ok(res.body.price > price && res.body.price < price * 1.02, `${res.body.price} vs ${price}`);
  assert.equal(res.body.cash, Math.round((10000 - res.body.amount) * 100) / 100);
  assert.ok(res.body.price_after > price);

  const me = await request(app).get("/me").set("Authorization", auth).expect(200);
  assert.equal(me.body.cash, res.body.cash);
  // Net worth values the shares at what selling them now would bring, so a
  // buy never inflates it: it dips by the spread, it doesn't jump.
  assert.ok(me.body.net_worth < 10000 && me.body.net_worth > 10000 - res.body.amount * 0.01, `${me.body.net_worth}`);

  const holdings = await request(app).get("/me/holdings").set("Authorization", auth).expect(200);
  assert.equal(holdings.body.holdings.length, 1);
  assert.equal(holdings.body.holdings[0].shares, 10);

  const txs = await request(app).get("/me/transactions").set("Authorization", auth).expect(200);
  assert.equal(txs.body.transactions.length, 1);
});

test("GET /quote prices an order without placing it, and validates input", { skip }, async () => {
  const q = (qs) => request(app).get(`/quote?${qs}`);
  const small = (await q("team_id=UGA&side=buy&shares=1").expect(200)).body;
  const big = (await q("team_id=UGA&side=buy&shares=500").expect(200)).body;
  assert.equal(small.team_id, "UGA");
  assert.ok(big.avg_price > small.avg_price, "bigger orders pay a higher average");
  assert.ok(big.price_after > big.price_before);
  const sell = (await q("team_id=UGA&side=sell&shares=1").expect(200)).body;
  assert.ok(sell.avg_price < small.avg_price, "the spread: selling gets less than buying costs");
  assert.equal((await q("team_id=UGA&side=hold&shares=1").expect(400)).body.error, "invalid_side");
  assert.equal((await q("team_id=UGA&side=buy&shares=0").expect(400)).body.error, "invalid_shares");
  assert.equal((await q("team_id=NOPE&side=buy&shares=1").expect(404)).body.error, "unknown_team");
});

test("GET /me/payouts lists the season payouts a player received", { skip }, async () => {
  const me = await login();
  await request(app).get("/me").set("Authorization", me.auth).expect(200); // creates the account
  await pool.query("insert into holdings (user_id, team_id, shares, avg_cost) values ($1, 'CLEM', 20, 30)", [me.id]);
  const { rows } = await pool.query("select pay_dividend('CLEM', 2026, 'bowl_eligible', 2, 'Bowl eligible: 6 wins') as d");
  const paid = rows[0].d;
  const res = await request(app).get("/me/payouts").set("Authorization", me.auth).expect(200);
  assert.equal(res.body.payouts.length, 1);
  assert.deepEqual(
    (({ team_id, kind, shares, amount, per_share }) => ({ team_id, kind, shares, amount, per_share }))(res.body.payouts[0]),
    { team_id: "CLEM", kind: "bowl_eligible", shares: 20, amount: Math.round(20 * paid.per_share * 100) / 100, per_share: paid.per_share }
  );
  const acct = await request(app).get("/me").set("Authorization", me.auth).expect(200);
  assert.equal(acct.body.cash, Math.round((10000 + 20 * paid.per_share) * 100) / 100);
  await request(app).get("/me/payouts").expect(401);
});

test("options: board, buy and sell back, portfolio, and errors", { skip }, async () => {
  await pool.query("select ensure_option_series()");
  const board = await request(app).get("/teams/uga/options").expect(200);
  assert.equal(board.body.team_id, "UGA");
  assert.equal(board.body.paused, false);
  assert.ok(board.body.football_price > 0);
  assert.equal(board.body.options.length, 20); // 5 strikes x call/put x weekly/season
  const call = board.body.options.find((o) => o.kind === "call" && o.expiry_kind === "weekly");
  assert.ok(call.ask > call.bid);

  const me = await login();
  const post = (body) => request(app).post("/options/trade").set("Authorization", me.auth).send(body);
  const bought = (await post({ series_id: call.id, side: "buy", qty: 3, price: 0.01 }).expect(200)).body;
  assert.equal(bought.price, call.ask, "the client's price is ignored");
  assert.deepEqual(bought.position, { qty: 3, avg_cost: call.ask });

  const account = (await request(app).get("/me/options").set("Authorization", me.auth).expect(200)).body;
  assert.equal(account.positions.length, 1);
  assert.equal(account.positions[0].team_id, "UGA");
  assert.equal(account.activity[0].side, "buy");
  const mine = (await request(app).get("/me").set("Authorization", me.auth).expect(200)).body;
  assert.equal(mine.options_value, Math.round(3 * call.bid * 100) / 100);

  assert.equal((await post({ series_id: call.id, side: "sell", qty: 4 }).expect(400)).body.error, "insufficient_options");
  assert.equal((await post({ series_id: call.id, side: "hold", qty: 1 }).expect(400)).body.error, "invalid_side");
  assert.equal((await post({ series_id: call.id, side: "buy", qty: 0 }).expect(400)).body.error, "invalid_shares");
  assert.equal((await post({ series_id: 99999999, side: "buy", qty: 1 }).expect(404)).body.error, "unknown_option");
  assert.equal((await post({ series_id: call.id, side: "buy", qty: 998 }).expect(400)).body.error, "position_limit");
  // 25% of net worth: an in-the-money call costs a few dollars each.
  const itm = board.body.options
    .filter((o) => o.kind === "call" && o.expiry_kind === "season")
    .sort((a, b) => a.strike - b.strike)[0];
  const tooMany = Math.ceil(2600 / itm.ask);
  assert.ok(tooMany <= 997, `${tooMany}`);
  assert.equal((await post({ series_id: itm.id, side: "buy", qty: tooMany }).expect(400)).body.error, "options_limit");
  await post({ series_id: call.id, side: "sell", qty: 3 }).expect(200);
  await request(app).post("/options/trade").send({ series_id: call.id, side: "buy", qty: 1 }).expect(401);
  await request(app).get("/teams/NOPE/options").expect(404);
});

test("POST /trade validates input and maps domain errors", { skip }, async () => {
  const { auth } = await login();
  const post = (body) => request(app).post("/trade").set("Authorization", auth).send(body);
  assert.equal((await post({ team_id: "UGA", side: "buy", shares: 1.5 }).expect(400)).body.error, "invalid_shares");
  assert.equal((await post({ team_id: "UGA", side: "buy", shares: "5" }).expect(400)).body.error, "invalid_shares");
  assert.equal((await post({ team_id: "UGA", side: "short", shares: 1 }).expect(400)).body.error, "invalid_side");
  assert.equal((await post({ side: "buy", shares: 1 }).expect(400)).body.error, "invalid_team");
  assert.equal((await post({ team_id: "NOPE", side: "buy", shares: 1 }).expect(404)).body.error, "unknown_team");
  assert.equal(
    (await post({ team_id: "UGA", side: "buy", shares: 100000 }).expect(400)).body.error,
    "insufficient_funds"
  );
  assert.equal((await post({ team_id: "UGA", side: "sell", shares: 1 }).expect(400)).body.error, "insufficient_shares");
  const bad = await request(app)
    .post("/trade")
    .set("Authorization", auth)
    .set("Content-Type", "application/json")
    .send("{nope")
    .expect(400);
  assert.equal(bad.body.error, "invalid_json");
});

test("PATCH /me sets a display name, validated and unique ignoring case", { skip }, async () => {
  const a = await login();
  const b = await login();
  const patch = (who, display_name) =>
    request(app).patch("/me").set("Authorization", who.auth).send({ display_name });

  await request(app).patch("/me").send({ display_name: "Nobody" }).expect(401);
  for (const bad of ["ab", "x".repeat(25), " -dash", "semi;colon", "trailing_", 42, undefined]) {
    assert.equal((await patch(a, bad).expect(400)).body.error, "invalid_display_name", String(bad));
  }
  for (const blocked of ["CFBx Admin", "Fu" + "ckTheDawgs"]) {
    assert.equal((await patch(a, blocked).expect(400)).body.error, "display_name_not_allowed", blocked);
  }
  await patch(a, "Gamecock Nation").expect(200); // football words aren't false positives
  const ok = await patch(a, "  Dawg   Fan  ").expect(200);
  assert.equal(ok.body.display_name, "Dawg Fan");
  assert.equal((await request(app).get("/me").set("Authorization", a.auth)).body.display_name, "Dawg Fan");

  assert.equal((await patch(b, "dawg fan").expect(409)).body.error, "display_name_taken");
  await patch(a, "Dawg Fan").expect(200); // re-saving your own name is fine
  await patch(a, null).expect(200); // leaving frees the name
  await patch(b, "dawg fan").expect(200);
  await patch(b, null).expect(200);
});

test("GET /leaderboard ranks opted-in players by net worth", { skip }, async () => {
  const [rich, tiedA, tiedB, hidden] = [await login(), await login(), await login(), await login()];
  const name = (who, n) => request(app).patch("/me").set("Authorization", who.auth).send({ display_name: n }).expect(200);
  await name(rich, "Rich Rival");
  await name(tiedA, "Alpha Tie");
  await name(tiedB, "beta tie");

  // rich buys 10 TEX, then TEX's price rises $5. hidden (no name) buys too.
  const { body: bought } = await request(app)
    .post("/trade").set("Authorization", rich.auth).send({ team_id: "TEX", side: "buy", shares: 10 }).expect(200);
  await request(app).post("/trade").set("Authorization", hidden.auth).send({ team_id: "TEX", side: "buy", shares: 100 }).expect(200);
  const { rows: saved } = await pool.query("select fundamental_price, hype, current_price from teams where id = 'TEX'");
  await pool.query(
    "update teams set fundamental_price = fundamental_price + 5, current_price = market_price(fundamental_price + 5, hype, live_pct) where id = 'TEX'"
  );
  const { rows: sv } = await pool.query("select sell_value('TEX', 10) as v");
  const richWorth = Math.round((bought.cash + sv[0].v) * 100) / 100;
  assert.ok(richWorth > 10000);
  try {
    const pub = await request(app).get("/leaderboard").expect(200);
    assert.equal(pub.body.players, 3);
    assert.deepEqual(
      pub.body.leaderboard.map((r) => [r.rank, r.display_name, r.net_worth, r.is_me]),
      [
        [1, "Rich Rival", richWorth, false],
        [2, "Alpha Tie", 10000, false],
        [2, "beta tie", 10000, false],
      ]
    );
    assert.equal(pub.body.me, undefined);
    for (const row of pub.body.leaderboard) {
      assert.deepEqual(Object.keys(row).sort(), ["display_name", "is_me", "net_worth", "rank"]);
    }

    const mine = await request(app).get("/leaderboard?limit=1").set("Authorization", tiedB.auth).expect(200);
    assert.equal(mine.body.leaderboard.length, 1);
    assert.deepEqual(mine.body.me, { rank: 2, display_name: "beta tie", net_worth: 10000 });
    const rows1 = await request(app).get("/leaderboard").set("Authorization", rich.auth);
    assert.equal(rows1.body.leaderboard[0].is_me, true);

    const hiddenView = await request(app).get("/leaderboard").set("Authorization", hidden.auth).expect(200);
    assert.equal(hiddenView.body.me, null);
    // A bad token on a public endpoint is just anonymous.
    const anon = await request(app).get("/leaderboard").set("Authorization", "Bearer junk").expect(200);
    assert.equal(anon.body.me, undefined);
  } finally {
    await pool.query("update teams set fundamental_price = $1, hype = $2, current_price = $3 where id = 'TEX'", [
      saved[0].fundamental_price,
      saved[0].hype,
      saved[0].current_price,
    ]);
  }
});

test("CORS only echoes allowed origins", { skip }, async () => {
  const ok = await request(app).get("/teams").set("Origin", "https://cfbx.example");
  assert.equal(ok.headers["access-control-allow-origin"], "https://cfbx.example");
  const no = await request(app).get("/teams").set("Origin", "https://evil.example");
  assert.equal(no.headers["access-control-allow-origin"], undefined);
});

test("serves the web app, its public config and the Supabase bundle", { skip }, async () => {
  const page = await request(app).get("/").expect(200);
  assert.match(page.text, /<main id="main">/);
  const cfg = await request(app).get("/config.js").expect(200);
  assert.match(cfg.headers["content-type"], /javascript/);
  assert.equal(
    cfg.text.trim(),
    'window.CFBX_CONFIG = {"apiUrl":"","supabaseUrl":"https://proj.supabase.co","supabaseAnonKey":"anon"};'
  );
  const bundle = await request(app).get("/vendor/supabase.js").expect(200);
  assert.match(bundle.text, /createClient/);
  await request(app).get("/app.js").expect(200);
});

test("SUPABASE_URL is reduced to the bare project address", () => {
  for (const u of ["https://abcd.supabase.co", "https://abcd.supabase.co/", " https://abcd.supabase.co/rest/v1/ "]) {
    assert.equal(supabaseBaseUrl(u), "https://abcd.supabase.co", u);
  }
  assert.throws(() => supabaseBaseUrl("abcd.supabase.co"), /not a valid URL/);
});
