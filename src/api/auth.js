// Bearer-token auth. The frontend signs in with Supabase Auth and sends the
// session's access token; we verify it and pull out the user id (`sub`).

import { createClient } from "@supabase/supabase-js";

// Returns an async (token) => userId | null backed by Supabase Auth.
export function supabaseTokenVerifier({
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_ANON_KEY,
} = {}) {
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async (token) => {
    // getClaims verifies locally against the project's JWKS when it uses
    // asymmetric signing keys, and falls back to a getUser round-trip otherwise.
    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) return null;
    return data.claims.sub;
  };
}

export function requireAuth(verifyToken) {
  return async (req, res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    if (!match) return res.status(401).json({ error: "missing_token" });
    try {
      const userId = await verifyToken(match[1]);
      if (!userId) return res.status(401).json({ error: "invalid_token" });
      req.userId = userId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Like requireAuth, but never rejects: sets req.userId when a valid token is
// present and otherwise carries on as an anonymous request.
export function optionalAuth(verifyToken) {
  return async (req, res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    if (!match) return next();
    try {
      const userId = await verifyToken(match[1]);
      if (userId) req.userId = userId;
    } catch {
      /* treat a verifier failure as anonymous on public endpoints */
    }
    next();
  };
}
