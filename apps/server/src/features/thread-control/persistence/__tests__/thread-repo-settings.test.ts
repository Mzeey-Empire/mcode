import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../thread-repo.js";
import type { Database } from "bun:sqlite";

describe("ThreadRepo.updateSettings", () => {
  let db: Database;
  let repo: ThreadRepo;
  let threadId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ThreadRepo(db);
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
    const thread = repo.create("ws-1", "test thread", "direct", "main");
    threadId = thread.id;
  });

  it("persists reasoning, interaction, orchestration, and permission settings", () => {
    const ok = repo.updateSettings(threadId, {
      reasoning_level: "high",
      interaction_mode: "plan",
      orchestration_mode: "proactive",
      permission_mode: "supervised",
    });
    expect(ok).toBe(true);

    const thread = repo.findById(threadId);
    expect(thread?.reasoning_level).toBe("high");
    expect(thread?.interaction_mode).toBe("plan");
    expect(thread?.orchestration_mode).toBe("proactive");
    expect(thread?.permission_mode).toBe("supervised");
  });

  it("allows partial updates (only reasoning_level)", () => {
    repo.updateSettings(threadId, { reasoning_level: "max" });
    const thread = repo.findById(threadId);
    expect(thread?.reasoning_level).toBe("max");
    expect(thread?.interaction_mode).toBeNull();
    expect(thread?.orchestration_mode).toBeNull();
    expect(thread?.permission_mode).toBeNull();
  });

  it("persists model, provider, and supplied settings together while retaining omitted values", () => {
    repo.updateSettings(threadId, { reasoning_level: "high", thinking: true, codex_fast_mode: true });

    expect(repo.updateSettings(threadId, {
      model: "gpt-5.6-luna",
      provider: "codex",
      permission_mode: "full",
      thinking: false,
      codex_fast_mode: null,
    })).toBe(true);

    expect(repo.findById(threadId)).toMatchObject({
      model: "gpt-5.6-luna",
      provider: "codex",
      permission_mode: "full",
      reasoning_level: "high",
      thinking: false,
      codex_fast_mode: null,
    });
    repo.updateSettings(threadId, { model: "gpt-5.6-sol" });
    expect(repo.findById(threadId)).toMatchObject({ model: "gpt-5.6-sol", provider: "codex", permission_mode: "full" });
  });

  it("leaves all thread settings unchanged when the combined update fails", () => {
    repo.updateSettings(threadId, { model: "original-model", provider: "claude", permission_mode: "supervised" });
    const before = repo.findById(threadId);
    db.exec(`
      CREATE TRIGGER reject_full_permission BEFORE UPDATE OF permission_mode ON threads
      WHEN NEW.permission_mode = 'full'
      BEGIN
        SELECT RAISE(ABORT, 'permission update rejected');
      END;
    `);

    expect(() => repo.updateSettings(threadId, {
      model: "gpt-5.6-luna", provider: "codex", permission_mode: "full",
    })).toThrow("permission update rejected");

    expect(repo.findById(threadId)).toEqual(before);
  });

  it("retains the timestamp when no settings are supplied", () => {
    const before = repo.findById(threadId);
    expect(repo.updateSettings(threadId, {})).toBe(false);
    expect(repo.findById(threadId)).toEqual(before);
  });

  it("returns false for nonexistent thread", () => {
    const ok = repo.updateSettings("nonexistent", { reasoning_level: "low" });
    expect(ok).toBe(false);
  });

  it("new threads have null settings columns by default", () => {
    const thread = repo.findById(threadId);
    expect(thread?.reasoning_level).toBeNull();
    expect(thread?.interaction_mode).toBeNull();
    expect(thread?.orchestration_mode).toBeNull();
    expect(thread?.permission_mode).toBeNull();
  });

  it("normalizes legacy orchestration-shaped reasoning values to max", () => {
    db.prepare("UPDATE threads SET reasoning_level = ? WHERE id = ?").run("ultrathink", threadId);
    expect(repo.findById(threadId)?.reasoning_level).toBe("max");

    db.prepare("UPDATE threads SET reasoning_level = ? WHERE id = ?").run("ultra", threadId);
    expect(repo.findById(threadId)?.reasoning_level).toBe("max");
  });
});
