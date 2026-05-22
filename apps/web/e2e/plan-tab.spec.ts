import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * E2E tests for the Plan tab in the right panel.
 *
 * Verifies:
 * 1. The Plan tab button exists with correct text and icon
 * 2. Switching to the Plan tab shows the "No plan" empty state
 */

const WORKSPACE = {
  id: "ws-plan-tab-1",
  name: "Plan Tab Test",
  path: "/tmp/plan-tab-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-plan-tab-1",
  workspace_id: "ws-plan-tab-1",
  title: "Plan tab test",
  branch_name: "main",
  branch_ref: "main",
  worktree_path: null,
  worktree_managed: false,
  sdk_session_id: null,
  status: "idle",
  model: "claude-sonnet-4-20250514",
  provider: "claude",
  goal: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/** Set up workspace + thread so the ChatView (and RightPanel) renders. */
async function setupWorkspace(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const wsStore = stores.find((s) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: thread.id,
        loading: false,
        error: null,
      });
    },
    { workspace: WORKSPACE, thread: THREAD },
  );
}

/** Show the right panel for the active thread via the diffStore. */
async function showRightPanel(page: Page, threadId: string): Promise<void> {
  await page.evaluate(
    ({ tid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const diffStore = stores.find((s) => {
        const st = s.getState();
        return "rightPanelByThread" in st && "showRightPanel" in st;
      });
      if (!diffStore) throw new Error("[E2E] diff store not found");
      diffStore.getState().showRightPanel(tid);
    },
    { tid: threadId },
  );
}

/**
 * Pre-seed the planStore with a stable empty array for the thread.
 *
 * Without this, PlanPanel's `s.plansByThread[threadId] ?? []` selector
 * returns a new array reference on every getSnapshot call, which triggers
 * an infinite re-render loop under the zustand intercept. Seeding with a
 * stored `[]` gives the selector a stable reference.
 */
async function seedPlanStore(page: Page, threadId: string): Promise<void> {
  await page.evaluate(
    ({ tid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const planStore = stores.find((s) => {
        const st = s.getState();
        return "plansByThread" in st && "generatingThreads" in st;
      });
      if (planStore) {
        planStore.setState({
          plansByThread: { [tid]: [] },
          activeVersionByThread: { [tid]: null },
        });
      }
    },
    { tid: threadId },
  );
}

test.describe("Plan Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await setupWorkspace(page);
  });

  test("plan tab button exists in the right panel header", async ({ page }) => {
    await showRightPanel(page, THREAD.id);

    // The Plan tab button renders with uppercase mono text and an SVG icon
    const planTab = page.locator("button").filter({ hasText: /Plan/i }).filter({
      has: page.locator("svg"),
    });
    await expect(planTab.first()).toBeVisible({ timeout: 3000 });
  });

  test("plan tab shows 'No plan' empty state when no plan exists", async ({ page }) => {
    // Seed planStore with a stable empty array so PlanPanel's selectors
    // don't trigger an infinite re-render loop under the zustand intercept
    await seedPlanStore(page, THREAD.id);

    await showRightPanel(page, THREAD.id);

    // Switch to the plan tab via store
    await page.evaluate(
      ({ tid }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const diffStore = stores.find((s) => {
          const st = s.getState();
          return "rightPanelByThread" in st && "setRightPanelTab" in st;
        });
        if (!diffStore) throw new Error("[E2E] diff store not found");
        diffStore.getState().setRightPanelTab(tid, "plan");
      },
      { tid: THREAD.id },
    );

    // The Plan tab empty state renders "No plan" in a mono-styled span
    await expect(page.getByText("No plan")).toBeVisible({ timeout: 3000 });
  });
});
