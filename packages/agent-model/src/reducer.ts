import { z } from "zod";
import { bindResponseItems } from "./response-binding.js";
import { applyCollaborationObservation } from "./collaboration-observation.js";
import { appendItemContent } from "./item-content-append.js";
import { CanonicalAgentSemanticEnvelopeSchema } from "./events.js";
import {
  AgentItemSchema,
  AgentThreadSchema,
  type AgentTurnEnding,
  AgentTurnSchema,
  type AgentTurnStatus,
  CollaborationActionSchema,
} from "./records.js";

/** Canonical in-memory state consumed and produced by the pure reducer. */
export const AgentModelStateSchema = z
  .object({
    threads: z.record(AgentThreadSchema),
    turns: z.record(AgentTurnSchema),
    items: z.record(AgentItemSchema),
    collaborationActions: z.record(CollaborationActionSchema),
    appliedEventIds: z.record(z.literal(true)),
    acceptedInputEventIds: z.record(z.string().min(1)),
    lastAcceptedSequenceByExecution: z.record(z.number().int().positive()),
  })
  .strict();
/** Canonical in-memory state consumed and produced by the pure reducer. */
export type AgentModelState = z.infer<typeof AgentModelStateSchema>;

/** Observable result of one pure canonical reducer step. */
export type AgentReducerResult = {
  state: AgentModelState;
  outcome:
    | "applied"
    | "duplicate"
    | "terminal-outcome-confirmed"
    | "routing-conflict"
    | "sequence-conflict";
};

/** Atomic result of reducing one bounded semantic event batch. */
export type AgentBatchReduction =
  | {
      outcome: "applied";
      state: AgentModelState;
      appliedCount: number;
      duplicateCount: number;
      ignoredTerminalCount: number;
    }
  | {
      outcome: "rejected";
      state: AgentModelState;
      eventId: string;
      reason: "routing-conflict" | "sequence-conflict";
    };

/** Atomic result of reducing a batch into a state the caller owns and lets this module mutate in place. */
export type OwnedBatchReduction =
  | {
      outcome: "applied";
      appliedCount: number;
      duplicateCount: number;
      ignoredTerminalCount: number;
      /** Undo this batch exactly; roll back later batches first. Calling it again does nothing. */
      rollback(): void;
    }
  | {
      /** The state is already back to how it was before the batch. */
      outcome: "rejected";
      eventId: string;
      reason: "routing-conflict" | "sequence-conflict";
    };

const TERMINAL_TURN_STATUSES: ReadonlySet<AgentTurnStatus> = new Set([
  "Completed",
  "Cancelled",
  "Interrupted",
  "Errored",
]);

type AgentEvent = z.infer<typeof CanonicalAgentSemanticEnvelopeSchema>;
type AgentEventPayload = AgentEvent["payload"];
type AgentEventType = AgentEventPayload["type"];
type AgentEventFor<TType extends AgentEventType> = AgentEvent & {
  payload: Extract<AgentEventPayload, { type: TType }>;
};
type AgentModelMapName = keyof AgentModelState;
type AgentModelMaps = Record<AgentModelMapName, Record<string, unknown>>;
/** One state change: a single key, or a whole replacement map for the rare events that rewrite many records. */
type AgentModelWrite = {
  [Name in AgentModelMapName]:
    | { readonly map: Name; readonly key: string; readonly value: AgentModelState[Name][string] }
    | { readonly map: Name; readonly replacement: AgentModelState[Name] };
}[AgentModelMapName];
/** A validated event's outcome and the writes it makes, before either the pure or the owned path applies them. */
type AgentEventDecision = { readonly outcome: AgentReducerResult["outcome"]; readonly writes: readonly AgentModelWrite[] };
type AgentEventReducer = (
  state: AgentModelState,
  event: AgentEvent,
  acceptedInput: readonly AgentModelWrite[],
) => AgentEventDecision;

