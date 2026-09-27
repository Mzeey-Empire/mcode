import "reflect-metadata";
import type { Database } from "bun:sqlite";
import type { Message } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ConversationDisplayMaterializer } from "../conversation-display-materializer.js";

const NOW = "2026-09-22T10:00:00.000Z";
const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function message(id: string, role: "user" | "assistant", sequence: number): Message {
  return {
    id,
    thread_id: THREAD_ID,
    role,
    content: role === "assistant" ? "Completed answer" : "Question",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: NOW,
    sequence,
    attachments: null,
  };
}

function seedCanonicalTurn(db: Database): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', 'C:/workspace', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at)
    VALUES (?, 'workspace-1', 'Thread', 'main', 'codex', ?, ?)
  `).run(THREAD_ID, NOW, NOW);
  db.prepare(`
    INSERT INTO canonical_agent_threads (
      id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
      provider_id, provider_identities_json, activity_state, conversation_revision,
      roster_revision, created_at, updated_at
    ) VALUES (?, 'workspace-1', NULL, ?, NULL, 'codex', '[]', 'Idle', 0, 0, ?, ?)
  `).run(THREAD_ID, THREAD_ID, NOW, NOW);
  db.prepare(`
    INSERT INTO canonical_agent_turns (
      id, thread_id, execution_id, status, trigger_json, permission_mode,
      provider_identities_json, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'execution-1', 'Completed', '{"kind":"user"}', 'default', '[]', ?, ?, ?, ?)
  `).run(TURN_ID, THREAD_ID, NOW, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO canonical_agent_ingest_checkpoints (
      execution_id, thread_id, turn_id, last_accepted_sequence, last_durable_sequence,
      native_cursor_json, phase, terminal_outcome, error, updated_at
    ) VALUES ('execution-1', ?, ?, 1, 1, NULL, 'completed', 'completed', NULL, ?)
  `).run(THREAD_ID, TURN_ID, NOW);
}

function insertItem(
  db: Database,
  id: string,
  payload: Record<string, unknown>,
  createdAt = NOW,
): void {
  db.prepare(`
    INSERT INTO canonical_agent_items (
      id, thread_id, turn_id, parent_item_id, kind, provider_identities_json,
      payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, 'message', '[]', ?, ?, ?)
  `).run(id, THREAD_ID, TURN_ID, JSON.stringify(payload), createdAt, createdAt);
}

function recoveryThought(messageId?: string, id = "thought-1"): Record<string, unknown> {
  return {
    projection: "narrativeRecovery",
    narrative: {
      kind: "narrationSegment",
      record: {
        id,
        message_id: messageId,
        text: "Working",
        started_at: NOW,
        sort_order: 0,
      },
    },
  };
}

function directThought(id: string, messageId: string): Record<string, unknown> {
  return {
    projection: "narrationSegment",
    record: { id, message_id: messageId, text: id, started_at: NOW, sort_order: 0 },
  };
}

