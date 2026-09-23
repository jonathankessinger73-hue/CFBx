import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recency,
  cfpStage,
  conferenceTier,
  isConferenceChampionship,
  computePrestige,
} from "../src/prestige/score.js";

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.01, `${msg}: ${actual} vs ${expected}`);

test("recency matches the spec's reference points", () => {
  assert.equal(recency(2014, 2014, 2025), 0.3);
  assert.equal(recency(2019, 2014, 2025), 0.617);
  assert.equal(recency(2022, 2014, 2025), 0.871);
  assert.equal(recency(2025, 2014, 2025), 1.15);
});

test("CFP stage parsing tolerates historical formats, most advanced stage wins", () => {
  assert.equal(cfpStage("ALLSTATE SUGAR BOWL - SEMIFINAL"), 3);
  assert.equal(cfpStage("College Football Playoff Semifinal at the Cotton Bowl Classic"), 3);
  assert.equal(cfpStage("College Football Playoff National Championship Presented by AT&T"), 4);
  assert.equal(cfpStage("CFP Quarterfinal - Rose Bowl Game presented by Prudential"), 2);
  assert.equal(cfpStage("College Football Playoff First Round Game"), 1);
  assert.equal(cfpStage("National Championship after the Semifinal"), 4);
  assert.equal(cfpStage("Duke's Mayo Bowl"), 0);
  assert.equal(cfpStage("FCS Playoff First Round".replace("Playoff", "Tournament")), 0);
  assert.equal(cfpStage(null), 0);
});

test("conference tiers, including the two Pac-12 eras", () => {
  assert.equal(conferenceTier("SEC", 2020), 1.45);
  assert.equal(conferenceTier("Big Ten", 2020), 1.3);
  assert.equal(conferenceTier("Pac-12", 2023), 1.12);
  assert.equal(conferenceTier("Pac-12", 2024), 0.72);
  assert.equal(conferenceTier("FBS Independents", 2020), null);
});

test("conference championship detection is structural and excludes Army-Navy", () => {
  const base = { seasonType: "regular", neutralSite: true, week: 14, home: "A", away: "B", homeConference: "SEC", awayConference: "SEC" };
  assert.equal(isConferenceChampionship(base, 15), true); // second-to-final week
  assert.equal(isConferenceChampionship({ ...base, week: 15 }, 15), true); // final week
  assert.equal(isConferenceChampionship({ ...base, week: 13 }, 15), false);
  // Neutral site: counts even if the conference has other games that week.
  assert.equal(isConferenceChampionship(base, 15, 3), true);
  // On campus: counts only as the conference's lone conference game that week
  // (hosted title games), not in rivalry week.
  assert.equal(isConferenceChampionship({ ...base, neutralSite: false }, 15, 1), true);
  assert.equal(isConferenceChampionship({ ...base, neutralSite: false }, 15, 6), false);
  assert.equal(isConferenceChampionship({ ...base, neutralSite: false, week: 12 }, 15, 1), false);
  assert.equal(isConferenceChampionship({ ...base, awayConference: "ACC" }, 15), false);
  assert.equal(
    isConferenceChampionship({ ...base, homeConference: "FBS Independents", awayConference: "FBS Independents" }, 15),
    false
  );
  assert.equal(
    isConferenceChampionship({ ...base, home: "Army", away: "Navy", homeConference: "American Athletic", awayConference: "American Athletic", week: 15 }, 15),
    false
  );
});

