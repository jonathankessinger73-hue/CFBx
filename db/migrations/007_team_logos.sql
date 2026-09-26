-- Team logo image URLs (ESPN's CDN, as listed by CFBD /teams/fbs), filled in
-- by the daily sync. The browser loads them directly; null means the app draws
-- its generic helmet instead.
alter table teams
  add column logo_url text,
  add column logo_dark_url text;   -- variant designed for dark backgrounds
