#!/usr/bin/env node
// Display-name moderation tools.
//
//   node scripts/names.js check "<name>"   is this name allowed?
//   node scripts/names.js list             print the (decoded) blocklist
//   node scripts/names.js audit [--apply]  find saved names that break the
//                                          current rules; --apply clears them
//                                          (players drop off the leaderboard
//                                          until they pick a new name)
//
// Edit the lists in src/moderation/blocklist.js (ROT13-encoded; encode a word
// with: node -e 'import("./src/moderation/names.js").then(m=>console.log(m.rot13("word")))').

import { checkDisplayName, decodedLists } from "../src/moderation/names.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "check" && rest.length) {
  const name = rest.join(" ");
  const r = checkDisplayName(name);
  console.log(r.ok ? `allowed: ${name}` : `blocked (${r.reason}): ${name}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "list") {
  const lists = decodedLists();
  for (const [k, v] of Object.entries(lists)) console.log(`${k}:\n  ${v.join(", ")}\n`);
} else if (cmd === "audit") {
  const apply = rest.includes("--apply");
  const { createPool } = await import("../src/db/pg.js");
  const pool = createPool();
  try {
    const { rows } = await pool.query("select id, display_name from users where display_name is not null");
    const bad = rows.filter((r) => !checkDisplayName(r.display_name).ok);
    for (const r of bad) console.log(`${apply ? "cleared" : "would clear"}: ${r.display_name} (${r.id})`);
    if (apply && bad.length) {
      await pool.query("update users set display_name = null where id = any($1)", [bad.map((r) => r.id)]);
    }
    console.log(`${rows.length} names checked, ${bad.length} ${apply ? "cleared" : "flagged (run with --apply to clear)"}`);
  } finally {
    await pool.end();
  }
} else {
  console.error('usage: node scripts/names.js check "<name>" | list | audit [--apply]');
  process.exit(2);
}
