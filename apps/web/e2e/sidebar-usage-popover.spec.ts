import { expect, test, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

const THREAD_ID = "thread-usage-hover";
const WORKSPACE = {
  id: "ws-usage-hover",
  name: "Hover Test Workspace",
  path: "/tmp/hover-test",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: THREAD_ID,
  workspace_id: WORKSPACE.id,
  title: "Hover Test Thread",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: "claude-opus-4-7",
  deleted_at: null,
  worktree_managed: false,
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

/**
 * Inject workspace and thread state directly into Zustand stores so the
 * SidebarUsagePanel renders without needing a real backend response.
 */
async function seedThread(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, threadId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) return;
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: threadId,
      });
    },
    { workspace: WORKSPACE, thread: THREAD, threadId: THREAD_ID },
  );
}

/**
 * Close the popover by dispatching an Escape keydown directly to the document.
 *
 * Base UI's useDismiss attaches its keydown listener at document level, not on
 * the focused DOM element. Playwright's page.keyboard.press() targets the
 * currently focused element, which may not bubble to document in all cases
 * (especially when the popover was opened by hover and FloatingFocusManager is
 * disabled). Dispatching directly to document matches Base UI's listener.
 */
async function dismissViaEscape(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

test.describe("Sidebar usage popover", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "thread.messages": [],
      "provider.getUsage": null,
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await seedThread(page);
    // Allow React to re-render after store mutation.
    await page.waitForTimeout(200);
  });

  test("opens on hover and can be dismissed", async ({ page }) => {
    // Wait for sidebar usage strip to render. The trigger is the
    // role=button with aria-label "Show usage details".
    const trigger = page.getByRole("button", { name: "Show usage details" });
    await expect(trigger).toBeVisible();

    // Popover content should not be present initially.
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toHaveCount(0);

    // Hover opens within 200ms (Base UI delay=80ms + render).
    await trigger.hover();
    await expect(popover).toBeVisible({ timeout: 500 });

    // Verify popover content is rendered in the portal.
    await expect(popover).toContainText("claude-opus-4-7");

    // Dismiss via Escape. Base UI's useDismiss listens at document level
    // (not on the focused element), so we dispatch directly to document.
    // Hover-out dismissal uses Base UI's safePolygon which tracks pointer-events
    // mutations — reliable in real browsers but not through Playwright's
    // synthetic CDP events.
    await dismissViaEscape(page);
    await expect(popover).toHaveCount(0, { timeout: 500 });
  });

  test("opens on keyboard focus and can be dismissed", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Show usage details" });
    const popover = page.locator('[data-slot="popover-content"]');

    await trigger.focus();
    await expect(popover).toBeVisible({ timeout: 500 });

    await dismissViaEscape(page);
    await expect(popover).toHaveCount(0, { timeout: 500 });
  });
});
