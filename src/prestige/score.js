// Program Prestige Score: sets each program's opening (IPO) price from a
// 12-season window of history. Pure functions; data fetching lives in
// rebuild.js. Every rule here follows CFBx-handoff-spec.md, "The IPO/baseline
// price" section. Where the spec was ambiguous the choice is noted inline.
//
// Deliberately excludes current-season performance (that's what trading is
// for) and anything before the window (a scope decision, not an oversight).

export const WINDOW_YEARS = 12;

export const WIN_BASE = 6.0;
export const FCS_OPP_QUALITY = 0.3;
export const CCG_APPEAR = 8;
export const CCG_WIN = 16;
export const STAGE_APPEAR = { 1: 6, 2: 14, 3: 26, 4: 45 };
export const STAGE_WIN = { 1: 8, 2: 12, 3: 19, 4: 30 };
export const BOWL_APPEAR = 3;
export const BOWL_WIN = 6;
export const TALENT_WEIGHT = 18;
export const PRESTIGE_MIN = 10;
export const PRESTIGE_MAX = 100;

export const INDEPENDENTS = "FBS Independents";

// SEC and Big Ten weighted highest by product decision (layered on top of
// results, not SP+'s own weighting).
const TIERS = {
  SEC: 1.45,
  "Big Ten": 1.3,
  ACC: 1.12,
  "Big 12": 1.12,
  "American Athletic": 0.78,
  "Mountain West": 0.76,
  "Conference USA": 0.7,
  "Sun Belt": 0.7,
  "Mid-American": 0.65,
};

// Same name, two different conferences: the power Pac-12 through 2023, the
// rebuilt G5-tier Pac-12 from 2024.
export function conferenceTier(conference, year) {
  if (conference === "Pac-12") return year <= 2023 ? 1.12 : 0.72;
  return TIERS[conference] ?? null;
}

// Smooth decay across the window: start -> 0.300, end -> 1.150.
export function recency(year, start, end) {
  const t = (year - start) / (end - start);
  return Math.round((0.3 + 0.85 * Math.pow(t, 1.25)) * 1000) / 1000;
}

// CFP stage from a postseason game's notes. Historical notes are formatted
// inconsistently ("ALLSTATE SUGAR BOWL - SEMIFINAL" in 2014 vs "College
// Football Playoff Semifinal at the ..." later), so match loose substrings,
// most advanced stage first. 0 = not a playoff game.
export function cfpStage(notes) {
  const n = String(notes || "").toLowerCase();
  if (n.includes("national championship")) return 4;
  if (n.includes("semifinal")) return 3;
  if (n.includes("quarterfinal")) return 2;
  if (n.includes("first round") && (n.includes("playoff") || n.includes("cfp"))) return 1;
  return 0;
}

const teamKey = (g, home) => String((home ? g.homeId : g.awayId) ?? (home ? g.home : g.away));
const byDate = (a, b) => String(a.startDate ?? "").localeCompare(String(b.startDate ?? "")) || (a.id ?? 0) - (b.id ?? 0);

// Playoff round for each of a season's postseason games: from the notes
// first (cfpStage), then filling gaps from structure. CFBD has blank notes
// for some semifinals (e.g. the 2015 and 2016 seasons), and a blank note
// alone can't tell a semifinal from an ordinary bowl. But both teams in the
// national championship game got there by winning a semifinal: if a finalist
// has no recognized semifinal, its last postseason win before the title game
// was its semifinal.
// Returns Map(game -> { stage, inferred }).
export function playoffStages(postseasonGames) {
  const stages = new Map(postseasonGames.map((g) => [g, { stage: cfpStage(g.notes), inferred: false }]));
  const involves = (g, key) => teamKey(g, true) === key || teamKey(g, false) === key;
  const winnerKey = (g) =>
    g.homePoints > g.awayPoints ? teamKey(g, true) : g.awayPoints > g.homePoints ? teamKey(g, false) : null;
  for (const final of postseasonGames.filter((g) => stages.get(g).stage === 4)) {
    for (const finalist of [teamKey(final, true), teamKey(final, false)]) {
      const games = postseasonGames.filter((g) => g !== final && involves(g, finalist));
      if (games.some((g) => stages.get(g).stage === 3)) continue;
      const semi = games
        .filter((g) => stages.get(g).stage === 0 && winnerKey(g) === finalist && byDate(g, final) < 0)
        .sort(byDate)
        .pop();
      if (semi) stages.set(semi, { stage: 3, inferred: true });
    }
  }
  return stages;
}

