import { describe, expect, it } from "vitest";
import type { ThoughtSegmentRecord, ToolCall, ToolCallRecord } from "@/transport/types";
import { buildNarrativeItems, computeLiveStreamingText } from "../build-narrative";
import { buildPersistedNarrativeItems } from "../build-persisted-narrative";
import { currentActivityHeading } from "../activity-label";
import { persistedTurnCounts } from "../../turn/turn-summary";
import type { ThoughtSegment } from "../types";

function tool(id: string, startedAt: number): ToolCall {
  return { id, toolName: "Read", toolInput: {}, output: "done", isError: false, isComplete: true, startedAt };
}

function toolRecord(id: string, sortOrder: number): ToolCallRecord {
  return {
    id,
    message_id: "m-1",
    parent_tool_call_id: null,
    tool_name: "Read",
    input_summary: "",
    output_summary: "",
    status: "completed",
    started_at: "2026-05-15T10:00:00Z",
    completed_at: "2026-05-15T10:00:01Z",
    sort_order: sortOrder,
  };
}

function thoughtRecord(over: Partial<ThoughtSegmentRecord>): ThoughtSegmentRecord {
  return {
    id: "th-1",
    message_id: "m-1",
    text: "thought",
    started_at: "2026-05-15T10:00:02Z",
    ended_at: "2026-05-15T10:00:05Z",
    sort_order: 1,
    ...over,
  };
}

const openReasoning: ThoughtSegment = { text: "Weighing options.", startedAt: 20, kind: "reasoning", isExplicitNonFinal: true };

describe("live reasoning narrative", () => {
  it("renders reasoning between tools as one reasoning row", () => {
    const { items, counts } = buildNarrativeItems({
      toolCalls: [tool("t1", 10), tool("t2", 30)],
      hooks: [],
      thoughtSegments: [{ ...openReasoning, endedAt: 25 }],
      streamingText: "",
      isAgentRunning: true,
    });
    expect(items.map((item) => item.type)).toEqual(["tool-group", "reasoning", "tool-group"]);
    expect(counts.thoughts).toBe(0);
  });

  it("keeps open reasoning out of the answer slot and the promoted delta", () => {
    const inputs = { toolCalls: [], hooks: [], thoughtSegments: [openReasoning], streamingText: "", isAgentRunning: true };
    expect(computeLiveStreamingText(inputs)).toBe("");
    expect(buildNarrativeItems(inputs).items).toEqual([{ type: "reasoning", segment: openReasoning, isActive: true }]);
  });

  it("subtracts only narration from the streamed answer tape", () => {
    const narration: ThoughtSegment = { text: "Checking. ", startedAt: 1, endedAt: 2 };
    const closedReasoning = { ...openReasoning, endedAt: 4 };
    const inputs = {
      toolCalls: [],
      hooks: [],
      thoughtSegments: [narration, closedReasoning],
      streamingText: "Checking. The answer.",
      isAgentRunning: true,
    };
    expect(computeLiveStreamingText(inputs)).toBe("The answer.");
    expect(buildNarrativeItems(inputs).items.at(-1)).toEqual({ type: "delta", text: "The answer." });
  });

  it("keeps reasoning that repeats the committed answer", () => {
    const { items } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      thoughtSegments: [{ ...openReasoning, endedAt: 25 }],
      streamingText: "",
      isAgentRunning: false,
      committedAssistantBody: openReasoning.text,
    });
    expect(items.map((item) => item.type)).toEqual(["reasoning"]);
  });

  it("does not read a heading from open reasoning", () => {
    expect(currentActivityHeading([{ ...openReasoning, text: "**Planning**\nnext" }])).toBeUndefined();
  });
});

describe("persisted reasoning narrative", () => {
  it("renders a reasoning record between tools as one reasoning row with its kind", () => {
    const items = buildPersistedNarrativeItems({
      tools: [toolRecord("t1", 0), toolRecord("t2", 2)],
      thoughts: [thoughtRecord({ kind: "reasoning", is_final_response: 0 })],
      hooks: [],
    });
    expect(items.map((item) => item.type)).toEqual(["tool-group", "reasoning", "tool-group"]);
    expect(items[1]).toMatchObject({ segment: { kind: "reasoning" }, isActive: false });
  });

  it("keeps a reasoning record whose text matches the answer", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [thoughtRecord({ kind: "reasoning", text: "The answer." })],
      hooks: [],
      messageContent: "The answer.",
    });
    expect(items.map((item) => item.type)).toEqual(["reasoning"]);
  });

  it("reads a legacy record without kind as narration", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [thoughtRecord({ text: "Older narration." })],
      hooks: [],
    });
    expect(items).toMatchObject([{ type: "thought", segment: { text: "Older narration." } }]);
    expect(items[0]).not.toHaveProperty("segment.kind");
  });

  it("does not count reasoning records as thoughts", () => {
    const counts = persistedTurnCounts({
      tools: [toolRecord("t1", 0)],
      thoughts: [thoughtRecord({ id: "n" }), thoughtRecord({ id: "r", kind: "reasoning", sort_order: 2 })],
    });
    expect(counts).toEqual({ steps: 1, thoughts: 1, subagents: 0 });
  });
});
