-- News moves between games (both run by the daily job and logged in
-- market_moves through apply_news_move):
--
--   line  a game's consensus spread moved: the market changed its mind about
--         the two teams, so their prices follow (before kickoff only)
--   poll  a team entered, left or moved in the AP poll or the CFP rankings

-- The spread our prices currently reflect. The first line seen for a game is
-- the baseline; later moves away from it move prices, then become the baseline.
alter table schedule add column line_priced numeric;
update schedule set line_priced = line where line is not null;

-- Poll rankings seen so far, one row per ranked team per poll release.
create table poll_ranks (
  poll text not null,          -- 'AP Top 25', 'Playoff Committee Rankings'
  season int not null,
  season_type text not null,
  week int not null,
  team_id text not null references teams(id),
  rank int not null,
  created_at timestamptz not null default now(),
  primary key (poll, season, season_type, week, team_id)
);
alter table poll_ranks enable row level security;
create policy poll_ranks_read on poll_ranks for select to anon, authenticated using (true);
grant select on poll_ranks to anon, authenticated;

-- Moves both teams of an open game for a line change, atomically: only if the
-- game is still open and its priced line is still p_from (so two runs can't
-- both apply the same move), then records p_to as the new baseline.
create function apply_line_move(
  p_schedule_id bigint,
  p_from numeric,
  p_to numeric,
  p_home_pct numeric,
  p_home_summary text,
  p_away_summary text
)
returns boolean
language plpgsql set search_path = public as $$
declare
  v_game schedule%rowtype;
  v_ref text;
begin
  select * into v_game from schedule where id = p_schedule_id for update;
  if not found or v_game.completed or v_game.line_priced is distinct from p_from then
    return false;
  end if;
  v_ref := format('%s:%s>%s@%s', p_schedule_id, p_from, p_to, extract(epoch from now()));
  -- Same lock order as apply_game_result.
  perform 1 from teams where id in (v_game.home_team_id, v_game.away_team_id) order by id for update;
  perform apply_news_move(v_game.home_team_id, v_game.season, v_game.week, 'line', v_ref, p_home_pct, p_home_summary);
  perform apply_news_move(v_game.away_team_id, v_game.season, v_game.week, 'line', v_ref, -p_home_pct, p_away_summary);
  update schedule set line = p_to, line_priced = p_to, updated_at = now() where id = p_schedule_id;
  return true;
end;
$$;

revoke all on function apply_line_move(bigint, numeric, numeric, numeric, text, text) from public, anon, authenticated;
grant execute on function apply_line_move(bigint, numeric, numeric, numeric, text, text) to service_role;
