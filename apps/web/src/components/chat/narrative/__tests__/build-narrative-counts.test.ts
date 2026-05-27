import { describe, it, expect } from "vitest";
import { buildNarrativeItems } from "../build-narrative";
import type { ToolCall } from "@/transport/types";
import type { NarrationSegment } from "../types";

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

function mkSegment(text: string, startedAt: number, endedAt?: number): NarrationSegment {
  return { text, startedAt, endedAt };
}

describe("buildNarrativeItems counts", () => {
  it("returns zero counts when nothing happened", () => {
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      narrationSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    expect(items).toEqual([]);
    expect(counts).toEqual({ steps: 0, narrationSegments: 0, subagents: 0 });
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
      narrationSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    expect(counts.steps).toBe(3);
    expect(counts.subagents).toBe(1);
    expect(counts.narrationSegments).toBe(0);
  });

  it("counts narration segments", () => {
    const segments: NarrationSegment[] = [
      mkSegment("first", 500, 600),
      mkSegment("second", 700, 800),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 1000 })];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      narrationSegments: segments,
      streamingText: "",
      isAgentRunning: false,
    });
    expect(counts.narrationSegments).toBe(2);
    expect(counts.steps).toBe(1);
  });

  it("does not count the streaming final response as a narration segment", () => {
    const segments: NarrationSegment[] = [
      mkSegment("streaming-final", 1000), // no endedAt → still streaming
    ];
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      narrationSegments: segments,
      streamingText: "",
      isAgentRunning: true,
    });
    // Final streaming response renders as `delta`, not `narration` (no anyToolRunning)
    expect(items.find((it) => it.type === "delta")).toBeDefined();
    expect(counts.narrationSegments).toBe(0);
  });

  it("appends isFinal surplus as delta after segments when streaming extends past segment tape", () => {
    const segments: NarrationSegment[] = [
      mkSegment("pre-tool reasoning", 100, 700),
    ];
    const tools: ToolCall[] = [
      mkTool({
        id: "r1",
        toolName: "Read",
        startedAt: 800,
      }),
    ];
    const fullStream = `${segments[0]!.text}Here is the answer.`;
    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      narrationSegments: segments,
      streamingText: fullStream,
      isAgentRunning: true,
    });
    expect(items.find((it) => it.type === "narration")?.type).toBe("narration");
    const deltaItem = items.find((it) => it.type === "delta");
    expect(deltaItem?.type === "delta" ? deltaItem.text : "").toBe("Here is the answer.");
    expect(counts.narrationSegments).toBe(1);
  });

  it("counts an in-progress Agent as both a step and a sub-agent", () => {
    const tools: ToolCall[] = [
      mkTool({ id: "1", toolName: "Read", startedAt: 1000 }),
      mkTool({ id: "2", toolName: "Agent", startedAt: 2000, isComplete: false }),
    ];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      narrationSegments: [],
      streamingText: "",
      isAgentRunning: true,
    });
    expect(counts.steps).toBe(2);
    expect(counts.subagents).toBe(1);
  });

  it("hides segments that duplicate the committed assistant bubble (post-turn live trail)", () => {
    const body = "README updated. Same paragraphs in narration and bubble.";
    const segments: NarrationSegment[] = [
      mkSegment("earlier reasoning", 100, 200),
      mkSegment(body, 300, 400),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 500 })];
    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      narrationSegments: segments,
      streamingText: "",
      isAgentRunning: false,
      committedAssistantBody: body,
    });
    expect(items.filter((it) => it.type === "narration")).toHaveLength(1);
    expect(counts.narrationSegments).toBe(1);
  });

  it("hides latest narration segment when bubble ends with that segment text (suffix fallback)", () => {
    const tail = "tail of final reply";
    const body = `Prefix context…${tail}`;
    const segments: NarrationSegment[] = [
      mkSegment("plan", 100, 200),
      mkSegment(tail, 300, 400),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 500 })];
    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      narrationSegments: segments,
      streamingText: "",
      isAgentRunning: false,
      committedAssistantBody: body,
    });
    expect(items.filter((it) => it.type === "narration")).toHaveLength(1);
    expect(counts.narrationSegments).toBe(1);
  });
});
