import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import {
  ClaudeEventMapper,
  type ClaudeEventEvidence,
  type ClaudeEventMapperCallbacks,
  type ClaudeMappedSession,
} from "../claude-event-mapper.js";

function createMapper(captureSdkSessionId = vi.fn(() => true)) {
  const events: AgentEvent[] = [];
  const evidence: ClaudeEventEvidence[] = [];
  const callbacks: ClaudeEventMapperCallbacks = {
    emit: (event, source) => { events.push(event); evidence.push(source); },
    getSession: vi.fn((): ClaudeMappedSession | undefined => undefined),
    captureSdkSessionId,
    observeNativeGoalCommands: vi.fn(),
    applyNativeGoalCommandResult: vi.fn(),
    invalidateSdkSession: vi.fn(),
    markSessionPoisoned: vi.fn(),
    updateUsage: vi.fn(() => ({})),
    invalidateUsage: vi.fn(),
    resolveBillingMode: vi.fn(async () => "unknown"),
    isSessionStartHookSuppressed: vi.fn(() => false),
    clearSessionStartHookSuppression: vi.fn(),
    liveExecutionId: vi.fn((): string | undefined => "EXECUTION_1"),
    settleBackgroundTool: vi.fn(),
  };
  return {
    events,
    evidence,
    captureSdkSessionId,
    callbacks,
    mapper: new ClaudeEventMapper("mcode-test", "test", callbacks),
  };
}

describe("ClaudeEventMapper native dispatch", () => {
  it("captures first-init session metadata with its own root and replay identity", () => {
    const { mapper, evidence } = createMapper();
    mapper.captureSessionIdentity({ type: "system", subtype: "init", session_id: "SESSION_1", parent_tool_use_id: null, uuid: "INIT_1" }, true);
    expect(evidence).toEqual([{ parent: { kind: "root" }, sourceIdentities: [], nativeEventId: "INIT_1" }]);
  });

  it("does not reuse a previous envelope's parent or replay identity for session metadata", async () => {
    const { mapper, evidence } = createMapper();
    await mapper.map({ type: "system", subtype: "fixture", parent_tool_use_id: "PARENT_1", uuid: "PREVIOUS_1" });
    mapper.captureSessionIdentity({ type: "system", subtype: "init", session_id: "SESSION_1", uuid: "INIT_1" }, true);
    expect(evidence.at(-1)).toEqual({ parent: { kind: "absent" }, sourceIdentities: [], nativeEventId: "INIT_1" });
  });

  it("rejects conflicting native parents until the execution evidence is reset", async () => {
    const { mapper, evidence } = createMapper();
    const message = { type: "assistant", parent_tool_use_id: "PARENT_1", message: { content: [{ type: "tool_use", id: "TOOL_1", name: "Read", input: {} }] } };
    await mapper.map(message);
    await expect(mapper.map({ ...message, parent_tool_use_id: "PARENT_2" })).rejects.toThrow("Conflicting Claude native parent");
    await expect(mapper.map({ ...message, parent_tool_use_id: " " })).rejects.toThrow("Invalid Claude native parent");
    mapper.resetExecution();
    await mapper.map({ ...message, parent_tool_use_id: "PARENT_2" });
    expect(evidence.at(-1)?.parent).toEqual({ kind: "native", id: "PARENT_2" });
  });

  it.each(["__proto__", "constructor", "toString"])(
    "ignores unsafe native type %s",
    async (type) => {
      const { events, mapper } = createMapper();

      await expect(mapper.map({ type })).resolves.toBe("none");

      expect(events).toEqual([]);
    },
  );

  it.each(["__proto__", "constructor", "toString"])(
    "treats unsafe system subtype %s as an unknown native event",
    async (subtype) => {
      const { events, mapper } = createMapper();

      await expect(mapper.map({ type: "system", subtype })).resolves.toBe(
        "none",
      );

      expect(events).toEqual([
        {
          type: AgentEventType.System,
          threadId: "test",
          subtype,
        },
      ]);
    },
  );

  it("rejects a whitespace SDK session identity", () => {
    const { events, captureSdkSessionId, mapper } = createMapper();

    mapper.captureSessionIdentity({ type: "system", session_id: " \t " }, true);

    expect(captureSdkSessionId).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("ends a successful result with turnComplete so the writer accepts every event", async () => {
    const { events, mapper } = createMapper();

    await expect(mapper.map({ type: "result", is_error: false, result: "pong", usage: { output_tokens: 1 } }))
      .resolves.toBe("turn_complete");

    expect(events.map((event) => event.type)).toEqual([AgentEventType.QuotaUpdate, AgentEventType.TurnComplete]);
  });
});

describe("ClaudeEventMapper tool results", () => {
  async function outputOf(content: unknown): Promise<unknown> {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "TOOL_1", content }] } });
    const result = events.find((event) => event.type === AgentEventType.ToolResult);
    return result && "output" in result ? result.output : undefined;
  }

  it("keeps string results unchanged", async () => {
    await expect(outputOf("plain output")).resolves.toBe("plain output");
  });

  it("joins text blocks instead of storing their JSON", async () => {
    await expect(outputOf([
      { type: "text", text: "[Subagent hand-back] Found the cause" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
      { type: "text", text: "in auth.ts" },
    ])).resolves.toBe("[Subagent hand-back] Found the cause\nin auth.ts");
  });

  it("falls back to JSON when no block carries text", async () => {
    const blocks = [{ type: "image", source: { type: "base64", data: "AAAA" } }];
    await expect(outputOf(blocks)).resolves.toBe(JSON.stringify(blocks));
  });
});

