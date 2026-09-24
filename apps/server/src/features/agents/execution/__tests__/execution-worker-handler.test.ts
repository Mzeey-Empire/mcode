import type { ProviderEventDraft } from "@mcode/providers";
import { describe, expect, it } from "vitest";

import {
  ExecutionMailboxScheduler,
  type ExecutionMailboxCommand,
  type ExecutionMailboxLimits,
} from "../execution-mailbox-scheduler.js";
import type {
  ExecutionIdentity,
  ExecutionLease,
  ExecutionWorkerPort,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from "../execution-mailbox-protocol.js";
import {
  ExecutionWorkerHandler,
  type ExecutionSemanticOperation,
  type ExecutionSemanticWriter,
  type ExecutionWorkCommand,
  type ExecutionWorkerResult,
  type ExecutionWriteReceipt,
} from "../execution-worker-handler.js";

type Command = ExecutionMailboxCommand<ExecutionWorkCommand>;

const EXECUTION: ExecutionIdentity = {
  threadId: "fixture-thread",
  turnId: "fixture-turn",
  executionId: "00000000-0000-4000-8000-000000000001",
};

const LIMITS: ExecutionMailboxLimits = {
  maxPending: 12,
  maxPendingBytes: 12_000,
  reservedControl: 6,
  reservedControlBytes: 6_000,
  maxPerExecutionPending: 8,
  maxPerExecutionBytes: 8_000,
  reservedPerExecutionControl: 5,
  reservedPerExecutionControlBytes: 5_000,
};

class RecordingWriter implements ExecutionSemanticWriter {
  readonly operations: ExecutionSemanticOperation[] = [];
  beforeCommit: ((operation: ExecutionSemanticOperation) => Promise<void>) | undefined;
  conflictKind: ExecutionSemanticOperation["mutation"]["kind"] | undefined;

  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    this.operations.push(operation);
    await this.beforeCommit?.(operation);
    if (operation.mutation.kind === this.conflictKind) {
      return { kind: "conflict", operationId: operation.operationId };
    }
    return { kind: "committed", operationId: operation.operationId, durableRevision: this.operations.length };
  }
}

class InlineWorker implements ExecutionWorkerPort<Command, ExecutionWorkerResult> {
  onmessage: ((event: MessageEvent<ExecutionWorkerReply<ExecutionWorkerResult>>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: ExecutionWorkerRequest<Command>[] = [];
  terminated = false;

  constructor(private readonly handler: ExecutionWorkerHandler) {}

  postMessage(request: ExecutionWorkerRequest<Command>): void {
    this.requests.push(request);
    void this.handler.handle(request)
      .then((reply) => this.onmessage?.(new MessageEvent("message", { data: reply })))
      .catch(() => this.onerror?.(new ErrorEvent("error")));
  }

  terminate(): void {
    this.terminated = true;
  }
}

function fixture(writer = new RecordingWriter()) {
  const workers: InlineWorker[] = [];
  const lost: ExecutionIdentity[][] = [];
  const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
    workerCount: 1,
    limits: LIMITS,
    createWorker: () => {
      const worker = new InlineWorker(new ExecutionWorkerHandler(writer));
      workers.push(worker);
      return worker;
    },
    onWorkerLost: (executions) => lost.push([...executions]),
  });
  const claim = scheduler.claim(EXECUTION, 1);
  if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
  return { scheduler, worker: workers[0]!, writer, lost, lease: claim.lease };
}

function submit(
  scheduler: ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>,
  lease: ExecutionLease,
  command: Command,
) {
  const admission = scheduler.submit({ execution: EXECUTION, lease, command, byteLength: 1_000 });
  if (admission.kind !== "admitted") throw new Error(`Admission failed: ${admission.kind}`);
  return admission;
}

function eventDraft(): ProviderEventDraft {
  return {
    eventId: "fixture-event-1",
    routing: { ...EXECUTION, itemId: "fixture-item-1" },
    sourceProviderId: "codex",
    sourceIdentities: [],
    sourceSequence: 1,
    payload: { type: "turn.started", startedAt: "2026-09-24T12:00:00.000Z" },
  };
}

async function committed(admission: ReturnType<typeof submit>, revision: number): Promise<void> {
  await expect(admission.completion).resolves.toMatchObject({
    kind: "reply",
    result: { kind: "committed", durableRevision: revision },
  });
}

