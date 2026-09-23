# Setting up CFBx: Supabase + CollegeFootballData

This guide assumes you've never used Supabase, Postgres or GitHub Actions
before. Budget about an hour. Each part ends with a check, so you know it
worked before moving on.

You'll set up four things:

1. **Supabase**: the database (teams, prices, accounts) and email sign-in.
2. **Your computer**: run the app locally against Supabase.
3. **CollegeFootballData (CFBD)**: real results, lines and ratings.
4. **GitHub Actions**: runs the jobs on a schedule, so your computer can be off.

A **secret** below means a value that must never be shared, posted or
committed to git. Secrets go only in your `.env` file (which git ignores) and
in GitHub's secret settings.

---

## Part 0: Prerequisites

1. **Node.js 22 or newer.** Check with `node --version` in a terminal. If it's
   missing or older than v22.9, install the LTS version from https://nodejs.org.
2. **Git.** Check with `git --version`. Install from https://git-scm.com if missing.
3. **The code.** All the work so far is on the branch
   `claude/session-start-78jjym`, not on `main` yet:

   ```
   git clone https://github.com/jonathankessinger73-hue/CFBx.git
   cd CFBx
   git checkout claude/session-start-78jjym
   npm install
   ```

   ✅ `npm install` ends with "found 0 vulnerabilities" (or similar) and no errors.

---

## Part 1: Supabase

### 1.1 Create the project

