import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import {
  ClaudeEventMapper,
  type ClaudeEventEvidence,
  type ClaudeEventMapperCallbacks,
} from "../claude-event-mapper.js";

function createMapper(captureSdkSessionId = vi.fn(() => true)) {
  const events: AgentEvent[] = [];
  const evidence: ClaudeEventEvidence[] = [];
  const callbacks: ClaudeEventMapperCallbacks = {
    emit: (event, source) => { events.push(event); evidence.push(source); },
    getSession: () => undefined,
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
  };
  return {
    events,
    evidence,
    captureSdkSessionId,
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
