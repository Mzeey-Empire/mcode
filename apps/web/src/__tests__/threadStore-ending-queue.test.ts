import { createAgentModelState, type AgentEvent } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueueStore } from "@/stores/queueStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { scheduleDrainAfterEdit, useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "ending-queue-thread";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";

function enqueue(content: string): void {
  useQueueStore.getState().enqueue(THREAD_ID, {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "full",
  });
}

function queued(): string[] | undefined {
  return useQueueStore.getState().queues[THREAD_ID]?.map((message) => message.content);
}

const ended = (outcome: "completed" | "cancelled" | "interrupted" | "errored", reason?: string): AgentEvent => ({
  type: "ended",
  threadId: THREAD_ID,
  turnExecutionId: EXECUTION_ID,
  outcome,
  reason,
});

/** A later drain request, such as cancelling a queued-message edit, must still send nothing. */
async function expectQueueHeld(): Promise<void> {
  scheduleDrainAfterEdit(THREAD_ID);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mockTransport.sendMessage).not.toHaveBeenCalled();
  expect(queued()).toEqual(["first", "second"]);
}

describe("queued follow-ups after a turn ends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      runningThreadIds: new Set([THREAD_ID]),
      records: new Map<string, ThreadRecord>([[THREAD_ID, {
        ...createEmptyThreadRecord(),
        runtimePhase: "running",
        turnExecutionId: EXECUTION_ID,
      }]]),
    });
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      autoDrainSuppressedThreadIds: new Set<string>(),
      toast: null,
      editingThreadId: null,
    });
    useWorkspaceStore.setState({ activeThreadId: THREAD_ID, threads: [createMockThread({ id: THREAD_ID })] });
    (mockTransport.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    enqueue("first");
    enqueue("second");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[string, AgentEvent]>([
    ["an error", { type: "error", threadId: THREAD_ID, error: "Overloaded", failure: { kind: "retryable" } }],
    ["an interruption", ended("interrupted")],
    ["a user stop", ended("cancelled", "user")],
    ["a Mcode stop", ended("cancelled", "approval_unanswerable")],
    ["a failed ending", ended("errored")],
  ])("holds the whole queue after %s", async (_name, event) => {
    useThreadStore.getState().handleAgentEvent(event);
    await vi.advanceTimersByTimeAsync(1_000);

    await expectQueueHeld();
  });

  it("holds the queue when a persisted Mcode stop settles the turn before any terminal event", async () => {
    useThreadStore.getState().handleTurnPersisted({
      threadId: THREAD_ID,
      messageId: null,
      settledMessage: null,
      executionId: EXECUTION_ID,
      outcome: "cancelled",
      toolCallCount: 0,
      filesChanged: [],
    });
    useThreadStore.getState().handleAgentEvent(ended("cancelled", "approval_unanswerable"));

    await expectQueueHeld();
  });

  it("holds the queue when canonical state settles a failed turn before any terminal event", async () => {
    const state = createAgentModelState();
    state.turns.t1 = {
      id: "t1", threadId: THREAD_ID, status: "Errored", trigger: { kind: "user" }, permissionMode: "full",
      approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, executionId: EXECUTION_ID,
      providerIdentities: [], startedAt: "2026-10-11T12:00:00.000Z", providerStartedAt: "2026-10-11T12:00:00.000Z",
      endedAt: "2026-10-11T12:00:05.000Z", createdAt: "2026-10-11T12:00:00.000Z", updatedAt: "2026-10-11T12:00:05.000Z",
      ending: { outcome: "errored", failure: { kind: "fatal", provider: "codex", message: "boom" } },
    };
    useThreadStore.getState().applyCanonicalReconnectRecoveries([{
      threadId: THREAD_ID, mode: "snapshot", snapshot: { state, revision: { conversationRevision: 1, rosterRevision: 0 } },
    }]);
    useThreadStore.getState().handleAgentEvent(ended("errored"));

    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
    await expectQueueHeld();
  });

  it("holds the queue when the provider is lost", async () => {
    useThreadStore.getState().handleAgentEvent({ type: "ended", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, reason: "provider_lost" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(useThreadStore.getState().records.get(THREAD_ID)?.runtimePhase).toBe("idle");
    await expectQueueHeld();
  });

  it("drains the first follow-up after a completion", async () => {
    useThreadStore.getState().handleAgentEvent(ended("completed"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockTransport.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID, content: "first" }));
    expect(queued()).toEqual(["second"]);
  });
});
