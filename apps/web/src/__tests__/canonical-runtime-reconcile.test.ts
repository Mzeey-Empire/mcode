import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import {
  resetThreadStoreForTests,
  seedThreadRecord,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_EXECUTION_ID = "00000000-0000-4000-8000-000000000099";
const NOW = "2026-08-11T12:00:00.000Z";

function envelope(
  eventId: string,
  acceptedSequence: number,
  executionId: string,
  payload: CanonicalAgentEventEnvelope["payload"],
): CanonicalAgentEventEnvelope {
  return {
    eventId,
    routing: {
      threadId: THREAD_ID,
      turnId: payload.type === "thread.recorded" ? undefined : TURN_ID,
      executionId,
    },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence,
    durableRevision: acceptedSequence,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload,
  };
}

function turnEvents(executionId: string, terminal?: "completed" | "interrupted"): CanonicalAgentEventEnvelope[] {
  const events: CanonicalAgentEventEnvelope[] = [
    envelope("e1", 1, executionId, {
      type: "thread.recorded",
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        rootThreadId: THREAD_ID,
        providerId: "codex",
        providerIdentities: [],
        activityState: "Active",
        conversationRevision: 1,
        rosterRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("e2", 2, executionId, {
      type: "turn.created",
      turn: {
        id: TURN_ID,
        threadId: THREAD_ID,
        status: "Pending",
        trigger: { kind: "user" },
        permissionMode: "full",
        approvalReviewMode: "manual",
        approvalReviewReason: "manual-requested",
        providerIdentities: [],
        startedAt: null,
        endedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("e3", 3, executionId, { type: "turn.started", startedAt: NOW }),
  ];
  if (terminal === "completed") {
    events.push(envelope("e4", 4, executionId, { type: "turn.completed", endedAt: NOW }));
  } else if (terminal === "interrupted") {
    events.push(envelope("e4", 4, executionId, { type: "turn.interrupted", endedAt: NOW, reason: "restart" }));
  }
  return events;
}

function seedRuntime(phase: "running" | "idle", turnExecutionId: string | null, running: boolean) {
  useThreadStore.setState({
    records: seedThreadRecord(THREAD_ID, { runtimePhase: phase, turnExecutionId }),
    runningThreadIds: running ? new Set([THREAD_ID]) : new Set(),
  });
}

describe("canonical runtime reconciliation", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests();
    vi.clearAllMocks();
  });

  it("clears a stale running flag when the correlated canonical turn terminates", () => {
    seedRuntime("running", EXECUTION_ID, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("claims an idle record when canonical reports a running turn", () => {
    seedRuntime("idle", null, false);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("keeps the optimistic running window while no canonical turn correlates", () => {
    seedRuntime("running", null, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("ignores a canonical turn carrying a different execution identity", () => {
    seedRuntime("running", OTHER_EXECUTION_ID, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("maps an interrupted canonical turn to the interrupted phase", () => {
    seedRuntime("running", EXECUTION_ID, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "interrupted"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("interrupted");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });
});
