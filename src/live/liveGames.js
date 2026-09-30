// Live in-game prices. Runs inside the API server (LIVE_GAMES=true): every
// few minutes, if any game is in its window (kickoff up to 5 hours ago), it
// reads CFBD's scoreboard and sets each playing team's live move: what the
// final would do to the price if the game ended now, scaled by how much of
// the game has been played (liveMovePct). When a game goes final its result is
// applied right away through the daily sync's own code path, which replaces
// the live move with the real one.
//
// Outside game windows it makes no CFBD calls at all, to stay inside the API
// plan's monthly limit.

import { normalizeScoreboardGame } from "../cfbd/client.js";
import { createTeamResolver } from "../cfbd/teamNames.js";
import { gameElapsed, liveMovePct, proxyExpectedMargin } from "../engine/pricing.js";
import { syncSeason } from "../jobs/syncSeason.js";

const WINDOW_BEFORE_MIN = 10; // start polling this long before kickoff
const WINDOW_AFTER_HOURS = 5; // and stop this long after it

/**
 * One polling round. Exported for tests; startLiveGames calls it on a timer.
 * @returns {Promise<{polled: boolean, live: number, finalized: number}>}
 */
export async function liveTick({ pool, cfbd, log = console.log, now = new Date(), finalized = new Set() }) {
  const { rows: open } = await pool.query(
    `select s.id, s.season, s.week, s.home_team_id, s.away_team_id, s.line, s.cfbd_game_id,
            h.strength as home_strength, a.strength as away_strength
       from schedule s
       join teams h on h.id = s.home_team_id
       join teams a on a.id = s.away_team_id
      where not s.completed
        and s.start_date <= $1::timestamptz + make_interval(mins => $2)
        and s.start_date >= $1::timestamptz - make_interval(hours => $3)`,
    [now.toISOString(), WINDOW_BEFORE_MIN, WINDOW_AFTER_HOURS]
  );
  if (!open.length) {
    await pool.query("select clear_live_moves('{}')"); // nothing's on: no live moves either
    return { polled: false, live: 0, finalized: 0 };
  }

  const { rows: teams } = await pool.query("select id, name from teams");
  const resolve = createTeamResolver(teams);
  const byCfbdId = new Map(open.filter((r) => r.cfbd_game_id).map((r) => [r.cfbd_game_id, r]));
  const byTeams = new Map();
  for (const r of open) {
    byTeams.set(`${r.home_team_id}:${r.away_team_id}`, r);
    byTeams.set(`${r.away_team_id}:${r.home_team_id}`, r);
  }

  const moves = [];
  let done = 0;
  for (const g of (await cfbd.scoreboard()).map(normalizeScoreboardGame)) {
    const home = resolve(g.home);
    const away = resolve(g.away);
    const row = byCfbdId.get(g.id) || (home && away ? byTeams.get(`${home}:${away}`) : null);
    if (!row || g.homePoints === null || g.awayPoints === null) continue;
    const flipped = row.home_team_id !== home;
    const homeScore = flipped ? g.awayPoints : g.homePoints;
    const awayScore = flipped ? g.homePoints : g.awayPoints;

    if (g.status === "completed") {
      if (finalized.has(row.id)) continue;
      // Apply the final now, through the daily sync's own code (it's
      // idempotent, so the daily job seeing it later is harmless).
      const summary = await syncSeason({
        pool,
        season: row.season,
        log,
        cfbd: {
          lines: async () => [],
          games: async () => [
            {
              id: g.id,
              season: row.season,
              week: row.week,
              completed: true,
              homeTeam: flipped ? g.away : g.home,
              awayTeam: flipped ? g.home : g.away,
              homePoints: homeScore,
              awayPoints: awayScore,
            },
          ],
        },
      });
      finalized.add(row.id);
      done += summary.gamesApplied;
      continue;
    }
    if (g.status !== "in_progress") continue;

    const expected =
      row.line !== null ? -row.line : proxyExpectedMargin(row.home_strength, row.away_strength);
    const elapsed = gameElapsed(g.period, g.clock);
    const homePct = liveMovePct(expected, homeScore - awayScore, elapsed);
    const status = `${g.period > 4 ? "OT" : `Q${g.period ?? 1}`} ${g.period > 4 ? "" : clockText(g.clock)}`.trim() +
      ` · ${row.away_team_id} ${awayScore}, ${row.home_team_id} ${homeScore}`;
    moves.push({ id: row.home_team_id, pct: homePct, status });
    moves.push({ id: row.away_team_id, pct: liveMovePct(-expected, awayScore - homeScore, elapsed), status });
  }

  if (moves.length) await pool.query("select set_live_moves($1)", [JSON.stringify(moves)]);
  await pool.query("select clear_live_moves($1)", [moves.map((m) => m.id)]);
  if (moves.length) log(`live: ${moves.map((m) => `${m.id} ${m.pct >= 0 ? "+" : ""}${m.pct}%`).join(", ")}`);
  return { polled: true, live: moves.length / 2, finalized: done };
}

function clockText(clock) {
  const parts = String(clock ?? "").split(":");
  if (parts.length < 2) return "";
  const [m, s] = parts.slice(-2);
  return `${Number(m)}:${String(s).padStart(2, "0")}`;
}

export function startLiveGames({ pool, cfbd, intervalMs = 180_000, log = console.log }) {
  const finalized = new Set();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await liveTick({ pool, cfbd, log, finalized });
    } catch (err) {
      log(`live games: ${err.message}`);
    } finally {
      running = false;
    }
  };
  log(`live games: checking every ${Math.round(intervalMs / 1000)}s during game windows`);
  run();
  return setInterval(run, intervalMs).unref();
}
