import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { NarrationSegmentRepo } from "../repositories/narration-segment-repo";

/** Seed a workspace, thread, and assistant message so FKs resolve. */
function seedFixtures(db: Database.Database): { messageId: string } {
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

describe("NarrationSegmentRepo", () => {
  let db: Database.Database;
  let repo: NarrationSegmentRepo;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new NarrationSegmentRepo(db);
    ({ messageId } = seedFixtures(db));
  });

  it("create then listByMessage round-trips a single segment", () => {
    const rec = repo.create({
      id: "ns-1",
      messageId,
      text: "I should read the file first.",
      startedAt: "2026-05-15T10:00:00.000Z",
      endedAt: "2026-05-15T10:00:01.500Z",
      sortOrder: 1,
    });
    expect(rec.id).toBe("ns-1");
    const out = repo.listByMessage(messageId);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("I should read the file first.");
    expect(out[0]!.sort_order).toBe(1);
    expect(out[0]!.ended_at).toBe("2026-05-15T10:00:01.500Z");
  });

  it("bulkCreate inserts multiple and lists in sort_order ascending", () => {
    repo.bulkCreate([
      { id: "ns-b", messageId, text: "B", startedAt: "2026-05-15T10:00:00Z", endedAt: null, sortOrder: 2 },
      { id: "ns-a", messageId, text: "A", startedAt: "2026-05-15T10:00:00Z", endedAt: null, sortOrder: 1 },
    ]);
    const out = repo.listByMessage(messageId);
    expect(out.map((r) => r.text)).toEqual(["A", "B"]);
  });

  it("cascade deletes narration segments when the message is deleted", () => {
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
