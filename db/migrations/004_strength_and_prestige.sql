-- Weekly strength refreshes and Program Prestige Score rebuilds.

-- One row per team per refresh week: which SP+ rating produced which
-- strength. teams.strength always holds the latest value.
create table strength_history (
  team_id text not null references teams(id),
  season int not null,
  week int not null,                 -- latest completed week when refreshed (0 = preseason)
  sp_rating numeric not null,
  strength numeric not null,
  created_at timestamptz not null default now(),
  primary key (team_id, season, week)
);

-- Opening (IPO) prices produced by each prestige rebuild, with the component
-- breakdown so a price can always be explained after the fact.
create table prestige_scores (
  season int not null,               -- the season these are opening prices for
  team_id text not null references teams(id),
  raw_score numeric,                 -- null for manually priced teams
  prestige numeric,                  -- 10-100 rescaled; null when manual
  price numeric not null,
  manual boolean not null default false,
  components jsonb,
  applied_at timestamptz not null default now(),
  primary key (season, team_id)
);

alter table strength_history enable row level security;
alter table prestige_scores enable row level security;
revoke all on strength_history, prestige_scores from anon, authenticated;

-- Market data, readable like teams.
grant select on strength_history, prestige_scores to anon, authenticated;
create policy strength_history_read on strength_history for select using (true);
create policy prestige_scores_read on prestige_scores for select using (true);
