import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@/transport/types";
import { persistedTurnCounts } from "../turn-summary";

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
});
