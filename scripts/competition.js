#!/usr/bin/env node
// Manages public competitions by hand: sets a prize and sponsor, or creates a
// one-off event (Rivalry Week, Bowl Season, ...). Weekly sprints, monthlies
// and the season championship are listed automatically.
//
//   npm run competition -- --list
//   npm run competition -- --code season-2026 --prize "$250 Fanatics gift card" \
//       --sponsor-name "Acme Tailgate" --sponsor-url https://example.com
//   npm run competition -- --create --name "Rivalry Week" \
//       --starts 2026-11-26T12:00 --ends 2026-11-30T12:00 --min-trades 2
//   (times are Eastern; add --dry-run to check without saving)
//
// Also runnable from GitHub: Actions -> Competition -> Run workflow.

import { createPool } from "../src/db/store.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`) || process.env[`COMP_${name.toUpperCase().replace(/-/g, "_")}`] === "true";
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : process.env[`COMP_${name.toUpperCase().replace(/-/g, "_")}`];
  return v === undefined || v === "" ? undefined : String(v).trim();
};
const action = flag("list") || process.env.COMP_ACTION === "list" ? "list"
  : flag("create") || process.env.COMP_ACTION === "create" ? "create"
  : "update";
const dryRun = flag("dry-run");

const ET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const problems = [];
const prize = arg("prize");
const sponsorName = arg("sponsor-name");
const sponsorUrl = arg("sponsor-url");
if (prize !== undefined && prize.length > 120) problems.push("--prize must be at most 120 characters");
if (sponsorName !== undefined && sponsorName.length > 60) problems.push("--sponsor-name must be at most 60 characters");
if (sponsorUrl !== undefined && sponsorUrl !== "none" && !/^https:\/\/\S+$/.test(sponsorUrl)) problems.push("--sponsor-url must start with https://");

let code = arg("code")?.toLowerCase();
const name = arg("name");
const starts = arg("starts");
const ends = arg("ends");
const minTrades = arg("min-trades") === undefined ? 1 : Number(arg("min-trades"));
if (action === "create") {
  if (!name || name.length < 3 || name.length > 60) problems.push("--name must be 3-60 characters");
  if (!ET.test(starts ?? "")) problems.push("--starts must look like 2026-11-26T12:00 (Eastern)");
  if (!ET.test(ends ?? "")) problems.push("--ends must look like 2026-11-30T12:00 (Eastern)");
  if (!Number.isInteger(minTrades) || minTrades < 0 || minTrades > 50) problems.push("--min-trades must be 0-50");
  const slug = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28).replace(/^-|-$/g, "");
  code ??= `event-${slug}-${(starts || "").slice(0, 4)}`;
}
if (action === "update" && !code) problems.push("--code is required (see --list)");
if (code && !/^[a-z0-9-]{3,40}$/.test(code)) problems.push("--code must be 3-40 lowercase letters, digits or dashes");
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

// "none" clears a field; leaving it out keeps what's there.
const clear = (v) => (v === "none" ? null : v);

const pool = createPool();
try {
  if (action === "list") {
    const { rows } = await pool.query(
      `select code, name, starts_at, ends_at, min_trades, prize, sponsor_name, finished,
              (select count(*) from competition_entries e where e.competition_id = c.id)::int as entrants
         from competitions c where not is_private order by finished, starts_at`
    );
    for (const r of rows) {
      console.log(
        `${r.code.padEnd(24)} ${r.name} | ${r.starts_at.toISOString()} -> ${r.ends_at.toISOString()} | ` +
          `${r.entrants} entrants | min ${r.min_trades} trades${r.prize ? ` | prize: ${r.prize}` : ""}` +
          `${r.sponsor_name ? ` | presented by ${r.sponsor_name}` : ""}${r.finished ? " | finished" : ""}`
      );
    }
  } else if (action === "create") {
    if (dryRun) {
      console.log(`[dry run] would create ${code}: ${name}, ${starts} -> ${ends} ET, min ${minTrades} trades`);
    } else {
      await pool.query(
        `insert into competitions (code, kind, name, starts_at, ends_at, min_trades, prize, sponsor_name, sponsor_url)
         values ($1, 'event', $2, $3::timestamp at time zone 'America/New_York', $4::timestamp at time zone 'America/New_York',
                 $5, $6, $7, $8)`,
        [code, name, starts, ends, minTrades, clear(prize) ?? null, clear(sponsorName) ?? null, clear(sponsorUrl) ?? null]
      );
      console.log(`created ${code}: ${name}. Players see it under Compete.`);
    }
  } else {
    const { rows } = await pool.query("select name, is_private from competitions where code = $1", [code]);
    if (!rows.length || rows[0].is_private) throw new Error(`no public competition ${code} (see --list)`);
    const sets = [];
    const values = [code];
    for (const [col, v] of [["prize", prize], ["sponsor_name", sponsorName], ["sponsor_url", sponsorUrl]]) {
      if (v === undefined) continue;
      values.push(clear(v));
      sets.push(`${col} = $${values.length}`);
    }
    if (!sets.length) throw new Error("nothing to change: pass --prize, --sponsor-name or --sponsor-url");
    if (dryRun) {
      console.log(`[dry run] ${code} (${rows[0].name}): ${sets.length} change(s)`);
    } else {
      await pool.query(`update competitions set ${sets.join(", ")} where code = $1`, values);
      console.log(`updated ${code} (${rows[0].name})`);
    }
  }
} finally {
  await pool.end();
}
