import {
  CANONICAL_AGENT_PROGRESS_RECOVERY_MAX,
  CanonicalAgentProgressFrameSchema,
  reduceAgentEventBatch,
  type AcceptedCanonicalAgentEventEnvelope,
  type CanonicalAgentProgressFrame,
  type CanonicalAgentProgressRecovery,
} from "@mcode/contracts";
import {
  applyCanonicalPushEvents,
  applyCanonicalReconnectRecovery,
  type CanonicalAgentReplica,
  type CanonicalAgentReplicaUpdate,
} from "./canonical-agent-replica";

/** A progress update separates first live effects from state-only save and recovery updates. */
export interface CanonicalProgressUpdate extends CanonicalAgentReplicaUpdate {
  publications: readonly AcceptedCanonicalAgentEventEnvelope[];
}

function result(replica: CanonicalAgentReplica, outcome: CanonicalProgressUpdate["outcome"], publications: readonly AcceptedCanonicalAgentEventEnvelope[] = [], installedSnapshot = false): CanonicalProgressUpdate {
  return { replica, outcome, publications, installedSnapshot };
}

function gap(current: CanonicalAgentReplica): CanonicalProgressUpdate {
  return result({ ...current, recoveryRequired: true }, "recovery-required");
}

function project(current: CanonicalAgentReplica): CanonicalProgressUpdate {
  const reduced = reduceAgentEventBatch(current.durableState, current.progress?.retained ?? []);
  if (reduced.outcome === "rejected") return gap(current);
  const turns = { ...reduced.state.turns };
  for (const id of current.interruptedTurnIds) {
    const turn = turns[id];
    if (turn && (turn.status === "Pending" || turn.status === "Running")) turns[id] = { ...turn, status: "Interrupted" };
  }
  return result({ ...current, state: { ...reduced.state, turns } }, "applied");
}

function accepted(current: CanonicalAgentReplica, frame: Extract<CanonicalAgentProgressFrame, { phase: "accepted" }>): CanonicalProgressUpdate {
  const progress = current.progress ?? { epoch: frame.epoch, acceptedThrough: 0, savedThrough: 0, retained: [] };
  if (progress.epoch !== frame.epoch || frame.from > progress.acceptedThrough) return gap(current);
  if (frame.through <= progress.acceptedThrough) return result(current, "ignored");
  const fresh = frame.events.filter((event) => event.progressPosition.sequence > progress.acceptedThrough);
  const retained = [...progress.retained, ...fresh.filter((event) => event.progressPosition.sequence > progress.savedThrough)];
  if (retained.length > CANONICAL_AGENT_PROGRESS_RECOVERY_MAX) return gap(current);
  const reduced = reduceAgentEventBatch(current.state, fresh);
  if (reduced.outcome === "rejected") return gap(current);
  // Live progress cannot repair a missing durable admission or revision.
  return result({ ...current, state: reduced.state, progress: { ...progress, acceptedThrough: frame.through, retained } }, "applied", fresh);
}

function saved(current: CanonicalAgentReplica, frame: Extract<CanonicalAgentProgressFrame, { phase: "saved" }>): CanonicalProgressUpdate {
  const progress = current.progress ?? { epoch: frame.epoch, acceptedThrough: 0, savedThrough: 0, retained: [] };
  if (progress.epoch !== frame.epoch) return gap(current);
  if (!contiguousSavedPrefix(progress.savedThrough, frame)) return gap(current);
  const durable = applyCanonicalPushEvents(current, frame.ownerThreadId ?? frame.threadId, frame.events);
  if (durable.outcome === "recovery-required") return { ...durable, publications: [] };
  if (durable.replica.revision.conversationRevision !== frame.revision.conversationRevision
    || durable.replica.revision.rosterRevision !== frame.revision.rosterRevision) {
    if (frame.through <= progress.savedThrough) return result(current, "ignored");
    return gap(current);
  }
  const through = Math.max(progress.savedThrough, frame.through);
  const next = { ...durable.replica, progress: { ...progress, savedThrough: through, retained: progress.retained.filter((event) => event.progressPosition.sequence > through) } };
  // A validated receipt for already accepted events changes save health, not visible content.
  return acknowledgesAcceptedPrefix(progress, frame)
    ? result({ ...next, state: current.state }, "applied")
    : project(next);
}

function acknowledgesAcceptedPrefix(progress: NonNullable<CanonicalAgentReplica["progress"]>, frame: Extract<CanonicalAgentProgressFrame, { phase: "saved" }>): boolean {
  return frame.through <= progress.acceptedThrough && frame.events.every((event) =>
    event.progressPosition?.epoch === progress.epoch && event.progressPosition.sequence <= progress.acceptedThrough);
}

