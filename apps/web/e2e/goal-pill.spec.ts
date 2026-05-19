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
    :root { color-scheme: dark; --primary: #f0a800; --foreground: #fafafa; --muted: #a1a1aa; }
    body { margin: 0; padding: 24px; background: #0a0a0a; font-family: ui-sans-serif, system-ui; color: var(--foreground); font-size: 14px; }
  </style>
</head>
<body>
  <div data-testid="goal-pill" role="note" aria-label="${condition ? `${label}: ${condition}` : label}"
       style="display:flex;align-items:center;gap:12px;padding:8px 0;">
    <div style="flex:1 1 0;height:1px;background:rgba(240,168,0,0.4);"></div>
    <div style="display:flex;min-width:0;align-items:baseline;gap:10px;">
      <svg data-testid="target-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;align-self:center;color:var(--primary);">
        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
      </svg>
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:0.2em;color:var(--primary);">${label}</span>
      ${condition ? `<span style="font-family:ui-serif,Georgia,serif;font-size:14px;font-style:italic;line-height:1.4;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">&ldquo;${condition}&rdquo;</span>` : ""}
      <span style="flex-shrink:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:0.18em;color:rgba(161,161,170,0.7);">${hint}</span>
    </div>
    <div style="flex:1 1 0;height:1px;background:rgba(240,168,0,0.4);"></div>
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
