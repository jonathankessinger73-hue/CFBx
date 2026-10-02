-- Options: calls and puts on each team, sold and bought back by the house.
--
--   * Underlying: the team's football price (fundamental_price), which is
--     moved by games, lines, polls and news but not by trading hype, so
--     nobody can push a settlement price around by buying shares.
--   * Expirations: weekly, every Monday at noon ET (covering the week's line
--     moves, Saturday's games and Sunday's poll), plus one season-long
--     expiration that settles the Monday at noon after the national title
--     game (its payout is the signal; falls back to early February).
--   * 1 option = 1 share. Buy, or sell back what you hold; no writing.
--   * Pricing (option_quote): Black-Scholes with no interest, where the
--     variance comes from the games left before expiry times the team's
--     own typical game move, plus a little weekly drift for news. The house
--     sells 5% above that fair value and buys back 5% below it.
--   * Guardrails: a team's options pause while its game is on (open before
--     kickoff and after the final); at most 1,000 options per team per
--     player; option cost basis capped at 25% of the player's net worth.
--
-- Also here: nobody may hold more than 1,000 shares of one team.

create function market_param_options(p_name text) returns numeric
language sql immutable as $$
  select case p_name
    when 'max_per_team' then 1000          -- options per team per player, and shares per team
    when 'max_share_of_net_worth' then 0.25
    when 'spread' then 0.05                -- ask = fair x 1.05 + $0.01, bid = fair x 0.95 - $0.01
    when 'weekly_news_vol' then 0.015      -- price drift per week from lines, polls, news
    when 'default_game_vol' then 0.08      -- typical game move for a team with little history
    when 'min_game_vol' then 0.04
    when 'max_game_vol' then 0.25
  end
$$;

-- ---------------------------------------------------------------------------
-- Share cap: no new position above 1,000 shares of one team. (Only blocks
-- increases, so anyone already above it can still sell down.)
-- ---------------------------------------------------------------------------
create function holdings_position_limit() returns trigger
language plpgsql as $$
begin
  if new.shares > market_param_options('max_per_team')
     and new.shares > coalesce(case when tg_op = 'UPDATE' then old.shares end, 0) then
    raise exception 'position_limit';
  end if;
  return new;
end;
$$;
create trigger holdings_position_limit
  before insert or update on holdings
  for each row execute function holdings_position_limit();

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table option_series (
  id bigserial primary key,
  team_id text not null references teams(id),
  kind text not null check (kind in ('call', 'put')),
  strike numeric not null check (strike > 0),
  expiry_kind text not null check (expiry_kind in ('weekly', 'season')),
  season int not null,
  expires_at timestamptz,             -- null for a season series until the title game is known
  settled boolean not null default false,
  settle_price numeric,
  created_at timestamptz not null default now()
);
create index option_series_team_idx on option_series (team_id) where not settled;
create index option_series_expiry_idx on option_series (expires_at) where not settled;

create table option_positions (
  user_id uuid not null references users(id) on delete cascade,
  series_id bigint not null references option_series(id),
  qty int not null check (qty > 0),
  avg_cost numeric not null,
  primary key (user_id, series_id)
);

-- Every option buy, sell and settlement payout, append-only like transactions.
create table option_trades (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  series_id bigint not null references option_series(id),
  side text not null check (side in ('buy', 'sell', 'settle')),
  qty int not null check (qty > 0),
  price numeric not null,             -- per option (for 'settle': the payout per option)
  amount numeric not null,
  created_at timestamptz not null default now()
);
create index option_trades_user_idx on option_trades (user_id, id);
create trigger option_trades_no_update_delete
  before update or delete on option_trades
  for each row execute function transactions_append_only();

alter table option_series enable row level security;
alter table option_positions enable row level security;
alter table option_trades enable row level security;
create policy option_series_read on option_series for select to anon, authenticated using (true);
grant select on option_series to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------

-- Standard normal CDF (Abramowitz & Stegun 26.2.17, error < 7.5e-8).
create function norm_cdf(x double precision) returns double precision
language plpgsql immutable as $$
declare
  t double precision := 1 / (1 + 0.2316419 * abs(x));
  tail double precision;
begin
  tail := exp(-x * x / 2) / sqrt(2 * pi()) *
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return case when x >= 0 then 1 - tail else tail end;
end;
$$;

-- Fair value of one option with total variance p_var of the log price.
create function option_fair(p_kind text, p_spot numeric, p_strike numeric, p_var double precision)
returns numeric language plpgsql immutable as $$
declare
  s double precision := p_spot;
  k double precision := p_strike;
  sd double precision;
  d1 double precision;
  d2 double precision;
