-- Server-side write paths. Each runs as a single SQL transaction, so a crash
-- can never leave cash debited without the holding updated (or vice versa).
-- Only service_role (the backend API / daily job) may call them.

-- ---------------------------------------------------------------------------
-- execute_trade: the only way cash or holdings change.
-- The price always comes from `teams`; callers cannot supply one.
-- Errors are raised with SQLSTATE P0001 and one of these messages:
--   invalid_side, invalid_shares, unknown_team, insufficient_funds, insufficient_shares
-- ---------------------------------------------------------------------------
create function execute_trade(p_user_id uuid, p_team_id text, p_side text, p_shares int)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_price numeric;
  v_cash numeric;
  v_amount numeric;
  v_old_shares int;
  v_old_avg numeric;
  v_new_shares int;
  v_new_avg numeric;
  v_tx_id bigint;
begin
  if p_side is null or p_side not in ('buy', 'sell') then
    raise exception 'invalid_side';
  end if;
  if p_shares is null or p_shares < 1 then
    raise exception 'invalid_shares';
  end if;

  -- FOR SHARE blocks a concurrent price update until this trade commits, so
  -- the price we charge is the price that was current when we executed.
  select current_price into v_price from teams where id = p_team_id for share;
  if not found then
    raise exception 'unknown_team';
  end if;

  insert into users (id) values (p_user_id) on conflict (id) do nothing;
  -- Serialize all trades for this user.
  select cash into v_cash from users where id = p_user_id for update;

  select shares, avg_cost into v_old_shares, v_old_avg
    from holdings where user_id = p_user_id and team_id = p_team_id for update;
  v_old_shares := coalesce(v_old_shares, 0);
  v_old_avg := coalesce(v_old_avg, 0);

  v_amount := round(v_price * p_shares, 2);

  if p_side = 'buy' then
    if v_cash < v_amount then
      raise exception 'insufficient_funds';
    end if;
    v_cash := v_cash - v_amount;
    v_new_shares := v_old_shares + p_shares;
    v_new_avg := round((v_old_avg * v_old_shares + v_amount) / v_new_shares, 2);
    insert into holdings (user_id, team_id, shares, avg_cost)
      values (p_user_id, p_team_id, v_new_shares, v_new_avg)
      on conflict (user_id, team_id)
      do update set shares = excluded.shares, avg_cost = excluded.avg_cost;
  else
    if v_old_shares < p_shares then
      raise exception 'insufficient_shares';
    end if;
    v_cash := v_cash + v_amount;
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

  insert into transactions (user_id, team_id, side, shares, price)
    values (p_user_id, p_team_id, p_side, p_shares, v_price)
    returning id into v_tx_id;

  return jsonb_build_object(
    'transaction_id', v_tx_id,
    'team_id', p_team_id,
    'side', p_side,
    'shares', p_shares,
    'price', v_price,
    'amount', v_amount,
    'cash', v_cash,
    'holding', case when v_new_shares > 0
      then jsonb_build_object('shares', v_new_shares, 'avg_cost', v_new_avg)
      else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_game_result: record one completed game and its price moves.
-- Prices are computed in JS (src/engine/pricing.js); this function applies
-- them atomically. Idempotent: returns false if the game was already applied.
-- Optimistic check: each team's price must still equal `prev_price`, so a
-- result computed from stale prices is rejected instead of silently applied.
--
-- p_teams:  [{id, prev_price, current_price, last_change_pct, last_covered,
--             last_expected, last_actual, last_line_is_real}, ...]
-- p_events: [{team_id, opponent_id, team_score, opp_score, pct_change,
--             price_after, expected_margin, actual_margin, is_real_line, summary}, ...]
-- ---------------------------------------------------------------------------
create function apply_game_result(
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
begin
  select * into v_game from schedule where id = p_schedule_id for update;
  if not found then
    raise exception 'unknown_game';
  end if;
  if v_game.completed then
    return false;
  end if;

  for v_team in select * from jsonb_array_elements(p_teams) loop
    update teams set
      current_price = (v_team->>'current_price')::numeric,
      last_change_pct = (v_team->>'last_change_pct')::numeric,
      last_covered = (v_team->>'last_covered')::boolean,
      last_expected = (v_team->>'last_expected')::numeric,
      last_actual = (v_team->>'last_actual')::numeric,
      last_line_is_real = (v_team->>'last_line_is_real')::boolean,
      updated_at = now()
    where id = v_team->>'id'
      and current_price = (v_team->>'prev_price')::numeric;
    if not found then
      raise exception 'stale_price for %', v_team->>'id';
    end if;
  end loop;

  insert into price_events (
    team_id, season, week, schedule_id, opponent_id, team_score, opp_score,
    pct_change, price_after, expected_margin, actual_margin, is_real_line, summary
  )
  select e->>'team_id', v_game.season, v_game.week, p_schedule_id, e->>'opponent_id',
         (e->>'team_score')::int, (e->>'opp_score')::int,
         (e->>'pct_change')::numeric, (e->>'price_after')::numeric,
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
-- Net worth, valued at current prices.
-- ---------------------------------------------------------------------------
create view user_net_worth as
select u.id as user_id,
       u.display_name,
       u.cash,
       coalesce(sum(h.shares * t.current_price), 0) as holdings_value,
       u.cash + coalesce(sum(h.shares * t.current_price), 0) as net_worth
  from users u
  left join holdings h on h.user_id = u.id
  left join teams t on t.id = h.team_id
 group by u.id;

revoke all on user_net_worth from anon, authenticated;
revoke all on function execute_trade(uuid, text, text, int) from public, anon, authenticated;
revoke all on function apply_game_result(bigint, int, int, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function execute_trade(uuid, text, text, int) to service_role;
grant execute on function apply_game_result(bigint, int, int, bigint, jsonb, jsonb) to service_role;
grant select on user_net_worth to service_role;
