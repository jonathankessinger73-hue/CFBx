// Shared pg setup. Import pg from here (not "pg" directly) so the type
// parsers below are always registered.

import pg from "pg";

// numeric and bigint arrive as strings by default; this app's magnitudes are
// small enough that JS numbers are exact for cents and ids.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

export default pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 5) });
}
