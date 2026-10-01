import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { expect, it } from "vitest";
import { openDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { listWorkspaceThreads } from "../workspace-thread-rpc.js";

it("lists persisted sidebar threads while a WAL writer is held without changing workspace recency", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-thread-read-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  const db = openDatabase({ dbPath });
  const held = new Database(dbPath);
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.create("Fixture", directory, true);
    const now = "2026-09-30T10:00:00.000Z";
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("thread", workspace.id, "Thread", "main", "codex", now, now);
    const threadRepo = new ThreadRepo(db);
    held.run("BEGIN IMMEDIATE");
    const result = listWorkspaceThreads({ workspaceService: { findById: (id) => workspaceRepo.findById(id) },
      threadService: { list: (id) => threadRepo.listByWorkspace(id) }, gitWatcherService: { retryWatch: () => {} } },
    { workspaceId: workspace.id });
    expect(result.map((thread) => thread.id)).toEqual(["thread"]);
    expect(workspaceRepo.findById(workspace.id)?.updated_at).toBe(workspace.updated_at);
  } finally {
    if (held.inTransaction) held.run("ROLLBACK");
    held.close(true);
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
