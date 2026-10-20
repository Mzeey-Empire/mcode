import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import { z } from "zod";
import type { AgentEvent } from "@mcode/contracts";
import { mapOpenCodeEnvelope, normalizeOpenCodeEnvelope, trackOpenCodePartType } from "../opencode-event-mapper.js";

const CTX = { threadId: "thread-1", turnExecutionId: "11111111-1111-4111-8111-111111111111" };
const capturedTraceSchema = z.object({ events: z.array(z.unknown()) });
const capturedToolPartSchema = z.object({ type: z.literal("tool"), sessionID: z.string() });
const capturedReasoningPartSchema = z.object({ type: z.literal("reasoning"), text: z.string() });

/** Map frames the way the provider does: one turn's part-type map and forwarded-text map. */
function replayWithPartTypes(frames: readonly unknown[]): AgentEvent[] {
  const partTypes = new Map<string, string>();
  const forwardedText = new Map<string, string>();
  return frames.flatMap((frame) => {
    const normalized = normalizeOpenCodeEnvelope(frame);
    const partType = normalized ? trackOpenCodePartType(partTypes, normalized) : undefined;
    return mapOpenCodeEnvelope(frame, { ...CTX, partType, forwardedText }).events;
  });
}

function partUpdated(part: Record<string, unknown>): unknown {
  return { type: "message.part.updated", properties: { sessionID: "ses_1", part: { sessionID: "ses_1", messageID: "msg_1", ...part } } };
}

function partDelta(partID: string, delta: string): unknown {
  return { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID, field: "text", delta } };
}

