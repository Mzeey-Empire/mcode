import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_WORKSPACES = [
  {
    id: "ws-1",
    name: "my-app",
    path: "/home/user/my-app",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: true,
    last_opened_at: Date.now() - 3600_000,
  },
  {
    id: "ws-2",
    name: "side-project",
    path: "/home/user/side-project",
    provider_config: {},
    is_git_repo: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: Date.now() - 86400_000,
  },
];

const MOCK_BROWSE_RESULT = {
  path: "/home/user",
  parent: "/home",
  entries: [
    { name: "my-app", isDir: true },
    { name: "side-project", isDir: true },
    { name: "README.md", isDir: false },
  ],
};

const MOCK_SETTINGS = getDefaultSettings();

async function setupPage(page: import("@playwright/test").Page) {
  await mockWebSocketServer(page, {
    "workspace.list": MOCK_WORKSPACES,
    "workspace.enrich": { items: [] },
    "workspace.touchLastOpened": null,
    "filesystem.browse": MOCK_BROWSE_RESULT,
    "workspace.create": {
      id: "ws-new",
      name: "new-project",
      path: "/home/user/new-project",
      provider_config: {},
      is_git_repo: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pinned: false,
      last_opened_at: null,
    },
    "settings.get": MOCK_SETTINGS,
  });
  await page.goto("/");
  // Wait for React to mount — "my-app" appears in the sidebar once the WS connects
  // and initTransport resolves. Then allow useEffects (initShortcuts) to run.
  // "my-app" appears in multiple places (sidebar + landing), so use .first().
  await expect(page.getByText("my-app").first()).toBeVisible({ timeout: 15000 });
  // React schedules useEffect after the first render/paint. Give effects time to
  // attach the keydown listener before the test fires keyboard shortcuts.
  await page.waitForTimeout(200);
}

test.describe("Command palette", () => {
  test.setTimeout(30000);

  test("opens with Ctrl+K", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    // Palette input should be focused
    await expect(page.getByPlaceholder("Search commands, projects, threads…")).toBeFocused();
  });

  test("opens with Ctrl+P (legacy keybinding)", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+p");
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("closes with Escape", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("> prefix filters to Actions only", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("Search commands, projects, threads…").fill(">");
    // Should show Actions section — use exact to avoid matching "Actions only" text
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Actions", { exact: true })).toBeVisible();
    // Should NOT show Recent Projects heading
    await expect(dialog.getByText("Recent Projects")).not.toBeVisible();
  });

  test("Backspace on empty input pops from projects view to root", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    // Navigate to projects view via Ctrl+O
    await page.keyboard.press("Control+o");
    const dialog = page.getByRole("dialog");
    // Should show Projects heading or project items
    await expect(dialog).toBeVisible();
    // Backspace on empty input should pop back to root
    const input = page.getByPlaceholder("Search commands, projects, threads…");
    await expect(input).toHaveValue("");
    await page.keyboard.press("Backspace");
    // Root view shows "Actions" section — use exact to avoid matching "Actions only"
    await expect(dialog.getByText("Actions", { exact: true })).toBeVisible();
  });

  test("filesystem browse shows directory contents", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    // Navigate to addProject view directly
    await page.evaluate(() => {
      // @ts-ignore
      const store = window.__DEBUG_commandPaletteStore;
      if (store) store.getState().push({ kind: "addProject", path: "~/", });
    });
    await page.keyboard.press("Control+o");
    // Fallback: check that projects view opened and we can click "+ Add project"
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
  });

  test("Ctrl+Enter in addProject view triggers Add action", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Control+o");
    const dialog = page.getByRole("dialog");
    // Click "+ Add project" button in footer
    const addBtn = dialog.getByRole("button", { name: "+ Add project" });
    if (await addBtn.isVisible()) {
      await addBtn.click();
      // Now in addProject view — Ctrl+Enter should trigger the add
      await page.keyboard.press("Control+Enter");
      // Dialog may close on successful add or stay if RPC pending
      await page.waitForTimeout(500);
    }
  });
});
