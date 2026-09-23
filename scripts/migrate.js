#!/usr/bin/env node
// Applies db/migrations/*.sql in order, once each, recording what ran in
// schema_migrations. Usage: DATABASE_URL=... node scripts/migrate.js
// (Alternatively paste the files into the Supabase SQL editor in order.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pg.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const pool = createPool();
const client = await pool.connect();
try {
  await client.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  await client.query("alter table schema_migrations enable row level security");
  const { rows } = await client.query("select name from schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    await client.query("begin");
    try {
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`${file}: ${err.message}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
