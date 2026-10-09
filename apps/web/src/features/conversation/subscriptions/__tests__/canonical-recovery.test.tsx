import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentModelState, reduceAgentEventBatch, type AcceptedCanonicalAgentEventEnvelope,
  type CanonicalAgentEventEnvelope, type SetThreadSubscriptionsResult } from "@mcode/contracts";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadSubscriptionReconciler } from "../useThreadSubscriptionReconciler";

const setThreadSubscriptions = vi.hoisted(() => vi.fn(async (): Promise<SetThreadSubscriptionsResult> => ({
  canonicalRecoveries: [],
})));
vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")), getTransport: () => ({ setThreadSubscriptions }),
}));

const THREAD = "parent-recovery";
const TURN = "admitted-turn";
const EXECUTION = "00000000-0000-4000-8000-000000000001";
const EPOCH = "active-generation";
const NOW = "2026-10-02T18:00:00.000Z";
const DESIRED = [THREAD];

function event(sequence: number, revision: number, payload: CanonicalAgentEventEnvelope["payload"]): CanonicalAgentEventEnvelope {
  return { eventId: `event-${sequence}`, acceptedSequence: sequence, durableRevision: revision,
    routing: { threadId: THREAD, executionId: EXECUTION,
      ...(payload.type !== "thread.recorded" ? { turnId: TURN } : {}),
      ...(payload.type === "item.recorded" ? { itemId: payload.item.id } : {}) },
    sourceProviderId: "codex", sourceIdentities: [],
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW }, payload };
}

function fixture() {
  const seed = event(1, 1, { type: "thread.recorded", thread: { id: THREAD, workspaceId: "workspace",
    rootThreadId: THREAD, providerId: "codex", providerIdentities: [], activityState: "Active",
    conversationRevision: 1, rosterRevision: 0, createdAt: NOW, updatedAt: NOW } });
  const admission = event(2, 2, { type: "turn.created", turn: { id: TURN, threadId: THREAD,
    executionId: EXECUTION, status: "Pending", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", providerIdentities: [],
    startedAt: null, providerStartedAt: null, endedAt: null, createdAt: NOW, updatedAt: NOW } });
  const started = event(3, 3, { type: "turn.started", startedAt: NOW });
  const prefix = event(4, 4, { type: "item.recorded", item: { id: "closed-prefix", threadId: THREAD,
    turnId: TURN, kind: "reasoning", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
    payload: { projection: "narrativeRecovery", narrative: { kind: "narrationSegment", record: {
      id: "closed-prefix", message_id: "response", text: "Completed commentary prefix", sort_order: 0,
      started_at: NOW, ended_at: NOW, is_final_response: 0 } } } } });
  const seeded = reduceAgentEventBatch(createAgentModelState(), [seed]);
  const admitted = reduceAgentEventBatch(createAgentModelState(), [seed, admission, started]);
  if (seeded.outcome !== "applied" || admitted.outcome !== "applied") throw new Error("Invalid admission fixture");
  const { durableRevision: _revision, ...accepted } = prefix;
  const retained: AcceptedCanonicalAgentEventEnvelope[] = [{ ...accepted, progressPosition: { epoch: EPOCH, sequence: 1 } }];
  return { seeded: seeded.state, admitted: admitted.state, admission, started, retained };
}

afterEach(() => {
  cleanup();
  resetThreadStoreForTests();
  setThreadSubscriptions.mockClear();
});

it("requests durable repair after a batched saved gap and live prefix, then restores the admitted turn and text", async () => {
  const capture = fixture();
  const record = createEmptyThreadRecord();
  record.runtimePhase = "running";
  record.turnExecutionId = EXECUTION;
  record.canonicalAgent = { ...record.canonicalAgent, state: capture.seeded, durableState: capture.seeded,
    revision: { conversationRevision: 1, rosterRevision: 0 } };
  resetThreadStoreForTests({ currentThreadId: THREAD, records: new Map([[THREAD, record]]) });
  let resolveRecovery: ((result: SetThreadSubscriptionsResult) => void) | undefined;
  const response = new Promise<SetThreadSubscriptionsResult>((resolve) => { resolveRecovery = resolve; });
  setThreadSubscriptions.mockResolvedValueOnce({ canonicalRecoveries: [] })
    .mockImplementationOnce(() => response);
  const { result } = renderHook(() => {
    const recoveryRequired = useThreadStore((state) => state.records.get(THREAD)?.canonicalAgent.recoveryRequired);
    const runningThreadIds = useThreadStore((state) => state.runningThreadIds);
    useThreadSubscriptionReconciler({ activeThreadId: THREAD, desiredThreadIds: DESIRED,
      connectionStatus: "connected", runningThreadIds, canonicalRecoverySignature: recoveryRequired ? THREAD : "" });
    return recoveryRequired;
  });
  await act(async () => {});
  expect(setThreadSubscriptions).toHaveBeenCalledTimes(1);
  act(() => {
    // A committed command can advertise its final revision while its admission is still a separate batch.
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD,
      epoch: "admission-generation", through: 0, revision: { conversationRevision: 3, rosterRevision: 0 }, events: [capture.admission] });
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD,
      epoch: EPOCH, through: 0, revision: { conversationRevision: 3, rosterRevision: 0 }, events: [capture.started] });
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD,
      epoch: EPOCH, from: 0, through: 1, events: capture.retained });
  });
  expect(result.current).toBe(true);
  await act(async () => {});
  expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
  expect(useThreadStore.getState().records.get(THREAD)?.canonicalAgent.state.items["closed-prefix"]).toBeDefined();
  const completeRecovery = resolveRecovery;
  if (!completeRecovery) throw new Error("Missing recovery response resolver");
  await act(async () => {
    completeRecovery({ canonicalRecoveries: [{ phase: "recovery", threadId: THREAD,
      epoch: EPOCH, acceptedThrough: 1, savedThrough: 0, retained: capture.retained, loss: "none",
      durable: { mode: "snapshot", threadId: THREAD, snapshot: {
        revision: { conversationRevision: 3, rosterRevision: 0 }, state: capture.admitted } } }] });
    await response;
  });
  const repaired = useThreadStore.getState().records.get(THREAD);
  expect(result.current).toBe(false);
  expect(repaired?.canonicalAgent.state.turns[TURN]?.status).toBe("Running");
  expect(repaired?.thoughtSegments).toEqual([expect.objectContaining({ id: "closed-prefix", text: "Completed commentary prefix", endedAt: Date.parse(NOW) })]);
  expect(useThreadStore.getState().runningThreadIds.has(THREAD)).toBe(true);
  expect(setThreadSubscriptions).toHaveBeenCalledTimes(2);
});
