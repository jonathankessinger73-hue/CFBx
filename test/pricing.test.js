import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePriceImpact,
  applyPriceChange,
  spreadToExpectedHomeMargin,
  strengthFromRatings,
  spreadPhrase,
  fcsGameImpact,
} from "../src/engine/pricing.js";

const noNoise = () => 0.5; // (0.5 - 0.5) * 0.6 = 0

test("favorite that wins but misses its spread loses value", () => {
  // Favored by 14, wins by 3.
  const r = computePriceImpact({ price: 50, strength: 90 }, 24, { price: 20, strength: 40 }, 21, 14, noNoise);
  assert.equal(r.a.covered, false);
  assert.ok(r.a.pct < 0, "favorite price should drop");
  assert.ok(r.a.price < 50);
  assert.equal(r.b.covered, true);
  assert.ok(r.b.pct > 0, "underdog that lost by less than the line should rise");
  assert.ok(r.b.price > 20);
});

test("move size follows 0.15 + |edge| * 0.32", () => {
  // Expected 7, actual 17 -> edge 10 -> 3.35%
  const r = computePriceImpact({ price: 100, strength: 50 }, 27, { price: 100, strength: 50 }, 10, 7, noNoise);
  assert.equal(r.edge, 10);
  assert.equal(r.a.pct, 3.35);
  assert.equal(r.b.pct, -3.35);
  assert.equal(r.a.price, 103.35);
  assert.equal(r.b.price, 96.65);
  assert.equal(r.a.expected, 7);
  assert.equal(r.b.expected, -7);
  assert.equal(r.a.actual, 17);
  assert.equal(r.b.actual, -17);
  assert.equal(r.isReal, true);
});

test("base move is capped at 28%", () => {
  const r = computePriceImpact({ price: 10, strength: 50 }, 100, { price: 10, strength: 50 }, 0, 0, noNoise);
  assert.equal(r.a.pct, 28);
  assert.equal(r.b.pct, -28);
});

test("noise stays within +/-0.3 percentage points", () => {
  const lo = computePriceImpact({ price: 10, strength: 50 }, 10, { price: 10, strength: 50 }, 0, 0, () => 0);
  const hi = computePriceImpact({ price: 10, strength: 50 }, 10, { price: 10, strength: 50 }, 0, 0, () => 0.999999);
  assert.equal(lo.a.pct, 3.05); // 3.35 - 0.3
  assert.equal(hi.a.pct, 3.65); // 3.35 + 0.3
});

test("SP+ proxy is used when no real line is given", () => {
  const r = computePriceImpact({ price: 10, strength: 80 }, 20, { price: 10, strength: 60 }, 10, undefined, noNoise);
  assert.equal(r.isReal, false);
  assert.equal(r.a.expected, 15); // (80 - 60) * 0.75
  assert.equal(r.a.covered, false); // won by 10, expected 15
});

test("an exact push counts as covered for both sides", () => {
  const r = computePriceImpact({ price: 10, strength: 50 }, 17, { price: 10, strength: 50 }, 10, 7, noNoise);
  assert.equal(r.edge, 0);
  assert.equal(r.a.covered, true);
  assert.equal(r.b.covered, true);
});

test("price is floored at $3 and realized change reflects the floor", () => {
  const m = applyPriceChange(3.5, -28);
  assert.equal(m.price, 3);
  assert.equal(m.lastChangePct, -14.29);
});

test("CFBD spread is negated into expected home margin", () => {
  assert.equal(spreadToExpectedHomeMargin(-7.5), 7.5);
  assert.equal(spreadToExpectedHomeMargin(null), null);
});

test("strength rescales SP+ ratings to 10..95", () => {
  const s = strengthFromRatings([
    { team_id: "A", rating: -20 },
    { team_id: "B", rating: 0 },
    { team_id: "C", rating: 20 },
  ]);
  assert.deepEqual([...s.values()], [10, 53, 95]);
});

test("spread phrase", () => {
  assert.equal(spreadPhrase(7, 3), "favored by 7.0, won by 3 — missed the line");
  assert.equal(spreadPhrase(-7, -3), "underdog by 7.0, lost by 3 — covered");
});

test("FCS games: a win leaves the price alone, a loss is a 15-25% penalty", () => {
  assert.deepEqual(fcsGameImpact(40, 56, 7), {
    pct: 0,
    price: 40,
    lastChangePct: 0,
    summary: "FCS opponent, no line — price unchanged",
  });
  const close = fcsGameImpact(40, 20, 21); // lost by 1: 15.5%
  assert.equal(close.pct, -15.5);
  assert.equal(close.price, 33.8);
  assert.equal(close.summary, "lost to an FCS opponent by 1 — automatic penalty");
  assert.equal(fcsGameImpact(40, 10, 20).pct, -20);
  assert.equal(fcsGameImpact(40, 0, 45).pct, -25); // capped
  assert.equal(fcsGameImpact(3.2, 0, 10).price, 3); // $3 floor
});
