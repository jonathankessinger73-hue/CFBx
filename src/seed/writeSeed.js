// Writes buildSeed() output to the database in a single transaction.
// Refuses to run against a database that already has teams: re-seeding a live
// market would silently reset every price to its IPO value.

import { gameKey } from "./buildSeed.js";

export async function writeSeed(pool, seed) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query("select count(*)::int as n from teams");
    if (rows[0].n > 0) throw new Error("teams table is not empty; refusing to re-seed");

    await client.query(
      `insert into teams (id, name, mascot, conference, strength, primary_color, secondary_color,
                          ipo_price, current_price, last_change_pct, last_covered, last_expected,
                          last_actual, last_line_is_real)
       select * from jsonb_to_recordset($1::jsonb) as x(
         id text, name text, mascot text, conference text, strength numeric,
         primary_color text, secondary_color text, ipo_price numeric, current_price numeric,
         last_change_pct numeric, last_covered boolean, last_expected numeric,
         last_actual numeric, last_line_is_real boolean)`,
      [JSON.stringify(seed.teams)]
    );

    const scheduleIds = new Map();
    const inserted = await client.query(
      `insert into schedule (season, week, home_team_id, away_team_id, line, home_score, away_score, completed)
       select season, week, home_team_id, away_team_id, line, home_score, away_score, completed
         from jsonb_to_recordset($1::jsonb) as x(
           season int, week int, home_team_id text, away_team_id text, line numeric,
           home_score int, away_score int, completed boolean)
       returning id, week, home_team_id, away_team_id`,
      [JSON.stringify(seed.schedule)]
    );
    for (const r of inserted.rows) {
      scheduleIds.set(gameKey({ week: r.week, home: r.home_team_id, away: r.away_team_id }), r.id);
    }

    const events = seed.events.map((e) => {
      const scheduleId = scheduleIds.get(e.game_key);
      if (!scheduleId) throw new Error(`no schedule row for ${e.game_key}`);
      const { game_key, ...rest } = e;
      return { ...rest, schedule_id: scheduleId };
    });
    await client.query(
      `insert into price_events (team_id, season, week, schedule_id, opponent_id, team_score,
                                 opp_score, pct_change, price_after, expected_margin,
                                 actual_margin, is_real_line, summary)
       select team_id, season, week, schedule_id, opponent_id, team_score, opp_score,
              pct_change, price_after, expected_margin, actual_margin, is_real_line, summary
         from jsonb_to_recordset($1::jsonb) as x(
           team_id text, season int, week int, schedule_id bigint, opponent_id text,
           team_score int, opp_score int, pct_change numeric, price_after numeric,
           expected_margin numeric, actual_margin numeric, is_real_line boolean, summary text)`,
      [JSON.stringify(events)]
    );

    await client.query("commit");
    return { teams: seed.teams.length, schedule: seed.schedule.length, events: events.length };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
