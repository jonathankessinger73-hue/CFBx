// Minimal CollegeFootballData.com API client, plus helpers that normalize the
// v1 (snake_case) and v2 (camelCase) response shapes into one form.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE_URL = process.env.CFBD_BASE_URL || "https://api.collegefootballdata.com";

/**
 * @param {object} [opts]
 * @param {string} [opts.cacheDir]  if set, responses are cached on disk keyed
 *        by URL. Only for historical pulls (the prestige rebuild); live jobs
 *        must not use it or they'd never see new results.
 */
// Keys get pasted with extras: quotes, spaces, or a "Bearer " prefix copied
// from CFBD's docs (we add that prefix ourselves). Strip them.
export function cleanApiKey(key) {
  return String(key ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .trim();
}

export function createCfbdClient({ apiKey = process.env.CFBD_API_KEY, fetchImpl = fetch, cacheDir } = {}) {
  apiKey = cleanApiKey(apiKey);
  if (!apiKey) throw new Error("CFBD_API_KEY is not set");
  async function get(pathname, params) {
    const url = new URL(pathname, BASE_URL);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const cacheFile =
      cacheDir && path.join(cacheDir, crypto.createHash("sha1").update(url.toString()).digest("hex") + ".json");
    if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (res.status === 401) {
      throw new Error(
        `CFBD rejected the API key (401). Check CFBD_API_KEY in .env: it should be only the key ` +
          `from CFBD's email (${apiKey.length} characters were sent), with no quotes or "Bearer".`
      );
    }
    if (!res.ok) throw new Error(`CFBD ${url.pathname} failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (cacheFile) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(body));
    }
    return body;
  }
  return {
    games: (year, seasonType = "regular") =>
      // `classification` is the v2 name for v1's `division`; send both. Returns
      // every game involving an FBS team, including FBS vs FCS.
      get("/games", { year, seasonType, classification: "fbs", division: "fbs" }),
    lines: (year, seasonType = "regular") => get("/lines", { year, seasonType }),
    spRatings: (year) => get("/ratings/sp", { year }),
    talent: (year) => get("/talent", { year }),
    records: (year) => get("/records", { year }),
    fbsTeams: (year) => get("/teams/fbs", { year }),
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
    // Extra fields used by the prestige rebuild.
    seasonType: pick(g, "seasonType", "season_type") ?? null,
    neutralSite: Boolean(pick(g, "neutralSite", "neutral_site")),
    homeId: pick(g, "homeId", "home_id") ?? null,
    awayId: pick(g, "awayId", "away_id") ?? null,
    homeConference: pick(g, "homeConference", "home_conference") ?? null,
    awayConference: pick(g, "awayConference", "away_conference") ?? null,
    homeClassification: (pick(g, "homeClassification", "home_division") ?? null)?.toLowerCase?.() ?? null,
    awayClassification: (pick(g, "awayClassification", "away_division") ?? null)?.toLowerCase?.() ?? null,
    notes: pick(g, "notes") ?? null,
    startDate: pick(g, "startDate", "start_date") ?? null,
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

// /ratings/sp rows -> { team, rating }. rating is null when not numeric; the
// national-averages row has no matching team, so callers drop it on lookup.
export function normalizeSpRating(r) {
  const rating = Number(pick(r, "rating"));
  return { team: pick(r, "team"), rating: Number.isFinite(rating) ? rating : null };
}

// /talent rows -> { team, talent }. v1 calls the team `school`.
export function normalizeTalent(r) {
  const talent = Number(pick(r, "talent"));
  return { team: pick(r, "team", "school"), talent: Number.isFinite(talent) ? talent : null };
}

// /records rows -> { team, wins, losses, ties, confWins, confLosses, confTies }.
// Logo URLs from a /teams entry. CFBD lists ESPN's images, the regular one and
// a "-dark" variant for dark backgrounds, sometimes over plain http.
export function normalizeTeamLogos(t) {
  const logos = (pick(t, "logos") || []).filter((u) => typeof u === "string" && u).map((u) => u.replace(/^http:\/\//, "https://"));
  const dark = logos.find((u) => /-dark\//.test(u)) || null;
  return {
    team: pick(t, "school"),
    logo: logos.find((u) => u !== dark) || dark,
    logoDark: dark,
  };
}

export function normalizeRecord(r) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const total = pick(r, "total") || {};
  const conf = pick(r, "conferenceGames", "conference_games") || {};
  return {
    team: pick(r, "team"),
    wins: n(total.wins),
    losses: n(total.losses),
    ties: n(total.ties),
    confWins: n(conf.wins),
    confLosses: n(conf.losses),
    confTies: n(conf.ties),
  };
}
