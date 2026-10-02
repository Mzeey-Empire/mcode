import { describe, expect, it } from "vitest";
import { AcceptedCanonicalAgentEventEnvelopeSchema } from "../compat/agent-model.js";
import { CanonicalAgentProgressFrameSchema, CanonicalAgentProgressRecoverySchema } from "../models/canonical-agent-progress.js";

function event(sequence = 1) {
  return {
    eventId: `event:${sequence}`, routing: { threadId: "thread", turnId: "turn", executionId: "10000000-0000-4000-8000-000000000001" },
    sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: sequence,
    progressPosition: { epoch: "epoch", sequence }, serverTimestamps: { acceptedAt: "2026-09-30T09:00:00.000Z" },
    payload: { type: "turn.started", startedAt: "2026-09-30T09:00:00.000Z" },
  };
}

describe("canonical accepted/saved progress contract", () => {
  it("accepts progress with no fabricated durable revision and rejects a durable field", () => {
    expect(AcceptedCanonicalAgentEventEnvelopeSchema.safeParse(event()).success).toBe(true);
    expect(AcceptedCanonicalAgentEventEnvelopeSchema.safeParse({ ...event(), durableRevision: 0 }).success).toBe(false);
  });

  it("requires one contiguous ordered epoch and matching thread routing", () => {
    const frame = { phase: "accepted", threadId: "thread", epoch: "epoch", from: 0, through: 2, events: [event(1), event(2)] };
    expect(CanonicalAgentProgressFrameSchema().safeParse(frame).success).toBe(true);
    expect(CanonicalAgentProgressFrameSchema().safeParse({ ...frame, events: [event(2), event(1)] }).success).toBe(false);
    expect(CanonicalAgentProgressFrameSchema().safeParse({ ...frame, epoch: "new-epoch" }).success).toBe(false);
    expect(CanonicalAgentProgressFrameSchema().safeParse({ ...frame, threadId: "other" }).success).toBe(false);
  });

  it("requires real durable metadata for saved events", () => {
    const frame = { phase: "saved", threadId: "thread", epoch: "epoch", through: 1,
      revision: { conversationRevision: 4, rosterRevision: 0 }, events: [{ ...event(), durableRevision: 4 }] };
    expect(CanonicalAgentProgressFrameSchema().safeParse(frame).success).toBe(true);
    expect(CanonicalAgentProgressFrameSchema().safeParse({ ...frame, events: [event()] }).success).toBe(false);
  });

  it("bounds recovery to a consistent saved prefix and retained suffix", () => {
    const recovery = { phase: "recovery", threadId: "thread", epoch: "epoch", savedThrough: 1, acceptedThrough: 2,
      durable: { mode: "delta", threadId: "thread", from: { conversationRevision: 4, rosterRevision: 0 },
        through: { conversationRevision: 4, rosterRevision: 0 }, events: [] }, retained: [event(2)], loss: "none" };
    expect(CanonicalAgentProgressRecoverySchema().safeParse(recovery).success).toBe(true);
    expect(CanonicalAgentProgressRecoverySchema().safeParse({ ...recovery, acceptedThrough: 3 }).success).toBe(false);
    expect(CanonicalAgentProgressRecoverySchema().safeParse({ ...recovery, savedThrough: 3 }).success).toBe(false);
  });
});
