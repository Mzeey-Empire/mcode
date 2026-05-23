/**
 * Browser regression: long shell commands must not widen the message-list scrollport.
 */
import { test, expect } from "@playwright/test";

const LONG_SHELL_COMMAND =
  'cd "C:\\\\Users\\\\cjnwo\\\\.mcode\\\\worktrees\\\\mcode\\\\feat-cursor-sub-agents-71ba0f21" && git add apps/web/src/components/chat/narrative/SubagentRow.tsx apps/web/src/components/chat/narrative/sub';

test.describe("narrative tool row overflow", () => {
  test("constrained tool rows do not widen the message-list scrollport", async ({ page }) => {
    await page.goto("about:blank");

    const metrics = await page.evaluate((command) => {
      document.body.innerHTML = "";

      const scrollport = document.createElement("div");
      scrollport.className = "h-full overflow-y-auto pt-4";
      scrollport.style.width = "480px";

      const column = document.createElement("div");
      column.className = "mx-auto w-full min-w-0 max-w-4xl overflow-x-hidden";

      const row = document.createElement("div");
      row.className =
        "flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden px-2 py-1 text-[0.8125rem]";

      const icon = document.createElement("span");
      icon.className = "w-3.5 h-3.5 shrink-0 inline-block";

      const label = document.createElement("span");
      label.className = "font-medium shrink-0";
      label.textContent = "Running a command...";

      const detail = document.createElement("span");
      detail.className =
        "font-mono text-[0.6875rem] truncate flex-1 min-w-0 [overflow-wrap:anywhere]";
      detail.textContent = command;

      row.append(icon, label, detail);
      column.append(row);
      scrollport.append(column);
      document.body.append(scrollport);

      const columnRect = column.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();

      return {
        scrollportScrollWidth: scrollport.scrollWidth,
        scrollportClientWidth: scrollport.clientWidth,
        columnRight: columnRect.right,
        rowRight: rowRect.right,
        detailRight: detailRect.right,
      };
    }, LONG_SHELL_COMMAND);

    expect(metrics.scrollportScrollWidth).toBeLessThanOrEqual(metrics.scrollportClientWidth + 1);
    expect(metrics.rowRight).toBeLessThanOrEqual(metrics.columnRight + 1);
    expect(metrics.detailRight).toBeLessThanOrEqual(metrics.columnRight + 1);
  });
});
