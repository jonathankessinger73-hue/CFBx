// HTTP API. The server is the only authority on price, cash and holdings:
// clients ask questions or request trades, they never assert a price.

import { createRequire } from "node:module";
import express from "express";
import { requireAuth, optionalAuth } from "./auth.js";
import { TRADE_ERRORS } from "../db/store.js";
import { checkDisplayName } from "../moderation/names.js";

const MAX_SHARES_PER_TRADE = 1_000_000;

// 3-24 chars; letters, digits, space, _ . -; starts and ends alphanumeric.
// Mirrors the users_display_name_format constraint (003_leaderboard.sql).
export const DISPLAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,22}[A-Za-z0-9]$/;

function corsMiddleware(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<import("../db/store.js").createStore>} opts.store
 * @param {(token: string) => Promise<string|null>} opts.verifyToken
 * @param {string[]} [opts.allowedOrigins]
 * @param {{dir: string, config: object}} [opts.web]  serve the frontend from
 *        `dir`, with `config` (public values only) exposed as /config.js
 */
export function createApp({ store, verifyToken, allowedOrigins = [], web }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(corsMiddleware(allowedOrigins));
  app.use(express.json({ limit: "16kb" }));

  const auth = requireAuth(verifyToken);
  const maybeAuth = optionalAuth(verifyToken);

  app.get("/health", (req, res) => res.json({ ok: true }));

  // ---- public ------------------------------------------------------------

  app.get("/teams", async (req, res) => {
    const { season, week } = await store.getMarketClock();
    const [teams, histories, records] = await Promise.all([
      store.listTeams(),
      store.listPriceHistories(season),
      store.listRecords(season),
    ]);
    res.json({
      season,
      week,
      teams: teams.map((t) => ({ ...t, history: histories.get(t.id) || [t.ipo_price], records: records.get(t.id) })),
    });
  });

  app.get("/teams/:id", async (req, res) => {
    const id = String(req.params.id).toUpperCase();
    const team = await store.getTeam(id);
    if (!team) return res.status(404).json({ error: "unknown_team" });
    const season = req.query.season ? Number.parseInt(req.query.season, 10) : undefined;
    const { season: current } = await store.getMarketClock();
    const [events, upcoming, records] = await Promise.all([
      store.getPriceEvents(id, Number.isFinite(season) ? season : undefined),
      store.getUpcomingGames(id),
      store.listRecords(Number.isFinite(season) ? season : current),
    ]);
    res.json({
      team: { ...team, records: records.get(id) },
      // Chart series: IPO price, then the price after each game.
      price_history: [team.ipo_price, ...events.map((e) => e.price_after)],
      game_log: events.slice().reverse(),
      upcoming: upcoming.map((g) => ({
        ...g,
        // Team-perspective expected margin from the posted line (CFBD
        // convention: negative = home favored). Null = no line posted yet,
        // so anything shown for this game is projected, not real.
        expected_margin: g.line === null ? null : g.is_home ? -g.line : g.line,
        line_is_real: g.line !== null,
      })),
    });
  });

  // Public. Only players who chose a display name are listed, and user ids
  // are never exposed. With a valid token, `me` is the caller's own entry
  // (null if they haven't opted in) so they can see their rank off-page.
  app.get("/leaderboard", maybeAuth, async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const [{ rows, players }, mine] = await Promise.all([
      store.leaderboard(limit),
      req.userId ? store.leaderboardEntry(req.userId) : null,
    ]);
    const body = {
      players,
      leaderboard: rows.map((r) => ({
        rank: Number(r.rank),
        display_name: r.display_name,
        net_worth: r.net_worth,
        is_me: r.user_id === req.userId,
      })),
    };
    if (req.userId) {
      body.me = mine ? { rank: Number(mine.rank), display_name: mine.display_name, net_worth: mine.net_worth } : null;
    }
    res.json(body);
  });

  // ---- authenticated -----------------------------------------------------

  app.get("/me", auth, async (req, res) => {
    const acct = await store.getAccount(req.userId);
    res.json({
      id: acct.user_id,
      display_name: acct.display_name,
      cash: acct.cash,
      holdings_value: acct.holdings_value,
      net_worth: acct.net_worth,
    });
  });

  // Body: { display_name: string | null }. null leaves the leaderboard.
  app.patch("/me", auth, async (req, res) => {
    const raw = (req.body || {}).display_name;
    let name = null;
    if (raw !== null) {
      if (typeof raw !== "string") return res.status(400).json({ error: "invalid_display_name" });
      name = raw.trim().replace(/\s+/g, " ");
      if (!DISPLAY_NAME_RE.test(name)) return res.status(400).json({ error: "invalid_display_name" });
      // Offensive or impersonating names. The response never says which word matched.
      if (!checkDisplayName(name).ok) return res.status(400).json({ error: "display_name_not_allowed" });
    }
    try {
      await store.setDisplayName(req.userId, name);
    } catch (err) {
      if (err.message === "display_name_taken") return res.status(409).json({ error: err.message });
      if (err.message === "invalid_display_name") return res.status(400).json({ error: err.message });
      throw err;
    }
    const acct = await store.getAccount(req.userId);
    res.json({ display_name: acct.display_name, cash: acct.cash, net_worth: acct.net_worth });
  });

  app.get("/me/holdings", auth, async (req, res) => {
    res.json({ holdings: await store.getHoldings(req.userId) });
  });

  app.get("/me/transactions", auth, async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const before = req.query.before ? Number.parseInt(req.query.before, 10) : undefined;
    res.json({
      transactions: await store.listTransactions(req.userId, {
        limit,
        before: Number.isFinite(before) ? before : undefined,
      }),
    });
  });

  app.post("/trade", auth, async (req, res) => {
    // Only these three fields are read. Anything else in the body - in
    // particular a price - is ignored: the price comes from the database.
    const { team_id, side, shares } = req.body || {};
    if (typeof team_id !== "string" || !team_id) {
      return res.status(400).json({ error: "invalid_team" });
    }
    if (side !== "buy" && side !== "sell") {
      return res.status(400).json({ error: "invalid_side" });
    }
    if (!Number.isInteger(shares) || shares < 1 || shares > MAX_SHARES_PER_TRADE) {
      return res.status(400).json({ error: "invalid_shares" });
    }
    try {
      const result = await store.executeTrade(req.userId, team_id.toUpperCase(), side, shares);
      res.json(result);
    } catch (err) {
      if (TRADE_ERRORS.has(err.message)) {
        const status = err.message === "unknown_team" ? 404 : 400;
        return res.status(status).json({ error: err.message });
      }
      throw err;
    }
  });

  // ---- frontend ------------------------------------------------------------

  if (web) {
    const configJs = `window.CFBX_CONFIG = ${JSON.stringify(web.config)};\n`;
    app.get("/config.js", (req, res) => {
      res.type("application/javascript").set("Cache-Control", "no-cache").send(configJs);
    });
    // Serve the Supabase browser bundle ourselves rather than from a CDN.
    const supabaseUmd = createRequire(import.meta.url).resolve("@supabase/supabase-js/dist/umd/supabase.js");
    app.get("/vendor/supabase.js", (req, res) => res.sendFile(supabaseUmd));
    app.use(express.static(web.dir, { index: "index.html" }));
  }

  app.use((req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
