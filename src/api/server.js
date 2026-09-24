import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { supabaseTokenVerifier, supabaseBaseUrl } from "./auth.js";
import { createPool, createStore } from "../db/store.js";

const store = createStore(createPool());
const app = createApp({
  store,
  verifyToken: supabaseTokenVerifier(),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  web:
    process.env.SERVE_WEB === "false"
      ? undefined
      : {
          dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web"),
          // Public values only: this is sent to every browser.
          config: {
            apiUrl: process.env.PUBLIC_API_URL || "",
            supabaseUrl: supabaseBaseUrl(process.env.SUPABASE_URL),
            supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
          },
        },
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`cfbx api listening on :${port}`));
