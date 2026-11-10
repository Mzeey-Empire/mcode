import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventSchema, type AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ProviderEventDraft } from "@mcode/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../../canonical/canonical-execution-writer-port.js";
import { CanonicalAcceptedProgress } from "../../canonical/canonical-accepted-progress.js";
import { CanonicalAgentStore as CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { ExecutionLivePublicationRelease } from "../../canonical/execution-live-publication-release.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { CanonicalAgentStore } from "../../canonical/canonical-agent-boundary.js";
import type { ExecutionIdentity, ExecutionLease, ExecutionWorkerPort, ExecutionWorkerReply, ExecutionWorkerRequest } from "../execution-mailbox-protocol.js";
import type { ExecutionLostAssignment, ExecutionMailboxCommand } from "../execution-mailbox-scheduler.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "../execution-worker-handler.js";
import { ExecutionThreadWorkerPort } from "../execution-worker-port.js";
import { ExecutionWorkerLossCoordinator } from "../execution-worker-loss-coordinator.js";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { RealGitExecutor } from "../../../projects/git/execution/real-git-executor.js";
import { RepositoryGitMutationLock } from "../../../projects/git/repository-git-mutation-lock.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { ensureSnapshotStoreId } from "../../../projects/diffs/snapshots/snapshot-store-identity.js";
import { SnapshotRefPins } from "../../../projects/diffs/snapshots/snapshot-ref-pins.js";

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
  let owner: ApplicationDatabaseWriter;
  let coordinator: ExecutionWorkerLossCoordinator;
  let workers: CrashingPort[];
  let published: string[];
  let liveEvents: AgentEvent[];
  let recoveryIncidentIds: string[];
  let recoveredAssignments: ExecutionLostAssignment[];

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-lost-worker-host-"));
    db = openDatabase({ dbPath: NodePath.join(directory, "app.sqlite") });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("lost-worker-workspace", "Workspace", directory, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(execution.threadId, "lost-worker-workspace", "Thread", "main", "codex", NOW, NOW);
    owner = new ApplicationDatabaseWriter(NodePath.join(directory, "app.sqlite"));
    writer = new CanonicalAgentWriterClient(owner);
    published = [];
    liveEvents = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    }, new ExecutionLivePublicationRelease({
      isBound: () => true,
      publish: (event) => liveEvents.push(event),
    }));
    recoveryIncidentIds = [];
    recoveredAssignments = [];
    workers = [];
    coordinator = new ExecutionWorkerLossCoordinator({
      interruptWorkerLoss: (input) => {
        recoveryIncidentIds.push(input.recoveryIncidentId);
        return port.interruptWorkerLoss(input);
      },
      released: (identity, lease) => port.released(identity, lease),
    }, {
      workerCount: 1,
      limits,
      createWorker: () => {
        const worker = new CrashingPort(port);
        workers.push(worker);
        return worker;
      },
    }, (assignment) => recoveredAssignments.push(assignment));
  });

  afterEach(async () => {
    coordinator.scheduler.shutdown();
    await owner.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  async function start(coordinator: ExecutionWorkerLossCoordinator, identity: ExecutionIdentity = execution) {
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

  it.each(["claude", "devin", "codex", "overflow"].flatMap((scenario) =>
    [true, false].map((ownerAlive) => ({ scenario, ownerAlive }))))("recovers checkpointed $scenario live text after its worker dies (owner alive $ownerAlive)", async ({ scenario, ownerAlive }) => {
    const providerId = scenario === "overflow" ? "claude" : scenario;
    coordinator.scheduler.shutdown();
    const progress = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, owner, writer, () => {}), writer);
    const port = new CanonicalExecutionWriterPort(writer, () => {}, undefined, undefined, progress);
    // Recovery after losing the progress owner must read the committed checkpoint, not its in-memory answer.
    const recoveryPort = ownerAlive ? port : new CanonicalExecutionWriterPort(writer, () => {});
    coordinator = new ExecutionWorkerLossCoordinator(recoveryPort, { workerCount: 1, limits, createWorker: () => {
      const worker = new CrashingPort(port);
      workers.push(worker);
      return worker;
    } });
    try {
      const claim = coordinator.scheduler.claim(execution, 1);
      if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
      const send = async (command: ExecutionWorkCommand) => {
        const admission = coordinator.scheduler.submit({ execution, lease: claim.lease, command, byteLength: 1_000 });
        if (admission.kind !== "admitted") throw new Error(`Not admitted: ${admission.kind}`);
        const reply = await admission.completion;
        expect(reply).toMatchObject({ kind: "reply" });
      };
      await send({ kind: "start", providerId, publishParentStart: true,
        parentLive: { planFeature: "none", precedingMessageId: `${execution.threadId}-user` },
        input: { thread: { id: execution.threadId, workspaceId: "lost-worker-workspace", providerId, createdAt: NOW },
          turnId: execution.turnId, executionId: execution.executionId, permissionMode: "supervised", providerIdentities: [],
          userMessage: { kind: "create", messageId: `${execution.threadId}-user`, content: "Question", sequence: 1 } } });
      const deltas = scenario === "overflow" ? Array.from({ length: 20 }, () => "x".repeat(15360)) : ["Partial ", "answer"];
      for (const [index, delta] of deltas.entries()) {
        const id = `live-text-${index}`;
        await send({ kind: "event", phase: "running", nativeCursor: null, events: [{
          eventId: id, routing: { ...execution, itemId: id }, sourceProviderId: providerId, sourceIdentities: [], delivery: "live",
          payload: { type: "item.recorded", item: { id, threadId: execution.threadId, turnId: execution.turnId,
            kind: "system", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
            payload: { projection: "providerRuntimeEvent", runtimeEvent: { event: { type: "textDelta",
              threadId: execution.threadId, turnExecutionId: execution.executionId, delta, isFinalResponse: true } } } } } }] });
        if (scenario === "overflow") await progress.waitForSaved(execution.threadId);
      }
      await progress.waitForSaved(execution.threadId);
      const prefix = scenario === "overflow" ? "x".repeat(ownerAlive ? 307200 : 261120) : "Partial answer";
      workers.at(-1)?.crash();
      expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
      await progress.waitForSaved(execution.threadId);
      expect(new MessageRepo(db, owner).listIncludingInternal(execution.threadId)
        .filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([prefix]);
    } finally {
      await progress.close();
    }
  });

  it("carries committed start, tool narrative, live publication, and finish through both workers", async () => {
    const claim = coordinator.scheduler.claim(execution, 1);
    if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
    const send = async (command: ExecutionWorkCommand) => {
      const admitted = coordinator.scheduler.submit({ execution, lease: claim.lease, command,
        byteLength: Buffer.byteLength(JSON.stringify(command), "utf8") });
      if (admitted.kind !== "admitted") throw new Error(`Command not admitted: ${admitted.kind}`);
      const completion = await admitted.completion;
      if (completion.kind !== "reply" || completion.result.kind !== "committed") {
        throw new Error(`Command did not commit: ${JSON.stringify(completion)}`);
      }
      return completion.result;
    };
    const started = { type: "turnStarted" as const, threadId: execution.threadId,
      turnExecutionId: execution.executionId };
    const begin = await send({
      kind: "start", providerId: "codex",
      input: {
        thread: { id: execution.threadId, workspaceId: "lost-worker-workspace", providerId: "codex", createdAt: NOW },
        turnId: execution.turnId, executionId: execution.executionId,
        permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: `${execution.threadId}-user`, content: "Question", sequence: 1 },
      },
      livePublication: [{ after: "writer", event: started }],
    });
    expect(begin.livePublication).toEqual([{
      publicationId: "1", after: "writer", event: started,
    }]);
    expect(db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(execution.executionId, begin.operationId))
      .toMatchObject({ receipt_json: expect.stringContaining('"publicationId":"1"') });

    const tool = { kind: "toolCall" as const, sequence: 2, sortOrder: 0, record: {
      id: "transport-tool", message_id: "", parent_tool_call_id: null,
      tool_name: "Read", input_summary: "CONTEXT.md", output_summary: "read",
      status: "completed" as const, started_at: NOW, completed_at: NOW, sort_order: 0,
    } };
    await send({ kind: "narrative-delta", input: { executionId: execution.executionId, items: [tool] } });
    expect(db.prepare("SELECT id FROM canonical_agent_items WHERE id = ?").get("toolCall:transport-tool"))
      .toEqual({ id: "toolCall:transport-tool" });

    const toolUse = { type: "toolUse" as const, threadId: execution.threadId,
      turnExecutionId: execution.executionId, toolCallId: "transport-tool", toolName: "Read",
      toolInput: { path: "CONTEXT.md" } };
    const event = await send({ kind: "event", phase: "running", nativeCursor: null, events: [{
      eventId: `${execution.executionId}:transport-tool`,
      routing: { ...execution, itemId: "transport-tool" },
      sourceProviderId: "codex", sourceIdentities: [], sourceSequence: 1,
      payload: { type: "item.recorded", item: {
        id: "transport-tool", threadId: execution.threadId, turnId: execution.turnId,
        kind: "tool-call", providerIdentities: [],
        payload: { projection: "toolCall", toolName: "Read", path: "CONTEXT.md" },
        createdAt: NOW, updatedAt: NOW,
      } },
    }], livePublication: [{ after: "writer", event: toolUse }] });
    expect(event.livePublication).toEqual([{
      publicationId: "2", after: "writer", event: toolUse,
    }]);
    expect(published).toContain(`${execution.executionId}:transport-tool`);
    expect(db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(execution.executionId, event.operationId))
      .toMatchObject({ receipt_json: expect.stringContaining('"publicationId":"2"') });

    const ended = { type: "ended" as const, threadId: execution.threadId,
      turnExecutionId: execution.executionId, outcome: "completed" as const };
    const finish = await send({ kind: "finish-live-event", outcome: "completed", projection: {
      threadId: execution.threadId, executionId: execution.executionId,
      outcome: "completed", endedAt: NOW,
      assistant: { content: "Done", model: null, attachments: [] }, narrative: [tool],
    }, input: {
      ...execution, providerId: "codex", providerIdentities: [], outcome: "completed",
      projection: { kind: "writer-staged" },
    }, livePublication: [{ after: "terminal", event: ended }] });
    expect(finish.livePublication).toEqual([{
      publicationId: "3", after: "terminal", event: ended,
    }]);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toEqual({ terminal_outcome: "completed" });
    expect(new MessageRepo(db, owner).listIncludingInternal(execution.threadId)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Done", outcome: "completed", is_internal: false,
    }));
    expect(db.prepare("SELECT id, status FROM tool_call_records WHERE id = ?").get("transport-tool"))
      .toEqual({ id: "transport-tool", status: "completed" });
    expect(published.indexOf(`${execution.executionId}:transport-tool`))
      .toBeLessThan(published.indexOf(`${execution.executionId}:turn.completed`));

    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toEqual({ terminal_outcome: "completed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND role = 'assistant' AND is_internal = 0")
      .get(execution.threadId)).toEqual({ count: 1 });
  });

  it("interrupts a crashed worker before replacing its slot", async () => {
    const lease = await start(coordinator);
    await new ParentAssistantTextCheckpointService(db, owner).appendChunk([{ ...execution, sequence: 1, text: "Partial answer" }]);
    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(recoveredAssignments).toEqual([{ execution, lease }]);
    expect(workers).toHaveLength(2);
    expect(db.prepare("SELECT terminal_outcome, recovery_incident_id FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toMatchObject({ terminal_outcome: "interrupted",
        recovery_incident_id: expect.stringMatching(/^worker-loss:[0-9a-f]{64}$/) });
    expect(new MessageRepo(db, owner).listIncludingInternal(execution.threadId)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Partial answer", outcome: "interrupted", is_internal: false,
    }));
    expect(published).toContain(`${execution.executionId}:recovery-interrupted`);
    expect(coordinator.scheduler.submit({ execution, lease, command: {
      kind: "checkpoint", phase: "running", nativeCursor: null,
    }, byteLength: 100 })).toEqual({ kind: "stale-execution" });
    expect(coordinator.scheduler.claim({ ...execution, executionId: "new-execution" }, 2).kind).toBe("claimed");
  });

  it("interrupts a Browser execution and never stores or publishes its late result after worker recovery", async () => {
    const claim = coordinator.scheduler.claim(execution, 1);
    if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
    const send = async (command: ExecutionWorkCommand) => {
      const admitted = coordinator.scheduler.submit({ execution, lease: claim.lease, command,
        byteLength: Buffer.byteLength(JSON.stringify(command), "utf8") });
      if (admitted.kind !== "admitted") throw new Error(`Command not admitted: ${admitted.kind}`);
      expect(await admitted.completion).toMatchObject({ kind: "reply", result: { kind: "committed" } });
    };
    const draft = (sequence: number, event: AgentEvent): ProviderEventDraft => ({
      eventId: `${execution.executionId}:browser-${sequence}`,
      routing: { ...execution, itemId: `browser-${sequence}` },
      sourceProviderId: "codex", sourceIdentities: [], sourceSequence: sequence,
      payload: { type: "item.recorded", item: {
        id: `browser-${sequence}`, threadId: execution.threadId, turnId: execution.turnId,
        kind: "system", providerIdentities: [],
        payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } },
        createdAt: NOW, updatedAt: NOW,
      } },
    });
    await send({
      kind: "start", providerId: "codex",
      input: {
        thread: { id: execution.threadId, workspaceId: "lost-worker-workspace", providerId: "codex", createdAt: NOW },
        turnId: execution.turnId, executionId: execution.executionId,
        permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: `${execution.threadId}-user`, content: "Question", sequence: 1 },
      },
      parentLive: { planFeature: "none", precedingMessageId: `${execution.threadId}-user` },
      publishParentStart: true,
    });
    await send({ kind: "event", phase: "running", nativeCursor: null, events: [draft(1, {
      type: "toolUse", threadId: execution.threadId, turnExecutionId: execution.executionId,
      toolCallId: "browser-call", toolName: "mcp__mcode-browser__browser_evaluate",
      toolInput: { expression: "globalThis.SECRET_SOURCE", observationRef: "observation-1" },
    })] });
    const storedUse = db.query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM canonical_agent_items WHERE id = ?",
    ).get("browser-1");
    expect(JSON.parse(storedUse?.payload_json ?? "null"))
      .toEqual({ projection: "providerRuntimeEvent", runtimeEvent: { event: {
        type: "toolUse", threadId: execution.threadId, turnExecutionId: execution.executionId,
        toolCallId: "browser-call", toolName: "mcp__mcode-browser__browser_evaluate",
        toolInput: { operation: "browser_evaluate" },
      } } });
    expect(liveEvents).toContainEqual(expect.objectContaining({
      type: "toolUse", toolCallId: "browser-call", toolInput: { operation: "browser_evaluate" },
    }));
    expect(published).toContain(`${execution.executionId}:browser-1`);

    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    expect(workers).toHaveLength(2);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toEqual({ terminal_outcome: "interrupted" });
    const storedBeforeResult = db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE execution_id = ? ORDER BY accepted_sequence")
      .all(execution.executionId);
    const publishedBeforeResult = [...published];
    const liveBeforeResult = [...liveEvents];
    expect(coordinator.scheduler.submit({ execution, lease: claim.lease, byteLength: 1_000,
      command: { kind: "event", phase: "running", nativeCursor: null, events: [draft(2, {
        type: "toolResult", threadId: execution.threadId, turnExecutionId: execution.executionId,
        toolCallId: "browser-call", output: '{"valueJson":"SECRET_RESULT"}', isError: false,
        outputTruncated: true, outputTotalBytes: 999, outputArtifactPath: "C:\\secret-result.txt",
        toolInput: { expression: "globalThis.SECRET_SOURCE" },
      })] },
    })).toEqual({ kind: "stale-execution" });
    expect(db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE execution_id = ? ORDER BY accepted_sequence")
      .all(execution.executionId)).toEqual(storedBeforeResult);
    expect(db.prepare("SELECT payload_json FROM canonical_agent_items WHERE id = ?").get("browser-2")).toBeNull();
    expect(published).toEqual(publishedBeforeResult);
    expect(liveEvents).toEqual(liveBeforeResult);
    expect(JSON.stringify(storedBeforeResult)).not.toContain("SECRET_SOURCE");
    expect(JSON.stringify(liveEvents)).not.toContain("SECRET_SOURCE");
    expect(JSON.stringify(storedBeforeResult)).not.toContain("SECRET_RESULT");
    expect(JSON.stringify(liveEvents)).not.toContain("SECRET_RESULT");
  });

  it("releases a lost attempt's baseline without recapturing its files", async () => {
    const repo = NodePath.join(directory, "repo");
    NodeFS.mkdirSync(repo);
    const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    git("init", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 1;\n");
    db.prepare("UPDATE workspaces SET path = ? WHERE id = ?").run(repo, "lost-worker-workspace");
    const executor = new RealGitExecutor();
    const lock = new RepositoryGitMutationLock(hostRuntime);
    const snapshots = new SnapshotService(executor, lock);
    const storeId = await ensureSnapshotStoreId(owner, NodePath.join(directory, "app.sqlite"), hostRuntime.platform);
    const pins = new SnapshotRefPins(executor, storeId, db, owner, lock, snapshots, hostRuntime);

    await start(coordinator);
    const { tree: baseline } = await pins.captureBaseline(repo, execution.threadId, execution.executionId);
    await new ParentAssistantTextCheckpointService(db, owner).appendChunk([{ ...execution, sequence: 1, text: "Partial answer" }]);
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 2;\n");
    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    await pins.settleExecution(execution.threadId, execution.executionId);

    const assistant = new MessageRepo(db, owner).listIncludingInternal(execution.threadId)
      .find((message) => message.role === "assistant");
    const rows = db.query("SELECT id FROM turn_snapshots WHERE message_id = ?").all(assistant?.id ?? "");
    expect(assistant).toBeDefined();
    expect(baseline).toBeTruthy();
    expect(rows).toEqual([]);
    expect(git("for-each-ref", "--format=%(refname)", "refs/mcode/")).toBe("");
  }, 30_000);

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

describe("ExecutionWorkerLossCoordinator with accepted progress", { timeout: 30_000 }, () => {
  let directory: string;
  let db: Database;
  let reader: Database;
  let databaseWriter: ApplicationDatabaseWriter;
  let writer: CanonicalAgentWriterClient;
  let progress: CanonicalAcceptedProgress;
  let coordinator: ExecutionWorkerLossCoordinator;
  let workers: CrashingPort[];

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-lost-worker-progress-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("lost-worker-workspace", "Workspace", directory, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(execution.threadId, "lost-worker-workspace", "Thread", "main", "codex", NOW, NOW);
    databaseWriter = new ApplicationDatabaseWriter(dbPath);
    writer = new CanonicalAgentWriterClient(databaseWriter);
    reader = openReadOnlyDatabase(dbPath);
    progress = new CanonicalAcceptedProgress(new CanonicalAgentStore(reader, databaseWriter, writer, () => {}), writer);
    const port = new CanonicalExecutionWriterPort(writer, () => {}, undefined, undefined, progress);
    workers = [];
    coordinator = new ExecutionWorkerLossCoordinator(port, {
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
    await progress.close();
    await writer.close();
    await databaseWriter.close();
    reader.close(true);
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  async function send(identity: ExecutionIdentity, lease: ExecutionLease, command: ExecutionWorkCommand) {
    const admitted = coordinator.scheduler.submit({ execution: identity, lease, command,
      byteLength: Buffer.byteLength(JSON.stringify(command), "utf8") });
    if (admitted.kind !== "admitted") throw new Error(`Command not admitted: ${admitted.kind}`);
    const completion = await admitted.completion;
    if (completion.kind !== "reply") throw new Error(`Command had no reply: ${JSON.stringify(completion)}`);
    return completion.result;
  }

  async function startTurn(identity: ExecutionIdentity, ownerEpoch: number) {
    const claim = coordinator.scheduler.claim(identity, ownerEpoch);
    if (claim.kind !== "claimed") throw new Error(`Claim failed: ${claim.kind}`);
    expect(await send(identity, claim.lease, { kind: "start", providerId: "codex", publishParentStart: true,
      parentLive: { planFeature: "none", precedingMessageId: `${identity.turnId}:user` },
      input: { thread: { id: identity.threadId, workspaceId: "lost-worker-workspace", providerId: "codex", createdAt: NOW },
        turnId: identity.turnId, executionId: identity.executionId, permissionMode: "full", providerIdentities: [],
        userMessage: { kind: "create", messageId: `${identity.turnId}:user`, content: "Question", sequence: ownerEpoch } } }))
      .toMatchObject({ kind: "committed" });
    return claim.lease;
  }

  function text(identity: ExecutionIdentity, sequence: number, type: "textDelta" | "turnComplete", fields: Record<string, unknown>) {
    const event = AgentEventSchema().parse({ type, threadId: identity.threadId, turnExecutionId: identity.executionId, ...fields });
    const itemId = `${identity.executionId}:raw:${sequence}`;
    return { eventId: itemId, routing: { ...identity, itemId }, sourceProviderId: "codex", sourceIdentities: [],
      sourceSequence: sequence, payload: { type: "item.recorded" as const, item: { id: itemId, threadId: identity.threadId,
        turnId: identity.turnId, kind: "system" as const, providerIdentities: [],
        payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } }, createdAt: NOW, updatedAt: NOW } } };
  }

  it("drops the lost execution's owner once its interruption is saved, and the thread takes a new turn", async () => {
    const lease = await startTurn(execution, 1);
    expect(await send(execution, lease, { kind: "event", phase: "running", nativeCursor: null,
      events: [text(execution, 1, "textDelta", { delta: "Partial answer", isFinalResponse: true })] }))
      .toMatchObject({ kind: "accepted" });
    await progress.waitForSaved(execution.threadId);
    expect(progress.depth().owners).toBe(1);

    workers[0]?.crash();
    expect(await coordinator.waitForRecovery(0)).toEqual({ kind: "recovered", workerIndex: 0 });
    await expect.poll(() => progress.depth()).toMatchObject({ pending: 0, owners: 0, ownedTurns: 0 });

    const saved = new CanonicalAgentStore(reader, databaseWriter, writer, () => {}).recoverThread(execution.threadId,
      { conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
    if (saved.mode !== "snapshot") throw new Error("Expected saved history");
    expect(saved.snapshot.state.turns[execution.turnId]?.status).toBe("Interrupted");
    expect(new MessageRepo(db, databaseWriter).listIncludingInternal(execution.threadId)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Partial answer", outcome: "interrupted", is_internal: false,
    }));

    const next = { ...execution, turnId: "after-loss-turn", executionId: "00000000-0000-4000-8000-000000000190" };
    const nextLease = await startTurn(next, 2);
    expect(await send(next, nextLease, { kind: "event", phase: "running", nativeCursor: null,
      events: [text(next, 1, "textDelta", { delta: "Fresh answer", isFinalResponse: true })] })).toMatchObject({ kind: "accepted" });
    expect(await send(next, nextLease, { kind: "event", phase: "running", nativeCursor: null,
      events: [text(next, 2, "turnComplete", { reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 })],
      terminalInput: { ...next, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } }))
      .toMatchObject({ kind: "accepted" });
    expect(await send(next, nextLease, { kind: "release" })).toEqual({ kind: "released" });
    expect(coordinator.scheduler.release(next, nextLease)).toBe(true);
    await expect.poll(() => progress.depth()).toMatchObject({ pending: 0, owners: 0 });
    expect(db.prepare("SELECT id, status FROM canonical_agent_turns WHERE thread_id = ? ORDER BY id").all(execution.threadId))
      .toEqual([{ id: next.turnId, status: "Completed" }, { id: execution.turnId, status: "Interrupted" }]);
  });
});
