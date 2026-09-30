-- Live in-game prices. While a game is being played, the API server polls
-- the scoreboard and sets each team's live_pct (see src/live/liveGames.js):
-- the move the final would make if the game ended now, scaled by how much of
-- the game has been played. The final result replaces it (move_price resets
-- live_pct and live_status when a game's result is applied).

-- Kickoff time from CFBD, so the poller only calls the scoreboard while games
-- could be on.
alter table schedule add column start_date timestamptz;
create index schedule_open_start_idx on schedule (start_date) where not completed;

-- e.g. 'Q3 7:32 · UGA 21, OU 17'. Null when the team isn't playing.
alter table teams add column live_status text;

-- p_moves: [{id, pct, status}, ...]
create function set_live_moves(p_moves jsonb) returns int
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  update teams t set
    hype = decayed_hype(t.hype, t.hype_updated_at, now()),
    hype_updated_at = now(),
    live_pct = x.pct,
    live_status = x.status,
    current_price = market_price(t.fundamental_price, decayed_hype(t.hype, t.hype_updated_at, now()), x.pct),
    updated_at = now()
  from jsonb_to_recordset(p_moves) as x(id text, pct numeric, status text)
  where t.id = x.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Clears live moves for teams no longer in a live game (a game that was
-- postponed or whose final hasn't been applied within the window).
create function clear_live_moves(p_keep text[]) returns int
language plpgsql set search_path = public as $$
declare
  v_count int;
begin
  update teams set
    hype = decayed_hype(hype, hype_updated_at, now()),
    hype_updated_at = now(),
    live_pct = 0,
    live_status = null,
    current_price = market_price(fundamental_price, decayed_hype(hype, hype_updated_at, now()), 0),
    updated_at = now()
  where (live_pct <> 0 or live_status is not null) and not (id = any(p_keep));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- move_price as before, but resetting the live move also clears live_status.
create or replace function move_price(p_team_id text, p_pct numeric, p_reset_live boolean,
                                      out pct_change numeric, out price_after numeric)
language plpgsql set search_path = public as $$
declare
  v_team teams%rowtype;
  v_fundamental numeric;
  v_hype numeric;
  v_live numeric;
begin
  select * into v_team from teams where id = p_team_id;
  if not found then
    raise exception 'unknown_team';
  end if;
  v_fundamental := greatest(3, round(v_team.fundamental_price * (1 + p_pct / 100), 4));
  v_hype := decayed_hype(v_team.hype, v_team.hype_updated_at, now());
  v_live := case when p_reset_live then 0 else v_team.live_pct end;
  pct_change := round((v_fundamental - v_team.fundamental_price) / v_team.fundamental_price * 100, 2);
  price_after := market_price(v_fundamental, v_hype, v_live);
  update teams set
    fundamental_price = v_fundamental,
    hype = v_hype,
    hype_updated_at = now(),
    live_pct = v_live,
    live_status = case when p_reset_live then null else live_status end,
    current_price = price_after,
    updated_at = now()
  where id = p_team_id;
end;
$$;

revoke all on function set_live_moves(jsonb), clear_live_moves(text[]) from public, anon, authenticated;
grant execute on function set_live_moves(jsonb), clear_live_moves(text[]) to service_role;
