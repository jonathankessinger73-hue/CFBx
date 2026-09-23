# CFBx — Backend Build Spec (hand this directly to Claude Code)

## What this project is

CFBx is a play-money trading app where users buy and sell "shares" in college
football programs. Prices move based on real weekly results compared against
real Vegas spreads. It currently exists as a single self-contained HTML file
(a Claude.ai artifact) with no server — everything runs in one browser via
`localStorage`. This spec is for turning it into a real, always-on product:
a backend that updates prices daily, a database that remembers who owns what,
and an API the frontend talks to instead of just editing its own local state.

**Reference implementation:** the current working artifact (formulas, UI,
full 138-team roster) is at:
`https://claude.ai/artifact/PSG8KjNjE2RA7Mku5VGYyL`
Pull the source HTML from that link — it contains the exact `SEED_TEAMS`,
`TEAM_COLORS`, `PRESTIGE_PRICE`, and `MASCOTS` tables for all 138 teams,
which should be used to seed the database rather than retyped by hand.

---

## Why a backend is needed at all

Right now, "buying a share" is just the browser editing its own JavaScript
variable. That's fine for one person testing alone, but it means:
- Nothing stops someone from editing the price in dev tools before "buying"
- Two people can't see the same live prices or trade against the same market
- Nobody's portfolio persists across devices or survives clearing browser data

The fix: the server becomes the *only* authority on three things — current
price, a user's cash balance, and a user's holdings. The frontend only ever
asks questions ("what's the price?", "what do I own?") or requests actions
("buy 5 shares of UGA") — it never computes or asserts a price itself.

---

## Recommended stack

Optimize for "get this running with minimal new concepts," not for maximum
scalability — this doesn't need to survive Twitter-scale traffic on day one.

- **Database + Auth: Supabase** (hosted Postgres + built-in email/OAuth login
  in one free tier). This removes the need to hand-roll authentication.
- **Backend API: Node.js** (Express or Fastify) — keeps the pricing logic in
  the same language as the existing frontend code, so the JS formulas below
  can be ported almost line-for-line instead of rewritten in a new language.
- **Scheduled job: GitHub Actions cron** — runs the daily CFBD pull. Free,
  no server to keep running yourself.
- **Frontend hosting: Vercel or Render** — deploys straight from a GitHub
  repo, free tier is enough for this.
- **External data source: CollegeFootballData.com API** — same one already
  in use. Requires a free API key (already obtained for this project).

---

## Database schema

```sql
-- One row per program. Seed this once from PRESTIGE_PRICE/SEED_TEAMS/
-- TEAM_COLORS/MASCOTS in the current artifact's source.
create table teams (
  id text primary key,           -- ticker, e.g. 'UGA'
  name text not null,            -- 'Georgia'
  mascot text,                   -- 'Bulldogs'
  conference text,               -- 'SEC'
  strength numeric not null,     -- current SP+-derived rating (0-100 scale)
  primary_color text,
  secondary_color text,
  current_price numeric not null,
  last_change_pct numeric default 0,
  last_covered boolean,          -- did they cover their own spread last game?
  last_expected numeric,         -- expected margin, their perspective
  last_actual numeric,           -- actual margin, their perspective
  last_line_is_real boolean      -- was that a real posted spread or SP+ proxy?
);

-- One row per completed game that has moved a price. This is the "game log"
-- shown per team, and also the season-level history for charts.
create table price_events (
  id bigserial primary key,
  team_id text references teams(id),
  week int not null,
  season int not null,
  opponent_id text references teams(id),
  team_score int,
  opp_score int,
  pct_change numeric not null,
  price_after numeric not null,
  expected_margin numeric,
  actual_margin numeric,
  is_real_line boolean,
  created_at timestamptz default now()
);

-- Users. If using Supabase Auth, this can just extend its built-in
-- auth.users table with app-specific fields via a 1:1 join table.
create table users (
  id uuid primary key,           -- matches Supabase auth.users.id
  cash numeric not null default 10000,
  created_at timestamptz default now()
);

-- Current holdings, one row per (user, team) with shares > 0.
create table holdings (
  user_id uuid references users(id),
  team_id text references teams(id),
  shares int not null,
  avg_cost numeric not null,
  primary key (user_id, team_id)
);

-- THE SOURCE OF TRUTH. Append-only. Never update or delete a row here -
-- cash and holdings are always derivable by replaying this table, which
-- is what makes it trustworthy. Same pattern real brokerages use.
create table transactions (
  id bigserial primary key,
  user_id uuid references users(id),
  team_id text references teams(id),
  side text not null check (side in ('buy','sell')),
  shares int not null,
  price numeric not null,        -- price AT THE MOMENT the server executed it
  created_at timestamptz default now()
);

-- The season's schedule, mirrors REAL_SCHEDULE_2026 from the artifact.
-- The daily job updates `line` as sportsbooks post them, and fills in
-- `home_score`/`away_score`/`completed` once games finish.
create table schedule (
  id bigserial primary key,
  season int not null,
  week int not null,
  home_team_id text references teams(id),
  away_team_id text references teams(id),
  line numeric,                  -- real spread, home-perspective, null if not posted
  home_score int,
  away_score int,
  completed boolean default false
);
```

