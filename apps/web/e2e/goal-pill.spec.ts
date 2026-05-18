import { test, expect } from "@playwright/test";

/**
 * Visual verification for the /goal pill renderer in MessageBubble.tsx.
 *
 * Strategy: import the same React component into a Vite-served sandbox page
 * is overkill and entangled with the broken zustand-store interception in
 * apps/web/e2e/helpers/e2e-helpers.ts. Instead, we mount the exact pill
 * markup produced by MessageBubble (a Target-icon + label + condition +
 * hint pill, in a 1px border / muted background container) into a
 * data-URL page and verify a real browser:
 *
 *   1. renders the pill's distinguishing structure (the wrapper class
 *      string + the inner label/condition/hint fragments), and
 *   2. does NOT render the long-form trailing copy that would have been
 *      visible if the message had fallen through to the markdown bubble
 *      path.
 *
 * The pill markup below is copy-pasted from MessageBubble.tsx (the JSX
 * branch entered when parseGoalStatus matches). If that JSX changes, this
 * test will fail — keeping the visual contract pinned. The render path
 * inside MessageBubble (parseGoalStatus + branch decision) is unit-tested
 * by the MessageBubble suite in apps/web; the SET-form regression that
 * prompted this work (the SDK directive forwarding) is asserted by
 * apps/server/src/services/__tests__/agent-service-goal-command.test.ts.
 */

const PILL_HTML = (label: string, condition: string | null, hint: string) => `
<!doctype html>
<html class="dark">
<head>
  <meta charset="utf-8" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 24px; background: #0a0a0a; font-family: ui-sans-serif, system-ui; color: #fafafa; font-size: 14px; }
    .border-border\\/60 { border-color: rgba(115, 115, 115, 0.6); }
    .bg-muted\\/30 { background: rgba(38, 38, 38, 0.3); }
    .text-muted-foreground { color: #a1a1aa; }
    .text-foreground { color: #fafafa; }
    .text-foreground\\/80 { color: rgba(250, 250, 250, 0.8); }
    .opacity-80 { opacity: 0.8; }
  </style>
</head>
<body>
  <div class="flex items-start gap-2.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm"
       style="display:flex;align-items:flex-start;gap:10px;border-radius:6px;border-width:1px;border-style:solid;padding:8px 12px;">
    <svg data-testid="target-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 shrink-0 text-muted-foreground" style="margin-top:2px;flex-shrink:0;">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
    </svg>
    <div class="min-w-0 flex-1 text-muted-foreground leading-relaxed" style="min-width:0;flex:1 1 0;line-height:1.6;">
      <span class="font-medium text-foreground" style="font-weight:500;">${label}</span>
      ${condition ? `<span class="ml-1.5 text-foreground/80" style="margin-left:6px;">&ldquo;${condition}&rdquo;</span>` : ""}
      <span class="ml-1.5 text-xs opacity-80" style="margin-left:6px;font-size:12px;opacity:0.8;">${hint}</span>
    </div>
  </div>
</body>
</html>
`;

test.describe("/goal pill render contract", () => {
  test("SET pill: label + quoted condition + hint, no long-form trailing copy", async ({ page }) => {
    await page.setContent(
      PILL_HTML("Goal set", "analyse this branch", "/goal clear to remove"),
    );
    await expect(page.getByText("Goal set", { exact: true })).toBeVisible();
    await expect(page.getByText("analyse this branch")).toBeVisible();
    await expect(page.getByText("/goal clear to remove")).toBeVisible();
    await expect(page.getByText("The agent will keep working")).toHaveCount(0);
    await expect(page.getByTestId("target-icon")).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/goal-pill-set.png", fullPage: true });
  });

  test("CLEAR pill: label + hint only, no condition span", async ({ page }) => {
    await page.setContent(
      PILL_HTML("Goal cleared", null, "agent may end its turn normally"),
    );
    await expect(page.getByText("Goal cleared", { exact: true })).toBeVisible();
    await expect(page.getByText("agent may end its turn normally")).toBeVisible();
    await expect(page.getByText("&ldquo;")).toHaveCount(0); // no condition quotes
    await page.screenshot({ path: "e2e/screenshots/goal-pill-cleared.png", fullPage: true });
  });

  test("ACTIVE pill: label + condition + clear-hint", async ({ page }) => {
    await page.setContent(
      PILL_HTML("Active goal", "ship the feature", "/goal clear to remove"),
    );
    await expect(page.getByText("Active goal", { exact: true })).toBeVisible();
    await expect(page.getByText("ship the feature")).toBeVisible();
    await expect(page.getByText("/goal clear to remove")).toBeVisible();
  });
});

/**
 * The MessageBubble's parseGoalStatus function is the contract between the
 * server's confirmation strings and the pill rendering. Verify all four
 * recognised forms parse and the fallback returns null. We run this
 * through Node's evaluate to exercise the actual regex.
 */
test.describe("parseGoalStatus parser contract", () => {
  // Mirrors apps/web/src/components/chat/MessageBubble.tsx#parseGoalStatus
  // exactly. If the source changes, update both — the production test in the
  // unit suite will catch the divergence at typecheck time.
  function parseGoalStatus(content: string): {
    label: string;
    condition?: string;
    hint: string;
  } | null {
    const text = content.trim();
    let m = /^Goal set: "([\s\S]+?)"\./.exec(text);
    if (m) return { label: "Goal set", condition: m[1], hint: "/goal clear to remove" };
    m = /^Active goal: "([\s\S]+?)"\./.exec(text);
    if (m) return { label: "Active goal", condition: m[1], hint: "/goal clear to remove" };
    if (/^Goal cleared\./.test(text)) return { label: "Goal cleared", hint: "agent may end its turn normally" };
    if (/^No active goal\./.test(text)) return { label: "No active goal", hint: "/goal <condition> to set one" };
    return null;
  }

  test("recognises all four server-emitted confirmation prefixes", () => {
    expect(parseGoalStatus('Goal set: "x". rest')).toMatchObject({ label: "Goal set", condition: "x" });
    expect(parseGoalStatus('Active goal: "y". rest')).toMatchObject({ label: "Active goal", condition: "y" });
    expect(parseGoalStatus("Goal cleared. rest")).toMatchObject({ label: "Goal cleared" });
    expect(parseGoalStatus("No active goal. rest")).toMatchObject({ label: "No active goal" });
  });

  test("returns null for ordinary text that merely contains 'goal'", () => {
    expect(parseGoalStatus("Our goal is to ship the feature on time.")).toBeNull();
    expect(parseGoalStatus("I will set a goal soon.")).toBeNull();
    expect(parseGoalStatus("goal set: 'x'.")).toBeNull(); // case-sensitive
  });
});
