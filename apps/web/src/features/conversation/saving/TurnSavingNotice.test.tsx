import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentModelState, type CanonicalAgentProgressRecovery, type TurnSavingStatus } from "@mcode/contracts";
import { createCanonicalAgentReplica } from "@/stores/canonical-agent-replica";
import { TurnSaveRecovery, TurnSavingNotice } from "./TurnSavingNotice";
import { mockTransport } from "@/__tests__/mocks/transport";
import { resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { NarrativeIndicator } from "../narrative/NarrativeIndicator";
import { deriveRunStatus } from "../narrative/run-status";
import { getComposerSendButtonVisualState } from "../composer/ComposerContentSurface";

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => mockTransport }));

const pending = { threadId: "thread-1", executionId: "00000000-0000-4000-8000-000000000001",
  accepted: { epoch: "runtime-1", sequence: 2 }, saved: { epoch: "runtime-1", sequence: 0 },
  pendingEvents: 2, pendingBytes: 128, oldestPendingAt: "2026-09-30T12:00:00.000Z" };
const failed: Extract<TurnSavingStatus, { mode: "saving-failed" }> = { ...pending, mode: "saving-failed",
  failure: { name: "DatabaseError", kind: "permanent", message: "Disk is full" } };

function ConnectedSavingNotice() {
  const statuses = useThreadStore((state) => state.records.get(pending.threadId)?.savingStatuses ?? []);
  return <TurnSaveRecovery statuses={statuses} />;
}

function ConnectedRuntimeNotice() {
  const record = useThreadStore((state) => state.records.get(pending.threadId));
  const running = useThreadStore((state) => state.runningThreadIds.has(pending.threadId));
  const status = deriveRunStatus({ stopPending: false, compacting: false, subagentsRunning: false, answering: false,
    activeTool: record?.toolCalls.find((tool) => !tool.isComplete) });
  return <><NarrativeIndicator stepCount={1} status={status} isAgentRunning={running} />
    <TurnSavingNotice lostProgress={false} /></>;
}

function epochRecoveryFixture() {
  resetThreadStoreForTests();
  const state = createAgentModelState();
  state.threads[pending.threadId] = { id: pending.threadId, workspaceId: "workspace", rootThreadId: pending.threadId, providerId: "codex",
    providerIdentities: [], activityState: "Active", conversationRevision: 1, rosterRevision: 0, createdAt: pending.oldestPendingAt, updatedAt: pending.oldestPendingAt };
  state.turns.turn = { id: "turn", threadId: pending.threadId, executionId: pending.executionId, status: "Running", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", providerIdentities: [],
    startedAt: pending.oldestPendingAt, providerStartedAt: null, endedAt: null, createdAt: pending.oldestPendingAt, updatedAt: pending.oldestPendingAt };
  resetThreadStoreForTests({ currentThreadId: pending.threadId, records: seedThreadRecord(pending.threadId, {
    runtimePhase: "running", turnExecutionId: pending.executionId,
    canonicalAgent: { ...createCanonicalAgentReplica(), state, durableState: state, revision: { conversationRevision: 1, rosterRevision: 0 },
      progress: { epoch: "old-epoch", acceptedThrough: 0, savedThrough: 0, retained: [] } },
  }), runningThreadIds: new Set([pending.threadId]) });
  const recovery: CanonicalAgentProgressRecovery = { phase: "recovery", threadId: pending.threadId, epoch: "new-epoch", acceptedThrough: 1, savedThrough: 0, loss: "none",
    durable: { mode: "snapshot", threadId: pending.threadId, snapshot: { revision: { conversationRevision: 1, rosterRevision: 0 }, state } },
    retained: [{ eventId: "new-terminal", routing: { threadId: pending.threadId, turnId: "turn", executionId: pending.executionId }, sourceProviderId: "codex",
      sourceIdentities: [], acceptedSequence: 1, progressPosition: { epoch: "new-epoch", sequence: 1 },
      serverTimestamps: { acceptedAt: pending.oldestPendingAt }, payload: { type: "turn.completed", endedAt: pending.oldestPendingAt } }],
  };
  const nextFailure: TurnSavingStatus = { ...failed, accepted: { epoch: "new-epoch", sequence: 1 }, saved: { epoch: "new-epoch", sequence: 0 }, pendingEvents: 1 };
  return { recovery, failed: nextFailure, state };
}

