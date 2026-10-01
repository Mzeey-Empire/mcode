import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRuntimeSnapshot, TurnSavingStatus } from "@mcode/contracts";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockThread, mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "followup-runtime";
const OTHER_THREAD_ID = "other-runtime";

function record() {
  return useThreadStore.getState().records.get(THREAD_ID);
}

function completeFirstTurn(): void {
  const handle = useThreadStore.getState().handleAgentEvent;
  handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "first" });
  handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "first", delta: "First reply" });
  handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "first", outcome: "completed" });
  expect(record()?.runtimePhase).toBe("completed");
}

describe("follow-up runtime ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(mockTransport.sendMessage).mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      activeThreadId: THREAD_ID,
      threads: [createMockThread({ id: THREAD_ID }), createMockThread({ id: OTHER_THREAD_ID })],
    });
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      runningThreadIds: new Set(),
      records: new Map([
        [THREAD_ID, createEmptyThreadRecord()],
        [OTHER_THREAD_ID, createEmptyThreadRecord()],
      ]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each<TurnRuntimeSnapshot["phase"]>(["running", "completed"])("preserves %s save failures through snapshots and reconnect", (phase) => {
    const failed: TurnSavingStatus = { threadId: THREAD_ID, executionId: "00000000-0000-4000-8000-000000000002", mode: "saving-failed",
      accepted: { epoch: "runtime-1", sequence: 2 }, saved: { epoch: "runtime-1", sequence: 0 },
      pendingEvents: 2, pendingBytes: 128, oldestPendingAt: "2026-09-30T12:00:00.000Z",
      failure: { kind: "permanent", name: "WriteError", message: "Unable to save accepted progress" } };
    const previous = { ...failed, executionId: "00000000-0000-4000-8000-000000000001" };
    const snapshot: TurnRuntimeSnapshot = { threadId: THREAD_ID, phase, turnExecutionId: failed.executionId,
      savingStatus: "durable", savingStatuses: [failed, previous] };
    useThreadStore.getState().applyThreadRuntimeSnapshot(snapshot);
    expect(record()?.savingStatus).toEqual(failed);
    expect(record()?.savingStatuses).toEqual([failed, previous]);

    useThreadStore.getState().hydrateThreadRuntimes([snapshot]);
    expect(record()?.runtimePhase).toBe(phase);
    expect(record()?.savingStatus).toEqual(failed);
    expect(record()?.savingStatuses).toEqual([failed, previous]);
  });

  it("completes a follow-up when the publication cursor write fails", async () => {
    completeFirstTurn();
    await useThreadStore.getState().sendMessage(THREAD_ID, "Second prompt");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("mcode-agent-publication-v2:")) throw new DOMException("quota", "QuotaExceededError");
      original.call(this, key, value);
    });
    const handle = useThreadStore.getState().handleAgentEvent;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second", publicationId: "1" });
    handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "second", publicationId: "2", delta: "Visible reply" });
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "second", publicationId: "3", outcome: "completed" });
    expect(record()?.runtimePhase).toBe("completed");
    expect(record()?.messages.map((message) => message.content)).toContain("Visible reply");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it.each([false, true])("completes a sent follow-up without file-effect metadata, background=%s", async (background) => {
    completeFirstTurn();
    expect(await useThreadStore.getState().sendMessage(THREAD_ID, "Second prompt")).toBe(true);
    expect(record()?.turnExecutionId).toBeNull();
    if (background) {
      useThreadStore.setState({ currentThreadId: OTHER_THREAD_ID });
      useWorkspaceStore.setState({ activeThreadId: OTHER_THREAD_ID });
    }

    const handle = useThreadStore.getState().handleAgentEvent;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second" });
    expect(record()?.turnExecutionId).toBe("second");
    handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "second", delta: "Second reply" });
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "second", outcome: "completed" });

    expect(record()?.runtimePhase).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
    expect(record()?.messages.map((message) => message.content)).toContain("Second reply");
    expect(record()?.messages.map((message) => message.content)).toContain("First reply");
    expect(useThreadStore.getState().records.get(OTHER_THREAD_ID)?.runtimePhase).toBe("idle");
  });

  it("retains the follow-up response on a duplicate start and ignores the previous turn's completion", async () => {
    completeFirstTurn();
    await useThreadStore.getState().sendMessage(THREAD_ID, "Second prompt");
    const handle = useThreadStore.getState().handleAgentEvent;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second" });
    handle({ type: "textDelta", threadId: THREAD_ID, turnExecutionId: "second", delta: "Kept reply" });
    handle({ type: "contextEstimate", threadId: THREAD_ID, turnExecutionId: "second", tokensIn: 20 });
    const responseKey = record()?.currentTurnResponseKey;
    handle({ type: "turnStarted", threadId: THREAD_ID, turnExecutionId: "second" });
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "first", outcome: "completed" });

    expect(record()?.turnExecutionId).toBe("second");
    expect(record()?.runtimePhase).toBe("running");
    expect(record()?.currentTurnResponseKey).toBe(responseKey);
    expect(record()?.streaming).toBe("Kept reply");
    handle({ type: "ended", threadId: THREAD_ID, turnExecutionId: "second", outcome: "completed" });
    expect(record()?.runtimePhase).toBe("completed");
  });
});
