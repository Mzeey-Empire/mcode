import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

/**
 * Attach to an already-running dev server on `BASE_URL` instead of starting one.
 * Only honored locally — CI always boots a fresh server so runs stay reproducible.
 * Useful when you intentionally keep `bun run dev` open and want faster test iteration.
 */
const reuseExistingServer =
  !process.env.CI && process.env.PLAYWRIGHT_REUSE_WEB_SERVER === "1";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    actionTimeout: 10000,
  },
  projects: [
    { name: "chromium" },
  ],
  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer,
    timeout: 120_000,
    // Spawning inherits the parent process env. React Fast Refresh in Vite
    // assumes development; a production NODE_ENV causes `$RefreshReg$` runtime errors.
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
  },
});
