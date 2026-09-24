// Shared pg setup. Import pg from here (not "pg" directly) so the type
// parsers below are always registered.

import fs from "node:fs";
import pg from "pg";

// numeric and bigint arrive as strings by default; this app's magnitudes are
// small enough that JS numbers are exact for cents and ids.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

export default pg;

// Encrypted, verified connections. Supabase signs its database certificates
// with its own CA (Database settings -> SSL -> Download certificate), which
// Node doesn't trust by default. Provide it as DATABASE_CA_CERT (the PEM text;
// handy for CI secrets) or DATABASE_CA_CERT_FILE (a path; handy locally), and
// leave sslmode out of DATABASE_URL (pg would treat sslmode=require as
// verify-full against Node's default CAs and fail).
export function sslConfig(env = process.env) {
  const ca = env.DATABASE_CA_CERT || (env.DATABASE_CA_CERT_FILE ? fs.readFileSync(env.DATABASE_CA_CERT_FILE, "utf8") : null);
  return ca ? { ca, rejectUnauthorized: true } : undefined;
}

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const ssl = sslConfig();
  const pool = new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 5), ...(ssl ? { ssl } : {}) });
  // An idle client can be dropped by the server (Supabase's pooler does this
  // routinely). Without a listener, pg re-emits that as an unhandled 'error'
  // and the process exits. The pool discards the broken client on its own.
  pool.on("error", (err) => console.error("postgres idle client error:", err.message));
  return pool;
}