---

## API endpoints

All endpoints except `/teams` and `/leaderboard` require an authenticated
user (Supabase Auth handles the token; the API just verifies it).

| Method | Path | Purpose |
|---|---|---|
| GET | `/teams` | Full list of teams with current prices, mascots, colors, last-game cover status |
| GET | `/teams/:id` | One team's detail: price history (from `price_events`), game log |
| GET | `/me` | Current user's cash + net worth |
| GET | `/me/holdings` | Current user's holdings, joined with current team prices for live valuation |
| POST | `/trade` | Body: `{team_id, side, shares}`. See validation logic below. |
| GET | `/me/transactions` | User's full trade history |
| GET | `/leaderboard` | Optional: top users by net worth (only worth building once this has multiple real users) |

### `POST /trade` — server-side validation logic

This is the one endpoint that actually matters for trust. Pseudocode:

```
1. Look up the team's current_price from the `teams` table directly.
   NEVER accept a price from the request body.
2. If side == 'buy':
   cost = current_price * shares
   if user.cash < cost: reject ("insufficient funds")
   user.cash -= cost
   update holdings: increase shares, recompute avg_cost
     (new_avg = (old_avg*old_shares + cost) / (old_shares + shares))
3. If side == 'sell':
   holding = user's current holding in that team
   if !holding or holding.shares < shares: reject ("insufficient shares")
   proceeds = current_price * shares
   user.cash += proceeds
   holding.shares -= shares (delete the row if it hits 0)
4. Insert one row into `transactions` (the permanent record).
5. Return the updated cash + holding to the frontend.
```

Wrap steps 2-4 in a single database transaction (the SQL kind) so a crash
mid-trade can't leave cash debited without the holding updated, or vice versa.

---

## Pricing engine — port these formulas exactly

These are the real, tuned constants from the current build. Do not
re-derive or approximate them — they were calibrated against real games
during development and are already correct.

### Spread-vs-actual price movement (runs once per completed game)

```js
const SPREAD_FACTOR = 0.75; // fallback: expected point spread per point of strength difference

function computePriceImpact(teamA, scoreA, teamB, scoreB, realLineForA /* optional */) {
  const isReal = typeof realLineForA === "number";
  const expectedMarginA = isReal ? realLineForA : (teamA.strength - teamB.strength) * SPREAD_FACTOR;
  const actualMarginA = scoreA - scoreB;
  const edge = actualMarginA - expectedMarginA; // + = A beat its spread, - = A missed it
  const magnitude = Math.abs(edge);
  const baseMove = Math.min(28, 0.15 + magnitude * 0.32);
  const pctA = round2((edge >= 0 ? 1 : -1) * baseMove + (Math.random() - 0.5) * 0.6);
  const pctB = round2((edge >= 0 ? -1 : 1) * baseMove + (Math.random() - 0.5) * 0.6);
  // Apply pctA to teamA.current_price, pctB to teamB.current_price (multiplicative, floor at $3)
  // Record: lastCovered = edge>=0 for A, edge<=0 for B; lastExpected/lastActual per team's own perspective
}
```

