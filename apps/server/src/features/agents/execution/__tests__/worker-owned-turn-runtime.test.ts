import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { AgentEventPublicationRegistry } from "../../orchestration/agent-event-publication-registry.js";
import { WorkerOwnedTurnRuntime } from "../worker-owned-turn-runtime.js";

const NOW = "2026-09-25T10:00:00.000Z";
const identities = Array.from({ length: 5 }, (_, index) => ({
  threadId: `failure-isolation-thread-${index}`,
  turnId: `failure-isolation-turn-${index}`,
  executionId: `00000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`,
}));

let directory: string | undefined;
let database: ReturnType<typeof openDatabase> | undefined;
let runtime: WorkerOwnedTurnRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  database?.close(true);
  if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  runtime = undefined;
  database = undefined;
  directory = undefined;
});

it("contains a rejected writer operation to its execution while a slot peer keeps running", async () => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-rejected-execution-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  database = openDatabase({ dbPath });
  database.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("failure-isolation-workspace", "Workspace", directory, NOW, NOW);
  const insertThread = database.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const identity of identities) {
    insertThread.run(identity.threadId, "failure-isolation-workspace", "Thread", "main", "codex", NOW, NOW);
  }
  runtime = new WorkerOwnedTurnRuntime(dbPath, new AgentEventPublicationRegistry());
  await runtime.whenReady();
  for (const identity of identities) {
    await runtime.owner.start({ execution: identity, ownerEpoch: 1, providerId: "codex", parentTurn: {
      thread: { id: identity.threadId, workspaceId: "failure-isolation-workspace", providerId: "codex", createdAt: NOW },
      turnId: identity.turnId, executionId: identity.executionId, permissionMode: "supervised",
      providerIdentities: [], userMessage: { kind: "create", messageId: `${identity.threadId}-user`, content: "Question", sequence: 1 },
    } });
  }
  const failed = identities[0]!;
  const peer = identities[4]!;
  expect(runtime.owner.current(failed.threadId)?.lease.workerIndex)
    .toBe(runtime.owner.current(peer.threadId)?.lease.workerIndex);
  database.run(`CREATE TRIGGER fail_one_append BEFORE INSERT ON canonical_writer_operation_receipts
    WHEN NEW.kind = 'semantic:append-events' AND NEW.execution_id = '${failed.executionId}'
    BEGIN SELECT RAISE(ABORT, 'injected append failure'); END`);
  await expect(runtime.owner.submit(failed, { kind: "event", phase: "running", nativeCursor: null, events: [{
    eventId: `${failed.executionId}:event:1`, routing: { ...failed, itemId: "failed-tool" },
    sourceProviderId: "codex", sourceIdentities: [], sourceSequence: 1,
    payload: { type: "item.recorded", item: { id: "failed-tool", threadId: failed.threadId, turnId: failed.turnId,
      kind: "tool-call", providerIdentities: [], payload: { projection: "toolCall", toolName: "Read", path: "CONTEXT.md" },
      createdAt: NOW, updatedAt: NOW } },
  }] })).rejects.toThrow("writer-failure");
  await runtime.recoverRejected(failed);
  expect(runtime.owner.current(failed.threadId)).toBeUndefined();
  expect(database.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
    .get(failed.executionId)).toEqual({ terminal_outcome: "interrupted" });
  expect(database.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
    .get(peer.executionId)).toEqual({ terminal_outcome: null });
  await expect(runtime.owner.submit(peer, { kind: "checkpoint", phase: "running", nativeCursor: null }))
    .resolves.toMatchObject({ kind: "committed" });
  expect(runtime.owner.isStarted(peer)).toBe(true);
});