describe("ClaudeEventMapper user interrupts", () => {
  async function eventsAfterResult(content: string, isError: boolean): Promise<AgentEvent[]> {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "assistant", message: { content: [
      { type: "tool_use", id: "AGENT_1", name: "Agent", input: { description: "Survey repo" } },
    ] } });
    await mapper.map({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "AGENT_1", content, is_error: isError },
    ] } });
    return events;
  }

  it("leaves an Agent call running when a user interrupt ends it", async () => {
    await expect(eventsAfterResult("[Request interrupted by user for tool use]", true)).resolves.toEqual([
      {
        type: AgentEventType.ToolUse,
        threadId: "test",
        toolCallId: "AGENT_1",
        toolName: "Agent",
        toolInput: { description: "Survey repo" },
        parentToolCallId: undefined,
      },
    ]);
  });

  it("still reports a real Agent failure", async () => {
    const events = await eventsAfterResult("Subagent crashed", true);
    expect(events.at(-1)).toEqual({
      type: AgentEventType.ToolResult,
      threadId: "test",
      toolCallId: "AGENT_1",
      output: "Subagent crashed",
      isError: true,
    });
  });

  it("keeps a successful result that quotes the interrupt text", async () => {
    const events = await eventsAfterResult("[Request interrupted by user]", false);
    expect(events.at(-1)).toEqual({
      type: AgentEventType.ToolResult,
      threadId: "test",
      toolCallId: "AGENT_1",
      output: "[Request interrupted by user]",
      isError: false,
    });
  });
});

