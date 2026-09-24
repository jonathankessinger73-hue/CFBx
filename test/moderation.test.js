import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDisplayName, rot13, splitWords } from "../src/moderation/names.js";

// Offensive test inputs are ROT13-encoded, like the blocklist itself.
const enc = rot13;

test("ordinary fan names, including football words that contain blocked substrings, are allowed", () => {
  for (const name of [
    "Dawg Fan", "Gamecock Nation", "Gamecocks4Life", "Hancock", "Dickinson Dave", "Scunthorpe United",
    "Classy Bass", "Assassin", "Grape Ape", "Raccoon Army", "Tycoon Tom", "Cocktail Hour", "Essex Eagles",
    "Analyst Andy", "Titans Fan", "Cumberland Gap", "Spicy Takes", "Wash It Up", "Cool As Ice", "Hokie Pokie",
    "Peacock Pete", "Pass Rush", "Homecoming King", "Therapist", "Grasshopper", "Sussex", "Big Ten Baron",
    "Mississippi", "Roll Tide Rhonda", "Horns Down Hank",
  ]) {
    assert.deepEqual(checkDisplayName(name), { ok: true }, name);
  }
});

test("profanity is caught through leetspeak, repeats, spacing and camelCase", () => {
  for (const name of [
    enc("ShpxGurQnjtf"), enc("shhhpx"), enc("Fu1g Gnyxre"), enc("Ovt Q1px"), enc("OvtQvpx"), enc("n55ubyr"),
    enc("Qhzo Nff"), enc("s h p x"), enc("f.u.v.g"), enc("OVTQVPX"), enc("Gvgf ZpTrr"), enc("Nff69"),
    enc("QvpxTnzrpbpx"), enc("Encr Genva"), enc("Urvy Gvqr"),
  ]) {
    assert.deepEqual(checkDisplayName(name), { ok: false, reason: "offensive" }, rot13(name));
  }
});

test("slurs are blocked, including plurals", () => {
  for (const w of ["avttre", "snttbgf", "ergneqrq", "xvxr", "Fcvp"]) {
    assert.equal(checkDisplayName(`Big ${rot13(w)} Fan`).ok, false, w);
  }
});

test("names impersonating staff or the site are reserved", () => {
  for (const name of ["Admin", "CFBx Official", "cfbx_fan", "c.f.b.x", "Moderator Mike", "Official Fan", "The Staff"]) {
    assert.deepEqual(checkDisplayName(name), { ok: false, reason: "reserved" }, name);
  }
});

test("word splitting", () => {
  assert.deepEqual(splitWords("BigDawgFan"), ["Big", "Dawg", "Fan"]);
  assert.deepEqual(splitWords("s.h.i.t happens"), ["shit", "happens"]);
  assert.deepEqual(splitWords("Roll_Tide-Roll"), ["Roll", "Tide", "Roll"]);
});
