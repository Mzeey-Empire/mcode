/**
 * Tests for workspaces.sort_order: listing, creation prepend, and reorder transactions.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";

describe("WorkspaceRepo sort_order", () => {
  let db: Database.Database;
  let repo: WorkspaceRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new WorkspaceRepo(db);
  });

  it("listAll returns every workspace ordered by sort_order ascending", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    repo.touchLastOpened(a.id);
    // never opened b still appears
    const list = repo.listAll();
    expect(list).toHaveLength(2);
    expect(list[0]!.sort_order).toBe(0);
    expect(list[1]!.sort_order).toBe(1);
    expect(list.map((w) => w.name)).toEqual(["b", "a"]);
  });

  it("create shifts existing rows down and places the new workspace at sort_order 0", () => {
    repo.create("first", "/1", true);
    repo.create("second", "/2", true);
    const list = repo.listAll();
    expect(list.map((w) => w.name)).toEqual(["second", "first"]);
    expect(list.map((w) => w.sort_order)).toEqual([0, 1]);
  });

  it("reorderToIndex moves an item up with a range increment", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    const c = repo.create("c", "/c", true);
    expect(repo.listAll().map((w) => w.name)).toEqual(["c", "b", "a"]);
    repo.reorderToIndex(a.id, 0);
    expect(repo.listAll().map((w) => w.name)).toEqual(["a", "c", "b"]);
  });

  it("reorderToIndex moves an item down with a range decrement", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    const c = repo.create("c", "/c", true);
    repo.reorderToIndex(c.id, 2);
    expect(repo.listAll().map((w) => w.name)).toEqual(["b", "a", "c"]);
  });

  it("prependToSortOrder moves a workspace to the top without duplicates", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    repo.prependToSortOrder(a.id);
    const list = repo.listAll();
    expect(list.map((w) => w.name)).toEqual(["a", "b"]);
    const orders = list.map((w) => w.sort_order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("prependToSortOrder is a no-op when the workspace is already first", () => {
    const a = repo.create("a", "/a", true);
    const b = repo.create("b", "/b", true);
    repo.prependToSortOrder(b.id);
    const before = repo.listAll().map((w) => ({ id: w.id, sort_order: w.sort_order }));
    repo.prependToSortOrder(b.id);
    const after = repo.listAll().map((w) => ({ id: w.id, sort_order: w.sort_order }));
    expect(after).toEqual(before);
  });

  it("prependToSortOrder ignores unknown ids without shifting other rows", () => {
    repo.create("a", "/a", true);
    const before = repo.listAll().map((w) => w.sort_order);
    repo.prependToSortOrder("nonexistent-id");
    const after = repo.listAll().map((w) => w.sort_order);
    expect(after).toEqual(before);
  });
});
