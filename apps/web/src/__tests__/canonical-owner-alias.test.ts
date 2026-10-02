import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentModelState, reduceAgentEventBatch, type AcceptedCanonicalAgentEventEnvelope, type AgentModelState,
  type CanonicalAgentProgressFrame, type CanonicalAgentProgressRecovery, type TurnSavingStatus } from "@mcode/contracts";
import { createCanonicalAgentReplica } from "@/stores/canonical-agent-replica";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { readThreadField, resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => mockTransport }));

const OWNER = "owner-thread";
const CHILD = "child-thread";
const OWNER_TURN = "owner-turn";
const CHILD_TURN = "child-turn";
const OWNER_EXECUTION = "00000000-0000-4000-8000-000000000001";
const CHILD_EXECUTION = "00000000-0000-4000-8000-000000000002";
const OTHER_EXECUTION = "00000000-0000-4000-8000-000000000003";
const EPOCH = "owner-epoch";
const NOW = "2026-09-30T12:00:00.000Z";

function familyState(): AgentModelState {
  const state = createAgentModelState();
  const commonThread = { workspaceId: "workspace", rootThreadId: OWNER, providerId: "codex" as const,
    providerIdentities: [], activityState: "Active" as const, conversationRevision: 0, rosterRevision: 0, createdAt: NOW, updatedAt: NOW };
  state.threads[OWNER] = { ...commonThread, id: OWNER };
  state.threads[CHILD] = { ...commonThread, id: CHILD, parentThreadId: OWNER, owningParentThreadId: OWNER };
  const commonTurn = { status: "Running" as const, permissionMode: "full" as const, approvalReviewMode: "manual" as const,
    approvalReviewReason: "manual-requested" as const, providerIdentities: [], startedAt: NOW, endedAt: null, createdAt: NOW, updatedAt: NOW };
  state.turns[OWNER_TURN] = { ...commonTurn, id: OWNER_TURN, threadId: OWNER, executionId: OWNER_EXECUTION, trigger: { kind: "user" } };
  state.turns[CHILD_TURN] = { ...commonTurn, id: CHILD_TURN, threadId: CHILD, executionId: CHILD_EXECUTION,
    trigger: { kind: "child", sourceThreadId: OWNER, sourceTurnId: OWNER_TURN } };
  return state;
}

function seedTarget(threadId: string): void {
  const state = familyState();
  useThreadStore.setState({ records: seedThreadRecord(threadId, {
    runtimePhase: "running", turnExecutionId: threadId === OWNER ? OWNER_EXECUTION : CHILD_EXECUTION,
    canonicalAgent: { ...createCanonicalAgentReplica(), state, durableState: state },
  }), runningThreadIds: new Set([...useThreadStore.getState().runningThreadIds, threadId]) });
}

function event(sequence: number, payload: AcceptedCanonicalAgentEventEnvelope["payload"]): AcceptedCanonicalAgentEventEnvelope {
  return { eventId: `owner-event-${sequence}`, routing: { threadId: OWNER, turnId: OWNER_TURN, executionId: OWNER_EXECUTION },
    sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: sequence,
    progressPosition: { epoch: EPOCH, sequence }, serverTimestamps: { acceptedAt: NOW }, payload };
}

function notice(sequence: number, overrides: Record<string, unknown> = {}): AcceptedCanonicalAgentEventEnvelope {
  return event(sequence, { type: "publication.recorded", publicationId: String(sequence), event: {
    type: "system", threadId: CHILD, turnExecutionId: CHILD_EXECUTION, subtype: "diagnostic", message: `Child notice ${sequence}`, ...overrides,
  } });
}

function accepted(events: AcceptedCanonicalAgentEventEnvelope[], threadId = CHILD): CanonicalAgentProgressFrame {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("empty alias fixture");
  return { phase: "accepted", threadId, ownerThreadId: OWNER, epoch: EPOCH,
    from: first.progressPosition.sequence - 1, through: last.progressPosition.sequence, events };
}

