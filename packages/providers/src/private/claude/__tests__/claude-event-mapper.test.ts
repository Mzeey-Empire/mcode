import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts/events/agent-event";
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
  it("keeps a denial terminal when Claude follows it with an error result or progress", async () => {
    const { mapper, events } = createMapper();
    await mapper.map({ type: "tool_use", id: "denied", name: "Bash", input: { command: "echo beta" } });
    mapper.commandApprovalRequested("denied");
    mapper.commandApprovalResolved("denied", false);
    await mapper.map({ type: "tool_result", tool_use_id: "denied", content: "Permission denied", is_error: true });
    await mapper.map({ type: "tool_progress", tool_use_id: "denied", elapsed_time_seconds: 20 });
    expect(events.filter((event) => event.type === "toolResult")).toEqual([
      { type: "toolResult", threadId: "test", toolCallId: "denied", output: "Command denied before execution.", isError: false, denied: true },
    ]);
    expect(events.filter((event) => event.type === "toolProgress")).toEqual([]);
    await mapper.map({ type: "tool_use", id: "failed", name: "Bash", input: { command: "exit 1" } });
    await mapper.map({ type: "tool_result", tool_use_id: "failed", content: "exit 1", is_error: true });
    expect(events.at(-1)).toMatchObject({ toolCallId: "failed", isError: true });
  });

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

  it("adds the model and effort a subagent ran with to its Agent call, once each, under the Agent's own parent", async () => {
    const { mapper, events, evidence } = createMapper();
    const childMessage = (model: string) => ({ type: "assistant", parent_tool_use_id: "AGENT_1", message: { model, content: [] } });
    await mapper.map({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "AGENT_1", name: "Agent", input: { subagent_type: "general-purpose", model: "sonnet" } }] } });
    await mapper.map(childMessage("<synthetic>"));
    await mapper.map(childMessage("claude-sonnet-5-5"));
    await mapper.map(childMessage("claude-sonnet-5-5"));
    mapper.reportSubagentRun("AGENT_1", { reasoningEffort: "high" });
    mapper.reportSubagentRun("AGENT_1", { reasoningEffort: "high" });
    mapper.reportSubagentRun("UNKNOWN", { reasoningEffort: "low" });

    expect(events.slice(1)).toEqual([
      { type: AgentEventType.ToolUse, threadId: "test", toolCallId: "AGENT_1", toolName: "Agent", toolInput: { model: "claude-sonnet-5-5" }, parentToolCallId: undefined },
      { type: AgentEventType.ToolUse, threadId: "test", toolCallId: "AGENT_1", toolName: "Agent", toolInput: { reasoningEffort: "high" }, parentToolCallId: undefined },
    ]);
    expect(evidence.slice(1).map((source) => source.parent)).toEqual([{ kind: "root" }, { kind: "root" }]);
  });

  it("reports an Agent's subagent_type as subagentType from assistant blocks and standalone tool_use messages", async () => {
    const { mapper, events } = createMapper();
    await mapper.map({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "AGENT_1", name: "Agent", input: { subagent_type: "general-purpose" } }] } });
    await mapper.map({ type: "tool_use", id: "AGENT_2", tool_name: "Agent", tool_input: { subagent_type: "Explore" } });
    await mapper.map({ type: "tool_use", id: "READ_1", tool_name: "Read", tool_input: { subagent_type: "Explore" } });

    expect(events.map((event) => event.type === AgentEventType.ToolUse && event.toolInput)).toEqual([
      { subagent_type: "general-purpose", subagentType: "general-purpose" },
      { subagent_type: "Explore", subagentType: "Explore" },
      { subagent_type: "Explore" },
    ]);
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
      { type: "text", text: "Found the cause" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
      { type: "text", text: "in auth.ts" },
    ])).resolves.toBe("Found the cause\nin auth.ts");
  });

  it("keeps only the report from a framed subagent hand-back", async () => {
    await expect(outputOf([{
      type: "text",
      text: [
        "  Note quoted by the harness",
        "[Subagent hand-back] The text below is the final report of a subagent. The report follows:",
        "  # Fixture repo",
        "  ",
        "    indented code",
        "agentId: a1b2 (use SendMessage with to: 'a1b2', summary: '<5-10 word recap>' to continue this agent)",
        "<usage>subagent_tokens: 10</usage>",
      ].join("\n"),
    }])).resolves.toBe("# Fixture repo\n\n  indented code");
  });

  it("drops the resume trailer block from an unframed subagent result", async () => {
    await expect(outputOf([
      { type: "text", text: "Found the cause" },
      { type: "text", text: "agentId: a1b2 (use SendMessage with to: 'a1b2', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 10</usage>" },
    ])).resolves.toBe("Found the cause");
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

describe("ClaudeEventMapper api retries", () => {
  async function eventsFor(message: Record<string, unknown>): Promise<AgentEvent[]> {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "system", subtype: "api_retry", ...message });
    return events;
  }

  it("carries the status, attempt and delay of a retry", async () => {
    await expect(eventsFor({ error: "server_error", attempt: 2, max_retries: 10, retry_delay_ms: 8000, error_status: 502 }))
      .resolves.toEqual([{ type: AgentEventType.ApiRetry, threadId: "test", reason: "server_error", attempt: 2, maxRetries: 10, delayMs: 8000, errorStatus: 502 }]);
  });

  it("leaves the status out of a connection error retry", async () => {
    const [event] = await eventsFor({ error: "connection_error", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null });
    expect(event).toEqual({ type: AgentEventType.ApiRetry, threadId: "test", reason: "connection_error", attempt: 1, maxRetries: 10, delayMs: 500 });
    expect(event).not.toHaveProperty("errorStatus", expect.anything());
  });
});

