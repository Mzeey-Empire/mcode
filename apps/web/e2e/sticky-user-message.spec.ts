import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

const WS_ID = "ws-sticky-test";
const THREAD_ID = "thread-sticky";
const USER_PROMPT = "Sticky test user prompt";
const LONG_USER_PROMPT = `${"Expand me please. ".repeat(12)}End.`;

/**
 * Seeds a thread with one user message and many assistant replies so scrolling
 * past the user bubble triggers the sticky preview bar.
 */
async function setupStickyThread(page: Page, userContent: string): Promise<void> {
  const now = new Date().toISOString();
  const workspace = {
    id: WS_ID,
    name: "Sticky Workspace",
    path: "/test/sticky",
    provider_config: {},
    is_git_repo: true,
    created_at: now,
    updated_at: now,
    pinned: false,
    last_opened_at: Date.now(),
    sort_order: 0,
  };
  const thread = {
    id: THREAD_ID,
    workspace_id: WS_ID,
    title: "Sticky Message Thread",
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

  const messages = [
    {
      id: "msg-user-sticky",
      thread_id: THREAD_ID,
      role: "user" as const,
      content: userContent,
      sequence: 0,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: now,
      attachments: null,
    },
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `msg-assistant-${i}`,
      thread_id: THREAD_ID,
      role: "assistant" as const,
      content:
        `Assistant reply ${i + 1}: ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}`,
      sequence: i + 1,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: 42,
      timestamp: new Date(Date.now() + (i + 1) * 1000).toISOString(),
      attachments: null,
    })),
  ];

  const emptyNarrative = { tools: [], thoughts: [], hooks: [] };

  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "workspace.enrich": { items: [] },
    "workspace.touchLastOpened": null,
    "thread.list": [thread],
    "message.list": { messages, hasMore: false, answeredPlanMessageIds: [] },
    "narrative.list": emptyNarrative,
    "narrative.listBatch": (params?: unknown) => {
      const messageIds =
        (params as { messageIds?: string[] } | undefined)?.messageIds ?? [];
      return Object.fromEntries(messageIds.map((id) => [id, emptyNarrative]));
    },
    "settings.get": getDefaultSettings(),
  });
}

async function openStickyThread(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/");
  await page.waitForSelector("[data-testid='thread-item']");
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector("[data-testid='message-list']");

  const scrollEl = page
    .locator("[data-testid='message-list'] >> css=.overflow-y-auto")
    .first();
  await expect(scrollEl).toBeVisible();
  return scrollEl;
}

async function scrollUntilStickyVisible(
  page: Page,
  scrollEl: ReturnType<Page["locator"]>,
): Promise<void> {
  await scrollEl.evaluate((el) => {
    const node = el as HTMLDivElement;
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.getByTestId("sticky-user-message")).toBeVisible({ timeout: 5000 });
}

test.describe("Sticky user message", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((wsId: string) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [wsId]: true }),
      );
    }, WS_ID);
  });

  test("shows the last user prompt after scrolling down the transcript", async ({ page }) => {
    await setupStickyThread(page, USER_PROMPT);
    const scrollEl = await openStickyThread(page);
    await scrollUntilStickyVisible(page, scrollEl);
    await expect(
      page.getByTestId("sticky-user-message").getByText(USER_PROMPT),
    ).toBeVisible();
  });

  test("jump control scrolls back toward the original user message", async ({ page }) => {
    await setupStickyThread(page, USER_PROMPT);
    const scrollEl = await openStickyThread(page);
    await scrollUntilStickyVisible(page, scrollEl);

    const scrollTopBeforeJump = await scrollEl.evaluate(
      (el) => (el as HTMLDivElement).scrollTop,
    );

    await page
      .getByTestId("sticky-user-message")
      .getByRole("button", { name: "Jump to your last message", exact: true })
      .click();

    await page.waitForFunction(
      ({ minScrollTop }) => {
        const el = document.querySelector("[data-testid='message-list'] .overflow-y-auto");
        return !!el && (el as HTMLDivElement).scrollTop < minScrollTop;
      },
      { minScrollTop: scrollTopBeforeJump - 40 },
      { timeout: 5000 },
    );
  });

  test("keyboard shortcut jumps when the sticky bar is visible", async ({ page }) => {
    await setupStickyThread(page, USER_PROMPT);
    const scrollEl = await openStickyThread(page);
    await scrollUntilStickyVisible(page, scrollEl);

    const scrollTopBeforeJump = await scrollEl.evaluate(
      (el) => (el as HTMLDivElement).scrollTop,
    );
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+Shift+ArrowUp" : "Control+Shift+ArrowUp");

    await page.waitForFunction(
      ({ minScrollTop }) => {
        const el = document.querySelector("[data-testid='message-list'] .overflow-y-auto");
        return !!el && (el as HTMLDivElement).scrollTop < minScrollTop;
      },
      { minScrollTop: scrollTopBeforeJump - 40 },
      { timeout: 5000 },
    );
  });

  test("expands and collapses long previews on single click", async ({ page }) => {
    await setupStickyThread(page, LONG_USER_PROMPT);
    const scrollEl = await openStickyThread(page);
    await scrollUntilStickyVisible(page, scrollEl);

    const previewButton = page.getByRole("button", { name: "Expand your last message" });
    await previewButton.click();
    await expect(page.getByRole("button", { name: "Collapse your last message" })).toBeVisible({
      timeout: 1000,
    });

    await page.getByRole("button", { name: "Collapse your last message" }).click();
    await expect(page.getByRole("button", { name: "Expand your last message" })).toBeVisible({
      timeout: 1000,
    });
  });
});
