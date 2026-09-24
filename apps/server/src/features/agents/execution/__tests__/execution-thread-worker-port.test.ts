import type { ProviderEventDraft } from "@mcode/providers";
import { describe, expect, it } from "vitest";

import type {
  DataOnlyParentTurnFinishInput,
  DataOnlyParentTurnStartInput,
} from "../../canonical/canonical-parent-turn-write.js";
import {
  ExecutionMailboxScheduler,
  type ExecutionMailboxLimits,
  type ExecutionLostAssignment,
} from "../execution-mailbox-scheduler.js";
import type { ExecutionIdentity, ExecutionLease } from "../execution-mailbox-protocol.js";
import { ExecutionThreadWorkerPort } from "../execution-worker-port.js";
import type {
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWorkCommand,
  ExecutionWorkerResult,
  ExecutionWriteReceipt,
} from "../execution-worker-handler.js";

const EXECUTION: ExecutionIdentity = {
  threadId: "real-worker-thread",
  turnId: "real-worker-turn",
  executionId: "00000000-0000-4000-8000-000000000002",
};

const START_INPUT: DataOnlyParentTurnStartInput = {
  thread: { id: EXECUTION.threadId, workspaceId: "fixture-workspace", providerId: "codex", createdAt: "2026-09-24T12:00:00.000Z" },
  turnId: EXECUTION.turnId,
  executionId: EXECUTION.executionId,
  permissionMode: "full",
  providerIdentities: [],
  userMessage: { kind: "create", content: "Test", sequence: 1 },
};

const FINISH_INPUT: DataOnlyParentTurnFinishInput = {
  threadId: EXECUTION.threadId,
  turnId: EXECUTION.turnId,
  executionId: EXECUTION.executionId,
  providerId: "codex",
  providerIdentities: [],
  outcome: "cancelled",
  projection: { message: null, narrative: [] },
};

const LIMITS: ExecutionMailboxLimits = {
  maxPending: 8,
  maxPendingBytes: 8_000,
  reservedControl: 4,
  reservedControlBytes: 4_000,
  maxPerExecutionPending: 6,
  maxPerExecutionBytes: 6_000,
  reservedPerExecutionControl: 3,
  reservedPerExecutionControlBytes: 3_000,
};

class AcknowledgingWriter implements ExecutionSemanticWriter {
  readonly operations: ExecutionSemanticOperation[] = [];

  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    this.operations.push(operation);
    return { kind: "committed", operationId: operation.operationId, durableRevision: this.operations.length };
  }
}

function fixture(writer: ExecutionSemanticWriter, workerUrl?: URL) {
  const ports: ExecutionThreadWorkerPort[] = [];
  const lost: ExecutionLostAssignment[][] = [];
  const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
    workerCount: 1,
    limits: LIMITS,
    createWorker: () => {
      const port = new ExecutionThreadWorkerPort(writer, workerUrl);
      ports.push(port);
      return port;
    },
    onWorkerLost: (executions) => lost.push([...executions]),
  });
  const claim = scheduler.claim(EXECUTION, 1);
  if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
  return { scheduler, port: ports[0]!, lost, lease: claim.lease };
}

function submit(
  scheduler: ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>,
  lease: ExecutionLease,
  command: Parameters<typeof scheduler.submit>[0]["command"],
) {
  const admission = scheduler.submit({ execution: EXECUTION, lease, command, byteLength: 1_000 });
  if (admission.kind !== "admitted") throw new Error(`Admission failed: ${admission.kind}`);
  return admission.completion;
}

function eventDraft(): ProviderEventDraft {
  return {
    eventId: "real-worker-event-1",
    routing: { ...EXECUTION, itemId: "real-worker-item-1" },
    sourceProviderId: "codex",
    sourceIdentities: [],
    sourceSequence: 1,
    payload: { type: "turn.started", startedAt: "2026-09-24T12:00:00.000Z" },
  };
}

describe("ExecutionThreadWorkerPort", () => {
  it("starts and closes the real Bun Worker", async () => {
    const port = new ExecutionThreadWorkerPort(new AcknowledgingWriter());
    try {
      await expect(port.whenReady()).resolves.toBe(true);
      await expect(port.close()).resolves.toBe(true);
    } finally {
      port.terminate();
    }
  }, 10_000);

  it("runs a complete synthetic execution through a real Worker and writer RPC", async () => {
    const writer = new AcknowledgingWriter();
    const { scheduler, port, lease } = fixture(writer);
    try {
      await expect(submit(scheduler, lease, { kind: "start", providerId: "codex", input: START_INPUT }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed", durableRevision: 1 } });
      await expect(port.whenReady()).resolves.toBe(true);
      await expect(submit(scheduler, lease, { kind: "event", events: [eventDraft()] }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed", durableRevision: 2 } });
      await expect(submit(scheduler, lease, { kind: "stop", requestId: "stop-real-worker" }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed", durableRevision: 3 } });
      await expect(submit(scheduler, lease, { kind: "checkpoint", phase: "stopping", nativeCursor: null }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed", durableRevision: 4 } });
      await expect(submit(scheduler, lease, { kind: "finalize", outcome: "cancelled", input: FINISH_INPUT }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed", durableRevision: 5 } });
      await expect(submit(scheduler, lease, { kind: "release" }))
        .resolves.toEqual({ kind: "reply", result: { kind: "released" } });
      expect(scheduler.release(EXECUTION, lease)).toBe(true);
      expect(writer.operations.map((operation) => operation.mutation.kind))
        .toEqual(["begin", "append-events", "stop-requested", "checkpoint", "finish"]);
      expect(writer.operations[2]?.mutation).toEqual({
        kind: "stop-requested", requestId: "stop-real-worker", lastAdmittedOrdinal: 2,
      });
    } finally {
      scheduler.shutdown();
    }
  }, 10_000);

  it("treats a clean but unexpected Worker exit as ownership loss", async () => {
    const exitWorkerUrl = new URL("./fixtures/exit.worker.ts", import.meta.url);
    const { scheduler, port, lost, lease } = fixture(new AcknowledgingWriter(), exitWorkerUrl);
    try {
      await expect(port.whenReady()).resolves.toBe(true);
      await expect(submit(scheduler, lease, { kind: "start", providerId: "codex", input: START_INPUT }))
        .resolves.toEqual({ kind: "worker-lost" });
      expect(lost).toEqual([[{ execution: EXECUTION, lease }]]);
      expect(scheduler.depth()).toMatchObject({ pending: 0, activeExecutions: 0 });
    } finally {
      scheduler.shutdown();
    }
  }, 10_000);
});
