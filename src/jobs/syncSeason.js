// The daily job's logic: pull CFBD games + lines, write newly posted lines
// into `schedule`, and apply every newly completed game to prices.
// Exposed as a function (CFBD client and pg pool injected) so it can be tested.

import "../db/pg.js"; // numeric/bigint type parsers
import { normalizeGame, normalizeLineGame } from "../cfbd/client.js";
import { createTeamResolver } from "../cfbd/teamNames.js";
import { applyGame } from "../engine/replay.js";
import { spreadToExpectedHomeMargin } from "../engine/pricing.js";

/**
 * @param {object} opts
 * @param {import("pg").Pool} opts.pool
 * @param {ReturnType<import("../cfbd/client.js").createCfbdClient>} opts.cfbd
 * @param {number} opts.season
 * @param {boolean} [opts.dryRun]  compute and report, but write nothing
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.random]
 */
export async function syncSeason({ pool, cfbd, season, dryRun = false, log = console.log, random = Math.random }) {
  const { rows: teams } = await pool.query("select id, name, strength, current_price from teams");
  const resolve = createTeamResolver(teams);
  const market = new Map(teams.map((t) => [t.id, { ...t }]));

  const { rows: allGames } = await pool.query(
    `select id, week, home_team_id, away_team_id, line, cfbd_game_id, completed
       from schedule where season = $1`,
    [season]
  );
  const openGames = allGames.filter((g) => !g.completed);
  // Games already recorded: CFBD keeps returning them, and they're not news.
  const doneIds = new Set(allGames.filter((g) => g.completed && g.cfbd_game_id).map((g) => g.cfbd_game_id));
  const doneTeams = new Set(
    allGames
      .filter((g) => g.completed)
      .flatMap((g) => [`${g.week}:${g.home_team_id}:${g.away_team_id}`, `${g.week}:${g.away_team_id}:${g.home_team_id}`])
  );
  const alreadyRecorded = (cfbdGame) =>
    doneIds.has(cfbdGame.id) || doneTeams.has(`${cfbdGame.week}:${resolve(cfbdGame.home)}:${resolve(cfbdGame.away)}`);

  // Match a CFBD game to one of our open schedule rows: by CFBD id if we've
  // matched it before, else by week + teams (either orientation, since CFBD
  // and our data can disagree about home/away at neutral sites).
  const byCfbdId = new Map(openGames.filter((g) => g.cfbd_game_id).map((g) => [g.cfbd_game_id, g]));
  const byTeams = new Map();
  for (const g of openGames) {
    byTeams.set(`${g.week}:${g.home_team_id}:${g.away_team_id}`, { row: g, flipped: false });
    byTeams.set(`${g.week}:${g.away_team_id}:${g.home_team_id}`, { row: g, flipped: true });
  }
  function match(cfbdGame) {
    const direct = byCfbdId.get(cfbdGame.id);
    if (direct) return { row: direct, flipped: direct.home_team_id !== resolve(cfbdGame.home) };
    const home = resolve(cfbdGame.home);
    const away = resolve(cfbdGame.away);
    if (!home || !away) return null; // e.g. an FCS opponent: not a tradable game
    return byTeams.get(`${cfbdGame.week}:${home}:${away}`) || null;
  }

  const summary = { linesPosted: 0, gamesApplied: 0, unmatched: [] };

  // ---- 1. lines ------------------------------------------------------------
  const lineGames = (await cfbd.lines(season)).map(normalizeLineGame);
  const spreadByCfbdId = new Map(); // CFBD spread in OUR home orientation
  for (const lg of lineGames) {
    const m = match(lg);
    if (!m || lg.spread === null) continue;
    const spread = m.flipped ? -lg.spread : lg.spread;
    spreadByCfbdId.set(lg.id, spread);
    if (m.row.line === null) {
      summary.linesPosted++;
      log(`line posted: week ${m.row.week} ${m.row.away_team_id} @ ${m.row.home_team_id} ${spread}`);
      if (!dryRun) {
        await pool.query(
          "update schedule set line = $2, cfbd_game_id = coalesce(cfbd_game_id, $3), updated_at = now() where id = $1 and line is null",
          [m.row.id, spread, lg.id]
        );
      }
      m.row.line = spread;
    }
  }

  // ---- 2. completed games ---------------------------------------------------
  const games = (await cfbd.games(season)).map(normalizeGame).filter((g) => g.completed);
  games.sort((a, b) => a.week - b.week || a.id - b.id);
  for (const g of games) {
    if (g.homePoints === null || g.awayPoints === null) continue;
    const m = match(g);
    if (!m) {
      if (resolve(g.home) && resolve(g.away) && !alreadyRecorded(g)) {
        summary.unmatched.push(`${g.week}: ${g.away} @ ${g.home}`);
      }
      continue;
    }
    const { row, flipped } = m;
    const homeScore = flipped ? g.awayPoints : g.homePoints;
    const awayScore = flipped ? g.homePoints : g.awayPoints;
    // Prefer a real line for this exact game from /lines, then whatever the
    // schedule holds; if neither exists the engine falls back to SP+.
    const spread = spreadByCfbdId.get(g.id) ?? row.line;

    const home = market.get(row.home_team_id);
    const away = market.get(row.away_team_id);
    const prev = [home.current_price, away.current_price];
    const events = applyGame(
      market,
      {
        season,
        week: row.week,
        home: row.home_team_id,
        away: row.away_team_id,
        home_score: homeScore,
        away_score: awayScore,
        expected_home_margin: spreadToExpectedHomeMargin(spread),
      },
      random
    );
    const teamPayload = [home, away].map((t, i) => ({
      id: t.id,
      prev_price: prev[i],
      current_price: t.current_price,
      last_change_pct: t.last_change_pct,
      last_covered: t.last_covered,
      last_expected: t.last_expected,
      last_actual: t.last_actual,
      last_line_is_real: t.last_line_is_real,
    }));
    log(
      `final: week ${row.week} ${row.away_team_id} ${awayScore} @ ${row.home_team_id} ${homeScore} -> ` +
        events.map((e) => `${e.team_id} ${e.pct_change >= 0 ? "+" : ""}${e.pct_change}%`).join(", ")
    );

    if (!dryRun) {
      const { rows } = await pool.query("select apply_game_result($1, $2, $3, $4, $5, $6) as applied", [
        row.id,
        homeScore,
        awayScore,
        g.id,
        JSON.stringify(teamPayload),
        JSON.stringify(events),
      ]);
      if (!rows[0].applied) {
        // Another run got there first; reload so later games price correctly.
        const { rows: fresh } = await pool.query(
          "select id, current_price from teams where id = any($1)",
          [[home.id, away.id]]
        );
        for (const f of fresh) market.get(f.id).current_price = f.current_price;
        continue;
      }
    }
    summary.gamesApplied++;
  }

  if (summary.unmatched.length) log(`unmatched FBS games (not in schedule): ${summary.unmatched.join("; ")}`);
  return summary;
}
