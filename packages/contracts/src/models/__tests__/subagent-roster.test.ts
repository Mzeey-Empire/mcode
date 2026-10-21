import { describe, expect, it } from "vitest";
import { SubagentRosterSchema, SubagentDetailSchema, isSubagentLaunchToolName, type SubagentRoster } from "../subagent-roster.js";

const roster: SubagentRoster = {
  owningParentThreadId: "parent", epoch: "boot-one", revision: 7, truncated: false,
  entries: [{
    id: "call:agent-1", provider: "claude", title: "Inspect the build", prompt: "Find the build failure",
    subagentType: "Explore", model: null, reasoningEffort: null, stepCount: 2, status: "stopped",
    startedAt: "2026-10-10T10:00:00.000Z", endedAt: "2026-10-10T10:01:00.000Z",
    tier: "steps", canStop: false, sourceToolCallId: "agent-1", childThreadId: null,
    sourceMessageId: "message-1", parentEntryId: null,
  }],
};

describe("subagent wire contracts", () => {
  it("round-trips identity, provider, stopped status and evidence tier", () => {
    expect(SubagentRosterSchema().parse(JSON.parse(JSON.stringify(roster)))).toEqual(roster);
  });

  it("round-trips steps and summary", () => {
    const detail = {
      entryId: "call:agent-1",
      steps: [{ toolCallId: "step-3", toolName: "Edit", label: "Fix build", status: "done", additions: 2, deletions: 1 }],
      totalSteps: 35, summary: "Fixed the build",
    };
    expect(SubagentDetailSchema().parse(JSON.parse(JSON.stringify(detail)))).toEqual(detail);
  });

  it("rejects old status vocabulary, invalid providers and oversized responses", () => {
    const entry = roster.entries[0];
    expect(SubagentRosterSchema().safeParse({ ...roster, entries: [{ ...entry, status: "Interrupted" }] }).success).toBe(false);
    expect(SubagentRosterSchema().safeParse({ ...roster, entries: [{ ...entry, provider: "unknown" }] }).success).toBe(false);
    expect(SubagentRosterSchema().safeParse({ ...roster, entries: Array.from({ length: 257 }, () => entry) }).success).toBe(false);
    expect(SubagentDetailSchema().safeParse({
      entryId: "call:agent-1", totalSteps: 33, summary: null,
      steps: Array.from({ length: 33 }, () => ({ toolCallId: "step", toolName: "Read", label: "Read", status: "done" })),
    }).success).toBe(false);
  });
});

describe("isSubagentLaunchToolName", () => {
  it.each(["Agent", "delegate_task", "mcp__mcode__delegate_task", "mcp:mcode/delegate_task"])("starts a sub-agent: %s", (name) => {
    expect(isSubagentLaunchToolName(name)).toBe(true);
  });

  it.each(["agent", "mcp__other__delegate_task", "mcp:other/delegate_task", "mcp__mcode__task_status", "delegate_task_v2"])(
    "does not start a sub-agent: %s",
    (name) => {
      expect(isSubagentLaunchToolName(name)).toBe(false);
    },
  );
});
