import { CANONICAL_AGENT_PROGRESS_RECOVERY_MAX, CanonicalAgentProgressFrameSchema, type CanonicalAgentProgressFrame, type CanonicalAgentProgressRecovery } from "@mcode/contracts/models/canonical-agent-progress";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import { reduceAgentEventBatch, type AgentItem, type AgentModelState, type AcceptedCanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import {
  applyCanonicalPushEvents,
  applyCanonicalReconnectRecovery,
  type CanonicalAgentReplica,
  type CanonicalAgentReplicaUpdate,
} from "./canonical-agent-replica";

/** A progress update separates first live effects from state-only save and recovery updates. */
export interface CanonicalProgressUpdate extends CanonicalAgentReplicaUpdate {
  /** Provider pieces to show now; present only for an applied live frame, which changes no saved state. */
  liveEvents?: readonly AgentEvent[];
  publications: readonly AcceptedCanonicalAgentEventEnvelope[];
}

type LiveChildTextPiece = NonNullable<Extract<CanonicalAgentProgressFrame, { phase: "live" }>["childText"]>[number];

function result(replica: CanonicalAgentReplica, outcome: CanonicalProgressUpdate["outcome"], publications: readonly AcceptedCanonicalAgentEventEnvelope[] = [], installedSnapshot = false): CanonicalProgressUpdate {
  return { replica, outcome, publications, installedSnapshot };
}

function gap(current: CanonicalAgentReplica): CanonicalProgressUpdate {
  return result({ ...current, recoveryRequired: true }, "recovery-required");
}

function compactProgressState(state: AgentModelState): AgentModelState {
  const appliedEventIds: AgentModelState["appliedEventIds"] = {};
  const acceptedInputEventIds: AgentModelState["acceptedInputEventIds"] = {};
  // Epoch cursors fence older deliveries. Keep the latest identity so reusing
  // its accepted sequence still conflicts without copying the whole turn per delta.
  for (const [executionId, sequence] of Object.entries(state.lastAcceptedSequenceByExecution)) {
    const inputKey = `${executionId}:${sequence}`;
    const eventId = state.acceptedInputEventIds[inputKey];
    if (eventId === undefined) continue;
    appliedEventIds[eventId] = true;
    acceptedInputEventIds[inputKey] = eventId;
  }
  return { ...state, appliedEventIds, acceptedInputEventIds };
}

function project(current: CanonicalAgentReplica): CanonicalProgressUpdate {
  const reduced = reduceAgentEventBatch(current.durableState, current.progress?.retained ?? []);
  if (reduced.outcome === "rejected") return gap(current);
  const turns = { ...reduced.state.turns };
  for (const id of current.interruptedTurnIds) {
    const turn = turns[id];
    if (turn && (turn.status === "Pending" || turn.status === "Running")) turns[id] = { ...turn, status: "Interrupted" };
  }
  return result({ ...current, state: compactProgressState({ ...reduced.state, turns }) }, "applied");
}

function accepted(current: CanonicalAgentReplica, frame: Extract<CanonicalAgentProgressFrame, { phase: "accepted" }>): CanonicalProgressUpdate {
  const progress = current.progress ?? { epoch: frame.epoch, acceptedThrough: 0, savedThrough: 0, retained: [] };
  if (progress.epoch !== frame.epoch || frame.from > progress.acceptedThrough) return gap(current);
  if (frame.through <= progress.acceptedThrough) return result(current, "ignored");
  const fresh = frame.events.filter((event) => event.progressPosition.sequence > progress.acceptedThrough);
  const retained = [...progress.retained, ...fresh.filter((event) => event.progressPosition.sequence > progress.savedThrough)];
  if (retained.length > CANONICAL_AGENT_PROGRESS_RECOVERY_MAX) return gap(current);
  const toReduce = fresh.filter((event) => event.progressPosition.sequence > progress.savedThrough
    || event.acceptedSequence === current.state.lastAcceptedSequenceByExecution[event.routing.executionId]);
  const reduced = reduceAgentEventBatch(current.state, toReduce);
  if (reduced.outcome === "rejected") return gap(current);
  // Live progress cannot repair a missing durable admission or revision.
  return result({ ...current, state: compactProgressState(reduced.state), progress: { ...progress, acceptedThrough: frame.through, retained } }, "applied", fresh);
}

function saved(current: CanonicalAgentReplica, frame: Extract<CanonicalAgentProgressFrame, { phase: "saved" }>): CanonicalProgressUpdate {
  const progress = current.progress ?? { epoch: frame.epoch, acceptedThrough: 0, savedThrough: 0, retained: [] };
  if (progress.epoch !== frame.epoch) return gap(current);
  if (!contiguousSavedPrefix(progress.savedThrough, frame)) return gap(current);
  const events = frame.events.filter((event) => {
    if (event.progressPosition) return event.progressPosition.sequence > progress.savedThrough;
    return event.durableRevision > current.revision.conversationRevision
      || (event.rosterRevision ?? 0) > current.revision.rosterRevision;
  });
  const durable = applyCanonicalPushEvents(current, frame.ownerThreadId ?? frame.threadId, events);
  if (durable.outcome === "recovery-required") return { ...durable, publications: [] };
  if (durable.replica.revision.conversationRevision !== frame.revision.conversationRevision
    || durable.replica.revision.rosterRevision !== frame.revision.rosterRevision) {
    if (frame.through <= progress.savedThrough) return result(current, "ignored");
    return gap(current);
  }
  const through = Math.max(progress.savedThrough, frame.through);
  const durableState = compactProgressState(durable.replica.durableState);
  const next = { ...durable.replica, state: durableState, durableState, progress: { ...progress, savedThrough: through, retained: progress.retained.filter((event) => event.progressPosition.sequence > through) } };
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

function ownedReplica(current: CanonicalAgentReplica, ownerThreadId: string): CanonicalAgentReplica | undefined {
  if (current.ownerThreadId === ownerThreadId) return current;
  return current.ownerThreadId ? undefined : { ...current, ownerThreadId };
}

/**
 * Live pieces have no position, so they are shown only right after the accepted position the server sent them at.
 * One that misses is dropped, not a gap: the next saved checkpoint carries its text. Positions never move here.
 */
function live(current: CanonicalAgentReplica, frame: Extract<CanonicalAgentProgressFrame, { phase: "live" }>): CanonicalProgressUpdate {
  const progress = current.progress;
  if (current.recoveryRequired || progress?.epoch !== frame.epoch || progress.acceptedThrough !== frame.after) {
    return result(current, "ignored");
  }
  const state = frame.childText ? withLiveChildText(current.state, frame.childText) : current.state;
  return { ...result(state === current.state ? current : { ...current, state }, "applied"), liveEvents: frame.events };
}

/**
 * Child text grows the shown copy of its child message in place, and the next checkpoint replaces that message with
 * its saved record. Text that does not follow the shown copy exactly is left for that checkpoint, never guessed at.
 */
function withLiveChildText(state: AgentModelState, pieces: readonly LiveChildTextPiece[]): AgentModelState {
  let items = state.items;
  for (const piece of pieces) {
    const grown = grownMessage(items[piece.itemId], piece);
    if (!grown) continue;
    if (items === state.items) items = { ...items };
    items[piece.itemId] = grown;
  }
  return items === state.items ? state : { ...state, items };
}

function grownMessage(item: AgentItem | undefined, piece: LiveChildTextPiece): AgentItem | undefined {
  if (item?.threadId !== piece.threadId || item.payload.projection !== "message") return undefined;
  const message = item.payload.message;
  if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
  const content = message.content;
  return typeof content === "string" && content.length === piece.at
    ? { ...item, payload: { ...item.payload, message: { ...message, content: content + piece.delta } } } : undefined;
}

/** Apply the unified progress protocol without dispatching save receipts or recovery effects. */
export function applyCanonicalProgressFrame(current: CanonicalAgentReplica, frame: CanonicalAgentProgressFrame): CanonicalProgressUpdate {
  if (!CanonicalAgentProgressFrameSchema().safeParse(frame).success) return gap(current);
  if (current.retiredEpochs.includes(frame.epoch)) return result(current, "ignored");
  const owned = ownedReplica(current, frame.ownerThreadId ?? frame.threadId);
  if (!owned) return gap(current);
  switch (frame.phase) {
    case "live": return live(owned, frame);
    case "accepted": return accepted(owned, frame);
    case "saved": return saved(owned, frame);
    case "recovery": return recovery(owned, frame);
  }
}
