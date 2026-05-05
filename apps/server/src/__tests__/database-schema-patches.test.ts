/**
 * Tests for applySchemaPatches - the post-migration column guard that fixes
 * databases created before sort_order was added to the workspaces table.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applySchemaPatches } from "../store/database.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("applySchemaPatches", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  it("adds sort_order to workspaces when the column is missing (old DB scenario)", () => {
    // Simulate a database created before sort_order was added to the schema
    db.prepare(
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
    ).run();

    expect(columnNames(db, "workspaces")).not.toContain("sort_order");

    applySchemaPatches(db);

    expect(columnNames(db, "workspaces")).toContain("sort_order");
  });

  it("defaults sort_order to 0 for existing rows after the patch", () => {
    db.prepare(
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)",
    ).run();
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run(
      "ws-1",
      "My Workspace",
      "/home/user/project",
    );

    applySchemaPatches(db);

    const row = db
      .prepare("SELECT sort_order FROM workspaces WHERE id = ?")
      .get("ws-1") as { sort_order: number };
    expect(row.sort_order).toBe(0);
  });

  it("is a no-op when sort_order already exists (fresh DB / already patched)", () => {
    db.prepare(
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0 NOT NULL)",
    ).run();
    db.prepare("INSERT INTO workspaces (id, name, sort_order) VALUES (?, ?, ?)").run(
      "ws-1",
      "Existing",
      42,
    );

    applySchemaPatches(db);

    const row = db
      .prepare("SELECT sort_order FROM workspaces WHERE id = ?")
      .get("ws-1") as { sort_order: number };
    // Value must be preserved - no column was dropped or reset
    expect(row.sort_order).toBe(42);
  });

  it("does not throw when the workspaces table does not exist", () => {
    // Completely empty DB - applySchemaPatches must not crash
    expect(() => applySchemaPatches(db)).not.toThrow();
  });
});
