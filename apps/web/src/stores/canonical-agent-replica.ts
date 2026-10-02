import {
  createAgentModelState,
  reduceAgentEventBatch,
  type AgentModelState,
  type AcceptedCanonicalAgentEventEnvelope,
  type CanonicalAgentEventEnvelope,
  type CanonicalAgentReconnectRecovery,
  type CanonicalAgentRevision,
} from "@mcode/contracts";

/** Renderer-owned replica of one thread's saved state and accepted progress. */
export interface CanonicalAgentReplica {
  /** Durable revisions and progress positions belong to this stream owner. */
  ownerThreadId: string | null;
  /** Visible state combines saved history with the retained accepted suffix. */
  state: AgentModelState;
  durableState: AgentModelState;
  revision: CanonicalAgentRevision;
  recoveryRequired: boolean;
  progress: {
    epoch: string;
    acceptedThrough: number;
    savedThrough: number;
    retained: readonly AcceptedCanonicalAgentEventEnvelope[];
  } | null;
  retiredEpochs: readonly string[];
  lostProgress: boolean;
  interruptedTurnIds: readonly string[];
}

/** Result of one ordered canonical replica update. */
export interface CanonicalAgentReplicaUpdate {
  replica: CanonicalAgentReplica;
  outcome: "applied" | "ignored" | "recovery-required";
  installedSnapshot: boolean;
}

/** Create an empty canonical replica for a thread with no installed durable state. */
export function createCanonicalAgentReplica(): CanonicalAgentReplica {
  const state = createAgentModelState();
  return {
    ownerThreadId: null,
    state,
    durableState: state,
    revision: { conversationRevision: 0, rosterRevision: 0 },
    recoveryRequired: false,
    progress: null,
    retiredEpochs: [],
    lostProgress: false,
    interruptedTurnIds: [],
  };
}

/** Install one reconnect recovery before later canonical push revisions are applied. */
export function applyCanonicalReconnectRecovery(
  current: CanonicalAgentReplica,
  recovery: CanonicalAgentReconnectRecovery,
): CanonicalAgentReplicaUpdate {
  if (recovery.mode === "snapshot") {
    const nextRevision = recovery.snapshot.revision;
    if (
      nextRevision.conversationRevision < current.revision.conversationRevision
      || nextRevision.rosterRevision < current.revision.rosterRevision
    ) {
      return { replica: current, outcome: "ignored", installedSnapshot: false };
    }
    return {
      replica: {
        ...current,
        state: recovery.snapshot.state,
        durableState: recovery.snapshot.state,
        revision: nextRevision,
        recoveryRequired: false,
      },
      outcome: "applied",
      installedSnapshot: true,
    };
  }

  if (!sameRevision(recovery.from, current.revision)) {
    if (revisionAtOrBefore(recovery.through, current.revision)) {
      return { replica: current, outcome: "ignored", installedSnapshot: false };
    }
    return recoveryRequired(current);
  }
  if (
    recovery.events.some((event) => event.routing.threadId !== recovery.threadId)
    || !hasContiguousRevisions(
      recovery.events.map((event) => event.durableRevision),
      recovery.from.conversationRevision,
      recovery.through.conversationRevision,
    )
    || !hasContiguousRevisions(
      recovery.events.flatMap((event) =>
        event.rosterRevision === undefined ? [] : [event.rosterRevision]
      ),
      recovery.from.rosterRevision,
      recovery.through.rosterRevision,
    )
  ) {
    return recoveryRequired(current);
  }
  return applyCanonicalEvents(current, recovery.events, recovery.through);
}

/** Apply one live canonical batch only when its durable revisions are contiguous. */
export function applyCanonicalPushEvents(
  current: CanonicalAgentReplica,
  threadId: string,
  events: readonly CanonicalAgentEventEnvelope[],
): CanonicalAgentReplicaUpdate {
  if (events.length === 0) {
    return { replica: current, outcome: "ignored", installedSnapshot: false };
  }
  if (events.some((event) => event.routing.threadId !== threadId)) {
    return recoveryRequired(current);
  }
  const through = events.reduce<CanonicalAgentRevision>((revision, event) => ({
    conversationRevision: Math.max(revision.conversationRevision, event.durableRevision),
    rosterRevision: Math.max(revision.rosterRevision, event.rosterRevision ?? revision.rosterRevision),
  }), current.revision);
  if (!hasContiguousRevisions(
    events.map((event) => event.durableRevision),
    current.revision.conversationRevision,
    through.conversationRevision,
  ) || !hasContiguousRevisions(
    events.flatMap((event) => event.rosterRevision === undefined ? [] : [event.rosterRevision]),
    current.revision.rosterRevision,
    through.rosterRevision,
  )) {
    return recoveryRequired(current);
  }
  const applicable = events.filter((event) =>
    event.durableRevision >= current.revision.conversationRevision
    || (event.rosterRevision !== undefined
      && event.rosterRevision >= current.revision.rosterRevision)
  );
  return applyCanonicalEvents(current, applicable, through);
}

function applyCanonicalEvents(
  current: CanonicalAgentReplica,
  events: readonly CanonicalAgentEventEnvelope[],
  through: CanonicalAgentRevision,
): CanonicalAgentReplicaUpdate {
  if (events.length === 0) {
    return {
      replica: { ...current, revision: through, recoveryRequired: false },
      outcome: sameRevision(current.revision, through) ? "ignored" : "applied",
      installedSnapshot: false,
    };
  }
  const reduction = reduceAgentEventBatch(current.durableState, events);
  if (reduction.outcome === "rejected") return recoveryRequired(current);
  return {
    replica: {
      ...current,
      state: reduction.state,
      durableState: reduction.state,
      revision: through,
      recoveryRequired: false,
    },
    outcome: "applied",
    installedSnapshot: false,
  };
}

function recoveryRequired(current: CanonicalAgentReplica): CanonicalAgentReplicaUpdate {
  return {
    replica: current.recoveryRequired ? current : { ...current, recoveryRequired: true },
    outcome: "recovery-required",
    installedSnapshot: false,
  };
}

function sameRevision(left: CanonicalAgentRevision, right: CanonicalAgentRevision): boolean {
  return left.conversationRevision === right.conversationRevision
    && left.rosterRevision === right.rosterRevision;
}

function revisionAtOrBefore(left: CanonicalAgentRevision, right: CanonicalAgentRevision): boolean {
  return left.conversationRevision <= right.conversationRevision
    && left.rosterRevision <= right.rosterRevision;
}

function hasContiguousRevisions(
  revisions: readonly number[],
  from: number,
  through: number,
): boolean {
  if (through < from) return false;
  const laterRevisions = [...new Set(revisions)]
    .filter((revision) => revision > from)
    .sort((left, right) => left - right);
  if (laterRevisions.some((revision) => revision > through)) return false;
  if (from === through) return laterRevisions.length === 0;
  let expected = from + 1;
  for (const revision of laterRevisions) {
    if (revision !== expected) return false;
    expected += 1;
  }
  return expected === through + 1;
}
