import { describe, it, expect } from "vitest";
import {
  buildStableItems,
  buildVolatileItems,
  buildVirtualItems,
  estimateItemHeight,
  STREAMING_CARD_COLLAPSED_HEIGHT,
} from "@/components/chat/virtual-items";
import type { ChatVirtualItem } from "@/components/chat/virtual-items";
import type { Message, ToolCall, HookExecution } from "@/transport/types";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    role: "assistant",
    content: "Hello world",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-01-01T00:00:00Z",
    sequence: 1,
    attachments: null,
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    toolName: "Read",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

/** Helper: build virtual items from raw inputs using the 3-function API. */
function buildAll(
  messages: readonly Message[],
  toolCalls: readonly ToolCall[],
  streamingText: string | undefined,
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
): ChatVirtualItem[] {
  const stable = buildStableItems(messages);
  const volatile = buildVolatileItems(toolCalls, isAgentRunning, agentStartTime, streamingText);
  return buildVirtualItems(stable, volatile, toolCalls.length > 0);
}

describe("buildStableItems", () => {
  it("returns only message items even when no extra options are provided", () => {
    const messages: Message[] = [
      makeMessage({ id: "u1", role: "user", content: "hi" }),
      makeMessage({ id: "a1", role: "assistant", content: "hello" }),
    ];
    const items = buildStableItems(messages);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "message")).toBe(true);
  });

  it("returns only message items when no persisted counts", () => {
    const messages: Message[] = [
      makeMessage({ id: "u1", role: "user", content: "hi" }),
      makeMessage({ id: "a1", role: "assistant", content: "hello" }),
    ];
    const items = buildStableItems(messages);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "message")).toBe(true);
  });
});

describe("buildVolatileItems", () => {
  it("returns narrative-flow item when agent is running with tool calls", () => {
    const toolCalls = [makeToolCall({ id: "t1" })];
    const items = buildVolatileItems(toolCalls, true, 1000, undefined);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }> | undefined;
    expect(narrativeItem).toBeDefined();
    expect(narrativeItem?.isAgentRunning).toBe(true);
    expect(narrativeItem?.toolCalls).toHaveLength(1);
  });

  it("returns empty array when no tool calls and agent not running", () => {
    const items = buildVolatileItems([], false, undefined, undefined);
    expect(items).toHaveLength(0);
  });

  it("returns empty array when streaming text is present but agent not running and no tool calls", () => {
    // With the narrative-flow consolidation, streaming text alone (no active agent, no tool calls)
    // does not produce a volatile item.
    const items = buildVolatileItems([], false, undefined, "partial...");
    expect(items).toHaveLength(0);
  });

  it("returns narrative-flow with streamingText when agent is running and streaming", () => {
    const items = buildVolatileItems([], true, 1000, "streaming...");
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }> | undefined;
    expect(narrativeItem).toBeDefined();
    expect(narrativeItem?.streamingText).toBe("streaming...");
    expect(narrativeItem?.isAgentRunning).toBe(true);
  });
});

describe("buildVirtualItems (combined)", () => {
  it("empty messages returns empty array", () => {
    const result = buildAll([], [], undefined, false, undefined);
    expect(result).toEqual([]);
  });

  it("messages only: one 'message' item per message", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1 }),
      makeMessage({ id: "msg-2", sequence: 2, role: "user", content: "Hi" }),
    ];
    const result = buildAll(messages, [], undefined, false, undefined);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "message", key: "msg-1" });
    expect(result[1]).toMatchObject({ type: "message", key: "msg-2" });
  });

  it("active tool calls split the last assistant message after the narrative-flow item", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "start" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "thinking" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    const types = result.map((item) => item.type);
    // msg-1, narrative-flow, msg-2 (split last assistant after narrative-flow item)
    expect(types).toEqual(["message", "narrative-flow", "message"]);
    expect(result[0]).toMatchObject({ type: "message", key: "msg-1" });
    expect(result[1]).toMatchObject({ type: "narrative-flow" });
    expect(result[2]).toMatchObject({ type: "message", key: "msg-2" });
  });

  it("streaming text with agent running adds a 'narrative-flow' item at the end", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildAll(messages, [], "partial response...", true, undefined);

    const last = result[result.length - 1];
    expect(last.type).toBe("narrative-flow");
    const narrativeItem = last as ChatVirtualItem & { type: "narrative-flow" };
    expect(narrativeItem.streamingText).toBe("partial response...");
  });

  it("indicator (running, no streaming) adds a 'narrative-flow' item", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const startTime = 12345;
    const result = buildAll(messages, [], undefined, true, startTime);

    const last = result[result.length - 1];
    expect(last.type).toBe("narrative-flow");
    const narrativeItem = last as ChatVirtualItem & { type: "narrative-flow" };
    expect(narrativeItem.startTime).toBe(startTime);
    expect(narrativeItem.isAgentRunning).toBe(true);
  });

  it("persisted tool call counts do not produce extra items", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "hi" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "done" }),
    ];
    const result = buildAll(messages, [], undefined, false, undefined);
    const types = result.map((item) => item.type);
    expect(types).toEqual(["message", "message"]);
  });

  it("includes narrative-flow with both streaming and running state when agent running and streaming", () => {
    const messages = [makeMessage({ id: "msg-1" })];
    const result = buildAll(messages, [], "streaming...", true, undefined);

    const types = result.map((item) => item.type);
    expect(types).toContain("narrative-flow");
    const narrative = result.find((i) => i.type === "narrative-flow") as (ChatVirtualItem & { type: "narrative-flow" }) | undefined;
    expect(narrative?.streamingText).toBe("streaming...");
    expect(narrative?.isAgentRunning).toBe(true);
  });

  it("does not split when last message is not assistant role", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "ok" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "user", content: "next prompt" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    // Both messages appear before narrative-flow, no split of last user message
    const types = result.map((item) => item.type);
    expect(types).toEqual(["message", "message", "narrative-flow"]);
  });

  it("full scenario: messages + tools + streaming", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "user", content: "please help" }),
      makeMessage({ id: "msg-2", sequence: 2, role: "assistant", content: "reading files" }),
    ];
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "Read" }),
      makeToolCall({ id: "tc-2", toolName: "Write" }),
    ];
    const result = buildAll(messages, toolCalls, "Here is my answer...", true, 99999);

    const types = result.map((item) => item.type);
    // user msg, narrative-flow (before split assistant msg), split assistant msg
    expect(types).toEqual(["message", "narrative-flow", "message"]);
    expect(result[0]).toMatchObject({ key: "msg-1" });
    expect(result[2]).toMatchObject({ key: "msg-2" });
    const narrativeItem = result[1] as ChatVirtualItem & { type: "narrative-flow" };
    expect(narrativeItem.toolCalls).toHaveLength(2);
    expect(narrativeItem.streamingText).toBe("Here is my answer...");
    expect(narrativeItem.isAgentRunning).toBe(true);
  });

  it("narrative-flow is present when live tool calls exist", () => {
    const messages = [
      makeMessage({ id: "msg-1", sequence: 1, role: "assistant", content: "done" }),
    ];
    const toolCalls = [makeToolCall({ id: "tc-1" })];
    const result = buildAll(messages, toolCalls, undefined, false, undefined);

    expect(result.map((item) => item.type)).toContain("narrative-flow");
  });
});

