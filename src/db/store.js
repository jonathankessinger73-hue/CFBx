// Data access for the API. Talks to Supabase's Postgres directly over
// DATABASE_URL (service connection). All writes that touch money go through
// the SQL functions in db/migrations/002_functions.sql so they are atomic.

export { createPool } from "./pg.js";

// Error messages raised by execute_trade that are the caller's fault.
export const TRADE_ERRORS = new Set([
  "invalid_side",
  "invalid_shares",
  "unknown_team",
  "insufficient_funds",
  "insufficient_shares",
]);

const TEAM_COLUMNS = `id, name, mascot, conference, strength, primary_color, secondary_color,
  ipo_price, current_price, last_change_pct, last_covered, last_expected, last_actual,
  last_line_is_real`;

export function createStore(pool) {
  return {
    pool,

    async listTeams() {
      const { rows } = await pool.query(`select ${TEAM_COLUMNS} from teams order by id`);
      return rows;
    },

    // Price series per team for sparklines: IPO price, then the price after
    // each game of the given season, in order.
    async listPriceHistories(season) {
      const { rows } = await pool.query(
        `select t.id, t.ipo_price,
                coalesce(array_agg(e.price_after order by e.week, e.id)
                           filter (where e.id is not null), '{}') as prices
           from teams t
           left join price_events e on e.team_id = t.id and e.season = $1
          group by t.id`,
        [season]
      );
      return new Map(rows.map((r) => [r.id, [r.ipo_price, ...r.prices.map(Number)]]));
    },

    // Current season and the latest week with a completed game (0 if none).
    async getMarketClock() {
      const { rows } = await pool.query(
        `with s as (select coalesce(max(season), extract(year from now())::int) as season from schedule)
         select s.season,
                coalesce((select max(week) from schedule
                           where season = s.season and completed), 0) as week
           from s`
      );
      return rows[0];
    },

    // Season records per team: overall, conference and against the spread.
    // Overall/conference use CFBD's official numbers when the daily sync has
    // stored them for this season (they include FCS games), otherwise they're
    // counted from price_events. ATS always comes from price_events, counting
    // only games with a real posted line; exact pushes are listed separately.
    async listRecords(season) {
      const { rows } = await pool.query(
        `with games as (
           select e.team_id,
                  e.team_score - e.opp_score as margin,
                  t.conference = o.conference and t.conference <> 'FBS Independents' as conf_game,
                  case when e.is_real_line then sign(e.actual_margin - e.expected_margin) end as ats
             from price_events e
             join teams t on t.id = e.team_id
             join teams o on o.id = e.opponent_id
            where e.season = $1
         ), computed as (
           select team_id,
                  count(*) filter (where margin > 0)::int as w,
                  count(*) filter (where margin < 0)::int as l,
                  count(*) filter (where margin = 0)::int as t,
                  count(*) filter (where conf_game and margin > 0)::int as cw,
                  count(*) filter (where conf_game and margin < 0)::int as cl,
                  count(*) filter (where conf_game and margin = 0)::int as ct,
                  count(*) filter (where ats = 1)::int as aw,
                  count(*) filter (where ats = -1)::int as al,
                  count(*) filter (where ats = 0)::int as ap
             from games group by team_id
         )
         select t.id, t.conference,
                (t.record_season = $1 and t.wins is not null) as official,
                coalesce(case when t.record_season = $1 then t.wins end, c.w, 0) as wins,
                coalesce(case when t.record_season = $1 then t.losses end, c.l, 0) as losses,
                coalesce(case when t.record_season = $1 then t.ties end, c.t, 0) as ties,
                coalesce(case when t.record_season = $1 then t.conf_wins end, c.cw, 0) as conf_wins,
                coalesce(case when t.record_season = $1 then t.conf_losses end, c.cl, 0) as conf_losses,
                coalesce(case when t.record_season = $1 then t.conf_ties end, c.ct, 0) as conf_ties,
                coalesce(c.aw, 0) as ats_wins,
                coalesce(c.al, 0) as ats_losses,
                coalesce(c.ap, 0) as ats_pushes
           from teams t
           left join computed c on c.team_id = t.id`,
        [season]
      );
      return new Map(
        rows.map((r) => [
          r.id,
          {
            overall: { wins: r.wins, losses: r.losses, ties: r.ties },
            // Independents have no conference record.
            conference:
              r.conference === "FBS Independents"
                ? null
                : { wins: r.conf_wins, losses: r.conf_losses, ties: r.conf_ties },
            ats: { wins: r.ats_wins, losses: r.ats_losses, pushes: r.ats_pushes },
            official: r.official,
          },
        ])
      );
    },

    async getTeam(id) {
      const { rows } = await pool.query(`select ${TEAM_COLUMNS} from teams where id = $1`, [id]);
      return rows[0] || null;
    },

    async getPriceEvents(teamId, season) {
      const { rows } = await pool.query(
        `select e.id, e.season, e.week, e.opponent_id, o.name as opponent_name,
                e.team_score, e.opp_score, e.pct_change, e.price_after,
                e.expected_margin, e.actual_margin, e.is_real_line, e.summary, e.created_at
           from price_events e
           left join teams o on o.id = e.opponent_id
          where e.team_id = $1 and ($2::int is null or e.season = $2)
          order by e.season, e.week, e.id`,
        [teamId, season ?? null]
      );
      return rows;
    },

    // Upcoming (not yet completed) games for a team, from its perspective.
    async getUpcomingGames(teamId) {
      const { rows } = await pool.query(
        `select s.id, s.season, s.week,
                (s.home_team_id = $1) as is_home,
                case when s.home_team_id = $1 then s.away_team_id else s.home_team_id end as opponent_id,
                s.line
           from schedule s
          where not s.completed and $1 in (s.home_team_id, s.away_team_id)
          order by s.season, s.week, s.id`,
        [teamId]
      );
      return rows;
    },

    // Returns the account, creating it with starting cash on first sight.
    async getAccount(userId) {
      await pool.query("insert into users (id) values ($1) on conflict (id) do nothing", [userId]);
      const { rows } = await pool.query(
        `select user_id, display_name, cash, holdings_value, net_worth
           from user_net_worth where user_id = $1`,
        [userId]
      );
      return rows[0];
    },

    async getHoldings(userId) {
      const { rows } = await pool.query(
        `select h.team_id, t.name, t.mascot, h.shares, h.avg_cost, t.current_price,
                round(h.shares * t.current_price, 2) as market_value,
                round(h.shares * (t.current_price - h.avg_cost), 2) as unrealized_pl
           from holdings h join teams t on t.id = h.team_id
          where h.user_id = $1
          order by market_value desc, h.team_id`,
        [userId]
      );
      return rows;
    },

    async executeTrade(userId, teamId, side, shares) {
      const { rows } = await pool.query("select execute_trade($1, $2, $3, $4) as result", [
        userId,
        teamId,
        side,
        shares,
      ]);
      return rows[0].result;
    },

    async listTransactions(userId, { limit = 100, before } = {}) {
      const { rows } = await pool.query(
        `select id, team_id, side, shares, price, round(shares * price, 2) as amount, created_at
           from transactions
          where user_id = $1 and ($2::bigint is null or id < $2)
          order by id desc
          limit $3`,
        [userId, before ?? null, limit]
      );
      return rows;
    },

    // Sets (or with null, clears) the public display name. Throws
    // display_name_taken / invalid_display_name for the caller to map.
    async setDisplayName(userId, displayName) {
      await pool.query("insert into users (id) values ($1) on conflict (id) do nothing", [userId]);
      try {
        await pool.query("update users set display_name = $2 where id = $1", [userId, displayName]);
      } catch (err) {
        if (err.code === "23505") throw new Error("display_name_taken");
        if (err.code === "23514") throw new Error("invalid_display_name");
        throw err;
      }
    },

    // Named players only, best first. Ties share a rank; name breaks the tie
    // for display order.
    async leaderboard(limit = 25) {
      const { rows } = await pool.query(
        `select rank, user_id, display_name, net_worth
           from leaderboard
          order by rank, lower(display_name)
          limit $1`,
        [limit]
      );
      const { rows: total } = await pool.query("select count(*)::int as n from leaderboard");
      return { rows, players: total[0].n };
    },

    // One player's row, or null if they haven't opted in.
    async leaderboardEntry(userId) {
      const { rows } = await pool.query(
        "select rank, user_id, display_name, net_worth from leaderboard where user_id = $1",
        [userId]
      );
      return rows[0] || null;
    },
  };
}
