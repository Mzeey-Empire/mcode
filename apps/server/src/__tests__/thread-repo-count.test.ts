/**
 * Tests for ThreadRepo.countActiveByWorkspaceIds added in the modern project selector feature.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";

describe("ThreadRepo.countActiveByWorkspaceIds", () => {
  let db: Database.Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(db);
    threadRepo = new ThreadRepo(db);
  });

  it("returns counts keyed by workspace id, omitting soft-deleted threads", () => {
    const ws1 = workspaceRepo.create("a", "/a", true);
    const ws2 = workspaceRepo.create("b", "/b", true);

    // Create 2 active threads in ws1
    threadRepo.create(ws1.id, "Thread 1", "direct", "main");
    threadRepo.create(ws1.id, "Thread 2", "direct", "main");

    // Create 1 soft-deleted thread in ws2, plus 1 active
    const archived = threadRepo.create(ws2.id, "Archived", "direct", "main");
    threadRepo.softDelete(archived.id);
    threadRepo.create(ws2.id, "Active", "direct", "main");

    const counts = threadRepo.countActiveByWorkspaceIds([ws1.id, ws2.id, "nonexistent-id"]);
    expect(counts.get(ws1.id)).toBe(2);
    expect(counts.get(ws2.id)).toBe(1);
    expect(counts.get("nonexistent-id")).toBeUndefined();
  });

  it("returns empty map for empty input", () => {
    const counts = threadRepo.countActiveByWorkspaceIds([]);
    expect(counts.size).toBe(0);
  });

  it("omits workspace ids with no active threads from the result", () => {
    const ws = workspaceRepo.create("a", "/a", true);
    const thread = threadRepo.create(ws.id, "T", "direct", "main");
    threadRepo.softDelete(thread.id);

    const counts = threadRepo.countActiveByWorkspaceIds([ws.id]);
    expect(counts.get(ws.id)).toBeUndefined();
  });
});
