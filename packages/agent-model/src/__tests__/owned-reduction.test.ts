import { describe, expect, it } from "vitest";
import {
  type AgentModelState,
  CanonicalAgentSemanticEnvelopeSchema,
  applyOwnedAgentEventBatch,
  clearOwnedEventIds,
  createAgentModelState,
  reduceAgentEventBatch,
} from "../index.js";

const NOW = "2026-11-05T12:00:00.000Z";
const LATER = "2026-11-05T12:00:05.000Z";
const executionId = "00000000-0000-4000-8000-000000000001";
const turnRouting = { threadId: "thread-1", turnId: "turn-1", executionId };
const timestamps = { createdAt: NOW, updatedAt: NOW };
const textItemId = `assistant-response-text:${executionId}`;

type Envelope = ReturnType<typeof CanonicalAgentSemanticEnvelopeSchema.parse>;

function envelope(acceptedSequence: number, routing: Record<string, unknown>, payload: unknown, eventId = `event-${acceptedSequence}`): Envelope {
  return CanonicalAgentSemanticEnvelopeSchema.parse({
    eventId, routing, sourceProviderId: "codex", sourceIdentities: [], acceptedSequence,
    serverTimestamps: { acceptedAt: NOW }, payload,
  });
}

function thread(id: string, parentThreadId?: string) {
  return { id, workspaceId: "workspace-1", rootThreadId: "thread-1", providerId: "codex", providerIdentities: [],
    activityState: "Active", conversationRevision: 0, rosterRevision: 0, ...(parentThreadId ? { parentThreadId } : {}), ...timestamps };
}

function item(id: string, payload: Record<string, unknown>, routing = turnRouting) {
  return { id, threadId: routing.threadId, turnId: routing.turnId, kind: "system", providerIdentities: [], payload, ...timestamps };
}

function threadRecorded(sequence: number) {
  return envelope(sequence, { threadId: "thread-1", executionId }, { type: "thread.recorded", thread: thread("thread-1") });
}

function turnCreated(sequence: number) {
  return envelope(sequence, turnRouting, { type: "turn.created", turn: {
    id: "turn-1", threadId: "thread-1", status: "Pending", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "manual-requested", providerIdentities: [],
    startedAt: null, endedAt: null, ...timestamps } });
}

function itemRecorded(sequence: number, id: string, payload: Record<string, unknown>) {
  return envelope(sequence, { ...turnRouting, itemId: id }, { type: "item.recorded", item: item(id, payload) });
}

function textRecorded(sequence: number, content: string) {
  return itemRecorded(sequence, textItemId, { projection: "assistantText", content, isStreaming: true });
}

function textAppended(sequence: number, offset: number, text: string) {
  return envelope(sequence, { ...turnRouting, itemId: textItemId }, { type: "item.content-appended", offset, text, updatedAt: LATER });
}

function runningTool(sequence: number, id: string) {
  return itemRecorded(sequence, `toolCall:${id}`, { projection: "narrativeRecovery",
    narrative: { kind: "toolCall", record: { id, message_id: "", status: "running", completed_at: null } } });
}

/** A recorded stream touching every hot event and each rare one the server owner can admit. */
function recordedStream(): Envelope[] {
  const collaborationAction = { id: "action-1", kind: "delegate",
    source: { threadId: "thread-1", turnId: "turn-1", itemId: "toolCall:tool-1" }, target: { threadId: "child-1" },
    status: "Dispatched", deliveryUnknown: false, providerIdentities: [], ...timestamps };
  const observedContext = { sourceExecution: turnRouting, parentExecution: turnRouting };
  return [
    threadRecorded(1),
    turnCreated(2),
    envelope(3, turnRouting, { type: "turn.started", startedAt: NOW }),
    envelope(4, turnRouting, { type: "turn.provider-started", at: NOW }),
    runningTool(5, "tool-1"),
    textRecorded(6, "Hel"),
    textAppended(7, 3, "lo"),
    textAppended(7, 3, "lo"),
    envelope(8, { threadId: "thread-1", executionId }, { type: "child-thread.recorded", parentThreadId: "thread-1",
      childThread: thread("child-1", "thread-1") }),
    envelope(9, { ...turnRouting, collaborationActionId: "action-1" }, { type: "collaboration-action.recorded", collaborationAction }),
    envelope(10, turnRouting, { type: "collaboration.observed", changes: [
      { kind: "thread-recorded", ...observedContext, thread: thread("child-2", "thread-1") },
      { kind: "item-recorded", ...observedContext, item: item("observed-1", { projection: "diagnostic" }) },
    ] }),
    itemRecorded(11, "message:message-1", { projection: "message", message: { content: "Hello" } }),
    envelope(12, turnRouting, { type: "turn.response-bound", messageId: "message-1", outcome: "completed", endedAt: LATER }),
    envelope(13, turnRouting, { type: "publication.recorded", publicationId: "1", event: { type: "turnComplete" } }),
    envelope(14, turnRouting, { type: "turn.completed", endedAt: LATER }),
    envelope(15, turnRouting, { type: "turn.errored", endedAt: LATER, error: "late failure" }),
    envelope(16, turnRouting, { type: "ingest.volatile-truncated", droppedEventCount: 1 }),
    // Canonical IDs are free text, so a record keyed `__proto__` must become an own key, not the map's prototype.
    itemRecorded(17, "__proto__", { projection: "diagnostic" }),
  ];
}

