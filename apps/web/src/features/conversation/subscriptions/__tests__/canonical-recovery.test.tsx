import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentModelState, reduceAgentEventBatch, type AcceptedCanonicalAgentEventEnvelope,
  type CanonicalAgentEventEnvelope, type ConversationPage, type SetThreadSubscriptionsResult } from "@mcode/contracts";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadSubscriptionReconciler } from "../useThreadSubscriptionReconciler";

const setThreadSubscriptions = vi.hoisted(() => vi.fn(async (): Promise<SetThreadSubscriptionsResult> => ({
  canonicalRecoveries: [],
})));
const loadConversationPage = vi.hoisted(() => vi.fn());
vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")), getTransport: () => ({ setThreadSubscriptions, loadConversationPage, loadTurn: async () => [] }),
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
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: null, providerStartedAt: null, ending: null, endedAt: null, createdAt: NOW, updatedAt: NOW } });
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
  loadConversationPage.mockReset();
});

it("reloads a leased non-active transcript after recovery invalidates its pending fetch", async () => {
  resetThreadStoreForTests({ currentThreadId: "selected-parent" });
  let resolveInitialPage: ((page: ConversationPage) => void) | undefined;
  const initialPage = new Promise<ConversationPage>((resolve) => { resolveInitialPage = resolve; });
  const messages = [
    createMockMessage({ id: "earlier-prompt", thread_id: THREAD, role: "user", content: "Earlier task", sequence: 1 }),
    createMockMessage({ id: "earlier-answer", thread_id: THREAD, role: "assistant", content: "Earlier answer", sequence: 2 }),
    createMockMessage({ id: "latest-prompt", thread_id: THREAD, role: "user", content: "Latest task", sequence: 3 }),
    createMockMessage({ id: "latest-answer", thread_id: THREAD, role: "assistant", content: "Latest answer", sequence: 4 }),
  ];
  loadConversationPage.mockImplementationOnce(() => initialPage)
    .mockResolvedValue({ messages, hasMore: false, narrativeByMessage: {} });
  const residency = getConversationResidency();
  const initialLoad = residency.mountDisplayConversation(THREAD);
  await act(async () => {});
  expect(loadConversationPage).toHaveBeenCalledTimes(1);
  setThreadSubscriptions.mockResolvedValueOnce({ canonicalRecoveries: [{
    phase: "recovery", threadId: THREAD, epoch: EPOCH, acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none",
    durable: { mode: "snapshot", threadId: THREAD, snapshot: {
      revision: { conversationRevision: 1, rosterRevision: 0 }, state: fixture().seeded,
    } },
  }] });
  try {
    renderHook(() => useThreadSubscriptionReconciler({
      activeThreadId: "selected-parent", desiredThreadIds: DESIRED, connectionStatus: "connected",
      runningThreadIds: new Set(), canonicalRecoverySignature: "",
    }));
    await act(async () => {});
    const completeInitialPage = resolveInitialPage;
    if (!completeInitialPage) throw new Error("Missing initial page resolver");
    await act(async () => {
      completeInitialPage({ messages: [], hasMore: false, narrativeByMessage: {} });
      await initialLoad;
    });

    expect(useThreadStore.getState().records.get(THREAD)?.messages.map((message) => message.id))
      .toEqual(["earlier-prompt", "earlier-answer", "latest-prompt", "latest-answer"]);
    expect(useThreadStore.getState().currentThreadId).toBe("selected-parent");
    expect(loadConversationPage).toHaveBeenCalledTimes(2);
  } finally {
    residency.unmountDisplayConversation(THREAD);
  }
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