begin
  if p_var <= 1e-9 then
    return greatest(0, case when p_kind = 'call' then s - k else k - s end);
  end if;
  sd := sqrt(p_var);
  d1 := (ln(s / k) + p_var / 2) / sd;
  d2 := d1 - sd;
  if p_kind = 'call' then
    return greatest(0, s * norm_cdf(d1) - k * norm_cdf(d2));
  end if;
  return greatest(0, k * norm_cdf(-d2) - s * norm_cdf(-d1));
end;
$$;

-- A team's typical game move (root mean square of its game moves, as a
-- fraction), from this season and last, clamped to a sensible range.
create function team_game_vol(p_team_id text) returns double precision
language sql stable set search_path = public as $$
  select greatest(market_param_options('min_game_vol'), least(market_param_options('max_game_vol'),
           coalesce(case when count(*) >= 3 then sqrt(avg(power(pct_change / 100, 2))) end,
                    market_param_options('default_game_vol'))))::double precision
    from price_events
   where team_id = p_team_id and not vs_fcs
     and season >= (select coalesce(max(season), 0) from schedule) - 1
$$;

-- Is this team's game on right now? Options pause from kickoff until the
-- final is applied (or 6 hours after kickoff, whichever comes first).
create function options_paused(p_team_id text) returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from schedule s
     where not s.completed and p_team_id in (s.home_team_id, s.away_team_id)
       and s.start_date <= now() and s.start_date > now() - interval '6 hours'
  ) or exists (select 1 from teams where id = p_team_id and live_status is not null)
$$;

-- When a season series without a known expiry is assumed to settle, for
-- pricing only: around the national title game.
create function season_expiry_estimate(p_season int) returns timestamptz
language sql immutable as $$
  select make_timestamptz(p_season + 1, 1, 20, 17, 0, 0, 'UTC')
$$;

-- Bid, ask and fair value for one series right now.
create function option_quote(p_series_id bigint,
                             out fair numeric, out bid numeric, out ask numeric,
                             out underlying numeric, out paused boolean, out games_left int)
language plpgsql stable set search_path = public as $$
declare
  v_series option_series%rowtype;
  v_spot numeric;
  v_expiry timestamptz;
  v_weeks double precision;
  v_vol double precision;
  v_var double precision;
  v_spread numeric := market_param_options('spread');
begin
  select * into v_series from option_series where id = p_series_id;
  if not found then
    raise exception 'unknown_option';
  end if;
  select fundamental_price into v_spot from teams where id = v_series.team_id;
  underlying := v_spot;
  paused := options_paused(v_series.team_id);
  v_expiry := coalesce(v_series.expires_at, season_expiry_estimate(v_series.season));
  select count(*)::int into games_left
    from schedule s
   where not s.completed and v_series.team_id in (s.home_team_id, s.away_team_id)
     and (v_series.expiry_kind = 'season' or (s.start_date is not null and s.start_date < v_expiry));
  v_weeks := greatest(0, extract(epoch from (v_expiry - now())) / 604800);
  v_vol := team_game_vol(v_series.team_id);
  v_var := games_left * v_vol * v_vol + v_weeks * power(market_param_options('weekly_news_vol'), 2);
  fair := round(option_fair(v_series.kind, v_spot, v_series.strike, v_var), 4);
  ask := round(fair * (1 + v_spread) + 0.01, 2);
  bid := greatest(0, round(fair * (1 - v_spread) - 0.01, 2));
end;
$$;

-- ---------------------------------------------------------------------------
-- Series: next Monday noon ET, and keeping strikes near the current price
-- ---------------------------------------------------------------------------
create function next_option_expiry(p_after timestamptz) returns timestamptz
language plpgsql stable as $$
declare
  v_local timestamp := p_after at time zone 'America/New_York';
  v_monday timestamp := date_trunc('week', v_local) + interval '12 hours';
begin
  if v_monday <= v_local then
    v_monday := v_monday + interval '7 days';
  end if;
  return v_monday at time zone 'America/New_York';
end;
$$;

-- A "round" strike near p_price, in steps that suit the team's current
-- price p_ref (so all five strikes in a set use the same step): quarters
-- under $10, halves under $100, whole dollars above.
create function option_strike(p_price numeric, p_ref numeric) returns numeric
language sql immutable as $$
  select case
    when p_ref < 10 then greatest(0.25, round(p_price * 4) / 4)
    when p_ref < 100 then round(p_price * 2) / 2
    else round(p_price)
  end
$$;

-- Makes sure every team has calls and puts near its current football price
-- for the next weekly expiry and for the season. A new set of five strikes
-- is listed when none is within 2.5% (weekly) / 5% (season) of the price.
-- Returns how many series it created.
create function ensure_option_series() returns int
language plpgsql set search_path = public as $$
declare
  v_weekly timestamptz := next_option_expiry(now());
  v_season int := (select coalesce(max(season), extract(year from now())::int) from schedule);
  v_season_over boolean;
  v_team record;
  v_count int := 0;
  v_k int;
  v_strike numeric;
  v_kind text;
