import { describe, expect, it } from "vitest";
import { SubagentRosterEntrySchema } from "@mcode/contracts";
import { subagentChipStatus, subagentOverviewCounts, subagentStatusLabel } from "../subagent-status";

describe("shared subagent surface words", () => {
  it.each([
    ["running", "Running", "working"],
    ["done", "Done", "finished"],
    ["failed", "Failed", "failed"],
    ["stopped", "Stopped", "stopped"],
  ] as const)("maps %s without deriving another lifecycle", (status, list, chip) => {
    expect(subagentStatusLabel(status)).toBe(list);
    expect(subagentChipStatus(status)).toBe(chip);
  });

  it("counts every terminal outcome as done", () => {
    const entries = ["running", "running", "done", "failed", "stopped"].map((status, index) =>
      SubagentRosterEntrySchema().parse({
        id: `call:${index}`, provider: "claude", title: "Inspect", prompt: null,
        subagentType: null, model: null, stepCount: 0, status,
        startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "steps",
        canStop: false, sourceToolCallId: String(index), childThreadId: null,
        sourceMessageId: null, parentEntryId: null,
      }));
    expect(subagentOverviewCounts(entries)).toEqual({ active: 2, done: 3 });
    expect(subagentOverviewCounts([])).toEqual({ active: 0, done: 0 });
  });
});
