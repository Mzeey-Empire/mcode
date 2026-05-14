/**
 * Electron smoke spec. Launches the packaged main process via Playwright's
 * `_electron.launch()`, asserts a first window appears, captures a screenshot,
 * and fails on renderer-side console errors.
 *
 * Future Electron-only features (native menus, tray, BrowserView, deep links)
 * should be appended to this suite as additional specs in this directory.
 *
 * Requires `apps/desktop/dist/main/main.cjs` to exist — the Playwright config
 * runs `bun run build` first via the `webServer`/`globalSetup` hook, but you
 * can also build manually with `cd apps/desktop && bun run build`.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP_DIR = resolve(__dirname, "..");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");

test.describe("Electron smoke", () => {
  test.beforeAll(() => {
    if (!existsSync(MAIN_BUNDLE)) {
      throw new Error(
        `Missing ${MAIN_BUNDLE}. Run \`cd apps/desktop && bun run build\` first.`,
      );
    }
  });

  test("first window opens and has the expected title", async () => {
    const app = await electron.launch({ args: ["."], cwd: DESKTOP_DIR });
    const rendererErrors: string[] = [];

    try {
      const win = await app.firstWindow();
      win.on("console", (m) => {
        if (m.type() === "error") rendererErrors.push(m.text());
      });

      await win.waitForLoadState("domcontentloaded");
      await expect(win).toHaveTitle(/Mcode/);

      await win.screenshot({
        path: resolve(
          DESKTOP_DIR,
          "..",
          "web",
          "e2e",
          "screenshots",
          "demo-desktop",
          "smoke-first-window.png",
        ),
        fullPage: true,
      });

      expect(rendererErrors, "renderer console errors").toEqual([]);
    } finally {
      await app.close();
    }
  });
});
