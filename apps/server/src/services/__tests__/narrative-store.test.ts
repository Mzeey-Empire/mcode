import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database";
import { MessageRepo } from "../../repositories/message-repo";
import { ToolCallRecordRepo } from "../../repositories/tool-call-record-repo";
import { ThoughtSegmentRepo } from "../../repositories/thought-segment-repo";
import { HookExecutionRepo } from "../../repositories/hook-execution-repo";
import { NarrativeStore } from "../narrative-store";

/** Seed a workspace + thread so message/record foreign keys are satisfied. */
function seedThread(db: Database.Database): string {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Test thread", "main", now, now);
  return "thread-1";
}

function insertMessage(
  db: Database.Database,
  id: string,
  role: string,
  content: string,
  sequence: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "thread-1", role, content, now, sequence);
}

describe("NarrativeStore.load (read seam)", () => {
  let db: Database.Database;
  let store: NarrativeStore;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    store = new NarrativeStore(
      new MessageRepo(db),
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
  });

  it("returns one list interleaved by (sequence, sortOrder), final response as the message body", () => {
    // One assistant message: preamble narration (0), tool call (1), hook (2),
    // final-response segment (3). The body must surface at sortOrder 3.
    insertMessage(db, "m1", "assistant", "Final answer text.", 1);
    new ThoughtSegmentRepo(db).bulkCreate([
      { messageId: "m1", text: "Let me look.", startedAt: "t", endedAt: "t", sortOrder: 0 },
      { messageId: "m1", text: "Final answer text.", startedAt: "t", endedAt: "t", sortOrder: 3, isFinalResponse: 1 },
    ]);
    new ToolCallRecordRepo(db).bulkCreate([
      { messageId: "m1", toolName: "Read", inputSummary: "f.ts", outputSummary: "ok", status: "completed", sortOrder: 1 },
    ]);
    new HookExecutionRepo(db).bulkCreate([
      { messageId: "m1", hookName: "PreToolUse", toolName: "Read", phase: "pre", payload: "{}", durationMs: 1, didBlock: false, startedAt: "t", endedAt: "t", sortOrder: 2 },
    ]);

    const entries = store.load("thread-1");

    expect(entries.map((e) => e.kind)).toEqual([
      "narrationSegment", // sortOrder 0
      "toolCall", // 1
      "hook", // 2
      "assistantMessage", // 3 (final response as body)
    ]);
    const body = entries.find((e) => e.kind === "assistantMessage");
    expect(body && body.kind === "assistantMessage" && body.body).toBe("Final answer text.");
    // The final-response segment is NOT also emitted as a narration row.
    const narrations = entries.filter((e) => e.kind === "narrationSegment");
    expect(narrations).toHaveLength(1);
    expect(narrations[0].kind === "narrationSegment" && narrations[0].record.text).toBe("Let me look.");
  });

  it("orders entries across messages by sequence, and skips user/system messages", () => {
    insertMessage(db, "u1", "user", "do the thing", 1);
    insertMessage(db, "m1", "assistant", "first answer", 2);
    insertMessage(db, "sys1", "system", "Context compacted", 3);
    insertMessage(db, "m2", "assistant", "second answer", 4);
    const tools = new ToolCallRecordRepo(db);
    tools.bulkCreate([
      { messageId: "m1", toolName: "Read", inputSummary: "a", outputSummary: "ok", status: "completed", sortOrder: 0 },
    ]);
    tools.bulkCreate([
      { messageId: "m2", toolName: "Bash", inputSummary: "ls", outputSummary: "ok", status: "completed", sortOrder: 0 },
    ]);

    const entries = store.load("thread-1");

    // Only assistant narrative; user + system rows excluded.
    expect(entries.every((e) => e.sequence === 2 || e.sequence === 4)).toBe(true);
    // All of message seq=2's entries precede all of seq=4's entries.
    const seqs = entries.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // m1 (seq 2): toolCall then assistantMessage (body sorts last, no final seg → MAX).
    const seq2 = entries.filter((e) => e.sequence === 2);
    expect(seq2.map((e) => e.kind)).toEqual(["toolCall", "assistantMessage"]);
  });

  it("places the assistant body last when there is no final-response segment", () => {
    insertMessage(db, "m1", "assistant", "answer with no tagged final segment", 1);
    new ToolCallRecordRepo(db).bulkCreate([
      { messageId: "m1", toolName: "Read", inputSummary: "a", outputSummary: "ok", status: "completed", sortOrder: 0 },
      { messageId: "m1", toolName: "Edit", inputSummary: "b", outputSummary: "ok", status: "completed", sortOrder: 1 },
    ]);

    const entries = store.load("thread-1");
    expect(entries.map((e) => e.kind)).toEqual(["toolCall", "toolCall", "assistantMessage"]);
  });
});