// A two-season world small enough to check by hand. 2025 recency 1.15, 2024 0.3.
function g(o) {
  return {
    seasonType: "regular",
    neutralSite: false,
    homeId: null,
    awayId: null,
    notes: null,
    homeClassification: "fbs",
    awayClassification: "fbs",
    ...o,
  };
}
const SEC = "SEC";
const fixture = {
  2024: [
    g({ week: 1, home: "Pac", homeConference: "Pac-12", away: "Fcs2", awayConference: "Big Sky", awayClassification: "fcs", homePoints: 40, awayPoints: 3 }),
  ],
  2025: [
    g({ week: 1, home: "Alpha", homeConference: SEC, away: "Fcs", awayConference: "Big Sky", awayClassification: "fcs", homePoints: 30, awayPoints: 0 }),
    g({ week: 2, home: "Alpha", homeConference: SEC, away: "Bravo", awayConference: SEC, homePoints: 24, awayPoints: 20 }),
    g({ week: 2, home: "Delta", homeConference: "FBS Independents", away: "Charlie", awayConference: "Big Ten", homePoints: 35, awayPoints: 10 }),
    g({ week: 3, home: "Delta", homeConference: "FBS Independents", away: "Echo", awayConference: "FBS Independents", homePoints: 28, awayPoints: 14 }),
    // Conference championship: neutral, second-to-final week (Army-Navy is week 15).
    g({ week: 14, neutralSite: true, home: "Alpha", homeConference: SEC, away: "Bravo", awayConference: SEC, homePoints: 24, awayPoints: 27 }),
    g({ week: 15, neutralSite: true, home: "Army", homeConference: "American Athletic", away: "Navy", awayConference: "American Athletic", homePoints: 17, awayPoints: 10 }),
    // Hosted title game: on campus, the Sun Belt's only conference game in week 14.
    g({ week: 14, home: "Sierra", homeConference: "Sun Belt", away: "Tango", awayConference: "Sun Belt", homePoints: 31, awayPoints: 24 }),
    // Rivalry week: two on-campus SEC games in week 15. Not title games.
    g({ week: 15, home: "Kilo", homeConference: SEC, away: "Lima", awayConference: SEC, homePoints: 20, awayPoints: 17 }),
    g({ week: 15, home: "Mike", homeConference: SEC, away: "Oscar", awayConference: SEC, homePoints: 14, awayPoints: 10 }),
    g({ seasonType: "postseason", week: 1, neutralSite: true, home: "Alpha", homeConference: SEC, away: "Charlie", awayConference: "Big Ten", homePoints: 17, awayPoints: 21, notes: "College Football Playoff Semifinal at the Orange Bowl" }),
    g({ seasonType: "postseason", week: 1, neutralSite: true, home: "Bravo", homeConference: SEC, away: "Delta", awayConference: "FBS Independents", homePoints: 10, awayPoints: 13, notes: "Duke's Mayo Bowl" }),
  ],
};
const TICKERS = {
  Alpha: "A", Bravo: "B", Charlie: "C", Delta: "D", Echo: "E", Pac: "P", Army: "ARMY", Navy: "NAVY",
  Sierra: "S", Tango: "T", Kilo: "K", Lima: "L", Mike: "M", Oscar: "O",
};

function run(extra = {}) {
  return computePrestige({
    gamesByYear: fixture,
    talent: [
      { team: "Alpha", talent: 900 },
      { team: "Bravo", talent: 800 },
      { team: "Charlie", talent: 700 },
      { team: "Delta", talent: 600 },
    ],
    window: { start: 2024, end: 2025 },
    resolve: (n) => TICKERS[n] ?? null,
    tickers: ["A", "B", "C", "D", "E", "P", "ARMY", "NAVY", "S", "T", "K", "L", "M", "O", "NEWBIE"],
    manualPrices: { NEWBIE: 13 },
    ...extra,
  });
}

