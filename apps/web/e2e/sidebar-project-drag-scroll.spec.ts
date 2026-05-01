import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/** Injects workspace store state for sidebar project list tests. */
async function injectWorkspaceList(
  page: Page,
  workspaces: Array<{
    id: string;
    name: string;
    path: string;
    is_git_repo: boolean;
    sort_order: number;
  }>,
  activeWorkspaceId: string,
): Promise<void> {
  const iso = new Date().toISOString();
  const full = workspaces.map((w) => ({
    ...w,
    provider_config: {},
    pinned: false,
    last_opened_at: null,
    created_at: iso,
    updated_at: iso,
  }));
  await page.evaluate(
    ({ full: wsList, activeId }) => {
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
        activeWorkspaceId: activeId,
        threads: [],
        activeThreadId: null,
        loading: false,
        error: null,
      });
    },
    { full, activeId: activeWorkspaceId },
  );
}

test.describe("Sidebar project drag — scroll and layout", () => {
  test.setTimeout(45000);

  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("dragging short project list does not grow sidebar-body scrollbox", async ({
    page,
  }) => {
    await injectWorkspaceList(
      page,
      [
        {
          id: "ws-drag-a",
          name: "AlphaProject",
          path: "/tmp/alpha",
          is_git_repo: true,
          sort_order: 0,
        },
        {
          id: "ws-drag-b",
          name: "BetaProject",
          path: "/tmp/beta",
          is_git_repo: true,
          sort_order: 1,
        },
      ],
      "ws-drag-a",
    );

    await expect(page.getByTestId("project-row-ws-drag-a")).toBeVisible();

    const projectScrollViewport = page.locator(
      '[data-slot="scroll-area-viewport"]',
    );

    const scrollMetricsBefore = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="sidebar-body"]');
      const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
      return {
        bodyOverflowY: body ? getComputedStyle(body).overflowY : "",
        bodyScrollH: body?.scrollHeight ?? 0,
        bodyClientH: body?.clientHeight ?? 0,
        vpScrollH: vp?.scrollHeight ?? 0,
        vpClientH: vp?.clientHeight ?? 0,
      };
    });

    expect(scrollMetricsBefore.bodyOverflowY).toBe("hidden");
    expect(scrollMetricsBefore.bodyScrollH).toBeLessThanOrEqual(
      scrollMetricsBefore.bodyClientH + 2,
    );
    expect(scrollMetricsBefore.vpScrollH).toBeLessThanOrEqual(
      scrollMetricsBefore.vpClientH + 2,
    );

    const row = page.getByTestId("project-row-ws-drag-a");
    const box = await row.boundingBox();
    expect(box, "project row box").not.toBeNull();

    const sidebarBox = await page.getByTestId("sidebar-body").boundingBox();
    expect(sidebarBox, "sidebar body box").not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sidebarBox!.x + sidebarBox!.width / 2,
      sidebarBox!.y + sidebarBox!.height - 8,
      { steps: 14 },
    );

    const scrollMetricsDuring = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="sidebar-body"]');
      const vp = document.querySelector('[data-slot="scroll-area-viewport"]');
      return {
        bodyScrollH: body?.scrollHeight ?? 0,
        bodyClientH: body?.clientHeight ?? 0,
        vpScrollH: vp?.scrollHeight ?? 0,
        vpClientH: vp?.clientHeight ?? 0,
      };
    });

    expect(scrollMetricsDuring.bodyScrollH).toBeLessThanOrEqual(
      scrollMetricsDuring.bodyClientH + 2,
    );
    expect(scrollMetricsDuring.vpScrollH).toBeLessThanOrEqual(
      scrollMetricsDuring.vpClientH + 2,
    );

    await page.screenshot({
      path: "e2e/screenshots/sidebar-project-drag-mid.png",
    });

    await page.mouse.up();

    await expect(projectScrollViewport).toBeVisible();
  });
});
