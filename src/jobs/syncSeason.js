// The daily job's logic: pull CFBD games + lines, write newly posted lines
// into `schedule`, and apply every newly completed game to prices.
// Exposed as a function (CFBD client and pg pool injected) so it can be tested.

import "../db/pg.js"; // numeric/bigint type parsers
import { normalizeGame, normalizeLineGame, normalizeRecord, normalizeTeamLogos } from "../cfbd/client.js";
import { createTeamResolver } from "../cfbd/teamNames.js";
import { applyGame } from "../engine/replay.js";
import { fcsGameImpact, spreadToExpectedHomeMargin } from "../engine/pricing.js";

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
  // FCS games already recorded, as "cfbdGameId:teamId".
  const { rows: fcsDone } = await pool.query(
    "select cfbd_game_id, team_id from price_events where season = $1 and vs_fcs",
    [season]
  );
  const fcsRecorded = new Set(fcsDone.map((r) => `${r.cfbd_game_id}:${r.team_id}`));
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
    if (!home || !away) return null; // e.g. an FCS opponent: see fcsSide()
    return byTeams.get(`${cfbdGame.week}:${home}:${away}`) || null;
  }

  // A game between a market team and an opponent outside FBS (FCS, D-II...).
  // Returns the market team's side, or null. An unresolved opponent that CFBD
  // itself calls FBS is a name we failed to map, not an FCS team.
  function fcsSide(cfbdGame) {
    const home = resolve(cfbdGame.home);
    const away = resolve(cfbdGame.away);
    if (home && !away && cfbdGame.awayClassification !== "fbs") {
      return { teamId: home, opponent: cfbdGame.away, teamScore: cfbdGame.homePoints, oppScore: cfbdGame.awayPoints };
    }
    if (away && !home && cfbdGame.homeClassification !== "fbs") {
      return { teamId: away, opponent: cfbdGame.home, teamScore: cfbdGame.awayPoints, oppScore: cfbdGame.homePoints };
    }
    return null;
  }

  const summary = { linesPosted: 0, gamesApplied: 0, fcsGames: 0, unmatched: [], recordsUpdated: 0, logosUpdated: 0 };

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
    const fcs = !m && fcsSide(g);
    if (fcs) {
      if (!fcsRecorded.has(`${g.id}:${fcs.teamId}`)) await applyFcsGame(g, fcs);
      continue;
    }
    if (!m) {
      // Both teams in the market but no schedule row, or one side an FBS
      // school we couldn't map to a ticker.
      if ((resolve(g.home) || resolve(g.away)) && !alreadyRecorded(g)) {
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

  // No line and no ticker for the opponent: a win is recorded with no price
  // change, a loss costs a fixed penalty (fcsGameImpact).
  async function applyFcsGame(g, { teamId, opponent, teamScore, oppScore }) {
    const team = market.get(teamId);
    const prev = team.current_price;
    const impact = fcsGameImpact(prev, teamScore, oppScore);
    log(
      `final (FCS): week ${g.week} ${teamId} ${teamScore}, ${opponent} ${oppScore} -> ` +
        `${teamId} ${impact.lastChangePct >= 0 ? "+" : ""}${impact.lastChangePct}%`
    );
    if (!dryRun) {
      const { rows } = await pool.query(
        "select apply_fcs_result($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as applied",
        [teamId, season, g.week, g.id, opponent, teamScore, oppScore, prev, impact.price, impact.lastChangePct, impact.summary]
      );
      if (!rows[0].applied) {
        const { rows: fresh } = await pool.query("select current_price from teams where id = $1", [teamId]);
        team.current_price = fresh[0].current_price;
        return;
      }
    }
    team.current_price = impact.price;
    summary.fcsGames++;
  }

  if (summary.unmatched.length) log(`unmatched FBS games (not in schedule): ${summary.unmatched.join("; ")}`);

  // ---- 3. official records ---------------------------------------------------
  // Overall and conference records as CFBD counts them, including games
  // against teams outside the market (FCS) that never move a price. A failure
  // here is logged but doesn't fail the run: prices matter more than records.
  if (cfbd.records) {
    try {
      const seen = new Set();
      const rows = [];
      for (const r of (await cfbd.records(season)).map(normalizeRecord)) {
        const id = resolve(r.team);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, ...r });
      }
      summary.recordsUpdated = rows.length;
      log(`records: ${rows.length} teams`);
      if (!dryRun && rows.length) {
        await pool.query(
          `update teams t set record_season = $2, wins = x.wins, losses = x.losses, ties = x.ties,
                  conf_wins = x."confWins", conf_losses = x."confLosses", conf_ties = x."confTies",
                  record_updated_at = now()
             from jsonb_to_recordset($1::jsonb) as x(id text, wins int, losses int, ties int,
                  "confWins" int, "confLosses" int, "confTies" int)
            where t.id = x.id`,
          [JSON.stringify(rows), season]
        );
      }
    } catch (err) {
      log(`records not updated: ${err.message}`);
    }
  }
  // ---- 4. team logos ---------------------------------------------------------
  // ESPN logo URLs as CFBD lists them. Only changed rows are written, so this
  // is a no-op most days. Like records, a failure is logged and ignored.
  if (cfbd.fbsTeams) {
    try {
      const seen = new Set();
      const rows = [];
      for (const t of (await cfbd.fbsTeams(season)).map(normalizeTeamLogos)) {
        const id = resolve(t.team);
        if (!id || !t.logo || seen.has(id)) continue;
        seen.add(id);
        rows.push({ id, logo: t.logo, dark: t.logoDark });
      }
      if (dryRun) {
        summary.logosUpdated = rows.length;
      } else if (rows.length) {
        const { rowCount } = await pool.query(
          `update teams t set logo_url = x.logo, logo_dark_url = x.dark
             from jsonb_to_recordset($1::jsonb) as x(id text, logo text, dark text)
            where t.id = x.id
              and (t.logo_url is distinct from x.logo or t.logo_dark_url is distinct from x.dark)`,
          [JSON.stringify(rows)]
        );
        summary.logosUpdated = rowCount;
      }
      log(`logos: ${rows.length} teams listed, ${dryRun ? "(dry run)" : `${summary.logosUpdated} updated`}`);
    } catch (err) {
      log(`logos not updated: ${err.message}`);
    }
  }
  return summary;
}
