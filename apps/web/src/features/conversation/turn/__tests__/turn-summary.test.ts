import { describe, expect, it } from "vitest";
import type { ThoughtSegmentRecord, ToolCallRecord } from "@/transport/types";
import { persistedTurnCounts, persistedTurnDurationMs } from "../turn-summary";

function record(id: string, toolName: string): ToolCallRecord {
  return {
    id,
    message_id: "answer",
    parent_tool_call_id: null,
    tool_name: toolName,
    input_summary: "README.md",
    output_summary: "done",
    status: "completed",
    started_at: "2026-08-18T12:00:00.000Z",
    completed_at: "2026-08-18T12:00:01.000Z",
    sort_order: 0,
  };
}

describe("persistedTurnCounts", () => {
  it("does not count a task-list write as a step", () => {
    const counts = persistedTurnCounts({
      tools: [record("todo", "TodoWrite"), record("read", "Read")],
      thoughts: [],
    });
    expect(counts).toEqual({ steps: 1, thoughts: 0, subagents: 0 });
  });

  it("counts a failed delegate_task as a step but not a sub-agent, unlike a failed Agent", () => {
    const counts = persistedTurnCounts({
      tools: [
        { ...record("delegate", "mcp__mcode__delegate_task"), status: "failed" },
        { ...record("agent", "Agent"), status: "failed" },
        { ...record("running", "mcp__mcode__delegate_task"), status: "running" },
      ],
      thoughts: [],
    });
    expect(counts).toEqual({ steps: 3, thoughts: 0, subagents: 2 });
  });
});

describe("persistedTurnDurationMs", () => {
  it("ends the turn at its own work, not at a background call or its steps settling later", () => {
    const read = { ...record("read", "Read"), completed_at: "2026-08-18T12:00:05.000Z" };
    const agent = { ...record("agent", "Agent"), background: true, completed_at: "2026-08-18T12:10:00.000Z" };
    const step = { ...record("step", "Bash"), parent_tool_call_id: "agent", completed_at: "2026-08-18T12:09:00.000Z" };
    const nested = { ...record("nested", "Read"), parent_tool_call_id: "step", completed_at: "2026-08-18T12:09:30.000Z" };

    expect(persistedTurnDurationMs({ tools: [nested, step, agent, read], thoughts: [] })).toBe(5_000);
  });

  it("ends a turn whose only work launched a background call at that launch", () => {
    const thought: ThoughtSegmentRecord = { id: "t", message_id: "answer", text: "", started_at: "2026-08-18T12:00:00.000Z", ended_at: null, sort_order: 0 };
    const agent = { ...record("agent", "Agent"), background: true, started_at: "2026-08-18T12:00:03.000Z", completed_at: "2026-08-18T12:10:00.000Z" };

    expect(persistedTurnDurationMs({ tools: [agent], thoughts: [] })).toBe(0);
    expect(persistedTurnDurationMs({ tools: [agent], thoughts: [thought] })).toBe(3_000);
  });
});