function makeHook(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    hookName: "pre-commit",
    hookType: "permission",
    status: "running",
    outputLines: [],
    fullOutput: [],
    startedAt: 1000,
    ...overrides,
  };
}

describe("buildVolatileItems with hooks", () => {
  it("includes hooks inside narrative-flow when agent is running and hooks are present", () => {
    const hooks = [makeHook()];
    const items = buildVolatileItems([], true, 1000, undefined, undefined, hooks);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }> | undefined;
    expect(narrativeItem).toBeDefined();
    expect(narrativeItem?.hooks).toHaveLength(1);
  });

  it("omits narrative-flow when no tool calls and agent not running (even with hooks)", () => {
    // Hooks alone (without agent running or tool calls) do not trigger a narrative-flow item.
    const hooks = [makeHook()];
    const items = buildVolatileItems([], false, undefined, undefined, undefined, hooks);
    expect(items.some((i) => i.type === "narrative-flow")).toBe(false);
  });

  it("narrative-flow appears before permission-request items", () => {
    const hooks = [makeHook()];
    const permissions = [{ requestId: "p1", toolName: "Edit", settled: false }];
    const items = buildVolatileItems([], true, 1000, undefined, permissions, hooks);
    const types = items.map((i) => i.type);
    const narrativeIdx = types.indexOf("narrative-flow");
    const permIdx = types.indexOf("permission-request");
    expect(narrativeIdx).toBeLessThan(permIdx);
  });

  it("narrative-flow item carries the hooks array", () => {
    const hooks = [makeHook({ hookName: "lint" }), makeHook({ hookName: "test", status: "completed", exitCode: 0, durationMs: 150 })];
    const items = buildVolatileItems([], true, 1000, undefined, undefined, hooks);
    const narrativeItem = items.find((i) => i.type === "narrative-flow") as Extract<(typeof items)[number], { type: "narrative-flow" }>;
    expect(narrativeItem.hooks).toHaveLength(2);
    expect(narrativeItem.hooks[0].hookName).toBe("lint");
  });
});

describe("estimateItemHeight", () => {
  it("system message returns 40", () => {
    const item: ChatVirtualItem = {
      key: "sys-1",
      type: "message",
      message: makeMessage({ role: "system", content: "You are an assistant." }),
    };
    expect(estimateItemHeight(item)).toBe(40);
  });

  it("short user message returns compact height (>= 74, < 200)", () => {
    const item: ChatVirtualItem = {
      key: "user-1",
      type: "message",
      message: makeMessage({ role: "user", content: "Hello!" }),
    };
    const height = estimateItemHeight(item);
    expect(height).toBeGreaterThanOrEqual(74);
    expect(height).toBeLessThan(200);
  });

  it("long assistant message returns taller estimate (> 200)", () => {
    const longContent = "This is a very long response. ".repeat(30);
    const item: ChatVirtualItem = {
      key: "asst-1",
      type: "message",
      message: makeMessage({ role: "assistant", content: longContent }),
    };
    const height = estimateItemHeight(item);
    expect(height).toBeGreaterThan(200);
  });

  it("many tool calls height capped at 400", () => {
    const toolCalls = Array.from({ length: 20 }, (_, i) =>
      makeToolCall({ id: `tc-${i}` }),
    );
    const item: ChatVirtualItem = {
      key: "active-tools",
      type: "active-tools",
      toolCalls,
    };
    expect(estimateItemHeight(item)).toBe(400);
  });

  it("indicator returns 48", () => {
    const item: ChatVirtualItem = {
      key: "indicator",
      type: "indicator",
      startTime: undefined,
      activeToolCalls: [],
    };
    expect(estimateItemHeight(item)).toBe(48);
  });

  it("streaming item returns 56", () => {
    const item: ChatVirtualItem = {
      key: "streaming",
      type: "streaming",
      text: "Hello world",
    };
    expect(estimateItemHeight(item)).toBe(STREAMING_CARD_COLLAPSED_HEIGHT);
  });

});
