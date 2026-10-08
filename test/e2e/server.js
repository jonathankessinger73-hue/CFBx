// Test server for the browser tests: a fresh seeded database, the real API
// and web app, and a fake token verifier ("test-<uuid>" tokens).
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { freshDatabase } from "../helpers/db.js";
import { createStore } from "../../src/db/store.js";
import { createApp } from "../../src/api/app.js";
import { buildSeed } from "../../src/seed/buildSeed.js";
import { writeSeed } from "../../src/seed/writeSeed.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, "data", f), "utf8"));

// Fixed name: Playwright may kill this process before shutdown cleanup
// finishes, so the next run drops and recreates the same database instead.
const pool = await freshDatabase("cfbx_e2e");
await writeSeed(
  pool,
  buildSeed({
    teams: read("teams.json"),
    results: read("results-2026.json"),
    schedule: read("schedule-2026.json"),
    season: 2026,
  })
);
// Logos: UGA gets an inline image (no network needed), ALA one that can't
// load (must fall back to the helmet), everyone else none.
const UGA_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="red"/></svg>');
await pool.query("update teams set logo_dark_url = $1 where id = 'UGA'", [UGA_LOGO]);
await pool.query("update teams set logo_url = 'https://127.0.0.1:1/missing.png' where id = 'ALA'");
// Options listed for every team (the API server does this every few minutes).
await pool.query("select ensure_option_series()");
// A live game in progress for TEX (as the live poller sets it).
await pool.query("select set_live_moves($1)", [JSON.stringify([{ id: "TEX", pct: 2.5, status: "Q3 7:32 · TENN 10, TEX 21" }])]);
// A news move (as the line-move / poll jobs record them) for the news panel.
await pool.query("select apply_news_move('UGA', 2026, 4, 'poll', 'e2e-poll', 1.5, 'Up 3 spots to No. 2 in the AP poll')");
// Competitions: one open for entry (with a sponsor and prize), one live.
await pool.query(
  `insert into competitions (code, kind, name, starts_at, ends_at, min_trades, prize, sponsor_name, sponsor_url) values
     ('rivalry-cup', 'event', 'Rivalry Cup', now() + interval '2 days', now() + interval '5 days', 1,
      '$100 gift card', 'Acme Tailgate', 'https://example.com'),
     ('live-cup', 'event', 'Live Cup', now() - interval '1 day', now() + interval '3 days', 1, null, null, null)`
);
await pool.query("update competitions set started = true where code = 'live-cup'");

const app = createApp({
  store: createStore(pool),
  verifyToken: async (token) => {
    const m = /^test-([0-9a-f-]{36})$/.exec(token);
    if (!m) return null;
    await pool.query("insert into auth.users (id) values ($1) on conflict do nothing", [m[1]]);
    return m[1];
  },
  web: {
    dir: path.join(root, "web"),
    config: {
      apiUrl: "",
      supabaseUrl: "http://supabase.test",
      supabaseAnonKey: "test-anon-key",
      authProviders: ["google"],
      googleClientId: "test-client.apps.googleusercontent.com",
      authEmailFrom: "noreply@mail.example.test",
    },
  },
});

const port = Number(process.env.E2E_PORT || 4173);
const server = app.listen(port, () => console.log(`e2e server on :${port}`));
const shutdown = async () => {
  server.closeAllConnections();
  server.close();
  await pool.dropDatabase().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
