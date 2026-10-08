-- Competitions: scoreboards on top of the one market. Everyone trades the
-- same teams at the same prices; a competition ranks its entrants by percent
-- return over a time window, so a big account has no head start.
--
--   week    "Week 7 Sprint": Thursday noon to Sunday noon (ET), one game slate
--   month   "November Monthly": the calendar month, September to January
--   season  "2026 Season Championship": Week 0 (or the next Thursday, when
--           the season is already underway) to February 1
--   event   one-offs created by an admin (Rivalry Week, Bowl Season, ...)
--   league  private leagues players create and share by link; members can
--           join any time and are scored from when they join
--
-- Public competitions close to new entries when they start. Each entrant's
-- starting value is their net worth at the start (or when they joined a
-- league); the score is their net worth now (or at the end) against it.
-- Prize eligibility needs a minimum number of trades during the window.

create table competitions (
  id bigserial primary key,
  code text not null unique,           -- in links: #/compete/<code>
  kind text not null check (kind in ('season', 'month', 'week', 'event', 'league')),
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  min_trades int not null default 0 check (min_trades >= 0),
  is_private boolean not null default false,
  late_join boolean not null default false,
  created_by uuid references users(id) on delete set null,
  prize text,
  sponsor_name text,
  sponsor_url text check (sponsor_url is null or sponsor_url ~ '^https://'),
  started boolean not null default false,
  finished boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index competitions_open_idx on competitions (ends_at) where not finished;

create table competition_entries (
  competition_id bigint not null references competitions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  start_value numeric,                 -- net worth when scoring began
  scored_from timestamptz,
  final_value numeric,                 -- net worth at the end
  final_rank int,
  primary key (competition_id, user_id)
);
create index competition_entries_user_idx on competition_entries (user_id);

alter table competitions enable row level security;
alter table competition_entries enable row level security;

-- Share and option trades a player made in a window.
create function trades_between(p_user_id uuid, p_from timestamptz, p_to timestamptz) returns int
language sql stable set search_path = public as $$
  select ((select count(*) from transactions
            where user_id = p_user_id and created_at >= p_from and created_at < p_to)
        + (select count(*) from option_trades
            where user_id = p_user_id and side in ('buy', 'sell') and created_at >= p_from and created_at < p_to))::int;
$$;

-- Standings: named entrants ranked by percent return. Players short of the
-- trade minimum are listed after the ranked ones, unranked. Before the start
-- it's just the entry list.
create function competition_standings(p_competition_id bigint)
returns table (rank int, user_id uuid, display_name text, start_value numeric, value numeric,
               return_pct numeric, trades int, qualified boolean)
language sql stable set search_path = public as $$
  with c as (select * from competitions where id = p_competition_id),
  e as (
    select e.user_id, u.display_name, e.start_value,
           case when c.finished then e.final_value else n.net_worth end as value,
           trades_between(e.user_id, coalesce(e.scored_from, c.starts_at), least(now(), c.ends_at)) as trades,
           c.min_trades
      from competition_entries e
      join c on c.id = e.competition_id
      join users u on u.id = e.user_id
      join user_net_worth n on n.user_id = e.user_id
     where u.display_name is not null
  ),
  s as (
    select user_id, display_name, start_value, round(value, 2) as value,
           case when start_value > 0 then round((value - start_value) / start_value * 100, 2) end as return_pct,
           trades, start_value is not null and trades >= min_trades as qualified
      from e
  )
  select (case when qualified then rank() over (partition by qualified order by return_pct desc) end)::int,
         user_id, display_name, start_value, value, return_pct, trades, qualified
    from s
   order by qualified desc, return_pct desc nulls last, lower(display_name);
$$;

-- Joins a player. Public competitions take entries until they start; leagues
-- take them until they end, and late joiners are scored from that moment.
create function join_competition(p_user_id uuid, p_code text) returns jsonb
language plpgsql set search_path = public as $$
declare
  c competitions%rowtype;
  v_now numeric;
begin
  select * into c from competitions where code = p_code;
  if not found then
    raise exception 'unknown_competition';
  end if;
  if c.finished or now() >= c.ends_at or (now() >= c.starts_at and not c.late_join) then
    raise exception 'competition_closed';
  end if;
  if not exists (select 1 from users where id = p_user_id and display_name is not null) then
    raise exception 'display_name_required';
  end if;
  if now() >= c.starts_at then
    select net_worth into v_now from user_net_worth where user_id = p_user_id;
    insert into competition_entries (competition_id, user_id, start_value, scored_from)
      values (c.id, p_user_id, round(v_now, 2), now())
      on conflict do nothing;
  else
    insert into competition_entries (competition_id, user_id) values (c.id, p_user_id)
      on conflict do nothing;
  end if;
  return jsonb_build_object('code', c.code, 'joined', true);
end;
$$;

-- Leaves before the start (nothing to undo yet), or a league any time.
create function leave_competition(p_user_id uuid, p_code text) returns boolean
language plpgsql set search_path = public as $$
declare
  c competitions%rowtype;
begin
  select * into c from competitions where code = p_code;
  if not found then
    raise exception 'unknown_competition';
  end if;
  if c.finished or (now() >= c.starts_at and c.kind <> 'league') then
    raise exception 'competition_closed';
  end if;
  delete from competition_entries where competition_id = c.id and user_id = p_user_id;
  return found;
end;
$$;

-- A private league, starting now. p_length: 'week', 'month' or 'season'
-- (to February 1). The creator joins it. At most 5 open leagues per creator.
create function create_league(p_user_id uuid, p_name text, p_length text) returns jsonb
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
  v_ends := case p_length
    when 'week' then now() + interval '7 days'
    when 'month' then now() + interval '30 days'
    when 'season' then (make_date(v_season + 1, 2, 1) + time '12:00') at time zone 'America/New_York'
  end;
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

-- Lists the next public competitions so there's always one open for entry:
-- this or next week's sprint (when games are scheduled in it), next month's
-- monthly (September to January), and the season championship.
create function ensure_competitions() returns int
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
              v_start, v_end, 1)
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
              ((v_month + interval '1 month')::date + time '00:00') at time zone 'America/New_York', 3)
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
        values ('season-' || v_season, 'season', v_season || ' Season Championship', v_start, v_end, 5)
        on conflict (code) do nothing;
      if found then v_count := v_count + 1; end if;
    end if;
  end if;
  return v_count;