**Critical design property, preserve this exactly:** direction is signed by
whether a team beat or missed ITS OWN spread — not by whether it won the
game. A heavy favorite that barely wins can see its price DROP. A team that
loses by less than expected can see its price RISE. This is intentional
and is the core "feels like a real stock market" mechanic (same as a stock
dropping on an earnings "beat" that still missed guidance).

### Which games use a real line vs. the SP+ fallback

- **Already-played games:** always try to find a real posted spread first
  (from CFBD's `/lines` endpoint, matched by game ID). Only fall back to
  the SP+ estimate if no line exists for that specific game.
- **Future/upcoming games:** use whatever the schedule table's `line`
  column holds — null until a sportsbook posts one (typically ~1 week out),
  at which point the daily job fills it in. Until then, the SP+ fallback
  formula is used to simulate a plausible result for "what if this week
  played out today" purposes, but this should be clearly labeled as
  projected, not real, anywhere it's shown in the UI.

---

## Team strength (`strength` field) — what it's for and how to update it

`strength` is a 0-100ish scale derived from the team's most recent full-season
SP+ rating (from CFBD's `/ratings/sp` endpoint). It drives the spread-fallback
formula above and should be refreshed once per season (not daily) when new
SP+ data is available — daily updates would just be old data restated.

```
strength = round(10 + (rating - min_rating_this_year) / (max_rating_this_year - min_rating_this_year) * 85)
```

Keep this completely separate from `current_price`. `strength` answers
"how good is this team right now, for predicting outcomes." `current_price`
answers "what has the market decided this program is worth," which
starts from history (below) and only moves from real results.

---

## The IPO/baseline price — "Program Prestige Score"

This is what sets a team's *starting* price (used once, at initial seeding,
not recalculated daily). It deliberately does NOT use current-season
performance — that's what the trading engine is for. It answers "who has
this program been," not "how are they playing this week."

Built from 12 seasons (2014–2025) of:
1. **Per-game win value**, weighted by the winning team's own conference tier
   AND by the beaten opponent's quality that season:
   ```
   opp_quality = 0.3                          if opponent was FCS
               = 0.5 + opponent_win_pct       otherwise   (range 0.5–1.5)
   win_value = 6.0 * own_conference_tier * opp_quality * year_recency_weight
   ```
2. **Conference championship bonus:** +8 for appearing, +16 for winning
   (both × that year's recency weight). Detect these STRUCTURALLY, not by
   text label — look for: game in the final or second-to-final week of the
   regular season, `neutral_site = true`, both teams share a conference,
   and that conference isn't "FBS Independents." Explicitly exclude the
   Army-Navy game by name — it structurally matches this pattern but is not
   a real conference championship.
3. **CFP/bowl bonus**, detected from the postseason games' `notes` field.
   Do a case-insensitive, format-tolerant match — real historical data uses
   inconsistent formatting across years (e.g., `"ALLSTATE SUGAR BOWL -
   SEMIFINAL"` in 2014 vs. `"College Football Playoff Semifinal..."` in
   2025). Match on the substrings `quarterfinal`, `semifinal`, `national
   championship` appearing anywhere in the lowercased notes, in that
   priority order (most advanced stage wins if multiple match):
   ```
   STAGE_APPEAR = {1: 6, 2: 14, 3: 26, 4: 45}   // 1=first round, 2=QF, 3=SF, 4=natty
   STAGE_WIN    = {1: 8, 2: 12, 3: 19, 4: 30}
   bonus = STAGE_APPEAR[stage] * recency + (won ? STAGE_WIN[stage] * recency : 0)
   ```
   Anything postseason that ISN'T a CFP-stage game gets a flat bowl bonus:
   `(3 + (won ? 6 : 0)) * recency`.
4. **Current recruiting talent** (CFBD `/talent` endpoint, most recent year)
   as a smaller, non-year-weighted addition: normalize 0–1 across all teams,
   multiply by 18, add directly to the raw score.

**Conference tier weights** (SEC and Big Ten weighted highest per explicit
product decision — this isn't SP+'s own weighting, it's layered on top):
```
SEC: 1.45          Big Ten: 1.30
ACC: 1.12          Big 12: 1.12
American Athletic: 0.78     Mountain West: 0.76
Conference USA: 0.70        Sun Belt: 0.70
Mid-American: 0.65
FBS Independents: null  →  use the average tier of that team's actual
                           opponents that season instead (handles Notre
                           Dame; excludes lower-division/unmatched
                           opponents from the average)
Pac-12: 1.12 for seasons ≤2023 (the real power conference), 0.72 for
        seasons ≥2024 (the rebuilt, G5-tier version) — SAME conference
        name, two genuinely different eras. Do not conflate them.
```

**Recency weighting** (12-year window, smooth decay, not a cliff):
```
recency(year) = round(0.30 + 0.85 * ((year - 2014) / (2025 - 2014)) ** 1.25, 3)
// 2014 → 0.300, 2019 → 0.617, 2022 → 0.871, 2025 → 1.150
```

**Final conversion:** rescale every team's raw total linearly to a 10–100
"prestige" score across the full field, then `price = round(8 + prestige * 0.5, 2)`.

**Known gaps, worth deciding on rather than silently inheriting:**
- Two 2026 FBS newcomers (Sacramento State, North Dakota State) have zero
  years of FBS history in this window, so they can't run through the formula
  at all — they were manually floored at $13.00 and $14.50 respectively as a
  judgment call, not a calculation. Any future FBS transition needs the same
  manual treatment until it accumulates real history.
- The model only sees 2014 onward. A program's pre-2014 history (e.g.
  Oklahoma's 2000s titles) is invisible to it. This was a deliberate scope
  decision, not an oversight — flagging it so it isn't "fixed" by accident
  by someone who doesn't know it was intentional.

---

## Daily scheduled job (GitHub Actions cron)

Run once daily in the off-season, and 2-3× on gamedays (Thu/Fri/Sat evenings
during the season) so results land same-day rather than next-morning.

```
1. GET https://api.collegefootballdata.com/games?year=2026&seasonType=regular&division=fbs
   - For any game now showing completed=true that wasn't before:
     run computePriceImpact() using that game's real score, update `teams`,
     insert a `price_events` row, mark `schedule.completed = true` with scores.
2. GET https://api.collegefootballdata.com/lines?year=2026&seasonType=regular
   - For any schedule row still missing a `line`, check if one has posted;
     if so, write it in (home-perspective, negative = home favored — CFBD's
     raw `spread` field is negative-favors-home already; no sign flip needed
     going INTO the schedule table, only when computing expected margin, see
     `-avg(spreads)` convention used when building the reference dataset).
3. Once per season only (e.g. one extra manual trigger in late December):
   re-pull /ratings/sp for the just-completed season and refresh `strength`
   for all teams, and re-run the full Program Prestige Score rebuild for
   next season's opening prices (this only matters at the START of a new
   season — don't run it mid-season, it would silently reset everyone's
   trading history back to an IPO price).
```

---

## Migration: seeding the database from the existing artifact

1. Open the reference artifact link above, view source, extract the
   `SEED_TEAMS`, `TEAM_COLORS`, `PRESTIGE_PRICE`, and `MASCOTS` JS objects
   directly (138 entries each) — these are already correct and validated;
   do not regenerate them from scratch.
2. Join them into the `teams` table's initial insert.
3. Extract `REAL_RESULTS_2026` and `REAL_SCHEDULE_2026` the same way to
   seed `price_events` (replay each one through `computePriceImpact` in
   week order to build correct price history) and `schedule`.

---

## Suggested build order

1. Supabase project + schema above + seed script (teams, schedule) — get
   read-only `/teams` working end to end before touching trading at all.
2. Auth (Supabase's built-in email login is enough to start).
3. `/trade` endpoint + the three tables it touches (users, holdings,
   transactions) — test this thoroughly with fake data before wiring the
   real frontend to it.
4. Port the existing frontend to call the API instead of `localStorage`.
   The UI/UX (cards, detail view, week/season toggle, covered/missed
   badges) can be reused almost as-is — only the data-fetching layer changes.
5. The GitHub Actions daily job, pointed at a staging environment first.
6. Only once 1–5 are solid: leaderboard, multiple concurrent users, anything
   further out.

## Environment variables needed

```
CFBD_API_KEY=            # already obtained
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=   # backend only, never exposed to frontend
SUPABASE_ANON_KEY=           # frontend, safe to expose
```