test("prestige components follow each rule", () => {
  const r = run();
  const row = (t) => r.rows.find((x) => x.ticker === t).components;
  const R = 1.15;

  // Alpha: beat an FCS team (0.3) and Bravo (1-2 on the year -> 0.5 + 1/3).
  close(row("A").win_value, 6 * 1.45 * 0.3 * R + 6 * 1.45 * (0.5 + 1 / 3) * R, "A wins");
  // Bravo: beat Alpha (2-2 -> 1.0) in the title game.
  close(row("B").win_value, 6 * 1.45 * 1.0 * R, "B wins");
  // Delta is independent: tier = mean of FBS opponents with a real conference
  // (Charlie 1.3, Bravo 1.45); Echo, another independent, is excluded.
  const dTier = (1.3 + 1.45) / 2;
  close(row("D").win_value, 6 * dTier * (0.5 + 1 / 2) * R + 6 * dTier * 0.5 * R + 6 * dTier * (0.5 + 1 / 3) * R, "D wins");
  assert.deepEqual(r.report.independents.map((x) => [x.team, x.tier]).sort(), [["Delta", 1.375], ["Echo", 1]]);

  // Conference championship: both appear (+8), winner +16. Army-Navy doesn't count.
  close(row("A").conf_championship, 8 * R, "A ccg");
  close(row("B").conf_championship, 24 * R, "B ccg");
  assert.equal(row("ARMY").conf_championship, 0);
  // Hosted Sun Belt title game counts; rivalry-week SEC games don't.
  close(row("S").conf_championship, 24 * R, "S ccg");
  close(row("T").conf_championship, 8 * R, "T ccg");
  assert.equal(row("K").conf_championship, 0);
  assert.equal(row("M").conf_championship, 0);
  assert.deepEqual(
    r.report.championships.map((c) => [c.conference, c.site]).sort(),
    [["SEC", "neutral"], ["Sun Belt", "on campus"]]
  );

  // Semifinal: appear 26, win +19. Non-playoff bowl: 3, +6 for the winner.
  close(row("A").cfp, 26 * R, "A cfp");
  close(row("C").cfp, 45 * R, "C cfp");
  close(row("B").bowls, 3 * R, "B bowl");
  close(row("D").bowls, 9 * R, "D bowl");

  // Pac-12 in 2024 is the G5-tier era (0.72), at 2024's recency (0.3).
  close(row("P").win_value, 6 * 0.72 * 0.3 * 0.3, "Pac-12 2024");

  // Talent normalized across the market: Alpha 1.0 -> 18, Delta 0 -> 0.
  assert.equal(row("A").talent, 18);
  assert.equal(row("D").talent, 0);
  close(row("B").talent, 18 * (2 / 3), "B talent");
});

test("prestige rescales to 10-100 and prices at 8 + prestige * 0.5", () => {
  const r = run();
  const computed = r.rows.filter((x) => !x.manual);
  const top = computed[0];
  const bottom = computed[computed.length - 1];
  assert.equal(top.prestige, 100);
  assert.equal(top.price, 58);
  assert.equal(bottom.prestige, 10);
  assert.equal(bottom.price, 13);
  // prestige is reported to 2 dp; price comes from the unrounded value.
  for (const x of computed) close(x.price, 8 + x.prestige * 0.5, x.ticker);
  // Sorted by price, descending.
  assert.deepEqual(r.rows.map((x) => x.price), [...r.rows.map((x) => x.price)].sort((a, b) => b - a));
});

test("teams with no FBS history take a manual price, or are reported missing", () => {
  const r = run();
  const newbie = r.rows.find((x) => x.ticker === "NEWBIE");
  assert.deepEqual([newbie.manual, newbie.price, newbie.prestige], [true, 13, null]);
  assert.deepEqual(r.missing, []);
  const r2 = run({ manualPrices: {} });
  assert.deepEqual(r2.missing, ["NEWBIE"]);
});

test("a CFBD team id keeps a program together across a rename", () => {
  const renamed = {
    2024: [g({ week: 1, home: "Old Name", homeId: 77, homeConference: SEC, away: "Bravo", awayConference: SEC, homePoints: 21, awayPoints: 7 })],
    2025: [g({ week: 1, home: "New Name", homeId: 77, homeConference: SEC, away: "Bravo", awayConference: SEC, homePoints: 21, awayPoints: 7 })],
  };
  const r = computePrestige({
    gamesByYear: renamed,
    talent: [],
    window: { start: 2024, end: 2025 },
    resolve: (n) => ({ "New Name": "N", Bravo: "B" })[n] ?? null,
    tickers: ["N", "B"],
  });
  assert.equal(r.rows.find((x) => x.ticker === "N").components.fbs_seasons, 2);
});
