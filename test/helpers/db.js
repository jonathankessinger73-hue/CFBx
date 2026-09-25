// Spins up a throwaway schema-per-test-file database on a local Postgres and
// applies db/migrations/*.sql, with a minimal stand-in for the pieces of
// Supabase they depend on (auth.users, auth.uid(), the three API roles).
//
// Set TEST_DATABASE_URL to run; tests that need it skip otherwise.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "../../src/db/pg.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const SUPABASE_STUB = `
-- Roles are cluster-wide and test files run in parallel, so two files can
-- both see a role missing and race to create it; the loser treats "already
-- exists" as success instead of failing its whole file.
do $$ begin
  begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role authenticated nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role service_role nologin bypassrls; exception when duplicate_object or unique_violation then null; end;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

// Creates a fresh database, migrates it, and returns a pg.Pool on it.
// Pass a fixed `name` to reuse one slot (any old copy is dropped first).
export async function freshDatabase(name = `cfbx_t_${process.pid}_${Date.now()}`) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad database name ${name}`);
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  await pool.query(SUPABASE_STUB);
  const dir = path.join(root, "db", "migrations");
  for (const file of fs.readdirSync(dir).sort()) {
    if (file.endsWith(".sql")) await pool.query(fs.readFileSync(path.join(dir, file), "utf8"));
  }

  pool.dropDatabase = async () => {
    await pool.end();
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query(`drop database if exists ${name} with (force)`);
    await c.end();
  };
  return pool;
}

export async function createAuthUser(pool, id) {
  await pool.query("insert into auth.users (id) values ($1)", [id]);
  return id;
}
