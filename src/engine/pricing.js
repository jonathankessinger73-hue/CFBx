// Pricing engine, ported from the reference artifact (reference/cfbx-artifact.html).
// The constants here were tuned against real games - do not re-derive them.
//
// Everything in this module is pure: callers pass team data in and get new
// prices back, so the same code drives the seed replay, the daily job and tests.

export const SPREAD_FACTOR = 0.75; // fallback: expected points per point of strength difference
export const PRICE_FLOOR = 3;
export const MAX_BASE_MOVE = 28;
export const NOISE_WIDTH = 0.6;

export function round2(n) {
  return Math.round(n * 100) / 100;
}

// SP+-derived fallback for when no real line exists for a game.
export function proxyExpectedMargin(strengthA, strengthB) {
  return (strengthA - strengthB) * SPREAD_FACTOR;
}

// CFBD's `spread` is home-perspective with negative = home favored. The rest
// of the engine works in "expected home margin" (positive = home favored).
export function spreadToExpectedHomeMargin(spread) {
  return typeof spread === "number" ? -spread : null;
}
export function expectedHomeMarginToSpread(margin) {
  return typeof margin === "number" ? -margin : null;
}

// Multiplicative move with a $3 floor. lastChangePct is the realized move,
// which differs from `pct` when the floor kicks in.
export function applyPriceChange(price, pct) {
  const newPrice = Math.max(PRICE_FLOOR, round2(price * (1 + pct / 100)));
  return { price: newPrice, lastChangePct: round2(((newPrice - price) / price) * 100) };
}

/**
 * Price impact of one completed game.
 *
 * Direction is signed by whether each team beat or missed ITS OWN spread, not
 * by who won. A favorite that wins by less than the line drops; an underdog
 * that loses by less than the line rises. This is intentional.
 *
 * @param {{price:number, strength:number}} teamA
 * @param {number} scoreA
 * @param {{price:number, strength:number}} teamB
 * @param {number} scoreB
 * @param {number|null|undefined} realLineForA  expected margin for A from a real
 *        posted line (positive = A favored); omit to use the SP+ proxy.
 * @param {() => number} [random]  noise source in [0,1), injectable for tests.
 */
export function computePriceImpact(teamA, scoreA, teamB, scoreB, realLineForA, random = Math.random) {
  const isReal = typeof realLineForA === "number";
  const expectedMarginA = isReal ? realLineForA : proxyExpectedMargin(teamA.strength, teamB.strength);
  const actualMarginA = scoreA - scoreB;
  const edge = actualMarginA - expectedMarginA; // + = A beat its spread, - = A missed it
  const magnitude = Math.abs(edge);
  const baseMove = Math.min(MAX_BASE_MOVE, 0.15 + magnitude * 0.32);
  const pctA = round2((edge >= 0 ? 1 : -1) * baseMove + (random() - 0.5) * NOISE_WIDTH);
  const pctB = round2((edge >= 0 ? -1 : 1) * baseMove + (random() - 0.5) * NOISE_WIDTH);

  const moveA = applyPriceChange(teamA.price, pctA);
  const moveB = applyPriceChange(teamB.price, pctB);

  return {
    edge,
    isReal,
    a: {
      pct: pctA,
      price: moveA.price,
      lastChangePct: moveA.lastChangePct,
      covered: edge >= 0,
      expected: round2(expectedMarginA),
      actual: actualMarginA,
    },
    b: {
      pct: pctB,
      price: moveB.price,
      lastChangePct: moveB.lastChangePct,
      covered: edge <= 0,
      expected: round2(-expectedMarginA),
      actual: -actualMarginA,
    },
  };
}

// Games against FCS (and lower) opponents have no betting line. A win or tie
// leaves the price alone; a loss is an automatic penalty: 15% plus half a
// point per point of losing margin, capped at 25%.
export const FCS_LOSS_BASE = 15;
export const FCS_LOSS_PER_POINT = 0.5;
export const FCS_LOSS_MAX = 25;

export function fcsGameImpact(price, teamScore, oppScore) {
  const margin = teamScore - oppScore;
  if (margin >= 0) {
    return { pct: 0, price, lastChangePct: 0, summary: "FCS opponent, no line — price unchanged" };
  }
  const pct = -Math.min(FCS_LOSS_MAX, FCS_LOSS_BASE + FCS_LOSS_PER_POINT * -margin);
  const move = applyPriceChange(price, pct);
  return {
    pct,
    price: move.price,
    lastChangePct: move.lastChangePct,
    summary: `lost to an FCS opponent by ${-margin} — automatic penalty`,
  };
}

// Human-readable line/result summary from one team's perspective.
export function spreadPhrase(expectedMargin, actualMargin) {
  const lineText =
    expectedMargin >= 0
      ? `favored by ${Math.abs(expectedMargin).toFixed(1)}`
      : `underdog by ${Math.abs(expectedMargin).toFixed(1)}`;
  const resultText = actualMargin >= 0 ? `won by ${actualMargin}` : `lost by ${Math.abs(actualMargin)}`;
  const covered = actualMargin >= expectedMargin;
  return `${lineText}, ${resultText} — ${covered ? "covered" : "missed the line"}`;
}

// Strength refresh from a season of SP+ ratings (run once per season).
// ratings: [{ team_id, rating }] -> Map(team_id -> strength)
export function strengthFromRatings(ratings) {
  const values = ratings.map((r) => r.rating);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return new Map(ratings.map((r) => [r.team_id, Math.round(10 + ((r.rating - min) / span) * 85)]));
}
