import { describe, expect, it } from "vitest";
import {
  reduceAgentEventBatch,
  type CanonicalAgentEventEnvelope,
  type AcceptedCanonicalAgentEventEnvelope,
  type CanonicalAgentProgressFrame,
} from "@mcode/contracts";
import {
  applyCanonicalPushEvents,
  applyCanonicalReconnectRecovery,
  createCanonicalAgentReplica,
} from "./canonical-agent-replica";
import { applyCanonicalProgressFrame } from "./canonical-agent-progress";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-11T12:00:00.000Z";

function envelope(
  eventId: string,
  acceptedSequence: number,
  durableRevision: number,
  payload: CanonicalAgentEventEnvelope["payload"],
): CanonicalAgentEventEnvelope {
  return {
    eventId,
    routing: {
      threadId: THREAD_ID,
      turnId: payload.type === "thread.recorded" ? undefined : TURN_ID,
      executionId: EXECUTION_ID,
    },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence,
    durableRevision,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload,
  };
}

function initialEvents(): CanonicalAgentEventEnvelope[] {
  return [
    envelope("thread", 1, 1, {
      type: "thread.recorded",
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        rootThreadId: THREAD_ID,
        providerId: "codex",
        providerIdentities: [],
        activityState: "Active",
        conversationRevision: 1,
        rosterRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("turn-created", 2, 1, {
      type: "turn.created",
      turn: {
        id: TURN_ID,
        threadId: THREAD_ID,
        status: "Pending",
        trigger: { kind: "user" },
        permissionMode: "full",
        approvalReviewMode: "manual",
        approvalReviewReason: "manual-requested",
        providerIdentities: [],
        startedAt: null,
        endedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("turn-started", 3, 1, { type: "turn.started", startedAt: NOW }),
  ];
}

describe("canonical agent renderer replica", () => {
  it("installs a snapshot before it applies a later revision", () => {
    const initial = initialEvents();
    const reduced = reduceAgentEventBatch(createCanonicalAgentReplica().state, initial);
    if (reduced.outcome !== "applied") throw new Error("snapshot fixture rejected");
    const installed = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "snapshot",
      threadId: THREAD_ID,
      snapshot: {
        revision: { conversationRevision: 1, rosterRevision: 0 },
        state: reduced.state,
      },
    });
    const completed = envelope("turn-completed", 4, 2, {
      type: "turn.completed",
      endedAt: NOW,
    });

    const update = applyCanonicalPushEvents(installed.replica, THREAD_ID, [completed]);

    expect(installed.installedSnapshot).toBe(true);
    expect(update.outcome).toBe("applied");
    expect(update.replica.revision.conversationRevision).toBe(2);
    expect(update.replica.state.turns[TURN_ID]?.status).toBe("Completed");
  });

  it("requests recovery instead of applying a non-contiguous revision", () => {
    const current = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: initialEvents(),
    }).replica;
    const skippedRevision = envelope("late-complete", 4, 3, {
      type: "turn.completed",
      endedAt: NOW,
    });

    const update = applyCanonicalPushEvents(current, THREAD_ID, [skippedRevision]);

    expect(update.outcome).toBe("recovery-required");
    expect(update.replica.recoveryRequired).toBe(true);
    expect(update.replica.revision.conversationRevision).toBe(1);
    expect(update.replica.state.turns[TURN_ID]?.status).toBe("Running");
  });

  it("keeps duplicate and late canonical events from changing activity", () => {
    const initial = initialEvents();
    const current = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: initial,
    }).replica;

    const duplicate = applyCanonicalPushEvents(current, THREAD_ID, initial);
    const staleSnapshot = applyCanonicalReconnectRecovery(duplicate.replica, {
      mode: "snapshot",
      threadId: THREAD_ID,
      snapshot: {
        revision: { conversationRevision: 0, rosterRevision: 0 },
        state: createCanonicalAgentReplica().state,
      },
    });

    expect(Object.keys(duplicate.replica.state.turns)).toEqual([TURN_ID]);
    expect(duplicate.replica.state.turns[TURN_ID]?.status).toBe("Running");
    expect(staleSnapshot.outcome).toBe("ignored");
    expect(staleSnapshot.replica).toBe(duplicate.replica);
  });

  it("rejects an event whose immutable routing assigns it to another thread", () => {
    const current = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: initialEvents(),
    }).replica;
    const wrongThread = {
      ...envelope("wrong-thread", 4, 2, { type: "turn.completed", endedAt: NOW }),
      routing: {
        threadId: "thread-2",
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
      },
    } satisfies CanonicalAgentEventEnvelope;

    const update = applyCanonicalPushEvents(current, THREAD_ID, [wrongThread]);

    expect(update.outcome).toBe("recovery-required");
    expect(update.replica.state.turns[TURN_ID]?.status).toBe("Running");
  });

  it("rejects a reconnect delta whose retained revisions are not contiguous", () => {
    const update = applyCanonicalReconnectRecovery(createCanonicalAgentReplica(), {
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 2, rosterRevision: 0 },
      events: initialEvents(),
    });

    expect(update.outcome).toBe("recovery-required");
    expect(update.replica.revision.conversationRevision).toBe(0);
    expect(update.replica.state.threads).toEqual({});
  });
});