describe("turn saving notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockTransport.retrySave).mockResolvedValue({ retried: false });
    resetThreadStoreForTests();
    resetThreadStoreForTests({ records: seedThreadRecord(pending.threadId, {
      runtimePhase: "completed", turnExecutionId: pending.executionId, savingStatus: failed, savingStatuses: [failed],
    }) });
  });

  it("keeps parent save recovery available on a child without restarting the child", async () => {
    resetThreadStoreForTests();
    resetThreadStoreForTests({ records: seedThreadRecord(pending.threadId, { runtimePhase: "completed", turnExecutionId: pending.executionId,
      canonicalAgent: { ...createCanonicalAgentReplica(), ownerThreadId: "parent-thread" } }) });
    const ownerFailure: TurnSavingStatus = { ...failed, executionId: "00000000-0000-4000-8000-000000000002" };
    useThreadStore.getState().setTurnSavingStatus(ownerFailure);
    vi.mocked(mockTransport.retrySave).mockResolvedValueOnce({ retried: true });
    render(<ConnectedSavingNotice />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry save" })).not.toBeDisabled());
    expect(mockTransport.retrySave).toHaveBeenCalledExactlyOnceWith(pending.threadId);
    expect(useThreadStore.getState().records.get(pending.threadId)?.runtimePhase).toBe("completed");
    expect(useThreadStore.getState().records.get(pending.threadId)?.turnExecutionId).toBe(pending.executionId);
    expect(useThreadStore.getState().records.get(pending.threadId)?.savingStatus).toBeNull();
    expect(useThreadStore.getState().records.get(pending.threadId)?.savingStatuses).toEqual([ownerFailure]);
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
  });

  it("closes an open command and removes the running footer when accepted worker loss interrupts a tools-only parent", async () => {
    const fixture = epochRecoveryFixture();
    const openTool = { id: "open-command", toolName: "Bash", toolInput: { command: "measure" },
      output: "Partial output", isError: false, isComplete: false, startedAt: Date.parse(pending.oldestPendingAt) };
    useThreadStore.setState({ records: seedThreadRecord(pending.threadId, { toolCalls: [openTool],
      thoughtSegments: [{ text: "Working", startedAt: Date.parse(pending.oldestPendingAt) }] }) });
    render(<ConnectedRuntimeNotice />);
    expect(screen.getByText("Running measure")).toBeInTheDocument();
    expect(getComposerSendButtonVisualState({ isThreadScaffold: false, isAgentRunning: true, isStopPending: false, hasContent: false })).toBe("stop");
    const payloads = [{ type: "execution.checkpoint" as const, operationKind: "worker-lost" as const },
      { type: "turn.response-bound" as const, messageId: "interrupted-response", outcome: "interrupted" as const, endedAt: pending.oldestPendingAt },
      { type: "turn.interrupted" as const, endedAt: pending.oldestPendingAt, reason: "Turn interrupted" }];
    await act(async () => {
      useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: pending.threadId, epoch: "old-epoch", from: 0, through: 3,
        events: payloads.map((payload, index) => ({ eventId: `lost-${index}`, routing: { threadId: pending.threadId, turnId: "turn", executionId: pending.executionId },
          sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: index + 1, progressPosition: { epoch: "old-epoch", sequence: index + 1 },
          serverTimestamps: { acceptedAt: pending.oldestPendingAt }, payload })) });
      useThreadStore.getState().setTurnSavingStatus({ ...fixture.failed, accepted: { epoch: "old-epoch", sequence: 3 }, saved: { epoch: "old-epoch", sequence: 0 }, pendingEvents: 3 });
    });
    const record = useThreadStore.getState().records.get(pending.threadId);
    expect(record?.runtimePhase).toBe("interrupted");
    expect(record?.toolCalls).toEqual([{ ...openTool, isComplete: true, isError: true }]);
    expect(record?.thoughtSegments[0]?.endedAt).toBeDefined();
    const running = useThreadStore.getState().runningThreadIds.has(pending.threadId);
    expect(running).toBe(false);
    expect(getComposerSendButtonVisualState({ isThreadScaffold: false, isAgentRunning: running, isStopPending: false, hasContent: false })).toBe("empty");
    await act(async () => {
      useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: pending.threadId, epoch: "old-epoch", from: 3, through: 4,
        events: [{ eventId: "lost-publication", routing: { threadId: pending.threadId, turnId: "turn", executionId: pending.executionId },
          sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: 4, progressPosition: { epoch: "old-epoch", sequence: 4 },
          serverTimestamps: { acceptedAt: pending.oldestPendingAt }, payload: { type: "publication.recorded", publicationId: "8",
            event: { type: "ended", threadId: pending.threadId, turnExecutionId: pending.executionId, outcome: "interrupted" } } }] });
    });
    expect(useThreadStore.getState().records.get(pending.threadId)?.toolCalls).toEqual(record?.toolCalls);
    expect(useThreadStore.getState().records.get(pending.threadId)?.runtimePhase).toBe("interrupted");
    await waitFor(() => expect(screen.queryByText("Running measure")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(useThreadStore.getState().records.get(pending.threadId)?.savingStatuses).not.toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps ordinary saving quiet", () => {
    render(<TurnSaveRecovery statuses={[{ ...pending, mode: "saving" }]} />);
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps automatic retries quiet and offers manual recovery without raw errors", () => {
    const status: TurnSavingStatus = { ...pending, mode: "save-retrying", failure: { name: "DatabaseError", kind: "transient", message: "Database is busy" } };
    const { rerender } = render(<TurnSaveRecovery statuses={[status]} />);
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
    rerender(<TurnSaveRecovery statuses={[{ ...status, mode: "saving-failed", failure: { ...status.failure, kind: "permanent", message: "Disk is full" } }]} />);
    expect(screen.getByRole("button", { name: "Retry save" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Disk is full|Database is busy/)).toBeNull();
  });

  it("discloses restart loss after pending work disappears", () => {
    render(<TurnSavingNotice lostProgress />);
    expect(screen.getByRole("alert").textContent).toContain("Progress that had not been saved was lost");
  });

  it("removes the recovery action once all retained executions are saved", () => {
    const { rerender } = render(<TurnSaveRecovery statuses={[failed]} />);
    expect(screen.getByRole("button", { name: "Retry save" })).toBeVisible();
    rerender(<TurnSaveRecovery statuses={[{ threadId: pending.threadId, executionId: pending.executionId, mode: "durable" }]} />);
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
  });

  it("fences retries for the same thread while pending and keeps failures when nothing was retried", async () => {
    let resolve: ((result: { retried: boolean }) => void) | undefined;
    vi.mocked(mockTransport.retrySave).mockImplementationOnce(() => new Promise((complete) => { resolve = complete; }));
    render(<TurnSaveRecovery statuses={[failed, { ...failed, executionId: "00000000-0000-4000-8000-000000000002" }]} />);
    const buttons = screen.getAllByRole("button", { name: "Retry save" });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[0]);
    expect(mockTransport.retrySave).toHaveBeenCalledExactlyOnceWith(pending.threadId);
    expect(screen.getAllByRole("button", { name: "Retrying save…" })).toHaveLength(1);
    for (const button of buttons) expect(button).toBeDisabled();
    const complete = resolve;
    if (!complete) throw new Error("missing retry request");
    await act(async () => { complete({ retried: false }); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry save" })).toHaveLength(1);
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(mockTransport.retryTurn).not.toHaveBeenCalled();
  });

  it("waits for saving-status pushes after a retry response and preserves the completed lifecycle", async () => {
    vi.mocked(mockTransport.retrySave).mockResolvedValueOnce({ retried: true });
    render(<ConnectedSavingNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry save" })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Retry save" })).toBeVisible();
    act(() => { useThreadStore.getState().setTurnSavingStatus({ ...failed, mode: "save-retrying" }); });
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
    act(() => { useThreadStore.getState().setTurnSavingStatus({ threadId: pending.threadId, executionId: pending.executionId, mode: "durable" }); });
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
    expect(useThreadStore.getState().records.get(pending.threadId)?.runtimePhase).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(pending.threadId)).toBe(false);
    expect(mockTransport.sendMessage).not.toHaveBeenCalled();
    expect(mockTransport.retryTurn).not.toHaveBeenCalled();
  });

  it("allows another retry after an RPC error without exposing storage diagnostics", async () => {
    vi.mocked(mockTransport.retrySave).mockRejectedValueOnce(new Error("Database is read-only"));
    render(<TurnSaveRecovery statuses={[failed]} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    expect(await screen.findByText("Save could not be retried. Try again.")).toBeVisible();
    expect(screen.queryByText(/Database is read-only|Disk is full/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry save" })).not.toBeDisabled();
  });

  it.each(["push", "snapshot"])("restores a new epoch failure received by %s before fenced recovery", (delivery) => {
    const fixture = epochRecoveryFixture();
    const store = useThreadStore.getState();
    const token = store.beginCanonicalRecovery([pending.threadId]);
    store.handleCanonicalProgress({ phase: "accepted", threadId: pending.threadId, epoch: "new-epoch", from: 0, through: 1, events: fixture.recovery.retained });
    if (delivery === "push") store.setTurnSavingStatus(fixture.failed);
    else store.hydrateThreadRuntimes([{ threadId: pending.threadId, turnExecutionId: pending.executionId, phase: "completed",
      savingStatus: "durable", savingStatuses: [fixture.failed] }]);
    render(<ConnectedSavingNotice />);
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
    act(() => { store.applyCanonicalReconnectRecoveries([fixture.recovery]); store.finishCanonicalRecovery(token); });
    const record = useThreadStore.getState().records.get(pending.threadId);
    expect(record?.runtimePhase).toBe("completed");
    expect(record?.canonicalAgent.progress?.epoch).toBe("new-epoch");
    expect(record?.savingStatuses).toEqual([fixture.failed]);
    expect(record?.pendingSavingStatuses).toEqual([]);
    expect(screen.getByRole("button", { name: "Retry save" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores a failure delivered after a new-epoch saved frame and before its recovery", () => {
    const fixture = epochRecoveryFixture();
    const terminal = fixture.recovery.retained[0];
    if (!terminal) throw new Error("missing terminal fixture");
    const status: TurnSavingStatus = { ...fixture.failed, accepted: { epoch: "new-epoch", sequence: 2 }, saved: { epoch: "new-epoch", sequence: 1 } };
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: pending.threadId, epoch: "new-epoch", through: 1,
      revision: { conversationRevision: 2, rosterRevision: 0 }, events: [{ ...terminal, durableRevision: 2, payload: { type: "turn.started", startedAt: pending.oldestPendingAt } }] });
    useThreadStore.getState().setTurnSavingStatus(status);
    expect(useThreadStore.getState().records.get(pending.threadId)?.canonicalAgent.recoveryRequired).toBe(true);
    render(<ConnectedSavingNotice />);
    expect(screen.queryByTestId("turn-save-recovery")).toBeNull();
    act(() => { useThreadStore.getState().applyCanonicalReconnectRecoveries([{ ...fixture.recovery, acceptedThrough: 2, savedThrough: 1,
      durable: { mode: "snapshot", threadId: pending.threadId, snapshot: { revision: { conversationRevision: 2, rosterRevision: 0 }, state: fixture.state } },
      retained: [{ ...terminal, acceptedSequence: 2, progressPosition: { epoch: "new-epoch", sequence: 2 } }] }]); });
    expect(useThreadStore.getState().records.get(pending.threadId)?.savingStatuses).toEqual([status]);
    expect(screen.getByRole("button", { name: "Retry save" })).toBeVisible();
  });

  it("rejects a retired epoch failure after validated replacement", () => {
    const fixture = epochRecoveryFixture();
    useThreadStore.getState().applyCanonicalReconnectRecoveries([fixture.recovery]);
    useThreadStore.getState().setTurnSavingStatus({ ...fixture.failed,
      accepted: { epoch: "old-epoch", sequence: 1 }, saved: { epoch: "old-epoch", sequence: 0 } });
    expect(useThreadStore.getState().records.get(pending.threadId)?.savingStatuses).toEqual([]);
    expect(useThreadStore.getState().records.get(pending.threadId)?.pendingSavingStatuses).toEqual([]);
  });
});
