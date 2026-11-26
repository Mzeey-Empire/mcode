import { createMockThread } from "@mcode/contracts/testing";
// @vitest-environment jsdom
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import {
  resetThreadStoreForTests,
  getTestThreadToolCalls,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { createAgentModelState } from "@mcode/contracts/compat/agent-model";
import { recoverParentNarrative } from "@/stores/parent-narrative-recovery";
import { prepareLiveNarrative } from "@/features/conversation/narrative/live-narrative-timeline";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Tool Call Matching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1" })] });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      records: new Map<string, ThreadRecord>([
        ["thread-1", createEmptyThreadRecord()],
      ]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts command duration after approval and settles only the denied command", () => {
    const send = useThreadStore.getState().handleAgentEvent;
    const first = { type: "toolUse", threadId: "thread-1", toolCallId: "first", toolName: "Bash", toolInput: { command: "echo alpha" } } satisfies AgentEvent;
    send({ ...first, status: "running", phase: "waiting" });
    send({ ...first, toolCallId: "second", status: "running", phase: "queued" });
    vi.advanceTimersByTime(20_000);
    send({ ...first, status: "running" });
    vi.advanceTimersByTime(1_000);
    send({ type: "toolResult", threadId: "thread-1", toolCallId: "first", output: "alpha", isError: false });
    send({ type: "toolResult", threadId: "thread-1", toolCallId: "second", output: "Denied", isError: false, denied: true });
    expect(getTestThreadToolCalls("thread-1").map(({ durationMs, isComplete, isError, status }) => ({ durationMs, isComplete, isError, status }))).toEqual([
      { durationMs: 1_000, isComplete: true, isError: false, status: "completed" },
      { durationMs: undefined, isComplete: true, isError: false, status: "denied" },
    ]);
  });

  it("measures a late-delivered result between the provider's event times, as the saved record does", () => {
    const send = useThreadStore.getState().handleAgentEvent;
    const use = { type: "toolUse" as const, threadId: "thread-1", toolName: "Bash", toolInput: { command: "echo alpha" } };
    send({ ...use, toolCallId: "delayed", occurredAt: "2026-11-26T10:00:00.000Z" });
    send({ ...use, toolCallId: "bunched", occurredAt: "2026-11-26T10:00:00.000Z" });
    vi.advanceTimersByTime(30_000);
    send({ type: "toolResult", threadId: "thread-1", toolCallId: "delayed", output: "alpha", isError: false, occurredAt: "2026-11-26T10:00:00.400Z" });
    send({ type: "toolResult", threadId: "thread-1", toolCallId: "bunched", output: "alpha", isError: false, occurredAt: "2026-11-26T10:00:00.250Z" });
    expect(getTestThreadToolCalls("thread-1").map(({ id, durationMs }) => ({ id, durationMs }))).toEqual([
      { id: "delayed", durationMs: 400 },
      { id: "bunched", durationMs: 250 },
    ]);
  });

  it("measures a result that arrives after reconnecting from the recovered call's saved start", () => {
    const startedAt = "2026-11-26T10:00:00.000Z";
    const state = createAgentModelState();
    state.turns.parent = {
      id: "parent", threadId: "thread-1", executionId: "00000000-0000-4000-8000-000000000001", status: "Running", trigger: { kind: "user" },
      permissionMode: "full", approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null,
      providerIdentities: [], startedAt, providerStartedAt: null, ending: null, endedAt: null, createdAt: startedAt, updatedAt: startedAt,
    };
    state.items.tool = {
      id: "tool", threadId: "thread-1", turnId: "parent", kind: "tool-call", providerIdentities: [], createdAt: startedAt, updatedAt: startedAt,
      payload: { projection: "toolCall", record: {
        id: "recovered", message_id: "", parent_tool_call_id: null, tool_name: "Bash", input_summary: "{}", output_summary: "",
        status: "running", started_at: startedAt, completed_at: null, sort_order: 1,
      } },
    };
    const { toolCalls } = recoverParentNarrative("thread-1", state);
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      records: new Map<string, ThreadRecord>([["thread-1", { ...createEmptyThreadRecord(), toolCalls: toolCalls ?? [] }]]),
    });
    vi.advanceTimersByTime(60_000);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "recovered", output: "alpha", isError: false, occurredAt: "2026-11-26T10:00:00.700Z" });
    expect(getTestThreadToolCalls("thread-1")[0]?.durationMs).toBe(700);
  });

  it("keeps a recovered tool after the thought saved before it when its event time is earlier", () => {
    const at = "2026-11-26T10:00:00.000Z";
    const state = createAgentModelState();
    state.turns.parent = {
      id: "parent", threadId: "thread-1", executionId: "00000000-0000-4000-8000-000000000001", status: "Running", trigger: { kind: "user" },
      permissionMode: "full", approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null,
      providerIdentities: [], startedAt: at, providerStartedAt: null, ending: null, endedAt: null, createdAt: at, updatedAt: at,
    };
    const item = { threadId: "thread-1", turnId: "parent", providerIdentities: [], createdAt: at, updatedAt: at };
    state.items.thought = { ...item, id: "thought", kind: "reasoning", payload: { projection: "narrationSegment", record: {
      id: "thinking", message_id: "", text: "Checking the file.", is_final_response: 0, started_at: "2026-11-26T10:00:05.000Z", ended_at: null, sort_order: 1,
    } } };
    state.items.tool = { ...item, id: "tool", kind: "tool-call", payload: { projection: "toolCall", record: {
      id: "delayed", message_id: "", parent_tool_call_id: null, tool_name: "Bash", input_summary: "{}", output_summary: "",
      status: "running", started_at: "2026-11-26T10:00:02.000Z", completed_at: null, sort_order: 2,
    } } };
    const { toolCalls, thoughtSegments } = recoverParentNarrative("thread-1", state);
    const { timeline } = prepareLiveNarrative({
      toolCalls: toolCalls ?? [], thoughtSegments: thoughtSegments ?? [], hooks: [], streamingText: "", isAgentRunning: true,
    });
    expect(timeline.map((event) => event.kind)).toEqual(["thought", "tool"]);
    expect(toolCalls?.[0]?.eventStartedAt).toBe(Date.parse("2026-11-26T10:00:02.000Z"));
  });

  it("starts an approved command's event-time duration at approval", () => {
    const send = useThreadStore.getState().handleAgentEvent;
    const command = { type: "toolUse", threadId: "thread-1", toolCallId: "approved", toolName: "Bash", toolInput: { command: "echo alpha" } } satisfies AgentEvent;
    send({ ...command, status: "running", phase: "waiting", occurredAt: "2026-11-26T10:00:00.000Z" });
    send({ ...command, status: "running", occurredAt: "2026-11-26T10:00:20.000Z" });
    vi.advanceTimersByTime(45_000);
    send({ type: "toolResult", threadId: "thread-1", toolCallId: "approved", output: "alpha", isError: false, occurredAt: "2026-11-26T10:00:21.000Z" });
    expect(getTestThreadToolCalls("thread-1")[0]?.durationMs).toBe(1_000);
  });

  it("keeps overlapping calls active until their own results arrive", () => {
    const send = useThreadStore.getState().handleAgentEvent;
    for (const toolCallId of ["first", "second"]) {
      send({ type: "toolUse", threadId: "thread-1", toolCallId, toolName: "Bash", toolInput: { command: "echo test" } });
    }
    expect(getTestThreadToolCalls("thread-1").map((call) => call.isComplete)).toEqual([false, false]);

    send({ type: "textDelta", threadId: "thread-1", delta: "Both commands are active.", isFinalResponse: false });
    vi.runAllTimers();
    expect(getTestThreadToolCalls("thread-1").map((call) => call.isComplete)).toEqual([false, false]);

    send({ type: "message", threadId: "thread-1", content: "Commands continue in parallel.", tokens: null });
    expect(getTestThreadToolCalls("thread-1").map((call) => call.isComplete)).toEqual([false, false]);

    send({ type: "toolResult", threadId: "thread-1", toolCallId: "second", output: "second done", isError: false });
    expect(getTestThreadToolCalls("thread-1").map((call) => call.isComplete)).toEqual([false, true]);
    send({ type: "toolResult", threadId: "thread-1", toolCallId: "first", output: "first done", isError: false });
    expect(getTestThreadToolCalls("thread-1").map((call) => call.isComplete)).toEqual([true, true]);
  });

  it("settles outstanding calls when the turn ends without tool results", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord(), runtimePhase: "running" }],
      ]),
    });
    const send = useThreadStore.getState().handleAgentEvent;
    send({ type: "toolUse", threadId: "thread-1", toolCallId: "unfinished", toolName: "Bash", toolInput: {} });
    send({ type: "turnComplete", threadId: "thread-1", reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    vi.runAllTimers();
    expect(getTestThreadToolCalls("thread-1").every((call) => call.isComplete)).toBe(true);
  });

  it("tool result with matching ID completes the correct tool call", () => {
    // Set up two pending tool calls
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc2", output: "done", isError: true, exitCode: 1 } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].isComplete).toBe(false); // tc1 untouched
    expect(calls[1].isComplete).toBe(true);
    expect(calls[1].output).toBe("done");
    expect(calls[1].exitCode).toBe(1);
  });

  it("tool result with non-matching ID falls back to first incomplete", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "unknown-id", output: "result", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].isComplete).toBe(true);
    expect(calls[0].output).toBe("result");
    // Second incomplete call should be untouched
    expect(calls[1].isComplete).toBe(false);
    expect(calls[1].output).toBeNull();
  });

  it("multiple concurrent tool calls resolve independently by ID", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc3", toolName: "Bash", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    // Resolve out of order
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc3", output: "third", isError: false } satisfies AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc1", output: "first", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].output).toBe("first");
    expect(calls[1].isComplete).toBe(false);
    expect(calls[2].output).toBe("third");
  });

  it("all tool calls already complete: fallback does nothing", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: "done", isError: false, isComplete: true },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "unknown", output: "extra", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    // Original output preserved
    expect(calls[0].output).toBe("done");
  });

  it("out-of-order results don't overwrite completed calls", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: "first-result", isError: false, isComplete: true },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc2", output: "second-result", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].output).toBe("first-result"); // preserved
    expect(calls[1].output).toBe("second-result"); // newly completed
  });

  it("tool result merges late metadata into the matching tool input", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              {
                id: "agent-1",
                toolName: "Agent",
                toolInput: {
                  codexCollabKind: "spawnAgent",
                  description: "Inspect mapper tests",
                },
                output: null,
                isError: false,
                isComplete: false,
              },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "agent-1",
        output: "done",
        isError: false,
        toolInput: {
          model: "gpt-5.5",
          reasoningEffort: "high",
        }, } satisfies AgentEvent);
    vi.runAllTimers();

    const [call] = getTestThreadToolCalls("thread-1");
    expect(call.isComplete).toBe(true);
    expect(call.output).toBe("done");
    expect(call.toolInput).toEqual({
      codexCollabKind: "spawnAgent",
      description: "Inspect mapper tests",
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
  });
});
