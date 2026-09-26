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
