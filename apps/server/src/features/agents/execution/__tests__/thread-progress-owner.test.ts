import { describe, expect, it } from "vitest";
import type { CanonicalAgentEventDraft } from "../../canonical/canonical-agent-boundary.js";
import { BoundedProgressRetention } from "../progress-retention-budget.js";
import { ThreadProgressOwner } from "../thread-progress-owner.js";
import type { AcceptedProgressBatch, ProgressRetentionLimits } from "../thread-progress-types.js";

const limits: ProgressRetentionLimits = {
  maxEvents: 8, maxBytes: 32_000, reservedControlEvents: 2, reservedControlBytes: 4_000,
};
const execution = { threadId: "thread", turnId: "turn", executionId: "10000000-0000-4000-8000-000000000001" };

function draft(id: string): CanonicalAgentEventDraft {
  return { eventId: id, routing: execution, sourceProviderId: "codex", sourceIdentities: [],
    payload: { type: "publication.recorded", publicationId: String(Number(id.replace(/\D/g, "")) || 1), event: { type: "textDelta", delta: id } } };
}

function owner(sharedBudget = new BoundedProgressRetention(limits)) {
  return new ThreadProgressOwner<string>({ threadId: "thread", epoch: "runtime-epoch", durableRevision: 3,
    limits, sharedBudget, now: () => "2026-09-30T09:00:00.000Z" });
}

function accept(progress: ThreadProgressOwner<string>, id: string, admission: "progress" | "control" = "progress") {
  const result = progress.accept({ operationId: id, execution, events: [draft(id)], write: `write:${id}`, admission });
  if (result.kind !== "accepted") throw new Error(`Unexpected admission: ${result.kind}`);
  return result.batch;
}

function receipt(batch: AcceptedProgressBatch<string>, durableRevision = 4) {
  return { operationId: batch.operationId, contentHash: batch.contentHash, predecessor: batch.predecessor, through: batch.through, durableRevision };
}