const AGENT_EVENT_REDUCERS: Record<AgentEventType, AgentEventReducer> = {
  "collaboration.observed": reduceCollaborationObserved,
  "execution.checkpoint": (_state, _event, acceptedInput) => reduceVolatileTruncation(acceptedInput),
  "turn.response-bound": (state, event, acceptedInput) => reduceResponseBound(state, event, acceptedInput),
  "thread.recorded": (_state, event, acceptedInput) =>
    reduceThreadRecorded(event as AgentEventFor<"thread.recorded">, acceptedInput),
  "child-thread.recorded": (state, event, acceptedInput) =>
    reduceChildThreadRecorded(state, event as AgentEventFor<"child-thread.recorded">, acceptedInput),
  "child-thread.bound": (state, event, acceptedInput) =>
    reduceChildThreadBound(state, event as AgentEventFor<"child-thread.bound">, acceptedInput),
  "turn.created": (state, event, acceptedInput) =>
    reduceTurnCreated(state, event as AgentEventFor<"turn.created">, acceptedInput),
  "turn.started": (state, event, acceptedInput) =>
    reduceTurnStarted(state, event as AgentEventFor<"turn.started">, acceptedInput),
  "turn.provider-started": (state, event, acceptedInput) =>
    reduceTurnProviderStarted(state, event as AgentEventFor<"turn.provider-started">, acceptedInput),
  "turn.completed": (state, event, acceptedInput) =>
    reduceTurnCompleted(state, event as AgentEventFor<"turn.completed">, acceptedInput),
  "turn.cancelled": (state, event, acceptedInput) =>
    reduceTurnCancelled(state, event as AgentEventFor<"turn.cancelled">, acceptedInput),
  "turn.interrupted": (state, event, acceptedInput) =>
    reduceTurnInterrupted(state, event as AgentEventFor<"turn.interrupted">, acceptedInput),
  "turn.errored": (state, event, acceptedInput) =>
    reduceTurnErrored(state, event as AgentEventFor<"turn.errored">, acceptedInput),
  "ingest.overflow": (state, event, acceptedInput) =>
    reduceIngestOverflow(state, event as AgentEventFor<"ingest.overflow">, acceptedInput),
  "ingest.volatile-truncated": (_state, _event, acceptedInput) => reduceVolatileTruncation(acceptedInput),
  "ingest.content-replaced": (_state, _event, acceptedInput) => reduceVolatileTruncation(acceptedInput),
  "item.recorded": (_state, event, acceptedInput) =>
    reduceItemRecorded(event as AgentEventFor<"item.recorded">, acceptedInput),
  "item.content-appended": (state, event, acceptedInput) =>
    reduceItemContentAppended(state, event as AgentEventFor<"item.content-appended">, acceptedInput),
  "collaboration-action.recorded": (_state, event, acceptedInput) =>
    reduceCollaborationActionRecorded(event as AgentEventFor<"collaboration-action.recorded">, acceptedInput),
  "publication.recorded": (_state, _event, acceptedInput) => reduceVolatileTruncation(acceptedInput),
};

const ROUTING_CONFLICT: AgentEventDecision = { outcome: "routing-conflict", writes: [] };
const SEQUENCE_CONFLICT: AgentEventDecision = { outcome: "sequence-conflict", writes: [] };

function decided(
  outcome: AgentReducerResult["outcome"],
  acceptedInput: readonly AgentModelWrite[],
  ...writes: AgentModelWrite[]
): AgentEventDecision {
  return { outcome, writes: [...writes, ...acceptedInput] };
}

function reduceCollaborationObserved(state: AgentModelState, event: AgentEvent, acceptedInput: readonly AgentModelWrite[]): AgentEventDecision {
  if (event.payload.type !== "collaboration.observed" || !event.routing.turnId) return ROUTING_CONFLICT;
  const candidate = applyCollaborationObservation(state, { ...event.routing, turnId: event.routing.turnId }, event.payload.changes);
  if (!candidate) return ROUTING_CONFLICT;
  return decided("applied", acceptedInput,
    { map: "threads", replacement: candidate.threads },
    { map: "turns", replacement: candidate.turns },
    { map: "items", replacement: candidate.items },
    { map: "collaborationActions", replacement: candidate.collaborationActions });
}

/** Create an empty canonical reducer state. */
export function createAgentModelState(): AgentModelState {
  return {
    threads: {},
    turns: {},
    items: {},
    collaborationActions: {},
    appliedEventIds: {},
    acceptedInputEventIds: {},
    lastAcceptedSequenceByExecution: {},
  };
}

/** Copy every top-level map, so an owner can mutate one state in place without changing the other. */
export function copyAgentModelState(state: AgentModelState): AgentModelState {
  return {
    threads: { ...state.threads },
    turns: { ...state.turns },
    items: { ...state.items },
    collaborationActions: { ...state.collaborationActions },
    appliedEventIds: { ...state.appliedEventIds },
    acceptedInputEventIds: { ...state.acceptedInputEventIds },
    lastAcceptedSequenceByExecution: { ...state.lastAcceptedSequenceByExecution },
  };
}

