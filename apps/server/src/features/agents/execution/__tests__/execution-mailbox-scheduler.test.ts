import { describe, expect, it } from "vitest";

import {
  ExecutionMailboxScheduler,
  type ExecutionMailboxLimits,
} from "../execution-mailbox-scheduler.js";
import type {
  ExecutionIdentity,
  ExecutionWorkerPort,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from "../execution-mailbox-protocol.js";

type Work =
  | { readonly kind: "start" }
  | { readonly kind: "event"; readonly sequence: number }
  | { readonly kind: "checkpoint"; readonly revision: number }
  | { readonly kind: "effect-result"; readonly effectId: string }
  | { readonly kind: "finalize" };
type Command = Work | { readonly kind: "stop"; readonly requestId: string };
type Result = { readonly revision: number };

const LIMITS: ExecutionMailboxLimits = {
  maxPending: 8,
  maxPendingBytes: 800,
  reservedControl: 2,
  reservedControlBytes: 200,
  maxPerExecutionPending: 5,
  maxPerExecutionBytes: 500,
  reservedPerExecutionControl: 2,
  reservedPerExecutionControlBytes: 200,
};

class FakeWorker implements ExecutionWorkerPort<Command, Result> {
  onmessage: ((event: MessageEvent<ExecutionWorkerReply<Result>>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly requests: ExecutionWorkerRequest<Command>[] = [];
  terminated = false;

  postMessage(request: ExecutionWorkerRequest<Command>): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(request: ExecutionWorkerRequest<Command>, revision: number): void {
    this.onmessage?.(new MessageEvent("message", {
      data: { ...request, result: { revision } },
    }));
  }

  crash(): void {
    this.onerror?.(new ErrorEvent("error"));
  }

  close(): void {
    this.onclose?.();
  }
}

function execution(threadId: string, executionId = `execution-${threadId}`): ExecutionIdentity {
  return { threadId, turnId: `turn-${threadId}`, executionId };
}

function fixture(workerCount = 1, limits = LIMITS) {
  const workers: FakeWorker[] = [];
  const lost: ExecutionIdentity[][] = [];
  const scheduler = new ExecutionMailboxScheduler<Work, Result>({
    workerCount,
    limits,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onWorkerLost: (affected) => lost.push([...affected]),
  });
  return { scheduler, workers, lost };
}

function claimed(scheduler: ExecutionMailboxScheduler<Work, Result>, identity: ExecutionIdentity, epoch = 1) {
  const claim = scheduler.claim(identity, epoch);
  if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
  return claim.lease;
}

function admitted(
  scheduler: ExecutionMailboxScheduler<Work, Result>,
  identity: ExecutionIdentity,
  lease: ReturnType<typeof claimed>,
  command: Command,
  byteLength = 100,
) {
  const admission = scheduler.submit({ execution: identity, lease, command, byteLength });
  if (admission.kind !== "admitted") throw new Error(`Admission failed: ${admission.kind}`);
  return admission;
}

function request(worker: FakeWorker, index: number): ExecutionWorkerRequest<Command> {
  const next = worker.requests[index];
  if (!next) throw new Error(`Missing worker request ${index}`);
  return next;
}

describe("ExecutionMailboxScheduler", () => {
  it("keeps an execution on one worker and processes each mailbox in order", async () => {
    const { scheduler, workers } = fixture(2);
    const first = execution("first");
    const second = execution("second");
    const third = execution("third");
    const firstLease = claimed(scheduler, first);
    const secondLease = claimed(scheduler, second);
    const thirdLease = claimed(scheduler, third);
    expect(firstLease.workerIndex).toBe(0);
    expect(secondLease.workerIndex).toBe(1);
    expect(thirdLease.workerIndex).toBe(0);

    const firstStart = admitted(scheduler, first, firstLease, { kind: "start" });
    const firstEvent = admitted(scheduler, first, firstLease, { kind: "event", sequence: 1 });
    const thirdStart = admitted(scheduler, third, thirdLease, { kind: "start" });
    const secondStart = admitted(scheduler, second, secondLease, { kind: "start" });
    expect(workers[0]?.requests).toHaveLength(1);
    expect(workers[1]?.requests).toHaveLength(1);

    workers[0]?.reply(request(workers[0], 0), 1);
    expect(request(workers[0]!, 1).execution).toEqual(first);
    workers[0]?.reply(request(workers[0]!, 1), 2);
    expect(request(workers[0]!, 2).execution).toEqual(third);
    workers[0]?.reply(request(workers[0]!, 2), 1);
    workers[1]?.reply(request(workers[1]!, 0), 1);

    expect([firstStart.ordinal, firstEvent.ordinal, thirdStart.ordinal]).toEqual([1, 2, 1]);
    expect(await firstEvent.completion).toEqual({ kind: "reply", result: { revision: 2 } });
    expect(await thirdStart.completion).toEqual({ kind: "reply", result: { revision: 1 } });
    expect(await secondStart.completion).toEqual({ kind: "reply", result: { revision: 1 } });
    expect(scheduler.release(first, firstLease)).toBe(true);
    expect(scheduler.depth().pending).toBe(0);
    scheduler.shutdown();
  });

  it("reserves count and byte credits for control commands within one execution", async () => {
    const { scheduler, workers } = fixture();
    const identity = execution("busy");
    const lease = claimed(scheduler, identity);
    const first = admitted(scheduler, identity, lease, { kind: "event", sequence: 1 });
    const second = admitted(scheduler, identity, lease, { kind: "event", sequence: 2 });
    const third = admitted(scheduler, identity, lease, { kind: "event", sequence: 3 });
    expect(scheduler.submit({ execution: identity, lease, command: { kind: "event", sequence: 4 }, byteLength: 100 }))
      .toEqual({ kind: "overloaded" });
    const stop = admitted(scheduler, identity, lease, { kind: "stop", requestId: "stop-1" });
    expect(scheduler.depth()).toMatchObject({ pending: 4, pendingBytes: 400 });
    expect(scheduler.submit({ execution: identity, lease, command: { kind: "stop", requestId: "stop-2" }, byteLength: 100 }))
      .toEqual({ kind: "stop-already-requested" });
    const checkpoint = admitted(scheduler, identity, lease, { kind: "checkpoint", revision: 1 });
    expect(scheduler.depth()).toMatchObject({ pending: 5, pendingBytes: 500 });

    for (let index = 0; index < 5; index += 1) workers[0]?.reply(request(workers[0]!, index), index + 1);
    expect((await stop.completion).kind).toBe("reply");
    expect((await checkpoint.completion).kind).toBe("reply");
    expect((await first.completion).kind).toBe("reply");
    expect((await second.completion).kind).toBe("reply");
    expect((await third.completion).kind).toBe("reply");
    expect(workers[0]?.requests.map((item) => item.command.kind)).toEqual(["event", "event", "event", "stop", "checkpoint"]);
    scheduler.shutdown();
  });

  it("closes ordinary admission at Stop's watermark while lifecycle controls still settle", async () => {
    const { scheduler, workers } = fixture();
    const identity = execution("stopping");
    const lease = claimed(scheduler, identity);
    const start = admitted(scheduler, identity, lease, { kind: "start" });
    const event = admitted(scheduler, identity, lease, { kind: "event", sequence: 1 });
    const stop = admitted(scheduler, identity, lease, { kind: "stop", requestId: "stop-now" });
    expect(scheduler.submit({ execution: identity, lease, command: { kind: "event", sequence: 2 }, byteLength: 100 }))
      .toEqual({ kind: "stopping" });
    const checkpoint = admitted(scheduler, identity, lease, { kind: "checkpoint", revision: 2 });
    const effect = admitted(scheduler, identity, lease, { kind: "effect-result", effectId: "file-1" });
    expect(request(workers[0]!, 0).ordinal).toBe(1);
    workers[0]?.reply(request(workers[0]!, 0), 1);
    workers[0]?.reply(request(workers[0]!, 1), 2);
    expect(request(workers[0]!, 2)).toMatchObject({
      ordinal: 3,
      stopWatermark: 2,
      command: { kind: "stop", requestId: "stop-now" },
    });
    workers[0]?.reply(request(workers[0]!, 2), 3);
    expect(await stop.completion).toEqual({ kind: "reply", result: { revision: 3 } });
    expect(scheduler.submit({ execution: identity, lease, command: { kind: "event", sequence: 3 }, byteLength: 100 }))
      .toEqual({ kind: "stopping" });
    expect(scheduler.submit({ execution: identity, lease, command: { kind: "stop", requestId: "again" }, byteLength: 100 }))
      .toEqual({ kind: "stop-already-requested" });
    const finalize = admitted(scheduler, identity, lease, { kind: "finalize" });
    for (let index = 3; index < 6; index += 1) workers[0]?.reply(request(workers[0]!, index), index + 1);
    expect(await start.completion).toEqual({ kind: "reply", result: { revision: 1 } });
    expect(await event.completion).toEqual({ kind: "reply", result: { revision: 2 } });
    expect((await checkpoint.completion).kind).toBe("reply");
    expect((await effect.completion).kind).toBe("reply");
    expect((await finalize.completion).kind).toBe("reply");
    expect(scheduler.release(identity, lease)).toBe(true);
    scheduler.shutdown();
  });

  it("keeps a global byte reserve when several executions fill normal capacity", async () => {
    const limits: ExecutionMailboxLimits = {
      ...LIMITS,
      maxPending: 10,
      maxPendingBytes: 500,
      reservedControl: 1,
      reservedControlBytes: 100,
      maxPerExecutionBytes: 500,
    };
    const { scheduler } = fixture(1, limits);
    const first = execution("first");
    const second = execution("second");
    const third = execution("third");
    const firstLease = claimed(scheduler, first);
    const secondLease = claimed(scheduler, second);
    const thirdLease = claimed(scheduler, third);
    admitted(scheduler, first, firstLease, { kind: "event", sequence: 1 }, 200);
    admitted(scheduler, second, secondLease, { kind: "event", sequence: 1 }, 200);
    expect(scheduler.submit({ execution: third, lease: thirdLease, command: { kind: "start" }, byteLength: 100 }))
      .toEqual({ kind: "overloaded" });
    admitted(scheduler, first, firstLease, { kind: "stop", requestId: "reserved" }, 100);
    expect(scheduler.depth()).toMatchObject({ pending: 3, pendingBytes: 500 });
    expect(scheduler.submit({ execution: second, lease: secondLease, command: { kind: "stop", requestId: "full" }, byteLength: 100 }))
      .toEqual({ kind: "overloaded" });
    scheduler.shutdown();
  });

  it("lets another execution progress while Stop remains behind its own earlier events", async () => {
    const { scheduler, workers } = fixture();
    const chatty = execution("chatty");
    const quiet = execution("quiet");
    const chattyLease = claimed(scheduler, chatty);
    const quietLease = claimed(scheduler, quiet);
    admitted(scheduler, chatty, chattyLease, { kind: "event", sequence: 1 });
    admitted(scheduler, chatty, chattyLease, { kind: "event", sequence: 2 });
    const stop = admitted(scheduler, chatty, chattyLease, { kind: "stop", requestId: "stop-chatty" });
    const quietEvent = admitted(scheduler, quiet, quietLease, { kind: "event", sequence: 1 });
    for (let index = 0; index < 4; index += 1) workers[0]?.reply(request(workers[0]!, index), index + 1);
    expect(workers[0]?.requests.map((item) => `${item.execution.threadId}:${item.command.kind}`))
      .toEqual(["chatty:event", "chatty:event", "quiet:event", "chatty:stop"]);
    expect((await quietEvent.completion).kind).toBe("reply");
    expect((await stop.completion).kind).toBe("reply");
    scheduler.shutdown();
  });

  it("revokes a crashed worker without replay and fences late replies from its generation", async () => {
    const { scheduler, workers, lost } = fixture();
    const oldExecution = execution("same-thread", "old-execution");
    const oldLease = claimed(scheduler, oldExecution);
    const first = admitted(scheduler, oldExecution, oldLease, { kind: "event", sequence: 1 });
    const queued = admitted(scheduler, oldExecution, oldLease, { kind: "event", sequence: 2 });
    const oldRequest = request(workers[0]!, 0);
    workers[0]?.crash();
    expect(await first.completion).toEqual({ kind: "worker-lost" });
    expect(await queued.completion).toEqual({ kind: "worker-lost" });
    expect(lost).toEqual([[oldExecution]]);
    expect(workers[0]?.terminated).toBe(true);
    expect(scheduler.claim(execution("unavailable"), 2)).toEqual({ kind: "worker-unavailable" });
    expect(scheduler.submit({ execution: oldExecution, lease: oldLease, command: { kind: "stop", requestId: "stale" }, byteLength: 100 }))
      .toEqual({ kind: "stale-execution" });

    expect(scheduler.replaceWorker(0)).toBe(true);
    expect(workers[1]?.requests).toHaveLength(0);

    const newExecution = execution("same-thread", "new-execution");
    const newLease = claimed(scheduler, newExecution, 2);
    expect(scheduler.submit({ execution: newExecution, lease: oldLease, command: { kind: "start" }, byteLength: 100 }))
      .toEqual({ kind: "stale-execution" });
    const newEvent = admitted(scheduler, newExecution, newLease, { kind: "event", sequence: 1 });
    workers[0]?.reply(oldRequest, 99);
    expect(scheduler.depth().pending).toBe(1);
    workers[1]?.reply(request(workers[1]!, 0), 1);
    expect(await newEvent.completion).toEqual({ kind: "reply", result: { revision: 1 } });
    expect(scheduler.release(oldExecution, oldLease)).toBe(false);
    scheduler.shutdown();
  });

  it("revokes a worker whose reply claims a different execution", async () => {
    const { scheduler, workers, lost } = fixture();
    const identity = execution("target");
    const lease = claimed(scheduler, identity);
    const admission = admitted(scheduler, identity, lease, { kind: "start" });
    const sent = request(workers[0]!, 0);
    workers[0]?.onmessage?.(new MessageEvent("message", {
      data: { ...sent, execution: execution("other"), result: { revision: 1 } },
    }));
    expect(await admission.completion).toEqual({ kind: "worker-lost" });
    expect(lost).toEqual([[identity]]);
    scheduler.shutdown();
  });

  it("keeps a different worker usable after one worker crashes", async () => {
    const { scheduler, workers, lost } = fixture(2);
    const failed = execution("failed");
    const healthy = execution("healthy");
    const failedLease = claimed(scheduler, failed);
    const healthyLease = claimed(scheduler, healthy);
    const failedEvent = admitted(scheduler, failed, failedLease, { kind: "event", sequence: 1 });
    const healthyEvent = admitted(scheduler, healthy, healthyLease, { kind: "event", sequence: 1 });
    workers[0]?.crash();
    workers[1]?.reply(request(workers[1]!, 0), 1);
    expect(await failedEvent.completion).toEqual({ kind: "worker-lost" });
    expect(await healthyEvent.completion).toEqual({ kind: "reply", result: { revision: 1 } });
    expect(lost).toEqual([[failed]]);
    const another = execution("another");
    expect(claimed(scheduler, another).workerIndex).toBe(1);
    scheduler.shutdown();
  });

  it("revokes retained commands when a worker exits without an error", async () => {
    const { scheduler, workers, lost } = fixture();
    const identity = execution("closed");
    const lease = claimed(scheduler, identity);
    const event = admitted(scheduler, identity, lease, { kind: "event", sequence: 1 });
    workers[0]?.close();
    expect(await event.completion).toEqual({ kind: "worker-lost" });
    expect(lost).toEqual([[identity]]);
    expect(scheduler.depth()).toMatchObject({ pending: 0, activeExecutions: 0 });
    scheduler.shutdown();
  });

  it("rejects a second active execution on the same thread and settles shutdown", async () => {
    const { scheduler } = fixture();
    const identity = execution("one", "first");
    const lease = claimed(scheduler, identity);
    expect(scheduler.claim(execution("one", "second"), 2)).toEqual({ kind: "thread-busy" });
    const admission = admitted(scheduler, identity, lease, { kind: "start" });
    expect(scheduler.release(identity, lease)).toBe(false);
    scheduler.shutdown();
    expect(await admission.completion).toEqual({ kind: "shutdown" });
    expect(scheduler.depth()).toMatchObject({ pending: 0, pendingBytes: 0, activeExecutions: 0 });
  });
});
