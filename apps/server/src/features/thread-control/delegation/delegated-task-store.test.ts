import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { WorkspaceStore } from "../../projects/persistence/workspace-store.js";
import { ThreadStore } from "../persistence/thread-store.js";
import { DelegatedTaskStore, type ClaimTaskInput } from "./delegated-task-store.js";

const databases: ReturnType<typeof openMemoryDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(true); });

function fixture() {
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
  return { db, workspace, coordinator, other, store, input };
}

describe("delegated task receipts", () => {
  it("claims once per Coordinator and rejects a changed input without replacing the pinned plan", () => {
    const { coordinator, other, store, input } = fixture();
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

  it("keeps live candidates and excludes durable terminal receipts, respecting the Coordinator filter", () => {
    const { db, workspace, coordinator, other, store, input } = fixture();
    const claim = (clientRequestId: string, coordinatorThreadId = coordinator.id) => {
      const result = store.claim({ ...input, clientRequestId, coordinatorThreadId });
      if (result.kind !== "claimed") throw new Error("Expected task claim");
      return result.task.taskId;
    };
    const live = claim("live");
    const otherLive = claim("other-live", other.id);
    const completed = claim("completed");
    const failed = claim("failed-startup");
    const rejected = claim("rejected-approval");
    db.query(`INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, ?, ?, 'codex', 'idle', '2026-10-21', '2026-10-21')`).run(coordinator.id, workspace.id, coordinator.id);
    db.query(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
      VALUES (?, ?, ?, 'Completed', '{}', 'full', '2026-10-21', '2026-10-21')`).run(completed, coordinator.id, completed);
    db.query(`INSERT INTO thread_startups (startup_id, workspace_id, kind, state, phase, steps_json, transcript_json, revision)
      VALUES (?, ?, 'create', 'failed', 'agent', '[]', '[]', 1)`).run(failed, workspace.id);
    db.query(`INSERT INTO thread_control_approvals
      (id, thread_id, workspace_id, prompt, execution_json, placement_json, turn_id, status)
      VALUES (?, ?, ?, '', '{}', '{}', 'creator', 'rejected')`).run(rejected, coordinator.id, workspace.id);

    expect(store.listUnfinishedCandidates().map((task) => task.taskId).sort()).toEqual([live, otherLive].sort());
    expect(store.listUnfinishedCandidates(coordinator.id).map((task) => task.taskId)).toEqual([live]);
    expect(store.listUnfinishedCandidates(other.id).map((task) => task.taskId)).toEqual([otherLive]);
  });
});
