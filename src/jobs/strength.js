#!/usr/bin/env node
// Weekly strength refresh from CFBD SP+. Usage:
//   DATABASE_URL=... CFBD_API_KEY=... node src/jobs/strength.js [--season 2026] [--dry-run]

import { createPool } from "../db/pg.js";
import { createCfbdClient } from "../cfbd/client.js";
import { refreshStrength } from "./refreshStrength.js";

const args = process.argv.slice(2);
const seasonIdx = args.indexOf("--season");
const season = seasonIdx >= 0 ? Number(args[seasonIdx + 1]) : Number(process.env.SEASON || 2026);
const dryRun = args.includes("--dry-run");

const pool = createPool();
try {
  const r = await refreshStrength({ pool, cfbd: createCfbdClient(), season, dryRun });
  console.log(
    r.skipped
      ? `${dryRun ? "[dry run] " : ""}skipped: not enough SP+ ratings yet`
      : `${dryRun ? "[dry run] " : ""}season ${season} week ${r.week}: ${r.rated} rated, ${r.updated} strengths changed`
  );
} finally {
  await pool.end();
}
