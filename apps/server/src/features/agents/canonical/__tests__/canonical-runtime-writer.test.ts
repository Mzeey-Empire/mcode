import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalAgentEventEnvelope, NarrativeEntry, ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { ParentAssistantTextCoordinator } from "../../turns/parent-assistant-text-coordinator.js";
import { ParentNarrativeRecoveryCoordinator } from "../../turns/parent-narrative-recovery-coordinator.js";
import { LegacyConversationMigration } from "../../conversation/migrations/legacy-conversation-migration.js";
import { ConversationDisplayMaterializer } from "../../conversation/migrations/conversation-display-materializer.js";

const NOW = "2026-10-01T10:00:00.000Z";
const executionId = "00000000-0000-4000-8000-000000000001";
const threadId = "thread-1";
const turnId = "turn-1";
const start = { thread: { id: threadId, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
  turnId, executionId, permissionMode: "supervised" as const, providerIdentities: [],
  userMessage: { kind: "create" as const, messageId: "user-1", content: "Question", sequence: 1 } };

function thought(id: string, text: string, sortOrder = 1): ParentNarrativeRecoveryItem {
  return { kind: "narrationSegment", record: { id, message_id: "", text,
    started_at: NOW, ended_at: NOW, sort_order: sortOrder } };
}

describe("main canonical operations through the sole writer", () => {
  let directory: string;
  let path: string;
  let reader: Database;
  let writer: ApplicationDatabaseWriter;
  let canonical: CanonicalAgentBoundary;
  let text: ParentAssistantTextCheckpointService;
  let published: CanonicalAgentEventEnvelope[][];
  let coordinator: ParentAssistantTextCoordinator | undefined;
  let narrativeRecovery: ParentNarrativeRecoveryCoordinator | undefined;

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
    text = new ParentAssistantTextCheckpointService(reader, writer);
  });

  afterEach(async () => {
    narrativeRecovery?.clear(executionId);
    narrativeRecovery = undefined;
    coordinator?.discard(executionId);
    coordinator = undefined;
    await writer.close();
    reader.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("commits starts atomically and continues following a rejected user-message projection", async () => {
    await expect(canonical.startParentTurn({ ...start, userMessage: { kind: "existing", messageId: "missing" } }))
      .rejects.toThrow("Queued user message not found");
    expect(canonical.loadTurn(turnId)).toBeNull();
    expect(await canonical.startParentTurn(start)).toMatchObject({ outcome: "committed" });
    expect(canonical.loadCheckpoint(executionId)).toMatchObject({ phase: "running" });
    expect(new MessageRepo(reader, writer).findByIdInThread(threadId, "user-1")).toMatchObject({ content: "Question" });
    expect(() => reader.run("DELETE FROM messages")).toThrow(/readonly/);
    await new MessageRepo(reader, writer).create(threadId, "user", "Later prompt", 2);
    expect(canonical.loadParentTurnUserMessage(executionId)).toMatchObject({ id: "user-1", content: "Question" });
    expect(canonical.loadParentTurnUserMessage("unknown-execution")).toBeNull();
  });

  it("resumes a partially committed terminal projection and preserves a single durable revision", async () => {
    await canonical.startParentTurn(start);
    const messages = new MessageRepo(reader, writer);
    const message = await messages.create(threadId, "assistant", "Answer", 2);
    const narrative: NarrativeEntry[] = Array.from({ length: 100 }, (_, index) => ({
      kind: "narrationSegment", sequence: 2, sortOrder: index, record: { id: `thought-${index}`, message_id: message.id,
        text: `Thought ${index}`, started_at: NOW, ended_at: NOW, sort_order: index },
    }));
    const input = { threadId, turnId, executionId, providerId: "codex", providerIdentities: [],
      outcome: "completed" as const, projection: { message, narrative } };
    let failPublication = true;
    canonical = new CanonicalAgentBoundary(reader, writer, new CanonicalAgentWriterClient(writer), (events) => {
      published.push([...events]);
      if (failPublication) { failPublication = false; throw new Error("Publication failed after commit"); }
    });
    await expect(canonical.finishParentTurnBatched(input)).rejects.toThrow("Publication failed after commit");
    const partial = canonical.loadCheckpoint(executionId);
    expect(partial?.lastDurableSequence).toBeGreaterThan(4);
    expect(partial?.terminalOutcome).toBeNull();
    const result = await canonical.finishParentTurnBatched(input);
    expect(result.outcome).toBe("committed");
    expect(result.writeBatches.batches).toBeGreaterThan(1);
    expect(canonical.loadCheckpoint(executionId)?.terminalOutcome).toBe("completed");
    expect(reader.query("SELECT DISTINCT durable_revision FROM canonical_agent_events WHERE accepted_sequence > 4").all())
      .toEqual([{ durable_revision: 2 }]);
    expect(await canonical.finishParentTurnBatched(input)).toMatchObject({ outcome: "terminal-outcome-confirmed" });
  });

  it("publishes accepted text despite a failed save, then recovers the retained prefix", async () => {
    await canonical.startParentTurn(start);
    await writer.setQueryOnlyForReliability(true);
    const statuses: string[] = [];
    coordinator = new ParentAssistantTextCoordinator(canonical, text, (update) => statuses.push(update.mode));
    coordinator.start(executionId, turnId);
    const live = vi.fn();
    const stopped = vi.fn();
    expect(coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "Visible now" }, live, stopped)).toBe(true);
    expect(live).toHaveBeenCalledTimes(1);
    expect(await coordinator.flush(executionId)).toBe(false);
    expect(statuses).toContain("saving-delayed");
    expect(stopped).not.toHaveBeenCalled();
    expect(text.restore(executionId)).toBe("");
    await writer.setQueryOnlyForReliability(false);
    expect(await coordinator.flush(executionId)).toBe(true);
    expect(text.restore(executionId)).toBe("Visible now");
    expect(statuses.at(-1)).toBe("durable");
  });

  it("retains text during an unavailable baseline and rebases after its committed prefix", async () => {
    await canonical.startParentTurn(start);
    await text.appendChunk([{ executionId, threadId, turnId, sequence: 1, text: "Saved " }]);
    const restore = vi.spyOn(text, "restoreChunks").mockImplementation(() => { throw new Error("SQLITE_BUSY"); });
    const live: string[] = [];
    const stopped = vi.fn();
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const queued = (delta: string) => coordinator!.queueText({ type: "textDelta", threadId,
      turnExecutionId: executionId, delta }, () => live.push(delta), stopped);
    expect(queued("pending ")).toBe(true);
    expect(await coordinator.flush(executionId)).toBe(false);
    expect(live).toEqual(["pending "]);
    expect(stopped).not.toHaveBeenCalled();
    restore.mockRestore();
    expect(await coordinator.flush(executionId)).toBe(true);
    expect(queued("continued")).toBe(true);
    expect(await coordinator.flush(executionId)).toBe(true);
    expect(text.restore(executionId)).toBe("Saved pending continued");
    expect(text.restoreChunks(executionId).at(-1)?.lastSequence).toBe(3);
    expect(stopped).not.toHaveBeenCalled();
  });

  it("honors explicit unsaved continuation when the baseline remains unavailable", async () => {
    await canonical.startParentTurn(start);
    vi.spyOn(text, "restoreChunks").mockImplementation(() => { throw new Error("SQLITE_BUSY"); });
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const live = vi.fn();
    const stopped = vi.fn();
    coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "Pending" }, live, stopped);
    expect(await coordinator.flush(executionId)).toBe(false);
    expect(coordinator.continueWithoutSaving(executionId)).toBe(true);
    expect(coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "Visible" }, live, stopped))
      .toBe(true);
    expect(coordinator.durabilityMode(executionId)).toBe("unsaved");
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(stopped).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("fences classification saves while subsequent text publishes with a reset sequence", async () => {
    await canonical.startParentTurn(start);
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const peer = new Database(path, { strict: true });
    peer.run("BEGIN IMMEDIATE");
    const live: string[] = [];
    const stopped = vi.fn();
    try {
      coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "Reasoning" }, () => live.push("old"), stopped);
      const classified = coordinator.classify(executionId, async () => {
        await canonical.classifyParentNarrativeRecovery({ executionId, items: [] }, "fenced-classification");
      });
      coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "Answer" }, () => live.push("new"), stopped);
      const saved = coordinator.flush(executionId);
      expect(live).toEqual(["old", "new"]);
      peer.run("COMMIT");
      await classified;
      expect(await saved).toBe(true);
      expect(stopped).not.toHaveBeenCalled();
      expect(text.restoreChunks(executionId)).toEqual([{ firstSequence: 1, lastSequence: 1,
        text: "Answer", byteLength: 6 }]);
    } finally { if (peer.inTransaction) peer.run("ROLLBACK"); peer.close(true); }
  });

  it("keeps a fsynced recovery journal until its import commits", async () => {
    await canonical.startParentTurn(start);
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

  it("retains a failed classification fence through shutdown without requiring later text", async () => {
    await canonical.startParentTurn(start);
    await text.appendChunk([{ executionId, threadId, turnId, sequence: 1, text: "Already saved reasoning" }]);
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    await writer.setQueryOnlyForReliability(true);
    await expect(coordinator.classify(executionId, async () => {
      await canonical.classifyParentNarrativeRecovery({ executionId, items: [] }, "shutdown-classification");
    })).rejects.toThrow("retained for retry");
    await expect(coordinator.close()).rejects.toThrow("retained unsaved checkpoints");
    await writer.setQueryOnlyForReliability(false);
    await coordinator.close();
    expect(coordinator.durabilityMode(executionId)).toBe("durable");
  });

  it("publishes a healthy classification burst exceeding one response's SQLite retention budget", async () => {
    await canonical.startParentTurn(start);
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const live = vi.fn();
    const stopped = vi.fn();
    const peer = new Database(path, { strict: true });
    peer.run("BEGIN IMMEDIATE");
    const oldText = "r".repeat(192 * 1024);
    const newText = "a".repeat(192 * 1024);
    try {
      expect(coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: oldText }, live, stopped)).toBe(true);
      const classified = coordinator.classify(executionId, async () => {
        await canonical.classifyParentNarrativeRecovery({ executionId, items: [] }, "burst-classification");
      });
      expect(coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: newText }, live, stopped)).toBe(true);
      expect(live).toHaveBeenCalledTimes(2);
      expect(stopped).not.toHaveBeenCalled();
      peer.run("COMMIT");
      await classified;
      expect(await coordinator.flush(executionId)).toBe(true);
      expect(text.restore(executionId)).toBe(newText);
    } finally { if (peer.inTransaction) peer.run("ROLLBACK"); peer.close(true); }
  });

  it("enforces one bounded pending byte budget across overlapping classification generations", async () => {
    await canonical.startParentTurn(start);
    await writer.setQueryOnlyForReliability(true);
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const live = vi.fn();
    const stopped = vi.fn();
    const responseText = "a".repeat(256 * 1024);
    const classifications: Promise<void>[] = [];
    for (let generation = 0; generation < 4; generation += 1) {
      if (generation > 0) classifications.push(expect(coordinator.classify(executionId, async () => {
        await canonical.classifyParentNarrativeRecovery({ executionId, items: [] }, "retained-classification:" + generation);
      })).rejects.toThrow("retained for retry"));
      expect(coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: responseText }, live, stopped)).toBe(true);
    }
    expect(stopped).not.toHaveBeenCalled();
    expect(coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "x" }, live, stopped)).toBe(false);
    expect(stopped).toHaveBeenCalledWith("Assistant text retained save capacity reached");
    expect(live).toHaveBeenCalledTimes(4);
    await Promise.all(classifications);
    await writer.setQueryOnlyForReliability(false);
    expect(await coordinator.flush(executionId)).toBe(true);
    expect(text.restore(executionId)).toBe(responseText);
  });

  it("prepares concurrent recovery snapshots only after the preceding commit acknowledges its delta", async () => {
    await canonical.startParentTurn(start);
    let snapshot = [thought("old-thought", "Before")];
    narrativeRecovery = new ParentNarrativeRecoveryCoordinator(canonical, { terminalSnapshot: () => snapshot });
    const event = { type: "textDelta" as const, threadId, turnExecutionId: executionId, delta: "Live" };
    const peer = new Database(path, { strict: true });
    peer.run("BEGIN IMMEDIATE");
    try {
      const first = narrativeRecovery.checkpoint(event);
      snapshot = [thought("new-thought", "After")];
      const second = narrativeRecovery.checkpoint(event);
      peer.run("COMMIT");
      await Promise.all([first, second]);
      expect(canonical.loadParentNarrativeRecovery(turnId)).toEqual(snapshot);
      await narrativeRecovery.close(() => Promise.resolve());
    } finally { if (peer.inTransaction) peer.run("ROLLBACK"); peer.close(true); }
  });

  it("drains a failed recovery head and its dependent text classification without deadlocking", async () => {
    await canonical.startParentTurn(start);
    await writer.setQueryOnlyForReliability(true);
    let snapshot = [thought("reasoning", "Reasoning")];
    narrativeRecovery = new ParentNarrativeRecoveryCoordinator(canonical, { terminalSnapshot: () => snapshot });
    const event = { type: "textDelta" as const, threadId, turnExecutionId: executionId, delta: "Reasoning" };
    await expect(narrativeRecovery.checkpoint(event)).rejects.toThrow(/readonly/);
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const stopped = vi.fn();
    coordinator.queueText(event, () => {}, stopped);
    snapshot = [thought("reasoning", "Classified reasoning")];
    const classified = narrativeRecovery.runOrdered(event, snapshot, (ready) => coordinator!.classify(executionId, async () => {
      const checkpoint = await ready;
      await canonical.classifyParentNarrativeRecovery(checkpoint.input, checkpoint.operationId);
      checkpoint.confirm();
    }));
    void classified.catch(() => undefined);
    snapshot = [thought("reasoning", "Classified reasoning"), thought("later", "Later", 2)];
    const later = narrativeRecovery.checkpoint(event);
    await writer.setQueryOnlyForReliability(false);
    await narrativeRecovery.close(() => coordinator!.close());
    await later;
    expect(stopped).not.toHaveBeenCalled();
    expect(canonical.loadParentNarrativeRecovery(turnId)).toEqual(snapshot);
    expect(text.restore(executionId)).toBe("");
  });

  it("drains admitted checkpoints before shutdown and reports retained save failure", async () => {
    await canonical.startParentTurn(start);
    coordinator = new ParentAssistantTextCoordinator(canonical, text, () => {});
    coordinator.start(executionId, turnId);
    const stopped = vi.fn();
    coordinator.queueText({ type: "textDelta", threadId, turnExecutionId: executionId, delta: "Shutdown prefix" }, () => {}, stopped);
    await writer.setQueryOnlyForReliability(true);
    await expect(coordinator.close()).rejects.toThrow("retained unsaved checkpoints");
    expect(stopped).not.toHaveBeenCalled();
    await writer.setQueryOnlyForReliability(false);
    await coordinator.close();
    expect(text.restore(executionId)).toBe("Shutdown prefix");
    expect(() => coordinator?.queueText({ type: "textDelta", threadId, turnExecutionId: executionId,
      delta: "Late producer" }, () => {}, stopped)).toThrow("closing");
  });

  it("materializes existing conversation rows through writer checkpoints and groups child publications", async () => {
    const messages = new MessageRepo(reader, writer);
    await messages.create(threadId, "user", "Legacy question", 1);
    await messages.create(threadId, "assistant", "Legacy answer", 2);
    expect((await new LegacyConversationMigration(writer).runToCompletion()).completed).toBe(true);
    await new ConversationDisplayMaterializer(writer).runToCompletion();
    expect(canonical.loadConversationProjection(threadId, 10).messages.map((message) => message.content))
      .toEqual(["Legacy question", "Legacy answer"]);
    await canonical.startParentTurn({ ...start, userMessage: { kind: "create", content: "New question", sequence: 3 } });
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
