#!/usr/bin/env node
// Extracts the validated seed tables from the reference artifact HTML
// (reference/cfbx-artifact.html) into JSON under data/. Run this whenever the
// reference artifact is refreshed; never hand-edit the generated JSON.
//
//   node scripts/extract-artifact.js [path/to/artifact.html]

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = process.argv[2] || path.join(root, "reference", "cfbx-artifact.html");
const html = fs.readFileSync(htmlPath, "utf8");

// Pull the source of one `var NAME = <literal>;` declaration.
function literalSource(name) {
  const start = html.indexOf(`var ${name} = `);
  if (start < 0) throw new Error(`${name} not found in ${htmlPath}`);
  const open = start + `var ${name} = `.length;
  const openCh = html[open];
  const closeCh = openCh === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"' || ch === "'") {
      // skip string literal
      const q = ch;
      for (i++; html[i] !== q; i++) if (html[i] === "\\") i++;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`unterminated literal for ${name}`);
}

function evalLiteral(name) {
  return vm.runInNewContext(`(${literalSource(name)})`);
}

const SEED_TEAMS = evalLiteral("SEED_TEAMS");
const TEAM_COLORS = evalLiteral("TEAM_COLORS");
const PRESTIGE_PRICE = evalLiteral("PRESTIGE_PRICE");
const MASCOTS = evalLiteral("MASCOTS");
const REAL_RESULTS_2026 = evalLiteral("REAL_RESULTS_2026");
const REAL_SCHEDULE_2026 = evalLiteral("REAL_SCHEDULE_2026");

const round2 = (n) => Math.round(n * 100) / 100;

const teams = SEED_TEAMS.map((t) => {
  const colors = TEAM_COLORS[t.id] || ["#3A4657", "#8993A3"];
  const ipo = PRESTIGE_PRICE[t.id] !== undefined ? PRESTIGE_PRICE[t.id] : 8 + t.strength * 0.5;
  return {
    id: t.id,
    name: t.name,
    mascot: MASCOTS[t.id] || null,
    conference: t.conf,
    strength: t.strength,
    primary_color: colors[0],
    secondary_color: colors[1],
    ipo_price: round2(ipo),
  };
});

const ids = new Set(teams.map((t) => t.id));
const problems = [];
for (const t of teams) {
  if (!(t.id in TEAM_COLORS)) problems.push(`${t.id}: no TEAM_COLORS entry`);
  if (!(t.id in PRESTIGE_PRICE)) problems.push(`${t.id}: no PRESTIGE_PRICE entry`);
  if (!(t.id in MASCOTS)) problems.push(`${t.id}: no MASCOTS entry`);
}
for (const g of [...REAL_RESULTS_2026, ...REAL_SCHEDULE_2026]) {
  for (const id of [g.home, g.away]) if (!ids.has(id)) problems.push(`week ${g.week}: unknown team ${id}`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

// The artifact stores `line` as the expected HOME margin (positive = home
// favored). We keep that convention in the JSON and name it explicitly so it
// can't be confused with CFBD's raw `spread` (negative = home favored).
const results = REAL_RESULTS_2026.map((g) => ({
  week: g.week,
  home: g.home,
  away: g.away,
  home_score: g.homeScore,
  away_score: g.awayScore,
  expected_home_margin: typeof g.line === "number" ? g.line : null,
}));
const schedule = REAL_SCHEDULE_2026.map((g) => ({
  week: g.week,
  home: g.home,
  away: g.away,
  expected_home_margin: typeof g.line === "number" ? g.line : null,
}));

const outDir = path.join(root, "data");
fs.mkdirSync(outDir, { recursive: true });
const write = (file, obj) =>
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(obj, null, 2) + "\n");
write("teams.json", teams);
write("results-2026.json", results);
write("schedule-2026.json", schedule);

console.log(
  `extracted ${teams.length} teams, ${results.length} completed games, ${schedule.length} scheduled games`
);
