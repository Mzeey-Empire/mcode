import { describe, expect, it } from "vitest";
import type { TurnRuntimeSnapshot, TurnSavingStatus } from "@mcode/contracts";
import { createEmptyThreadRecord } from "./thread-record";
import { mergeTurnSavingStatus, savingSnapshotPatch } from "./turn-saving-status";

const CURRENT = "00000000-0000-4000-8000-000000000002";
const PREVIOUS = "00000000-0000-4000-8000-000000000001";

function saving(executionId = CURRENT, accepted = 2, saved = 0): Extract<TurnSavingStatus, { mode: "saving" }> {
  return { threadId: "thread-1", executionId, mode: "saving", accepted: { epoch: "runtime-1", sequence: accepted },
    saved: { epoch: "runtime-1", sequence: saved }, pendingEvents: accepted - saved, pendingBytes: 128, oldestPendingAt: "2026-09-30T12:00:00.000Z" };
}

describe("correlated turn saving status", () => {
  it("keeps a completed execution visible while a new turn runs", () => {
    const record = { ...createEmptyThreadRecord(), turnExecutionId: CURRENT };
    const active = mergeTurnSavingStatus(record, saving());
    const previous = mergeTurnSavingStatus({ ...record, ...active }, saving(PREVIOUS));
    expect(previous.savingStatus?.executionId).toBe(CURRENT);
    expect(previous.savingStatuses.map((status) => status.executionId)).toEqual([CURRENT, PREVIOUS]);
    const receipt = mergeTurnSavingStatus({ ...record, ...previous }, { threadId: "thread-1", executionId: PREVIOUS, mode: "durable" });
    expect(receipt.savingStatus?.mode).toBe("saving");
    expect(receipt.savingStatuses.find((status) => status.executionId === PREVIOUS)?.mode).toBe("durable");
  });

  it("ignores stale progress health updates for the same execution", () => {
    const record = { ...createEmptyThreadRecord(), turnExecutionId: CURRENT };
    const fresh = mergeTurnSavingStatus(record, saving(CURRENT, 9, 5));
    const stale = mergeTurnSavingStatus({ ...record, ...fresh }, saving(CURRENT, 8, 4));
    expect(stale).toEqual(fresh);
  });

  it("hydrates full completed execution statuses when the active execution is empty", () => {
    const patch = savingSnapshotPatch(createEmptyThreadRecord(), { threadId: "thread-1", phase: "completed", turnExecutionId: null, savingStatuses: [saving(PREVIOUS)] });
    expect(patch.savingStatuses).toEqual([saving(PREVIOUS)]);
  });

  it.each<TurnRuntimeSnapshot["phase"]>(["running", "completed"])("keeps explicit failed saves over legacy durable during %s reconnect", (phase) => {
    const record = { ...createEmptyThreadRecord(), turnExecutionId: CURRENT };
    const failed: TurnSavingStatus = { ...saving(), mode: "saving-failed",
      failure: { kind: "permanent", name: "WriteError", message: "Unable to save accepted progress" } };
    const previous = { ...failed, executionId: PREVIOUS };
    const snapshot: TurnRuntimeSnapshot = { threadId: "thread-1", phase, turnExecutionId: CURRENT,
      savingStatus: "durable", savingStatuses: [failed, previous] };
    const hydrated = savingSnapshotPatch(record, snapshot);
    const reconnected = savingSnapshotPatch({ ...record, ...hydrated }, snapshot);
    expect(hydrated.savingStatus).toEqual(failed);
    expect(hydrated.savingStatuses).toEqual([failed, previous]);
    expect(reconnected).toEqual(hydrated);
  });

  it("does not invent metrics from a scalar pending mode", () => {
    const patch = savingSnapshotPatch(createEmptyThreadRecord(), { threadId: "thread-1", phase: "completed", turnExecutionId: CURRENT, savingStatus: "save-retrying" });
    expect(patch.savingStatus).toBeNull();
    expect(patch.savingStatuses).toEqual([]);
  });
});
