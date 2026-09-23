import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.js",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "node test/e2e/server.js",
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    env: { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || "", E2E_PORT: String(port) },
  },
});