function saved(events: AcceptedCanonicalAgentEventEnvelope[]): CanonicalAgentProgressFrame {
  const through = events.at(-1)?.progressPosition.sequence;
  if (!through) throw new Error("empty alias fixture");
  return { phase: "saved", threadId: CHILD, ownerThreadId: OWNER, epoch: EPOCH, through,
    revision: { conversationRevision: through, rosterRevision: 0 },
    events: events.map((item) => ({ ...item, durableRevision: item.progressPosition.sequence })) };
}

function recovery(retained: AcceptedCanonicalAgentEventEnvelope[], state = familyState(), savedThrough = 0): CanonicalAgentProgressRecovery {
  return { phase: "recovery", threadId: CHILD, ownerThreadId: OWNER, epoch: EPOCH, loss: "none", savedThrough,
    acceptedThrough: retained.at(-1)?.progressPosition.sequence ?? savedThrough,
    durable: { mode: "snapshot", threadId: OWNER, snapshot: { revision: { conversationRevision: savedThrough, rosterRevision: 0 }, state } }, retained };
}

function childTerminal(sequence: number): AcceptedCanonicalAgentEventEnvelope {
  const turn = familyState().turns[CHILD_TURN];
  if (!turn) throw new Error("missing child fixture");
  return event(sequence, { type: "collaboration.observed", changes: [{ kind: "turn-terminal", outcome: "completed",
    sourceExecution: { threadId: CHILD, turnId: CHILD_TURN, executionId: CHILD_EXECUTION },
    parentExecution: { threadId: OWNER, turnId: OWNER_TURN, executionId: OWNER_EXECUTION },
    turn: { ...turn, status: "Completed", endedAt: NOW },
  }] });
}

