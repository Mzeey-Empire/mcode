import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { CanonicalAgentStore as CanonicalAgentBoundary } from "../../canonical/canonical-agent-store.js";
import { MessageStore as MessageRepo } from "../../conversation/persistence/message-store.js";
import {
  ParentAssistantTextCheckpointStore as ParentAssistantTextCheckpointService,
  type ParentAssistantTextRecoveryJournalChunk,
} from "../parent-assistant-text-checkpoint-store.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000001522";
const THREAD_ID = "thread-1522";
const TURN_ID = "turn-1522";
const NOW = "2026-08-24T10:00:00.000Z";

function input(sequence: number, text: string) {
  return { executionId: EXECUTION_ID, threadId: THREAD_ID, turnId: TURN_ID, sequence, text };
}

function seedParentAssistantTurn(db: Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("workspace-1522", "Workspace", "C:/workspace", NOW, NOW);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(THREAD_ID, "workspace-1522", "Durability", "main", "claude", "active", NOW, NOW);
  const messages = new MessageRepo(db);
  new CanonicalAgentBoundary(db, () => {}).startParentTurn({
    thread: { id: THREAD_ID, workspaceId: "workspace-1522", providerId: "claude", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "full",
    providerIdentities: [],
    projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
  });
}

describe("ParentAssistantTextCheckpointService", () => {
  let db: Database;
  let service: ParentAssistantTextCheckpointService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedParentAssistantTurn(db);
    service = new ParentAssistantTextCheckpointService(db);
  });

  afterEach(() => db.close());

  it("stores adjacent deltas as one chunk and restores their accepted order", () => {
    expect(service.appendChunk([input(1, "first "), input(2, "second")])).toMatchObject({
      outcome: "committed",
      durableThrough: 2,
      committedItems: 2,
      committedBytes: 12,
    });

    expect(service.restore(EXECUTION_ID)).toBe("first second");
    expect(db.prepare(
      "SELECT first_sequence, last_sequence, text, byte_length FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?",
    ).all(EXECUTION_ID)).toEqual([{
      first_sequence: 1,
      last_sequence: 2,
      text: "first second",
      byte_length: 12,
    }]);
  });

  it("accepts an exact chunk retry but rejects conflicting text and sequence gaps", () => {
    service.appendChunk([input(1, "same")]);

    expect(service.appendChunk([input(1, "same")])).toMatchObject({
      outcome: "duplicate",
      durableThrough: 1,
    });
    expect(() => service.appendChunk([input(1, "changed")])).toThrow(/conflicts/);
    expect(() => service.appendChunk([input(3, "gap")])).toThrow(/expected 2, received 3/);
    expect(service.restore(EXECUTION_ID)).toBe("same");
  });

  it("stops before retained byte or chunk limits are exceeded", () => {
    const byteLimited = new ParentAssistantTextCheckpointService(db, { maxBytes: 4, maxChunks: 4 });
    expect(byteLimited.appendChunk([input(1, "12345")])).toMatchObject({ outcome: "overflow" });
    expect(byteLimited.restore(EXECUTION_ID)).toBe("");

    const chunkLimited = new ParentAssistantTextCheckpointService(db, { maxBytes: 100, maxChunks: 1 });
    expect(chunkLimited.appendChunk([input(1, "one")])).toMatchObject({ outcome: "committed" });
    expect(chunkLimited.appendChunk([input(2, "two")])).toMatchObject({ outcome: "overflow" });
    expect(chunkLimited.restore(EXECUTION_ID)).toBe("one");
  });

  it("resets unfinished text and retires text only after a canonical terminal outcome", () => {
    service.appendChunk([input(1, "retry me")]);
    expect(service.retire(EXECUTION_ID)).toBe(false);
    expect(service.restore(EXECUTION_ID)).toBe("retry me");
    expect(service.reset(EXECUTION_ID)).toBe(true);
    expect(service.restore(EXECUTION_ID)).toBe("");

    service.appendChunk([input(1, "finished")]);
    db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET terminal_outcome = 'completed'
      WHERE execution_id = ?
    `).run(EXECUTION_ID);
    expect(service.reset(EXECUTION_ID)).toBe(false);
    expect(service.retire(EXECUTION_ID)).toBe(true);
    expect(service.restore(EXECUTION_ID)).toBe("");
  });

  it("resets an unfinished retry even when its checkpoint rows are already absent", () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-text-retry-"));
    const retryService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const recovered: ParentAssistantTextRecoveryJournalChunk[] = [];
    try {
      retryService.recoveryJournal.append([input(1, "journaled")]);

      expect(retryService.resetForRetry(EXECUTION_ID)).toBe(true);
      retryService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));

      expect(recovered).toEqual([]);
      expect(retryService.restore(EXECUTION_ID)).toBe("");
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("removes a recovery journal after its equivalent canonical projection commits", () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-text-retire-"));
    const journalService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const recovered: ParentAssistantTextRecoveryJournalChunk[] = [];
    try {
      journalService.recoveryJournal.append([input(1, "journaled")]);
      journalService.discardRecoveryJournal(EXECUTION_ID);

      journalService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));
      expect(recovered).toEqual([]);
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("removes journal-only provisional text after the canonical execution is terminal", () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-text-terminal-journal-"));
    const journalService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const recovered: ParentAssistantTextRecoveryJournalChunk[] = [];
    try {
      journalService.recoveryJournal.append([input(1, "journaled")]);
      db.prepare(`
        UPDATE canonical_agent_ingest_checkpoints
        SET terminal_outcome = 'completed'
        WHERE execution_id = ?
      `).run(EXECUTION_ID);

      expect(journalService.retire(EXECUTION_ID)).toBe(true);
      journalService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));

      expect(recovered).toEqual([]);
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a recovery journal when SQLite has no retained capacity for its next chunk", () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-text-overflow-"));
    const journalService = new ParentAssistantTextCheckpointService(
      db,
      { maxBytes: 4, maxChunks: 4 },
      { directory: journalDirectory },
    );
    const recovered: ParentAssistantTextRecoveryJournalChunk[] = [];
    try {
      expect(journalService.appendChunk([input(1, "full")]).outcome).toBe("committed");
      journalService.recoveryJournal.append([input(2, "tail")]);

      expect(() => journalService.importRecoveryJournals())
        .toThrow("Assistant text recovery journal exceeds the retained checkpoint capacity");
      expect(journalService.restore(EXECUTION_ID)).toBe("full");

      journalService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));
      expect(recovered).toEqual([
        expect.objectContaining({ firstSequence: 2, lastSequence: 2, text: "tail" }),
      ]);
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps an incomplete journal tail for later recovery instead of unlinking it", () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-text-incomplete-"));
    const journalService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const journalPath = NodePath.join(journalDirectory, `${EXECUTION_ID}.journal`);
    try {
      NodeFS.writeFileSync(journalPath, "{\"version\":1", "utf8");

      expect(() => journalService.recoveryJournal.drain(EXECUTION_ID, () => expect.unreachable()))
        .toThrow("Assistant text recovery journal has an incomplete final record");
      expect(NodeFS.existsSync(journalPath)).toBe(true);
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("does not disable journaling when a persistent database path cannot be resolved", () => {
    const persistentDatabase = {
      filename: "",
    } as unknown as Database;

    expect(() => new ParentAssistantTextCheckpointService(persistentDatabase))
      .toThrow("Assistant text recovery journal database path is unavailable");
  });
});
