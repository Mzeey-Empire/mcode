import { describe, expect, it } from "vitest";
import { AcceptedSaveScheduler } from "../accepted-save-scheduler.js";
import { BoundedProgressRetention } from "../../execution/progress-retention-budget.js";
import { ThreadProgressOwner } from "../../execution/thread-progress-owner.js";
import type { AcceptedProgressBatch, SavedProgressReceipt } from "../../execution/thread-progress-types.js";

const limits = { maxEvents: 20, maxBytes: 100_000, reservedControlEvents: 2, reservedControlBytes: 5_000 };

function owner(threadId: string) {
  return new ThreadProgressOwner<string>({ threadId, epoch: "epoch", durableRevision: 0,
    limits, sharedBudget: new BoundedProgressRetention(limits) });
}

function accepted(progress: ThreadProgressOwner<string>, threadId: string, id: string) {
  const execution = { threadId, turnId: `${threadId}:turn`, executionId: "10000000-0000-4000-8000-000000000001" };
  const result = progress.accept({ operationId: id, execution, admission: "progress", write: id, events: [{
    eventId: id, routing: execution, sourceProviderId: "codex", sourceIdentities: [],
    payload: { type: "turn.started", startedAt: new Date().toISOString() },
  }] });
  if (result.kind !== "accepted") throw new Error(`Unexpected admission: ${result.kind}`);
  return result.batch;
}

function receipt(batch: AcceptedProgressBatch<string>): SavedProgressReceipt {
  return { operationId: batch.operationId, contentHash: batch.contentHash, predecessor: batch.predecessor, through: batch.through, durableRevision: batch.through.sequence };
}

