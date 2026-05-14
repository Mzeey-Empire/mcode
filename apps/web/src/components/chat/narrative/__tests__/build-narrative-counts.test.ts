import { describe, it, expect } from "vitest";
import { buildNarrativeItems } from "../build-narrative";
import type { ToolCall } from "@/transport/types";
import type { ThoughtSegment } from "../types";

function mkTool(partial: Partial<ToolCall> & { id: string; toolName: string }): ToolCall {
  return {
    id: partial.id,
    toolName: partial.toolName,
    toolInput: partial.toolInput ?? {},
    isComplete: partial.isComplete ?? true,
    isError: partial.isError ?? false,
    output: partial.output,
    parentToolCallId: partial.parentToolCallId ?? null,
    startedAt: partial.startedAt ?? 1000,
  } as ToolCall;
}

function mkThought(text: string, startedAt: number, endedAt?: number): ThoughtSegment {
  return { text, startedAt, endedAt };
}

describe("buildNarrativeItems counts", () => {
  it("returns zero counts when nothing happened", () => {
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    expect(items).toEqual([]);
    expect(counts).toEqual({ steps: 0, thoughts: 0, subagents: 0 });
  });

  it("counts top-level tool calls as steps and Agent calls as subagents", () => {
    const tools: ToolCall[] = [
      mkTool({ id: "1", toolName: "Read", startedAt: 1000 }),
      mkTool({ id: "2", toolName: "Agent", startedAt: 2000 }),
      mkTool({ id: "3", toolName: "Read", startedAt: 1500, parentToolCallId: "2" }),
      mkTool({ id: "4", toolName: "Grep", startedAt: 3000 }),
    ];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    expect(counts.steps).toBe(3);
    expect(counts.subagents).toBe(1);
    expect(counts.thoughts).toBe(0);
  });

  it("counts thought segments", () => {
    const thoughts: ThoughtSegment[] = [
      mkThought("first", 500, 600),
      mkThought("second", 700, 800),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 1000 })];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "",
      isAgentRunning: false,
    });
    expect(counts.thoughts).toBe(2);
    expect(counts.steps).toBe(1);
  });

  it("does not count the streaming final response as a thought", () => {
    const thoughts: ThoughtSegment[] = [
      mkThought("streaming-final", 1000), // no endedAt → still streaming
    ];
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "",
      isAgentRunning: true,
    });
    // Final streaming response renders as `delta`, not `thought` (no anyToolRunning)
    expect(items.find((it) => it.type === "delta")).toBeDefined();
    expect(counts.thoughts).toBe(0);
  });
});
