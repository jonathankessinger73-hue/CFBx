-- Leaderboard. Players opt in by choosing a display name; players without
-- one are never listed, so nobody's account is public by default.

-- 3-24 characters: letters, digits, space, underscore, dot, dash; must start
-- and end with a letter or digit. Mirrored in src/api/app.js.
alter table users add constraint users_display_name_format
  check (display_name is null or display_name ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{1,22}[A-Za-z0-9]$');

-- Names are unique ignoring case ("Dawgfan" and "dawgfan" collide).
create unique index users_display_name_lower_key on users (lower(display_name));

-- Standard competition ranking (1, 2, 2, 4) by net worth at current prices.
create view leaderboard as
select rank() over (order by net_worth desc) as rank,
       user_id,
       display_name,
       net_worth
  from user_net_worth
 where display_name is not null;

revoke all on leaderboard from anon, authenticated;
grant select on leaderboard to service_role;
