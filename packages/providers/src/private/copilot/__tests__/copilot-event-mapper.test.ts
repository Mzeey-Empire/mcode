import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { AgentEventSchema, ProviderRuntimeEventSchema, providerRuntimeEvent } from "@mcode/contracts";
import { parseCopilotCapturedTrace } from "../../../conformance/copilot-trace.js";
import { mapCopilotEvent, closeOpenChildren, type CopilotTurnState } from "../copilot-event-mapper.js";

function turnState(): CopilotTurnState {
  return { turnExecutionId: "00000000-0000-4000-8000-000000000001", invocations: new Map(), nativeIdleObserved: false, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
    tools: new Map(), pendingPermissions: new Map(), completed: Promise.resolve(), settle: () => {} };
}


function parentEvents(event: SessionEvent, threadId: string, turn: CopilotTurnState) {
  return mapCopilotEvent(event, threadId, turn).map((mapped) => mapped.event);
}

describe("Copilot session errors", () => {
  it.each([
    { errorType: "quota", failure: { kind: "usage_limit", code: "quota" } },
    { errorType: "query", statusCode: 503, failure: { kind: "retryable", status: 503, code: "query" } },
    { errorType: "authentication", failure: { kind: "auth", code: "authentication" } },
    { errorType: "authorization", statusCode: 403, failure: { kind: "auth", status: 403, code: "authorization" } },
    { errorType: "rate_limit", statusCode: 429, failure: { kind: "retryable", status: 429, code: "rate_limit" } },
    { errorType: "context_limit", statusCode: 503, failure: { kind: "fatal", status: 503, code: "context_limit" } },
    { errorType: "unknown", failure: { kind: "fatal", code: "unknown" } },
  ])("classifies $errorType with status $statusCode", ({ errorType, statusCode, failure }) => {
    const events = parentEvents({ id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z",
      type: "session.error", data: { errorType, statusCode, message: "Native failure" },
    }, "thread", turnState());
    expect(events).toEqual([{ type: "error", threadId: "thread", error: "Native failure", failure }]);
    expect(AgentEventSchema().parse(events[0])).toEqual(events[0]);
  });

  it.each([undefined, null, "503", 99, 600, 503.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "omits an invalid optional HTTP status %s without losing the native message", (statusCode) => {
      const event: SessionEvent = { id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z",
        type: "session.error", data: { errorType: "query", message: "Native failure" } };
      Object.assign(event.data, { statusCode });
      expect(parentEvents(event, "thread", turnState())).toEqual([
        { type: "error", threadId: "thread", error: "Native failure", failure: { kind: "fatal", code: "query" } },
      ]);
    },
  );

  it.each([undefined, null, 42, {}, " ", "x".repeat(129)])("omits a malformed native error code %s", (errorType) => {
    const event: SessionEvent = { id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z",
      type: "session.error", data: { errorType: "query", statusCode: 503, message: "Native failure" } };
    Object.assign(event.data, { errorType });
    expect(parentEvents(event, "thread", turnState())).toEqual([
      { type: "error", threadId: "thread", error: "Native failure", failure: { kind: "retryable", status: 503 } },
    ]);
  });
});

// Synthetic child-tool coverage derived from copilot-core.captured.json envelope shapes.
function trace(failed = false, description = true) {
  const entries = [
    { type: "tool.execution_start", data: { toolCallId: "TOOL_1", toolName: "task", arguments: description ? { description: "REDACTED_CONTENT" } : {} } },
    { type: "subagent.started", data: { toolCallId: "TOOL_1", agentName: "AGENT_1", agentDisplayName: "AGENT_2", agentDescription: "PROMPT_1" } },
    { type: "tool.execution_start", data: { toolCallId: "TOOL_2", toolName: "read", arguments: {}, parentToolCallId: "TOOL_1" } },
    { type: "tool.execution_progress", ephemeral: true, data: { toolCallId: "TOOL_2", progressMessage: "REDACTED_CONTENT", parentToolCallId: "TOOL_1" } },
    { type: "tool.execution_complete", data: { toolCallId: "TOOL_2", success: true, result: { content: "REDACTED_TOOL_OUTPUT" }, parentToolCallId: "TOOL_1" } },
    { type: "assistant.message", data: { messageId: "MESSAGE_1", content: "REDACTED_CHILD_CONTENT", parentToolCallId: "TOOL_1" } },
    { type: "assistant.message_delta", ephemeral: true, data: { messageId: "MESSAGE_1", deltaContent: "REDACTED_CHILD_CONTENT", parentToolCallId: "TOOL_1" } },
    { type: failed ? "subagent.failed" : "subagent.completed", data: { toolCallId: "TOOL_1", agentName: "AGENT_1", agentDisplayName: "AGENT_2", ...(failed ? { error: "REDACTED_CONTENT" } : {}) } },
    { type: "tool.execution_complete", data: { toolCallId: "TOOL_1", success: true, result: { content: "REDACTED_TOOL_OUTPUT" } } },
    { type: "assistant.message_delta", ephemeral: true, data: { messageId: "MESSAGE_2", deltaContent: "REDACTED_CONTENT" } },
  ];
  return parseCopilotCapturedTrace(entries.map((event, index) => ({ ...event, id: `EVENT_${index}`, parentId: null,
    timestamp: `2000-01-01T00:00:0${index}.000Z` })));
}

describe("Copilot subagent mapping", () => {
  const metadata = { id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z" };
  function start(turn: CopilotTurnState, toolCallId: string, parentToolCallId?: string, args: Record<string, unknown> = {}) {
    const provisional = mapCopilotEvent({ ...metadata, type: "tool.execution_start", data: {
      toolCallId, toolName: "task", arguments: args, ...(parentToolCallId ? { parentToolCallId } : {}),
    } }, "thread", turn);
    const delegated = mapCopilotEvent({ ...metadata, type: "subagent.started", data: {
      toolCallId, agentName: "explore", agentDisplayName: "Explorer", agentDescription: "Inspect the code",
    } }, "thread", turn);
    return { provisional, delegated };
  }

  it("routes child text and tools with evidence while keeping parent text intact", () => {
    const turn = turnState();
    const events = trace().flatMap((event) => mapCopilotEvent(event, "thread", turn));
    expect(events.filter((mapped) => mapped.event.type === "textDelta")).toEqual([
      { event: { type: "textDelta", threadId: "thread", delta: "REDACTED_CHILD_CONTENT" },
        childThread: { role: "child", path: ["TOOL_1"], nativeItemId: "MESSAGE_1", final: true } },
      { event: { type: "textDelta", threadId: "thread", delta: "REDACTED_CHILD_CONTENT" },
        childThread: { role: "child", path: ["TOOL_1"], nativeItemId: "MESSAGE_1" } },
      { event: { type: "textDelta", threadId: "thread", delta: "REDACTED_CONTENT" } },
    ]);
    expect(turn.assistantText).toEqual({ messageId: "MESSAGE_2", content: "REDACTED_CONTENT" });
    expect(turn.pendingAssistantMessage).toBeUndefined();
    expect(events.filter((mapped) => mapped.childThread?.role === "child" && mapped.event.type.startsWith("tool"))).toEqual([
      { event: { type: "toolUse", threadId: "thread", toolCallId: "TOOL_2", toolName: "read", toolInput: {} },
        childThread: { role: "child", path: ["TOOL_1"] } },
      { event: { type: "toolResult", threadId: "thread", toolCallId: "TOOL_2", output: "REDACTED_TOOL_OUTPUT", isError: false },
        childThread: { role: "child", path: ["TOOL_1"] } },
    ]);
    expect(events.some((mapped) => "parentToolCallId" in mapped.event)).toBe(false);
    for (const mapped of events) {
      const runtime = providerRuntimeEvent(mapped.event, mapped.childThread
        ? { providerId: "copilot", kind: "child-thread", childThread: mapped.childThread } : undefined);
      expect(ProviderRuntimeEventSchema().parse(runtime)).toEqual(runtime);
    }
  });

  it("drops an empty child message containing only tool requests", () => {
    const turn = turnState();
    start(turn, "T1");
    expect(mapCopilotEvent({ ...metadata, type: "assistant.message", data: {
      messageId: "M", content: "", parentToolCallId: "T1",
      toolRequests: [{ toolCallId: "read", name: "Read", arguments: {} }],
    } }, "thread", turn)).toEqual([]);
  });

  it("drops child thinking messages", () => {
    const turn = turnState();
    start(turn, "T1");
    const message: SessionEvent = { ...metadata, type: "assistant.message", data: {
      messageId: "M", content: "Private reasoning", parentToolCallId: "T1", phase: "thinking",
    } };
    expect(mapCopilotEvent(message, "thread", turn)).toEqual([]);
  });

  it("keeps two interleaved children separate from each other and the parent", () => {
    const turn = turnState();
    start(turn, "T1");
    start(turn, "T2");
    const events = [
      mapCopilotEvent({ ...metadata, type: "assistant.message_delta", ephemeral: true, data: {
        messageId: "M1", deltaContent: "First", parentToolCallId: "T1",
      } }, "thread", turn),
      mapCopilotEvent({ ...metadata, type: "assistant.message_delta", ephemeral: true, data: {
        messageId: "P", deltaContent: "Parent",
      } }, "thread", turn),
      mapCopilotEvent({ ...metadata, type: "tool.execution_start", data: {
        toolCallId: "read", toolName: "Read", arguments: {}, parentToolCallId: "T2",
      } }, "thread", turn),
      mapCopilotEvent({ ...metadata, type: "assistant.message_delta", ephemeral: true, data: {
        messageId: "M2", deltaContent: "Second", parentToolCallId: "T2",
      } }, "thread", turn),
    ].flat();
    expect(events.map((mapped) => mapped.childThread?.path ?? [])).toEqual([["T1"], [], ["T2"], ["T2"]]);
    expect(events.filter((mapped) => !mapped.childThread).map((mapped) => mapped.event)).toEqual([
      { type: "textDelta", threadId: "thread", delta: "Parent" },
    ]);
    expect(turn.assistantText).toEqual({ messageId: "P", content: "Parent" });
  });

  it.each([["Inspect parser", "Inspect parser"], [undefined, "Explorer"]])(
    "uses agentDescription for the prompt and %s for the title", (description, title) => {
      const turn = turnState();
      const result = start(turn, "T1", undefined, { ...(description ? { description } : {}), prompt: "Stale task prompt" });
      expect(result.provisional[0]?.event).toMatchObject({ toolInput: description ? { description } : {} });
      expect(JSON.stringify(result.provisional)).not.toContain("Stale task prompt");
      expect(result.delegated).toMatchObject([{ event: { type: "toolUse", toolName: "Agent",
        toolInput: { description: title, prompt: "Inspect the code", subagentType: "explore" } },
        childThread: { role: "delegate", path: ["T1"], prompt: "Inspect the code", title, agentType: "explore" } }]);
    },
  );

  it("closes completed children and preserves failure after a successful task result", () => {
    const completedTurn = turnState();
    const complete = trace().flatMap((event) => mapCopilotEvent(event, "thread", completedTurn));
    expect(complete.filter((mapped) => mapped.event.type === "turnComplete")).toMatchObject([
      { event: { type: "turnComplete" }, childThread: { role: "child", path: ["TOOL_1"] } },
    ]);
    const turn = turnState();
    const events = trace(true, false).flatMap((event) => mapCopilotEvent(event, "thread", turn));
    expect(events.filter((mapped) => mapped.event.type === "error")).toMatchObject([
      { event: { error: "REDACTED_CONTENT", failure: { kind: "fatal" } }, childThread: { role: "child", path: ["TOOL_1"] } },
    ]);
    expect(events.filter((mapped) => mapped.event.type === "turnComplete")).toEqual([]);
    expect(events.filter((mapped) => mapped.event.type === "toolResult" && mapped.event.toolCallId === "TOOL_1")).toEqual([
      { event: { type: "toolResult", threadId: "thread", toolCallId: "TOOL_1", output: "REDACTED_CONTENT", isError: true } },
      { event: { type: "toolResult", threadId: "thread", toolCallId: "TOOL_1", output: "REDACTED_TOOL_OUTPUT", isError: true } },
    ]);
    expect(closeOpenChildren(turn, "thread", "interrupted")).toEqual([]);
  });

  it("routes a late tool result using retained invocation ancestry", () => {
    const turn = turnState();
    start(turn, "T1");
    mapCopilotEvent({ ...metadata, type: "tool.execution_start", data: {
      toolCallId: "read", toolName: "Read", arguments: {}, parentToolCallId: "T1",
    } }, "thread", turn);
    mapCopilotEvent({ ...metadata, type: "subagent.completed", data: {
      toolCallId: "T1", agentName: "explore", agentDisplayName: "Explorer",
    } }, "thread", turn);
    expect(mapCopilotEvent({ ...metadata, type: "tool.execution_complete", data: {
      toolCallId: "read", success: true, result: { content: "Late" },
    } }, "thread", turn)).toEqual([{ event: { type: "toolResult", threadId: "thread", toolCallId: "read", output: "Late", isError: false },
      childThread: { role: "child", path: ["T1"] } }]);
  });

  it.each(["interrupted", "cancelled", "errored"] as const)("closes only open children once with %s", (outcome) => {
    const turn = turnState();
    start(turn, "T1");
    start(turn, "T2");
    mapCopilotEvent({ ...metadata, type: "subagent.completed", data: {
      toolCallId: "T1", agentName: "explore", agentDisplayName: "Explorer",
    } }, "thread", turn);
    expect(closeOpenChildren(turn, "thread", outcome)).toEqual([{ event: {
      type: "ended", threadId: "thread", turnExecutionId: turn.turnExecutionId, outcome,
    }, childThread: { role: "child", path: ["T2"] } }]);
    expect(closeOpenChildren(turn, "thread", outcome)).toEqual([]);
  });

  it("builds nested paths and drops missing or cyclic ancestry instead of publishing at the root", () => {
    const turn = turnState();
    start(turn, "T1");
    const nested = start(turn, "T2", "T1");
    expect(nested.provisional[0]?.childThread).toEqual({ role: "child", path: ["T1"] });
    expect(nested.delegated[0]?.childThread).toMatchObject({ role: "delegate", path: ["T1", "T2"] });
    const message: SessionEvent = { ...metadata, type: "assistant.message", data: {
      messageId: "M", content: "Grandchild", parentToolCallId: "T2",
    } };
    expect(mapCopilotEvent(message, "thread", turn)[0]?.childThread).toEqual({
      role: "child", path: ["T1", "T2"], nativeItemId: "M", final: true,
    });
    turn.invocations.set("T1", { parentToolCallId: "T2", state: "open" });
    expect(mapCopilotEvent(message, "thread", turn)).toEqual([]);
    turn.invocations.delete("T1");
    expect(mapCopilotEvent(message, "thread", turn)).toEqual([]);
    expect(turn.assistantText).toBeUndefined();
  });
});

describe("Copilot reasoning mapping", () => {
  const at = (index: number) => ({ id: `EVENT_${index}`, parentId: null, timestamp: "2000-01-01T00:00:00.000Z" });
  function map(turn: CopilotTurnState, events: SessionEvent[]) {
    return events.flatMap((event) => parentEvents(event, "thread", turn));
  }

  it("streams reasoning deltas and closes the block with an empty done delta when the final text matches", () => {
    expect(map(turnState(), [
      { ...at(0), type: "assistant.reasoning_delta", ephemeral: true, data: { reasoningId: "R1", deltaContent: "Check " } },
      { ...at(1), type: "assistant.reasoning_delta", ephemeral: true, data: { reasoningId: "R1", deltaContent: "the parser" } },
      { ...at(2), type: "assistant.reasoning", data: { reasoningId: "R1", content: "Check the parser" } },
    ])).toEqual([
      { type: "reasoningDelta", threadId: "thread", delta: "Check ", reasoningItemId: "R1" },
      { type: "reasoningDelta", threadId: "thread", delta: "the parser", reasoningItemId: "R1" },
      { type: "reasoningDelta", threadId: "thread", delta: "", reasoningItemId: "R1", done: true },
    ]);
  });

  it("emits the full block on a final reasoning event without prior deltas", () => {
    expect(map(turnState(), [{ ...at(3), type: "assistant.reasoning", data: { reasoningId: "R1", content: "Check the parser" } }])).toEqual([
      { type: "reasoningDelta", threadId: "thread", delta: "Check the parser", reasoningItemId: "R1", done: true },
    ]);
  });

  it("maps a thinking-phase message to a closed reasoning block instead of answer text", () => {
    const turn = turnState();
    expect(map(turn, [{ ...at(4), type: "assistant.message", data: { messageId: "MESSAGE_1", content: "Plan the edit", phase: "thinking" } }])).toEqual([
      { type: "reasoningDelta", threadId: "thread", delta: "Plan the edit", reasoningItemId: "MESSAGE_1", done: true },
    ]);
    expect(turn.pendingAssistantMessage).toBeUndefined();
  });

  it("does not repeat a thinking-phase message whose text already streamed as answer text", () => {
    expect(map(turnState(), [
      { ...at(5), type: "assistant.message_delta", ephemeral: true, data: { messageId: "MESSAGE_1", deltaContent: "Plan" } },
      { ...at(6), type: "assistant.message", data: { messageId: "MESSAGE_1", content: "Plan", phase: "thinking" } },
    ])).toEqual([{ type: "textDelta", threadId: "thread", delta: "Plan" }]);
  });

  it("keeps answer text events unchanged when reasoning interleaves with them", () => {
    expect(map(turnState(), [
      { ...at(7), type: "assistant.reasoning_delta", ephemeral: true, data: { reasoningId: "R1", deltaContent: "Think" } },
      { ...at(8), type: "assistant.message_delta", ephemeral: true, data: { messageId: "MESSAGE_1", deltaContent: "Hello " } },
      { ...at(9), type: "assistant.reasoning", data: { reasoningId: "R1", content: "Think more" } },
      { ...at(10), type: "assistant.message_delta", ephemeral: true, data: { messageId: "MESSAGE_1", deltaContent: "world" } },
      { ...at(11), type: "assistant.message", data: { messageId: "MESSAGE_1", content: "Hello world" } },
    ])).toEqual([
      { type: "reasoningDelta", threadId: "thread", delta: "Think", reasoningItemId: "R1" },
      { type: "textDelta", threadId: "thread", delta: "Hello " },
      { type: "reasoningDelta", threadId: "thread", delta: " more", reasoningItemId: "R1", done: true },
      { type: "textDelta", threadId: "thread", delta: "world" },
    ]);
  });

  it("splits reasoning longer than the contract bound across deltas", () => {
    const content = "a".repeat(65_537);
    expect(map(turnState(), [{ ...at(12), type: "assistant.reasoning", data: { reasoningId: "R1", content } }])).toEqual([
      { type: "reasoningDelta", threadId: "thread", delta: "a".repeat(65_536), reasoningItemId: "R1" },
      { type: "reasoningDelta", threadId: "thread", delta: "a", reasoningItemId: "R1", done: true },
    ]);
  });
});