/** Apply one validated semantic event without mutating the previous state. */
export function reduceAgentEvent(
  state: AgentModelState,
  event: AgentEvent,
): AgentReducerResult {
  const decision = decideAgentEvent(state, event);
  return { state: writeImmutably(state, decision.writes), outcome: decision.outcome };
}

function decideAgentEvent(state: AgentModelState, event: AgentEvent): AgentEventDecision {
  const inputKey = `${event.routing.executionId}:${event.acceptedSequence}`;
  const acceptedEventId = state.acceptedInputEventIds[inputKey];
  if (acceptedEventId === event.eventId) {
    return { outcome: "duplicate", writes: [] };
  }
  if (acceptedEventId || state.appliedEventIds[event.eventId]) {
    return SEQUENCE_CONFLICT;
  }
  const lastAcceptedSequence = state.lastAcceptedSequenceByExecution[event.routing.executionId];
  if (lastAcceptedSequence !== undefined && event.acceptedSequence < lastAcceptedSequence) {
    return SEQUENCE_CONFLICT;
  }

  const acceptedInput: readonly AgentModelWrite[] = [
    { map: "appliedEventIds", key: event.eventId, value: true },
    { map: "acceptedInputEventIds", key: inputKey, value: event.eventId },
    { map: "lastAcceptedSequenceByExecution", key: event.routing.executionId, value: event.acceptedSequence },
  ];
  return AGENT_EVENT_REDUCERS[event.payload.type](state, event, acceptedInput);
}

function reduceThreadRecorded(
  event: AgentEventFor<"thread.recorded">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const { thread } = event.payload;
  if (event.routing.threadId !== thread.id) return ROUTING_CONFLICT;
  return decided("applied", acceptedInput, { map: "threads", key: thread.id, value: thread });
}

function reduceChildThreadRecorded(
  state: AgentModelState,
  event: AgentEventFor<"child-thread.recorded">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const { parentThreadId, childThread } = event.payload;
  if (
    event.routing.threadId !== parentThreadId
    || childThread.parentThreadId !== parentThreadId
    || childThread.id === parentThreadId
  ) {
    return ROUTING_CONFLICT;
  }
  const existing = state.threads[childThread.id];
  if (existing && JSON.stringify(existing) !== JSON.stringify(childThread)) {
    return ROUTING_CONFLICT;
  }
  const parent = state.threads[parentThreadId];
  if (!parent) return ROUTING_CONFLICT;
  if (existing) return decided("duplicate", acceptedInput);
  return decided("applied", acceptedInput,
    { map: "threads", key: parentThreadId, value: { ...parent, rosterRevision: parent.rosterRevision + 1 } },
    { map: "threads", key: childThread.id, value: childThread });
}

function reduceChildThreadBound(
  state: AgentModelState,
  event: AgentEventFor<"child-thread.bound">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const { parentThreadId, childThreadId, providerIdentity } = event.payload;
  if (event.routing.threadId !== parentThreadId) return ROUTING_CONFLICT;
  const child = state.threads[childThreadId];
  if (!child || child.parentThreadId !== parentThreadId) return ROUTING_CONFLICT;
  const matchesIdentity = (identity: typeof providerIdentity) => (
    identity.providerId === providerIdentity.providerId && identity.scope === providerIdentity.scope
  );
  const sameIdentity = child.providerIdentities.some((identity) => (
    matchesIdentity(identity) && identity.value === providerIdentity.value
  ));
  const conflictingIdentity = child.providerIdentities.some((identity) => (
    matchesIdentity(identity) && identity.value !== providerIdentity.value
  ));
  if (conflictingIdentity) return ROUTING_CONFLICT;
  return decided(sameIdentity ? "duplicate" : "applied", acceptedInput, {
    map: "threads",
    key: child.id,
    value: sameIdentity ? child : { ...child, providerIdentities: [...child.providerIdentities, providerIdentity] },
  });
}

function reduceTurnCreated(
  state: AgentModelState,
  event: AgentEventFor<"turn.created">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const { turn } = event.payload;
  if (event.routing.threadId !== turn.threadId || event.routing.turnId !== turn.id) {
    return ROUTING_CONFLICT;
  }
  if (turn.executionId !== undefined && turn.executionId !== event.routing.executionId) {
    return ROUTING_CONFLICT;
  }
  const currentTurn = state.turns[turn.id];
  if (currentTurn && TERMINAL_TURN_STATUSES.has(currentTurn.status)) {
    return decided("terminal-outcome-confirmed", acceptedInput);
  }
  const stored = turn.executionId === event.routing.executionId
    ? turn
    : { ...turn, executionId: event.routing.executionId };
  return decided("applied", acceptedInput, { map: "turns", key: turn.id, value: stored });
}

