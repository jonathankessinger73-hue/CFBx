-- Recruiting class rankings, snapshotted weekly from November through
-- February (signing season). Each snapshot after the first moves prices by
-- how far a team's class rose or fell since the previous one.
create table recruiting_ranks (
  class_year int not null,
  taken_on date not null,
  team_id text not null references teams(id),
  rank int not null,
  points numeric,
  primary key (class_year, taken_on, team_id)
);
alter table recruiting_ranks enable row level security;
create policy recruiting_ranks_read on recruiting_ranks for select to anon, authenticated using (true);
grant select on recruiting_ranks to anon, authenticated;
