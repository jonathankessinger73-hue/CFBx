import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { supabaseTokenVerifier, supabaseBaseUrl } from "./auth.js";
import { createPool, createStore } from "../db/store.js";

const store = createStore(createPool());
const app = createApp({
  store,
  verifyToken: supabaseTokenVerifier(),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // e.g. cfbxchange.com: visits to www. or the onrender.com address go there.
  canonicalHost: (process.env.CANONICAL_HOST || "").trim() || undefined,
  web:
    process.env.SERVE_WEB === "false"
      ? undefined
      : {
          dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web"),
          // Public values only: this is sent to every browser.
          config: {
            apiUrl: process.env.PUBLIC_API_URL || "",
            supabaseUrl: supabaseBaseUrl(process.env.SUPABASE_URL),
            supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
            // Sign-in providers switched on in Supabase besides email, e.g. "google".
            authProviders: (process.env.AUTH_PROVIDERS || "")
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
            // Shown on the "check your email" screen so people know what to look for.
            authEmailFrom: process.env.AUTH_EMAIL_FROM || "",
          },
        },
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`cfbx api listening on :${port}`));

// Trading hype fades back toward zero; apply that every few minutes so prices
// drift back even when nobody trades.
const DECAY_EVERY_MS = 5 * 60 * 1000;
// Options: pay out expired ones and keep strikes listed near current prices.
// Also saves each player's net worth for today (portfolio returns).
// Safe to run from several places.
const marketTick = async () => {
  for (const sql of ["select decay_hype()", "select settle_options()", "select ensure_option_series()", "select record_net_worth()"]) {
    await store.pool.query(sql).catch((err) => console.error(`${sql} failed:`, err.message));
  }
};
marketTick();
setInterval(marketTick, DECAY_EVERY_MS).unref();

// Live in-game prices (LIVE_GAMES=true, needs CFBD_API_KEY): polls the
// scoreboard only while games are on. Run it on one server only.
if (process.env.LIVE_GAMES === "true") {
  try {
    const { startLiveGames } = await import("../live/liveGames.js");
    const { createCfbdClient } = await import("../cfbd/client.js");
    const seconds = Math.max(60, Number(process.env.LIVE_POLL_SECONDS) || 180);
    startLiveGames({ pool: store.pool, cfbd: createCfbdClient(), intervalMs: seconds * 1000 });
  } catch (err) {
    console.error(`live games not started: ${err.message}`);
  }
}
