import { describe, it, expect } from "vitest";
import { buildPersistedNarrativeItems } from "./build-persisted-narrative";
import type {
  ToolCallRecord,
  NarrationSegmentRecord,
  HookExecutionRecord,
} from "@/transport/types";

function makeTool(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "t-1",
    message_id: "m-1",
    parent_tool_call_id: null,
    tool_name: "Read",
    input_summary: "",
    output_summary: "",
    status: "completed",
    started_at: "2026-05-15T10:00:00Z",
    completed_at: "2026-05-15T10:00:01Z",
    sort_order: 1,
    ...over,
  };
}

function makeSegment(over: Partial<NarrationSegmentRecord> = {}): NarrationSegmentRecord {
  return {
    id: "ns-1",
    message_id: "m-1",
    text: "narration",
    started_at: "2026-05-15T10:00:00Z",
    ended_at: "2026-05-15T10:00:00.500Z",
    sort_order: 1,
    ...over,
  };
}

function makeHook(over: Partial<HookExecutionRecord> = {}): HookExecutionRecord {
  return {
    id: "hk-1",
    message_id: "m-1",
    hook_name: "PreToolUse",
    tool_name: "Bash",
    phase: "permission",
    payload: "{}",
    duration_ms: 12,
    did_block: false,
    started_at: "2026-05-15T10:00:00Z",
    ended_at: "2026-05-15T10:00:00.012Z",
    sort_order: 2,
    ...over,
  };
}

describe("buildPersistedNarrativeItems", () => {
  it("empty input returns no items", () => {
    expect(buildPersistedNarrativeItems({ tools: [], narrationSegments: [], hooks: [] })).toEqual([]);
  });

  it("narration-only: emits a narration row per record", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      narrationSegments: [makeSegment({ id: "ns-1", text: "a", sort_order: 1 })],
      hooks: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("narration");
  });

  it("tools-only flat: groups consecutive completed non-Agent calls into a tool-group", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "t-1", tool_name: "Read", sort_order: 1 }),
        makeTool({ id: "t-2", tool_name: "Write", sort_order: 2 }),
      ],
      narrationSegments: [],
      hooks: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].group.calls).toHaveLength(2);
    }
  });

  it("hooks-only: emits a hook row per record", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      narrationSegments: [],
      hooks: [makeHook({ id: "hk-1" })],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("hook");
  });

  it("nests child tool calls under their parent Agent as a subagent row", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "agent-1", tool_name: "Agent", sort_order: 1 }),
        makeTool({ id: "child-1", tool_name: "Read", sort_order: 2, parent_tool_call_id: "agent-1" }),
      ],
      narrationSegments: [],
      hooks: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("subagent");
    if (items[0].type === "subagent") {
      expect(items[0].children).toHaveLength(1);
      expect(items[0].toolCall.id).toBe("agent-1");
    }
  });

  it("parallel sub-agents render as separate subagent rows", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "agent-1", tool_name: "Agent", sort_order: 1 }),
        makeTool({ id: "agent-2", tool_name: "Agent", sort_order: 2 }),
        makeTool({ id: "c-1a", tool_name: "Read", sort_order: 3, parent_tool_call_id: "agent-1" }),
        makeTool({ id: "c-2a", tool_name: "Read", sort_order: 4, parent_tool_call_id: "agent-2" }),
      ],
      narrationSegments: [],
      hooks: [],
    });
    expect(items.filter((i) => i.type === "subagent")).toHaveLength(2);
  });

  it("interleaves all streams by sort_order", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "t-1", tool_name: "Read", sort_order: 2 }),
        makeTool({ id: "t-2", tool_name: "Write", sort_order: 5 }),
      ],
      narrationSegments: [
        makeSegment({ id: "ns-1", sort_order: 1 }),
        makeSegment({ id: "ns-2", sort_order: 3 }),
      ],
      hooks: [makeHook({ id: "hk-1", sort_order: 4 })],
    });
    // sort: narration(1), tool(2), narration(3), hook(4), tool(5)
    // tool-group breaks on each non-tool, so: narration, tool-group(1), narration, hook, tool-group(1)
    expect(items.map((i) => i.type)).toEqual([
      "narration",
      "tool-group",
      "narration",
      "hook",
      "tool-group",
    ]);
  });

  it("hides a narration row that exactly matches messageContent even when sort_order is not last", () => {
    const dup = "ENTIRE ASSISTANT BODY";
    const items = buildPersistedNarrativeItems({
      tools: [],
      narrationSegments: [
        makeSegment({ id: "ns-dup", text: dup, sort_order: 1 }),
        makeSegment({ id: "ns-tail", text: "short note", sort_order: 9 }),
      ],
      hooks: [],
      messageContent: dup,
    });
    const narrationTexts = items
      .filter((i): i is Extract<typeof i, { type: "narration" }> => i.type === "narration")
      .map((i) => i.segment.text);
    expect(narrationTexts).toEqual(["short note"]);
  });

  it("memo cache invalidates when messageContent changes but narration reference is stable", () => {
    const segments = [
      makeSegment({ id: "ns-dup", text: "BODY", sort_order: 1 }),
      makeSegment({ id: "ns-keep", text: "note", sort_order: 2 }),
    ];
    const first = buildPersistedNarrativeItems({
      tools: [],
      narrationSegments: segments,
      hooks: [],
      messageContent: "BODY",
    });
    const second = buildPersistedNarrativeItems({
      tools: [],
      narrationSegments: segments,
      hooks: [],
      messageContent: "OTHER",
    });
    const firstTexts = first
      .filter((i): i is Extract<typeof i, { type: "narration" }> => i.type === "narration")
      .map((i) => i.segment.text);
    const secondTexts = second
      .filter((i): i is Extract<typeof i, { type: "narration" }> => i.type === "narration")
      .map((i) => i.segment.text);
    expect(firstTexts).toEqual(["note"]);
    expect(secondTexts).toEqual(["BODY", "note"]);
  });
});
