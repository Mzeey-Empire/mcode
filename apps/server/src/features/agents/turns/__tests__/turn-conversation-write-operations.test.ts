import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { turnConversationWriteOperations } from "../turn-conversation-write-operations.js";

describe("writer-owned conversation sequences", () => {
  let directory: string;
  let reader: Database;
  let writer: ApplicationDatabaseWriter;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-conversation-writer-"));
    const path = NodePath.join(directory, "app.sqlite");
    const seed = openDatabase({ dbPath: path });
    try {
      seed.run("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)", ["workspace", "Workspace", directory]);
      seed.run("INSERT INTO threads (id, workspace_id, title, branch, provider) VALUES (?, ?, ?, ?, ?)", ["thread", "workspace", "Thread", "main", "codex"]);
    } finally { seed.close(true); }
    reader = openReadOnlyDatabase(path);
    writer = new ApplicationDatabaseWriter(path);
  });

  afterEach(async () => {
    await writer.close();
    reader.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("reuses an assigned goal receipt and allocates distinct sequence values for concurrent new rows", async () => {
    const input = { threadId: "thread", messageId: "goal-one", content: "First receipt", model: "fixture-model" };
    const first = writer.execute(turnConversationWriteOperations.goalReceipt, input);
    const duplicate = writer.execute(turnConversationWriteOperations.goalReceipt, input);
    const divider = writer.execute(turnConversationWriteOperations.compactionDivider, "thread");
    const next = writer.execute(turnConversationWriteOperations.goalReceipt, { ...input, messageId: "goal-two", content: "Second receipt" });
    expect(await first).toMatchObject({ id: "goal-one", sequence: 1 });
    expect(await duplicate).toMatchObject({ id: "goal-one", sequence: 1 });
    await divider;
    expect(await next).toMatchObject({ id: "goal-two", sequence: 3 });
    expect(reader.query("SELECT content, sequence FROM messages ORDER BY sequence").all()).toEqual([
      { content: "First receipt", sequence: 1 }, { content: "Context compacted", sequence: 2 },
      { content: "Second receipt", sequence: 3 },
    ]);
  });

  it("rejects an identity reused with different content without poisoning the next command", async () => {
    const input = { threadId: "thread", messageId: "goal-one", content: "Saved receipt", model: null };
    await writer.execute(turnConversationWriteOperations.goalReceipt, input);
    await expect(writer.execute(turnConversationWriteOperations.goalReceipt, { ...input, content: "Conflicting receipt" }))
      .rejects.toThrow("Goal receipt identity conflicts");
    await writer.execute(turnConversationWriteOperations.compactionDivider, "thread");
    expect(reader.query("SELECT content, sequence FROM messages ORDER BY sequence").all()).toEqual([
      { content: "Saved receipt", sequence: 1 }, { content: "Context compacted", sequence: 2 },
    ]);
  });
});