describe("ThreadProgressOwner", () => {
  it("bounds saved duplicate identities as well as their cached receipts", () => {
    const largeLimits = { maxEvents: 8192, maxBytes: 16 * 1024 * 1024, reservedControlEvents: 16, reservedControlBytes: 8192 };
    const progress = new ThreadProgressOwner<string, string>({ threadId: execution.threadId, epoch: "runtime-epoch",
      durableRevision: 3, limits: largeLimits, sharedBudget: new BoundedProgressRetention(largeLimits) });
    const result = progress.accept({ operationId: "large", execution,
      events: Array.from({ length: 1500 }, (_, index) => draft(`${index}:${"x".repeat(230)}`)), write: "write", admission: "control" },
      undefined, { inputHash: "original", receipt: () => "accepted" });
    if (result.kind !== "accepted") throw new Error(`Unexpected admission: ${result.kind}`);
    expect(progress.replay("large", "original").kind).toBe("duplicate");
    expect(progress.acknowledge(receipt(result.batch, 4))).toBe(true);
    expect(progress.replay("large", "original").kind).toBe("unknown");
    expect(progress.recoveryCut().retained).toEqual([]);
  });

  it("accepts ordered progress and reserved control while saving remains pending", () => {
    const progress = owner();
    const batches = [accept(progress, "text1"), accept(progress, "tool2"), accept(progress, "terminal3", "control")];
    expect(batches.map((batch) => batch.through.sequence)).toEqual([1, 2, 3]);
    expect(progress.recoveryCut().retained).toEqual(batches);
    expect(progress.savingState()).toMatchObject({ kind: "saving", saved: { sequence: 0 }, accepted: { sequence: 3 } });
  });

  it("allocates order once and rejects conflicting operation identity without side effects", () => {
    const progress = owner();
    const first = accept(progress, "event1");
    const duplicate = progress.accept({ operationId: "event1", execution, events: [draft("event1")], write: "write:event1", admission: "progress" });
    expect(duplicate).toEqual({ kind: "duplicate", operationId: first.operationId, through: first.through });
    expect(progress.accept({ operationId: "event1", execution, events: [draft("event2")], write: "different", admission: "progress" }))
      .toEqual({ kind: "rejected", reason: "identity-conflict" });
    expect(accept(progress, "event2").events[0]?.acceptedSequence).toBe(2);
  });

  it("advances only a contiguous saved prefix and retains gaps for reconnect", () => {
    const progress = owner();
    const first = accept(progress, "event1");
    const second = accept(progress, "event2");
    expect(progress.acknowledge(receipt(second, 5))).toBe(true);
    expect(progress.recoveryCut()).toMatchObject({ saved: { sequence: 0 }, retained: [first, second] });
    expect(progress.acknowledge(receipt(first, 4))).toBe(true);
    expect(progress.recoveryCut()).toMatchObject({ saved: { sequence: 2 }, durableRevision: 5, retained: [] });
    expect(progress.acknowledge(receipt(first))).toBe(false);
  });

  it("cannot certify a different batch or runtime epoch", () => {
    const progress = owner();
    const batch = accept(progress, "event1");
    expect(progress.acknowledge({ ...receipt(batch), contentHash: "different" })).toBe(false);
    expect(progress.acknowledge({ ...receipt(batch), through: { epoch: "restarted", sequence: 1 } })).toBe(false);
    expect(progress.recoveryCut().saved.sequence).toBe(0);
  });

  it("rejects a mismatched predecessor, stale durable revision, or reversed commit order", () => {
    const progress = owner();
    const first = accept(progress, "event1");
    const second = accept(progress, "event2");
    expect(progress.acknowledge({ ...receipt(first), predecessor: { epoch: "runtime-epoch", sequence: 1 } })).toBe(false);
    expect(progress.acknowledge(receipt(first, 3))).toBe(false);
    expect(progress.acknowledge(receipt(second, 5))).toBe(true);
    expect(progress.acknowledge(receipt(first, 6))).toBe(false);
    expect(progress.acknowledge(receipt(first, 4))).toBe(true);
    expect(progress.recoveryCut().durableRevision).toBe(5);
  });

  it("reserves terminal capacity and rejects ordinary overflow without advancing", () => {
    const progress = owner();
    for (let index = 1; index <= 6; index += 1) accept(progress, `event${index}`);
    expect(progress.accept({ operationId: "event7", execution, events: [draft("event7")], write: "write:event7", admission: "progress" }))
      .toEqual({ kind: "rejected", reason: "retention-exhausted" });
    const terminal = accept(progress, "terminal7", "control");
    expect(terminal.events[0]?.acceptedSequence).toBe(7);
    expect(terminal.through.sequence).toBe(7);
  });

  it("accounts failed/in-flight retention globally until real contiguous acknowledgements", () => {
    const budget = new BoundedProgressRetention(limits);
    const progress = owner(budget);
    const batch = accept(progress, "event1");
    const error = new Error("SQLITE_FULL");
    progress.recordFailure({ operationId: batch.operationId, error, exhausted: true });
    expect(progress.savingState()).toMatchObject({ kind: "failed", error });
    expect(budget.depth()).toEqual({ events: 1, bytes: batch.byteLength });
    expect(progress.acknowledge(receipt(batch))).toBe(true);
    expect(budget.depth()).toEqual({ events: 0, bytes: 0 });
    expect(progress.savingState().kind).toBe("saved");
  });

  it("old saving receipts cannot discard a newer execution's accepted suffix", () => {
    const progress = owner();
    const old = accept(progress, "terminal1", "control");
    const nextExecution = { ...execution, turnId: "next-turn", executionId: "10000000-0000-4000-8000-000000000002" };
    const next = progress.accept({ operationId: "new2", execution: nextExecution,
      events: [{ ...draft("new2"), routing: nextExecution }], write: "write:new2", admission: "progress" });
    if (next.kind !== "accepted") throw new Error(`Unexpected admission: ${next.kind}`);
    progress.acknowledge(receipt(old));
    expect(progress.recoveryCut().retained).toEqual([next.batch]);
    expect(next.batch.events[0]?.acceptedSequence).toBe(1);
    expect(next.batch.through.sequence).toBe(2);
  });

  it("retains immutable copies even when the producer mutates its original data", () => {
    const progress = owner();
    const input = draft("event1");
    const result = progress.accept({ operationId: "event1", execution, events: [input], write: "write:event1", admission: "progress" });
    if (result.kind !== "accepted") throw new Error(`Unexpected admission: ${result.kind}`);
    input.sourceProviderId = "changed";
    expect(result.batch.events[0]?.draft.sourceProviderId).toBe("codex");
    expect(Object.isFrozen(result.batch.events[0]?.draft)).toBe(true);
  });
});