begin
  v_season_over := exists (select 1 from dividends where season = v_season and kind = 'national_title');
  for v_team in select id, fundamental_price as price from teams loop
    -- weekly
    if not exists (
      select 1 from option_series
       where team_id = v_team.id and expiry_kind = 'weekly' and expires_at = v_weekly and not settled
         and strike between v_team.price * 0.975 and v_team.price * 1.025
    ) then
      for v_k in -2..2 loop
        v_strike := option_strike(v_team.price * (1 + v_k * 0.05), v_team.price);
        foreach v_kind in array array['call', 'put'] loop
          insert into option_series (team_id, kind, strike, expiry_kind, season, expires_at)
          select v_team.id, v_kind, v_strike, 'weekly', v_season, v_weekly
           where not exists (select 1 from option_series where team_id = v_team.id and kind = v_kind
                               and strike = v_strike and expiry_kind = 'weekly' and expires_at = v_weekly);
          if found then v_count := v_count + 1; end if;
        end loop;
      end loop;
    end if;
    -- season
    if not v_season_over and not exists (
      select 1 from option_series
       where team_id = v_team.id and expiry_kind = 'season' and season = v_season and not settled
         and strike between v_team.price * 0.95 and v_team.price * 1.05
    ) then
      for v_k in -2..2 loop
        v_strike := option_strike(v_team.price * (1 + v_k * 0.10), v_team.price);
        foreach v_kind in array array['call', 'put'] loop
          insert into option_series (team_id, kind, strike, expiry_kind, season, expires_at)
          select v_team.id, v_kind, v_strike, 'season', v_season, null
           where not exists (select 1 from option_series where team_id = v_team.id and kind = v_kind
                               and strike = v_strike and expiry_kind = 'season' and season = v_season and not settled);
          if found then v_count := v_count + 1; end if;
        end loop;
      end loop;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settlement: pays out expired series on the football price, in cash.
-- Run every few minutes by the API server (and the daily job).
-- ---------------------------------------------------------------------------
create function settle_options() returns int
language plpgsql set search_path = public as $$
declare
  v_series record;
  v_payout numeric;
  v_count int := 0;
begin
  -- Season series learn their expiry once the national title game is paid
  -- out (the Monday noon after), or by early February at the latest.
  update option_series s set expires_at = next_option_expiry(d.paid_at)
    from dividends d
   where s.expiry_kind = 'season' and s.expires_at is null and not s.settled
     and d.season = s.season and d.kind = 'national_title';
  update option_series set expires_at = next_option_expiry(make_timestamptz(season + 1, 2, 1, 12, 0, 0, 'UTC'))
   where expiry_kind = 'season' and expires_at is null and not settled
     and now() >= make_timestamptz(season + 1, 2, 1, 12, 0, 0, 'UTC');

  for v_series in
    select s.id, s.kind, s.strike, t.fundamental_price as price
      from option_series s join teams t on t.id = s.team_id
     where not s.settled and s.expires_at <= now()
     order by s.id
       for update of s
  loop
    v_payout := round(greatest(0, case when v_series.kind = 'call'
                                        then v_series.price - v_series.strike
                                        else v_series.strike - v_series.price end), 2);
    -- A settle row for every holder, including $0 ("expired worthless").
    insert into option_trades (user_id, series_id, side, qty, price, amount)
      select user_id, v_series.id, 'settle', qty, v_payout, round(qty * v_payout, 2)
        from option_positions where series_id = v_series.id;
    if v_payout > 0 then
      update users u set cash = u.cash + round(p.qty * v_payout, 2)
        from option_positions p where p.series_id = v_series.id and p.user_id = u.id;
    end if;
    delete from option_positions where series_id = v_series.id;
    update option_series set settled = true, settle_price = v_series.price where id = v_series.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trading
-- ---------------------------------------------------------------------------
create function execute_option_trade(p_user_id uuid, p_series_id bigint, p_side text, p_qty int)
returns jsonb
language plpgsql set search_path = public as $$
declare
  v_series option_series%rowtype;
  v_quote record;
  v_cash numeric;
  v_pos option_positions%rowtype;
  v_team_qty int;
  v_cost_basis numeric;
  v_net_worth numeric;
  v_price numeric;
  v_amount numeric;
  v_new_qty int;
  v_new_avg numeric;
