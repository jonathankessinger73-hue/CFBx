import { createApp } from "./app.js";
import { supabaseTokenVerifier } from "./auth.js";
import { createPool, createStore } from "../db/store.js";

const store = createStore(createPool());
const app = createApp({
  store,
  verifyToken: supabaseTokenVerifier(),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`cfbx api listening on :${port}`));
