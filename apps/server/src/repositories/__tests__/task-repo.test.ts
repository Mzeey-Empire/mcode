import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database.js";
import { TaskRepo, type StoredTask } from "../task-repo.js";

/**
 * The repo serializes tasks via JSON.stringify, so coverage focuses on the
 * `StoredTask.status` contract: ensure the four statuses (including the newly
 * accepted `cancelled`) round-trip without lossy coercion to `pending`.
 */
describe("TaskRepo", () => {
  let db: Database.Database;
  let repo: TaskRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    repo = container.resolve(TaskRepo);
  });

  it("round-trips cancelled status without coercion", () => {
    const tasks: StoredTask[] = [
      { content: "abandoned step", status: "cancelled" },
      { content: "still in progress", status: "in_progress" },
    ];
    repo.upsert("thread-1", tasks);
    expect(repo.get("thread-1")).toEqual(tasks);
  });

  it("returns null for an unknown thread", () => {
    expect(repo.get("missing")).toBeNull();
  });

  it("upsert overwrites prior tasks for the same thread", () => {
    repo.upsert("thread-2", [{ content: "old", status: "pending" }]);
    repo.upsert("thread-2", [{ content: "new", status: "completed" }]);
    expect(repo.get("thread-2")).toEqual([
      { content: "new", status: "completed" },
    ]);
  });

  it("delete removes the row", () => {
    repo.upsert("thread-3", [{ content: "x", status: "pending" }]);
    repo.delete("thread-3");
    expect(repo.get("thread-3")).toBeNull();
  });
});
