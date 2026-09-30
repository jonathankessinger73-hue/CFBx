-- Trading moves prices. Each team's displayed price has three parts:
--
--   current_price = fundamental_price x (1 + hype) x (1 + live_pct / 100)
--
--   fundamental_price  moved by news: final scores, and later line moves,
--                      polls and other events (apply_* functions below)
--   hype               moved by trading: buying pushes it up, selling down,
--                      capped at +/-15% and fading back to 0 (half-life 1 day)
--   live_pct           in-game move while a game is being played, 0 otherwise
--
-- current_price stays the one number everything else reads (trades, net
-- worth, the API), kept in sync by market_price(). Constants live in
-- market_param() so they're in one place.

create function market_param(p_name text) returns numeric
language sql immutable as $$
  select case p_name
    when 'hype_cap' then 0.15             -- hype stays within +/-15%
    when 'spread' then 0.005              -- buy/sell gap: buyers pay +0.25%, sellers get -0.25%
    when 'half_life_hours' then 24        -- hype halves every day
    when 'depth_per_player' then 40000    -- $ of trading per 100% hype, per active player
    when 'min_players' then 5             -- depth never assumes fewer players than this
    when 'active_days' then 14            -- "active player" = traded in the last 14 days
  end
$$;

alter table teams
  add column fundamental_price numeric,
  add column hype numeric not null default 0,
  add column hype_updated_at timestamptz not null default now(),
  add column live_pct numeric not null default 0;
update teams set fundamental_price = current_price;
alter table teams alter column fundamental_price set not null;
alter table teams add constraint teams_hype_cap check (abs(hype) <= 0.15);

-- Inserts that only give current_price (the seed script) start with no hype.
create function teams_default_fundamental() returns trigger
language plpgsql as $$
begin
  new.fundamental_price := coalesce(new.fundamental_price, new.current_price);
  return new;
end;
$$;
create trigger teams_default_fundamental
  before insert on teams
  for each row execute function teams_default_fundamental();

-- Trades now fill along a curve, so the per-share price is an average; keep
-- the exact total too. Older rows have no amount (it was shares x price).
alter table transactions add column amount numeric;
create index transactions_created_idx on transactions (created_at);

-- Non-game news that moved a price (line moves, polls, ...). Game results
-- stay in price_events. (kind, ref, team_id) makes each move apply once.
create table market_moves (
  id bigserial primary key,
  team_id text not null references teams(id),
  season int not null,
  week int,
  kind text not null,
  ref text not null,
  pct_change numeric not null,
  price_after numeric not null,
  summary text not null,
  created_at timestamptz not null default now(),
  unique (kind, ref, team_id)
);
create index market_moves_team_idx on market_moves (team_id, created_at);
alter table market_moves enable row level security;
create policy market_moves_read on market_moves for select to anon, authenticated using (true);
grant select on market_moves to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------

create function market_price(p_fundamental numeric, p_hype numeric, p_live_pct numeric)
returns numeric language sql immutable as $$
  select greatest(3, round(p_fundamental * (1 + p_hype) * (1 + p_live_pct / 100), 2))
$$;

create function decayed_hype(p_hype numeric, p_since timestamptz, p_at timestamptz)
returns numeric language sql immutable as $$
  select case
    when p_hype = 0 or p_at <= p_since then p_hype
    else round(p_hype * power(0.5, extract(epoch from (p_at - p_since)) / (market_param('half_life_hours') * 3600)), 6)
  end
$$;

-- Fill `p_shares` shares against the curve price(h) = base x (1 + h), where
-- each share traded moves h by base / depth. Buying walks h up and selling
-- walks it down, so a big order pays a rising (or gets a falling) average
-- price. Past the cap the rest fills flat at the capped price. Then the
-- spread: buyers pay half of it on top, sellers give half up.
create function trade_fill(p_base numeric, p_hype numeric, p_side text, p_shares int, p_depth numeric,
                           out amount numeric, out hype_after numeric)
