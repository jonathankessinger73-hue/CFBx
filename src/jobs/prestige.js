#!/usr/bin/env node
// Program Prestige Score rebuild. Run once per season, BEFORE the season's
// first game, to set opening prices.
//
//   DATABASE_URL=... CFBD_API_KEY=... node src/jobs/prestige.js --season 2027
//       [--end-year 2026] [--talent-year 2027] [--out reports/prestige-2027.json]
//       [--cache-dir .cache/cfbd] [--apply]
//
// Without --apply it only writes the report (every team's price and the
// breakdown behind it) so it can be reviewed first.

import fs from "node:fs";
import path from "node:path";
import { createPool } from "../db/pg.js";
import { createCfbdClient } from "../cfbd/client.js";
import { buildPrestige, applyPrestige } from "../prestige/rebuild.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const season = Number(opt("season"));
if (!Number.isInteger(season)) {
  console.error("--season <year> is required (the season these opening prices are for)");
  process.exit(2);
}
const endYear = Number(opt("end-year", season - 1));
const talentYear = Number(opt("talent-year", season));
const out = opt("out", `reports/prestige-${season}.json`);
const cacheDir = opt("cache-dir", ".cache/cfbd");
const apply = args.includes("--apply");

const pool = createPool();
try {
  const result = await buildPrestige({
    pool,
    cfbd: createCfbdClient({ cacheDir }),
    season,
    endYear,
    talentYear,
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");

  console.log(`\nwindow ${result.window.start}-${result.window.end}, talent ${result.talentYear}`);
  console.log("rank  team    price   prestige   vs current IPO");
  result.rows.slice(0, 25).forEach((r, i) =>
    console.log(
      `${String(i + 1).padStart(4)}  ${r.ticker.padEnd(6)} ${r.price.toFixed(2).padStart(6)}   ` +
        `${r.manual ? "manual" : r.prestige.toFixed(1).padStart(6)}   ${r.change_vs_current_ipo >= 0 ? "+" : ""}${r.change_vs_current_ipo.toFixed(2)}`
    )
  );
  console.log(`... ${result.rows.length} teams priced; full report: ${out}`);
  console.log(`conference championships detected: ${result.report.championships.length}, playoff games: ${result.report.playoff.length}`);
  if (result.missing.length) console.log(`NO PRICE (no FBS history, not in MANUAL_PRICES): ${result.missing.join(", ")}`);
  if (result.unmatchedFbsSchools.length) {
    console.log(`FBS schools not in the market (fine if they're gone/not listed): ${result.unmatchedFbsSchools.join(", ")}`);
  }

  if (apply) {
    const n = await applyPrestige(pool, result);
    console.log(`applied opening prices for ${n} teams to season ${season}`);
  } else {
    console.log("report only; re-run with --apply to set these as opening prices");
  }
} finally {
  await pool.end();
}
