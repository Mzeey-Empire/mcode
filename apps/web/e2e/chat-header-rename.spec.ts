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

const thread1 = {
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

const thread2 = {
  id: "thread-2",
  workspace_id: WS_ID,
  title: "Another Thread",
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

test.describe("Chat Header Thread Rename", () => {
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
      "thread.list": [thread1, thread2],
      "thread.updateTitle": true,
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-item']");
    // Navigate to a thread (wait for 250ms delay)
    await page.locator("[data-testid='thread-item']").first().click();
    await page.waitForSelector("[data-testid='chat-header-title']");
  });

  test("double-click on thread title in chat header enters edit mode", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    await titleDiv.dblclick();
    const input = page.locator("[data-testid='chat-header-title-input']");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("double-click updates thread title", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    await titleDiv.dblclick();
    const input = page.locator("[data-testid='chat-header-title-input']");
    await input.clear();
    await input.fill("Updated Title");
    await input.press("Enter");
    // Wait for re-render
    await page.waitForSelector("[data-testid='chat-header-title']");
    await expect(page.locator("[data-testid='chat-header-title']")).toContainText("Updated Title");
  });

  test("Escape cancels edit without saving", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    const originalTitle = await titleDiv.locator("span").textContent();
    await titleDiv.dblclick();
    const input = page.locator("[data-testid='chat-header-title-input']");
    await input.press("Escape");
    await expect(input).not.toBeVisible();
    const currentTitle = await titleDiv.locator("span").textContent();
    expect(currentTitle).toBe(originalTitle);
  });

  test("edit mode closes when switching to a different thread", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    await titleDiv.dblclick();
    await expect(page.locator("[data-testid='chat-header-title-input']")).toBeVisible();
    // Click on another thread
    const secondThread = page.locator("[data-testid='thread-item']").nth(1);
    await secondThread.click();
    await page.waitForSelector("[data-testid='chat-header-title']");
    // Edit input should be gone
    await expect(page.locator("[data-testid='chat-header-title-input']")).not.toBeVisible();
  });
});