const isArmyNavy = (g) => {
  const names = [g.home, g.away].map((n) => String(n).toLowerCase());
  return names.includes("army") && names.includes("navy");
};

// Conference championship games, detected structurally (not from labels):
// a regular-season game in the final or second-to-final week between two
// teams of the same real conference (Army-Navy matches that shape and is
// excluded by name), that is EITHER
//   - at a neutral site (SEC, Big Ten, ACC, Big 12, MAC title games), OR
//   - on campus, but the conference's only conference game that week.
//     Several conferences (American, Mountain West, Sun Belt, C-USA) host the
//     title game at the higher seed. A lone game tells a title week apart
//     from rivalry week, when a conference plays many games against itself.
// `confGamesThisWeek` = that conference's conference games in g's week.
export function isConferenceChampionship(g, finalWeek, confGamesThisWeek = 1) {
  return (
    g.seasonType !== "postseason" &&
    (g.week === finalWeek || g.week === finalWeek - 1) &&
    !!g.homeConference &&
    g.homeConference === g.awayConference &&
    g.homeConference !== INDEPENDENTS &&
    !isArmyNavy(g) &&
    (g.neutralSite || confGamesThisWeek === 1)
  );
}

const confWeekKey = (g) => `${g.week}|${g.homeConference}`;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} input
 * @param {Record<number, object[]>} input.gamesByYear  normalized CFBD games
 *        (see normalizeGame), regular season and postseason, per year
 * @param {{team: string, talent: number|null}[]} input.talent  most recent /talent pull
 * @param {{start: number, end: number}} input.window
 * @param {(cfbdName: string) => string|null} input.resolve  CFBD name -> ticker
 * @param {string[]} input.tickers  the market's teams, all of which need a price
 * @param {Record<string, number>} [input.manualPrices]  prices for teams with no
 *        FBS history in the window (they can't run through the formula)
 */
export function computePrestige({ gamesByYear, talent, window, resolve, tickers, manualPrices = {} }) {
  const teams = new Map(); // key -> accumulator
  const names = new Map(); // key -> latest CFBD name
  const report = { championships: [], playoff: [], unknownConferences: [], independents: [] };
  const acc = (key) => {
    if (!teams.has(key)) {
      teams.set(key, { win_value: 0, conf_championship: 0, cfp: 0, bowls: 0, fbs_seasons: new Set() });
    }
    return teams.get(key);
  };

  for (let year = window.start; year <= window.end; year++) {
    const rec = recency(year, window.start, window.end);
    const games = (gamesByYear[year] || []).filter((g) => g.homePoints !== null && g.awayPoints !== null);

    // Per-team season facts: key, FBS?, conference, record, opponents.
    const season = new Map();
    const side = (g, home) => {
      const key = String((home ? g.homeId : g.awayId) ?? (home ? g.home : g.away));
      names.set(key, home ? g.home : g.away);
      const cls = home ? g.homeClassification : g.awayClassification;
      const conf = home ? g.homeConference : g.awayConference;
      if (!season.has(key)) season.set(key, { fbs: false, conference: null, w: 0, g: 0, opponents: [] });
      const s = season.get(key);
      // Classification is the source of truth; if a response lacks it, a
      // known FBS conference is the fallback.
      if (cls === "fbs" || (cls == null && (conf === INDEPENDENTS || conferenceTier(conf, year) !== null))) s.fbs = true;
      if (conf && !s.conference) s.conference = conf;
      return { key, s };
    };
    for (const g of games) {
      const h = side(g, true);
      const a = side(g, false);
      const homeWon = g.homePoints > g.awayPoints;
      h.s.g++;
      a.s.g++;
      if (homeWon) h.s.w++;
      else if (g.awayPoints > g.homePoints) a.s.w++;
      h.s.opponents.push(a.key);
      a.s.opponents.push(h.key);
    }

    // Tier per FBS team. Independents (and unrecognized conferences) use the
    // average tier of their FBS opponents that have a real conference tier.
    const tier = new Map();
    for (const [key, s] of season) {
      if (!s.fbs) continue;
      acc(key).fbs_seasons.add(year);
      const own = s.conference === INDEPENDENTS ? null : conferenceTier(s.conference, year);
      if (own !== null) tier.set(key, own);
    }
    const direct = new Map(tier); // only real conference tiers feed the average
    for (const [key, s] of season) {
      if (!s.fbs || tier.has(key)) continue;
      const oppTiers = s.opponents.map((o) => direct.get(o)).filter((t) => t !== undefined);
      const t = oppTiers.length ? oppTiers.reduce((x, y) => x + y, 0) / oppTiers.length : 1;
      tier.set(key, t);
      const entry = { year, team: names.get(key), conference: s.conference, tier: Math.round(t * 1000) / 1000 };
      if (s.conference === INDEPENDENTS) report.independents.push(entry);
      else report.unknownConferences.push(entry);
    }

    const oppQuality = (key) => {
      const s = season.get(key);
      return s.fbs ? 0.5 + s.w / s.g : FCS_OPP_QUALITY;
    };

    const regular = games.filter((g) => g.seasonType !== "postseason");
    const finalWeek = Math.max(0, ...regular.map((g) => g.week || 0));
    const confGames = new Map(); // "week|conference" -> conference games that week
    for (const g of regular) {
      if (g.homeConference && g.homeConference === g.awayConference) {
        confGames.set(confWeekKey(g), (confGames.get(confWeekKey(g)) || 0) + 1);
      }
    }

    const stages = playoffStages(games.filter((g) => g.seasonType === "postseason"));

    for (const g of games) {
      const hKey = teamKey(g, true);
      const aKey = teamKey(g, false);
      const hFbs = season.get(hKey).fbs;
      const aFbs = season.get(aKey).fbs;
      const winner = g.homePoints > g.awayPoints ? hKey : g.awayPoints > g.homePoints ? aKey : null;
      const loser = winner === hKey ? aKey : winner === aKey ? hKey : null;

      // 1. Per-game win value, for every FBS win (regular season and postseason).
      if (winner && season.get(winner).fbs) {
        acc(winner).win_value += WIN_BASE * tier.get(winner) * oppQuality(loser) * rec;
      }

      if (g.seasonType === "postseason") {
        const { stage, inferred } = stages.get(g);
        for (const [key, fbs] of [[hKey, hFbs], [aKey, aFbs]]) {
          if (!fbs) continue;
          const won = key === winner;
          if (stage) acc(key).cfp += STAGE_APPEAR[stage] * rec + (won ? STAGE_WIN[stage] * rec : 0);
          else acc(key).bowls += (BOWL_APPEAR + (won ? BOWL_WIN : 0)) * rec;
        }
        if (stage) report.playoff.push({ year, stage, inferred, home: g.home, away: g.away, notes: g.notes });
      } else if (isConferenceChampionship(g, finalWeek, confGames.get(confWeekKey(g)))) {
        // Both teams get the appearance bonus; the winner also gets the win
        // bonus (8 + 16), mirroring how the CFP appear/win bonuses stack.
        for (const key of [hKey, aKey]) {
          if (season.get(key).fbs) acc(key).conf_championship += CCG_APPEAR * rec + (key === winner ? CCG_WIN * rec : 0);
        }
        report.championships.push({
          year,
          week: g.week,
          conference: g.homeConference,
          site: g.neutralSite ? "neutral" : "on campus",
          home: g.home,
          away: g.away,
        });
      }
    }
  }

  // Map CFBD teams to market tickers.
  const byTicker = new Map();
  const unmatched = new Set();
  for (const [key, a] of teams) {
    const ticker = resolve(names.get(key));
    if (!ticker) {
      if (a.fbs_seasons.size) unmatched.add(names.get(key));
      continue;
    }
    if (!byTicker.has(ticker)) byTicker.set(ticker, { ...a, fbs_seasons: new Set(a.fbs_seasons), cfbd_name: names.get(key) });
    else {
      // Same program under two CFBD keys (e.g. a rename without an id): merge.
      const m = byTicker.get(ticker);
      for (const k of ["win_value", "conf_championship", "cfp", "bowls"]) m[k] += a[k];
      for (const y of a.fbs_seasons) m.fbs_seasons.add(y);
    }
  }

  // 4. Current recruiting talent, normalized 0-1 across the market's teams.
  const talentByTicker = new Map();
  for (const t of talent) {
    const ticker = t.talent === null ? null : resolve(t.team);
    if (ticker && tickers.includes(ticker) && !talentByTicker.has(ticker)) talentByTicker.set(ticker, t.talent);
  }
  const tv = [...talentByTicker.values()];
  const tMin = Math.min(...tv);
  const tSpan = Math.max(...tv) - tMin || 1;

  const rows = [];
  const missing = [];
  for (const ticker of tickers) {
    const a = byTicker.get(ticker);
    const hasHistory = a && a.fbs_seasons.size > 0;
    if (!hasHistory) {
      // No FBS seasons in the window: the formula can't price them.
      if (manualPrices[ticker] !== undefined) {
        rows.push({ ticker, manual: true, price: manualPrices[ticker], raw: null, prestige: null, components: null });
      } else {
        missing.push(ticker);
      }
      continue;
    }
    const talentNorm = talentByTicker.has(ticker) ? (talentByTicker.get(ticker) - tMin) / tSpan : 0;
    const components = {
      win_value: round2(a.win_value),
      conf_championship: round2(a.conf_championship),
      cfp: round2(a.cfp),
      bowls: round2(a.bowls),
      talent: round2(talentNorm * TALENT_WEIGHT),
      talent_raw: talentByTicker.get(ticker) ?? null,
      fbs_seasons: a.fbs_seasons.size,
      cfbd_name: a.cfbd_name,
    };
    const raw = a.win_value + a.conf_championship + a.cfp + a.bowls + talentNorm * TALENT_WEIGHT;
    rows.push({ ticker, manual: false, raw, components });
  }

  // Rescale computed teams to 10-100, then price = 8 + prestige * 0.5.
  const computed = rows.filter((r) => !r.manual);
  const rMin = Math.min(...computed.map((r) => r.raw));
  const rSpan = Math.max(...computed.map((r) => r.raw)) - rMin || 1;
  for (const r of computed) {
    r.prestige = PRESTIGE_MIN + ((r.raw - rMin) / rSpan) * (PRESTIGE_MAX - PRESTIGE_MIN);
    r.price = round2(8 + r.prestige * 0.5);
    r.raw = round2(r.raw);
    r.prestige = round2(r.prestige);
  }

  rows.sort((x, y) => y.price - x.price || x.ticker.localeCompare(y.ticker));
  return {
    window,
    recency: Object.fromEntries(
      Array.from({ length: window.end - window.start + 1 }, (_, i) => [window.start + i, recency(window.start + i, window.start, window.end)])
    ),
    rows,
    missing,
    unmatchedFbsSchools: [...unmatched].sort(),
    report,
  };
}
