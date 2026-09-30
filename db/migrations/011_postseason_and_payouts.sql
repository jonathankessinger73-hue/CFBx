-- Postseason games and season payouts.
--
-- The daily sync now also pulls bowl and playoff games and adds any game
-- between two market teams that isn't in the schedule yet (conference title
-- games, rescheduled games), so every one of them is priced. Regular season
-- and postseason weeks both start at 1, so rows carry their season type.

alter table schedule
  add column season_type text not null default 'regular' check (season_type in ('regular', 'postseason')),
  add column notes text;   -- CFBD's label, e.g. "SEC Championship", "CFP Semifinal at the Rose Bowl"

-- Season payouts: cash paid to shareholders when their team hits a
-- milestone (bowl eligibility, conference title, playoff berth, national
-- title), as a percentage of the share price at that moment. Each milestone
-- pays once per team per season. Shares bought in the 24 hours before don't
-- count, so there's no point buying the moment a result is certain.
create table dividends (
  id bigserial primary key,
  team_id text not null references teams(id),
  season int not null,
  kind text not null,
  pct numeric not null,
  per_share numeric not null,
  shares_paid int not null,
  total_paid numeric not null,
  summary text not null,
  paid_at timestamptz not null default now(),
  unique (team_id, season, kind)
);

create table dividend_payments (
  dividend_id bigint not null references dividends(id),
  user_id uuid not null references users(id) on delete cascade,
  shares int not null,
  amount numeric not null,
  primary key (dividend_id, user_id)
);
create index dividend_payments_user_idx on dividend_payments (user_id);

alter table dividends enable row level security;
alter table dividend_payments enable row level security;
create policy dividends_read on dividends for select to anon, authenticated using (true);
create policy dividend_payments_own on dividend_payments for select to authenticated using (user_id = auth.uid());
grant select on dividends to anon, authenticated;
grant select on dividend_payments to authenticated;

-- Pays one milestone. Returns the dividend row as jsonb, or null if this
-- milestone was already paid for this team and season.
create function pay_dividend(p_team_id text, p_season int, p_kind text, p_pct numeric, p_summary text)
returns jsonb
language plpgsql set search_path = public as $$
declare
  v_price numeric;
  v_per_share numeric;
  v_id bigint;
  v_shares int;
  v_total numeric;
begin
  select current_price into v_price from teams where id = p_team_id for update;
  if not found then
    raise exception 'unknown_team';
  end if;
  if exists (select 1 from dividends where team_id = p_team_id and season = p_season and kind = p_kind) then
    return null;
  end if;
  v_per_share := round(v_price * p_pct / 100, 2);

  insert into dividends (team_id, season, kind, pct, per_share, shares_paid, total_paid, summary)
    values (p_team_id, p_season, p_kind, p_pct, v_per_share, 0, 0, p_summary)
    returning id into v_id;

  -- Eligible shares: held now, minus any bought in the last 24 hours.
  insert into dividend_payments (dividend_id, user_id, shares, amount)
  select v_id, h.user_id, e.shares, round(e.shares * v_per_share, 2)
    from holdings h
    cross join lateral (
      select greatest(0, h.shares - coalesce((
        select sum(t.shares) from transactions t
         where t.user_id = h.user_id and t.team_id = h.team_id and t.side = 'buy'
           and t.created_at > now() - interval '24 hours'), 0))::int as shares
    ) e
   where h.team_id = p_team_id and e.shares > 0 and v_per_share > 0;

  update users u set cash = u.cash + p.amount
    from dividend_payments p
   where p.dividend_id = v_id and p.user_id = u.id;

  select coalesce(sum(shares), 0), coalesce(sum(amount), 0) into v_shares, v_total
    from dividend_payments where dividend_id = v_id;
  update dividends set shares_paid = v_shares, total_paid = v_total where id = v_id;

  return (select to_jsonb(d) from dividends d where id = v_id);
end;
$$;

revoke all on function pay_dividend(text, int, text, numeric, text) from public, anon, authenticated;
grant execute on function pay_dividend(text, int, text, numeric, text) to service_role;
