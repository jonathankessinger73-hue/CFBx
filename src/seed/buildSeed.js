// Builds the initial database contents from the JSON extracted out of the
// reference artifact (see scripts/extract-artifact.js):
//   - teams at IPO price, then moved by replaying every completed game in
//     week order through the pricing engine,
//   - the full schedule (completed games with scores, upcoming with lines),
//   - one price_events row per team per completed game.

import { replaySeason } from "../engine/replay.js";
import { expectedHomeMarginToSpread } from "../engine/pricing.js";

export const gameKey = (g) => `${g.week}:${g.home}-vs-${g.away}`;

export function buildSeed({ teams, results, schedule, season, random = Math.random }) {
  const { market, games } = replaySeason(teams, results, season, random);

  const teamRows = [...market.values()].map((t) => ({
    id: t.id,
    name: t.name,
    mascot: t.mascot,
    conference: t.conference,
    strength: t.strength,
    primary_color: t.primary_color,
    secondary_color: t.secondary_color,
    ipo_price: t.ipo_price,
    current_price: t.current_price,
    last_change_pct: t.last_change_pct,
    last_covered: t.last_covered,
    last_expected: t.last_expected,
    last_actual: t.last_actual,
    last_line_is_real: t.last_line_is_real,
  }));

  const scheduleRows = [
    ...results.map((g) => ({
      key: gameKey(g),
      season,
      week: g.week,
      home_team_id: g.home,
      away_team_id: g.away,
      line: expectedHomeMarginToSpread(g.expected_home_margin),
      home_score: g.home_score,
      away_score: g.away_score,
      completed: true,
    })),
    ...schedule.map((g) => ({
      key: gameKey(g),
      season,
      week: g.week,
      home_team_id: g.home,
      away_team_id: g.away,
      line: expectedHomeMarginToSpread(g.expected_home_margin),
      home_score: null,
      away_score: null,
      completed: false,
    })),
  ];

  const eventRows = games.flatMap(({ game, events }) =>
    events.map((e) => ({ ...e, game_key: gameKey(game) }))
  );

  return { teams: teamRows, schedule: scheduleRows, events: eventRows };
}
