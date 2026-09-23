// Applies completed games to an in-memory market, producing the rows that the
// database stores. Used by the seed script (replaying the season so far from
// IPO prices) and by the daily job (one newly completed game at a time).

import { computePriceImpact, spreadPhrase } from "./pricing.js";

/**
 * Apply one completed game to `market` (Map of team_id -> team row, mutated).
 * Returns the two price_events rows it produced (home first).
 *
 * @param {Map<string, object>} market  rows with at least id, strength, current_price
 * @param {{season:number, week:number, home:string, away:string,
 *          home_score:number, away_score:number,
 *          expected_home_margin:number|null}} game
 */
export function applyGame(market, game, random = Math.random) {
  const home = market.get(game.home);
  const away = market.get(game.away);
  if (!home || !away) throw new Error(`unknown team in game ${game.home} vs ${game.away}`);

  const impact = computePriceImpact(
    { price: home.current_price, strength: home.strength },
    game.home_score,
    { price: away.current_price, strength: away.strength },
    game.away_score,
    typeof game.expected_home_margin === "number" ? game.expected_home_margin : undefined,
    random
  );

  const events = [];
  for (const [team, opp, side, teamScore, oppScore] of [
    [home, away, impact.a, game.home_score, game.away_score],
    [away, home, impact.b, game.away_score, game.home_score],
  ]) {
    team.current_price = side.price;
    team.last_change_pct = side.lastChangePct;
    team.last_covered = side.covered;
    team.last_expected = side.expected;
    team.last_actual = side.actual;
    team.last_line_is_real = impact.isReal;
    events.push({
      team_id: team.id,
      season: game.season,
      week: game.week,
      opponent_id: opp.id,
      team_score: teamScore,
      opp_score: oppScore,
      pct_change: side.lastChangePct,
      price_after: side.price,
      expected_margin: side.expected,
      actual_margin: side.actual,
      is_real_line: impact.isReal,
      summary: spreadPhrase(side.expected, side.actual),
    });
  }
  return events;
}

/**
 * Replay a list of completed games, in week order, starting from IPO prices.
 * Games within a week keep their input order (Array#sort is stable).
 * Returns the final market plus, per game, the price_events it produced.
 */
export function replaySeason(teams, results, season, random = Math.random) {
  const market = new Map(
    teams.map((t) => [
      t.id,
      {
        ...t,
        current_price: t.ipo_price,
        last_change_pct: 0,
        last_covered: null,
        last_expected: null,
        last_actual: null,
        last_line_is_real: null,
      },
    ])
  );
  const ordered = results.slice().sort((a, b) => a.week - b.week);
  const games = ordered.map((g) => ({ game: g, events: applyGame(market, { ...g, season }, random) }));
  return { market, games };
}