1. Sign up at https://supabase.com (GitHub login is easiest).
2. Click **New project**.
   - **Name:** `cfbx`
   - **Database password:** click **Generate a password**, then **copy it
     somewhere safe** (a password manager). This is a secret. You'll need it in
     step 1.3, and Supabase won't show it again (you can reset it later).
     Tip: a password made of only letters and numbers avoids a URL-encoding
     headache in step 1.3.
   - **Region:** the one closest to you (or to where you'll host the app later).
3. Click **Create new project** and wait a minute or two while it sets up.

### 1.2 Get the project URL and the public key

1. In the left sidebar, open **Project Settings** (gear icon) → **Data API**.
   Copy the **Project URL** (looks like `https://abcdefghijkl.supabase.co`).
2. Open **Project Settings** → **API Keys**. Copy the **publishable** key
   (starts with `sb_publishable_`). If your project only shows **Legacy API
   keys**, copy the one labelled **anon** / **public** instead. Either works.

   ⚠️ Do **not** use the **secret** / **service_role** key anywhere in this
   app. It bypasses all security. The app doesn't need it.

### 1.3 Get the database connection string

1. Click the **Connect** button at the top of the project dashboard.
2. Pick the **Connection String** tab, and under the connection method choose
   **Session pooler**. It looks like:

   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```

   Use the **Session pooler**, not "Direct connection". The direct address is
   IPv6-only, and GitHub Actions (and many home networks) can't reach it.
3. Replace `[YOUR-PASSWORD]`, including the brackets, with the password from 1.1.
   If your password contains any of `@ : / ? # % &`, either reset it to one
   with only letters and numbers (**Project Settings → Database → Reset database
   password**) or URL-encode those characters (for example `@` → `%40`).

This whole string is a **secret**; it contains your password.

### 1.4 Download the SSL certificate

This makes the connection to the database encrypted and verified.

1. **Project Settings → Database → SSL Configuration → Download certificate.**
2. Save the file into your `CFBx` folder as `supabase-ca.crt`. (`*.crt` files
   are git-ignored, so it won't be committed.)

### 1.5 Set up email sign-in

1. **Authentication → URL Configuration**
   - **Site URL:** `http://localhost:3000`
   - **Redirect URLs:** add `http://localhost:3000/**`

   Sign-in links send people back to these addresses. When you deploy the app
   later, add its real address here too.
2. **Authentication → Sign In / Providers**: make sure **Email** is enabled
   (it is by default).
3. **About emails:** Supabase's built-in email sender is for testing only. It
   only delivers to email addresses of members of your Supabase organization
   (so, **your own address**), and only a few per hour. That's fine for now.
   Before letting other people sign in, set up your own email provider under
   **Authentication → Emails → SMTP Settings** (Resend, Postmark and SendGrid
   all have free tiers).

---

## Part 2: Run it on your computer

### 2.1 Create your `.env` file

In the `CFBx` folder:

```
cp .env.example .env        # on Windows: copy .env.example .env
```

Open `.env` in a text editor and fill in:

```
CFBD_API_KEY=                       # leave blank until Part 3
SUPABASE_URL=https://abcdefghijkl.supabase.co          # from 1.2
SUPABASE_ANON_KEY=sb_publishable_...                   # from 1.2
DATABASE_URL=postgresql://postgres.abcdefghijkl:...    # from 1.3, password filled in
DATABASE_CA_CERT_FILE=./supabase-ca.crt                # from 1.4
PORT=3000
```

Leave the other lines as they are. Don't add `?sslmode=...` to `DATABASE_URL`.
The certificate file handles encryption.

### 2.2 Create the tables

```
npm run migrate
```

✅ You should see four lines: `applied 001_schema.sql` through
`applied 004_strength_and_prestige.sql`. Running it again prints nothing,
because each migration only applies once.

### 2.3 Load the teams and the season so far

```
npm run seed
```

✅ `seeded 138 teams, 761 schedule rows, 314 price events`.
Check it in Supabase: **Table Editor → teams** shows 138 rows.

The seed only runs on an empty database. If you run it again it refuses on
purpose, so it can't reset a live market.

### 2.4 Start the app and sign in

```
npm run dev
```

1. Open http://localhost:3000. The market shows all 138 programs.
2. Click **Sign in** and enter the **same email you used for Supabase** (see 1.5.3).
3. Open the email, click the link, and you're back in the app, signed in with
   $10,000 in cash.
4. Buy a few shares of something. Then check **Table Editor → transactions** in
   Supabase: your trade is there.

Stop the app with `Ctrl+C`.

---

## Part 3: CollegeFootballData

### 3.1 Add your API key

If you don't have a key yet, request one at https://collegefootballdata.com/key.
It arrives by email. The key is a **secret**. Put it in `.env`:

```
CFBD_API_KEY=your-key-here
```

About usage limits: CFBD plans have a monthly API call limit (check yours on
your CFBD account page). With the schedules in Part 4, CFBx uses roughly 110
calls a month. A prestige rebuild uses about 25 more, and repeat runs are
cached on disk.

### 3.2 Try each job in dry-run mode first

Dry runs fetch real data and print what *would* happen, but change nothing.

**Daily results + lines:**

```
npm run job:daily -- --dry-run
```

✅ Look for lines like `line posted: week 5 ...` and `final: week 4 ...`, then a
summary: `[dry run] season 2026: N lines posted, N games applied, N unmatched`.
"Unmatched" should be 0 or close to it. If you see real FBS games listed as
unmatched, send me the list: it usually means a team name needs an alias in
`src/cfbd/teamNames.js`.

**Weekly strength (SP+):**

```
npm run job:strength -- --dry-run
```

✅ A list of the biggest strength changes, then
`[dry run] season 2026 week N: 138 rated, N strengths changed`. If it says
"not enough SP+ ratings yet", CFBD hasn't published this season's SP+ yet.
That's safe; the job just waits.

**Prestige rebuild (report only):**

```
npm run job:prestige -- --season 2026
```

This rebuilds *this* season's opening prices from 2014–2025, just to compare
with the prices you're using now. It never applies anything without
`--apply`, and applying for 2026 would be refused anyway because the season has
started. Open `reports/prestige-2026.json` and look at:
- the price and `change_vs_current_ipo` for each team: do the rankings look
  sensible?
- `report.championships`: are the conference title games right (including
  hosted ones marked `on campus`)?
- `unmatchedFbsSchools`: schools that aren't in the market. Fine for programs
  that left FBS, but tell me about any that should match.

### 3.3 Run them for real

When the dry runs look right:

```
npm run job:daily
npm run job:strength
```

✅ `npm run dev` again: team pages show any new results in the game log, and
upcoming games show REAL LINE tags where lines were posted.

---

## Part 4: GitHub Actions (automatic schedule)

### 4.1 Merge the code into `main`

GitHub only runs scheduled workflows from the repository's **default branch**
(`main`). Until the work is merged, the schedules won't run and the workflows
won't show a **Run workflow** button. Open a pull request from
`claude/session-start-78jjym` into `main` and merge it. I can open the pull
request for you if you'd like.

### 4.2 Add the secrets

1. On GitHub, open the repo → **Settings → Environments → New environment**.
   Name it exactly `staging`.
2. Under **Environment secrets**, click **Add environment secret** three times:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the full connection string from 1.3 |
   | `DATABASE_CA_CERT` | open `supabase-ca.crt` in a text editor and paste **all** of it, including the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines |
   | `CFBD_API_KEY` | your CFBD key |

The workflows use the `staging` environment by default. Later, if you create a
second Supabase project for production, make a `production` environment with
its secrets. Then, under **Settings → Secrets and variables → Actions →
Variables**, add a repository variable `CFBX_JOB_ENVIRONMENT` = `production`.

### 4.3 Run each workflow once by hand

**Actions** tab → pick a workflow → **Run workflow**:

1. **CFBD sync** with **dry run** checked. ✅ Green check; open the run and read
   the log, which matches what you saw locally.
2. **Weekly strength refresh** with **dry run** checked.
3. Run both again with dry run unchecked.

After that they run by themselves:

| Workflow | Schedule |
|---|---|
| CFBD sync | daily, plus Thursday/Friday/Saturday nights |
| Weekly strength refresh | Tuesdays, August–January |
| Prestige rebuild | never automatically; run it by hand before each new season |

A red ✗ on a run means something failed; GitHub emails you. Open the run to see
the error.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `password authentication failed` | Wrong password in `DATABASE_URL`, or it contains special characters that need URL-encoding (1.3). |
| `ENOTFOUND` / `ENETUNREACH` / timeout connecting | You used the Direct connection string. Use the **Session pooler** one (1.3). |
| `self-signed certificate in certificate chain` | `DATABASE_CA_CERT_FILE` is missing or points at the wrong file, or `DATABASE_URL` has `?sslmode=require` on the end (remove it). |
| `migrate` fails on `001_schema.sql` with a permission error on `auth.users` | Open Supabase **SQL Editor**, paste each file from `db/migrations/` in order, and click **Run**. Tell me which statement failed. |
| Sign-in email never arrives | The built-in email sender only delivers to your Supabase organization's members and is heavily rate-limited (1.5.3). Check spam, wait a few minutes, or set up custom SMTP. |
| Clicking the email link opens a "can't reach" page | The Site URL / Redirect URLs in 1.5.1 don't match where the app is running. |
| `CFBD /games failed: 401` | `CFBD_API_KEY` is wrong or missing. |
| `CFBD ... 429` | You've hit your CFBD plan's call limit for the month. |
| Scheduled workflows never run | The code isn't merged into `main` yet (4.1). |
| Supabase says the project is paused | Free projects pause after a period of inactivity. Click **Restore project** in the dashboard. |