describe("AcceptedSaveScheduler", () => {
  it("does not block acceptance or reconnect while the actual writer operation is held", async () => {
    const progress = owner("one");
    let release: ((receipt: SavedProgressReceipt) => void) | undefined;
    const held = new Promise<SavedProgressReceipt>((resolve) => { release = resolve; });
    let writes = 0;
    const scheduler = new AcceptedSaveScheduler<string>({ writer: { append: async () => { writes += 1; return held; } },
      maxAttempts: 2, retryDelayMs: 0, retryable: () => true,
      onSaved: async (_batch, saved) => { progress.acknowledge(saved); }, onFailure: async (_batch, failure) => { progress.recordFailure(failure); } });
    const first = accepted(progress, "one", "text");
    scheduler.enqueue(first);
    const second = accepted(progress, "one", "tool");
    scheduler.enqueue(second);
    expect(writes).toBe(0);
    await Promise.resolve();
    expect(writes).toBe(1);
    expect(progress.recoveryCut().retained).toEqual([first, second]);
    expect(progress.savingState().kind).toBe("saving");
    if (!release) throw new Error("Missing held-write release");
    release(receipt(first));
    await scheduler.close();
    expect(progress.recoveryCut().saved.sequence).toBe(1);
  });

  it("takes one batch per ready thread rather than draining a noisy thread", async () => {
    const one = owner("one");
    const two = owner("two");
    const writes: string[] = [];
    const scheduler = new AcceptedSaveScheduler<string>({ writer: { append: async (batch) => { writes.push(batch.operationId); return receipt(batch); } },
      maxAttempts: 2, retryDelayMs: 0, retryable: () => true,
      onSaved: async (batch, saved) => { (batch.execution.threadId === "one" ? one : two).acknowledge(saved); }, onFailure: async () => {} });
    scheduler.enqueue(accepted(one, "one", "one:1"));
    scheduler.enqueue(accepted(one, "one", "one:2"));
    scheduler.enqueue(accepted(two, "two", "two:1"));
    await scheduler.settle();
    expect(writes).toEqual(["one:1", "two:1", "one:2"]);
    expect(scheduler.depth().pending).toBe(0);
    await scheduler.close();
  });

  it("retries identical bytes, preserves the original error, and never repeats live acceptance", async () => {
    const progress = owner("one");
    const writes: AcceptedProgressBatch<string>[] = [];
    const original = new Error("database busy");
    const failures: Error[] = [];
    const scheduler = new AcceptedSaveScheduler<string>({ writer: { append: async (batch) => {
      writes.push(batch); if (writes.length === 1) throw original; return receipt(batch);
    } }, maxAttempts: 2, retryDelayMs: 0, retryable: () => true,
    onSaved: async (_batch, saved) => { progress.acknowledge(saved); },
    onFailure: async (_batch, failure) => { failures.push(failure.error); progress.recordFailure(failure); } });
    const batch = accepted(progress, "one", "text");
    scheduler.enqueue(batch);
    await scheduler.settle();
    expect(writes).toEqual([batch, batch]);
    expect(writes[0]).toBe(writes[1]);
    expect(failures).toEqual([original]);
    expect(progress.recoveryCut().accepted.sequence).toBe(1);
    expect(progress.savingState().kind).toBe("saved");
    await scheduler.close();
  });

  it("parks permanent failure without losing retention or preventing a peer save", async () => {
    const one = owner("one");
    const two = owner("two");
    const failure = new Error("SQLITE_FULL");
    const scheduler = new AcceptedSaveScheduler<string>({ writer: { append: async (batch) => {
      if (batch.execution.threadId === "one") throw failure; return receipt(batch);
    } }, maxAttempts: 3, retryDelayMs: 0, retryable: () => false,
    onSaved: async (batch, saved) => { (batch.execution.threadId === "one" ? one : two).acknowledge(saved); },
    onFailure: async (_batch, failed) => { one.recordFailure(failed); } });
    const batch = accepted(one, "one", "one:1");
    scheduler.enqueue(batch);
    scheduler.enqueue(accepted(two, "two", "two:1"));
    await scheduler.settle();
    expect(one.savingState()).toMatchObject({ kind: "failed", error: failure });
    expect(one.recoveryCut().retained).toEqual([batch]);
    expect(two.savingState().kind).toBe("saved");
    expect(scheduler.depth()).toMatchObject({ pending: 1, threads: 1, inFlight: false });
    await scheduler.close();
  });

  it("observes a receipt callback failure without calling it a storage failure or blocking peers", async () => {
    const one = owner("one");
    const two = owner("two");
    const error = new Error("receipt mailbox unavailable");
    const storageFailures: Error[] = [];
    const observedErrors: Error[] = [];
    const scheduler = new AcceptedSaveScheduler<string>({
      writer: { append: async (batch) => receipt(batch) }, maxAttempts: 3, retryDelayMs: 0, retryable: () => true,
      onSaved: async (batch, saved) => { if (batch.execution.threadId === "one") throw error; two.acknowledge(saved); },
      onFailure: async (_batch, failure) => { storageFailures.push(failure.error); },
      onObserverError: (_batch, cause) => { observedErrors.push(cause); },
    });
    scheduler.enqueue(accepted(one, "one", "one:1"));
    scheduler.enqueue(accepted(two, "two", "two:1"));
    await expect(scheduler.settle()).rejects.toBe(error);
    expect(storageFailures).toEqual([]);
    expect(observedErrors).toEqual([error]);
    expect(two.savingState().kind).toBe("saved");
    await expect(scheduler.close()).rejects.toBe(error);
  });

  it("observes a failed failure callback and continues scheduling a peer", async () => {
    const one = owner("one");
    const two = owner("two");
    const observerError = new Error("failure mailbox unavailable");
    const observedErrors: Error[] = [];
    const scheduler = new AcceptedSaveScheduler<string>({
      writer: { append: async (batch) => { if (batch.execution.threadId === "one") throw new Error("SQLITE_FULL"); return receipt(batch); } },
      maxAttempts: 3, retryDelayMs: 0, retryable: () => false,
      onSaved: async (_batch, saved) => { two.acknowledge(saved); },
      onFailure: async () => { throw observerError; }, onObserverError: (_batch, cause) => { observedErrors.push(cause); },
    });
    scheduler.enqueue(accepted(one, "one", "one:1"));
    scheduler.enqueue(accepted(two, "two", "two:1"));
    await expect(scheduler.settle()).rejects.toBe(observerError);
    expect(observedErrors).toEqual([observerError]);
    expect(two.savingState().kind).toBe("saved");
    await expect(scheduler.close()).rejects.toBe(observerError);
  });
});