function reduceTurnStarted(
  state: AgentModelState,
  event: AgentEventFor<"turn.started">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInput, {
    status: "Running",
    startedAt: event.payload.startedAt,
    endedAt: null,
    ending: null,
  });
}

function reduceTurnProviderStarted(
  state: AgentModelState,
  event: AgentEventFor<"turn.provider-started">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const turnId = event.routing.turnId;
  const currentTurn = turnId ? state.turns[turnId] : undefined;
  if (!currentTurn || currentTurn.threadId !== event.routing.threadId) {
    return ROUTING_CONFLICT;
  }
  // The first frame is a one-time fact: a later claim never moves it.
  if (currentTurn.providerStartedAt !== null) {
    return decided("duplicate", acceptedInput);
  }
  if (TERMINAL_TURN_STATUSES.has(currentTurn.status)) {
    return decided("terminal-outcome-confirmed", acceptedInput);
  }
  return decided("applied", acceptedInput, {
    map: "turns",
    key: currentTurn.id,
    value: { ...currentTurn, providerStartedAt: event.payload.at, updatedAt: event.payload.at },
  });
}

function reduceTurnCompleted(
  state: AgentModelState,
  event: AgentEventFor<"turn.completed">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInput, {
    status: "Completed",
    endedAt: event.payload.endedAt,
    ending: null,
  });
}

function reduceTurnCancelled(
  state: AgentModelState,
  event: AgentEventFor<"turn.cancelled">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInput, {
    status: "Cancelled",
    endedAt: event.payload.endedAt,
    // Every stop before stop causes existed was a user stop.
    ending: { outcome: "cancelled", stop: event.payload.stop ?? { by: "user" } },
  });
}

function reduceTurnInterrupted(
  state: AgentModelState,
  event: AgentEventFor<"turn.interrupted">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInput, {
    status: "Interrupted",
    endedAt: event.payload.endedAt,
    ending: interruptedEnding(event.payload),
  });
}

function interruptedEnding(payload: AgentEventFor<"turn.interrupted">["payload"]): AgentTurnEnding {
  const cause = payload.cause ?? "unknown";
  if (cause !== "usage_limit" || payload.usageLimit === undefined) return { outcome: "interrupted", cause };
  return { outcome: "interrupted", cause, usageLimit: payload.usageLimit };
}

function reduceTurnErrored(
  state: AgentModelState,
  event: AgentEventFor<"turn.errored">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  return updateTurnLifecycle(state, event.routing.threadId, event.routing.turnId, acceptedInput, {
    status: "Errored",
    endedAt: event.payload.endedAt,
    ending: {
      outcome: "errored",
      failure: event.payload.failure ?? {
        kind: "fatal",
        provider: state.threads[event.routing.threadId]?.providerId ?? event.sourceProviderId,
        message: event.payload.error,
      },
    },
  });
}

function reduceIngestOverflow(
  state: AgentModelState,
  event: AgentEventFor<"ingest.overflow">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const lifecycle = updateTurnLifecycle(
    state,
    event.routing.threadId,
    event.routing.turnId,
    acceptedInput,
    { status: "Interrupted", endedAt: event.payload.endedAt, ending: { outcome: "interrupted", cause: "saving_stopped" } },
  );
  if (lifecycle.outcome !== "applied") return lifecycle;
  const thread = state.threads[event.routing.threadId];
  if (!thread) return ROUTING_CONFLICT;
  return {
    outcome: "applied",
    writes: [
      ...lifecycle.writes,
      { map: "threads", key: thread.id, value: { ...thread, activityState: "Idle", updatedAt: event.payload.endedAt } },
    ],
  };
}

function reduceVolatileTruncation(acceptedInput: readonly AgentModelWrite[]): AgentEventDecision {
  return decided("applied", acceptedInput);
}

