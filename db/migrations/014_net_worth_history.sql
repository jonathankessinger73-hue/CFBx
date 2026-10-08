-- Portfolio returns over time (1 week, 1 month, 3 months, this season, year to
-- date, all time). Each player's net worth is saved once per day (the last
-- value of the day, America/New_York), and a period's gain is today's net
-- worth minus the saved value from the day before the period started.
--
-- Days before this table existed are filled in once below by replaying each
-- player's trades, options and payouts against the last recorded price of
-- each team at the end of that day (net_worth_at). Those older values are
-- estimates: they don't see hype or live-game swings that weren't recorded.

create table net_worth_history (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,                 -- America/New_York calendar day
  net_worth numeric not null,
  primary key (user_id, day)
);

alter table net_worth_history enable row level security;
create policy net_worth_history_own on net_worth_history for select to authenticated using (user_id = auth.uid());
grant select on net_worth_history to authenticated;

-- Saves (or updates) today's value for every player. Called every few
-- minutes by the API server, so each day ends up holding its closing value.
create function record_net_worth() returns int
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  insert into net_worth_history (user_id, day, net_worth)
  select user_id, (now() at time zone 'America/New_York')::date, round(net_worth, 2)
    from user_net_worth
  on conflict (user_id, day) do update set net_worth = excluded.net_worth;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The last recorded price of a team at a moment: from a game result, a news
-- move or a trade, whichever came last.
create function team_price_at(p_team_id text, p_at timestamptz) returns numeric
language sql stable set search_path = public as $$
  select coalesce(
    (select price from (
        select price_after as price, created_at, id from price_events where team_id = p_team_id and created_at <= p_at
        union all
        select price_after, created_at, id from market_moves where team_id = p_team_id and created_at <= p_at
        union all
        select price, created_at, id from transactions where team_id = p_team_id and created_at <= p_at
      ) x order by created_at desc, id desc limit 1),
    (select current_price from teams where id = p_team_id));
$$;

-- A player's estimated net worth at a past moment, rebuilt from the
-- append-only trade logs. Open options are valued at their last trade price.
create function net_worth_at(p_user_id uuid, p_at timestamptz) returns numeric
language sql stable set search_path = public as $$
  with tx as (
    select team_id,
           sum(case side when 'buy' then shares else -shares end) as shares,
           sum(case side when 'buy' then -1 else 1 end * coalesce(amount, shares * price)) as cash
      from transactions
     where user_id = p_user_id and created_at <= p_at
     group by team_id
  ), opt as (
    select series_id,
           sum(case side when 'buy' then qty else -qty end) as qty,
           sum(case side when 'buy' then -amount else amount end) as cash
      from option_trades
     where user_id = p_user_id and created_at <= p_at
     group by series_id
  )
  select round(
    10000
    + coalesce((select sum(cash) from tx), 0)
    + coalesce((select sum(cash) from opt), 0)
    + coalesce((select sum(p.amount) from dividend_payments p join dividends d on d.id = p.dividend_id
                 where p.user_id = p_user_id and d.paid_at <= p_at), 0)
    + coalesce((select sum(shares * team_price_at(team_id, p_at)) from tx where shares > 0), 0)
    + coalesce((select sum(o.qty * coalesce((
                  select t.price from option_trades t
                   where t.series_id = o.series_id and t.side <> 'settle' and t.created_at <= p_at
                   order by t.created_at desc, t.id desc limit 1), 0))
                  from opt o where o.qty > 0), 0),
    2);
$$;

-- Gain or loss over each period. A player who joined after a period began is
-- measured from their starting $10,000 (joined = true).
create function portfolio_returns(p_user_id uuid)
returns table (period text, since date, joined boolean, start_value numeric, net_worth numeric, gain numeric, gain_pct numeric)
language plpgsql stable set search_path = public as $$
declare
  v_today date := (now() at time zone 'America/New_York')::date;
  v_joined date;
  v_now numeric;
  v_season int;
  v_season_start date;
  r record;
  v_base date;
  v_start numeric;
begin
  select (u.created_at at time zone 'America/New_York')::date into v_joined from users u where u.id = p_user_id;
  if not found then
    return;
  end if;
  select n.net_worth into v_now from user_net_worth n where n.user_id = p_user_id;

  -- This season: from the day of its first kickoff (Week 0).
  v_season := coalesce((select max(season) from schedule where start_date <= now()), (select max(season) from schedule),
                       extract(year from v_today)::int);
  v_season_start := coalesce(
    (select min((start_date at time zone 'America/New_York')::date) from schedule
      where season = v_season and season_type = 'regular'),
    make_date(v_season, 8, 24));

  for r in
    select * from (values
      ('week', 1, v_today - 6),
      ('month', 2, (v_today - interval '1 month')::date + 1),
      ('3months', 3, (v_today - interval '3 months')::date + 1),
      ('season', 4, v_season_start),
      ('ytd', 5, make_date(extract(year from v_today)::int, 1, 1)),
      ('all', 6, null::date)
    ) as p(period, ord, since)
    order by ord
  loop
    -- Measured from the close of the day before the period starts.
    v_base := r.since - 1;
    if r.since is null or v_joined > v_base then
      v_start := 10000;
      joined := true;
    else
      v_start := coalesce(
        (select h.net_worth from net_worth_history h where h.user_id = p_user_id and h.day = v_base),
        net_worth_at(p_user_id, ((v_base + 1)::timestamp at time zone 'America/New_York')));
      joined := false;
    end if;
    period := r.period;
    since := case when joined then v_joined else r.since end;
    start_value := v_start;
    net_worth := round(v_now, 2);
    gain := round(v_now - v_start, 2);
    gain_pct := case when v_start > 0 then round((v_now - v_start) / v_start * 100, 2) else 0 end;
    return next;
  end loop;
end;
$$;

-- Fill in the days before this table existed: one closing value per player
-- per day, from the day they joined through yesterday.
insert into net_worth_history (user_id, day, net_worth)
select u.id, d::date,
       net_worth_at(u.id, ((d::date + 1)::timestamp at time zone 'America/New_York'))
  from users u
 cross join lateral generate_series(
       (u.created_at at time zone 'America/New_York')::date,
       (now() at time zone 'America/New_York')::date - 1,
       interval '1 day') d
on conflict do nothing;

select record_net_worth();

revoke all on function record_net_worth(), team_price_at(text, timestamptz), net_worth_at(uuid, timestamptz),
  portfolio_returns(uuid) from public, anon, authenticated;
grant execute on function record_net_worth(), team_price_at(text, timestamptz), net_worth_at(uuid, timestamptz),
  portfolio_returns(uuid) to service_role;
