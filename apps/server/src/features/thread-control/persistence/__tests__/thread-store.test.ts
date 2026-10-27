import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceStore } from "../../../projects/persistence/workspace-store.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import * as push from "../../../../application/transport/push.js";
import { ThreadRepo } from "../thread-repo.js";
import { ThreadStore } from "../thread-store.js";

afterEach(() => vi.restoreAllMocks());

describe("whole thread index", () => {
  it("reads a legacy-only PR as unresolved regardless of its legacy status", () => {
    const db = openMemoryDatabase();
    try {
      const workspace = new WorkspaceStore(db).create("Legacy", "/legacy");
      const threads = new ThreadStore(db);
      const thread = threads.create(workspace.id, "Legacy PR", "worktree", "feature");
      db.query("UPDATE threads SET pr_number = ?, pr_status = ? WHERE id = ?").run(42, "MERGED", thread.id);
      expect(threads.findById(thread.id)?.pull_requests).toEqual([
        { number: 42, state: "unresolved", title: null, url: null },
      ]);
      expect(threads.listAll()[0]?.pull_requests).toEqual([
        { number: 42, state: "unresolved", title: null, url: null },
      ]);
    } finally {
      db.close(true);
    }
  });

  it("includes a 101st thread and threads in another workspace", () => {
    const db = openMemoryDatabase();
    try {
      const workspaces = new WorkspaceStore(db);
      const first = workspaces.create("First", "/first");
      const second = workspaces.create("Second", "/second");
      const threads = new ThreadStore(db);
      const expected = Array.from({ length: 101 }, (_, index) => threads.create(first.id, `Thread ${index}`, "direct", "main").id);
      expected.push(threads.create(second.id, "Other project", "direct", "main").id);
      expect(threads.listAll().map((thread) => thread.id).sort()).toEqual(expected.sort());
    } finally {
      db.close(true);
    }
  });

  it("excludes deleted and delegated threads while retaining completed threads and forks", () => {
    const db = openMemoryDatabase();
    try {
      const workspace = new WorkspaceStore(db).create("Index", "/fixture");
      const threads = new ThreadStore(db);
      const root = threads.create(workspace.id, "Root", "direct", "main");
      const fork = threads.create(workspace.id, "Fork", "direct", "main", false, "claude", { parentThreadId: root.id });
      threads.complete(root.id, "2030-01-01T00:00:00.000Z", null);
      threads.create(workspace.id, "Delegated", "direct", "main", false, "claude", {
        delegation: { coordinatorThreadId: root.id, creatorTurnId: "turn", creatorToolCallId: "tool" },
      });
      const removed = threads.create(workspace.id, "Deleted", "direct", "main");
      threads.softDelete(removed.id);
      expect(threads.listAll().map((thread) => thread.id).sort()).toEqual([root.id, fork.id].sort());
    } finally {
      db.close(true);
    }
  });

  it("pushes a server-created thread only after it is readable from the committed index", async () => {
    const runtime = createThreadPersistenceTestRuntime();
    const threads = new ThreadRepo(runtime.reader, runtime.writer);
    const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Index", "/fixture");
    const committedIds: string[] = [];
    vi.spyOn(push, "broadcast").mockImplementation((channel) => {
      if (channel === "thread.created") committedIds.push(...threads.listAll().map((thread) => thread.id));
    });
    const created = await threads.create(workspace.id, "Created elsewhere", "direct", "main");
    expect(committedIds).toEqual([created.id]);
  });
});
