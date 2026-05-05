import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { ThreadRepo } from "../repositories/thread-repo";

describe("WorkspaceRepo - soft/hard delete", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
  });

  it("softDelete sets deleted_at and returns true", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    const result = workspaceRepo.softDelete(ws.id);
    expect(result).toBe(true);

    // Direct DB check - row still exists but has deleted_at set
    const row = db.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").get(ws.id) as any;
    expect(row.deleted_at).not.toBeNull();
  });

  it("softDelete returns false for non-existent workspace", () => {
    const result = workspaceRepo.softDelete("non-existent-id");
    expect(result).toBe(false);
  });

  it("listAll excludes soft-deleted workspaces", () => {
    const ws1 = workspaceRepo.create("Active", "/tmp/active");
    const ws2 = workspaceRepo.create("Deleted", "/tmp/deleted");
    workspaceRepo.softDelete(ws2.id);

    const list = workspaceRepo.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ws1.id);
  });

  it("findById returns null for soft-deleted workspace", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    workspaceRepo.softDelete(ws.id);
    expect(workspaceRepo.findById(ws.id)).toBeNull();
  });

  it("findByPath returns null for soft-deleted workspace", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    workspaceRepo.softDelete(ws.id);
    expect(workspaceRepo.findByPath("/tmp/test-ws")).toBeNull();
  });

  it("findDeletingWorkspaces returns only soft-deleted workspaces", () => {
    const ws1 = workspaceRepo.create("Active", "/tmp/active");
    const ws2 = workspaceRepo.create("Deleting", "/tmp/deleting");
    workspaceRepo.softDelete(ws2.id);

    const deleting = workspaceRepo.findDeleting();
    expect(deleting).toHaveLength(1);
    expect(deleting[0].id).toBe(ws2.id);
  });

  it("hardDelete permanently removes the workspace row", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    workspaceRepo.softDelete(ws.id);
    const result = workspaceRepo.hardDelete(ws.id);
    expect(result).toBe(true);

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeUndefined();
  });

  it("hardDelete cascades to all threads (active and soft-deleted)", () => {
    const ws = workspaceRepo.create("Test", "/tmp/test-ws");
    threadRepo.create(ws.id, "Thread 1", "direct", "main");
    const t2 = threadRepo.create(ws.id, "Thread 2", "worktree", "feat/x");
    threadRepo.softDelete(t2.id);

    workspaceRepo.hardDelete(ws.id);

    const threads = db.prepare("SELECT id FROM threads WHERE workspace_id = ?").all(ws.id);
    expect(threads).toHaveLength(0);
  });
});
