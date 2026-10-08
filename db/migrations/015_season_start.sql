-- Fix: "This season" on the portfolio returns panel started at the earliest
-- kickoff time on file, but kickoff times were only saved for games not yet
-- played, so for 2026 that was early October instead of Week 0. The season now
-- starts on the first day of its first week (kickoff times of finished games
-- are now saved too), or the last Saturday of August when that isn't known.

create function season_start_day(p_season int) returns date
language sql stable set search_path = public as $$
  select coalesce(
    (select min((s.start_date at time zone 'America/New_York')::date) from schedule s
      where s.season = p_season and s.season_type = 'regular'
        and s.week = (select min(week) from schedule where season = p_season and season_type = 'regular')),
    -- Week 0 is the last Saturday of August.
    make_date(p_season, 8, 31) - ((extract(dow from make_date(p_season, 8, 31))::int + 1) % 7));
$$;

create or replace function portfolio_returns(p_user_id uuid)
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

  -- This season: from Week 0.
  v_season := coalesce((select max(season) from schedule where start_date <= now()), (select max(season) from schedule),
                       extract(year from v_today)::int);
  v_season_start := season_start_day(v_season);

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

revoke all on function season_start_day(int) from public, anon, authenticated;
grant execute on function season_start_day(int) to service_role;