function pureState(events: readonly Envelope[]): AgentModelState {
  const reduction = reduceAgentEventBatch(createAgentModelState(), events);
  if (reduction.outcome !== "applied") throw new Error(`fixture rejected ${reduction.eventId}: ${reduction.reason}`);
  return reduction.state;
}

function ownedApplied(state: AgentModelState, events: readonly Envelope[]) {
  const reduction = applyOwnedAgentEventBatch(state, events);
  if (reduction.outcome !== "applied") throw new Error(`owned rejected ${reduction.eventId}: ${reduction.reason}`);
  return reduction;
}

describe("owned agent event reduction", () => {
  it("leaves the owned state exactly as it was when a later event in the batch conflicts", () => {
    const state = pureState([threadRecorded(1), turnCreated(2), textRecorded(3, "Part")]);
    const before = structuredClone(state);

    const conflicting = envelope(6, { ...turnRouting, itemId: "elsewhere" }, { type: "item.recorded", item: item("other", { projection: "diagnostic" }) });
    const reduction = applyOwnedAgentEventBatch(state, [textAppended(4, 4, "ial"), runningTool(5, "tool-1"), conflicting]);

    expect(reduction).toEqual({ outcome: "rejected", eventId: "event-6", reason: "routing-conflict" });
    expect(state).toStrictEqual(before);
  });

  it("restores the exact prior state when an applied batch is rolled back", () => {
    const stream = recordedStream();
    const state = pureState(stream.slice(0, 9));
    const before = structuredClone(state);

    const reduction = ownedApplied(state, stream.slice(9));
    expect(state).not.toStrictEqual(before);
    reduction.rollback();

    expect(state).toStrictEqual(before);
  });

  it("restores the prior state through a later compaction when batches roll back in reverse", () => {
    const stream = recordedStream();
    const state = pureState(stream.slice(0, 4));
    const before = structuredClone(state);

    const first = ownedApplied(state, stream.slice(4, 7));
    clearOwnedEventIds(state);
    const second = ownedApplied(state, stream.slice(7, 12));
    clearOwnedEventIds(state);
    second.rollback();
    first.rollback();

    expect(state).toStrictEqual(before);
  });

  it("matches the pure reducer with compaction after every tiny batch", () => {
    const stream = recordedStream();
    let pure = createAgentModelState();
    const owned = createAgentModelState();
    const counts = { applied: 0, duplicate: 0, ignoredTerminal: 0 };
    for (let start = 0, size = 1; start < stream.length; start += size, size = size % 3 + 1) {
      const batch = stream.slice(start, start + size);
      const expected = reduceAgentEventBatch(pure, batch);
      if (expected.outcome !== "applied") throw new Error(`fixture rejected ${expected.eventId}`);
      pure = { ...expected.state, appliedEventIds: {}, acceptedInputEventIds: {} };
      const actual = ownedApplied(owned, batch);
      clearOwnedEventIds(owned);
      counts.applied += actual.appliedCount;
      counts.duplicate += actual.duplicateCount;
      counts.ignoredTerminal += actual.ignoredTerminalCount;
      expect([actual.appliedCount, actual.duplicateCount, actual.ignoredTerminalCount])
        .toEqual([expected.appliedCount, expected.duplicateCount, expected.ignoredTerminalCount]);
      expect(owned).toStrictEqual(pure);
    }
    expect(counts).toEqual({ applied: 16, duplicate: 1, ignoredTerminal: 1 });
    expect(Object.hasOwn(owned.items, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(owned.items)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(pure.items)).toBe(Object.prototype);
    expect(owned.items[textItemId]?.payload.content).toBe("Hello");
    expect(owned.items["toolCall:tool-1"]?.payload.projection).toBe("toolCall");
  });

  it("reads the same map keys for a small batch whatever the size of the history", () => {
    const accesses = (priorItems: number) => {
      const state = pureState([threadRecorded(1), turnCreated(2)]);
      for (let index = 0; index < priorItems; index += 1) {
        state.items[`history:${index}`] = item(`history:${index}`, { projection: "diagnostic" });
      }
      const counts = { ownKeys: 0, get: 0 };
      const counted = <T extends object>(target: T): T => new Proxy(target, {
        ownKeys(map) { counts.ownKeys += 1; return Reflect.ownKeys(map); },
        get(map, key, receiver) { counts.get += 1; return Reflect.get(map, key, receiver); },
      });
      state.items = counted(state.items);
      state.turns = counted(state.turns);
      state.lastAcceptedSequenceByExecution = counted(state.lastAcceptedSequenceByExecution);

      const observedContext = { sourceExecution: turnRouting, parentExecution: turnRouting };
      ownedApplied(state, [textRecorded(3, "Hel"), textAppended(4, 3, "lo"), runningTool(5, "tool-1"),
        envelope(6, turnRouting, { type: "collaboration.observed", changes: [
          { kind: "item-recorded", ...observedContext, item: item("observed-1", { projection: "diagnostic" }) }] })]);

      expect(state.items[textItemId]?.payload.content).toBe("Hello");
      expect(state.items["observed-1"]?.payload.projection).toBe("diagnostic");
      return counts;
    };

    const small = accesses(10);
    const large = accesses(10_000);

    expect(small.ownKeys).toBe(0);
    expect(large).toEqual(small);
  });
});
