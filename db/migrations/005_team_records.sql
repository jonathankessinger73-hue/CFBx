-- Official season records from CFBD's /records (written by the daily sync).
-- These include games against teams outside the market (FCS opponents),
-- which price_events never sees. Null until the first sync after this
-- migration; the API falls back to records computed from price_events.
alter table teams
  add column record_season int,
  add column wins int,
  add column losses int,
  add column ties int,
  add column conf_wins int,
  add column conf_losses int,
  add column conf_ties int,
  add column record_updated_at timestamptz;
