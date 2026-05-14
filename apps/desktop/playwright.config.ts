/**
 * Playwright config for Electron E2E specs (Electron-only surfaces:
 * native menus, tray, BrowserView, contextBridge IPC, deep links).
 *
 * Renderer-only specs live in apps/web/e2e/ and run via Vite — much faster.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
