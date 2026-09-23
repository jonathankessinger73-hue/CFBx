#!/usr/bin/env node
// Seeds an empty database from data/*.json (extracted from the reference
// artifact). Usage: DATABASE_URL=... node scripts/seed.js [--season 2026]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/store.js";
import { buildSeed } from "../src/seed/buildSeed.js";
import { writeSeed } from "../src/seed/writeSeed.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seasonArg = process.argv.indexOf("--season");
const season = seasonArg > 0 ? Number(process.argv[seasonArg + 1]) : 2026;
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, "data", f), "utf8"));

const seed = buildSeed({
  teams: read("teams.json"),
  results: read(`results-${season}.json`),
  schedule: read(`schedule-${season}.json`),
  season,
});

const pool = createPool();
try {
  const counts = await writeSeed(pool, seed);
  console.log(`seeded ${counts.teams} teams, ${counts.schedule} schedule rows, ${counts.events} price events`);
} finally {
  await pool.end();
}
