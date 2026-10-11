import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { AgentEventSchema } from "@mcode/contracts";
import { parseCopilotCapturedTrace } from "../../../conformance/copilot-trace.js";
import { mapCopilotEvent, type CopilotTurnState } from "../copilot-event-mapper.js";

function turnState(): CopilotTurnState {
  return { nativeIdleObserved: false, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
    tools: new Map(), pendingPermissions: new Map(), completed: Promise.resolve(), settle: () => {} };
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
    const events = mapCopilotEvent({ id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z",
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
      expect(mapCopilotEvent(event, "thread", turnState())).toEqual([
        { type: "error", threadId: "thread", error: "Native failure", failure: { kind: "fatal", code: "query" } },
      ]);
    },
  );

  it.each([undefined, null, 42, {}, " ", "x".repeat(129)])("omits a malformed native error code %s", (errorType) => {
    const event: SessionEvent = { id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z",
      type: "session.error", data: { errorType: "query", statusCode: 503, message: "Native failure" } };
    Object.assign(event.data, { errorType });
    expect(mapCopilotEvent(event, "thread", turnState())).toEqual([
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
  it("enriches one Agent call and keeps child tools nested without leaking child text", () => {
    const turn = turnState();
    const events = trace().flatMap((event) => mapCopilotEvent(event, "thread", turn));
    const agents = events.filter((event) => event.type === "toolUse" && event.toolName === "Agent");
    expect(agents.map((event) => event.toolCallId)).toEqual(["TOOL_1", "TOOL_1"]);
    expect(agents[1]).toMatchObject({ toolInput: { description: "REDACTED_CONTENT", prompt: "PROMPT_1", subagentType: "AGENT_1" },
      subagentPresentation: { task: "REDACTED_CONTENT", displayName: "AGENT 1", identityKey: "TOOL_1", detail: { kind: "transcript-unavailable" } } });
    expect(events.filter((event) => "parentToolCallId" in event && event.parentToolCallId)).toEqual([
      { type: "toolUse", threadId: "thread", toolCallId: "TOOL_2", toolName: "read", toolInput: {}, parentToolCallId: "TOOL_1" },
      { type: "toolProgress", threadId: "thread", toolCallId: "TOOL_2", toolName: "read", elapsedSeconds: 1, parentToolCallId: "TOOL_1" },
      { type: "toolResult", threadId: "thread", toolCallId: "TOOL_2", output: "REDACTED_TOOL_OUTPUT", isError: false, parentToolCallId: "TOOL_1" },
    ]);
    expect(events.filter((event) => event.type === "toolResult" && event.toolCallId === "TOOL_1")).toEqual([
      { type: "toolResult", threadId: "thread", toolCallId: "TOOL_1", output: "REDACTED_TOOL_OUTPUT", isError: false },
    ]);
    expect(events.filter((event) => event.type === "textDelta")).toEqual([{ type: "textDelta", threadId: "thread", delta: "REDACTED_CONTENT" }]);
  });

  it("preserves the task prompt instead of replacing it with the agent description", () => {
    const turn = turnState();
    const metadata = { id: "EVENT_1", parentId: null, timestamp: "2000-01-01T00:00:00.000Z" };
    mapCopilotEvent({ ...metadata, type: "tool.execution_start", data: {
      toolCallId: "TOOL_1", toolName: "task", arguments: { prompt: "Inspect the parser" },
    } }, "thread", turn);
    const events = mapCopilotEvent({ ...metadata, id: "EVENT_2", type: "subagent.started", data: {
      toolCallId: "TOOL_1", agentName: "explore", agentDisplayName: "Explorer", agentDescription: "Explores code",
    } }, "thread", turn);
    expect(events).toMatchObject([{ type: "toolUse", toolName: "Agent", toolInput: { prompt: "Inspect the parser" } }]);
  });

  it("retains failure even when the enclosing task completes successfully and falls back to the display name", () => {
    const turn = turnState();
    const events = trace(true, false).flatMap((event) => mapCopilotEvent(event, "thread", turn));
    expect(events.filter((event) => event.type === "toolUse" && event.toolName === "Agent")[1]).toMatchObject({
      subagentPresentation: { task: "AGENT_2" }, toolInput: { prompt: "PROMPT_1", subagentType: "AGENT_1" },
    });
    expect(events.filter((event) => event.type === "toolResult" && event.toolCallId === "TOOL_1")).toEqual([
      { type: "toolResult", threadId: "thread", toolCallId: "TOOL_1", output: "REDACTED_CONTENT", isError: true },
      { type: "toolResult", threadId: "thread", toolCallId: "TOOL_1", output: "REDACTED_TOOL_OUTPUT", isError: true },
    ]);
  });
});

describe("Copilot reasoning mapping", () => {
  const at = (index: number) => ({ id: `EVENT_${index}`, parentId: null, timestamp: "2000-01-01T00:00:00.000Z" });
  function map(turn: CopilotTurnState, events: SessionEvent[]) {
    return events.flatMap((event) => mapCopilotEvent(event, "thread", turn));
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