const EPOCH = "runtime-1";

function acceptedEvents(events: readonly CanonicalAgentEventEnvelope[]): AcceptedCanonicalAgentEventEnvelope[] {
  return events.map(({ durableRevision: _durableRevision, rosterRevision: _rosterRevision, ...event }) => ({
    ...event, progressPosition: { epoch: EPOCH, sequence: event.acceptedSequence },
  }));
}

function acceptedFrame(events: readonly CanonicalAgentEventEnvelope[]): CanonicalAgentProgressFrame {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("empty test batch");
  return { phase: "accepted", threadId: THREAD_ID, epoch: EPOCH, from: first.acceptedSequence - 1, through: last.acceptedSequence, events: acceptedEvents(events) };
}

function savedFrame(events: readonly CanonicalAgentEventEnvelope[]): CanonicalAgentProgressFrame {
  const last = events.at(-1);
  if (!last) throw new Error("empty test batch");
  return { phase: "saved", threadId: THREAD_ID, epoch: EPOCH, through: last.acceptedSequence,
    revision: { conversationRevision: last.durableRevision, rosterRevision: 0 },
    events: events.map((event) => ({ ...event, progressPosition: { epoch: EPOCH, sequence: event.acceptedSequence } })),
  };
}

describe("canonical accepted and saved progress", () => {
  it("renders a completed turn before saving and saves without publishing it again", () => {
    const events = [...initialEvents(), envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW })];
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(events));
    expect(live.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(live.replica.durableState.turns[TURN_ID]).toBeUndefined();
    expect(live.replica.revision.conversationRevision).toBe(0);
    expect(live.publications).toHaveLength(4);
    let saved = live;
    for (let through = 1; through <= events.length; through += 1) {
      saved = applyCanonicalProgressFrame(saved.replica, savedFrame(events.slice(0, through)));
      expect(saved.outcome).toBe("applied");
      expect(saved.replica.state).toBe(live.replica.state);
      expect(saved.replica.state.turns[TURN_ID]).toBe(live.replica.state.turns[TURN_ID]);
      expect(saved.replica.progress?.savedThrough).toBe(through);
    }
    expect(saved.publications).toEqual([]);
    expect(saved.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(saved.replica.durableState.turns[TURN_ID]?.status).toBe("Completed");
    expect(saved.replica.progress?.retained).toEqual([]);
  });

  it("keeps the first accepted effects when their saved receipt arrived first", () => {
    const events = initialEvents();
    const saved = applyCanonicalProgressFrame(createCanonicalAgentReplica(), savedFrame(events));
    expect(saved.publications).toEqual([]);
    const live = applyCanonicalProgressFrame(saved.replica, acceptedFrame(events));
    expect(live.publications).toHaveLength(3);
    expect(live.replica.progress?.retained).toEqual([]);
    const duplicate = applyCanonicalProgressFrame(live.replica, acceptedFrame(events));
    expect(duplicate.publications).toEqual([]);
  });

  it("rebases a later accepted terminal over an earlier save", () => {
    const events = initialEvents();
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(events));
    const terminal = envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW });
    const completed = applyCanonicalProgressFrame(live.replica, acceptedFrame([terminal]));
    const saved = applyCanonicalProgressFrame(completed.replica, savedFrame(events));
    expect(saved.replica.durableState.turns[TURN_ID]?.status).toBe("Running");
    expect(saved.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(saved.replica.progress?.retained.map((event) => event.eventId)).toEqual(["complete"]);
  });

  it("requests gap repair before a later batch can publish effects", () => {
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(initialEvents()));
    const gap = applyCanonicalProgressFrame(live.replica, acceptedFrame([envelope("gap", 5, 2, { type: "turn.completed", endedAt: NOW })]));
    expect(gap.outcome).toBe("recovery-required");
    expect(gap.publications).toEqual([]);
    expect(gap.replica.state.turns[TURN_ID]?.status).toBe("Running");
  });

  it("does not advance through a malformed cutoff or a mixed epoch", () => {
    const frame = acceptedFrame(initialEvents());
    if (frame.phase !== "accepted") throw new Error("unexpected fixture phase");
    for (const malformed of [{ ...frame, through: 100 }, { ...frame, events: frame.events.map((event) => ({ ...event, progressPosition: { ...event.progressPosition, epoch: "other-runtime" } })) }]) {
      const update = applyCanonicalProgressFrame(createCanonicalAgentReplica(), malformed);
      expect(update.outcome).toBe("recovery-required");
      expect(update.replica.progress).toBeNull();
      expect(update.publications).toEqual([]);
    }
  });

  it("validates actual saved revisions independently of accepted state", () => {
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(initialEvents()));
    const gap = applyCanonicalProgressFrame(live.replica, savedFrame([envelope("gap", 4, 3, { type: "turn.completed", endedAt: NOW })]));
    expect(gap.outcome).toBe("recovery-required");
    expect(gap.replica.revision.conversationRevision).toBe(0);
    expect(gap.replica.state.turns[TURN_ID]?.status).toBe("Running");
  });

  it("keeps a durable gap pending while a valid live terminal advances, then clears it after repair", () => {
    const events = initialEvents();
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(events));
    const saved = applyCanonicalProgressFrame(live.replica, savedFrame(events));
    const terminal = envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW });
    const gap = applyCanonicalProgressFrame(saved.replica, savedFrame([{ ...terminal, durableRevision: 3 }]));
    const completed = applyCanonicalProgressFrame(gap.replica, acceptedFrame([terminal]));
    expect(completed.outcome).toBe("applied");
    expect(completed.publications.map((event) => event.eventId)).toEqual(["complete"]);
    expect(completed.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(completed.replica.recoveryRequired).toBe(true);

    const repaired = applyCanonicalProgressFrame(completed.replica, savedFrame([terminal]));
    expect(repaired.outcome).toBe("applied");
    expect(repaired.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(repaired.replica.recoveryRequired).toBe(false);
  });

  it.each(["epoch", "revision"] as const)("rejects an invalid %s acknowledgement before preserving or advancing the saved prefix", (invalid) => {
    const events = initialEvents();
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(events));
    const frame = savedFrame(events);
    if (frame.phase !== "saved") throw new Error("unexpected saved fixture");
    const malformed = invalid === "epoch"
      ? { ...frame, epoch: "other-runtime", events: frame.events.map((event) => ({ ...event, progressPosition: { epoch: "other-runtime", sequence: event.acceptedSequence } })) }
      : { ...frame, revision: { conversationRevision: 2, rosterRevision: 0 }, events: frame.events.map((event) => ({ ...event, durableRevision: 2 })) };
    const rejected = applyCanonicalProgressFrame(live.replica, malformed);
    expect(rejected.outcome).toBe("recovery-required");
    expect(rejected.replica.state).toBe(live.replica.state);
    expect(rejected.replica.durableState).toBe(live.replica.durableState);
    expect(rejected.replica.progress?.savedThrough).toBe(0);
    expect(rejected.replica.revision.conversationRevision).toBe(0);
    expect(rejected.publications).toEqual([]);
  });

  it("installs a saved prefix with its retained terminal suffix without live effects", () => {
    const events = initialEvents();
    const terminal = envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW });
    const recovered = applyCanonicalProgressFrame(createCanonicalAgentReplica(), {
      phase: "recovery", threadId: THREAD_ID, epoch: EPOCH, acceptedThrough: 4, savedThrough: 3,
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 0, rosterRevision: 0 }, through: { conversationRevision: 1, rosterRevision: 0 }, events },
      retained: acceptedEvents([terminal]), loss: "none",
    });
    expect(recovered.publications).toEqual([]);
    expect(recovered.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(recovered.replica.durableState.turns[TURN_ID]?.status).toBe("Running");
    expect(applyCanonicalProgressFrame(recovered.replica, acceptedFrame([terminal])).publications).toEqual([]);
  });

  it("preserves visible state when recovery confirms an already accepted suffix", () => {
    const events = initialEvents();
    const terminal = envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW });
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame([...events, terminal]));
    const saved = applyCanonicalProgressFrame(live.replica, savedFrame(events));
    const recovered = applyCanonicalProgressFrame(saved.replica, {
      phase: "recovery", threadId: THREAD_ID, epoch: EPOCH, acceptedThrough: 4, savedThrough: 3,
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 1, rosterRevision: 0 }, through: { conversationRevision: 1, rosterRevision: 0 }, events: [] },
      retained: acceptedEvents([terminal]), loss: "none",
    });

    expect(recovered.outcome).toBe("applied");
    expect(recovered.publications).toEqual([]);
    expect(recovered.replica.state).toBe(live.replica.state);
    expect(recovered.replica.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(recovered.replica.durableState.turns[TURN_ID]?.status).toBe("Running");
    expect(recovered.replica.progress?.acceptedThrough).toBe(4);
    expect(recovered.replica.progress?.savedThrough).toBe(3);
  });

  it("projects recovery when a retained identity was not the accepted suffix already rendered", () => {
    const events = initialEvents();
    const terminal = envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW });
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame([...events, terminal]));
    const saved = applyCanonicalProgressFrame(live.replica, savedFrame(events));
    const mismatched = acceptedEvents([{ ...terminal, eventId: "different-complete" }]);
    const recovered = applyCanonicalProgressFrame(saved.replica, {
      phase: "recovery", threadId: THREAD_ID, epoch: EPOCH, acceptedThrough: 4, savedThrough: 3,
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 1, rosterRevision: 0 }, through: { conversationRevision: 1, rosterRevision: 0 }, events: [] },
      retained: mismatched, loss: "none",
    });

    expect(recovered.outcome).toBe("applied");
    expect(recovered.replica.state).not.toBe(live.replica.state);
    expect(recovered.replica.state.turns[TURN_ID]?.status).toBe("Completed");
  });

  it("discards a lost volatile suffix after restart and fences the old epoch", () => {
    const initial = initialEvents();
    const live = applyCanonicalProgressFrame(createCanonicalAgentReplica(), acceptedFrame(initial));
    const saved = applyCanonicalProgressFrame(live.replica, savedFrame(initial));
    const terminal = envelope("complete", 4, 2, { type: "turn.completed", endedAt: NOW });
    const completed = applyCanonicalProgressFrame(saved.replica, acceptedFrame([terminal]));
    const restarted = applyCanonicalProgressFrame(completed.replica, {
      phase: "recovery", threadId: THREAD_ID, epoch: "runtime-2", acceptedThrough: 0, savedThrough: 0,
      durable: { mode: "snapshot", threadId: THREAD_ID, snapshot: { revision: saved.replica.revision, state: saved.replica.durableState } },
      retained: [], loss: "runtime-restarted",
    });
    expect(restarted.replica.state.turns[TURN_ID]?.status).toBe("Interrupted");
    expect(restarted.replica.lostProgress).toBe(true);
    expect(restarted.replica.progress?.retained).toEqual([]);
    expect(applyCanonicalProgressFrame(restarted.replica, savedFrame([terminal])).outcome).toBe("ignored");
  });
});
