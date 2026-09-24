-- CFBx core schema. Targets Supabase Postgres (relies on auth.users and the
-- anon / authenticated / service_role roles Supabase provides).
--
-- Trust model: the backend API (service_role) is the only writer. The browser
-- holds the anon key, so every table has RLS on and at most read access.

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------

create table teams (
  id text primary key,                -- ticker, e.g. 'UGA'
  name text not null,                 -- 'Georgia'
  mascot text,                        -- 'Bulldogs'
  conference text,                    -- 'SEC'
  strength numeric not null,          -- SP+-derived rating, 10-95; refreshed once per season
  primary_color text,
  secondary_color text,
  ipo_price numeric not null,         -- Program Prestige Score opening price for the season
  current_price numeric not null check (current_price >= 3),
  last_change_pct numeric not null default 0,
  last_covered boolean,               -- did they cover their own spread last game?
  last_expected numeric,              -- expected margin, their perspective
  last_actual numeric,                -- actual margin, their perspective
  last_line_is_real boolean,          -- real posted spread, or SP+ proxy?
  updated_at timestamptz not null default now()
);

-- The season's schedule. `line` uses CFBD's raw convention: home perspective,
-- NEGATIVE = home favored (expected home margin = -line). Null until posted.
create table schedule (
  id bigserial primary key,
  season int not null,
  week int not null,
  home_team_id text not null references teams(id),
  away_team_id text not null references teams(id),
  line numeric,
  home_score int,
  away_score int,
  completed boolean not null default false,
  cfbd_game_id bigint unique,         -- filled in once matched against CFBD /games
  updated_at timestamptz not null default now()
);
create index schedule_season_week_idx on schedule (season, week);

-- One row per team per completed game that moved its price.
create table price_events (
  id bigserial primary key,
  team_id text not null references teams(id),
  season int not null,
  week int not null,
  schedule_id bigint references schedule(id),
  opponent_id text references teams(id),
  team_score int,
  opp_score int,
  pct_change numeric not null,
  price_after numeric not null,
  expected_margin numeric,
  actual_margin numeric,
  is_real_line boolean,
  summary text,                       -- e.g. 'favored by 7.0, won by 3 - missed the line'
  created_at timestamptz not null default now(),
  unique (schedule_id, team_id)       -- a game can only move a team's price once
);
create index price_events_team_idx on price_events (team_id, season, week, id);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  cash numeric not null default 10000 check (cash >= 0),
  created_at timestamptz not null default now()
);

create table holdings (
  user_id uuid not null references users(id) on delete cascade,
  team_id text not null references teams(id),
  shares int not null check (shares > 0),
  avg_cost numeric not null,
  primary key (user_id, team_id)
);

-- THE SOURCE OF TRUTH. Append-only: cash and holdings can always be rebuilt
-- by replaying this table.
create table transactions (
  id bigserial primary key,
  user_id uuid not null references users(id),
  team_id text not null references teams(id),
  side text not null check (side in ('buy', 'sell')),
  shares int not null check (shares > 0),
  price numeric not null,             -- price at the moment the server executed it
  created_at timestamptz not null default now()
);
create index transactions_user_idx on transactions (user_id, id);

create function transactions_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'transactions is append-only';
end;
$$;
create trigger transactions_no_update_delete
  before update or delete on transactions
  for each row execute function transactions_append_only();
create trigger transactions_no_truncate
  before truncate on transactions
  for each statement execute function transactions_append_only();

-- Give every new auth user an account row with starting cash.
create function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table teams enable row level security;
alter table schedule enable row level security;
alter table price_events enable row level security;
alter table users enable row level security;
alter table holdings enable row level security;
alter table transactions enable row level security;

revoke all on teams, schedule, price_events, users, holdings, transactions from anon, authenticated;

grant select on teams, schedule, price_events to anon, authenticated;
create policy teams_read on teams for select using (true);
create policy schedule_read on schedule for select using (true);
create policy price_events_read on price_events for select using (true);

grant select on users, holdings, transactions to authenticated;
create policy users_read_own on users for select to authenticated using (id = auth.uid());
create policy holdings_read_own on holdings for select to authenticated using (user_id = auth.uid());
create policy transactions_read_own on transactions for select to authenticated using (user_id = auth.uid());