end;
$$;

-- Runs every few minutes: lists upcoming competitions, records starting
-- values for ones that just started, and settles ones that just ended.
create function run_competitions() returns jsonb
language plpgsql set search_path = public as $$
declare
  v_created int;
  v_started int;
  v_finished int := 0;
  v_comp record;
begin
  v_created := ensure_competitions();

  update competition_entries e set start_value = round(n.net_worth, 2), scored_from = now()
    from competitions c, user_net_worth n
   where c.id = e.competition_id and n.user_id = e.user_id
     and c.starts_at <= now() and not c.finished and e.start_value is null;
  update competitions set started = true where starts_at <= now() and not started;
  get diagnostics v_started = row_count;

  for v_comp in select id from competitions where ends_at <= now() and not finished order by id for update skip locked loop
    update competition_entries e set final_value = round(n.net_worth, 2)
      from user_net_worth n
     where e.competition_id = v_comp.id and n.user_id = e.user_id;
    update competitions set finished = true where id = v_comp.id;
    update competition_entries e set final_rank = s.rank
      from competition_standings(v_comp.id) s
     where e.competition_id = v_comp.id and e.user_id = s.user_id;
    v_finished := v_finished + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'started', v_started, 'finished', v_finished);
end;
$$;

revoke all on function trades_between(uuid, timestamptz, timestamptz), competition_standings(bigint),
  join_competition(uuid, text), leave_competition(uuid, text), create_league(uuid, text, text),
  ensure_competitions(), run_competitions()
  from public, anon, authenticated;
grant execute on function trades_between(uuid, timestamptz, timestamptz), competition_standings(bigint),
  join_competition(uuid, text), leave_competition(uuid, text), create_league(uuid, text, text),
  ensure_competitions(), run_competitions()
  to service_role;
