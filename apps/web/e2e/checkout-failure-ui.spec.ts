/**
 * E2E tests verifying that:
 * 1. Thread creation failures render in a CollapsibleError component
 *    (expandable details + Retry / Dismiss buttons).
 * 2. Post-checkout warnings render in a ThreadWarningBanner component
 *    (amber, collapsible, dismissible).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

// ── Test fixtures ────────────────────────────────────────────────────────────

const WORKSPACE = {
  id: "ws-checkout-test",
  name: "Checkout Failure Test",
  path: "/tmp/checkout-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const BASE_THREAD = {
  workspace_id: WORKSPACE.id,
  status: "idle" as const,
  mode: "worktree" as const,
  worktree_path: "/tmp/wt",
  branch: "mcode/test-branch",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: null,
  deleted_at: null,
  worktree_managed: true,
  sdk_session_id: null,
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

const THREAD_WITH_ERROR = {
  ...BASE_THREAD,
  id: "thread-error-1",
  title: "Thread with creation error",
  clientPreparing: false,
  clientError:
    "fatal: post-checkout hook failed (error code 1)\nhint: The worktree was created but the hook exited with an error.\nhint: Check your .git/hooks/post-checkout script.",
};

const THREAD_WITH_WARNINGS = {
  ...BASE_THREAD,
  id: "thread-warning-1",
  title: "Thread with post-checkout warnings",
  clientWarnings: [
    "warning: post-checkout hook exited with code 1\nfailed to install dependencies in worktree\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve",
    "warning: unable to update submodules in worktree",
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function setupWorkspaceState(
  page: Page,
  opts: {
    workspaces: (typeof WORKSPACE)[];
    threads: (typeof BASE_THREAD)[];
    activeWorkspaceId: string;
    activeThreadId: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ workspaces, threads, activeWorkspaceId, activeThreadId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces,
        threads,
        activeWorkspaceId,
        activeThreadId,
        loading: false,
      });
    },
    opts,
  );
}

// ── Tests: CollapsibleError ──────────────────────────────────────────────────

test.describe("Thread creation error (CollapsibleError)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () => (window as any).__mcodeHydrationComplete === true, // eslint-disable-line @typescript-eslint/no-explicit-any
    );
  });

  test("shows collapsed error summary with retry and dismiss buttons", async ({
    page,
  }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_WITH_ERROR],
      activeWorkspaceId: WORKSPACE.id,
      activeThreadId: THREAD_WITH_ERROR.id,
    });

    // Summary text should be visible
    await expect(page.getByText("Failed to create thread")).toBeVisible();

    // Retry and Dismiss buttons should be visible
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();

    // Error detail should NOT be visible yet (collapsed)
    await expect(page.locator("pre").filter({ hasText: "post-checkout" })).not.toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/collapsible-error-collapsed.png",
      fullPage: true,
    });
  });

  test("expands to show error details when clicked", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_WITH_ERROR],
      activeWorkspaceId: WORKSPACE.id,
      activeThreadId: THREAD_WITH_ERROR.id,
    });

    // Click the summary to expand
    await page.getByText("Failed to create thread").click();

    // Error detail should now be visible
    const errorDetail = page.locator("pre").filter({ hasText: "post-checkout" });
    await expect(errorDetail).toBeVisible();
    await expect(errorDetail).toContainText("post-checkout hook failed");

    await page.screenshot({
      path: "e2e/screenshots/collapsible-error-expanded.png",
      fullPage: true,
    });
  });
});

// ── Tests: ThreadWarningBanner ───────────────────────────────────────────────

test.describe("Post-checkout warning banner (ThreadWarningBanner)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "thread.list": [THREAD_WITH_WARNINGS],
      "message.list": [],
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () => (window as any).__mcodeHydrationComplete === true, // eslint-disable-line @typescript-eslint/no-explicit-any
    );
  });

  test("shows warning banner with summary and dismiss button", async ({
    page,
  }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_WITH_WARNINGS],
      activeWorkspaceId: WORKSPACE.id,
      activeThreadId: THREAD_WITH_WARNINGS.id,
    });

    // Summary text should be visible
    await expect(
      page.getByText("Post-checkout hook encountered an error"),
    ).toBeVisible();

    // Dismiss button (X) should be visible
    await expect(
      page.getByRole("button", { name: "Dismiss warning" }),
    ).toBeVisible();

    // Warning details should NOT be visible yet (collapsed)
    await expect(
      page.locator("pre").filter({ hasText: "npm ERR" }),
    ).not.toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/warning-banner-collapsed.png",
      fullPage: true,
    });
  });

  test("expands to show warning details when clicked", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_WITH_WARNINGS],
      activeWorkspaceId: WORKSPACE.id,
      activeThreadId: THREAD_WITH_WARNINGS.id,
    });

    // Click the summary to expand
    await page.getByText("Post-checkout hook encountered an error").click();

    // Warning details should now be visible
    const warningDetail = page.locator("pre").filter({ hasText: "npm ERR" });
    await expect(warningDetail).toBeVisible();

    // Both warnings should be rendered
    await expect(
      page.locator("pre").filter({ hasText: "failed to install dependencies" }),
    ).toBeVisible();
    await expect(
      page.locator("pre").filter({ hasText: "unable to update submodules" }),
    ).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/warning-banner-expanded.png",
      fullPage: true,
    });
  });

  test("dismiss button removes the warning banner", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_WITH_WARNINGS],
      activeWorkspaceId: WORKSPACE.id,
      activeThreadId: THREAD_WITH_WARNINGS.id,
    });

    await expect(
      page.getByText("Post-checkout hook encountered an error"),
    ).toBeVisible();

    // Click dismiss
    await page.getByRole("button", { name: "Dismiss warning" }).click();

    // Banner should disappear
    await expect(
      page.getByText("Post-checkout hook encountered an error"),
    ).not.toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/warning-banner-dismissed.png",
      fullPage: true,
    });
  });
});
