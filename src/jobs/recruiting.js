// Recruiting class moves. From November through February the daily job takes
// a weekly snapshot of CFBD's team recruiting rankings for next year's class;
// every snapshot after the first moves each team by how far its class rose or
// fell (recruitingMovePct), logged in market_moves. Outside those months, or
// within a week of the last snapshot, it does nothing (and makes no call).

import { recruitingMovePct } from "../engine/pricing.js";

const SIGNING_MONTHS = new Set([11, 12, 1, 2]); // Nov-Feb
const SNAPSHOT_EVERY_DAYS = 7;

export async function syncRecruiting({ pool, cfbd, season, now = new Date(), dryRun, log, resolve }) {
  if (!SIGNING_MONTHS.has(now.getUTCMonth() + 1)) return 0;
  const classYear = season + 1;
  const takenOn = now.toISOString().slice(0, 10);
  const { rows: last } = await pool.query(
    "select max(taken_on)::text as taken_on from recruiting_ranks where class_year = $1",
    [classYear]
  );
  const lastTaken = last[0].taken_on;
  if (lastTaken && (Date.parse(takenOn) - Date.parse(lastTaken)) / 86400000 < SNAPSHOT_EVERY_DAYS) return 0;

  const ranks = new Map();
  for (const r of await cfbd.recruitingTeams(classYear)) {
    const id = resolve(r.team);
    const rank = Number(r.rank);
    if (id && Number.isInteger(rank) && !ranks.has(id)) ranks.set(id, { rank, points: Number(r.points) || null });
  }
  if (!ranks.size) return 0;

  let moves = 0;
  if (lastTaken) {
    const { rows: prev } = await pool.query(
      "select team_id, rank from recruiting_ranks where class_year = $1 and taken_on = $2",
      [classYear, lastTaken]
    );
    const ref = `recruiting:${classYear}:${takenOn}`;
    for (const { team_id: teamId, rank: before } of prev) {
      const after = ranks.get(teamId)?.rank;
      const pct = recruitingMovePct(before, after);
      if (!pct) continue;
      const spots = Math.abs(before - after);
      const summary = `${classYear} recruiting class ${before > after ? "up" : "down"} ${spots} spot${spots === 1 ? "" : "s"} to No. ${after}`;
      log(`recruiting move: ${teamId} ${pct > 0 ? "+" : ""}${pct}% (${summary})`);
      moves++;
      if (!dryRun) {
        await pool.query("select apply_news_move($1, $2, null, 'recruiting', $3, $4, $5)", [teamId, season, ref, pct, summary]);
      }
    }
  } else {
    log(`recruiting: ${classYear} class rankings recorded as the starting point (no moves)`);
  }
  if (!dryRun) {
    await pool.query(
      `insert into recruiting_ranks (class_year, taken_on, team_id, rank, points)
       select $1, $2, x.team_id, x.rank, x.points
         from jsonb_to_recordset($3::jsonb) as x(team_id text, rank int, points numeric)
       on conflict do nothing`,
      [classYear, takenOn, JSON.stringify([...ranks].map(([team_id, r]) => ({ team_id, ...r })))]
    );
  }
  return moves;
}