describe("mapOpenCodeEnvelope", () => {
  it("maps the captured task presentation, child reads, and result summary", () => {
    const fixture = capturedTraceSchema.parse(JSON.parse(NodeFS.readFileSync(new URL("./fixtures/task-subagent.captured.json", import.meta.url), "utf8")));
    const events = fixture.events.flatMap((frame) => {
      const normalized = normalizeOpenCodeEnvelope(frame);
      const part = capturedToolPartSchema.safeParse(normalized?.properties.part);
      if (!part.success) return [];
      return mapOpenCodeEnvelope(frame, { ...CTX, ...(part.data.sessionID === "ses_ed6efc38affeCX4FfwARNpGIYx"
        ? { parentToolCallId: "call_00_xr57hsrx9heom9avd50vi5bk" } : {}) }).events;
    });
    const agents = events.filter((event) => event.type === "toolUse" && event.toolName === "Agent");
    expect([...new Set(agents.map((event) => event.toolCallId))]).toEqual(["call_00_xr57hsrx9heom9avd50vi5bk"]);
    expect(agents.at(-1)).toMatchObject({ toolInput: { description: "Read math.js and README.md",
      prompt: "Read math.js and README.md with the read tool, then report the exported function name.", subagentType: "general", model: "big-pickle" },
      subagentPresentation: { task: "Read math.js and README.md", displayName: "General", model: "big-pickle" } });
    expect(events.filter((event) => event.type === "toolResult").map((event) => [event.toolCallId, event.parentToolCallId, event.isError])).toEqual([
      ["call_00_gklh7p1tknyzzv94mr7cglmz", "call_00_xr57hsrx9heom9avd50vi5bk", false],
      ["call_01_pnjs9yz5shlnirmegim4j9oa", "call_00_xr57hsrx9heom9avd50vi5bk", false],
      ["call_00_xr57hsrx9heom9avd50vi5bk", undefined, false],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "toolResult", output: "`add`", isError: false });
  });

  it.each([
    ["plain summary", "plain summary"],
    ["<task_result>\nwrapped summary\n</task_result>", "wrapped summary"],
    ["<task_result>\ntruncated summary\n", "truncated summary"],
  ])("extracts task output %s", (output, expectedSummary) => {
    const result = mapOpenCodeEnvelope({ type: "message.part.updated", properties: { part: {
      type: "tool", tool: "task", callID: "task", state: { status: "completed", output },
    } } }, CTX);
    expect(result.events).toEqual([{ ...CTX, type: "toolResult", toolCallId: "task", isError: false,
      output: expectedSummary }]);
  });

  it("maps the captured running todowrite part to the canonical task-list tool", () => {
    const out = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: {
        type: "tool", tool: "todowrite", callID: "call_01", id: "prt_1", messageID: "msg_1", sessionID: "ses_1",
        state: { status: "running", input: { todos: [
          { content: "create a.txt", status: "pending", priority: "medium" },
          { content: "create b.txt", status: "pending", priority: "medium" },
        ] }, time: { start: 1791678705254 } },
      } },
    }, CTX);
    expect(out.events).toEqual([{
      type: "toolUse", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      toolCallId: "call_01", toolName: "TodoWrite", toolInput: { todos: [
        { content: "create a.txt", status: "pending", priority: "medium" },
        { content: "create b.txt", status: "pending", priority: "medium" },
      ] },
    }]);
  });

  it("keeps the pending todowrite part's empty input", () => {
    const out = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: {
        type: "tool", tool: "todowrite", callID: "call_01", id: "prt_1", messageID: "msg_1", sessionID: "ses_1",
        state: { status: "pending", input: {} },
      } },
    }, CTX);
    expect(out.events).toEqual([{
      type: "toolUse", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      toolCallId: "call_01", toolName: "TodoWrite", toolInput: {},
    }]);
  });

  it("canonicalizes todowrite in session.next.tool.called", () => {
    const out = mapOpenCodeEnvelope({
      type: "session.next.tool.called",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", callID: "call_01", tool: "todowrite",
        input: { todos: [{ content: "create a.txt", status: "completed", priority: "medium" }] },
      },
    }, CTX);
    expect(out.events).toEqual([{
      type: "toolUse", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      toolCallId: "call_01", toolName: "TodoWrite",
      toolInput: { todos: [{ content: "create a.txt", status: "completed", priority: "medium" }] },
    }]);
  });

  it("ignores todo.updated snapshots to avoid duplicate task-list writes", () => {
    expect(mapOpenCodeEnvelope({
      type: "todo.updated",
      properties: { sessionID: "ses_1", todos: [
        { content: "create a.txt", status: "pending", priority: "medium" },
        { content: "create b.txt", status: "pending", priority: "medium" },
      ] },
    }, CTX)).toEqual({ disposition: "ignored", events: [], reason: "noise:todo.updated" });
  });

  it("preserves repeated delta text while deduplicating full snapshots", () => {
    const context = { ...CTX, forwardedText: new Map<string, string>() };
    const events = ["```", "`", "`"].flatMap((delta) => mapOpenCodeEnvelope({ type: "message.part.delta",
      properties: { messageID: "message", partID: "part", field: "text", delta } }, context).events);
    expect(events.map((event) => event.type === "textDelta" ? event.delta : null)).toEqual(["```", "`", "`"]);
    expect(mapOpenCodeEnvelope({ type: "message.part.updated", properties: {
      part: { type: "text", messageID: "message", id: "part", text: "`````" },
    } }, context).events).toEqual([]);
  });
  it("maps text deltas in both envelope shapes", () => {
    const flat = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "text", id: "p1" }, delta: "hello" },
    }, CTX);
    expect(flat.disposition).toBe("mapped");
    expect(flat.events[0]).toMatchObject({ type: "textDelta", delta: "hello" });

    const wrapped = mapOpenCodeEnvelope({
      type: "bus",
      payload: { type: "message.part.updated", properties: { part: { type: "text", id: "p1" }, delta: "hi" } },
    }, CTX);
    expect(wrapped.disposition).toBe("mapped");
    expect(wrapped.events[0]).toMatchObject({ type: "textDelta", delta: "hi" });
  });

  it("maps tool running then completed states", () => {
    const use = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "tool", callID: "c1", tool: "read", state: { status: "running", input: { path: "a" } } } },
    }, CTX);
    expect(use.events[0]).toMatchObject({ type: "toolUse", toolCallId: "c1", toolName: "read" });

    const result = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: {}, output: "ok", title: "t", metadata: {}, time: { start: 1, end: 2 } } } },
    }, CTX);
    expect(result.events[0]).toMatchObject({ type: "toolResult", toolCallId: "c1", isError: false });
  });

  it("marks session.idle as completion and unknown types as bounded diagnostics in both envelopes", () => {
    const idle = mapOpenCodeEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } }, CTX);
    expect(idle.disposition).toBe("mapped");
    expect(idle.events[0]).toMatchObject({ type: "turnComplete" });

    const unknown = mapOpenCodeEnvelope({ type: "session.frobnicate", properties: {} }, CTX);
    expect(unknown.disposition).toBe("diagnostic");
    expect(unknown.reason).toBe("unknown-event-type");
    expect(unknown.events).toEqual([]);

    const wrappedUnknown = mapOpenCodeEnvelope({
      type: "bus",
      payload: { type: "session.frobnicate", properties: {} },
    }, CTX);
    expect(wrappedUnknown.disposition).toBe("diagnostic");
    expect(wrappedUnknown.reason).toBe("unknown-event-type");
    expect(wrappedUnknown.events).toEqual([]);
  });

  it("ignores known noise with a reason and keeps lifecycle signals state-only", () => {
    expect(mapOpenCodeEnvelope({ type: "server.connected", properties: {} }, CTX).disposition).toBe("state-only");
    const noise = mapOpenCodeEnvelope({ type: "todo.updated", properties: {} }, CTX);
    expect(noise.disposition).toBe("ignored");
    expect(noise.reason).toBe("noise:todo.updated");
  });

  it("never turns user message parts into assistant deltas", () => {
    const userPart = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { type: "text", id: "p1", sessionID: "ses_1", messageID: "msg_user" },
        delta: "do the thing",
      },
    }, { ...CTX, partRole: "user" });
    expect(userPart.disposition).toBe("state-only");
    expect(userPart.events).toHaveLength(0);
  });

  it("maps standalone part deltas to text deltas", () => {
    const delta = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello" },
    }, CTX);
    expect(delta.disposition).toBe("mapped");
    expect(delta.events[0]).toMatchObject({ type: "textDelta", delta: "hello" });

    const userDelta = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_user", partID: "prt_9", field: "text", delta: "do the thing" },
    }, { ...CTX, partRole: "user" });
    expect(userDelta.disposition).toBe("state-only");

    const nonText = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "reasoning", delta: "hmm" },
    }, CTX);
    expect(nonText.disposition).toBe("state-only");
  });

  it("ignores plugin lifecycle noise", () => {
    const added = mapOpenCodeEnvelope({ type: "plugin.added", properties: { plugin: "opencode-pty" } }, CTX);
    expect(added.disposition).toBe("ignored");
    expect(added.reason).toBe("noise:plugin.added");
  });

  it("ignores catalog, reference, and integration lifecycle noise", () => {
    for (const type of ["catalog.updated", "reference.updated", "integration.updated"]) {
      const out = mapOpenCodeEnvelope({ type, properties: {} }, CTX);
      expect(out.disposition).toBe("ignored");
      expect(out.reason).toBe(`noise:${type}`);
    }
  });

  it("forwards each text slice exactly once across deltas and snapshots", () => {
    const forwarded = new Map<string, string>();
    const ctx = { ...CTX, forwardedText: forwarded };
    const delta = mapOpenCodeEnvelope({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "abcdef" },
    }, ctx);
    expect(delta.events[0]).toMatchObject({ type: "textDelta", delta: "abcdef" });
    const snapshot = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { type: "text", id: "prt_1", messageID: "msg_1", text: "abcdef" } },
    }, ctx);
    expect(snapshot.disposition).toBe("state-only");
    expect(snapshot.events).toHaveLength(0);
  });

  it("maps the session.next streaming family", () => {
    const text = mapOpenCodeEnvelope({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", textID: "txt_1", delta: "hi" },
    }, CTX);
    expect(text.events[0]).toMatchObject({ type: "textDelta", delta: "hi" });

    const called = mapOpenCodeEnvelope({
      type: "session.next.tool.called",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", callID: "c1", tool: "read", input: { path: "a" } },
    }, CTX);
    expect(called.events[0]).toMatchObject({ type: "toolUse", toolCallId: "c1" });

    const ended = mapOpenCodeEnvelope({
      type: "session.next.step.ended",
      properties: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "end_turn", cost: 0.01, tokens: { input: 10, output: 5 } },
    }, CTX);
    expect(ended.events[0]).toMatchObject({ type: "turnComplete", tokensIn: 10, tokensOut: 5 });

    const asked = mapOpenCodeEnvelope({
      type: "permission.v2.asked",
      properties: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["echo hi"] },
    }, CTX);
    expect(asked.disposition).toBe("mapped");
    expect(asked.events).toHaveLength(0);
    expect(asked.reason).toBe("permission-request");

    const question = mapOpenCodeEnvelope({
      type: "question.v2.asked",
      properties: { id: "que_1", sessionID: "ses_1", questions: [] },
    }, CTX);
    expect(question.disposition).toBe("mapped");
    expect(question.events).toHaveLength(0);
    expect(question.reason).toBe("question-request");
  });

  it("rejects oversized envelopes with one bounded diagnostic", () => {
    const big = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { type: "text", id: "p1" }, delta: "x".repeat(300_000) },
    }, CTX);
    expect(big.disposition).toBe("diagnostic");
    expect(big.reason).toBe("oversized-envelope");
    expect(big.events).toHaveLength(1);
    expect(big.events[0]).toMatchObject({ type: "system", subtype: "provider.notice.oversized-event" });
  });

  it("classifies the HTTP boundary oversized-frame sentinel without raw payload", () => {
    const mapped = mapOpenCodeEnvelope({ type: "mcode.adapter.oversized-sse-frame", properties: {} }, CTX);
    expect(mapped).toMatchObject({
      disposition: "diagnostic",
      reason: "oversized-sse-frame",
      events: [{ type: "system", subtype: "provider.notice.oversized-event" }],
    });
  });

  it("measures oversized envelopes in UTF-8 bytes", () => {
    const big = mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "text", id: "p1" }, delta: "😀".repeat(70_000) },
    }, CTX);
    expect(big.disposition).toBe("diagnostic");
    expect(big.reason).toBe("oversized-envelope");
  });

  it("bounds tool input before it reaches canonical events", () => {
    const mapped = mapOpenCodeEnvelope({
      type: "session.next.tool.called",
      properties: {
        callID: "c1",
        tool: "bash",
        input: {
          command: "x".repeat(10_000),
          nested: { one: { two: { three: { four: "untrusted" } } } },
        },
      },
    }, CTX);
    expect(mapped.events[0]).toMatchObject({
      type: "toolUse",
      toolInput: {
        command: "x".repeat(4_096),
        nested: { one: { two: { three: "[truncated]" } } },
      },
    });
  });

  it("keeps unknown events out of the timeline", () => {
    const unknown = mapOpenCodeEnvelope({ type: `x.${"y".repeat(2_000)}`, properties: {} }, CTX);
    expect(unknown).toEqual({
      disposition: "diagnostic", events: [], reason: "unknown-event-type",
    });
  });

  it("keeps unknown message parts out of the timeline", () => {
    expect(mapOpenCodeEnvelope({
      type: "message.part.updated",
      properties: { part: { type: "future-part" } },
    }, CTX)).toEqual({
      disposition: "diagnostic", events: [], reason: "unknown-part-type",
    });
  });

  it("maps reroute, warning, and auth signals to single bounded notices", () => {
    const reroute = mapOpenCodeEnvelope({
      type: "session.next.model.switched",
      properties: { sessionID: "ses_1", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
    }, CTX);
    expect(reroute.disposition).toBe("mapped");
    expect(reroute.events[0]).toMatchObject({
      type: "modelFallback",
      requestedModel: "requested model",
      actualModel: "anthropic/claude-sonnet-4-6",
    });

    const warning = mapOpenCodeEnvelope({
      type: "tui.toast.show",
      properties: { message: "disk almost full", variant: "warning" },
    }, CTX);
    expect(warning.events[0]).toMatchObject({
      type: "system",
      subtype: "provider.notice.warning",
      message: "Provider warning: disk almost full",
    });

    const info = mapOpenCodeEnvelope({
      type: "tui.toast.show",
      properties: { message: "saved", variant: "info" },
    }, CTX);
    expect(info.disposition).toBe("ignored");

    const config = mapOpenCodeEnvelope({ type: "config.updated", properties: {} }, CTX);
    expect(config).toMatchObject({
      disposition: "diagnostic",
      reason: "configuration-signal",
      events: [{
        type: "system",
        subtype: "provider.notice.configuration",
        message: "The provider reported a configuration update that may require attention.",
      }],
    });

    const auth = mapOpenCodeEnvelope({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "login expired" } } },
    }, CTX);
    expect(auth.disposition).toBe("mapped");
    expect(auth.events).toHaveLength(2);
    expect(auth.events[0]).toMatchObject({ type: "error", error: "login expired" });
    expect(auth.events[1]).toMatchObject({
      type: "system",
      subtype: "provider.notice.authentication-required",
      message: "Authentication is required before the provider can continue.",
    });

    const plain = mapOpenCodeEnvelope({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "UnknownError", data: { message: "boom" } } },
    }, CTX);
    expect(plain.events).toHaveLength(1);
    expect(plain.events[0]).toMatchObject({ type: "error", error: "boom" });
  });

  it("maps wrapped envelopes to the same notices as flat ones", () => {
    const wrapped = mapOpenCodeEnvelope({
      type: "bus",
      payload: {
        type: "session.next.model.switched",
        properties: { sessionID: "ses_1", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
      },
    }, CTX);
    expect(wrapped.events[0]).toMatchObject({
      type: "modelFallback",
      actualModel: "anthropic/claude-sonnet-4-6",
    });

    const wrappedAsk = mapOpenCodeEnvelope({
      type: "bus",
      payload: { type: "permission.v2.asked", properties: { id: "per_9", action: "bash" } },
    }, CTX);
    expect(wrappedAsk.disposition).toBe("mapped");
    expect(wrappedAsk.reason).toBe("permission-request");
  });

  it("keeps reply lifecycle signals state-only", () => {
    for (const type of [
      "permission.v2.replied",
      "question.v2.replied",
      "question.v2.rejected",
      "question.replied",
      "question.rejected",
    ]) {
      expect(mapOpenCodeEnvelope({ type, properties: {} }, CTX).disposition).toBe("state-only");
    }
  });
});

