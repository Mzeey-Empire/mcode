import "reflect-metadata";
import * as NodeFS from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadStore as ThreadRepo } from "../thread-store.js";
import type { Database } from "bun:sqlite";

describe("ThreadRepo lineage", () => {
  let db: Database;
  let repo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ThreadRepo(db);
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
  });

  it("creates a thread without lineage by default", () => {
    const thread = repo.create("ws-1", "root thread", "direct", "main");
    expect(thread.parent_thread_id).toBeNull();
    expect(thread.forked_from_message_id).toBeNull();
  });

  it("creates a thread with lineage fields", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    const child = repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-123",
    });
    expect(child.parent_thread_id).toBe(parent.id);
    expect(child.forked_from_message_id).toBe("msg-123");
  });

  it("persists and reads back lineage fields", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    const child = repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-456",
    });
    const found = repo.findById(child.id);
    expect(found?.parent_thread_id).toBe(parent.id);
    expect(found?.forked_from_message_id).toBe("msg-456");
  });

  it("lists threads including lineage fields", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-789",
    });
    const threads = repo.listByWorkspace("ws-1");
    const child = threads.find((t) => t.title === "child");
    expect(child?.parent_thread_id).toBe(parent.id);
  });

  it("soft-deleting parent does not delete child", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    const child = repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-abc",
    });
    repo.softDelete(parent.id);
    const found = repo.findById(child.id);
    expect(found).not.toBeNull();
    expect(found?.parent_thread_id).toBe(parent.id);
  });

  it("updateLineage sets lineage on existing thread", () => {
    const thread = repo.create("ws-1", "existing", "direct", "main");
    expect(thread.parent_thread_id).toBeNull();

    const updated = repo.updateLineage(thread.id, "parent-id", "msg-999");
    expect(updated).toBe(true);

    const found = repo.findById(thread.id);
    expect(found?.parent_thread_id).toBe("parent-id");
    expect(found?.forked_from_message_id).toBe("msg-999");
  });

  it("clears cross-workspace delegation lineage when the coordinator is deleted", () => {
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-2", "other", "/tmp/other");
    const coordinator = repo.create("ws-1", "coordinator", "direct", "main");
    const child = repo.create("ws-2", "child", "direct", "main", true, "claude", { delegation: {
      coordinatorThreadId: coordinator.id,
      creatorTurnId: "turn-1",
      creatorToolCallId: "call-1",
    } });

    repo.softDelete(coordinator.id);

    const row = db.prepare("SELECT delegation_coordinator_thread_id, delegation_creator_turn_id, delegation_creator_tool_call_id, delegation_creation_kind FROM threads WHERE id = ?").get(child.id) as {
      delegation_coordinator_thread_id: string | null;
      delegation_creator_turn_id: string | null;
      delegation_creator_tool_call_id: string | null;
      delegation_creation_kind: string | null;
    };
    expect(row).toEqual({
      delegation_coordinator_thread_id: null,
      delegation_creator_turn_id: "turn-1",
      delegation_creator_tool_call_id: "call-1",
      delegation_creation_kind: "thread_delegation",
    });
  });

  it("keeps a cross-workspace child when its coordinator is hard-deleted", () => {
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-2", "other", "/tmp/other");
    const coordinator = repo.create("ws-1", "coordinator", "direct", "main");
    const child = repo.create("ws-2", "child", "direct", "main", true, "claude", { delegation: {
      coordinatorThreadId: coordinator.id,
      creatorTurnId: "turn-1",
      creatorToolCallId: "call-1",
    } });

    expect(repo.hardDelete(coordinator.id)).toBe(true);

    expect(db.prepare("SELECT delegation_coordinator_thread_id FROM threads WHERE id = ?").get(child.id)).toEqual({
      delegation_coordinator_thread_id: null,
    });
  });
  it("hides delegated children from lists, search and counts while keeping identity reads", () => {
    const coordinator = repo.create("ws-1", "coordinator", "direct", "main");
    const child = repo.create("ws-1", "delegated", "direct", "main", true, "codex", { delegation: {
      coordinatorThreadId: coordinator.id, creatorTurnId: "turn", creatorToolCallId: "request",
    } });
    expect(repo.findById(child.id)?.delegation_coordinator_thread_id).toBe(coordinator.id);
    expect(repo.listByWorkspace("ws-1").map((thread) => thread.id)).toEqual([coordinator.id]);
    expect(repo.listRecent().map((thread) => thread.id)).toEqual([coordinator.id]);
    expect(repo.search({ query: "delegated" })).toEqual({ threads: [], workspaces: [] });
    expect(repo.countActiveByWorkspaceIds(["ws-1"]).get("ws-1")).toBe(1);
    expect(repo.countActiveByBranch(coordinator.id, "main")).toBe(0);
    repo.updateExternalCreator(coordinator.id, "integration");
    repo.updateExternalCreator(child.id, "integration");
    expect(repo.countActiveByIntegration("integration")).toBe(1);
  });

  it("keeps legacy batch threads visible after migration without losing audit provenance", () => {
    const coordinator = repo.create("ws-1", "coordinator", "direct", "main");
    const child = repo.create("ws-1", "legacy", "direct", "main", true, "claude", { delegation: {
      coordinatorThreadId: coordinator.id, creatorTurnId: "legacy-turn", creatorToolCallId: "legacy-call",
    } });
    db.exec(NodeFS.readFileSync(new URL("../../../../../drizzle/0095_worried_anthem.sql", import.meta.url), "utf8"));
    expect(repo.listByWorkspace("ws-1").map((thread) => thread.title).sort()).toEqual(["coordinator", "legacy"]);
    expect(repo.search({ query: "legacy" }).threads.map((thread) => thread.id)).toEqual([child.id]);
    expect(repo.countActiveByWorkspaceIds(["ws-1"]).get("ws-1")).toBe(2);
    expect(db.prepare("SELECT delegation_creator_turn_id, delegation_creator_tool_call_id, delegation_creation_kind FROM threads WHERE id = ?").get(child.id))
      .toEqual({ delegation_creator_turn_id: "legacy-turn", delegation_creator_tool_call_id: "legacy-call", delegation_creation_kind: "thread_delegation" });
  });
});
