-- Trade minimums to be ranked: 3 for a weekly sprint, 5 for a monthly, 10
-- for the season championship (were 1, 3 and 5). Applies to new
-- competitions and to ones not yet finished.

update competitions set min_trades = case kind when 'week' then 3 when 'month' then 5 when 'season' then 10 end
 where kind in ('week', 'month', 'season') and not finished;

create or replace function ensure_competitions() returns int
language plpgsql set search_path = public as $$
declare
  v_today date := (now() at time zone 'America/New_York')::date;
  v_thu date := date_trunc('week', v_today)::date + 3;   -- weeks start Monday
  v_start timestamptz;
  v_end timestamptz;
  v_week int;
  v_post boolean;
  v_games int;
  v_month date;
  v_season int;
  v_count int := 0;
begin
  -- Weekly sprints.
  for i in 0..1 loop
    v_start := ((v_thu + 7 * i) + time '12:00') at time zone 'America/New_York';
    v_end := ((v_thu + 7 * i + 3) + time '12:00') at time zone 'America/New_York';
    continue when v_start <= now() or exists (select 1 from competitions where kind = 'week' and starts_at = v_start);
    select count(*), min(week) filter (where season_type = 'regular'), bool_or(season_type = 'postseason')
      into v_games, v_week, v_post
      from schedule where start_date >= v_start and start_date < v_end;
    continue when v_games = 0;
    insert into competitions (code, kind, name, starts_at, ends_at, min_trades)
      values ('week-' || to_char(v_thu + 7 * i, 'YYYY-MM-DD'), 'week',
              case when v_week is not null and not v_post then 'Week ' || v_week || ' Sprint'
                   else 'Bowl Sprint · ' || to_char(v_thu + 7 * i, 'Mon FMDD') end,
              v_start, v_end, 3)
      on conflict (code) do nothing;
    v_count := v_count + 1;
  end loop;

  -- Next month's monthly, during the season.
  v_month := (date_trunc('month', v_today) + interval '1 month')::date;
  if extract(month from v_month) in (9, 10, 11, 12, 1)
     and exists (select 1 from schedule
                  where start_date >= (v_month + time '00:00') at time zone 'America/New_York'
                    and start_date < ((v_month + interval '1 month')::date + time '00:00') at time zone 'America/New_York') then
    insert into competitions (code, kind, name, starts_at, ends_at, min_trades)
      values ('month-' || to_char(v_month, 'YYYY-MM'), 'month', trim(to_char(v_month, 'Month')) || ' Monthly',
              (v_month + time '00:00') at time zone 'America/New_York',
              ((v_month + interval '1 month')::date + time '00:00') at time zone 'America/New_York', 5)
      on conflict (code) do nothing;
    if found then v_count := v_count + 1; end if;
  end if;

  -- The season championship: from Week 0, or from the next Thursday when the
  -- season is already underway (until December).
  v_season := (select max(season) from schedule);
  if v_season is not null and not exists (select 1 from competitions where code = 'season-' || v_season) then
    v_start := (season_start_day(v_season) + time '00:00') at time zone 'America/New_York';
    if v_start <= now() then
      v_start := (case when v_today < v_thu or (v_today = v_thu and now() < (v_thu + time '12:00') at time zone 'America/New_York')
                       then v_thu else v_thu + 7 end + time '12:00') at time zone 'America/New_York';
    end if;
    v_end := (make_date(v_season + 1, 2, 1) + time '12:00') at time zone 'America/New_York';
    if v_start < (make_date(v_season, 12, 1) + time '00:00') at time zone 'America/New_York' then
      insert into competitions (code, kind, name, starts_at, ends_at, min_trades)
        values ('season-' || v_season, 'season', v_season || ' Season Championship', v_start, v_end, 10)
        on conflict (code) do nothing;
      if found then v_count := v_count + 1; end if;
    end if;
  end if;
  return v_count;
end;
$$;

