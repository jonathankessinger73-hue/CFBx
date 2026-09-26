#!/usr/bin/env node
// Daily CFBD sync. Usage:
//   DATABASE_URL=... CFBD_API_KEY=... node src/jobs/daily.js [--season 2026] [--dry-run]

import { createPool } from "../db/store.js";
import { createCfbdClient } from "../cfbd/client.js";
import { syncSeason } from "./syncSeason.js";

const args = process.argv.slice(2);
const seasonIdx = args.indexOf("--season");
const season = seasonIdx >= 0 ? Number(args[seasonIdx + 1]) : Number(process.env.SEASON || 2026);
const dryRun = args.includes("--dry-run");

const pool = createPool();
try {
  const summary = await syncSeason({ pool, cfbd: createCfbdClient(), season, dryRun });
  console.log(
    `${dryRun ? "[dry run] " : ""}season ${season}: ${summary.linesPosted} lines posted, ` +
      `${summary.gamesApplied} games applied, ${summary.fcsGames} FCS games recorded, ${summary.unmatched.length} unmatched, ` +
      `${summary.recordsUpdated} records, ${summary.logosUpdated} logos`
  );
} finally {
  await pool.end();
}
