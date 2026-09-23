import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { TEST_DATABASE_URL, freshDatabase, createAuthUser } from "./helpers/db.js";
import { createStore } from "../src/db/store.js";
import { createApp } from "../src/api/app.js";
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

  const res = await request(app)
    .post("/trade")
    .set("Authorization", auth)
    .send({ team_id: "tex", side: "buy", shares: 10, price: 0.01 })
    .expect(200);
  assert.equal(res.body.price, price);
  assert.equal(res.body.cash, Math.round((10000 - price * 10) * 100) / 100);

  const me = await request(app).get("/me").set("Authorization", auth).expect(200);
  assert.equal(me.body.cash, res.body.cash);
  assert.equal(me.body.net_worth, 10000);

  const holdings = await request(app).get("/me/holdings").set("Authorization", auth).expect(200);
  assert.equal(holdings.body.holdings.length, 1);
  assert.equal(holdings.body.holdings[0].shares, 10);

  const txs = await request(app).get("/me/transactions").set("Authorization", auth).expect(200);
  assert.equal(txs.body.transactions.length, 1);
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

  // rich buys 10 TEX, then TEX rises $5: net worth 10,050. hidden (no name) buys too.
  const { rows } = await pool.query("select current_price from teams where id = 'TEX'");
  const texPrice = rows[0].current_price;
  await request(app).post("/trade").set("Authorization", rich.auth).send({ team_id: "TEX", side: "buy", shares: 10 }).expect(200);
  await request(app).post("/trade").set("Authorization", hidden.auth).send({ team_id: "TEX", side: "buy", shares: 100 }).expect(200);
  await pool.query("update teams set current_price = $1 where id = 'TEX'", [texPrice + 5]);
  try {
    const pub = await request(app).get("/leaderboard").expect(200);
    assert.equal(pub.body.players, 3);
    assert.deepEqual(
      pub.body.leaderboard.map((r) => [r.rank, r.display_name, r.net_worth, r.is_me]),
      [
        [1, "Rich Rival", 10050, false],
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
    await pool.query("update teams set current_price = $1 where id = 'TEX'", [texPrice]);
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
