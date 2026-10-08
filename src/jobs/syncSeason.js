// The daily job's logic: pull CFBD games + lines, write newly posted lines
// into `schedule`, and apply every newly completed game to prices.
// Exposed as a function (CFBD client and pg pool injected) so it can be tested.

import "../db/pg.js"; // numeric/bigint type parsers
import { normalizeGame, normalizeLineGame, normalizeRecord, normalizeTeamLogos } from "../cfbd/client.js";
import { createTeamResolver } from "../cfbd/teamNames.js";
import { applyGame } from "../engine/replay.js";
import { PAYOUTS, fcsGameImpact, lineMovePct, spreadToExpectedHomeMargin } from "../engine/pricing.js";
import { cfpStage } from "../prestige/score.js";
import { syncPolls } from "./polls.js";
import { syncRecruiting } from "./recruiting.js";

/**
 * @param {object} opts
 * @param {import("pg").Pool} opts.pool
 * @param {ReturnType<import("../cfbd/client.js").createCfbdClient>} opts.cfbd
 * @param {number} opts.season
 * @param {boolean} [opts.dryRun]  compute and report, but write nothing
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.random]
 */
export async function syncSeason({
  pool,
  cfbd,
  season,
  dryRun = false,
  log = console.log,
  random = Math.random,
  now = new Date(),
}) {
  const { rows: teams } = await pool.query("select id, name, strength, current_price from teams");
  const resolve = createTeamResolver(teams);
  const market = new Map(teams.map((t) => [t.id, { ...t }]));

  const { rows: allGames } = await pool.query(
    `select id, week, season_type, home_team_id, away_team_id, line, line_priced, cfbd_game_id, completed,
            start_date, notes
       from schedule where season = $1`,
    [season]
  );
  const openGames = allGames.filter((g) => !g.completed);
  // Regular season and postseason weeks both start at 1: keys carry the type.
  const typeOf = (g) => (g.seasonType === "postseason" || g.season_type === "postseason" ? "postseason" : "regular");
  const key = (type, week, a, b) => `${type}:${week}:${a}:${b}`;
  // Games already recorded: CFBD keeps returning them, and they're not news.
  const doneIds = new Set(allGames.filter((g) => g.completed && g.cfbd_game_id).map((g) => g.cfbd_game_id));
  const doneTeams = new Set(
    allGames
      .filter((g) => g.completed)
      .flatMap((g) => [
        key(g.season_type, g.week, g.home_team_id, g.away_team_id),
        key(g.season_type, g.week, g.away_team_id, g.home_team_id),
      ])
  );
  // FCS games already recorded, as "cfbdGameId:teamId".
  const { rows: fcsDone } = await pool.query(
    "select cfbd_game_id, team_id from price_events where season = $1 and vs_fcs",
    [season]
  );
  const fcsRecorded = new Set(fcsDone.map((r) => `${r.cfbd_game_id}:${r.team_id}`));
  const alreadyRecorded = (cfbdGame) =>
    doneIds.has(cfbdGame.id) ||
    doneTeams.has(key(typeOf(cfbdGame), cfbdGame.week, resolve(cfbdGame.home), resolve(cfbdGame.away)));

  // Match a CFBD game to one of our open schedule rows: by CFBD id if we've
  // matched it before, else by week + teams (either orientation, since CFBD
  // and our data can disagree about home/away at neutral sites), else by the
  // two teams alone if exactly one open game has them within two weeks (a game
  // that moved).
  const byCfbdId = new Map();
  const byTeams = new Map();
  const byPair = new Map();
  const pairKey = (type, a, b) => `${type}:${[a, b].sort().join(":")}`;
  function indexRow(g) {
    if (g.cfbd_game_id) byCfbdId.set(g.cfbd_game_id, g);
    byTeams.set(key(g.season_type, g.week, g.home_team_id, g.away_team_id), { row: g, flipped: false });
    byTeams.set(key(g.season_type, g.week, g.away_team_id, g.home_team_id), { row: g, flipped: true });
    const pk = pairKey(g.season_type, g.home_team_id, g.away_team_id);
    byPair.set(pk, [...(byPair.get(pk) || []), g]);
  }
  openGames.forEach(indexRow);
  function match(cfbdGame) {
    const direct = byCfbdId.get(cfbdGame.id);
    if (direct) return { row: direct, flipped: direct.home_team_id !== resolve(cfbdGame.home) };
    const home = resolve(cfbdGame.home);
    const away = resolve(cfbdGame.away);
    if (!home || !away) return null; // e.g. an FCS opponent: see fcsSide()
    const exact = byTeams.get(key(typeOf(cfbdGame), cfbdGame.week, home, away));
    if (exact) return exact;
    // Only a small shift in weeks: a title-game rematch is a different game.
    const pair = (byPair.get(pairKey(typeOf(cfbdGame), home, away)) || []).filter(
      (r) => Math.abs(r.week - cfbdGame.week) <= 2
    );
    return pair.length === 1 ? { row: pair[0], flipped: pair[0].home_team_id !== home } : null;
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

  const summary = {
    gamesAdded: 0,
    dividendsPaid: 0,
    linesPosted: 0,
    lineMoves: 0,
    gamesApplied: 0,
    fcsGames: 0,
    unmatched: [],
    recordsUpdated: 0,
    logosUpdated: 0,
    pollMoves: 0,
    recruitingMoves: 0,
  };

  // ---- 0. games, and any missing from the schedule ---------------------------
  // Postseason (bowls, playoff) too, when the client supports it.
  const withPostseason = typeof cfbd.postseasonGames === "function";
  const allCfbdGames = [
    ...(await cfbd.games(season)).map(normalizeGame),
    ...(withPostseason ? (await cfbd.postseasonGames(season)).map((g) => ({ ...normalizeGame(g), seasonType: "postseason" })) : []),
  ];
  // A game between two market teams that isn't in our schedule (conference
  // title games, bowls, a game moved to another week that we can't place)
  // gets a schedule row, so it's priced like any other.
  for (const g of allCfbdGames) {
    const home = resolve(g.home);
    const away = resolve(g.away);
    if (!home || !away || home === away || match(g) || alreadyRecorded(g)) continue;
    const row = {
      id: null,
      week: g.week,
      season_type: typeOf(g),
      home_team_id: home,
      away_team_id: away,
      line: null,
      line_priced: null,
      cfbd_game_id: g.id,
      completed: false,
      start_date: g.startDate ? new Date(g.startDate) : null,
      notes: g.notes,
    };
    if (!dryRun) {
      const { rows } = await pool.query(
        `insert into schedule (season, week, season_type, home_team_id, away_team_id, cfbd_game_id, start_date, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (cfbd_game_id) do nothing
         returning id`,
        [season, row.week, row.season_type, home, away, g.id, row.start_date, g.notes]
      );
      if (!rows.length) continue;
      row.id = rows[0].id;
    }
    summary.gamesAdded++;
    log(`game added: ${row.season_type} week ${row.week} ${away} @ ${home}${g.notes ? ` (${g.notes})` : ""}`);
    openGames.push(row);
    indexRow(row);
  }

  // ---- 1. lines ------------------------------------------------------------
  const lineGames = [
    ...(await cfbd.lines(season)).map(normalizeLineGame),
    ...(withPostseason ? (await cfbd.lines(season, "postseason")).map((g) => ({ ...normalizeLineGame(g), seasonType: "postseason" })) : []),
  ];
  const spreadByCfbdId = new Map(); // CFBD spread in OUR home orientation
  for (const lg of lineGames) {
    const m = match(lg);
    if (!m || lg.spread === null) continue;
    const spread = m.flipped ? -lg.spread : lg.spread;
    spreadByCfbdId.set(lg.id, spread);
    const row = m.row;
    if (row.line === null || row.line_priced === null) {
      // First line seen for this game: post it; it's the baseline for moves.
      if (row.line === null) {
        summary.linesPosted++;
        log(`line posted: week ${row.week} ${row.away_team_id} @ ${row.home_team_id} ${spread}`);
      }
      if (!dryRun) {
        await pool.query(
          `update schedule set line = coalesce(line, $2), line_priced = coalesce(line_priced, line, $2),
                  cfbd_game_id = coalesce(cfbd_game_id, $3), updated_at = now()
            where id = $1`,
          [row.id, spread, lg.id]
        );
      }
      row.line ??= spread;
      row.line_priced ??= row.line;
      continue;
    }
    // The line moved since prices last reflected it: both teams move.
    const homePct = lineMovePct(-(spread - row.line_priced));
    if (homePct === 0) continue;
    const home = market.get(row.home_team_id);
    const away = market.get(row.away_team_id);
    const homeSummary = `Line moved vs ${away.name}: now ${lineText(-spread)} (was ${lineText(-row.line_priced)})`;
    const awaySummary = `Line moved vs ${home.name}: now ${lineText(spread)} (was ${lineText(row.line_priced)})`;
    log(
      `line move: week ${row.week} ${row.away_team_id} @ ${row.home_team_id} ${row.line_priced} -> ${spread}: ` +
        `${row.home_team_id} ${homePct > 0 ? "+" : ""}${homePct}%, ${row.away_team_id} ${homePct < 0 ? "+" : ""}${-homePct}%`
    );
    let applied = true;
    if (!dryRun) {
      const { rows } = await pool.query("select apply_line_move($1, $2, $3, $4, $5, $6) as applied", [
        row.id,
        row.line_priced,
        spread,
        homePct,
        homeSummary,
        awaySummary,
      ]);
      applied = rows[0].applied;
    }
    if (applied) summary.lineMoves++;
    row.line = spread;
    row.line_priced = spread;
  }

  // ---- 2. completed games ---------------------------------------------------
  // Kickoff times and labels for open games (kickoffs tell the live poller
  // when games are on; labels like "SEC Championship" show in game logs).
  // Finished games get their kickoff filled in once if it was never saved
  // (the portfolio's "this season" return starts from Week 0's date).
  const kickoffs = [];
  for (const g of allCfbdGames) {
    const m = match(g);
    if (!m || m.row.id === null) continue;
    if (g.completed && m.row.start_date) continue;
    const start = g.startDate ? new Date(g.startDate) : null;
    const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
    const startChanged = validStart && m.row.start_date?.getTime() !== validStart.getTime();
    const notesChanged = g.notes && g.notes !== m.row.notes;
    if (startChanged || notesChanged) {
      kickoffs.push({ id: m.row.id, start: validStart?.toISOString() ?? null, cfbd_id: g.id, notes: g.notes || null });
    }
  }
  if (kickoffs.length && !dryRun) {
    await pool.query(
      `update schedule s set start_date = coalesce(x.start, s.start_date), notes = coalesce(x.notes, s.notes),
              cfbd_game_id = coalesce(s.cfbd_game_id, x.cfbd_id)
         from jsonb_to_recordset($1::jsonb) as x(id bigint, start timestamptz, cfbd_id bigint, notes text)
        where s.id = x.id`,
      [JSON.stringify(kickoffs)]
    );
  }

  const games = allCfbdGames.filter((g) => g.completed);
  games.sort((a, b) => (typeOf(a) === typeOf(b) ? 0 : typeOf(a) === "postseason" ? 1 : -1) || a.week - b.week || a.id - b.id);
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
    // Moves go to the database as percentages, applied to whatever the price
    // is at that moment (trades may have moved it since we read it).
    const teamPayload = [home, away].map((t, i) => ({
      id: t.id,
      pct: events[i].move_pct,
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
      if (!rows[0].applied) continue; // another run got there first
    }
    summary.gamesApplied++;
  }

  // No line and no ticker for the opponent: a win is recorded with no price
  // change, a loss costs a fixed penalty (fcsGameImpact).
  async function applyFcsGame(g, { teamId, opponent, teamScore, oppScore }) {
    const team = market.get(teamId);
    const impact = fcsGameImpact(team.current_price, teamScore, oppScore);
    log(
      `final (FCS): week ${g.week} ${teamId} ${teamScore}, ${opponent} ${oppScore} -> ` +
        `${teamId} ${impact.lastChangePct >= 0 ? "+" : ""}${impact.lastChangePct}%`
    );
    if (!dryRun) {
      const { rows } = await pool.query(
        "select apply_fcs_result($1, $2, $3, $4, $5, $6, $7, $8, $9) as applied",
        [teamId, season, g.week, g.id, opponent, teamScore, oppScore, impact.pct, impact.summary]
      );
      if (!rows[0].applied) return;
    }
    team.current_price = impact.price;
    summary.fcsGames++;
  }

  if (summary.unmatched.length) log(`unmatched FBS games (not in schedule): ${summary.unmatched.join("; ")}`);

  const winsByTeam = new Map(); // official wins this season, from /records

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
      for (const r of rows) winsByTeam.set(r.id, r.wins);
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
  // ---- 3b. season payouts -------------------------------------------------------
  // Milestones reached, from official records and CFBD's game labels.
  const milestones = [];
  for (const [id, wins] of winsByTeam) if (wins >= 6) milestones.push([id, "bowl_eligible"]);
  for (const g of allCfbdGames) {
    const home = resolve(g.home);
    const away = resolve(g.away);
    const winner = !g.completed || g.homePoints === g.awayPoints ? null : g.homePoints > g.awayPoints ? home : away;
    const stage = typeOf(g) === "postseason" ? cfpStage(g.notes) : 0;
    if (stage >= 1) {
      // In the playoff field as soon as the game is announced.
      for (const id of [home, away]) if (id) milestones.push([id, "playoff_berth"]);
      if (stage === 4 && winner) milestones.push([winner, "national_title"]);
    } else if (
      typeOf(g) === "regular" && winner &&
      /championship/i.test(g.notes || "") && !/playoff|national/i.test(g.notes || "") &&
      g.homeConference && g.homeConference === g.awayConference
    ) {
      milestones.push([winner, "conf_title"]);
    }
  }
  for (const [teamId, kind] of milestones) {
    const payout = PAYOUTS[kind];
    if (dryRun) {
      log(`payout (dry run, if not already paid): ${teamId} ${kind} ${payout.pct}%`);
      continue;
    }
    const { rows } = await pool.query("select pay_dividend($1, $2, $3, $4, $5) as paid", [
      teamId,
      season,
      kind,
      payout.pct,
      payout.summary,
    ]);
    const paid = rows[0].paid;
    if (!paid) continue;
    summary.dividendsPaid++;
    log(`payout: ${teamId} ${payout.summary}: $${paid.per_share}/share, ${paid.shares_paid} shares, $${paid.total_paid} total`);
  }

  // ---- 4. poll moves ---------------------------------------------------------
  if (cfbd.rankings) {
    try {
      summary.pollMoves = await syncPolls({ pool, cfbd, season, dryRun, log, resolve, teams: market });
    } catch (err) {
      log(`polls not updated: ${err.message}`);
    }
  }

  // ---- 4b. recruiting class moves (Nov-Feb) --------------------------------------
  if (cfbd.recruitingTeams) {
    try {
      summary.recruitingMoves = await syncRecruiting({ pool, cfbd, season, now, dryRun, log, resolve });
    } catch (err) {
      log(`recruiting not updated: ${err.message}`);
    }
  }

  // ---- 5. team logos ---------------------------------------------------------
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

// A team's expected margin as words: "favored by 7.0", "underdog by 3.5".
function lineText(margin) {
  if (margin > 0) return `favored by ${margin.toFixed(1)}`;
  if (margin < 0) return `underdog by ${(-margin).toFixed(1)}`;
  return "a pick'em";
}
