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
  "position_limit",
]);

// Errors raised by execute_option_trade that are the caller's fault.
export const OPTION_ERRORS = new Set([
  "invalid_side",
  "invalid_shares",
  "unknown_option",
  "option_expired",
  "options_paused",
  "insufficient_funds",
  "insufficient_options",
  "position_limit",
  "options_limit",
]);

const TEAM_COLUMNS = `id, name, mascot, conference, strength, primary_color, secondary_color,
  ipo_price, current_price, last_change_pct, last_covered, last_expected, last_actual,
  last_line_is_real, logo_url, logo_dark_url, live_status`;

const round2 = (n) => Math.round(n * 100) / 100;

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
                coalesce(array_agg(e.price_after order by s.season_type = 'postseason', e.week, e.id)
                           filter (where e.id is not null), '{}') as prices
           from teams t
           left join price_events e on e.team_id = t.id and e.season = $1
           left join schedule s on s.id = e.schedule_id
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
                  coalesce(t.conference = o.conference and t.conference <> 'FBS Independents', false) as conf_game,
                  case when e.is_real_line then sign(e.actual_margin - e.expected_margin) end as ats
             from price_events e
             join teams t on t.id = e.team_id
             left join teams o on o.id = e.opponent_id -- null for FCS opponents
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
        `select e.id, e.season, e.week, e.opponent_id, coalesce(o.name, e.opponent_name) as opponent_name, e.vs_fcs,
                e.team_score, e.opp_score, e.pct_change, e.price_after,
                e.expected_margin, e.actual_margin, e.is_real_line, e.summary, e.created_at,
                coalesce(s.season_type, 'regular') as season_type, s.notes
           from price_events e
           left join teams o on o.id = e.opponent_id
           left join schedule s on s.id = e.schedule_id
          where e.team_id = $1 and ($2::int is null or e.season = $2)
          order by e.season, s.season_type = 'postseason', e.week, e.id`,
        [teamId, season ?? null]
      );
      return rows;
    },

    // Recent non-game price moves (line moves, polls, ...), newest first.
    async getMarketMoves(teamId, limit = 15) {
      const { rows } = await pool.query(
        `select id, season, week, kind, pct_change, price_after, summary, created_at
           from market_moves where team_id = $1
          order by created_at desc, id desc limit $2`,
        [teamId, limit]
      );
      return rows;
    },

    // Upcoming (not yet completed) games for a team, from its perspective.
    async getUpcomingGames(teamId) {
      const { rows } = await pool.query(
        `select s.id, s.season, s.week,
                (s.home_team_id = $1) as is_home,
                case when s.home_team_id = $1 then s.away_team_id else s.home_team_id end as opponent_id,
                s.line, s.season_type, s.notes
           from schedule s
          where not s.completed and $1 in (s.home_team_id, s.away_team_id)
          order by s.season, s.season_type = 'postseason', s.week, s.id`,
        [teamId]
      );
      return rows;
    },

    // Returns the account, creating it with starting cash on first sight.
    async getAccount(userId) {
      await pool.query("insert into users (id) values ($1) on conflict (id) do nothing", [userId]);
      const { rows } = await pool.query(
        `select user_id, display_name, cash, holdings_value, options_value, net_worth
           from user_net_worth where user_id = $1`,
        [userId]
      );
      return rows[0];
    },

    async getHoldings(userId) {
      const { rows } = await pool.query(
        `select team_id, name, mascot, shares, avg_cost, current_price, market_value,
                round(market_value - shares * avg_cost, 2) as unrealized_pl
           from (select h.team_id, t.name, t.mascot, h.shares, h.avg_cost, t.current_price,
                        -- what selling the whole position now would bring in
                        sell_value(h.team_id, h.shares) as market_value
                   from holdings h join teams t on t.id = h.team_id
                  where h.user_id = $1) x
          order by market_value desc, team_id`,
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

    // Season payouts this player received, newest first.
    async listPayouts(userId) {
      const { rows } = await pool.query(
        `select d.team_id, d.season, d.kind, d.summary, d.per_share, p.shares, p.amount, d.paid_at
           from dividend_payments p join dividends d on d.id = p.dividend_id
          where p.user_id = $1
          order by d.paid_at desc, d.id desc`,
        [userId]
      );
      return rows;
    },

    // A team's open options with live quotes, nearest expiry first.
    async getOptionBoard(teamId) {
      const { rows } = await pool.query(
        `select s.id, s.kind, s.strike, s.expiry_kind, s.expires_at, q.bid, q.ask, q.underlying, q.paused, q.games_left
           from option_series s cross join lateral option_quote(s.id) q
          where s.team_id = $1 and not s.settled and (s.expires_at is null or s.expires_at > now())
          order by s.expires_at nulls last, s.kind, s.strike`,
        [teamId]
      );
      return rows;
    },

    async executeOptionTrade(userId, seriesId, side, qty) {
      const { rows } = await pool.query("select execute_option_trade($1, $2, $3, $4) as result", [
        userId,
        seriesId,
        side,
        qty,
      ]);
      return rows[0].result;
    },

    // A player's open options (valued at the buy-back price) and recent
    // option activity, including settlement payouts.
    async getOptionAccount(userId) {
      const { rows: positions } = await pool.query(
        `select p.series_id, s.team_id, s.kind, s.strike, s.expiry_kind, s.expires_at, p.qty, p.avg_cost,
                q.bid, q.paused, round(p.qty * q.bid, 2) as value,
                round(p.qty * (q.bid - p.avg_cost), 2) as unrealized_pl
           from option_positions p
           join option_series s on s.id = p.series_id
           cross join lateral option_quote(s.id) q
          where p.user_id = $1
          order by s.expires_at nulls last, s.team_id, s.kind, s.strike`,
        [userId]
      );
      const { rows: activity } = await pool.query(
        `select t.id, t.side, t.qty, t.price, t.amount, t.created_at,
                s.team_id, s.kind, s.strike, s.expiry_kind, s.expires_at, s.settle_price
           from option_trades t join option_series s on s.id = t.series_id
          where t.user_id = $1
          order by t.id desc limit 25`,
        [userId]
      );
      return { positions, activity };
    },

    // One player's stake in one team: current position, total return on
    // everything they've done with the team (shares, options, payouts), and
    // the history behind it, newest first.
    async getTeamAccount(userId, teamId) {
      const [{ rows: hold }, { rows: opts }, { rows: history }] = await Promise.all([
        pool.query(
          `select h.shares, h.avg_cost, sell_value(h.team_id, h.shares) as value
             from holdings h where h.user_id = $1 and h.team_id = $2`,
          [userId, teamId]
        ),
        pool.query(
          `select coalesce(sum(p.qty * (option_quote(p.series_id)).bid), 0) as value, coalesce(sum(p.qty), 0)::int as qty
             from option_positions p join option_series s on s.id = p.series_id
            where p.user_id = $1 and s.team_id = $2`,
          [userId, teamId]
        ),
        pool.query(
          `select * from (
             select 'shares' as kind, t.side, t.shares as qty, t.price,
                    coalesce(t.amount, round(t.shares * t.price, 2)) as amount, t.created_at,
                    null::text as option_kind, null::numeric as strike, null::text as summary
               from transactions t where t.user_id = $1 and t.team_id = $2
             union all
             select 'option', o.side, o.qty, o.price, o.amount, o.created_at, s.kind, s.strike, null
               from option_trades o join option_series s on s.id = o.series_id
              where o.user_id = $1 and s.team_id = $2
             union all
             select 'payout', 'payout', p.shares, d.per_share, p.amount, d.paid_at, null, null, d.summary
               from dividend_payments p join dividends d on d.id = p.dividend_id
              where p.user_id = $1 and d.team_id = $2
           ) x order by created_at desc`,
          [userId, teamId]
        ),
      ]);
      const sum = (pred) => history.filter(pred).reduce((n, h) => n + h.amount, 0);
      const invested = sum((h) => h.side === "buy");
      const returned = sum((h) => h.side !== "buy");
      const sharesValue = hold[0]?.value ?? 0;
      const optionsValue = opts[0].value;
      const totalReturn = round2(returned + sharesValue + optionsValue - invested);
      return {
        team_id: teamId,
        shares: hold[0]?.shares ?? 0,
        avg_cost: hold[0]?.avg_cost ?? null,
        shares_value: round2(sharesValue),
        options_qty: opts[0].qty,
        options_value: round2(optionsValue),
        invested: round2(invested),
        returned: round2(returned),
        total_return: totalReturn,
        total_return_pct: invested > 0 ? round2((totalReturn / invested) * 100) : null,
        history,
      };
    },

    // What an order would fill at right now (the same math execute_trade uses).
    async quoteTrade(teamId, side, shares) {
      const { rows } = await pool.query("select quote_trade($1, $2, $3) as quote", [teamId, side, shares]);
      return rows[0].quote;
    },

    async listTransactions(userId, { limit = 100, before } = {}) {
      const { rows } = await pool.query(
        `select id, team_id, side, shares, price, coalesce(amount, round(shares * price, 2)) as amount, created_at
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
