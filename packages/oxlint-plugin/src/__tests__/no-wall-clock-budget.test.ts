import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noWallClockBudget } from "../rules/no-wall-clock-budget.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("no-wall-clock-budget", noWallClockBudget, {
  valid: [
    {
      name: "a lower bound on elapsed time",
      code: "const elapsedMs = performance.now() - startedAt; expect(elapsedMs).toBeGreaterThanOrEqual(100);",
    },
    {
      name: "a wall-clock value used as data",
      code: "cacheRecord(id, { lastHydratedAt: Date.now() - 5000 });",
    },
    {
      name: "an upper bound on a counted value",
      code: "expect(reads).toBeLessThanOrEqual(4_000);",
    },
    {
      name: "an upper bound on a constant",
      code: "expect(PAGE_SNAPSHOT_DEBOUNCE_MS).toBeLessThanOrEqual(300);",
    },
  ],
  invalid: [
    {
      name: "an inline elapsed expression",
      code: "expect(performance.now() - startedAt).toBeLessThan(1_000);",
      errors: [{ messageId: "wallClockBudget" }],
    },
    {
      name: "elapsed time through a variable",
      code: "const elapsedMs = performance.now() - startedAt; expect(elapsedMs).toBeLessThan(2_000);",
      errors: [{ messageId: "wallClockBudget" }],
    },
    {
      name: "Date.now with an inclusive upper bound",
      code: "expect(Date.now() - startedAt).toBeLessThanOrEqual(500);",
      errors: [{ messageId: "wallClockBudget" }],
    },
  ],
});
