// Program Prestige Score rebuild: pull the history window from CFBD, score it
// (score.js), and optionally apply the result as a season's opening prices.

import "../db/pg.js"; // numeric/bigint type parsers
import { normalizeGame, normalizeTalent } from "../cfbd/client.js";
import { createTeamResolver } from "../cfbd/teamNames.js";
import { computePrestige, WINDOW_YEARS } from "./score.js";

// FBS newcomers with no FBS seasons in the window can't be scored; their
// opening prices are a judgment call (spec, "Known gaps"). Any future FBS
// transition needs an entry here until it has FBS history.
export const MANUAL_PRICES = { SACST: 13.0, NDSU: 14.5 };

/**
 * Fetch and score. Nothing is written.
 * @param {object} opts
 * @param {number} opts.season        the season the prices are for (opening prices)
 * @param {number} [opts.endYear]     last season in the window (default season - 1)
 * @param {number} [opts.talentYear]  /talent year (default: season, falling back to endYear)
 */
export async function buildPrestige({ pool, cfbd, season, endYear = season - 1, talentYear = season, log = console.log }) {
  const window = { start: endYear - WINDOW_YEARS + 1, end: endYear };
  const { rows: teams } = await pool.query("select id, name, ipo_price, current_price from teams order by id");

  const gamesByYear = {};
  for (let y = window.start; y <= window.end; y++) {
    const [regular, post] = await Promise.all([cfbd.games(y, "regular"), cfbd.games(y, "postseason")]);
    gamesByYear[y] = [
      ...regular.map((g) => ({ ...normalizeGame(g), seasonType: "regular" })),
      ...post.map((g) => ({ ...normalizeGame(g), seasonType: "postseason" })),
    ];
    log(`${y}: ${regular.length} regular-season + ${post.length} postseason games`);
  }

  let talentUsed = talentYear;
  let talent = (await cfbd.talent(talentYear)).map(normalizeTalent);
  if (!talent.length && talentYear !== endYear) {
    talentUsed = endYear;
    talent = (await cfbd.talent(endYear)).map(normalizeTalent);
  }
  log(`talent: ${talent.length} teams from ${talentUsed}`);

  const result = computePrestige({
    gamesByYear,
    talent,
    window,
    resolve: createTeamResolver(teams),
    tickers: teams.map((t) => t.id),
    manualPrices: MANUAL_PRICES,
  });

  const current = new Map(teams.map((t) => [t.id, t]));
  for (const r of result.rows) {
    const t = current.get(r.ticker);
    r.name = t.name;
    r.current_ipo_price = t.ipo_price;
    r.change_vs_current_ipo = Math.round((r.price - t.ipo_price) * 100) / 100;
  }
  return { season, talentYear: talentUsed, generatedAt: new Date().toISOString(), ...result };
}

/**
 * Apply a rebuild as `season`'s opening prices: sets ipo_price and
 * current_price for every team, clears last-game fields, and records the
 * scores. Refuses once `season` has a completed game, because that would
 * silently wipe everyone's in-season price moves.
 */
export async function applyPrestige(pool, result) {
  if (result.missing.length) {
    throw new Error(`no price for ${result.missing.join(", ")}; add them to MANUAL_PRICES or fix name matching`);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Take the teams rows first so a concurrent daily sync can't slip a game in.
    await client.query("select id from teams for update");
    const { rows } = await client.query(
      "select count(*)::int as n from schedule where season = $1 and completed",
      [result.season]
    );
    if (rows[0].n > 0) {
      throw new Error(
        `season ${result.season} already has ${rows[0].n} completed games; opening prices can only be set before the season starts`
      );
    }
    const { rows: dbTeams } = await client.query("select id from teams");
    const priced = new Set(result.rows.map((r) => r.ticker));
    const unpriced = dbTeams.map((t) => t.id).filter((id) => !priced.has(id));
    if (unpriced.length) throw new Error(`rebuild has no price for ${unpriced.join(", ")}`);

    const payload = JSON.stringify(
      result.rows.map((r) => ({
        team_id: r.ticker,
        raw_score: r.raw,
        prestige: r.prestige,
        price: r.price,
        manual: r.manual,
        components: r.components,
      }))
    );
    await client.query(
      `update teams t set ipo_price = x.price, current_price = x.price, last_change_pct = 0,
              last_covered = null, last_expected = null, last_actual = null,
              last_line_is_real = null, updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(team_id text, price numeric)
        where t.id = x.team_id`,
      [payload]
    );
    await client.query(
      `insert into prestige_scores (season, team_id, raw_score, prestige, price, manual, components)
       select $2, team_id, raw_score, prestige, price, manual, components
         from jsonb_to_recordset($1::jsonb) as x(team_id text, raw_score numeric, prestige numeric,
                                                 price numeric, manual boolean, components jsonb)
       on conflict (season, team_id) do update set
         raw_score = excluded.raw_score, prestige = excluded.prestige, price = excluded.price,
         manual = excluded.manual, components = excluded.components, applied_at = now()`,
      [payload, result.season]
    );
    await client.query("commit");
    return result.rows.length;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
