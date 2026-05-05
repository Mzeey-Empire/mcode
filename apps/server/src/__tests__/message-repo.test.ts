import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MessageRepo } from "../repositories/message-repo.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      files_changed TEXT,
      cost_usd REAL,
      tokens_used INTEGER,
      timestamp TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      attachments TEXT,
      reply_to_message_id TEXT,
      quoted_text TEXT
    );
    CREATE TABLE tool_call_records (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      name TEXT,
      arguments TEXT,
      result TEXT
    );
  `);
  return db;
}

describe("MessageRepo", () => {
  let db: Database.Database;
  let repo: MessageRepo;

  beforeEach(() => {
    db = createTestDb();
    repo = new MessageRepo(db);
  });

  describe("listByThreadUpToSequence", () => {
    it("returns all messages with sequence <= maxSequence", () => {
      for (let i = 1; i <= 5; i++) {
        repo.create("thread-1", "user", `msg-${i}`, i);
      }

      const result = repo.listByThreadUpToSequence("thread-1", 3);
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.sequence)).toEqual([1, 2, 3]);
    });

    it("returns empty array when no messages match", () => {
      repo.create("thread-1", "user", "msg-1", 10);

      const result = repo.listByThreadUpToSequence("thread-1", 5);
      expect(result).toHaveLength(0);
    });

    it("does not clamp at 1000 rows", () => {
      // Insert 1200 messages
      const insert = db.prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertMany = db.transaction(() => {
        for (let i = 1; i <= 1200; i++) {
          insert.run(`id-${i}`, "thread-1", "user", `msg-${i}`, "2026-01-01T00:00:00Z", i);
        }
      });
      insertMany();

      const result = repo.listByThreadUpToSequence("thread-1", 1200);
      expect(result).toHaveLength(1200);
    });

    it("only returns messages for the specified thread", () => {
      repo.create("thread-1", "user", "t1-msg", 1);
      repo.create("thread-2", "user", "t2-msg", 1);

      const result = repo.listByThreadUpToSequence("thread-1", 10);
      expect(result).toHaveLength(1);
      expect(result[0].thread_id).toBe("thread-1");
    });
  });

  describe("create with reply fields", () => {
    it("persists replyToMessageId and quotedText", () => {
      const original = repo.create("thread-1", "assistant", "hello", 1);
      const reply = repo.create("thread-1", "user", "reply text", 2, undefined, original.id, "quoted excerpt");

      expect(reply.reply_to_message_id).toBe(original.id);
      expect(reply.quoted_text).toBe("quoted excerpt");
    });

    it("stores null when reply fields are omitted", () => {
      const msg = repo.create("thread-1", "user", "no reply", 1);

      expect(msg.reply_to_message_id).toBeNull();
      expect(msg.quoted_text).toBeNull();
    });

    it("round-trips reply fields through findByIdInThread", () => {
      const original = repo.create("thread-1", "user", "original", 1);
      const reply = repo.create("thread-1", "assistant", "response", 2, undefined, original.id, "some quote");

      const found = repo.findByIdInThread("thread-1", reply.id);
      expect(found).not.toBeNull();
      expect(found!.reply_to_message_id).toBe(original.id);
      expect(found!.quoted_text).toBe("some quote");
    });
  });

  describe("findByIdInThread", () => {
    it("returns the message matching the given id and thread", () => {
      repo.create("thread-1", "user", "first", 1);
      const second = repo.create("thread-1", "assistant", "second", 2);

      const found = repo.findByIdInThread("thread-1", second.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(second.id);
      expect(found!.content).toBe("second");
    });

    it("returns null when message does not exist", () => {
      const found = repo.findByIdInThread("thread-1", "nonexistent");
      expect(found).toBeNull();
    });

    it("returns null when message belongs to a different thread", () => {
      const msg = repo.create("thread-2", "user", "other thread", 1);

      const found = repo.findByIdInThread("thread-1", msg.id);
      expect(found).toBeNull();
    });
  });
});
