import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();
const now = new Date().toISOString();
const WS_ID = "ws-1";

const workspace = {
  id: WS_ID,
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now() - 3600_000,
};

const thread = {
  id: "thread-1",
  workspace_id: WS_ID,
  title: "Test Thread",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "claude-3-5-sonnet",
  provider: "claude",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

test.describe("Sidebar Thread Rename", () => {
  test.beforeEach(async ({ page }) => {
    // Pre-expand the workspace in the sidebar so the thread list loads on mount.
    await page.addInitScript((wsId: string) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [wsId]: true }),
      );
    }, WS_ID);

    await mockWebSocketServer(page, {
      "workspace.list": [workspace],
      "workspace.enrich": { items: [] },
      "workspace.touchLastOpened": null,
      "thread.list": [thread],
      "thread.updateTitle": true,
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-list']");
  });

  test("double-click on thread in sidebar enters edit mode", async ({ page }) => {
    const threadItem = page.locator("[data-testid='thread-item']").first();
    await threadItem.dblclick();
    const input = threadItem.locator("input[type='text']");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("double-click updates thread title", async ({ page }) => {
    const threadItem = page.locator("[data-testid='thread-item']").first();
    await threadItem.dblclick();
    const input = threadItem.locator("input[type='text']");
    await input.clear();
    await input.fill("Renamed Thread");
    await input.press("Enter");
    const newTitle = await threadItem.locator("[data-testid='thread-title']").textContent();
    expect(newTitle).toBe("Renamed Thread");
  });

  test("Escape cancels edit without saving", async ({ page }) => {
    const threadItem = page.locator("[data-testid='thread-item']").first();
    const originalTitle = await threadItem.locator("[data-testid='thread-title']").textContent();
    await threadItem.dblclick();
    const input = threadItem.locator("input[type='text']");
    await input.press("Escape");
    const currentTitle = await threadItem.locator("[data-testid='thread-title']").textContent();
    expect(currentTitle).toBe(originalTitle);
  });
});
