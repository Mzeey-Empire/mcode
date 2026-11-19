import { describe, expect, it } from "vitest";
import { SubagentRosterEntrySchema } from "@mcode/contracts/models/subagent-roster";
import { formatLiveDuration, subagentChipStatus, subagentOverviewCounts, subagentStatusLabel } from "../subagent-status";

describe("shared subagent surface words", () => {
  it.each([
    ["needs-you", "Needs you", "needs you"],
    ["setting-up", "Setting up", "setting up"],
    ["running", "Running", "working"],
    ["failed", "Failed", "failed"],
    ["stopped", "Stopped", "stopped"],
    ["finished", "Finished", "finished"],
  ] as const)("maps %s without deriving another lifecycle", (status, list, chip) => {
    expect(subagentStatusLabel(status)).toBe(list);
    expect(subagentChipStatus(status)).toBe(chip);
  });

  it("counts setting up as running, stopped as finished, and failed apart", () => {
    const entries = ["needs-you", "setting-up", "running", "failed", "stopped", "finished"].map((status, index) =>
      SubagentRosterEntrySchema().parse({
        id: `call:${index}`, provider: "claude", title: "Inspect", prompt: null,
        subagentType: null, model: null, reasoningEffort: null, stepCount: 0, status,
        startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "steps",
        canStop: false, sourceToolCallId: String(index), childThreadId: null,
        sourceMessageId: null, parentEntryId: null,
      }));
    expect(subagentOverviewCounts(entries)).toEqual({ needsYou: 1, running: 2, failed: 1, finished: 2 });
    expect(subagentOverviewCounts([])).toEqual({ needsYou: 0, running: 0, failed: 0, finished: 0 });
  });
});

describe("formatLiveDuration", () => {
  it.each([
    [-5_000, "0s"],
    [999, "0s"],
    [48_000, "48s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [72_000, "1m 12s"],
    [3_599_000, "59m 59s"],
    [3_600_000, "1h 0m"],
    [3_780_000, "1h 3m"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatLiveDuration(ms)).toBe(expected);
  });
});
