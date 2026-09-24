import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../../canonical/canonical-execution-writer-port.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import type { ExecutionWorkerPort, ExecutionWorkerReply, ExecutionWorkerRequest } from "../execution-mailbox-protocol.js";
import type { ExecutionMailboxCommand } from "../execution-mailbox-scheduler.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "../execution-worker-handler.js";
import { ExecutionThreadWorkerPort } from "../execution-worker-port.js";
import { ExecutionWorkerLossCoordinator } from "../execution-worker-loss-coordinator.js";

const NOW = "2026-09-24T10:00:00.000Z";
const execution = {
  threadId: "lost-worker-thread", turnId: "lost-worker-turn",
  executionId: "00000000-0000-4000-8000-000000000188",
} as const;
type Command = ExecutionMailboxCommand<ExecutionWorkCommand>;

const limits = {
  maxPending: 8, maxPendingBytes: 8_000, reservedControl: 2, reservedControlBytes: 2_000,
  maxPerExecutionPending: 6, maxPerExecutionBytes: 6_000,
  reservedPerExecutionControl: 2, reservedPerExecutionControlBytes: 2_000,
};

class CrashingPort implements ExecutionWorkerPort<Command, ExecutionWorkerResult> {
  onmessage: ((event: MessageEvent<ExecutionWorkerReply<ExecutionWorkerResult>>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly inner: ExecutionThreadWorkerPort;

  constructor(writer: CanonicalExecutionWriterPort) {
    this.inner = new ExecutionThreadWorkerPort(writer);
    this.inner.onmessage = (event) => this.onmessage?.(event);
    this.inner.onerror = (event) => this.onerror?.(event);
    this.inner.onclose = () => this.onclose?.();
  }

  postMessage(request: ExecutionWorkerRequest<Command>): void {
    this.inner.postMessage(request);
  }

  terminate(): void {
    this.inner.terminate();
  }

  crash(): void {
    this.inner.terminate();
    this.onclose?.();
  }
}

describe("ExecutionWorkerLossCoordinator with a file-backed writer", () => {
  let directory: string;
  let db: Database;
  let writer: CanonicalAgentWriterClient;
  let coordinator: ExecutionWorkerLossCoordinator;
  let workers: CrashingPort[];
  let published: string[];
  let recoveryIncidentIds: string[];

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-lost-worker-host-"));
    db = openDatabase({ dbPath: NodePath.join(directory, "app.sqlite") });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("lost-worker-workspace", "Workspace", directory, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(execution.threadId, "lost-worker-workspace", "Thread", "main", "codex", NOW, NOW);
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    published = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });
    recoveryIncidentIds = [];
    workers = [];
    coordinator = new ExecutionWorkerLossCoordinator({
      interruptWorkerLoss: (input) => {
        recoveryIncidentIds.push(input.recoveryIncidentId);
        return port.interruptWorkerLoss(input);
      },
    }, {
      workerCount: 1,
      limits,
      createWorker: () => {
        const worker = new CrashingPort(port);
        workers.push(worker);
        return worker;
      },
    });
  });