describe("ClaudeEventMapper background tools", () => {
  const launch = (id: string) => ({
    type: "user",
    tool_use_result: { status: "async_launched", isAsync: true, agentId: `agent-${id}` },
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched successfully." }] },
  });
  const notification = (id: string, status: string) =>
    ({ type: "system", subtype: "task_notification", tool_use_id: id, task_id: `task-${id}`, status, summary: `${id} ${status}` });

  async function launched(ids: readonly string[]) {
    const harness = createMapper();
    const pendingToolUses = new Set<string>();
    vi.mocked(harness.callbacks.getSession).mockReturnValue({ model: "sonnet", contextWindowMode: undefined, pendingToolUses, hasFiredToolThisTurn: false });
    for (const id of ids) {
      await harness.mapper.map({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: {} }] } });
      await harness.mapper.map(launch(id));
    }
    return { ...harness, pendingToolUses };
  }

  it("holds an async launch open instead of completing it", async () => {
    const { events, pendingToolUses } = await launched(["AGENT_1"]);
    expect(events.map((event) => event.type)).toEqual([AgentEventType.ToolUse, AgentEventType.ToolBackgrounded]);
    expect(pendingToolUses.size).toBe(0);
  });

  it("settles a held call inside its own turn, even after the execution evidence resets", async () => {
    const { events, mapper, callbacks } = await launched(["AGENT_1"]);
    mapper.resetExecution();
    mapper.settleBackgroundTask(notification("AGENT_1", "completed"));
    mapper.settleBackgroundTask(notification("AGENT_1", "completed"));
    expect(events.at(-1)).toEqual({ type: AgentEventType.ToolResult, threadId: "test", toolCallId: "AGENT_1", output: "AGENT_1 completed", isError: false });
    expect(events.filter((event) => event.type === AgentEventType.ToolResult)).toHaveLength(1);
    expect(callbacks.settleBackgroundTool).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "cancelled"],
  ])("hands a %s task from an ended turn to the host as %s", async (sdkStatus, status) => {
    const { events, mapper, callbacks } = await launched(["AGENT_1"]);
    vi.mocked(callbacks.liveExecutionId).mockReturnValue(undefined);
    const before = events.length;
    mapper.settleBackgroundTask(notification("AGENT_1", sdkStatus));
    expect(callbacks.settleBackgroundTool).toHaveBeenCalledExactlyOnceWith(
      { executionId: "EXECUTION_1", toolCallId: "AGENT_1", status, output: `AGENT_1 ${sdkStatus}` });
    expect(events).toHaveLength(before);
  });

  it("ignores task notifications for calls it does not hold", async () => {
    const { events, mapper, callbacks } = await launched([]);
    mapper.settleBackgroundTask({ ...notification("BASH_1", "completed"), owned_by_subagent: true });
    expect(events).toEqual([]);
    expect(callbacks.settleBackgroundTool).not.toHaveBeenCalled();
  });

  it("completes an ordinary tool result even when the message names an async launch for several results", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ ...launch("AGENT_1"), message: { content: [
      { type: "tool_result", tool_use_id: "AGENT_1", content: "one" },
      { type: "tool_result", tool_use_id: "AGENT_2", content: "two" },
    ] } });
    expect(events.map((event) => event.type)).toEqual([AgentEventType.ToolResult, AgentEventType.ToolResult]);
  });

  it("stops every held call when the session ends, routing each to its own turn", async () => {
    const { events, mapper, callbacks } = await launched(["AGENT_1", "AGENT_2"]);
    vi.mocked(callbacks.liveExecutionId).mockReturnValue("EXECUTION_2");
    mapper.settleBackgroundTask(notification("AGENT_2", "completed"));
    vi.mocked(callbacks.settleBackgroundTool).mockClear();
    mapper.settleAllBackgroundTools();
    mapper.settleAllBackgroundTools();
    expect(callbacks.settleBackgroundTool).toHaveBeenCalledExactlyOnceWith(
      { executionId: "EXECUTION_1", toolCallId: "AGENT_1", status: "cancelled", output: "Stopped when the Claude session ended." });
    expect(events.filter((event) => event.type === AgentEventType.ToolResult)).toEqual([]);
  });
});

describe("ClaudeEventMapper rate limits", () => {
  async function eventsFor(rateLimitInfo: unknown): Promise<AgentEvent[]> {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "rate_limit_event", rate_limit_info: rateLimitInfo });
    return events;
  }

  it("reports a usage warning as not blocked", async () => {
    await expect(eventsFor({ status: "allowed_warning", resetsAt: 1_700_000_000, rateLimitType: "five_hour", utilization: 0.9 }))
      .resolves.toEqual([{ type: AgentEventType.RateLimited, threadId: "test", active: false }]);
  });

  it("reports a rejection as blocked with its retry window", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      await expect(eventsFor({ status: "rejected", resetsAt: 1_700_000_090, rateLimitType: "five_hour", utilization: 1 }))
        .resolves.toEqual([{ type: AgentEventType.RateLimited, threadId: "test", active: true, retryAfterMs: 90_000, limitType: "five_hour", utilization: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the block when requests are allowed", async () => {
    await expect(eventsFor({ status: "allowed" })).resolves.toEqual([{ type: AgentEventType.RateLimited, threadId: "test", active: false }]);
  });

  it.each([undefined, {}, { status: "constructor" }])("ignores an unknown status %j", async (info) => {
    await expect(eventsFor(info)).resolves.toEqual([]);
  });
});
