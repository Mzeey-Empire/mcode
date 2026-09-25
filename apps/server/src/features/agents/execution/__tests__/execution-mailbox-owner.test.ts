import { describe, expect, it } from "vitest";

import { ExecutionMailboxOwner } from "../execution-mailbox-owner.js";
import { ExecutionProviderEventOwnership } from "../execution-provider-event-ownership.js";
import { ExecutionMailboxScheduler, type ExecutionMailboxCommand } from "../execution-mailbox-scheduler.js";
import type { ExecutionIdentity, ExecutionWorkerPort, ExecutionWorkerReply, ExecutionWorkerRequest } from "../execution-mailbox-protocol.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "../execution-worker-handler.js";

type Command = ExecutionMailboxCommand<ExecutionWorkCommand>;

class WorkerPort implements ExecutionWorkerPort<Command, ExecutionWorkerResult> {
  onmessage: ((event: MessageEvent<ExecutionWorkerReply<ExecutionWorkerResult>>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly requests: ExecutionWorkerRequest<Command>[] = [];

  postMessage(request: ExecutionWorkerRequest<Command>): void { this.requests.push(request); }
  terminate(): void {}

  reply(index: number, result: ExecutionWorkerResult): void {
    const request = this.requests[index];
    if (!request) throw new Error(`Missing request ${index}`);
    this.onmessage?.(new MessageEvent("message", { data: { ...request, result } }));
  }
}

const execution: ExecutionIdentity = { threadId: "thread-1", turnId: "turn-1", executionId: "execution-1" };
const parentTurn = {
  thread: { id: execution.threadId, workspaceId: "workspace-1", providerId: "codex", createdAt: "2026-09-24T00:00:00.000Z" },
  turnId: execution.turnId,
  executionId: execution.executionId,
  permissionMode: "supervised" as const,
  providerIdentities: [],
  userMessage: { kind: "create" as const, messageId: "user-1", content: "Run", sequence: 1 },
};

describe("ExecutionMailboxOwner", () => {
  it("claims before durable start and admits Stop behind earlier commands", async () => {
    const worker = new WorkerPort();
    const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
      workerCount: 1,
      limits: {
        maxPending: 8, maxPendingBytes: 128_000, reservedControl: 2, reservedControlBytes: 16_000,
        maxPerExecutionPending: 8, maxPerExecutionBytes: 128_000,
        reservedPerExecutionControl: 2, reservedPerExecutionControlBytes: 16_000,
      },
      createWorker: () => worker,
      onWorkerLost: () => {},
    });
    const owner = new ExecutionMailboxOwner(scheduler);
    const starting = owner.start({ execution, ownerEpoch: 1, providerId: "codex", parentTurn });
    expect(worker.requests[0]?.command.kind).toBe("start");
    expect(owner.current(execution.threadId)?.execution).toEqual(execution);
    await expect(owner.start({ execution, ownerEpoch: 2, providerId: "codex", parentTurn }))
      .rejects.toThrow("already has an execution owner");
    worker.reply(0, { kind: "committed", operationId: `${worker.requests[0]!.lease.leaseId}:1`, durableRevision: 1 });
    await starting;

    const checkpoint = owner.submit(execution, { kind: "checkpoint", phase: "running", nativeCursor: null });
    const stopped = owner.stop(execution, "stop-1");
    expect(worker.requests[1]?.command.kind).toBe("checkpoint");
    await expect(owner.submit(execution, { kind: "assistant-text", inputs: [] }))
      .rejects.toThrow("stopping");
    expect(() => owner.submit({ ...execution, executionId: "stale" }, { kind: "checkpoint", phase: "running", nativeCursor: null }))
      .toThrow("No matching execution owner");
    worker.reply(1, { kind: "committed", operationId: `${worker.requests[1]!.lease.leaseId}:2`, durableRevision: 1 });
    expect(worker.requests[2]).toMatchObject({ stopWatermark: 2, command: { kind: "stop", requestId: "stop-1" } });
    worker.reply(2, { kind: "committed", operationId: `${worker.requests[2]!.lease.leaseId}:3`, durableRevision: 1 });
    await checkpoint;
    await stopped;
    scheduler.shutdown();
  });
});

describe("ExecutionProviderEventOwnership", () => {
  it("submits an exact attempt to its mailbox and rejects retired or superseded attempts", async () => {
    const worker = new WorkerPort();
    const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
      workerCount: 1,
      limits: {
        maxPending: 8, maxPendingBytes: 128_000, reservedControl: 2, reservedControlBytes: 16_000,
        maxPerExecutionPending: 8, maxPerExecutionBytes: 128_000,
        reservedPerExecutionControl: 2, reservedPerExecutionControlBytes: 16_000,
      },
      createWorker: () => worker,
      onWorkerLost: () => {},
    });
    const owner = new ExecutionMailboxOwner(scheduler);
    const ownership = new ExecutionProviderEventOwnership(owner);
    expect(ownership.resolve(execution.executionId)).toEqual({ kind: "rejected" });
    const start = owner.start({ execution, ownerEpoch: 1, providerId: "codex", parentTurn });
    await expect(ownership.bind(execution, 1)).rejects.toThrow("no matching execution owner");
    worker.reply(0, { kind: "committed", operationId: `${worker.requests[0]!.lease.leaseId}:1`, durableRevision: 1 });
    await start;
    await ownership.bind(execution, 1);
    const route = ownership.resolve(execution.executionId);
    if (route.kind !== "worker") throw new Error("Expected worker route");
    const batch = {
      threadId: execution.threadId, turnId: execution.turnId, executionId: execution.executionId,
      batchId: "batch-1", deliveryAttempt: 1, phase: "running", events: [],
    };
    const submitted = route.submit(batch);
    expect(worker.requests[1]?.command).toMatchObject({ kind: "event", phase: "running", events: [] });
    const nextAttempt = ownership.bind(execution, 2);
    expect(ownership.resolve(execution.executionId)).toEqual({ kind: "rejected" });
    await expect(route.submit(batch)).rejects.toThrow("retired execution attempt");
    worker.reply(1, {
      kind: "committed", operationId: `${worker.requests[1]!.lease.leaseId}:2`, durableRevision: 1,
      providerCommit: {
        outcome: "committed", conversationRevision: 1, rosterRevision: 0,
        acceptedThrough: 1, durableThrough: 1, eventCount: 0,
      },
    });
    await expect(submitted).resolves.toMatchObject({ batchId: "batch-1",
      deliveryAttempt: 1, commit: { outcome: "committed" } });

    await nextAttempt;
    expect(ownership.resolve(execution.executionId)).toMatchObject({ kind: "worker", deliveryAttempt: 2 });
    await ownership.retire(execution);
    expect(ownership.resolve(execution.executionId)).toEqual({ kind: "rejected" });
    expect(worker.requests).toHaveLength(2);
    scheduler.shutdown();
  });
});