function reduceResponseBound(state: AgentModelState, event: AgentEvent, acceptedInput: readonly AgentModelWrite[]): AgentEventDecision {
  if (event.payload.type !== "turn.response-bound") return ROUTING_CONFLICT;
  const turn = event.routing.turnId ? state.turns[event.routing.turnId] : undefined;
  if (!turn || turn.threadId !== event.routing.threadId || turn.executionId !== event.routing.executionId) {
    return ROUTING_CONFLICT;
  }
  return decided("applied", acceptedInput, { map: "items", replacement: bindResponseItems(state.items,
    { ...event.payload, threadId: turn.threadId, turnId: turn.id }) });
}

function reduceItemRecorded(
  event: AgentEventFor<"item.recorded">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const { item } = event.payload;
  if (
    event.routing.threadId !== item.threadId
    || event.routing.turnId !== item.turnId
    || event.routing.itemId !== item.id
  ) {
    return ROUTING_CONFLICT;
  }
  return decided("applied", acceptedInput, { map: "items", key: item.id, value: item });
}

function reduceItemContentAppended(
  state: AgentModelState,
  event: AgentEventFor<"item.content-appended">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const item = event.routing.itemId ? state.items[event.routing.itemId] : undefined;
  if (!item || item.threadId !== event.routing.threadId || item.turnId !== event.routing.turnId) {
    return ROUTING_CONFLICT;
  }
  const result = appendItemContent(item, event.payload);
  switch (result.kind) {
    case "appended":
      return decided("applied", acceptedInput, { map: "items", key: item.id, value: result.item });
    case "already-applied":
      return decided("duplicate", acceptedInput);
    case "base-mismatch":
      return ROUTING_CONFLICT;
  }
}

function reduceCollaborationActionRecorded(
  event: AgentEventFor<"collaboration-action.recorded">,
  acceptedInput: readonly AgentModelWrite[],
): AgentEventDecision {
  const { collaborationAction } = event.payload;
  if (
    event.routing.threadId !== collaborationAction.source.threadId
    || event.routing.collaborationActionId !== collaborationAction.id
  ) {
    return ROUTING_CONFLICT;
  }
  return decided("applied", acceptedInput, { map: "collaborationActions", key: collaborationAction.id, value: collaborationAction });
}

/** Apply a semantic event batch atomically or return the unchanged input state. */
export function reduceAgentEventBatch(
  state: AgentModelState,
  events: readonly z.infer<typeof CanonicalAgentSemanticEnvelopeSchema>[],
): AgentBatchReduction {
  let nextState = state;
  let appliedCount = 0;
  let duplicateCount = 0;
  let ignoredTerminalCount = 0;

  for (const event of events) {
    const result = reduceAgentEvent(nextState, event);
    if (result.outcome === "routing-conflict" || result.outcome === "sequence-conflict") {
      return {
        outcome: "rejected",
        state,
        eventId: event.eventId,
        reason: result.outcome,
      };
    }

    nextState = result.state;
    if (result.outcome === "applied") appliedCount += 1;
    if (result.outcome === "duplicate") duplicateCount += 1;
    if (result.outcome === "terminal-outcome-confirmed") ignoredTerminalCount += 1;
  }

  return {
    outcome: "applied",
    state: nextState,
    appliedCount,
    duplicateCount,
    ignoredTerminalCount,
  };
}

/**
 * Apply a semantic event batch by mutating `state` in place, at a cost set by the batch rather than the history.
 *
 * Only for a caller that owns `state` outright: nothing else may hold `state` or its maps expecting them to stay
 * fixed. Validation and outcomes match {@link reduceAgentEventBatch}. A rejected batch leaves `state` as it was; an
 * applied one can be undone with `rollback()` until the caller lets go of the result.
 */
export function applyOwnedAgentEventBatch(
  state: AgentModelState,
  events: readonly z.infer<typeof CanonicalAgentSemanticEnvelopeSchema>[],
): OwnedBatchReduction {
  markOwnedChange(state);
  const journal = new OwnedWriteJournal(state);
  let appliedCount = 0;
  let duplicateCount = 0;
  let ignoredTerminalCount = 0;

  for (const event of events) {
    const decision = decideAgentEvent(state, event);
    if (decision.outcome === "routing-conflict" || decision.outcome === "sequence-conflict") {
      journal.rollback();
      return { outcome: "rejected", eventId: event.eventId, reason: decision.outcome };
    }
    journal.write(decision.writes);
    if (decision.outcome === "applied") appliedCount += 1;
    if (decision.outcome === "duplicate") duplicateCount += 1;
    if (decision.outcome === "terminal-outcome-confirmed") ignoredTerminalCount += 1;
  }

  return { outcome: "applied", appliedCount, duplicateCount, ignoredTerminalCount, rollback: () => journal.rollback() };
}

