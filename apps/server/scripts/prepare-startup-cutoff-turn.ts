import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { openDatabase } from "../src/runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../src/runtime/persistence/sqlite/application-database-writer.js";
import { CanonicalAgentStore } from "../src/features/agents/canonical/canonical-agent-store.js";
import { MessageStore } from "../src/features/agents/conversation/persistence/message-store.js";
import { ParentAssistantTextCheckpointService } from "../src/features/agents/turns/parent-assistant-text-checkpoint-service.js";
import { z } from "zod";

const path = process.argv[2];
if (!path || !NodePath.isAbsolute(path)) throw new Error("Expected an absolute fixture database path");
const db = openDatabase({ dbPath: path });
const writer = new ApplicationDatabaseWriter(path);
try {
  await writer.whenReady();
  const thread = z.object({ id: z.string(), workspace_id: z.string(), created_at: z.string() }).parse(db.query(
    `SELECT t.id, t.workspace_id, t.created_at FROM threads t
     LEFT JOIN messages m ON m.thread_id = t.id GROUP BY t.id ORDER BY COUNT(m.id) DESC, t.id LIMIT 1`,
  ).get());
  const turnId = NodeCrypto.randomUUID();
  const executionId = NodeCrypto.randomUUID();
  const store = new CanonicalAgentStore(db, () => {});
  const messages = new MessageStore(db);
  const sequence = z.object({ next: z.number() }).parse(db.query(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE thread_id = ?",
  ).get(thread.id)).next;
  store.startParentTurn({
    thread: { id: thread.id, workspaceId: thread.workspace_id, providerId: "codex", createdAt: thread.created_at },
    turnId,
    executionId,
    permissionMode: "supervised",
    providerIdentities: [],
    projectUserMessage: () => messages.create(thread.id, "user", "Startup fixture interrupted turn.", sequence),
  });
  const checkpoints = new ParentAssistantTextCheckpointService(db, writer);
  checkpoints.recoveryJournal.append([
    {
      executionId,
      threadId: thread.id,
      turnId,
      sequence: 1,
      text: "Startup fixture unfinished assistant response.",
    },
  ]);
} finally {
  await writer.close();
  db.close(true);
}
