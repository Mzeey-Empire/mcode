import "reflect-metadata";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@mcode/contracts";
import { broadcast } from "../../../../application/transport/push.js";
import { ApprovalService } from "../../../agents/approvals/approval-service.js";
import { AgentService } from "../../../agents/orchestration/agent-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { WorktreeRepo } from "../../../projects/persistence/worktree-repo.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { GitRepositoryService } from "../../../projects/git/git-repository-service.js";
import { ProjectWorktreeService } from "../../../projects/worktrees/project-worktree-service.js";
import { ProviderRegistry } from "../../../providers/composition/provider-registry.js";
import { ModelCacheService } from "../../../providers/models/model-cache-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { threads, workspaces } from "../../../../runtime/persistence/sqlite/schema.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
import { ThreadControlApprovalRepo } from "../persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../persistence/thread-control-audit-repo.js";
import { ThreadControlService, type InternalThreadControlAuthority } from "../thread-control-service.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const authority: InternalThreadControlAuthority = {
  type: "internal", userId: "local-user", sourceThreadId: "thread-A",
  sourceTurnId: "turn-A", sourceToolCallId: "call-send", sourceProviderId: "claude",
  permissionMode: "supervised",
};

function createFixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const db = drizzle(runtime.database);
  db.insert(workspaces).values({ id: "workspace-fixture", name: "Fixture", path: ".dev/fixture-repo" }).run();
  db.insert(threads).values([
    { id: "thread-A", workspaceId: "workspace-fixture", title: "Thread A", branch: "main", model: "claude-exact" },
    { id: "thread-B", workspaceId: "workspace-fixture", title: "Thread B", branch: "main", model: "claude-exact" },
  ]).run();
  const agent = vi.mockObject(AgentService.prototype);
  agent.runtimeAccess.mockReturnValue({ activeCount: () => 0, activeThreadIds: () => [], runtimeSnapshots: () => [] });
  const approvalService = new ApprovalService({ resolveAll: () => [] });
  approvalService.start({
    publishApprovalRequest: (request) => broadcast("approval.requested", request),
    publishApprovalResolved: vi.fn(),
    stopSession: async () => {},
  });
  const models = vi.mockObject(ModelCacheService.prototype);
  models.listModels.mockResolvedValue([{ id: "claude-exact", name: "Claude fixture" }]);
  const service = new ThreadControlService(
    approvalService,
    new WorkspaceRepo(runtime.reader, runtime.writer),
    vi.mockObject(WorktreeRepo.prototype),
    vi.mockObject(GitWorktreeService.prototype),
    vi.mockObject(GitRepositoryService.prototype),
    new ThreadRepo(runtime.reader, runtime.writer),
    vi.mockObject(ProjectWorktreeService.prototype),
    agent,
    vi.mockObject(SettingsService.prototype),
    vi.mockObject(ProviderRegistry.prototype),
    models,
    new ThreadControlApprovalRepo(runtime.reader, runtime.writer),
    new ThreadControlAuditRepo(runtime.writer),
  );
  return { service, agent };
}

function approvalOwnership({ threadId, providerId, subject, choices, noteDelivery, origin }: ApprovalRequest) {
  return { threadId, providerId, subject, choices, noteDelivery, origin };
}

describe("supervised cross-thread send approval", () => {
  it("broadcasts and lists the approval on A while naming B as the target", async () => {
    const { service, agent } = createFixture();
    expect(service.listPendingApprovals("thread-A")).toEqual([]);
    expect(service.listPendingApprovals("thread-B")).toEqual([]);

    const result = await service.threadSend(authority, { threadId: "thread-B", message: "Needs approval." });

    expect(result).toMatchObject({ status: "pending_approval", workspaceId: "workspace-fixture", threadId: "thread-B" });
    const expected = [{
      threadId: "thread-A", providerId: "claude",
      subject: { kind: "thread_operation", operation: "thread_send", targetThreadId: "thread-B", message: "Needs approval." },
      choices: [{ id: "allow", intent: "allow_once", label: "Allow" }, { id: "deny", intent: "deny", label: "Deny" }],
      noteDelivery: "none", origin: { kind: "agent" },
    }];
    expect(vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === "approval.requested")).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith("approval.requested", expect.objectContaining(expected[0]));
    expect(service.listPendingApprovals("thread-A").map(approvalOwnership)).toEqual(expected);
    expect(service.listPendingApprovals("thread-B")).toEqual([]);
    expect(agent.sendMessage.mock.calls).toEqual([]);
  });
});