language plpgsql immutable as $$
declare
  v_cap numeric := market_param('hype_cap');
  v_sign int := case when p_side = 'buy' then 1 else -1 end;
  v_curve_shares numeric;
  v_gross numeric;
begin
  hype_after := greatest(-v_cap, least(v_cap, p_hype + v_sign * p_shares * p_base / p_depth));
  v_curve_shares := least(p_shares, abs(hype_after - p_hype) * p_depth / p_base);
  v_gross := v_curve_shares * p_base * (1 + (p_hype + hype_after) / 2)
           + (p_shares - v_curve_shares) * p_base * (1 + hype_after);
  v_gross := greatest(v_gross, 3 * p_shares);  -- the $3 price floor applies to fills too
  amount := round(v_gross * (1 + v_sign * market_param('spread') / 2), 2);
  hype_after := round(hype_after, 6);
end;
$$;

-- Dollars of trading that move hype by 100%, scaled by how many people are
-- trading, so a handful of friends can't swing a price as far as a crowd.
create function market_depth() returns numeric
language sql stable set search_path = public as $$
  select market_param('depth_per_player') * greatest(
    market_param('min_players'),
    (select count(distinct user_id) from transactions
      where created_at > now() - make_interval(days => market_param('active_days')::int)))
$$;

-- ---------------------------------------------------------------------------
-- Hype fades: run every few minutes by the API server (and the daily job).
-- ---------------------------------------------------------------------------
create function decay_hype() returns int
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  update teams set
    hype = case when abs(decayed_hype(hype, hype_updated_at, now())) < 0.0005 then 0
                else decayed_hype(hype, hype_updated_at, now()) end,
    hype_updated_at = now(),
    current_price = market_price(fundamental_price,
      case when abs(decayed_hype(hype, hype_updated_at, now())) < 0.0005 then 0
           else decayed_hype(hype, hype_updated_at, now()) end,
      live_pct)
  where hype <> 0;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trading
-- ---------------------------------------------------------------------------

-- What an order would cost right now, without placing it.
create function quote_trade(p_team_id text, p_side text, p_shares int)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_team teams%rowtype;
  v_hype numeric;
  v_fill record;
  v_base numeric;
begin
  if p_side is null or p_side not in ('buy', 'sell') then raise exception 'invalid_side'; end if;
  if p_shares is null or p_shares < 1 then raise exception 'invalid_shares'; end if;
  select * into v_team from teams where id = p_team_id;
  if not found then raise exception 'unknown_team'; end if;
  v_hype := decayed_hype(v_team.hype, v_team.hype_updated_at, now());
  v_base := v_team.fundamental_price * (1 + v_team.live_pct / 100);
  select * into v_fill from trade_fill(v_base, v_hype, p_side, p_shares, market_depth());
  return jsonb_build_object(
    'team_id', p_team_id,
    'side', p_side,
    'shares', p_shares,
    'amount', v_fill.amount,
    'avg_price', round(v_fill.amount / p_shares, 2),
    'price_before', market_price(v_team.fundamental_price, v_hype, v_team.live_pct),
    'price_after', market_price(v_team.fundamental_price, v_fill.hype_after, v_team.live_pct)
  );
end;
$$;

-- execute_trade: the only way cash or holdings change. The price always
-- comes from `teams`; callers cannot supply one. Same errors as before.
create or replace function execute_trade(p_user_id uuid, p_team_id text, p_side text, p_shares int)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_team teams%rowtype;
  v_hype numeric;
  v_base numeric;
  v_fill record;
  v_cash numeric;
  v_old_shares int;
  v_old_avg numeric;
  v_new_shares int;
  v_new_avg numeric;
  v_price_after numeric;
  v_tx_id bigint;
