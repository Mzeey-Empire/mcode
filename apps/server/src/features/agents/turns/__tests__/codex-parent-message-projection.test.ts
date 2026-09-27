import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { RealGitExecutor } from "../../../projects/git/execution/real-git-executor.js";
import { TurnSnapshotRepo } from "../persistence/turn-snapshot-repo.js";
import { TurnFinalizer } from "../turn-finalizer.js";
import { CodexParentMessageProjection } from "../codex-parent-message-projection.js";
import { deriveTurnAssistantMessageId } from "../turn-assistant-message-id.js";

const execution = { threadId: "thread-1", turnId: "turn-1", executionId: "execution-1" } as const;
const endedAt = "2026-09-24T10:00:00.000Z";
const image = { id: "image-1", name: "image.png", mimeType: "image/png", sizeBytes: 12 };

describe("CodexParentMessageProjection", () => {
  let directory: string;
  let path: string;
  let db: Database;
  let messages: MessageRepo;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-codex-message-projection-"));
    path = NodePath.join(directory, "mcode.db");
    db = openDatabase({ dbPath: path });
    messages = new MessageRepo(db);
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace-1", "Workspace", "C:/fixture", endedAt, endedAt);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(execution.threadId, "workspace-1", "Thread", "main", "codex", endedAt, endedAt);
    messages.create(execution.threadId, "user", "Question", 1, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, "user-1");
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function finalizer(): TurnFinalizer {
    return new TurnFinalizer(
      messages,
      new ThreadRepo(db),
      new NarrativeStore(messages, new ToolCallRecordRepo(db), new ThoughtSegmentRepo(db), new HookExecutionRepo(db)),
      new SnapshotService(new RealGitExecutor()),
      new TurnSnapshotRepo(db),
      db,
    );
  }

  function projection(): CodexParentMessageProjection {
    return new CodexParentMessageProjection({ execution, turnKind: "ordinary" });
  }

  it("matches the live finalizer after an intervening notice and survives repeat and reload", () => {
    const live = finalizer();
    const worker = projection();
    live.bufferAssistantAttachments(execution.threadId, [image]);
    worker.bufferGeneratedAttachment(execution, image);
    messages.create(execution.threadId, "system", "Notice", 2, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, "notice-1");

    const publicMessage = worker.projectMessage({
      execution, content: "Answer", model: "codex-model", precedingMessageId: "notice-1",
      postTurnGoalReceipt: false,
    });
    const liveMessageId = live.bufferAssistantBody(execution.threadId, "Answer", "codex-model");
    expect(publicMessage).toEqual({ messageId: liveMessageId, model: "codex-model", attachments: [image] });
    expect(liveMessageId).toBe(deriveTurnAssistantMessageId(execution.threadId, "notice-1"));

    const terminal = worker.projectTerminal({ execution, outcome: "completed", endedAt,
      fallbackModel: "later-model", narrative: [] });
    expect(structuredClone(terminal)).toEqual(terminal);
    expect(terminal).toMatchObject({ fromProvider: true,
      assistant: { messageId: publicMessage.messageId, content: "Answer", model: "codex-model", attachments: [image] } });
    expect(worker.projectTerminal({ execution, outcome: "completed", endedAt,
      fallbackModel: "later-model", narrative: [] })).toEqual(terminal);

    messages.createAssistantIdempotent({ id: terminal.assistant.messageId, threadId: execution.threadId,
      content: terminal.assistant.content, model: terminal.assistant.model,
      attachments: [...terminal.assistant.attachments], sequence: 3 });
    db.close(true);
    db = openDatabase({ dbPath: path });
    messages = new MessageRepo(db);
    expect(messages.listByThread(execution.threadId, 10).messages.filter((message) => message.role === "assistant"))
      .toEqual([expect.objectContaining({ id: publicMessage.messageId, model: "codex-model", attachments: [image] })]);

    const replayWorker = projection();
    replayWorker.bufferGeneratedAttachment(execution, image);
    const replay = replayWorker.projectMessage({ execution, content: "Answer", model: "codex-model",
      precedingMessageId: "notice-1", postTurnGoalReceipt: false });
    expect(replay).toEqual(publicMessage);
    messages.createAssistantIdempotent({ id: replay.messageId, threadId: execution.threadId,
      content: "Answer", model: "codex-model", sequence: 3 });
    expect(messages.listByThread(execution.threadId, 10).messages.filter((message) => message.role === "assistant"))
      .toHaveLength(1);
  });

  it("keeps the published ID when a later notice changes the last visible row", () => {
    const worker = projection();
    const publicMessage = worker.projectMessage({ execution, content: "Answer", model: null,
      precedingMessageId: "user-1", postTurnGoalReceipt: false });
    messages.create(execution.threadId, "system", "Later notice", 2);

    const terminal = worker.projectTerminal({ execution, outcome: "completed", endedAt,
      precedingMessageId: messages.listByThread(execution.threadId, 1).messages[0]?.id,
      fallbackModel: "new-model", narrative: [] });
    expect(terminal.assistant.messageId).toBe(publicMessage.messageId);
    expect(terminal.assistant.model).toBeNull();
  });

  it("derives a text-only fallback ID at terminal time and fences a prior execution", () => {
    const worker = projection();
    const stale = { ...execution, executionId: "old-execution" };
    expect(() => worker.appendFinalResponseText(stale, "wrong")).toThrow(/Stale Codex/);
    expect(() => worker.bufferGeneratedAttachment(stale, image)).toThrow(/Stale Codex/);
    expect(() => worker.projectMessage({ execution: stale, content: "wrong", model: null,
      precedingMessageId: "user-1", postTurnGoalReceipt: false })).toThrow(/Stale Codex/);
    worker.appendFinalResponseText(execution, "  partial answer  ");
    const terminal = worker.projectTerminal({ execution, outcome: "cancelled", endedAt,
      precedingMessageId: "user-1", fallbackModel: "codex-fallback", narrative: [] });
    expect(terminal).toMatchObject({ fromProvider: false,
      assistant: { messageId: deriveTurnAssistantMessageId(execution.threadId, "user-1"),
        content: "partial answer", model: "codex-fallback", attachments: [] } });
    expect(() => worker.projectTerminal({ execution: { ...execution, turnId: "later-turn" },
      outcome: "completed", endedAt, precedingMessageId: "user-1", fallbackModel: null, narrative: [] }))
      .toThrow(/Stale Codex/);
  });

  it("rejects plan turns and post-turn goal receipts without mutating the ordinary message", () => {
    expect(() => new CodexParentMessageProjection({ execution, turnKind: "plan" }))
      .toThrow(/plan output needs early assistant materialization/);
    const worker = projection();
    expect(() => worker.projectMessage({ execution, content: "Goal achieved in 3s.", model: null,
      precedingMessageId: "user-1", postTurnGoalReceipt: true })).toThrow(/Post-turn goal receipts/);
    expect(worker.projectTerminal({ execution, outcome: "completed", endedAt,
      precedingMessageId: "user-1", fallbackModel: null, narrative: [] }).assistant.content).toBe("");
  });
});
