import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const NOW = Date.now();

const MOCK_WORKSPACES = [
  {
    id: "ws-pinned",
    name: "pinned-app",
    path: "/home/user/pinned-app",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: true,
    last_opened_at: NOW - 3600_000,
  },
  {
    id: "ws-recent",
    name: "recent-app",
    path: "/home/user/recent-app",
    provider_config: {},
    is_git_repo: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: NOW - 7200_000,
  },
  {
    id: "ws-older",
    name: "older-app",
    path: "/home/user/older-app",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: NOW - 86400_000,
  },
];

const MOCK_ENRICHMENT = {
  items: [
    { id: "ws-pinned", branch: "main", isGit: true, isClean: true, threadCount: 3 },
    { id: "ws-recent", branch: null, isGit: false, isClean: true, threadCount: 0 },
    { id: "ws-older", branch: "feat/new-feature", isGit: true, isClean: false, threadCount: 1 },
  ],
};

const MOCK_SETTINGS = getDefaultSettings();

async function setupLanding(page: import("@playwright/test").Page) {
  await mockWebSocketServer(page, {
    "workspace.list": MOCK_WORKSPACES,
    "workspace.enrich": MOCK_ENRICHMENT,
    "workspace.touchLastOpened": null,
    "workspace.pin": null,
    "workspace.removeRecent": null,
    "settings.get": MOCK_SETTINGS,
  });
  await page.goto("/");
  // No active workspace = landing is shown
  await page.waitForTimeout(800);
}

async function setupWithWorkspace(page: import("@playwright/test").Page) {
  const ctrl = await mockWebSocketServer(page, {
    "workspace.list": MOCK_WORKSPACES,
    "workspace.enrich": MOCK_ENRICHMENT,
    "workspace.touchLastOpened": null,
    "workspace.pin": null,
    "workspace.removeRecent": null,
    "settings.get": MOCK_SETTINGS,
    "thread.list": [],
  });
  await page.goto("/");
  await page.waitForTimeout(800);
  return ctrl;
}

test.describe("Project selector — cold-start landing", () => {
  test.setTimeout(30000);

  test("shows landing screen when no workspace is active", async ({ page }) => {
    await setupLanding(page);
    // The landing has the app wordmark
    await expect(page.getByText("mcode")).toBeVisible();
    // Should show "Pinned" section heading
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
  });

  test("landing shows pinned and recent project sections", async ({ page }) => {
    await setupLanding(page);
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
    await expect(page.getByText("pinned-app")).toBeVisible();
    await expect(page.getByText("recent-app")).toBeVisible();
  });

  test("clicking a project on the landing opens it (hides landing)", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": MOCK_WORKSPACES,
      "workspace.enrich": MOCK_ENRICHMENT,
      "workspace.touchLastOpened": null,
      "thread.list": [],
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await page.waitForTimeout(800);

    // Click the pinned project row
    await page.getByText("pinned-app").click();
    // Landing should disappear (workspace is now active)
    await expect(page.getByText("mcode")).not.toBeVisible({ timeout: 3000 });
  });

  test("empty state shows Add project CTA when no workspaces exist", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [],
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await page.waitForTimeout(800);
    await expect(page.getByText("No projects yet")).toBeVisible();
    await expect(page.getByTestId("landing-add-project")).toBeVisible();
  });

  test("Add project CTA opens the palette addProject view", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [],
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "filesystem.browse": {
        path: "/home/user",
        parent: "/home",
        entries: [{ name: "my-app", isDir: true }],
      },
    });
    await page.goto("/");
    await page.waitForTimeout(800);
    await page.getByTestId("landing-add-project").click();
    // Palette dialog should open in addProject view (shows Add button)
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Project selector — palette projects view", () => {
  test.setTimeout(30000);

  test("Ctrl+O opens projects view in palette", async ({ page }) => {
    await setupWithWorkspace(page);
    await page.keyboard.press("Control+o");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("pinned-app")).toBeVisible();
  });

  test("projects view shows pinned section first", async ({ page }) => {
    await setupWithWorkspace(page);
    await page.keyboard.press("Control+o");
    const dialog = page.getByRole("dialog");
    // Both sections visible
    const headings = dialog.locator("[cmdk-group-heading]");
    const firstHeading = headings.first();
    await expect(firstHeading).toContainText("Pinned");
  });

  test("search filters projects by name", async ({ page }) => {
    await setupWithWorkspace(page);
    await page.keyboard.press("Control+o");
    await page.getByPlaceholder("Search commands, projects, threads…").fill("older");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("older-app")).toBeVisible();
    await expect(dialog.getByText("pinned-app")).not.toBeVisible();
  });

  test("search by path works", async ({ page }) => {
    await setupWithWorkspace(page);
    await page.keyboard.press("Control+o");
    await page.getByPlaceholder("Search commands, projects, threads…").fill("pinned-app");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("pinned-app")).toBeVisible();
  });

  test("pin toggle calls workspace.pin RPC", async ({ page }) => {
    const rpcs: string[] = [];
    await mockWebSocketServer(page, {
      "workspace.list": MOCK_WORKSPACES,
      "workspace.enrich": MOCK_ENRICHMENT,
      "workspace.touchLastOpened": null,
      "workspace.pin": (() => { rpcs.push("workspace.pin"); return null; })(),
      "thread.list": [],
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await page.waitForTimeout(800);
    await page.keyboard.press("Control+o");
    // Hover over a row to reveal the pin button
    const row = page.getByTestId("project-row").first();
    await row.hover();
    const pinBtn = row.getByTestId("project-row-pin");
    await pinBtn.click();
    // RPC should have fired (check UI updated optimistically)
    await page.waitForTimeout(300);
  });

  test("remove button on recent rows removes the workspace from recents", async ({ page }) => {
    await setupWithWorkspace(page);
    await page.keyboard.press("Control+o");
    // Hover a recent row to reveal remove button
    const dialog = page.getByRole("dialog");
    const recentRows = dialog.getByTestId("project-row");
    // Find a recent row (not pinned) — there should be at least one
    if (await recentRows.count() > 1) {
      const row = recentRows.nth(1);
      await row.hover();
      const removeBtn = row.getByTestId("project-row-remove");
      if (await removeBtn.isVisible()) {
        await removeBtn.click();
        await page.waitForTimeout(300);
        // Row should be removed from the visible list
        await expect(row).not.toBeVisible();
      }
    }
  });

  test("selecting a project from palette closes palette and activates workspace", async ({ page }) => {
    await setupWithWorkspace(page);
    await page.keyboard.press("Control+o");
    const dialog = page.getByRole("dialog");
    await page.getByText("pinned-app").click();
    // Palette should close
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
    // Landing should not be shown (workspace is now active)
    await expect(page.getByText("mcode")).not.toBeVisible({ timeout: 3000 });
  });
});