begin
  if p_side is null or p_side not in ('buy', 'sell') then
    raise exception 'invalid_side';
  end if;
  if p_shares is null or p_shares < 1 then
    raise exception 'invalid_shares';
  end if;

  -- FOR UPDATE: this trade moves the price, so trades on one team run one
  -- at a time and each fills against the price the previous one left.
  select * into v_team from teams where id = p_team_id for update;
  if not found then
    raise exception 'unknown_team';
  end if;

  insert into users (id) values (p_user_id) on conflict (id) do nothing;
  select cash into v_cash from users where id = p_user_id for update;

  select shares, avg_cost into v_old_shares, v_old_avg
    from holdings where user_id = p_user_id and team_id = p_team_id for update;
  v_old_shares := coalesce(v_old_shares, 0);
  v_old_avg := coalesce(v_old_avg, 0);

  if p_side = 'sell' and v_old_shares < p_shares then
    raise exception 'insufficient_shares';
  end if;

  v_hype := decayed_hype(v_team.hype, v_team.hype_updated_at, now());
  v_base := v_team.fundamental_price * (1 + v_team.live_pct / 100);
  select * into v_fill from trade_fill(v_base, v_hype, p_side, p_shares, market_depth());

  if p_side = 'buy' then
    if v_cash < v_fill.amount then
      raise exception 'insufficient_funds';
    end if;
    v_cash := v_cash - v_fill.amount;
    v_new_shares := v_old_shares + p_shares;
    v_new_avg := round((v_old_avg * v_old_shares + v_fill.amount) / v_new_shares, 2);
    insert into holdings (user_id, team_id, shares, avg_cost)
      values (p_user_id, p_team_id, v_new_shares, v_new_avg)
      on conflict (user_id, team_id)
      do update set shares = excluded.shares, avg_cost = excluded.avg_cost;
  else
    v_cash := v_cash + v_fill.amount;
    v_new_shares := v_old_shares - p_shares;
    v_new_avg := v_old_avg;
    if v_new_shares = 0 then
      delete from holdings where user_id = p_user_id and team_id = p_team_id;
    else
      update holdings set shares = v_new_shares
        where user_id = p_user_id and team_id = p_team_id;
    end if;
  end if;

  update users set cash = v_cash where id = p_user_id;

  v_price_after := market_price(v_team.fundamental_price, v_fill.hype_after, v_team.live_pct);
  update teams set
    hype = v_fill.hype_after,
    hype_updated_at = now(),
    current_price = v_price_after,
    updated_at = now()
  where id = p_team_id;

  insert into transactions (user_id, team_id, side, shares, price, amount)
    values (p_user_id, p_team_id, p_side, p_shares, round(v_fill.amount / p_shares, 2), v_fill.amount)
    returning id into v_tx_id;

  return jsonb_build_object(
    'transaction_id', v_tx_id,
    'team_id', p_team_id,
    'side', p_side,
    'shares', p_shares,
    'price', round(v_fill.amount / p_shares, 2),
    'amount', v_fill.amount,
    'price_after', v_price_after,
    'cash', v_cash,
    'holding', case when v_new_shares > 0
      then jsonb_build_object('shares', v_new_shares, 'avg_cost', v_new_avg)
      else null end
  );
end;
$$;

-- What a holding would fetch if sold right now: the same fill a sell order
-- gets (walking the price down, less the spread). Net worth and the
-- leaderboard use this, so pushing a price up with your own buying can't
-- inflate your own net worth: it only pays if you can actually sell higher.
create function sell_value(p_team_id text, p_shares int) returns numeric
language sql stable set search_path = public as $$
  select (trade_fill(t.fundamental_price * (1 + t.live_pct / 100),
                     decayed_hype(t.hype, t.hype_updated_at, now()),
                     'sell', p_shares, market_depth())).amount
    from teams t where t.id = p_team_id
$$;

create or replace view user_net_worth as
select u.id as user_id,
       u.display_name,
       u.cash,
       coalesce(sum(sell_value(h.team_id, h.shares)), 0) as holdings_value,
       u.cash + coalesce(sum(sell_value(h.team_id, h.shares)), 0) as net_worth
  from users u
  left join holdings h on h.user_id = u.id
 group by u.id;

-- ---------------------------------------------------------------------------
-- News moves. Every price move from outside trading goes through move_price:
-- it moves fundamental_price by p_pct (with the $3 floor), brings hype up to
-- date, and returns the realized move and the new displayed price. The row
-- must already be locked by the caller.
-- ---------------------------------------------------------------------------
create function move_price(p_team_id text, p_pct numeric, p_reset_live boolean,
                           out pct_change numeric, out price_after numeric)
