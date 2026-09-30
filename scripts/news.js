#!/usr/bin/env node
// Posts a market news move by hand: coaching changes, suspensions, anything
// with no data feed. Moves the team's price and shows under "market news".
//
//   npm run news -- --team UGA --pct -5 --summary "Head coach leaves for the NFL"
//   (add --dry-run to check it without posting)
//
// Also runnable from GitHub: Actions -> Market news -> Run workflow.

import { createPool } from "../src/db/store.js";

const MAX_PCT = 15;

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : process.env[`NEWS_${name.toUpperCase()}`];
};
const team = String(arg("team") ?? "").trim().toUpperCase();
const pct = Number(arg("pct"));
const summary = String(arg("summary") ?? "").trim();
const dryRun = args.includes("--dry-run") || process.env.NEWS_DRY_RUN === "true";

const problems = [];
if (!/^[A-Z0-9]{1,8}$/.test(team)) problems.push("--team must be a ticker, like UGA");
if (!Number.isFinite(pct) || pct === 0 || Math.abs(pct) > MAX_PCT) problems.push(`--pct must be a non-zero number between -${MAX_PCT} and ${MAX_PCT}`);
if (summary.length < 5 || summary.length > 140) problems.push("--summary must be 5-140 characters");
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const pool = createPool();
try {
  const { rows } = await pool.query("select name, current_price from teams where id = $1", [team]);
  if (!rows.length) throw new Error(`no team with ticker ${team}`);
  const { rows: clock } = await pool.query("select coalesce(max(season), extract(year from now())::int) as season from schedule");
  const season = clock[0].season;
  if (dryRun) {
    console.log(`[dry run] ${team} (${rows[0].name}, $${rows[0].current_price}) ${pct > 0 ? "+" : ""}${pct}%: ${summary}`);
  } else {
    const ref = `manual:${new Date().toISOString()}`;
    await pool.query("select apply_news_move($1, $2, null, 'news', $3, $4, $5)", [team, season, ref, pct, summary]);
    const { rows: after } = await pool.query("select current_price from teams where id = $1", [team]);
    console.log(`${team} ${pct > 0 ? "+" : ""}${pct}%: $${rows[0].current_price} -> $${after[0].current_price} (${summary})`);
  }
} finally {
  await pool.end();
}
