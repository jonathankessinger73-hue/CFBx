// Minimal CollegeFootballData.com API client, plus helpers that normalize the
// v1 (snake_case) and v2 (camelCase) response shapes into one form.

const BASE_URL = process.env.CFBD_BASE_URL || "https://api.collegefootballdata.com";

export function createCfbdClient({ apiKey = process.env.CFBD_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("CFBD_API_KEY is not set");
  async function get(path, params) {
    const url = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`CFBD ${url.pathname} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  return {
    games: (year, seasonType = "regular") =>
      // `classification` is the v2 name for v1's `division`; send both.
      get("/games", { year, seasonType, classification: "fbs", division: "fbs" }),
    lines: (year, seasonType = "regular") => get("/lines", { year, seasonType }),
    spRatings: (year) => get("/ratings/sp", { year }),
  };
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};

export function normalizeGame(g) {
  return {
    id: pick(g, "id"),
    season: pick(g, "season"),
    week: pick(g, "week"),
    completed: Boolean(pick(g, "completed")),
    home: pick(g, "homeTeam", "home_team"),
    away: pick(g, "awayTeam", "away_team"),
    homePoints: pick(g, "homePoints", "home_points") ?? null,
    awayPoints: pick(g, "awayPoints", "away_points") ?? null,
  };
}

// Average of all providers' numeric spreads, in CFBD's convention
// (home perspective, negative = home favored). Null if none posted.
export function consensusSpread(lineGame) {
  const spreads = (lineGame.lines || [])
    .map((l) => (l.spread === null || l.spread === undefined || l.spread === "" ? NaN : Number(l.spread)))
    .filter(Number.isFinite);
  if (!spreads.length) return null;
  return Math.round((spreads.reduce((a, b) => a + b, 0) / spreads.length) * 100) / 100;
}

export function normalizeLineGame(g) {
  return {
    id: pick(g, "id"),
    week: pick(g, "week"),
    home: pick(g, "homeTeam", "home_team"),
    away: pick(g, "awayTeam", "away_team"),
    spread: consensusSpread(g),
  };
}