language plpgsql set search_path = public as $$
declare
  v_team teams%rowtype;
  v_fundamental numeric;
  v_hype numeric;
  v_live numeric;
begin
  select * into v_team from teams where id = p_team_id;
  if not found then
    raise exception 'unknown_team';
  end if;
  v_fundamental := greatest(3, round(v_team.fundamental_price * (1 + p_pct / 100), 4));
  v_hype := decayed_hype(v_team.hype, v_team.hype_updated_at, now());
  v_live := case when p_reset_live then 0 else v_team.live_pct end;
  pct_change := round((v_fundamental - v_team.fundamental_price) / v_team.fundamental_price * 100, 2);
  price_after := market_price(v_fundamental, v_hype, v_live);
  update teams set
    fundamental_price = v_fundamental,
    hype = v_hype,
    hype_updated_at = now(),
    live_pct = v_live,
    current_price = price_after,
    updated_at = now()
  where id = p_team_id;
end;
$$;

-- A news move logged in market_moves. Idempotent: false if (kind, ref, team)
-- was already applied.
create function apply_news_move(p_team_id text, p_season int, p_week int, p_kind text, p_ref text,
                                p_pct numeric, p_summary text)
returns boolean
language plpgsql set search_path = public as $$
declare
  v_move record;
begin
  perform 1 from teams where id = p_team_id for update;
  if not found then
    raise exception 'unknown_team';
  end if;
  if exists (select 1 from market_moves where kind = p_kind and ref = p_ref and team_id = p_team_id) then
    return false;
  end if;
  select * into v_move from move_price(p_team_id, p_pct, false);
  insert into market_moves (team_id, season, week, kind, ref, pct_change, price_after, summary)
    values (p_team_id, p_season, p_week, p_kind, p_ref, v_move.pct_change, v_move.price_after, p_summary);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_game_result, now pct-based: the job sends each team's move as a
