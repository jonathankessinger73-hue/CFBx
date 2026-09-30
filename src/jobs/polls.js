// Poll moves: when a new AP poll or CFP ranking comes out, teams that
// entered, left or moved in it get a price move (pollMovePct), logged in
// market_moves. Run by the daily job, so a release is picked up the day it
// comes out.
//
// Idempotent: releases already stored in poll_ranks are skipped, and each
// move's ref is the release, so a crash halfway through can't double-apply.
// The first time this runs in a season it only records the releases so far as
// the baseline: turning the feature on mid-season shouldn't replay weeks of
// old poll moves.

import { normalizeRankings } from "../cfbd/client.js";
import { POLLS, pollMovePct, pollMoveSummary } from "../engine/pricing.js";

export async function syncPolls({ pool, cfbd, season, dryRun, log, resolve }) {
  const all = normalizeRankings(await cfbd.rankings(season)).filter((r) => POLLS[r.poll]);
  const { rows: stored } = await pool.query(
    "select poll, season_type, week, team_id, rank from poll_ranks where season = $1",
    [season]
  );
  const bootstrap = stored.length === 0;

  // Releases in order: stored ones (for "previous") and new ones.
  const key = (poll, seasonType, week) => `${poll}|${seasonType}|${week}`;
  const releases = new Map(); // key -> { poll, seasonType, week, ranks: Map(team -> rank), stored }
  for (const r of stored) {
    const k = key(r.poll, r.season_type, r.week);
    if (!releases.has(k)) releases.set(k, { poll: r.poll, seasonType: r.season_type, week: r.week, ranks: new Map(), stored: true });
    releases.get(k).ranks.set(r.team_id, r.rank);
  }
  for (const r of all) {
    const k = key(r.poll, r.seasonType, r.week);
    const release = releases.get(k);
    if (release?.stored) continue;
    const id = resolve(r.school);
    if (!id) continue; // FCS schools can appear in "others receiving votes" lists
    if (!release) releases.set(k, { poll: r.poll, seasonType: r.seasonType, week: r.week, ranks: new Map(), stored: false });
    releases.get(k).ranks.set(id, r.rank);
  }

  const order = (r) => (r.seasonType === "postseason" ? 1000 : 0) + r.week;
  let moves = 0;
  for (const poll of Object.keys(POLLS)) {
    const list = [...releases.values()].filter((r) => r.poll === poll).sort((a, b) => order(a) - order(b));
    const fresh = list.filter((r) => !r.stored);
    if (!fresh.length) continue;
    // First run of the season: every release so far is recorded, none moves prices.
    for (const release of fresh) {
      const prev = bootstrap ? null : list[list.indexOf(release) - 1] || { ranks: new Map() };
      const ref = `${poll}:${season}:${release.seasonType}:${release.week}`;
      if (prev) {
        const teamIds = new Set([...prev.ranks.keys(), ...release.ranks.keys()]);
        for (const teamId of teamIds) {
          const before = prev.ranks.get(teamId) ?? null;
          const after = release.ranks.get(teamId) ?? null;
          const pct = pollMovePct(poll, before, after);
          if (pct === 0) continue;
          const summary = pollMoveSummary(poll, before, after);
          log(`poll move: ${teamId} ${pct > 0 ? "+" : ""}${pct}% (${summary})`);
          moves++;
          if (!dryRun) {
            await pool.query("select apply_news_move($1, $2, $3, 'poll', $4, $5, $6)", [
              teamId,
              season,
              release.week,
              ref,
              pct,
              summary,
            ]);
          }
        }
      } else {
        log(`polls: ${poll} week ${release.week} recorded as the starting point (no moves)`);
      }
      if (!dryRun) {
        await pool.query(
          `insert into poll_ranks (poll, season, season_type, week, team_id, rank)
           select $1, $2, $3, $4, x.team_id, x.rank
             from jsonb_to_recordset($5::jsonb) as x(team_id text, rank int)
           on conflict do nothing`,
          [poll, season, release.seasonType, release.week,
           JSON.stringify([...release.ranks].map(([team_id, rank]) => ({ team_id, rank })))]
        );
      }
      release.stored = true;
    }
  }
  return moves;
}
