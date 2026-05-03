/**
 * Regression: legacy sibling DBs may already have workspaces.sort_order while
 * this timestamp migration is still pending. up() must not ALTER ADD the column twice.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { up } from "../store/migrations/20260501120000_workspace_sort_order.js";

describe("migration 20260501120000: workspace_sort_order", () => {
  it("up() does not fail when sort_order already exists", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        provider_config TEXT NOT NULL DEFAULT '{}',
        is_git_repo INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO workspaces (id, name, path, created_at, updated_at, pinned, last_opened_at, sort_order)
      VALUES
        ('id-a', 'a', '/a', '2020-01-01', '2020-01-01', 0, NULL, 0),
        ('id-b', 'b', '/b', '2020-01-01', '2020-01-01', 0, 1000, 0);
    `);

    expect(() => up(db)).not.toThrow();

    const orders = db
      .prepare("SELECT sort_order FROM workspaces ORDER BY id")
      .all() as Array<{ sort_order: number }>;
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((r) => r.sort_order)).size).toBe(2);
  });

  it("up() does not overwrite existing distinct sort_order values", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        provider_config TEXT NOT NULL DEFAULT '{}',
        is_git_repo INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO workspaces (id, name, path, created_at, updated_at, pinned, last_opened_at, sort_order)
      VALUES
        ('id-a', 'a', '/a', '2020-01-01', '2020-01-01', 0, NULL, 3),
        ('id-b', 'b', '/b', '2020-01-01', '2020-01-01', 0, 1000, 7);
    `);

    expect(() => up(db)).not.toThrow();

    const orders = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY id")
      .all() as Array<{ id: string; sort_order: number }>;
    expect(orders).toEqual([
      { id: "id-a", sort_order: 3 },
      { id: "id-b", sort_order: 7 },
    ]);
  });
});