describe("ConversationDisplayMaterializer", () => {
  let db: Database;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedCanonicalTurn(db);
  });

  afterEach(() => {
    db.close();
  });

  it("keeps explicit anchors while choosing the earliest visible assistant for mixed child rows", () => {
    insertItem(db, "hidden", {
      projection: "message", message: { ...message("hidden-1", "assistant", 0), is_internal: true },
    });
    insertItem(db, "prompt", { projection: "message", message: message("prompt-1", "user", 1) });
    insertItem(db, "first", { projection: "message", message: message("assistant-a", "assistant", 2) });
    insertItem(db, "tied", { projection: "message", message: message("assistant-z", "assistant", 2) });
    insertItem(db, "last", { projection: "message", message: message("assistant-last", "assistant", 3) });
    insertItem(db, "direct-1", directThought("explicit-1", "assistant-last"));
    insertItem(db, "direct-2", directThought("explicit-2", "assistant-last"));
    insertItem(db, "recovery", recoveryThought(undefined, "implicit-1"));
    insertItem(db, "child-reasoning", { projection: "codexChildReasoning", nativeItemId: "reasoning", content: "Thinking" });
    insertItem(db, "child-call", { projection: "codexChildToolCall", nativeItemId: "tool", toolName: "Read", toolInput: {} });
    insertItem(db, "child-result", { projection: "codexChildToolResult", nativeItemId: "tool", output: "contents" });
    insertItem(db, "hook", {
      projection: "hook",
      record: { id: "hook-1", message_id: "assistant-last", hook_name: "Stop", phase: "stop", started_at: NOW },
    });

    new ConversationDisplayMaterializer(db).materializeItems(["last"]);

    expect(db.prepare("SELECT id, message_id FROM thought_segments WHERE id NOT LIKE 'codex-child-%' ORDER BY id").all()).toEqual([
      { id: "explicit-1", message_id: "assistant-last" },
      { id: "explicit-2", message_id: "assistant-last" },
      { id: "implicit-1", message_id: "assistant-a" },
    ]);
    expect(db.prepare("SELECT message_id, text FROM thought_segments WHERE id LIKE 'codex-child-%'").all())
      .toEqual([{ message_id: "assistant-a", text: "Thinking" }]);
    expect(db.prepare("SELECT message_id, output_summary, status FROM tool_call_records").all())
      .toEqual([{ message_id: "assistant-a", output_summary: "contents", status: "completed" }]);
    expect(db.prepare("SELECT id, message_id FROM hook_executions").all())
      .toEqual([{ id: "hook-1", message_id: "assistant-last" }]);
    expect(db.prepare("SELECT id FROM messages ORDER BY id").all())
      .toEqual([{ id: "assistant-a" }, { id: "assistant-last" }]);
  });

  it("preserves message updates between different resolutions of a shared canonical message ID", () => {
    insertItem(db, "a-explicit-source", {
      projection: "message", message: { ...message("shared", "assistant", 3), content: "Explicit source" },
    });
    insertItem(db, "b-anchor-source", {
      projection: "message", message: { ...message("shared", "assistant", 2), content: "Anchor source" },
    });
    insertItem(db, "child-a", directThought("explicit-a", "shared"));
    insertItem(db, "child-b", { projection: "codexChildReasoning", nativeItemId: "reasoning", content: "Thinking" });
    insertItem(db, "child-c", directThought("explicit-c", "shared"));
    const materializer = new ConversationDisplayMaterializer(db);
    materializer.materializeItems(["a-explicit-source"]);
    expect(db.prepare("SELECT content FROM messages WHERE id = 'shared'").get()).toEqual({ content: "Explicit source" });

    insertItem(db, "child-d", recoveryThought(undefined, "implicit"));
    materializer.materializeItems(["a-explicit-source"]);
    expect(db.prepare("SELECT content FROM messages WHERE id = 'shared'").get()).toEqual({ content: "Explicit source" });
  });

  it("rolls back a failed child traversal and resolves current messages when the same materializer retries", () => {
    insertItem(db, "assistant", { projection: "message", message: message("assistant-1", "assistant", 2) });
    insertItem(db, "a-recovery", recoveryThought());
    insertItem(db, "b-direct", directThought("direct-1", "assistant-1"));
    insertItem(db, "c-invalid", {
      projection: "narrationSegment",
      record: { id: "invalid-1", message_id: "assistant-1", text: "Retried", started_at: "" },
    });
    const materializer = new ConversationDisplayMaterializer(db);
    const materialize = db.transaction(() => materializer.materializeItems(["assistant"]));

    expect(materialize).toThrow("Canonical thought started_at is required");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM thought_segments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_conversation_display_mappings").get()).toEqual({ count: 0 });

    db.prepare("UPDATE canonical_agent_items SET payload_json = json_set(payload_json, '$.record.started_at', ?) WHERE id = 'c-invalid'").run(NOW);
    db.prepare("UPDATE canonical_agent_items SET payload_json = json_set(payload_json, '$.message.content', 'New answer') WHERE id = 'assistant'").run();
    materialize();

    expect(db.prepare("SELECT content FROM messages WHERE id = 'assistant-1'").get()).toEqual({ content: "New answer" });
    expect(db.prepare("SELECT id, message_id FROM thought_segments ORDER BY id").all()).toEqual([
      { id: "direct-1", message_id: "assistant-1" },
      { id: "invalid-1", message_id: "assistant-1" },
      { id: "thought-1", message_id: "assistant-1" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_conversation_display_mappings").get()).toEqual({ count: 4 });
  });

  it("resolves later canonical visibility and content changes without reusing a prior traversal", () => {
    insertItem(db, "first", { projection: "message", message: message("assistant-first", "assistant", 2) });
    insertItem(db, "last", { projection: "message", message: message("assistant-last", "assistant", 3) });
    insertItem(db, "recovery", recoveryThought());
    insertItem(db, "direct", directThought("direct-1", "assistant-last"));
    const materializer = new ConversationDisplayMaterializer(db);
    materializer.materializeItems(["last"]);
    expect(db.prepare("SELECT message_id FROM thought_segments WHERE id = 'thought-1'").get())
      .toEqual({ message_id: "assistant-first" });

    db.prepare("UPDATE canonical_agent_items SET payload_json = json_set(payload_json, '$.message.is_internal', 1) WHERE id = 'first'").run();
    db.prepare("UPDATE canonical_agent_items SET payload_json = json_set(payload_json, '$.message.content', 'Updated answer') WHERE id = 'last'").run();
    materializer.materializeItems(["last"]);

    expect(db.prepare("SELECT id, message_id FROM thought_segments ORDER BY id").all()).toEqual([
      { id: "direct-1", message_id: "assistant-last" },
      { id: "thought-1", message_id: "assistant-last" },
    ]);
    expect(db.prepare("SELECT content FROM messages WHERE id = 'assistant-last'").get()).toEqual({ content: "Updated answer" });

    db.prepare("UPDATE canonical_agent_ingest_checkpoints SET terminal_outcome = NULL, phase = 'running'").run();
    insertItem(db, "prompt", { projection: "message", message: message("prompt-1", "user", 1) });
    materializer.materializeItems(["recovery", "direct"]);
    expect(db.prepare("SELECT DISTINCT message_id FROM thought_segments").all()).toEqual([{ message_id: "prompt-1" }]);
  });

  it.each(["completed", "cancelled"])("keeps recovered narrative on the prompt until the turn is %s", (outcome) => {
    db.prepare("UPDATE canonical_agent_ingest_checkpoints SET terminal_outcome = NULL, phase = 'running'").run();
    insertItem(db, "prompt-item", { projection: "message", message: message("prompt-1", "user", 1) });
    insertItem(db, "assistant-item", { projection: "message", message: message("assistant-1", "assistant", 2) });
    insertItem(db, "recovery-item", recoveryThought());

    new ConversationDisplayMaterializer(db).materializeItems(["recovery-item"]);

    expect(db.prepare("SELECT id, content FROM messages").all()).toEqual([{ id: "prompt-1", content: "Question" }]);
    expect(db.prepare("SELECT id, message_id, text FROM thought_segments").all()).toEqual([
      { id: "thought-1", message_id: "prompt-1", text: "Working" },
    ]);

    const recoveredMaterializer = new ConversationDisplayMaterializer(db);
    recoveredMaterializer.materializeItems(["recovery-item"]);
    expect(db.prepare("SELECT message_id FROM thought_segments").all()).toEqual([{ message_id: "prompt-1" }]);

    db.prepare("UPDATE canonical_agent_ingest_checkpoints SET terminal_outcome = ?, phase = ?").run(outcome, outcome);
    recoveredMaterializer.materializeItems(["assistant-item"]);

    expect(db.prepare("SELECT id, message_id, text FROM thought_segments").all()).toEqual([
      { id: "thought-1", message_id: "assistant-1", text: "Working" },
    ]);
    expect(db.prepare("SELECT target_kind, target_id FROM canonical_conversation_display_mappings WHERE source_item_id = 'recovery-item'").get())
      .toEqual({ target_kind: "narrationSegment", target_id: "thought-1" });
  });

  it("defers recovery narrative with no visible anchor until a terminal message arrives", () => {
    insertItem(db, "recovery-item", recoveryThought());
    const materializer = new ConversationDisplayMaterializer(db);

    materializer.materializeItems(["recovery-item"]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM thought_segments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_conversation_display_mappings").get()).toEqual({ count: 0 });

    insertItem(db, "assistant-item", { projection: "message", message: message("assistant-1", "assistant", 2) });
    materializer.materializeItems(["assistant-item"]);

    expect(db.prepare("SELECT id, message_id FROM thought_segments").all()).toEqual([
      { id: "thought-1", message_id: "assistant-1" },
    ]);
  });

  it.each(["missing", "hidden"])("rejects recovery narrative with an explicit %s message", (visibility) => {
    insertItem(db, "prompt-item", { projection: "message", message: message("prompt-1", "user", 1) });
    if (visibility === "hidden") {
      insertItem(db, "hidden-item", {
        projection: "message",
        message: { ...message("invalid-1", "user", 2), is_internal: true },
      });
    }
    insertItem(db, "recovery-item", recoveryThought("invalid-1"));

    expect(() => new ConversationDisplayMaterializer(db).materializeItems(["recovery-item"]))
      .toThrow(`Canonical narrative item recovery-item references ${visibility === "hidden" ? "a hidden" : "missing"} message invalid-1`);
    expect(db.prepare("SELECT COUNT(*) AS count FROM thought_segments").get()).toEqual({ count: 0 });
  });

  it("defers unanchored canonical child rows until a terminal assistant can display them", async () => {
    insertItem(db, "child-tool-item", {
      projection: "codexChildToolCall",
      nativeItemId: "native-child-tool",
      toolName: "Read",
      toolInput: { path: "src/app.ts" },
    });
    const materializer = new ConversationDisplayMaterializer(db);

    await materializer.runToCompletion();

    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_records").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_conversation_display_mappings").get())
      .toEqual({ count: 0 });

    const assistant = message("assistant-1", "assistant", 2);
    insertItem(db, "assistant-item", { projection: "message", message: assistant }, "2026-09-22T10:00:01.000Z");
    db.transaction(() => materializer.materializeItems(["assistant-item"]))();

    expect(db.prepare("SELECT message_id, tool_name FROM tool_call_records").get()).toEqual({
      message_id: assistant.id,
      tool_name: "Read",
    });
    expect(db.prepare(`
      SELECT target_kind FROM canonical_conversation_display_mappings WHERE source_item_id = 'child-tool-item'
    `).get()).toEqual({ target_kind: "toolCall" });
  });

  it("keeps legacy lineage and richer display-only fields while rematerializing a canonical message", () => {
    const legacyFields = {
      selectedTextComments: JSON.stringify([{ id: "comment-1" }]),
      outcome: "completed",
      outcomeExecutionId: "execution-legacy",
      systemNotice: JSON.stringify({ kind: "diagnostic", presentation: "timeline" }),
      parentAgentProvenance: JSON.stringify({ parentThreadId: "parent", parentTurnId: "turn", parentItemId: "item", providerIdentities: [] }),
      legacyProvenance: JSON.stringify({ source: "messages", migrationVersion: 1, mapping: "canonical" }),
    };
    db.prepare(`
      INSERT INTO messages (
        id, thread_id, role, content, timestamp, sequence, origin_type,
        source_thread_id, source_turn_id, source_provider_id, selected_text_comments,
        outcome, outcome_execution_id, system_notice, parent_agent_provenance, legacy_provenance
      ) VALUES (?, ?, 'user', 'Question', ?, 1, 'legacy', 'legacy-thread', 'legacy-turn', 'codex', ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-message", THREAD_ID, NOW, legacyFields.selectedTextComments,
      legacyFields.outcome, legacyFields.outcomeExecutionId, legacyFields.systemNotice,
      legacyFields.parentAgentProvenance, legacyFields.legacyProvenance,
    );
    const legacyMessage = {
      ...message("legacy-message", "user", 1),
      legacyProvenance: { source: "messages" as const, migrationVersion: 1, mapping: "canonical" as const },
    };
    insertItem(db, "legacy-message-item", { projection: "message", message: legacyMessage });

    new ConversationDisplayMaterializer(db).materializeItems(["legacy-message-item"]);

    expect(db.prepare(`
      SELECT origin_type, source_thread_id, source_turn_id, source_provider_id,
        selected_text_comments, outcome, outcome_execution_id, system_notice, parent_agent_provenance, legacy_provenance
      FROM messages WHERE id = 'legacy-message'
    `).get()).toEqual({
      origin_type: "legacy",
      source_thread_id: "legacy-thread",
      source_turn_id: "legacy-turn",
      source_provider_id: "codex",
      selected_text_comments: legacyFields.selectedTextComments,
      outcome: legacyFields.outcome,
      outcome_execution_id: legacyFields.outcomeExecutionId,
      system_notice: legacyFields.systemNotice,
      parent_agent_provenance: legacyFields.parentAgentProvenance,
      legacy_provenance: legacyFields.legacyProvenance,
    });
  });

  it("uses the canonical tool projection during startup and live updates", async () => {
    db.prepare(`
      INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
      VALUES ('assistant-1', ?, 'assistant', 'Completed answer', ?, 2)
    `).run(THREAD_ID, NOW);
    db.prepare(`
      INSERT INTO tool_call_records (
        id, message_id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order
      ) VALUES ('tool-1', 'assistant-1', 'Read', '{}', 'existing output', 'completed', ?, ?, 0)
    `).run(NOW, NOW);
    insertItem(db, "tool-item", {
      projection: "toolCall",
      record: {
        id: "tool-1",
        message_id: "assistant-1",
        tool_name: "Read",
        input_summary: "{}",
        output_summary: "canonical output",
        status: "running",
        started_at: NOW,
        completed_at: null,
        sort_order: 0,
      },
    });
    const materializer = new ConversationDisplayMaterializer(db);

    await materializer.runToCompletion();

    expect(db.prepare(`
      SELECT output_summary, status, completed_at FROM tool_call_records WHERE id = 'tool-1'
    `).get()).toEqual({ output_summary: "canonical output", status: "running", completed_at: null });

    materializer.materializeItems(["tool-item"]);

    expect(db.prepare(`
      SELECT output_summary, status, completed_at FROM tool_call_records WHERE id = 'tool-1'
    `).get()).toEqual({ output_summary: "canonical output", status: "running", completed_at: null });
  });

  it("uses a canonical message source when a narrative record reaches an old display row first", () => {
    db.prepare(`
      INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
      VALUES ('assistant-1', ?, 'assistant', 'old display answer', ?, 2)
    `).run(THREAD_ID, NOW);
    insertItem(db, "assistant-source", {
      projection: "message",
      message: message("assistant-1", "assistant", 2),
    });
    insertItem(db, "tool-item", {
      projection: "toolCall",
      record: {
        id: "tool-1",
        message_id: "assistant-1",
        tool_name: "Read",
        input_summary: "{}",
        output_summary: "canonical output",
        status: "completed",
        started_at: NOW,
        completed_at: NOW,
        sort_order: 0,
      },
    });

    new ConversationDisplayMaterializer(db).materializeItems(["tool-item"]);

    expect(db.prepare(`SELECT content FROM messages WHERE id = 'assistant-1'`).get())
      .toEqual({ content: "Completed answer" });
  });

  it("preserves a leading BOM in a live tool output", () => {
    db.prepare(`
      INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
      VALUES ('assistant-1', ?, 'assistant', 'Completed answer', ?, 2)
    `).run(THREAD_ID, NOW);
    insertItem(db, "tool-item", {
      projection: "toolCall",
      record: {
        id: "tool-bom",
        message_id: "assistant-1",
        tool_name: "Read",
        input_summary: "{}",
        output_summary: "\uFEFFoutput",
        status: "completed",
        started_at: NOW,
        completed_at: NOW,
        sort_order: 0,
      },
    });

    new ConversationDisplayMaterializer(db).materializeItems(["tool-item"]);

    expect(db.prepare(`SELECT output_summary FROM tool_call_records WHERE id = 'tool-bom'`).get())
      .toEqual({ output_summary: "\uFEFFoutput" });
  });

  it("applies a canonical child result after its startup call materializes the same display row", async () => {
    insertItem(db, "assistant-item", {
      projection: "message",
      message: message("assistant-1", "assistant", 2),
    });
    insertItem(db, "child-call-item", {
      projection: "codexChildToolCall",
      nativeItemId: "child-tool-1",
      toolName: "Read",
      toolInput: { path: "src/app.ts" },
    });
    insertItem(db, "child-result-item", {
      projection: "codexChildToolResult",
      nativeItemId: "child-tool-1",
      output: "file contents",
      isError: false,
    });

    await new ConversationDisplayMaterializer(db).runToCompletion();

    expect(db.prepare(`
      SELECT output_summary, status, completed_at
      FROM tool_call_records
      WHERE id LIKE 'codex-child-tool:%'
    `).get()).toEqual({
      output_summary: "file contents",
      status: "completed",
      completed_at: NOW,
    });
  });

  it("overlays exact canonical legacy provenance onto a preserved display message", async () => {
    db.prepare(`
      INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, origin_type)
      VALUES ('legacy-message', ?, 'user', 'Question', ?, 1, 'legacy')
    `).run(THREAD_ID, NOW);
    insertItem(db, "legacy-item", {
      projection: "message",
      message: {
        ...message("legacy-message", "user", 1),
        legacyProvenance: { source: "messages", migrationVersion: 1, mapping: "canonical" },
      },
    });

    await new ConversationDisplayMaterializer(db).runToCompletion();

    expect(db.prepare(`
      SELECT origin_type, legacy_provenance FROM messages WHERE id = 'legacy-message'
    `).get()).toEqual({
      origin_type: "legacy",
      legacy_provenance: JSON.stringify({ source: "messages", migrationVersion: 1, mapping: "canonical" }),
    });
  });

  it("rolls back a malformed batch without advancing the resumable checkpoint", async () => {
    insertItem(db, "assistant-item", {
      projection: "message",
      message: message("assistant-rollback", "assistant", 2),
    });
    insertItem(db, "invalid-tool-item", {
      projection: "toolCall",
      record: {
        id: "tool-rollback",
        message_id: "assistant-rollback",
        tool_name: "Read",
        input_summary: "{}",
        output_summary: "",
        status: "",
        started_at: NOW,
        sort_order: 0,
      },
    });

    await expect(new ConversationDisplayMaterializer(db).runToCompletion())
      .rejects.toThrow("Canonical toolCall status is required");

    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'assistant-rollback'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_conversation_display_mappings").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT last_source_created_at, last_source_id, completed
      FROM conversation_display_materialization_state
      WHERE id = 1
    `).get()).toEqual({ last_source_created_at: null, last_source_id: null, completed: 0 });
  });
});
