import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

test.describe("Sidebar thread search", () => {
  test.beforeEach(async ({ page }) => {
    const now = new Date().toISOString();
    await mockWebSocketServer(page, {
      "workspace.list": [
        {
          id: "ws-1",
          name: "Test Workspace",
          path: "/test/path",
          provider_config: {},
          is_git_repo: true,
          pinned: false,
          last_opened_at: Date.now() - 3600_000,
          sort_order: 0,
          created_at: now,
          updated_at: now,
        },
      ],
      "thread.list": [
        {
          id: "thread-1",
          workspace_id: "ws-1",
          title: "Test Thread",
          status: "active",
          mode: "direct",
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
          copilot_agent: null,
          last_compact_summary: null,
        },
      ],
    });
  });

  test("search input is visible and focusable", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.getByTestId("sidebar-search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
  });

  test("Ctrl+Shift+F focuses search input", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.getByTestId("sidebar-search-input");
    await page.keyboard.press("Control+Shift+F");
    await expect(searchInput).toBeFocused();
  });

  test("typing in search updates input value", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.getByTestId("sidebar-search-input");
    await searchInput.fill("test query");
    await expect(searchInput).toHaveValue("test query");
  });

  test("Escape clears search query", async ({ page }) => {
    await page.goto("/");
    const searchInput = page.getByTestId("sidebar-search-input");
    await searchInput.fill("some text");
    await expect(searchInput).toHaveValue("some text");
    await page.keyboard.press("Escape");
    await expect(searchInput).toHaveValue("");
  });

  test("sort control is visible beside Projects", async ({ page }) => {
    await page.goto("/");
    const sortButton = page.getByLabel("Sort threads");
    await expect(sortButton).toBeVisible();
  });

  test("filter icon is visible in search bar", async ({ page }) => {
    await page.goto("/");
    const filterButton = page.getByLabel("Filter threads");
    await expect(filterButton).toBeVisible();
  });
});
