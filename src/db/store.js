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

    async leaderboard(limit = 25) {
      const { rows } = await pool.query(
        `select user_id, display_name, net_worth
           from user_net_worth
          order by net_worth desc, user_id
          limit $1`,
        [limit]
      );
      return rows;
    },
  };
}
