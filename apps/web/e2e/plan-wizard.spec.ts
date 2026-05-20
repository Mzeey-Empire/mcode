import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * E2E tests for the Plan Question Wizard (composer-takeover pattern).
 *
 * These verify:
 * 1. Wizard renders with correct ARIA structure when plan questions arrive
 * 2. Keyboard navigation selects options and advances questions
 * 3. Wizard hides when no plan questions exist
 * 4. AcceptRecommended appears for all-recommended batches
 *
 * Strategy: Mock WS, intercept Zustand stores, inject a workspace/thread
 * into the workspace store, then inject plan questions into the thread store.
 */

const WORKSPACE = {
  id: "ws-plan-1",
  name: "Plan Test",
  path: "/tmp/plan-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-plan-1",
  workspace_id: "ws-plan-1",
  title: "Plan mode test",
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

const MOCK_QUESTIONS = [
  {
    id: "q1",
    category: "ARCHITECTURE",
    question: "Which database should we use?",
    options: [
      { id: "o1", title: "PostgreSQL", description: "Relational, battle-tested", recommended: true },
      { id: "o2", title: "MongoDB", description: "Document store, flexible schema" },
      { id: "o3", title: "SQLite", description: "Embedded, zero config" },
    ],
  },
  {
    id: "q2",
    category: "AUTH",
    question: "Authentication strategy?",
    options: [
      { id: "o4", title: "JWT", description: "Stateless tokens", recommended: true },
      { id: "o5", title: "Session cookies", description: "Server-side sessions" },
    ],
  },
];

/** Set up workspace + thread in the workspace store so ChatView renders. */
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

/** Inject plan questions into the thread store. */
async function injectPlanQuestions(
  page: Page,
  threadId: string,
  questions: typeof MOCK_QUESTIONS,
): Promise<void> {
  await page.evaluate(
    ({ tid, qs }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const threadStore = stores.find((s) => {
        const st = s.getState();
        return "planQuestionsByThread" in st && "setPlanQuestions" in st;
      });
      if (!threadStore) throw new Error("[E2E] thread store not found");
      threadStore.getState().setPlanQuestions(tid, qs);
    },
    { tid: threadId, qs: questions },
  );
}

test.describe("Plan Question Wizard", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await setupWorkspace(page);
  });

  test("wizard is not visible when no plan questions exist", async ({ page }) => {
    // Give React a tick to render, then verify no wizard
    await page.waitForTimeout(500);
    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toHaveCount(0);
  });

  test("wizard renders with correct ARIA roles when questions are injected", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Radiogroup with options
    const radiogroup = wizard.locator("[role='radiogroup']");
    await expect(radiogroup).toBeVisible();

    // 3 question options + 1 "Other" = 4 radio tiles
    const radios = wizard.locator("[role='radio']");
    await expect(radios).toHaveCount(4);

    // All radios start unchecked
    for (let i = 0; i < 4; i++) {
      await expect(radios.nth(i)).toHaveAttribute("aria-checked", "false");
    }

    await page.screenshot({
      path: "e2e/screenshots/plan-wizard-active.png",
      fullPage: true,
    });
  });

  test("displays question category and text", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // First question category and text
    await expect(wizard.locator("text=ARCHITECTURE")).toBeVisible();
    await expect(wizard.locator("text=Which database should we use?")).toBeVisible();

    // Step indicator shows 1/2
    await expect(wizard.locator("text=1/2")).toBeVisible();
  });

  test("shows Recommended badge on recommended options", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // PostgreSQL has recommended: true - use .first() since "Accept recommended" button also matches
    await expect(wizard.locator("[role='radio']").filter({ hasText: "Recommended" }).first()).toBeVisible();
  });

  test("keyboard number key selects an option", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Press "1" to select PostgreSQL
    await page.keyboard.press("1");

    const firstRadio = wizard.locator("[role='radio']").first();
    await expect(firstRadio).toHaveAttribute("aria-checked", "true");
  });

  test("Enter advances to next question", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Select an option and advance
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");

    // Should now show question 2 - use getByText with exact match for category
    await expect(wizard.getByText("AUTH", { exact: true })).toBeVisible();
    await expect(wizard.getByText("Authentication strategy?")).toBeVisible();
    await expect(wizard.getByText("2/2")).toBeVisible();
  });

  test("AcceptRecommended button is visible when all questions have recommended", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Both questions have exactly one recommended option
    await expect(wizard.locator("text=Accept recommended")).toBeVisible();
  });

  test("Cancel button dismisses the wizard", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    await wizard.locator("button", { hasText: "Cancel" }).click();

    // Wizard should collapse
    await expect(wizard).not.toBeVisible({ timeout: 2000 });
  });

  test("single question batch hides step indicator", async ({ page }) => {
    // Inject only one question
    await injectPlanQuestions(page, THREAD.id, [MOCK_QUESTIONS[0]]);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Step indicator should not be visible (AC-1.27)
    const stepIndicator = wizard.locator("text=/\\d+\\/\\d+/");
    await expect(stepIndicator).not.toBeVisible();
  });
});