-- percentage and the database applies it to whatever the price is at that
-- moment, so trades happening at the same time can't make it stale.
-- Idempotent: returns false if the game was already applied.
--
-- p_teams:  [{id, pct, last_covered, last_expected, last_actual, last_line_is_real}, ...]
-- p_events: [{team_id, opponent_id, team_score, opp_score, expected_margin,
--             actual_margin, is_real_line, summary}, ...]
-- ---------------------------------------------------------------------------
create or replace function apply_game_result(
  p_schedule_id bigint,
  p_home_score int,
  p_away_score int,
  p_cfbd_game_id bigint,
  p_teams jsonb,
  p_events jsonb
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_game schedule%rowtype;
  v_team jsonb;
  v_move record;
  v_moves jsonb := '{}';
begin
  select * into v_game from schedule where id = p_schedule_id for update;
  if not found then
    raise exception 'unknown_game';
  end if;
  if v_game.completed then
    return false;
  end if;

  -- Lock both teams in a fixed order so two games can't deadlock.
  perform 1 from teams
    where id in (select e->>'id' from jsonb_array_elements(p_teams) e)
    order by id for update;

  for v_team in select * from jsonb_array_elements(p_teams) loop
    select * into v_move from move_price(v_team->>'id', (v_team->>'pct')::numeric, true);
    update teams set
      last_change_pct = v_move.pct_change,
      last_covered = (v_team->>'last_covered')::boolean,
      last_expected = (v_team->>'last_expected')::numeric,
      last_actual = (v_team->>'last_actual')::numeric,
      last_line_is_real = (v_team->>'last_line_is_real')::boolean
    where id = v_team->>'id';
    v_moves := v_moves || jsonb_build_object(v_team->>'id',
      jsonb_build_object('pct', v_move.pct_change, 'price', v_move.price_after));
  end loop;

  insert into price_events (
    team_id, season, week, schedule_id, opponent_id, team_score, opp_score,
    pct_change, price_after, expected_margin, actual_margin, is_real_line, summary
  )
  select e->>'team_id', v_game.season, v_game.week, p_schedule_id, e->>'opponent_id',
         (e->>'team_score')::int, (e->>'opp_score')::int,
         (v_moves->(e->>'team_id')->>'pct')::numeric, (v_moves->(e->>'team_id')->>'price')::numeric,
         (e->>'expected_margin')::numeric, (e->>'actual_margin')::numeric,
         (e->>'is_real_line')::boolean, e->>'summary'
    from jsonb_array_elements(p_events) e;

  update schedule set
    home_score = p_home_score,
    away_score = p_away_score,
    completed = true,
    cfbd_game_id = coalesce(p_cfbd_game_id, cfbd_game_id),
    updated_at = now()
  where id = p_schedule_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_fcs_result, now pct-based (same reason). A result reported late for
-- an earlier week doesn't overwrite the "last game" fields, and a no-change
-- result is charted at the price the team had that week.
-- ---------------------------------------------------------------------------
drop function apply_fcs_result(text, int, int, bigint, text, int, int, numeric, numeric, numeric, text);
create function apply_fcs_result(
  p_team_id text,
  p_season int,
  p_week int,
  p_cfbd_game_id bigint,
  p_opponent_name text,
  p_team_score int,
  p_opp_score int,
  p_pct numeric,
  p_summary text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_team teams%rowtype;
  v_latest boolean;
  v_move record;
  v_price_after numeric;
begin
  select * into v_team from teams where id = p_team_id for update;
  if not found then
    raise exception 'unknown_team';
  end if;
  if exists (select 1 from price_events where cfbd_game_id = p_cfbd_game_id and team_id = p_team_id) then
    return false;
  end if;

  v_latest := not exists (
    select 1 from price_events where team_id = p_team_id and season = p_season and week > p_week
  );
  select * into v_move from move_price(p_team_id, p_pct, v_latest);
  v_price_after := v_move.price_after;
  if not v_latest and p_pct = 0 then
    select coalesce(
             (select price_after from price_events
               where team_id = p_team_id and season = p_season and week <= p_week
               order by week desc, id desc limit 1),
             v_team.ipo_price)
      into v_price_after;
  end if;

  update teams set
    last_change_pct = case when v_latest then v_move.pct_change else last_change_pct end,
    last_covered = case when v_latest then null else last_covered end,
    last_expected = case when v_latest then null else last_expected end,
    last_actual = case when v_latest then p_team_score - p_opp_score else last_actual end,
    last_line_is_real = case when v_latest then null else last_line_is_real end
  where id = p_team_id;

  insert into price_events (
    team_id, season, week, schedule_id, opponent_id, opponent_name, cfbd_game_id, vs_fcs,
    team_score, opp_score, pct_change, price_after, expected_margin, actual_margin,
    is_real_line, summary
  ) values (
    p_team_id, p_season, p_week, null, null, p_opponent_name, p_cfbd_game_id, true,
    p_team_score, p_opp_score, v_move.pct_change, v_price_after, null, p_team_score - p_opp_score,
    null, p_summary
  );
  return true;
end;
$$;

revoke all on function market_param(text), market_price(numeric, numeric, numeric),
  decayed_hype(numeric, timestamptz, timestamptz),
  trade_fill(numeric, numeric, text, int, numeric), market_depth(), decay_hype(),
  quote_trade(text, text, int), move_price(text, numeric, boolean), sell_value(text, int),
  apply_news_move(text, int, int, text, text, numeric, text),
  apply_fcs_result(text, int, int, bigint, text, int, int, numeric, text)
  from public, anon, authenticated;
grant execute on function market_param(text), market_price(numeric, numeric, numeric),
  decayed_hype(numeric, timestamptz, timestamptz),
  trade_fill(numeric, numeric, text, int, numeric), market_depth(), decay_hype(),
  quote_trade(text, text, int), move_price(text, numeric, boolean), sell_value(text, int),
  apply_news_move(text, int, int, text, text, numeric, text),
  apply_fcs_result(text, int, int, bigint, text, int, int, numeric, text)
  to service_role;
