import { test } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import path from "path";
import { fileURLToPath } from "url";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

const MOCK_SETTINGS = {
  appearance: { theme: "dark" },
  agent: { maxConcurrent: 3, defaults: { mode: "build", permission: "supervised" } },
  model: { defaults: { provider: "claude", id: "claude-sonnet-4-6", fallbackId: "claude-sonnet-4-6", reasoning: "high" } },
  provider: { cli: { codex: "", claude: "", copilot: "" } },
  prDraft: { provider: "", model: "" },
  terminal: { scrollback: 1000 },
  notifications: { enabled: false },
  worktree: { naming: { mode: "auto", aiConfirmation: true } },
  server: { memory: { heapMb: 96 } },
  updates: { channel: "stable", autoDownload: true, autoInstallOnQuit: true, checkInterval: "4hours" },
};

test.describe("About section visual", () => {
  test.setTimeout(30000);

  test("about settings section screenshot", async ({ page }) => {
    await mockWebSocketServer(page, {
      "settings.get": MOCK_SETTINGS,
      "settings.update": MOCK_SETTINGS,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(1000);

    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await settingsBtn.click();
    await page.waitForTimeout(800);

    const aboutBtn = page.getByRole("button", { name: "About", exact: true });
    await aboutBtn.scrollIntoViewIfNeeded();
    await aboutBtn.click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-about.png"),
      fullPage: false,
    });
  });
});
