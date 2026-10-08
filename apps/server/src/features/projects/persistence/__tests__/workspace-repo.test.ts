import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceService } from "../../index.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { FakeGitExecutor } from "../../git/execution/fake-git-executor.js";

let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;

describe("WorkspaceRepo", () => {
  let db: Database;
  let repo: WorkspaceRepo;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    repo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  });

  it("hardDelete() deletes the workspace row", async () => {
    const ws = (await repo.create("test", "/tmp/test"));
    expect(repo.findById(ws.id)).not.toBeNull();

    const deleted = (await repo.hardDelete(ws.id));

    expect(deleted).toBe(true);
    expect(repo.findById(ws.id)).toBeNull();
  });

  it("hardDelete() cascade-deletes associated threads", async () => {
    const ws = (await repo.create("test", "/tmp/test"));
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-1", ws.id, "Thread 1", "main", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-2", ws.id, "Thread 2", "main", now, now);

    (await repo.hardDelete(ws.id));

    const threads = db
      .prepare("SELECT id FROM threads WHERE workspace_id = ?")
      .all(ws.id) as { id: string }[];
    expect(threads).toHaveLength(0);
  });

  it("hardDelete() cascade-deletes messages through threads", async () => {
    const ws = (await repo.create("test", "/tmp/test"));
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-1", ws.id, "Thread", "main", now, now);
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("m-1", "t-1", "user", "hello", now, 1);

    (await repo.hardDelete(ws.id));

    const messages = db
      .prepare("SELECT id FROM messages WHERE thread_id = ?")
      .all("t-1") as { id: string }[];
    expect(messages).toHaveLength(0);
  });

  it("hardDelete() returns false for non-existent ID", async () => {
    expect((await repo.hardDelete("non-existent"))).toBe(false);
  });

  it("create() allows re-using a path after the previous workspace was deleted", async () => {
    const ws1 = (await repo.create("test", "/tmp/reuse"));
    (await repo.hardDelete(ws1.id));

    const ws2 = (await repo.create("test-2", "/tmp/reuse"));

    expect(ws2.id).not.toBe(ws1.id);
    expect(ws2.path).toBe("/tmp/reuse");
  });
});

describe("WorkspaceService", () => {
  let repo: WorkspaceRepo;
  let service: WorkspaceService;

  beforeEach(() => {
    persistenceRuntime = createThreadPersistenceTestRuntime();
    repo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    const threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    const mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    service = new WorkspaceService(
      repo,
      threadRepo,
      persistenceRuntime.writer,
      mockAttachmentService,
      {
        teardownThread: vi.fn().mockResolvedValue(undefined),
        deletePersistentData: async <Result>(_ids: readonly string[], remove: () => Promise<Result>): Promise<Result> => remove(),
      },
      new FakeGitExecutor(),
      { killByThread: vi.fn().mockResolvedValue(undefined) },
    );
  });

  it("create() returns existing workspace when path already exists", async () => {
    const ws1 = await service.create("project-a", "/tmp/existing");
    await service.create("other", "/tmp/other");

    const ws2 = await service.create("project-a-renamed", "/tmp/existing");

    expect(ws2.id).toBe(ws1.id);
    expect(ws2.name).toBe("project-a");
    expect(repo.listAll()[0]!.id).toBe(ws1.id);
  });

  it("create() creates a new workspace when path does not exist", async () => {
    const ws = await service.create("new-project", "/tmp/new");
    expect(ws.name).toBe("new-project");
    expect(ws.path).toBe("/tmp/new");
  });
});
