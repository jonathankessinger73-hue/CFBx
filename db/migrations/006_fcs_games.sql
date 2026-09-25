-- Games against teams outside the market (FCS and below). They appear in a
-- team's game log and price chart like any other game, but the opponent has
-- no ticker, so the row carries the opponent's name instead of an id and no
-- schedule row. There is no betting line: a win leaves the price unchanged,
-- a loss applies a fixed penalty (computed in src/engine/pricing.js).

alter table price_events
  add column opponent_name text,        -- set when opponent_id is null
  add column cfbd_game_id bigint,
  add column vs_fcs boolean not null default false,
  add constraint price_events_cfbd_team_key unique (cfbd_game_id, team_id);

-- ---------------------------------------------------------------------------
-- apply_fcs_result: record one completed game against a non-market opponent.
-- Idempotent (returns false if this game is already recorded for the team) and
-- guarded like apply_game_result: the team's price must still be p_prev_price.
-- A game reported late (an earlier week than the team's latest game) doesn't
-- overwrite the "last game" fields on teams, and a no-change result is charted
-- at the price the team had that week.
-- ---------------------------------------------------------------------------
create function apply_fcs_result(
  p_team_id text,
  p_season int,
  p_week int,
  p_cfbd_game_id bigint,
  p_opponent_name text,
  p_team_score int,
  p_opp_score int,
  p_prev_price numeric,
  p_new_price numeric,
  p_pct_change numeric,
  p_summary text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_team teams%rowtype;
  v_latest boolean;
  v_price_after numeric;
begin
  select * into v_team from teams where id = p_team_id for update;
  if not found then
    raise exception 'unknown_team';
  end if;
  if exists (select 1 from price_events where cfbd_game_id = p_cfbd_game_id and team_id = p_team_id) then
    return false;
  end if;
  if v_team.current_price <> p_prev_price then
    raise exception 'stale_price for %', p_team_id;
  end if;

  v_latest := not exists (
    select 1 from price_events where team_id = p_team_id and season = p_season and week > p_week
  );
  v_price_after := p_new_price;
  if not v_latest and p_new_price = p_prev_price then
    select coalesce(
             (select price_after from price_events
               where team_id = p_team_id and season = p_season and week <= p_week
               order by week desc, id desc limit 1),
             v_team.ipo_price)
      into v_price_after;
  end if;

  update teams set
    current_price = p_new_price,
    last_change_pct = case when v_latest then p_pct_change else last_change_pct end,
    last_covered = case when v_latest then null else last_covered end,
    last_expected = case when v_latest then null else last_expected end,
    last_actual = case when v_latest then p_team_score - p_opp_score else last_actual end,
    last_line_is_real = case when v_latest then null else last_line_is_real end,
    updated_at = now()
  where id = p_team_id;

  insert into price_events (
    team_id, season, week, schedule_id, opponent_id, opponent_name, cfbd_game_id, vs_fcs,
    team_score, opp_score, pct_change, price_after, expected_margin, actual_margin,
    is_real_line, summary
  ) values (
    p_team_id, p_season, p_week, null, null, p_opponent_name, p_cfbd_game_id, true,
    p_team_score, p_opp_score, p_pct_change, v_price_after, null, p_team_score - p_opp_score,
    null, p_summary
  );
  return true;
end;
$$;

revoke all on function apply_fcs_result(text, int, int, bigint, text, int, int, numeric, numeric, numeric, text)
  from public, anon, authenticated;
grant execute on function apply_fcs_result(text, int, int, bigint, text, int, int, numeric, numeric, numeric, text)
  to service_role;
