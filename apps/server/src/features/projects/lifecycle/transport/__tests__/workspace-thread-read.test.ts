import "reflect-metadata";
import { Database } from "bun:sqlite";
import { expect, it } from "vitest";
import { openReadOnlyDatabase } from "../../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase } from "../../../testing/owned-test-database.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { listWorkspaceThreads } from "../workspace-thread-rpc.js";

it("lists persisted sidebar threads while a WAL writer is held without changing workspace recency", async () => {
  const owned = createOwnedTestDatabase();
  const db = openReadOnlyDatabase(owned.db.filename);
  const held = new Database(owned.db.filename);
  try {
    const workspaceRepo = new WorkspaceRepo(db, owned.writer);
    const workspace = await workspaceRepo.create("Fixture", "/fixture", true);
    const now = "2026-09-30T10:00:00.000Z";
    owned.db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("thread", workspace.id, "Thread", "main", "codex", now, now);
    const threadRepo = new ThreadRepo(db, owned.writer);
    held.run("BEGIN IMMEDIATE");
    const result = listWorkspaceThreads({ workspaceService: { findById: (id) => workspaceRepo.findById(id) },
      threadService: { list: (id) => threadRepo.listByWorkspace(id) }, gitWatcherService: { retryWatch: async () => false } },
    { workspaceId: workspace.id });
    expect(result.map((thread) => thread.id)).toEqual(["thread"]);
    expect(workspaceRepo.findById(workspace.id)?.updated_at).toBe(workspace.updated_at);
  } finally {
    if (held.inTransaction) held.run("ROLLBACK");
    held.close(true);
    db.close(true);
    await owned.close();
  }
});
