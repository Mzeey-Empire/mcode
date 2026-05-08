import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/** Injects many workspaces to overflow the sidebar viewport. */
async function injectManyWorkspaces(page: Page, count: number): Promise<void> {
  const iso = new Date().toISOString();
  const workspaces = Array.from({ length: count }, (_, i) => ({
    id: `ws-scroll-${i}`,
    name: `Project ${String(i).padStart(2, "0")}`,
    path: `/tmp/project-${i}`,
    is_git_repo: true,
    sort_order: i,
    provider_config: {},
    pinned: false,
    last_opened_at: null,
    created_at: iso,
    updated_at: iso,
  }));

  await page.evaluate(
    ({ wsList }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: wsList,
        activeWorkspaceId: "ws-scroll-0",
        threads: [],
        activeThreadId: null,
        loading: false,
        error: null,
      });
    },
    { wsList: workspaces },
  );
}

test.describe("Sidebar project tree scroll", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("project list scrolls when projects exceed viewport height", async ({
    page,
  }) => {
    await injectManyWorkspaces(page, 20);

    await expect(page.getByTestId("project-row-ws-scroll-0")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
      if (!vp) return { scrollHeight: 0, clientHeight: 0 };
      return {
        scrollHeight: vp.scrollHeight,
        clientHeight: vp.clientHeight,
      };
    });

    // Content must overflow the viewport
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 50);

    // Viewport must be scrollable
    const scrolled = await page.evaluate(() => {
      const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
      if (!vp) return false;
      vp.scrollTop = 200;
      return vp.scrollTop > 0;
    });
    expect(scrolled).toBe(true);
  });
});