begin
  if p_side is null or p_side not in ('buy', 'sell') then raise exception 'invalid_side'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'invalid_shares'; end if;

  select * into v_series from option_series where id = p_series_id for update;
  if not found then raise exception 'unknown_option'; end if;
  if v_series.settled or (v_series.expires_at is not null and v_series.expires_at <= now()) then
    raise exception 'option_expired';
  end if;
  select * into v_quote from option_quote(p_series_id);
  if v_quote.paused then raise exception 'options_paused'; end if;

  insert into users (id) values (p_user_id) on conflict (id) do nothing;
  select cash into v_cash from users where id = p_user_id for update;
  select * into v_pos from option_positions where user_id = p_user_id and series_id = p_series_id for update;

  if p_side = 'buy' then
    v_price := v_quote.ask;
    v_amount := round(v_price * p_qty, 2);
    if v_cash < v_amount then raise exception 'insufficient_funds'; end if;
    select coalesce(sum(p.qty), 0) into v_team_qty
      from option_positions p join option_series s on s.id = p.series_id
     where p.user_id = p_user_id and s.team_id = v_series.team_id;
    if v_team_qty + p_qty > market_param_options('max_per_team') then raise exception 'position_limit'; end if;
    select coalesce(sum(qty * avg_cost), 0) into v_cost_basis from option_positions where user_id = p_user_id;
    select net_worth into v_net_worth from user_net_worth where user_id = p_user_id;
    if v_cost_basis + v_amount > market_param_options('max_share_of_net_worth') * v_net_worth then
      raise exception 'options_limit';
    end if;
    v_cash := v_cash - v_amount;
    v_new_qty := coalesce(v_pos.qty, 0) + p_qty;
    v_new_avg := round((coalesce(v_pos.avg_cost, 0) * coalesce(v_pos.qty, 0) + v_amount) / v_new_qty, 4);
    insert into option_positions (user_id, series_id, qty, avg_cost)
      values (p_user_id, p_series_id, v_new_qty, v_new_avg)
      on conflict (user_id, series_id) do update set qty = excluded.qty, avg_cost = excluded.avg_cost;
  else
    if coalesce(v_pos.qty, 0) < p_qty then raise exception 'insufficient_options'; end if;
    v_price := v_quote.bid;
    v_amount := round(v_price * p_qty, 2);
    v_cash := v_cash + v_amount;
    v_new_qty := v_pos.qty - p_qty;
    v_new_avg := v_pos.avg_cost;
    if v_new_qty = 0 then
      delete from option_positions where user_id = p_user_id and series_id = p_series_id;
    else
      update option_positions set qty = v_new_qty where user_id = p_user_id and series_id = p_series_id;
    end if;
  end if;

  update users set cash = v_cash where id = p_user_id;
  insert into option_trades (user_id, series_id, side, qty, price, amount)
    values (p_user_id, p_series_id, p_side, p_qty, v_price, v_amount);

  return jsonb_build_object(
    'series_id', p_series_id,
    'team_id', v_series.team_id,
    'kind', v_series.kind,
    'strike', v_series.strike,
    'side', p_side,
    'qty', p_qty,
    'price', v_price,
    'amount', v_amount,
    'cash', v_cash,
    'position', case when v_new_qty > 0 then jsonb_build_object('qty', v_new_qty, 'avg_cost', round(v_new_avg, 2)) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Net worth now includes options, at what selling them back would bring.
-- ---------------------------------------------------------------------------
create or replace view user_net_worth as
select u.id as user_id,
       u.display_name,
       u.cash,
       coalesce((select sum(sell_value(h.team_id, h.shares)) from holdings h where h.user_id = u.id), 0)
         as holdings_value,
       u.cash
         + coalesce((select sum(sell_value(h.team_id, h.shares)) from holdings h where h.user_id = u.id), 0)
         + coalesce((select sum(p.qty * (option_quote(p.series_id)).bid) from option_positions p where p.user_id = u.id), 0)
         as net_worth,
       coalesce((select sum(p.qty * (option_quote(p.series_id)).bid) from option_positions p where p.user_id = u.id), 0)
         as options_value
  from users u;

revoke all on function market_param_options(text), norm_cdf(double precision),
  option_fair(text, numeric, numeric, double precision), team_game_vol(text), options_paused(text),
  season_expiry_estimate(int), option_quote(bigint), next_option_expiry(timestamptz), option_strike(numeric, numeric),
  ensure_option_series(), settle_options(), execute_option_trade(uuid, bigint, text, int)
  from public, anon, authenticated;
grant execute on function market_param_options(text), norm_cdf(double precision),
  option_fair(text, numeric, numeric, double precision), team_game_vol(text), options_paused(text),
  season_expiry_estimate(int), option_quote(bigint), next_option_expiry(timestamptz), option_strike(numeric, numeric),
  ensure_option_series(), settle_options(), execute_option_trade(uuid, bigint, text, int)
  to service_role;
