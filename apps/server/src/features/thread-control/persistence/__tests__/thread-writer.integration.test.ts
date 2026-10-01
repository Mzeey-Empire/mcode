import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadControlApprovalRepo } from "../../authority/persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../../authority/persistence/thread-control-audit-repo.js";
import { CleanupJobRepo } from "../../cleanup/persistence/cleanup-job-repo.js";
import { ExternalThreadControlPairingService } from "../../external/external-thread-control-pairing-service.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../thread-repo.js";

function createRepositories() {
  const runtime = createThreadPersistenceTestRuntime();
  return {
    ...runtime,
    workspaces: new WorkspaceRepo(runtime.reader, runtime.writer),
    threads: new ThreadRepo(runtime.reader, runtime.writer),
    approvals: new ThreadControlApprovalRepo(runtime.reader, runtime.writer),
    audit: new ThreadControlAuditRepo(runtime.writer),
    jobs: new CleanupJobRepo(runtime.reader, runtime.writer),
    pairings: new ExternalThreadControlPairingService(runtime.reader, runtime.writer),
  };
}

describe("thread persistence through the shared SQLite writer", () => {
  it("commits complete thread operations while the main connection remains physically read-only", async () => {
    const { workspaces, threads, reader } = createRepositories();
    const workspace = await workspaces.create("Writer Project", "/writer-project");
    const root = await threads.create(workspace.id, "Root", "direct", "main");
    const child = await threads.create(workspace.id, "Child", "direct", "main", true, "codex", {
      parentThreadId: root.id, forkedFromMessageId: "origin-message",
    });
    expect(threads.findById(child.id)?.parent_thread_id).toBe(root.id);
    await threads.updateSettings(child.id, { reasoning_level: "high", codex_fast_mode: true });
    expect(threads.findById(child.id)).toMatchObject({ reasoning_level: "high", codex_fast_mode: true });
    expect(() => reader.run("DELETE FROM threads")).toThrow(/readonly/);
    expect(await threads.hardDelete(root.id)).toBe(true);
    expect(threads.findById(root.id)).toBeNull();
    expect(threads.findById(child.id)).toBeNull();
  });

  it("rolls back TEMP-queue hard deletion and lets the next unrelated audit command commit", async () => {
    const { workspaces, threads, audit, database, reader } = createRepositories();
    const workspace = await workspaces.create("Rollback Project", "/rollback-project");
    const root = await threads.create(workspace.id, "Root", "direct", "main");
    const child = await threads.create(workspace.id, "Child", "direct", "main", true, "codex", {
      parentThreadId: root.id, forkedFromMessageId: "origin-message",
    });
    database.run("CREATE TRIGGER reject_thread_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'reject thread deletion'); END");
    await expect(threads.hardDelete(root.id)).rejects.toThrow("reject thread deletion");
    await audit.write({ callerId: "test", threadId: root.id, operation: "probe", outcome: "continued" });
    expect(threads.findById(root.id)).not.toBeNull();
    expect(threads.findById(child.id)).not.toBeNull();
    expect(reader.query("SELECT outcome FROM thread_control_audit").all()).toEqual([{ outcome: "continued" }]);
  });

  it("allows exactly one concurrent approval claim before phase changes", async () => {
    const { workspaces, threads, approvals } = createRepositories();
    const workspace = await workspaces.create("Approval Project", "/approval-project");
    const thread = await threads.create(workspace.id, "Approval target", "direct", "main");
    const approvalId = await approvals.createSend({
      threadId: thread.id, workspaceId: workspace.id, message: "Continue", turnId: "test-turn", callerId: "test-caller",
      execution: { providerId: "codex", modelId: "gpt-test", permissionMode: "full", interactionMode: "build" },
    });
    const claims = await Promise.all([approvals.claim(approvalId), approvals.claim(approvalId)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await approvals.setOperationPhase(approvalId, "dispatching")).toBe(true);
    expect(await approvals.settle(approvalId, "approved")).toBe(true);
    expect(await approvals.claim(approvalId)).toBeNull();
  });

  it("rolls back a whole multi-thread cleanup closure if its later deletion fails", async () => {
    const { workspaces, threads, jobs, database } = createRepositories();
    const workspace = await workspaces.create("Cleanup Project", "/cleanup-project");
    const first = await threads.create(workspace.id, "First", "direct", "main");
    const second = await threads.create(workspace.id, "Second", "direct", "main");
    const firstJob = await jobs.insert({ thread_id: first.id, workspace_path: workspace.path, worktree_path: null, branch: "main" });
    await jobs.insert({ thread_id: second.id, workspace_path: workspace.path, worktree_path: null, branch: "main" });
    database.prepare("CREATE TRIGGER reject_second_delete BEFORE DELETE ON threads WHEN OLD.title = 'Second' BEGIN SELECT RAISE(ABORT, 'reject second deletion'); END").run();
    await expect(jobs.completeThreads(firstJob.id, [first.id, second.id])).rejects.toThrow("reject second deletion");
    expect(threads.findById(first.id)).not.toBeNull();
    expect(threads.findById(second.id)).not.toBeNull();
    expect(jobs.count()).toBe(2);
  });

  it("revalidates queued pairing authority and preserves typed rate-limit errors", async () => {
    const { pairings } = createRepositories();
    const secret = await pairings.create({ integrationId: "test-integration", workspaceIds: [], scopes: [], callsPerMinute: 1, maxActiveThreads: 1 });
    const authenticated = pairings.authenticate(secret.credential);
    await pairings.beginDelivery(authenticated, "first", "fingerprint-first");
    await expect(pairings.beginDelivery(authenticated, "second", "fingerprint-second")).rejects.toMatchObject({ name: "ExternalThreadControlPairingError", code: "rate_limited", retryAfterSeconds: 60 });
    const revocation = pairings.revoke(secret.pairingId);
    const stale = pairings.beginDelivery(authenticated, "third", "fingerprint-third");
    const rejection = expect(stale).rejects.toMatchObject({ name: "ExternalThreadControlPairingError", code: "stale_epoch" });
    await revocation;
    await rejection;
  });
});
