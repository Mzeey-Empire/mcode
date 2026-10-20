import "reflect-metadata";
import { expect, it } from "vitest";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../../agents/tools/persistence/tool-call-record-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { createOwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { handoffItemsFromMessages } from "../items.js";
import { loadHandoffMessages } from "../message-adapter.js";

it("loads verbatim thread history, provider and real tool records with an exclusive delta cursor", async () => {
  const owned = createOwnedTestDatabase();
  try {
    const messageRepo = new MessageRepo(owned.db, owned.writer);
    const toolCallRecordRepo = new ToolCallRecordRepo(owned.db, owned.writer);
    const threadRepo = new ThreadRepo(owned.db, owned.writer);
    owned.db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("handoff-ws", "fixture", "/fixture");
    const thread = await threadRepo.create("handoff-ws", "handoff", "direct", "main");
    const other = await threadRepo.create("handoff-ws", "unrelated", "direct", "main");
    await messageRepo.create(thread.id, "user", "  question\n", 1);
    await messageRepo.create(other.id, "user", "other thread", 2);
    await messageRepo.createAssistantIdempotent({
      id: "handoff-answer", threadId: thread.id, sequence: 2, content: "\nanswer  ", provider: "codex",
    });
    await messageRepo.createAssistantIdempotent({
      id: "handoff-hidden", threadId: thread.id, sequence: 3, content: "hidden", provider: "claude", isInternal: true,
    });
    owned.db.prepare("UPDATE messages SET files_changed = ? WHERE id = ?")
      .run('["a.ts",{"path":"b.ts"}]', "handoff-answer");
    await toolCallRecordRepo.create({
      messageId: "handoff-answer", toolName: "Bash", inputSummary: "pwd",
      outputSummary: "private output", status: "completed", sortOrder: 0,
    });
    await toolCallRecordRepo.create({
      messageId: "handoff-answer", toolName: "Read", inputSummary: "a.ts",
      outputSummary: "file body", status: "completed", sortOrder: 1,
    });
    const input = { messageRepo, toolCallRecordRepo, threadId: thread.id };
    const full = loadHandoffMessages(input);
    expect(handoffItemsFromMessages(full, null)).toEqual([
      { sequence: 1, role: "user", kind: "message", provider: null, text: "  question\n" },
      { sequence: 2, role: "assistant", kind: "message", provider: "codex", text: "\nanswer  " },
      { sequence: 2, role: "assistant", kind: "tool_call", provider: "codex", text: "Bash: pwd" },
      { sequence: 2, role: "assistant", kind: "files_changed", provider: "codex", text: "Files changed: a.ts, b.ts" },
    ]);
    const delta = loadHandoffMessages({ ...input, afterSequence: 1 });
    expect(delta.map((message) => message.sequence)).toEqual([2, 3]);
    expect(handoffItemsFromMessages(delta, null).map((item) => item.text)).toEqual([
      "\nanswer  ", "Bash: pwd", "Files changed: a.ts, b.ts",
    ]);
    expect(loadHandoffMessages({ ...input, afterSequence: 3 })).toEqual([]);
  } finally {
    await owned.close();
  }
});
