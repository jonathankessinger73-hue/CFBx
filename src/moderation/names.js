// Display-name moderation. checkDisplayName(name) -> { ok } or { ok: false, reason }.
//
// Matching, in order:
//  1. Split the name into words on spaces/_/./- and camelCase ("BigDog" -> big, dog).
//     Runs of single characters are joined back ("f u c k" -> fuck).
//  2. Normalize each word: lowercase, leetspeak digits to letters (1 is tried as
//     both i and l), everything else non-alphabetic dropped. Also a variant
//     with digits simply removed ("ass69" -> ass).
//  3. Each blocklist word becomes a pattern allowing repeated letters, so
//     "fuuuck" matches "fuck" but "as" does not match "ass".
//  4. Substring entries are checked inside each word after allowlisted words
//     (e.g. "gamecock") are cut out; token entries must be the whole word,
//     optionally plural.
//
// Deliberately not checked across word boundaries: "Wash It Up" must not
// trip on "washitup". The reason returned never says which word matched.

import { ENCODED, RESERVED_SUBSTRING, RESERVED_TOKEN } from "./blocklist.js";

export const rot13 = (s) =>
  s.replace(/[a-z]/gi, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

const LEET = { 0: "o", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };

// "fuck" -> /f+u+c+k+/ ; repeats collapse, letters can't be dropped.
const loose = (word) => word.split("").map((c) => `${c}+`).join("");

const SUBSTRING = ENCODED.substring.map((w) => new RegExp(loose(rot13(w))));
const TOKEN = ENCODED.token.map((w) => new RegExp(`^${loose(rot13(w))}(e?s+)?$`));
const ALLOW = ENCODED.allow.map((w) => new RegExp(`${loose(rot13(w))}(e?s+)?`, "g"));
const RESERVED_SUB = RESERVED_SUBSTRING.map((w) => new RegExp(loose(w)));
const RESERVED_TOK = RESERVED_TOKEN.map((w) => new RegExp(`^${loose(w)}s*$`));

// Words of the name, with runs of single characters joined.
export function splitWords(name) {
  const raw = String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const words = [];
  let run = "";
  for (const w of raw) {
    if (w.length === 1) {
      run += w;
      continue;
    }
    if (run) words.push(run), (run = "");
    words.push(w);
  }
  if (run) words.push(run);
  return words;
}

// Normalized spellings to test for one word.
export function variants(word) {
  const lower = word.toLowerCase();
  const leet = (one) =>
    lower
      .replace(/1/g, one)
      .replace(/[0-9]/g, (d) => LEET[d] ?? "")
      .replace(/[^a-z]/g, "");
  const set = new Set([leet("i"), leet("l"), lower.replace(/[^a-z]/g, "")]);
  set.delete("");
  return [...set];
}

export function checkDisplayName(name) {
  const words = splitWords(name);
  const all = words.flatMap(variants);

  const joined = variants(words.join(""));
  if (joined.some((v) => RESERVED_SUB.some((re) => re.test(v))) || all.some((v) => RESERVED_TOK.some((re) => re.test(v)))) {
    return { ok: false, reason: "reserved" };
  }
  for (const v of all) {
    if (TOKEN.some((re) => re.test(v))) return { ok: false, reason: "offensive" };
    const trimmed = ALLOW.reduce((s, re) => s.replace(re, " "), v);
    if (trimmed.split(" ").some((part) => SUBSTRING.some((re) => re.test(part)))) {
      return { ok: false, reason: "offensive" };
    }
  }
  return { ok: true };
}

// Decoded lists, for the maintenance CLI only.
export function decodedLists() {
  return {
    substring: ENCODED.substring.map(rot13),
    token: ENCODED.token.map(rot13),
    allow: ENCODED.allow.map(rot13),
    reservedSubstring: RESERVED_SUBSTRING,
    reservedToken: RESERVED_TOKEN,
  };
}