describe("parent-owned child progress aliases", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests({ currentThreadId: CHILD });
    sessionStorage.removeItem(`mcode-agent-publication-v2:${CHILD}`);
    sessionStorage.removeItem(`mcode-agent-publication-v2:${OWNER}`);
    vi.clearAllMocks();
    seedTarget(CHILD);
  });

  it("keeps execution indicators settled after completion followed by Stop rejection", async () => {
    let rejectStop!: (error: Error) => void;
    vi.mocked(mockTransport.stopAgent).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectStop = reject; }),
    );
    const stopping = useThreadStore.getState().stopAgent(CHILD);
    useThreadStore.getState().handleCanonicalProgress(accepted([childTerminal(1)]));
    rejectStop(new Error("WebSocket disconnected"));
    await stopping;

    const state = useThreadStore.getState();
    expect(state.records.get(CHILD)?.canonicalAgent.state.turns[CHILD_TURN]?.status).toBe("Completed");
    expect(state.runningThreadIds.has(CHILD)).toBe(false);
    expect(isThreadExecuting(CHILD, state)).toBe(false);
  });

  it("renders a child-only accepted notice and saves against the owner stream", () => {
    const events = [notice(1), childTerminal(2)];
    useThreadStore.getState().handleCanonicalProgress(accepted(events));
    expect(readThreadField(CHILD, (record) => record.messages.map((message) => message.content))).toEqual(["Child notice 1"]);
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("completed");
    const saving: TurnSavingStatus = { threadId: CHILD, executionId: OWNER_EXECUTION, mode: "saving",
      accepted: { epoch: EPOCH, sequence: 2 }, saved: { epoch: EPOCH, sequence: 0 },
      pendingEvents: 2, pendingBytes: 256, oldestPendingAt: NOW };
    useThreadStore.getState().setTurnSavingStatus(saving);
    const visible = useThreadStore.getState().records.get(CHILD);
    if (!visible) throw new Error("missing child transcript");
    const dispatch = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    for (let through = 1; through <= events.length; through += 1) {
      useThreadStore.getState().handleCanonicalProgress(saved(events.slice(0, through)));
      const acknowledged = useThreadStore.getState().records.get(CHILD);
      if (!acknowledged) throw new Error("missing acknowledged child transcript");
      expect(acknowledged.canonicalAgent.state).toBe(visible.canonicalAgent.state);
      expect(acknowledged.canonicalAgent.state.turns[CHILD_TURN]).toBe(visible.canonicalAgent.state.turns[CHILD_TURN]);
      expect(acknowledged.messages).toBe(visible.messages);
      expect(acknowledged.toolCalls).toBe(visible.toolCalls);
      expect(acknowledged.thoughtSegments).toBe(visible.thoughtSegments);
      expect(acknowledged.hooks).toBe(visible.hooks);
      expect(acknowledged.savingStatuses).toEqual(through === 2 ? [] : [saving]);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(readThreadField(CHILD, (record) => record.canonicalAgent)).toMatchObject({ ownerThreadId: OWNER, recoveryRequired: false,
      revision: { conversationRevision: 2, rosterRevision: 0 }, progress: { epoch: EPOCH, savedThrough: 2, retained: [] } });
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(1);
  });

  it("keeps the child running when the parent's turn completes", () => {
    useThreadStore.getState().handleCanonicalProgress(accepted([event(1, { type: "turn.completed", endedAt: NOW })]));
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.state.turns[OWNER_TURN]?.status)).toBe("Completed");
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("running");
    expect(readThreadField(CHILD, (record) => record.turnExecutionId)).toBe(CHILD_EXECUTION);
    expect(useThreadStore.getState().runningThreadIds.has(CHILD)).toBe(true);
  });

  it("dispatches an owner publication only once across parent and child targets", () => {
    seedTarget(OWNER);
    const events = [notice(1)];
    useThreadStore.getState().handleCanonicalProgress(accepted(events, OWNER));
    useThreadStore.getState().handleCanonicalProgress(accepted(events));
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(1);
    expect(readThreadField(OWNER, (record) => record.messages)).toHaveLength(0);
  });

  it("preserves owner dedup when the parent record is removed while its alias remains", () => {
    seedTarget(OWNER);
    const events = [notice(1)];
    useThreadStore.getState().handleCanonicalProgress(accepted(events, OWNER));
    useThreadStore.getState().handleCanonicalProgress(recovery([]));
    useThreadStore.getState().clearThreadState(OWNER);
    useThreadStore.getState().handleCanonicalProgress(accepted(events));
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(1);
  });

  it("installs child-only retained recovery without replaying effects", () => {
    const events = [notice(1), childTerminal(2)];
    useThreadStore.getState().applyCanonicalReconnectRecoveries([recovery(events)]);
    useThreadStore.getState().handleCanonicalProgress(accepted(events));
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("completed");
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(0);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.ownerThreadId)).toBe(OWNER);
  });

  it("preserves a newer child lifecycle suffix when an older recovery cut arrives", () => {
    const events = [notice(1), childTerminal(2)];
    useThreadStore.getState().handleCanonicalProgress(accepted(events));
    useThreadStore.getState().handleCanonicalProgress(recovery(events.slice(0, 1)));
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("completed");
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(1);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.progress?.acceptedThrough)).toBe(2);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.progress?.retained)).toEqual(events);
  });

  it("discloses restart loss and interrupts the child from the saved owner family", () => {
    useThreadStore.getState().handleCanonicalProgress(accepted([childTerminal(1)]));
    useThreadStore.getState().handleCanonicalProgress({ ...recovery([]), epoch: "owner-restarted", loss: "runtime-restarted" });
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.ownerThreadId)).toBe(OWNER);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.lostProgress)).toBe(true);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.state.turns[CHILD_TURN]?.status)).toBe("Interrupted");
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("interrupted");
    expect(useThreadStore.getState().runningThreadIds.has(CHILD)).toBe(false);
    useThreadStore.getState().handleCanonicalProgress(accepted([childTerminal(1)]));
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("interrupted");
  });

  it("recovers the known owner honestly when an unsaved child spawn is absent after restart", () => {
    const family = familyState();
    const child = family.threads[CHILD];
    const turn = family.turns[CHILD_TURN];
    if (!child || !turn) throw new Error("missing child spawn fixture");
    const base = familyState();
    delete base.threads[CHILD];
    delete base.turns[CHILD_TURN];
    useThreadStore.setState({ records: seedThreadRecord(CHILD, { canonicalAgent: { ...createCanonicalAgentReplica(), state: base, durableState: base } }) });
    const parentExecution = { threadId: OWNER, turnId: OWNER_TURN, executionId: OWNER_EXECUTION };
    useThreadStore.getState().handleCanonicalProgress(accepted([event(1, { type: "collaboration.observed", changes: [
      { kind: "thread-recorded", sourceExecution: parentExecution, parentExecution, thread: child },
      { kind: "turn-started", sourceExecution: parentExecution, parentExecution, turn },
    ] })]));
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.state.threads[CHILD])).toEqual(child);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.durableState.threads[CHILD])).toBeUndefined();
    useThreadStore.getState().handleCanonicalProgress({ ...recovery([], base), epoch: "owner-restarted", loss: "runtime-restarted" });
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.ownerThreadId)).toBe(OWNER);
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.state.threads[CHILD])).toBeUndefined();
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.state.turns[CHILD_TURN])).toBeUndefined();
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("interrupted");
    expect(readThreadField(CHILD, (record) => record.canonicalAgent.lostProgress)).toBe(true);
    expect(useThreadStore.getState().runningThreadIds.has(CHILD)).toBe(false);
  });

  it.each([
    { type: "toolUse", toolCallId: "unsafe", toolName: "Read", toolInput: {} },
    { threadId: "unknown-child" },
    { turnExecutionId: OTHER_EXECUTION },
    { subtype: "provider.session.started" },
  ])("rejects an uncorrelated redirected publication %j", (overrides) => {
    const dispatch = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    useThreadStore.getState().handleCanonicalProgress(accepted([notice(1, overrides)]));
    expect(dispatch).not.toHaveBeenCalled();
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(0);
    expect(readThreadField(CHILD, (record) => record.toolCalls)).toHaveLength(0);
    expect(useThreadStore.getState().records.has("unknown-child")).toBe(false);
  });

  it("clears owner save health after a missed saved acknowledgement without replaying its child notice", () => {
    const events = [notice(1)];
    const failure: TurnSavingStatus = { threadId: CHILD, executionId: OWNER_EXECUTION, mode: "saving-failed",
      accepted: { epoch: EPOCH, sequence: 1 }, saved: { epoch: EPOCH, sequence: 0 },
      pendingEvents: 1, pendingBytes: 256, oldestPendingAt: NOW, failure: { name: "DatabaseError", message: "Disk is full", kind: "permanent" } };
    useThreadStore.getState().handleCanonicalProgress(accepted(events));
    useThreadStore.getState().setTurnSavingStatus(failure);
    expect(readThreadField(CHILD, (record) => record.savingStatuses)).toEqual([failure]);
    expect(readThreadField(CHILD, (record) => record.savingStatus)).toBeNull();
    const reduced = reduceAgentEventBatch(familyState(), events);
    if (reduced.outcome === "rejected") throw new Error("invalid saved alias fixture");
    useThreadStore.getState().handleCanonicalProgress(recovery([], reduced.state, 1));
    expect(readThreadField(CHILD, (record) => record.savingStatuses)).toEqual([]);
    expect(readThreadField(CHILD, (record) => record.messages)).toHaveLength(1);
    expect(readThreadField(CHILD, (record) => record.runtimePhase)).toBe("running");
  });
});