describe("ExecutionWorkerHandler through its scheduler", () => {
  it("runs one synthetic turn from start through Stop, checkpoint, and finalization", async () => {
    const { scheduler, worker, writer, lease } = fixture();
    await committed(submit(scheduler, lease, { kind: "start", providerId: "codex" }), 1);
    await committed(submit(scheduler, lease, { kind: "event", events: [eventDraft()] }), 2);
    const stop = submit(scheduler, lease, { kind: "stop", requestId: "stop-1" });
    expect(scheduler.submit({
      execution: EXECUTION,
      lease,
      command: { kind: "event", events: [eventDraft()] },
      byteLength: 1_000,
    })).toEqual({ kind: "stopping" });
    await committed(stop, 3);
    await committed(submit(scheduler, lease, { kind: "checkpoint", phase: "stopping", nativeCursor: "cursor-1" }), 4);
    await committed(submit(scheduler, lease, { kind: "effect-result", effectId: "file-1", settled: true }), 5);
    await committed(submit(scheduler, lease, { kind: "provider-outcome", outcome: "cancelled" }), 6);
    await committed(submit(scheduler, lease, { kind: "finalize", outcome: "cancelled" }), 7);
    await expect(submit(scheduler, lease, { kind: "release" }).completion).resolves.toEqual({
      kind: "reply",
      result: { kind: "released" },
    });
    expect(scheduler.release(EXECUTION, lease)).toBe(true);

    expect(writer.operations.map((operation) => operation.mutation.kind)).toEqual([
      "begin", "append-events", "stop-requested", "checkpoint", "effect-result", "provider-outcome", "finish",
    ]);
    expect(writer.operations[2]?.mutation).toEqual({
      kind: "stop-requested", requestId: "stop-1", lastAdmittedOrdinal: 2,
    });
    expect(worker.requests.map((request) => request.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(worker.requests.every((request) => request.execution.executionId === EXECUTION.executionId
      && request.lease.leaseId === lease.leaseId)).toBe(true);
    expect(scheduler.depth()).toMatchObject({ pending: 0, activeExecutions: 0 });
    scheduler.shutdown();
  });

  it("does not acknowledge a worker command until its writer receipt arrives", async () => {
    const writer = new RecordingWriter();
    let releaseWrite: (() => void) | undefined;
    writer.beforeCommit = () => new Promise<void>((resolve) => { releaseWrite = resolve; });
    const { scheduler, worker, lease } = fixture(writer);
    const start = submit(scheduler, lease, { kind: "start", providerId: "codex" });
    const event = submit(scheduler, lease, { kind: "event", events: [eventDraft()] });
    await Promise.resolve();
    expect(worker.requests).toHaveLength(1);
    expect(scheduler.depth()).toMatchObject({ pending: 2 });
    releaseWrite?.();
    await committed(start, 1);
    expect(worker.requests).toHaveLength(2);
    releaseWrite?.();
    await committed(event, 2);
    scheduler.shutdown();
  });

  it("rejects a writer conflict without reporting a durable command", async () => {
    const writer = new RecordingWriter();
    writer.conflictKind = "append-events";
    const { scheduler, lease } = fixture(writer);
    await committed(submit(scheduler, lease, { kind: "start", providerId: "codex" }), 1);
    await expect(submit(scheduler, lease, { kind: "event", events: [eventDraft()] }).completion).resolves.toEqual({
      kind: "reply",
      result: { kind: "rejected", reason: "writer-conflict" },
    });
    await expect(submit(scheduler, lease, { kind: "checkpoint", phase: "running", nativeCursor: null }).completion)
      .resolves.toEqual({ kind: "reply", result: { kind: "rejected", reason: "out-of-order" } });
    scheduler.shutdown();
  });

  it("revokes the execution when the writer fails instead of acknowledging its event", async () => {
    const writer = new RecordingWriter();
    writer.beforeCommit = async (operation) => {
      if (operation.mutation.kind === "append-events") throw new Error("database unavailable");
    };
    const { scheduler, worker, lost, lease } = fixture(writer);
    await committed(submit(scheduler, lease, { kind: "start", providerId: "codex" }), 1);
    await expect(submit(scheduler, lease, { kind: "event", events: [eventDraft()] }).completion)
      .resolves.toEqual({ kind: "worker-lost" });
    expect(lost).toEqual([[EXECUTION]]);
    expect(worker.terminated).toBe(true);
    expect(scheduler.depth()).toMatchObject({ pending: 0, activeExecutions: 0 });
    scheduler.shutdown();
  });
});
