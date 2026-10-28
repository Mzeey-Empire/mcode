import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../../../runtime/persistence/sqlite/database.js";
import { ThoughtSegmentStore, type CreateThoughtSegmentInput } from "../thought-segment-store.js";

/** Seed a workspace, thread, and assistant message so FKs resolve. */
function seedFixtures(db: Database): { messageId: string } {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Test thread", "main", now, now);
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("msg-1", "thread-1", "assistant", "hello", now, 1);
  return { messageId: "msg-1" };
}

describe("ThoughtSegmentStore", () => {
  let db: Database;
  let repo: ThoughtSegmentStore;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ThoughtSegmentStore(db);
    ({ messageId } = seedFixtures(db));
  });

  it.each(["bulkCreate", "createBoundedBatch"])("%s preserves conflicts unless replacement is enabled, then updates every column", (method) => {
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) SELECT 'msg-2', thread_id, role, content, timestamp, 2 FROM messages WHERE id = ?",
    ).run(messageId);
    const write = (input: CreateThoughtSegmentInput, replaceExisting: boolean) => {
      if (method === "bulkCreate") {
        repo.bulkCreate([input], replaceExisting);
      } else {
        db.transaction(() => repo.createBoundedBatch(
          [input], { maxRows: 1, maxBytes: 10_000, maxElapsedMs: 1_000 }, replaceExisting,
        ))();
      }
    };
    write({
      id: "thought-conflict",
      messageId,
      text: "Thinking",
      startedAt: "2026-05-15T10:00:00Z",
      endedAt: null,
      sortOrder: 1,
    }, false);
    const original = repo.listByMessage(messageId);
    const replacement: CreateThoughtSegmentInput = {
      id: "thought-conflict",
      messageId: "msg-2",
      text: "Reasoning complete",
      startedAt: "2026-05-15T10:01:00Z",
      endedAt: "2026-05-15T10:01:01Z",
      sortOrder: 3,
      isFinalResponse: 1,
      kind: "reasoning",
    };

    write(replacement, false);
    expect(repo.listByMessage(messageId)).toEqual(original);
    expect(repo.listByMessage("msg-2")).toEqual([]);

    write(replacement, true);
    expect(repo.listByMessage(messageId)).toEqual([]);
    expect(repo.listByMessage("msg-2")).toEqual([{
      id: "thought-conflict",
      message_id: "msg-2",
      text: "Reasoning complete",
      started_at: "2026-05-15T10:01:00Z",
      ended_at: "2026-05-15T10:01:01Z",
      sort_order: 3,
      is_final_response: 1,
      kind: "reasoning",
    }]);
  });

  it("create then listByMessage round-trips a single segment", () => {
    const rec = repo.create({
      id: "th-1",
      messageId,
      text: "I should read the file first.",
      startedAt: "2026-05-15T10:00:00.000Z",
      endedAt: "2026-05-15T10:00:01.500Z",
      sortOrder: 1,
    });
    expect(rec.id).toBe("th-1");
    const out = repo.listByMessage(messageId);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("I should read the file first.");
    expect(out[0]!.sort_order).toBe(1);
    expect(out[0]!.ended_at).toBe("2026-05-15T10:00:01.500Z");
  });

  it("bulkCreate inserts multiple and lists in sort_order ascending", () => {
    repo.bulkCreate([
      { id: "th-b", messageId, text: "B", startedAt: "2026-05-15T10:00:00Z", endedAt: null, sortOrder: 2 },
      { id: "th-a", messageId, text: "A", startedAt: "2026-05-15T10:00:00Z", endedAt: null, sortOrder: 1 },
    ]);
    const out = repo.listByMessage(messageId);
    expect(out.map((r) => r.text)).toEqual(["A", "B"]);
  });

  it("cascade deletes thoughts when the message is deleted", () => {
    repo.create({
      messageId,
      text: "x",
      startedAt: "2026-05-15T10:00:00Z",
      endedAt: null,
      sortOrder: 0,
    });
    expect(repo.countByMessage(messageId)).toBe(1);
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    expect(repo.countByMessage(messageId)).toBe(0);
  });
});
