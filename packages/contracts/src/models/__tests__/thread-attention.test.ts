import { describe, expect, it } from "vitest";
import type { SubagentStatus } from "../subagent-roster.js";
import { foldDescendants, type ThreadDescendants } from "../thread-attention.js";

describe("foldDescendants", () => {
  it.each<{ statuses: SubagentStatus[]; expected: ThreadDescendants }>([
    { statuses: [], expected: "none" },
    { statuses: ["running", "needs-you"], expected: "needs-you" },
    { statuses: ["setting-up"], expected: "running" },
    { statuses: ["failed", "stopped", "finished"], expected: "none" },
  ])("folds $statuses to $expected", ({ statuses, expected }) => {
    expect(foldDescendants(statuses)).toBe(expected);
  });
});
