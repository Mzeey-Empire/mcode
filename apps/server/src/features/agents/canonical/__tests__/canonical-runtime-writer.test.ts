import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { NarrativeEntry } from "@mcode/contracts/models/narrative-entry";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalAgentStore } from "../canonical-agent-store.js";
import { CanonicalParentTurnWrite } from "../canonical-parent-turn-write.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { LegacyConversationMigration } from "../../conversation/migrations/legacy-conversation-migration.js";
import { ConversationDisplayMaterializer } from "../../conversation/migrations/conversation-display-materializer.js";
import { TurnSteerRepo } from "../../steering/persistence/turn-steer-repo.js";
import { asTurnSteerError } from "../../steering/turn-steer.js";

const NOW = "2026-10-01T10:00:00.000Z";
const executionId = "00000000-0000-4000-8000-000000000001";
const threadId = "thread-1";
const turnId = "turn-1";
const start = { thread: { id: threadId, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
  turnId, executionId, permissionMode: "supervised" as const, providerIdentities: [],
  userMessage: { kind: "create" as const, messageId: "user-1", content: "Question", sequence: 1 } };

describe("canonical runtime persistence", () => {
  let directory: string;
  let path: string;
  let reader: Database;
  let startDatabase: Database;
  let parents: CanonicalParentTurnWrite;
  let writer: ApplicationDatabaseWriter;
  let canonical: CanonicalAgentBoundary;
  let text: ParentAssistantTextCheckpointService;
  let published: CanonicalAgentEventEnvelope[][];

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-canonical-runtime-"));
    path = NodePath.join(directory, "app.sqlite");
    const setup = openDatabase({ dbPath: path });
    setup.run("INSERT INTO workspaces (id,name,path) VALUES (?,?,?)", ["workspace-1", "Fixture", directory]);
    setup.run("INSERT INTO threads (id,workspace_id,title,branch,provider) VALUES (?,?,?,?,?)",
      [threadId, "workspace-1", "Fixture", "main", "codex"]);
    setup.close(true);
    reader = openReadOnlyDatabase(path);
    writer = new ApplicationDatabaseWriter(path);
    published = [];
    canonical = new CanonicalAgentBoundary(reader, writer, new CanonicalAgentWriterClient(writer),
      (events) => published.push([...events]));
    startDatabase = new Database(path);
    parents = new CanonicalParentTurnWrite(startDatabase, (events) => published.push([...events]));
    text = new ParentAssistantTextCheckpointService(reader, writer);
  });

  afterEach(async () => {
    await writer.close();
    startDatabase.close(true);
    reader.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("commits starts atomically and continues following a rejected user-message projection", async () => {
    expect(() => parents.start({ ...start, userMessage: { kind: "existing", messageId: "missing" } }))
      .toThrow("Queued user message not found");
    expect(canonical.loadTurn(turnId)).toBeNull();
    expect(parents.start(start)).toMatchObject({ outcome: "committed" });
    expect(canonical.loadCheckpoint(executionId)).toMatchObject({ phase: "running" });
    expect(new MessageRepo(reader, writer).findByIdInThread(threadId, "user-1")).toMatchObject({ content: "Question" });
    expect(() => reader.run("DELETE FROM messages")).toThrow(/readonly/);
    await new MessageRepo(reader, writer).create(threadId, "user", "Later prompt", 2);
    expect(canonical.loadParentTurnUserMessage(executionId)).toMatchObject({ id: "user-1", content: "Question" });
    expect(canonical.loadParentTurnUserMessage("unknown-execution")).toBeNull();
  });

  it("admits a Send again resend once and closes another window's copy before its user message", async () => {
    const steerId = "00000000-0000-4000-8000-0000000000a1";
    const replacementId = "00000000-0000-4000-8000-0000000000a2";
    const steers = new TurnSteerRepo(reader, writer);
    await steers.insertPending({ messageId: steerId, threadId, turnExecutionId: executionId, inputsHash: "hash",
      payload: { content: "Use staging" } });
    await steers.settle(steerId, { state: "delivery_unknown" });
    await steers.requeue(steerId, replacementId);
    const resend = async (turn: string, execution: string) => parents.start({ ...start, turnId: turn,
      executionId: execution, resendOfSteerId: steerId,
      userMessage: { kind: "create", messageId: replacementId, content: "Use staging", sequence: 1 } });

    await expect(resend("turn-resend-1", "00000000-0000-4000-8000-0000000000b1")).resolves.toMatchObject({ outcome: "committed" });
    const second = await resend("turn-resend-2", "00000000-0000-4000-8000-0000000000b2").then(() => null, (error: unknown) => error);

    expect(asTurnSteerError(second)?.code).toBe("steer_resend_closed");
    expect(canonical.loadTurn("turn-resend-2")).toBeNull();
    expect(steers.find(steerId)).toMatchObject({ state: "closed" });
  });

  it("resumes a partially committed terminal projection and preserves a single durable revision", async () => {
    parents.start(start);
    const messages = new MessageRepo(reader, writer);
    const message = await messages.create(threadId, "assistant", "Answer", 2);
    const narrative: NarrativeEntry[] = Array.from({ length: 100 }, (_, index) => ({
      kind: "narrationSegment", sequence: 2, sortOrder: index, record: { id: `thought-${index}`, message_id: message.id,
        text: `Thought ${index}`, started_at: NOW, ended_at: NOW, sort_order: index },
    }));
    const input = { threadId, turnId, executionId, providerId: "codex", providerIdentities: [],
      outcome: "completed" as const, projectTurn: () => ({ message, narrative }) };
    let failPublication = true;
    const storeDb = new Database(path);
    try {
      const store = new CanonicalAgentStore(storeDb, (events) => {
        published.push([...events]);
        if (failPublication) { failPublication = false; throw new Error("Publication failed after commit"); }
      });
      await expect(store.finishParentTurnBatched(input)).rejects.toThrow("Publication failed after commit");
      const partial = canonical.loadCheckpoint(executionId);
      expect(partial?.lastDurableSequence).toBeGreaterThan(4);
      expect(partial?.terminalOutcome).toBeNull();
      const result = await store.finishParentTurnBatched(input);
      expect(result.outcome).toBe("committed");
      expect(result.writeBatches.batches).toBeGreaterThan(1);
      expect(canonical.loadCheckpoint(executionId)?.terminalOutcome).toBe("completed");
      expect(reader.query("SELECT DISTINCT durable_revision FROM canonical_agent_events WHERE accepted_sequence > 4").all())
        .toEqual([{ durable_revision: 2 }]);
      expect(await store.finishParentTurnBatched(input)).toMatchObject({ outcome: "terminal-outcome-confirmed" });
    } finally {
      storeDb.close(true);
    }
  });

  it("keeps a fsynced recovery journal until its import commits", async () => {
    parents.start(start);
    text.recoveryJournal.append([{ executionId, threadId, turnId, sequence: 1, text: "Recover me" }]);
    const journalPath = NodePath.join(directory, "app.sqlite.recovery", "parent-assistant-text", executionId + ".journal");
    await writer.setQueryOnlyForReliability(true);
    await expect(text.importRecoveryJournals()).rejects.toThrow(/readonly/);
    expect(NodeFS.existsSync(journalPath)).toBe(true);
    await writer.setQueryOnlyForReliability(false);
    expect(await text.importRecoveryJournals()).toEqual([executionId]);
    expect(text.restore(executionId)).toBe("Recover me");
    expect(NodeFS.existsSync(journalPath)).toBe(false);
  });

  it("materializes existing conversation rows through writer checkpoints and groups child publications", async () => {
    const messages = new MessageRepo(reader, writer);
    await messages.create(threadId, "user", "Legacy question", 1);
    await messages.create(threadId, "assistant", "Legacy answer", 2);
    expect((await new LegacyConversationMigration(writer).runToCompletion()).completed).toBe(true);
    await new ConversationDisplayMaterializer(writer).runToCompletion();
    expect(canonical.loadConversationProjection(threadId, 10).messages.map((message) => message.content))
      .toEqual(["Legacy question", "Legacy answer"]);
    parents.start({ ...start, userMessage: { kind: "create", content: "New question", sequence: 3 } });
    published = [];
    await canonical.startCodexChildDelegation({ parentThreadId: threadId, parentTurnId: turnId,
      parentExecutionId: executionId, parentItemId: "toolCall:spawn", receiverThreadIds: ["native-child"], providerIdentities: [] });
    await canonical.bindCodexChildIdentity({ parentThreadId: threadId, parentTurnId: turnId,
      parentExecutionId: executionId, parentItemId: "toolCall:spawn", nativeThreadId: "native-child" });
    await canonical.startCodexChildTurn({ parentThreadId: threadId, parentTurnId: turnId,
      parentExecutionId: executionId, parentItemId: "toolCall:spawn", nativeThreadId: "native-child", nativeTurnId: "native-turn" });
    expect(published.flat().some((event) => event.routing.threadId !== threadId)).toBe(true);
    for (const group of published) {
      expect(new Set(group.map((event) => event.routing.threadId)).size).toBe(1);
      expect(group.length).toBeLessThanOrEqual(64);
    }
  });
});