describe("mapOpenCodeEnvelope retries", () => {
  const NOW = 1_800_000_000_000;
  afterEach(() => { vi.useRealTimers(); });

  it("maps a retry session status to ApiRetry with the delay until the next attempt", () => {
    vi.useFakeTimers({ now: NOW });
    expect(mapOpenCodeEnvelope({ type: "session.status", properties: { sessionID: "ses_1", status: {
      type: "retry", attempt: 2, message: "Provider is overloaded", next: NOW + 4_000,
    } } }, CTX)).toEqual({ disposition: "mapped", events: [{
      type: "apiRetry", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      reason: "Provider is overloaded", attempt: 2, delayMs: 4_000,
    }] });
  });

  it("clamps a next attempt already in the past to no delay", () => {
    vi.useFakeTimers({ now: NOW });
    expect(mapOpenCodeEnvelope({ type: "session.status", properties: { status: { type: "retry", attempt: 1, message: "busy", next: NOW - 50 } } }, CTX).events)
      .toEqual([{ type: "apiRetry", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId, reason: "busy", attempt: 1, delayMs: 0 }]);
  });

  it.each(["idle", "busy"])("keeps a %s session status state-only", (type) => {
    expect(mapOpenCodeEnvelope({ type: "session.status", properties: { sessionID: "ses_1", status: { type } } }, CTX))
      .toEqual({ disposition: "state-only", events: [] });
  });

  it("maps a retry part to ApiRetry with its HTTP status", () => {
    expect(mapOpenCodeEnvelope({ type: "message.part.updated", properties: { part: {
      id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "retry", attempt: 3, time: { created: NOW },
      error: { name: "APIError", data: { message: "Too many requests", statusCode: 429, isRetryable: true, responseBody: "secret body" } },
    } } }, CTX)).toEqual({ disposition: "mapped", events: [{
      type: "apiRetry", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      reason: "Too many requests", attempt: 3, errorStatus: 429,
    }] });
  });

  it("maps session.next.retried to ApiRetry", () => {
    expect(mapOpenCodeEnvelope({ type: "session.next.retried", properties: {
      sessionID: "ses_1", attempt: 1, error: { message: "Server error", statusCode: 503, isRetryable: true },
    } }, CTX)).toEqual({ disposition: "mapped", events: [{
      type: "apiRetry", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      reason: "Server error", attempt: 1, errorStatus: 503,
    }] });
  });

  it("maps a malformed retry with a generic reason and no optional fields", () => {
    expect(mapOpenCodeEnvelope({ type: "session.next.retried", properties: { attempt: "two", error: "boom" } }, CTX).events)
      .toEqual([{ type: "apiRetry", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId, reason: "retry" }]);
  });

  it("maps a reasoning part's snapshots and text-field deltas to one reasoning block", () => {
    const reasoning = { type: "reasoning" as const, threadId: "thread-1", turnExecutionId: CTX.turnExecutionId, reasoningItemId: "prt_r" };
    expect(replayWithPartTypes([
      partUpdated({ id: "prt_r", type: "reasoning", text: "", time: { start: 1 } }),
      partDelta("prt_r", "Let me"),
      partDelta("prt_r", " check."),
      partUpdated({ id: "prt_r", type: "reasoning", text: "Let me check. Done", time: { start: 1, end: 2 } }),
    ])).toEqual([
      { ...reasoning, type: "reasoningDelta", delta: "" },
      { ...reasoning, type: "reasoningDelta", delta: "Let me" },
      { ...reasoning, type: "reasoningDelta", delta: " check." },
      { ...reasoning, type: "reasoningDelta", delta: " Done", done: true },
    ]);
  });

  it("closes a fully streamed reasoning part with an empty done delta", () => {
    const events = replayWithPartTypes([
      partUpdated({ id: "prt_r", type: "reasoning", text: "", time: { start: 1 } }),
      partDelta("prt_r", "all of it"),
      partUpdated({ id: "prt_r", type: "reasoning", text: "all of it", time: { start: 1, end: 2 } }),
    ]);
    expect(events.at(-1)).toEqual({
      type: "reasoningDelta", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId,
      delta: "", reasoningItemId: "prt_r", done: true,
    });
  });

  it("keeps a text part in the same message as answer text, forwarded exactly once", () => {
    const events = replayWithPartTypes([
      partUpdated({ id: "prt_r", type: "reasoning", text: "", time: { start: 1 } }),
      partDelta("prt_r", "thinking"),
      partUpdated({ id: "prt_r", type: "reasoning", text: "thinking", time: { start: 1, end: 2 } }),
      partUpdated({ id: "prt_t", type: "text", text: "", time: { start: 3 } }),
      partDelta("prt_t", "The answer"),
      partDelta("prt_t", " is 4."),
      partUpdated({ id: "prt_t", type: "text", text: "The answer is 4.", time: { start: 3, end: 4 } }),
    ]);
    expect(events.filter((event) => event.type === "textDelta").map((event) => event.delta)).toEqual(["The answer", " is 4."]);
    expect(events.filter((event) => event.type === "reasoningDelta").map((event) => event.delta)).toEqual(["", "thinking", ""]);
  });

  it("maps the session.next reasoning family to open, delta, and done", () => {
    const forwardedText = new Map<string, string>();
    const ctx = { ...CTX, forwardedText };
    const base = { sessionID: "ses_1", assistantMessageID: "msg_1", reasoningID: "rsn_1" };
    const events = [
      { type: "session.next.reasoning.started", properties: base },
      { type: "session.next.reasoning.delta", properties: { ...base, delta: "hmm" } },
      { type: "session.next.reasoning.ended", properties: { ...base, text: "hmm" } },
    ].flatMap((frame) => mapOpenCodeEnvelope(frame, ctx).events);
    const reasoning = { type: "reasoningDelta", threadId: "thread-1", turnExecutionId: CTX.turnExecutionId, reasoningItemId: "rsn_1" };
    expect(events).toEqual([
      { ...reasoning, delta: "" },
      { ...reasoning, delta: "hmm" },
      { ...reasoning, delta: "", done: true },
    ]);
  });

  it("keeps captured reasoning out of answer text", () => {
    const fixture = capturedTraceSchema.parse(JSON.parse(NodeFS.readFileSync(new URL("./fixtures/task-subagent.captured.json", import.meta.url), "utf8")));
    const reasoningTexts = fixture.events.flatMap((frame) => {
      const part = capturedReasoningPartSchema.safeParse(normalizeOpenCodeEnvelope(frame)?.properties.part);
      return part.success && part.data.text ? [part.data.text] : [];
    });
    expect(reasoningTexts).toHaveLength(2);
    const events = replayWithPartTypes(fixture.events);
    const answer = events.flatMap((event) => event.type === "textDelta" ? [event.delta] : []).join("");
    const thought = events.flatMap((event) => event.type === "reasoningDelta" ? [event.delta] : []).join("");
    for (const text of reasoningTexts) {
      expect(answer).not.toContain(text.slice(0, 20));
      expect(thought).toContain(text);
    }
    expect(events.filter((event) => event.type === "reasoningDelta" && event.done)).toHaveLength(2);
  });
});
