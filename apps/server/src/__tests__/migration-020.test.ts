import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { up as up020, down as down020 } from "../store/migrations/020_workspace_pinned_and_last_opened.js";

describe("migration 020: workspace_pinned_and_last_opened", () => {
  function makeDb() {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        provider_config TEXT,
        is_git_repo INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO workspaces (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("ws1", "/tmp/a", 100, 200);
    return db;
  }

  it("adds pinned (default 0) column", () => {
    const db = makeDb();
    up020(db);
    const row = db.prepare("SELECT pinned FROM workspaces WHERE name = 'ws1'").get() as { pinned: number };
    expect(row.pinned).toBe(0);
  });

  it("adds last_opened_at, backfilled from updated_at", () => {
    const db = makeDb();
    up020(db);
    const row = db.prepare("SELECT last_opened_at FROM workspaces WHERE name = 'ws1'").get() as { last_opened_at: number };
    expect(row.last_opened_at).toBe(200);
  });

  it("down() removes the columns", () => {
    const db = makeDb();
    up020(db);
    down020(db);
    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).not.toContain("pinned");
    expect(names).not.toContain("last_opened_at");
  });
});