  afterEach(async () => {
    coordinator.scheduler.shutdown();
    await writer.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  async function start(coordinator: ExecutionWorkerLossCoordinator, identity = execution) {
    const claim = coordinator.scheduler.claim(identity, 1);
    if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
    const command: ExecutionWorkCommand = {
      kind: "start", providerId: "codex",
      input: {
        thread: { id: identity.threadId, workspaceId: "lost-worker-workspace", providerId: "codex", createdAt: NOW },
        turnId: identity.turnId, executionId: identity.executionId,
        permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: `${identity.threadId}-user`, content: "Question", sequence: 1 },
      },
    };
    const admitted = coordinator.scheduler.submit({ execution: identity, lease: claim.lease, command, byteLength: 1_000 });
    if (admitted.kind !== "admitted") throw new Error(`Start not admitted: ${admitted.kind}`);
    expect(await admitted.completion).toMatchObject({ kind: "reply", result: { kind: "committed" } });
    return claim.lease;
  }

  it("interrupts a crashed worker before replacing its slot", async () => {
    const lease = await start(coordinator);
    new ParentAssistantTextCheckpointService(db).appendChunk([{ ...execution, sequence: 1, text: "Partial answer" }]);
    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(workers).toHaveLength(2);
    expect(db.prepare("SELECT terminal_outcome, recovery_incident_id FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toMatchObject({ terminal_outcome: "interrupted",
        recovery_incident_id: expect.stringMatching(/^worker-loss:[0-9a-f]{64}$/) });
    expect(new MessageRepo(db).listIncludingInternal(execution.threadId)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Partial answer", outcome: "interrupted", is_internal: false,
    }));
    expect(published).toContain(`${execution.executionId}:recovery-interrupted`);
    expect(coordinator.scheduler.submit({ execution, lease, command: {
      kind: "checkpoint", phase: "running", nativeCursor: null,
    }, byteLength: 100 })).toEqual({ kind: "stale-execution" });
    expect(coordinator.scheduler.claim({ ...execution, executionId: "new-execution" }, 2).kind).toBe("claimed");
  });

  it("keeps the slot fenced after a failed writer receipt until explicit retry", async () => {
    const lease = await start(coordinator);
    db.run(`CREATE TRIGGER fail_loss_receipt BEFORE INSERT ON canonical_writer_operation_receipts
      WHEN NEW.kind = 'semantic:worker-lost' BEGIN SELECT RAISE(ABORT, 'loss receipt unavailable'); END`);
    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toMatchObject({ kind: "failed", workerIndex: 0,
      unresolved: [{ execution, lease }] });
    expect(workers).toHaveLength(1);
    expect(coordinator.scheduler.claim(execution, 2)).toEqual({ kind: "thread-busy" });
    expect(coordinator.scheduler.claim({ threadId: "other", turnId: "other", executionId: "other" }, 2))
      .toEqual({ kind: "worker-unavailable" });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toEqual({ terminal_outcome: null });
    db.run("DROP TRIGGER fail_loss_receipt");
    expect(await coordinator.retryFailed(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(workers).toHaveLength(2);
    expect(recoveryIncidentIds).toHaveLength(2);
    expect(recoveryIncidentIds[1]).toBe(recoveryIncidentIds[0]);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toEqual({ terminal_outcome: "interrupted" });
  });

  it("keeps a shared slot fenced until every lost task has writer evidence", async () => {
    const second = {
      threadId: "second-lost-thread", turnId: "second-lost-turn",
      executionId: "00000000-0000-4000-8000-000000000189",
    };
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(second.threadId, "lost-worker-workspace", "Second", "main", "codex", NOW, NOW);
    await start(coordinator);
    await start(coordinator, second);
    db.run(`CREATE TRIGGER fail_second_loss BEFORE INSERT ON canonical_writer_operation_receipts
      WHEN NEW.kind = 'semantic:worker-lost' AND NEW.execution_id = '${second.executionId}'
      BEGIN SELECT RAISE(ABORT, 'second loss receipt unavailable'); END`);
    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toMatchObject({ kind: "failed", workerIndex: 0,
      unresolved: [{ execution: second }] });
    expect(workers).toHaveLength(1);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toEqual({ terminal_outcome: "interrupted" });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(second.executionId)).toEqual({ terminal_outcome: null });
    expect(coordinator.scheduler.claim(second, 2)).toEqual({ kind: "thread-busy" });
    db.run("DROP TRIGGER fail_second_loss");
    expect(await coordinator.retryFailed(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(workers).toHaveLength(2);
    expect(recoveryIncidentIds).toHaveLength(3);
    expect(recoveryIncidentIds[2]).toBe(recoveryIncidentIds[1]);
    expect(recoveryIncidentIds[0]).not.toBe(recoveryIncidentIds[1]);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(second.executionId)).toEqual({ terminal_outcome: "interrupted" });
    const incidents = db.prepare("SELECT recovery_incident_id FROM canonical_agent_ingest_checkpoints WHERE execution_id IN (?, ?)")
      .all(execution.executionId, second.executionId);
    expect(new Set(incidents.map((row) => JSON.stringify(row))).size).toBe(2);
  });

  it("replaces an idle crashed slot using the callback's slot index", async () => {
    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(workers).toHaveLength(2);
  });
});
