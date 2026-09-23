// Weekly strength refresh: pull the current season's SP+ ratings from CFBD
// and rescale them into teams.strength (10-95).
//
// Strength only feeds the SP+ fallback spread (games with no posted line)
// and the "projected" labels in the UI. It never moves a price by itself.
// SP+ is republished weekly during the season (early weeks still lean on
// preseason priors), so running this weekly keeps the fallback current.

import "../db/pg.js"; // numeric/bigint type parsers
import { normalizeSpRating } from "../cfbd/client.js";
import { createTeamResolver } from "../cfbd/teamNames.js";
import { strengthFromRatings } from "../engine/pricing.js";

// Refuse to rescale from a thin or partial ratings pull: min/max over a
// handful of teams would distort everyone's strength.
export const MIN_RATED_TEAMS = 100;

/**
 * @param {object} opts
 * @param {import("pg").Pool} opts.pool
 * @param {{ spRatings: (year: number) => Promise<object[]> }} opts.cfbd
 * @param {number} opts.season
 * @param {boolean} [opts.dryRun]
 * @param {(msg: string) => void} [opts.log]
 */
export async function refreshStrength({ pool, cfbd, season, dryRun = false, log = console.log, minTeams = MIN_RATED_TEAMS }) {
  const { rows: teams } = await pool.query("select id, name, strength from teams");
  const resolve = createTeamResolver(teams);

  const ratings = [];
  const seen = new Set();
  const unmatched = [];
  for (const r of (await cfbd.spRatings(season)).map(normalizeSpRating)) {
    if (r.rating === null) continue;
    const id = resolve(r.team);
    if (!id) {
      if (r.team && !/average/i.test(r.team)) unmatched.push(r.team);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ratings.push({ team_id: id, rating: r.rating });
  }

  if (ratings.length < minTeams) {
    log(`only ${ratings.length} teams rated for ${season} (need ${minTeams}); strengths left unchanged`);
    return { updated: 0, skipped: true, rated: ratings.length, unmatched, unrated: [] };
  }

  const { rows: clock } = await pool.query(
    "select coalesce(max(week), 0) as week from schedule where season = $1 and completed",
    [season]
  );
  const week = clock[0].week;

  const strengths = strengthFromRatings(ratings);
  const before = new Map(teams.map((t) => [t.id, t.strength]));
  const changes = ratings
    .map((r) => ({ ...r, strength: strengths.get(r.team_id), was: before.get(r.team_id) }))
    .sort((a, b) => Math.abs(b.strength - b.was) - Math.abs(a.strength - a.was));
  const unrated = teams.filter((t) => !strengths.has(t.id)).map((t) => t.id);

  log(`season ${season} after week ${week}: ${ratings.length} teams rated`);
  for (const c of changes.slice(0, 10).filter((c) => c.strength !== c.was)) {
    log(`  ${c.team_id.padEnd(6)} ${c.was} -> ${c.strength}  (SP+ ${c.rating})`);
  }
  if (unrated.length) log(`not rated this week (strength kept): ${unrated.join(", ")}`);
  if (unmatched.length) log(`ratings for schools not in the market: ${unmatched.length}`);

  if (!dryRun) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const payload = JSON.stringify(changes.map((c) => ({ team_id: c.team_id, rating: c.rating, strength: c.strength })));
      await client.query(
        `update teams t set strength = x.strength, updated_at = now()
           from jsonb_to_recordset($1::jsonb) as x(team_id text, rating numeric, strength numeric)
          where t.id = x.team_id`,
        [payload]
      );
      // Re-running in the same week overwrites that week's snapshot.
      await client.query(
        `insert into strength_history (team_id, season, week, sp_rating, strength)
         select team_id, $2, $3, rating, strength
           from jsonb_to_recordset($1::jsonb) as x(team_id text, rating numeric, strength numeric)
         on conflict (team_id, season, week)
           do update set sp_rating = excluded.sp_rating, strength = excluded.strength, created_at = now()`,
        [payload, season, week]
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    updated: changes.filter((c) => c.strength !== c.was).length,
    skipped: false,
    rated: ratings.length,
    week,
    unmatched,
    unrated,
  };
}
