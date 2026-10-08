-- League lengths follow the football calendar: "1 week", "Until Week 7",
-- "Until Week 8", ... through conference championship weekend, or "Rest of
-- the season". A week's option disappears once that week is (nearly) over,
-- and they all come back when the next season's schedule is loaded.
-- Replaces the "1 month" option.

-- The weeks a new league can run until, from the current season's schedule:
-- each regular-season week through the one with the conference title games,
-- ending the Sunday noon (Eastern) after its last game, while at least a day
-- away. A game moved far from its week (rescheduled) doesn't stretch it.
create function league_week_options()
returns table (week int, label text, ends_at timestamptz)
language sql stable set search_path = public as $$
  with s as (select max(season) as season from schedule),
  g as (
    select sc.week, sc.start_date, coalesce(sc.notes, '') ilike '%championship%' as champ,
           min(sc.start_date) over (partition by sc.week) as first_kick
      from schedule sc, s
     where sc.season = s.season and sc.season_type = 'regular' and sc.start_date is not null
  ),
  wk as (
    select week, bool_or(champ) as champ,
           (max(start_date) filter (where start_date < first_kick + interval '7 days') at time zone 'America/New_York')::date as last_day
      from g group by week
  ),
  cutoff as (select coalesce(min(week) filter (where champ), max(week)) as last_week from wk),
  e as (
    select week, champ,
           (last_day + case extract(dow from last_day)::int when 0 then 1 else 7 - extract(dow from last_day)::int end
              + time '12:00') at time zone 'America/New_York' as ends_at
      from wk
  )
  select e.week,
         case when e.champ then 'Until Championship Weekend' else 'Until Week ' || e.week end,
         e.ends_at
    from e, cutoff
   where e.week <= cutoff.last_week and e.ends_at > now() + interval '1 day'
   order by e.week;
$$;

-- p_length: 'week' (7 days), 'w<N>' (until week N, from league_week_options)
-- or 'season' (to February 1).
create or replace function create_league(p_user_id uuid, p_name text, p_length text) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_ends timestamptz;
  v_season int;
  v_code text;
begin
  if not exists (select 1 from users where id = p_user_id and display_name is not null) then
    raise exception 'display_name_required';
  end if;
  if length(v_name) < 3 or length(v_name) > 40 then
    raise exception 'invalid_league_name';
  end if;
  if (select count(*) from competitions where created_by = p_user_id and kind = 'league' and not finished) >= 5 then
    raise exception 'league_limit';
  end if;
  v_season := extract(year from (now() at time zone 'America/New_York') - interval '2 months')::int;
  if p_length = 'week' then
    v_ends := now() + interval '7 days';
  elsif p_length = 'season' then
    v_ends := (make_date(v_season + 1, 2, 1) + time '12:00') at time zone 'America/New_York';
  elsif p_length ~ '^w[0-9]{1,2}$' then
    select o.ends_at into v_ends from league_week_options() o where o.week = substr(p_length, 2)::int;
  end if;
  if v_ends is null or v_ends <= now() + interval '1 day' then
    raise exception 'invalid_league_length';
  end if;
  v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into competitions (code, kind, name, starts_at, ends_at, is_private, late_join, created_by, started)
    values (v_code, 'league', v_name, now(), v_ends, true, true, p_user_id, true);
  perform join_competition(p_user_id, v_code);
  return jsonb_build_object('code', v_code);
end;
$$;

revoke all on function league_week_options() from public, anon, authenticated;
grant execute on function league_week_options() to service_role;
