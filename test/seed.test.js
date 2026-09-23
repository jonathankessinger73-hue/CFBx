import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSeed } from "../src/seed/buildSeed.js";

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const teams = read("teams.json");
const results = read("results-2026.json");
const schedule = read("schedule-2026.json");

test("extracted data covers all 138 teams with colors, mascots and IPO prices", () => {
  assert.equal(teams.length, 138);
  assert.equal(new Set(teams.map((t) => t.id)).size, 138);
  for (const t of teams) {
    assert.ok(t.mascot, `${t.id} mascot`);
    assert.match(t.primary_color, /^#[0-9A-F]{6}$/i);
    assert.ok(t.ipo_price >= 8, `${t.id} ipo`);
  }
  // Manually floored FBS newcomers (see spec "Known gaps").
  assert.equal(teams.find((t) => t.id === "SACST").ipo_price, 13);
  assert.equal(teams.find((t) => t.id === "NDSU").ipo_price, 14.5);
});

test("seed replays every completed game and converts lines to CFBD convention", () => {
  const seed = buildSeed({ teams, results, schedule, season: 2026, random: () => 0.5 });
  assert.equal(seed.teams.length, 138);
  assert.equal(seed.events.length, results.length * 2);
  assert.equal(seed.schedule.length, results.length + schedule.length);
  assert.equal(seed.schedule.filter((g) => g.completed).length, results.length);

  // Artifact: TCU (home) favored by 7.5 over UNC -> CFBD spread -7.5.
  const tcu = seed.schedule.find((g) => g.week === 1 && g.home_team_id === "TCU");
  assert.equal(tcu.line, -7.5);

  // Last price event for each team matches its final price.
  const last = new Map();
  for (const e of seed.events) last.set(e.team_id, e.price_after);
  for (const t of seed.teams) {
    if (last.has(t.id)) assert.equal(t.current_price, last.get(t.id), t.id);
    else assert.equal(t.current_price, t.ipo_price, t.id);
  }

  // TCU was favored by 7.5 at home and lost 10-15: missed, price down.
  const tcuEvent = seed.events.find((e) => e.team_id === "TCU" && e.week === 1);
  assert.equal(tcuEvent.expected_margin, 7.5);
  assert.equal(tcuEvent.actual_margin, -5);
  assert.ok(tcuEvent.pct_change < 0);
});