function contiguousSavedPrefix(from: number, frame: Extract<CanonicalAgentProgressFrame, { phase: "saved" }>): boolean {
  if (frame.through <= from) return true;
  const positions = [...new Set(frame.events.flatMap((event) => event.progressPosition?.epoch === frame.epoch ? [event.progressPosition.sequence] : []))]
    .filter((sequence) => sequence > from).sort((left, right) => left - right);
  return positions.length === frame.through - from && positions.every((sequence, index) => sequence === from + index + 1);
}

function recovery(current: CanonicalAgentReplica, frame: CanonicalAgentProgressRecovery): CanonicalProgressUpdate {
  const durable = applyCanonicalReconnectRecovery(current, frame.durable);
  if (durable.outcome === "recovery-required") return { ...durable, publications: [] };
  if (durable.outcome === "ignored" && frame.durable.mode === "snapshot") return result(current, "ignored");
  const recovered = {
    ...durable.replica,
    progress: recoveredProgress(current, frame),
    retiredEpochs: current.progress && current.progress.epoch !== frame.epoch ? [...current.retiredEpochs, current.progress.epoch].slice(-8) : current.retiredEpochs,
    lostProgress: current.lostProgress || frame.loss === "runtime-restarted",
    interruptedTurnIds: interruptedTurns(durable.replica, frame),
    recoveryRequired: false,
  };
  if (confirmsRenderedProgress(current, frame)) {
    return result({ ...recovered, state: current.state }, "applied", [], durable.installedSnapshot);
  }
  const next = project(recovered);
  return { ...next, installedSnapshot: durable.installedSnapshot };
}

function recoveredProgress(current: CanonicalAgentReplica, frame: CanonicalAgentProgressRecovery): NonNullable<CanonicalAgentReplica["progress"]> {
  const previous = current.progress?.epoch === frame.epoch ? current.progress : null;
  // Pushes received after the cut are retained when a response races live delivery.
  const later = previous?.retained.filter((event) => event.progressPosition.sequence > frame.acceptedThrough) ?? [];
  const savedThrough = Math.max(previous?.savedThrough ?? 0, frame.savedThrough);
  const retained = [...frame.retained, ...later].filter((event) => event.progressPosition.sequence > savedThrough);
  return { epoch: frame.epoch, acceptedThrough: Math.max(frame.acceptedThrough, previous?.acceptedThrough ?? 0), savedThrough, retained };
}

function confirmsRenderedProgress(current: CanonicalAgentReplica, frame: CanonicalAgentProgressRecovery): boolean {
  const progress = current.progress;
  // A matching live suffix does not make an incomplete durable base safe to preserve.
  if (current.recoveryRequired || !progress || progress.epoch !== frame.epoch || frame.loss !== "none" || progress.acceptedThrough < frame.acceptedThrough) return false;
  return frame.retained.every((event) =>
    event.progressPosition.sequence <= progress.savedThrough
    || progress.retained.some((accepted) => sameAcceptedEvent(accepted, event)));
}

function sameAcceptedEvent(left: AcceptedCanonicalAgentEventEnvelope, right: AcceptedCanonicalAgentEventEnvelope): boolean {
  return left.eventId === right.eventId
    && left.progressPosition.epoch === right.progressPosition.epoch
    && left.progressPosition.sequence === right.progressPosition.sequence
    && left.routing.threadId === right.routing.threadId
    && left.routing.turnId === right.routing.turnId
    && left.routing.executionId === right.routing.executionId
    && left.payload.type === right.payload.type;
}

function interruptedTurns(current: CanonicalAgentReplica, frame: CanonicalAgentProgressRecovery): readonly string[] {
  if (frame.loss !== "runtime-restarted") return current.interruptedTurnIds;
  const interrupted = Object.values(current.durableState.turns)
    .filter((turn) => turn.threadId === frame.threadId && (turn.status === "Running" || turn.status === "Pending"))
    .map((turn) => turn.id);
  return [...new Set([...current.interruptedTurnIds, ...interrupted])].slice(-128);
}

/** Apply the unified progress protocol without dispatching save receipts or recovery effects. */
export function applyCanonicalProgressFrame(current: CanonicalAgentReplica, frame: CanonicalAgentProgressFrame): CanonicalProgressUpdate {
  if (!CanonicalAgentProgressFrameSchema().safeParse(frame).success) return gap(current);
  if (current.retiredEpochs.includes(frame.epoch)) return result(current, "ignored");
  const ownerThreadId = frame.ownerThreadId ?? frame.threadId;
  if (current.ownerThreadId && current.ownerThreadId !== ownerThreadId) return gap(current);
  const owned = current.ownerThreadId === ownerThreadId ? current : { ...current, ownerThreadId };
  switch (frame.phase) {
    case "accepted": return accepted(owned, frame);
    case "saved": return saved(owned, frame);
    case "recovery": return recovery(owned, frame);
  }
}
