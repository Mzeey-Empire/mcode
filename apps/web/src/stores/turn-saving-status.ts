import type { TurnRuntimeSnapshot, TurnSavingStatus } from "@mcode/contracts";
import type { ThreadRecord } from "./thread-record";

type SavingPatch = Pick<ThreadRecord, "savingStatus" | "savingStatuses" | "pendingSavingStatuses">;

function currentSavingPatch(record: ThreadRecord): SavingPatch {
  return { savingStatus: record.savingStatus, savingStatuses: record.savingStatuses, pendingSavingStatuses: record.pendingSavingStatuses };
}

function sameSavingIdentity(left: TurnSavingStatus, right: TurnSavingStatus): boolean {
  return left.executionId === right.executionId && "accepted" in left && "accepted" in right && left.accepted.epoch === right.accepted.epoch;
}

function bufferSavingStatus(record: ThreadRecord, status: TurnSavingStatus): SavingPatch {
  const current = currentSavingPatch(record);
  if (!("accepted" in status) || record.canonicalAgent.retiredEpochs.includes(status.accepted.epoch)) return current;
  const previous = record.pendingSavingStatuses.find((candidate) => sameSavingIdentity(candidate, status));
  if (previous && staleSavingStatus(previous, status)) return current;
  return { ...current, pendingSavingStatuses: [...record.pendingSavingStatuses.filter((candidate) => !sameSavingIdentity(candidate, status)), status].slice(-128) };
}

/** Keeps completed executions' saving work separate from the current execution. */
export function mergeTurnSavingStatus(record: ThreadRecord, status: TurnSavingStatus): SavingPatch {
  if (savedCutCoversStatus(record, status)) return reconcileSavedTurnStatuses(record);
  if ("accepted" in status && record.canonicalAgent.progress && status.accepted.epoch !== record.canonicalAgent.progress.epoch) {
    return bufferSavingStatus(record, status);
  }
  const previous = record.savingStatuses.find((candidate) => candidate.executionId === status.executionId);
  if (previous && staleSavingStatus(previous, status)) {
    return currentSavingPatch(record);
  }
  const savingStatuses = [...record.savingStatuses.filter((candidate) => candidate.executionId !== status.executionId), status].slice(-128);
  return {
    savingStatuses,
    savingStatus: status.executionId === record.turnExecutionId ? status : record.savingStatus,
    pendingSavingStatuses: record.pendingSavingStatuses,
  };
}

function staleSavingStatus(previous: TurnSavingStatus, status: TurnSavingStatus): boolean {
  if (!("accepted" in previous) || !("accepted" in status)) return false;
  return previous.accepted.epoch === status.accepted.epoch
    && (status.accepted.sequence < previous.accepted.sequence || status.saved.sequence < previous.saved.sequence);
}

function savedCutCoversStatus(record: ThreadRecord, status: TurnSavingStatus, drainedEpoch?: string): boolean {
  const progress = record.canonicalAgent.progress;
  return "accepted" in status && (status.accepted.epoch === drainedEpoch
    || (progress !== null && status.accepted.epoch === progress.epoch && status.accepted.sequence <= progress.savedThrough));
}

/** Clears notices covered by the saved prefix or a generation drained before loss-free recovery. */
export function reconcileSavedTurnStatuses(record: ThreadRecord, drainedEpoch?: string): SavingPatch {
  const epoch = record.canonicalAgent.progress?.epoch;
  const pending = record.pendingSavingStatuses.filter((status) => "accepted" in status
    && status.accepted.epoch !== drainedEpoch && !record.canonicalAgent.retiredEpochs.includes(status.accepted.epoch));
  const ready = pending.filter((status) => "accepted" in status && status.accepted.epoch === epoch);
  let next: SavingPatch = {
    savingStatuses: record.savingStatuses.filter((status) => !savedCutCoversStatus(record, status, drainedEpoch)),
    savingStatus: record.savingStatus && !savedCutCoversStatus(record, record.savingStatus, drainedEpoch) ? record.savingStatus : null,
    pendingSavingStatuses: pending.filter((status) => !ready.includes(status)),
  };
  for (const status of ready) next = mergeTurnSavingStatus({ ...record, ...next }, status);
  return next;
}

/** Scalar snapshots only reconstruct legacy statuses; pending modes require their correlated metrics. */
export function savingSnapshotPatch(record: ThreadRecord, snapshot: TurnRuntimeSnapshot): SavingPatch {
  let next = currentSavingPatch(record);
  const statuses = snapshot.savingStatuses ?? [];
  for (const status of statuses) next = mergeTurnSavingStatus({ ...record, ...next, turnExecutionId: snapshot.turnExecutionId }, status);
  const mode = snapshot.savingStatus;
  const hasCorrelatedStatus = statuses.some((status) => status.executionId === snapshot.turnExecutionId)
    || next.savingStatuses.some((status) => status.executionId === snapshot.turnExecutionId && "accepted" in status);
  if (snapshot.turnExecutionId && !hasCorrelatedStatus && (mode === "durable" || mode === "saving-delayed" || mode === "unsaved" || mode === "stopping")) {
    next = mergeTurnSavingStatus({ ...record, ...next, turnExecutionId: snapshot.turnExecutionId }, { threadId: snapshot.threadId, executionId: snapshot.turnExecutionId, mode });
  }
  return reconcileSavedTurnStatuses({ ...record, ...next });
}
