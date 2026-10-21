import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { WorkspaceStore } from "../../projects/persistence/workspace-store.js";
import { ThreadStore } from "../persistence/thread-store.js";
import { DelegatedTaskStore, type ClaimTaskInput } from "./delegated-task-store.js";

const databases: ReturnType<typeof openMemoryDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(true); });

describe("delegated task receipts", () => {
  it("claims once per Coordinator and rejects a changed input without replacing the pinned plan", () => {
    const db = openMemoryDatabase();
    databases.push(db);
    const workspace = new WorkspaceStore(db).create("Fixture", "/fixture");
    const threads = new ThreadStore(db);
    const coordinator = threads.create(workspace.id, "Coordinator", "direct", "main");
    const other = threads.create(workspace.id, "Other", "direct", "main");
    const store = new DelegatedTaskStore(db);
    const input: ClaimTaskInput = {
      coordinatorThreadId: coordinator.id, clientRequestId: "review-1", inputFingerprint: "first",
      plan: { workspaceId: workspace.id, title: "Review", prompt: "Find bugs", providerId: "codex", modelId: "gpt-test",
        permissionMode: "full", coordinatorPermissionMode: "full", checkout: { kind: "new_worktree", commit: "a".repeat(40), baseBranch: "main" },
        messageId: "00000000-0000-4000-8000-000000000001", creatorTurnId: "creator", creatorToolCallId: "call", creatorProviderId: "claude", userId: "user" },
    };
    const first = store.claim(input);
    if (first.kind !== "claimed") throw new Error("Expected first claim");
    expect(store.claim({ ...input, plan: { ...input.plan, checkout: { kind: "direct", branch: "changed" } } }))
      .toEqual({ kind: "existing", task: first.task });
    expect(store.claim({ ...input, inputFingerprint: "changed" })).toEqual({ kind: "conflict" });
    const separate = store.claim({ ...input, coordinatorThreadId: other.id });
    if (separate.kind !== "claimed") throw new Error("Expected separate claim");
    expect(separate.task.taskId).not.toBe(first.task.taskId);
    expect(store.find(first.task.taskId, other.id)).toBeNull();
    expect(store.find("unknown", coordinator.id)).toBeNull();
  });
});
