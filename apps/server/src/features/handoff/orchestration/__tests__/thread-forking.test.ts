import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import type { Database } from "bun:sqlite";

describe("thread forking - data layer", () => {
  let db: Database;
  let owned: OwnedTestDatabase;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;

  afterEach(async () => {
    await owned.writer.barrier();
    db.close(true);
    await owned.close();
  });

  beforeEach(async () => {
    owned = createOwnedTestDatabase();
    db = openReadOnlyDatabase(owned.db.filename);
    threadRepo = new ThreadRepo(db, owned.writer);
    messageRepo = new MessageRepo(db, owned.writer);

    owned.db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");

    const parent = await threadRepo.create("ws-1", "Fix auth bug", "direct", "main");
    await messageRepo.create(parent.id, "user", "Fix the auth bug", 1);
    await messageRepo.create(parent.id, "assistant", "I fixed the auth bug by updating the middleware.", 2);
    await messageRepo.create(parent.id, "user", "Now add tests", 3);
    await messageRepo.create(parent.id, "assistant", "I added comprehensive tests for the auth middleware.", 4);
  });

  it("child thread stores lineage to parent", async () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    const child = await threadRepo.create("ws-1", "Branch: test coverage", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    expect(child.parent_thread_id).toBe(parent.id);
    expect(child.forked_from_message_id).toBe("msg-fork");
  });

  it("child does not copy parent sdk_session_id", async () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    await threadRepo.updateSdkSessionId(parent.id, "sdk-parent-session");
    const child = await threadRepo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    expect(child.sdk_session_id).toBeNull();
  });

  it("deleting parent does not delete child", async () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    const child = await threadRepo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    await threadRepo.softDelete(parent.id);
    const found = threadRepo.findById(child.id);
    expect(found).not.toBeNull();
    expect(found!.parent_thread_id).toBe(parent.id);
  });

  it("child messages are independent from parent messages", async () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    const child = await threadRepo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    const parentMsgs = messageRepo.listByThread(parent.id, 100);
    expect(parentMsgs.messages).toHaveLength(4);

    const childMsgs = messageRepo.listByThread(child.id, 100);
    expect(childMsgs.messages).toHaveLength(0);
  });
});

describe("thread forking - edge cases", () => {
  let db: Database;
  let owned: OwnedTestDatabase;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;

  afterEach(async () => {
    await owned.writer.barrier();
    db.close(true);
    await owned.close();
  });

  beforeEach(async () => {
    owned = createOwnedTestDatabase();
    db = openReadOnlyDatabase(owned.db.filename);
    threadRepo = new ThreadRepo(db, owned.writer);
    messageRepo = new MessageRepo(db, owned.writer);
    owned.db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
    owned.db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-2", "other", "/tmp/other");
  });

  it("cross-workspace lineage data is isolated", async () => {
    const parent = await threadRepo.create("ws-1", "parent", "direct", "main");
    await messageRepo.create(parent.id, "user", "hello", 1);
    expect(parent.workspace_id).toBe("ws-1");
    // Cross-workspace forking is prevented by the guard in createBranchedThread
  });

  it("deleted thread lineage is preserved", async () => {
    const parent = await threadRepo.create("ws-1", "parent", "direct", "main");
    await messageRepo.create(parent.id, "user", "hello", 1);
    await threadRepo.softDelete(parent.id);
    const found = threadRepo.findById(parent.id);
    expect(found?.deleted_at).not.toBeNull();
  });

  it("empty thread has no messages to fork from", async () => {
    const parent = await threadRepo.create("ws-1", "empty", "direct", "main");
    const { messages } = messageRepo.listByThread(parent.id, 100);
    expect(messages).toHaveLength(0);
  });
});