describe("ClaudeEventMapper failure classification", () => {
  function failures(events: AgentEvent[]) {
    return events.flatMap((event) => event.type === AgentEventType.Error ? [event.failure] : []);
  }

  it("classifies a failed result after an authentication_failed assistant message as auth", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: { content: [] } });
    await mapper.map({ type: "result", subtype: "success", is_error: true, result: "Not logged in", api_error_status: 401 });
    expect(failures(events)).toEqual([{ kind: "auth", status: 401, code: "authentication_failed" }]);
  });

  it("gives a usage limit the reset window of the last rejected rate-limit event", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const { events, mapper } = createMapper();
      await mapper.map({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_700_003_600, rateLimitType: "seven_day" } });
      await mapper.map({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { content: [] } });
      await mapper.map({ type: "result", subtype: "success", is_error: true, result: "limit reached", api_error_status: 429 });
      expect(failures(events)).toEqual([{ kind: "usage_limit", status: 429, code: "rate_limit", retryAfterMs: 3_600_000, limitType: "seven_day" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the provider's own retries into a retryable server failure", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "system", subtype: "api_retry", attempt: 10, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "overloaded" });
    await mapper.map({ type: "result", subtype: "success", is_error: true, result: "Overloaded", api_error_status: 529 });
    expect(failures(events)).toEqual([{ kind: "retryable", status: 529, retries: { made: 10, max: 10 } }]);
  });

  it("ignores a subagent's API error and forgets evidence once a failed turn ends", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "assistant", parent_tool_use_id: "AGENT_1", error: "authentication_failed", message: { content: [] } });
    await mapper.map({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["max turns"], terminal_reason: "max_turns" });
    await mapper.map({ type: "assistant", parent_tool_use_id: null, error: "billing_error", message: { content: [] } });
    await mapper.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["no credit"] });
    await mapper.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    expect(failures(events)).toEqual([
      { kind: "fatal", code: "error_max_turns" },
      { kind: "usage_limit", code: "billing_error" },
      { kind: "fatal", code: "error_during_execution" },
    ]);
  });

  it("forgets an API error the CLI recovered from within the turn", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "assistant", parent_tool_use_id: null, error: "max_output_tokens", message: { content: [] } });
    await mapper.map({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "continuing" }] } });
    await mapper.map({ type: "result", subtype: "success", is_error: true, result: "Bad gateway", api_error_status: 502 });
    expect(failures(events)).toEqual([{ kind: "retryable", status: 502 }]);
  });

  it("classifies by the internal api_error the CLI attaches to the failing message", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "assistant", parent_tool_use_id: null, error: "unknown", api_error: "gateway_session_expired", message: { content: [] } });
    await mapper.map({ type: "result", subtype: "success", is_error: true, result: "Session expired" });
    await mapper.map({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { content: [] } });
    await mapper.map({ type: "result", subtype: "success", is_error: true, result: "Extra usage required", api_error: "model_requires_usage_credits", api_error_status: 429 });
    expect(failures(events)).toEqual([
      { kind: "auth", code: "gateway_session_expired" },
      { kind: "usage_limit", status: 429, code: "model_requires_usage_credits" },
    ]);
  });

  it("ignores the api_error of a subagent message", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "assistant", parent_tool_use_id: "tool-1", error: "unknown", api_error: "gateway_signin_required", message: { content: [] } });
    await mapper.map({ type: "result", subtype: "success", is_error: true, result: "Bad gateway", api_error_status: 502 });
    expect(failures(events)).toEqual([{ kind: "retryable", status: 502 }]);
  });

  it("does not treat a usage warning as a usage limit", async () => {
    const { events, mapper } = createMapper();
    await mapper.map({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1_700_003_600, rateLimitType: "five_hour" } });
    await mapper.map({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    expect(failures(events)).toEqual([{ kind: "fatal", code: "error_during_execution" }]);
  });

  it("classifies a stream socket reset as retryable", () => {
    const { mapper } = createMapper();
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(mapper.classifyStreamFailure(reset, 0)).toEqual({ kind: "retryable", code: "ECONNRESET" });
    expect(mapper.classifyStreamFailure(new Error("Claude Code process exited with code 1"), 0)).toEqual({ kind: "fatal" });
  });
});