/**
 * Drop the event-identity maps of an owned state in place, the counterpart of compacting a pure reduction.
 * An earlier batch's `rollback()` still restores them exactly.
 */
export function clearOwnedEventIds(state: AgentModelState): void {
  markOwnedChange(state);
  state.appliedEventIds = {};
  state.acceptedInputEventIds = {};
}

const ownedChangeCounts = new WeakMap<AgentModelState, number>();

/**
 * How many times an owned batch or compaction has changed `state` in place. A reader that keeps `state` between
 * calls records this when it starts reading; a later different value means what it would read may have changed.
 * Counts a batch even if it is later rejected or rolled back, so a reader can only err towards refusing.
 */
export function ownedStateChangeCount(state: AgentModelState): number {
  return ownedChangeCounts.get(state) ?? 0;
}

function markOwnedChange(state: AgentModelState): void {
  ownedChangeCounts.set(state, ownedStateChangeCount(state) + 1);
}

type OwnedKeyWrite = { readonly map: Record<string, unknown>; readonly key: string; readonly had: boolean; readonly prev: unknown };

/** Records each in-place write so a batch can be undone without having copied any map. */
class OwnedWriteJournal {
  private readonly maps: AgentModelMaps;
  // The seven map references at batch start: restoring them undoes whole-map replacements and later compaction.
  private readonly startMaps: AgentModelState;
  private readonly entries: OwnedKeyWrite[] = [];
  private settled = false;

  constructor(private readonly state: AgentModelState) {
    this.maps = state;
    this.startMaps = { ...state };
  }

  write(writes: readonly AgentModelWrite[]): void {
    for (const write of writes) {
      if ("replacement" in write) {
        this.maps[write.map] = write.replacement;
        continue;
      }
      const map = this.maps[write.map];
      // `Object.hasOwn` is ES2022, beyond the web app's lib, which also compiles this file.
      const had = Object.prototype.hasOwnProperty.call(map, write.key);
      this.entries.push({ map, key: write.key, had, prev: had ? map[write.key] : undefined });
      defineOwnKey(map, write.key, write.value);
    }
  }

  rollback(): void {
    if (this.settled) return;
    this.settled = true;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (!entry) continue;
      if (entry.had) defineOwnKey(entry.map, entry.key, entry.prev);
      else delete entry.map[entry.key];
    }
    this.entries.length = 0;
    Object.assign(this.state, this.startMaps);
  }
}

function writeImmutably(state: AgentModelState, writes: readonly AgentModelWrite[]): AgentModelState {
  if (writes.length === 0) return state;
  const next = { ...state };
  const maps: AgentModelMaps = next;
  const copied = new Set<AgentModelMapName>();
  for (const write of writes) {
    if ("replacement" in write) {
      maps[write.map] = write.replacement;
      copied.add(write.map);
      continue;
    }
    if (!copied.has(write.map)) {
      maps[write.map] = { ...maps[write.map] };
      copied.add(write.map);
    }
    defineOwnKey(maps[write.map], write.key, write.value);
  }
  return next;
}

/**
 * Set a record as an own key. IDs are free text, and plain assignment of `__proto__` would replace the map's
 * prototype instead, unlike the `{ ...map, [id]: record }` literal this reducer used to build.
 */
function defineOwnKey(map: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

function updateTurnLifecycle(
  state: AgentModelState,
  threadId: string,
  turnId: string | undefined,
  acceptedInput: readonly AgentModelWrite[],
  update: {
    status: AgentTurnStatus;
    startedAt?: string;
    endedAt: string | null;
    ending: AgentTurnEnding | null;
  },
): AgentEventDecision {
  const currentTurn = turnId ? state.turns[turnId] : undefined;
  if (!currentTurn || currentTurn.threadId !== threadId) {
    return ROUTING_CONFLICT;
  }
  if (TERMINAL_TURN_STATUSES.has(currentTurn.status)) {
    return decided("terminal-outcome-confirmed", acceptedInput);
  }

  return decided("applied", acceptedInput, {
    map: "turns",
    key: currentTurn.id,
    value: {
      ...currentTurn,
      status: update.status,
      startedAt: update.startedAt ?? currentTurn.startedAt,
      endedAt: update.endedAt,
      ending: update.ending,
      updatedAt: update.endedAt ?? update.startedAt ?? currentTurn.updatedAt,
    },
  });
}
