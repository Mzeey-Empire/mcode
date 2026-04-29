/**
 * Tests for WorkspaceRepo pin/recency methods added in the modern project selector feature.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";

describe("WorkspaceRepo pinning + recency", () => {
  let db: Database.Database;
  let repo: WorkspaceRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new WorkspaceRepo(db);
  });

  it("setPinned toggles pinned flag", () => {
    const ws = repo.create("a", "/a", true);
    repo.setPinned(ws.id, true);
    expect(repo.findById(ws.id)!.pinned).toBe(true);
    repo.setPinned(ws.id, false);
    expect(repo.findById(ws.id)!.pinned).toBe(false);
  });

  it("touchLastOpened bumps last_opened_at without changing updated_at", () => {
    const ws = repo.create("a", "/a", true);
    const before = repo.findById(ws.id)!;
    repo.touchLastOpened(ws.id);
    const after = repo.findById(ws.id)!;
    expect(after.last_opened_at).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("removeRecent clears last_opened_at and unpins", () => {
    const ws = repo.create("a", "/a", true);
    repo.touchLastOpened(ws.id);
    repo.setPinned(ws.id, true);
    repo.removeRecent(ws.id);
    const after = repo.findById(ws.id)!;
    expect(after.last_opened_at).toBeNull();
    expect(after.pinned).toBe(false);
  });

  it("listAll orders pinned first, then last_opened_at DESC, excludes workspaces never opened", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    const c = repo.create("c", "/c", true);
    const d = repo.create("d", "/d", true); // never opened

    // Stub Date.now so each touchLastOpened gets a strictly-increasing timestamp.
    // Without this, three rapid Date.now() calls inside the same ms tick can
    // produce equal values and the "DESC by last_opened_at" ordering becomes
    // ambiguous, making this test flaky on fast hardware.
    let tick = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => ++tick);

    try {
      // Open in order: b, then c, then a (so a is most recent)
      repo.touchLastOpened(b.id);
      repo.touchLastOpened(c.id);
      repo.touchLastOpened(a.id);
      repo.setPinned(b.id, true); // b is pinned

      const list = repo.listAll();
      expect(list.map((w) => w.name)).toEqual(["b", "a", "c"]);
      expect(list.find((w) => w.id === d.id)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
