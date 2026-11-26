import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import * as push from "../../../../application/transport/push.js";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import type { GitWorktreeService } from "../../git/git-worktree-service.js";
import type { SandboxWorktreeCleanupPolicy } from "../sandbox-worktree-cleanup-policy.js";
import { ProjectWorktreeService } from "../project-worktree-service.js";

describe("ProjectWorktreeService.provisionThreadWorktree", () => {
  it("tells clients the worktree path once it is readable, since thread.created went out without it", async () => {
    const runtime = createThreadPersistenceTestRuntime();
    const threads = new ThreadRepo(runtime.reader, runtime.writer);
    const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Alpha", "/alpha");
    const worktreePath = "/alpha-worktrees/main-1";
    const gitWorktrees = {
      createWorktree: vi.fn().mockResolvedValue({
        name: "main-1", path: worktreePath, branch: "main", managed: true, createdBranch: false, warnings: [],
      }),
      removeWorktree: vi.fn(),
    } as unknown as GitWorktreeService;
    const service = new ProjectWorktreeService(
      threads, new WorkspaceRepo(runtime.reader, runtime.writer), runtime.writer, gitWorktrees,
      { decide: vi.fn() } as unknown as SandboxWorktreeCleanupPolicy,
    );
    const thread = await threads.create(workspace.id, "Delegated", "worktree", "main");
    const pathsReadableAtPush: (string | null | undefined)[] = [];
    vi.spyOn(push, "broadcast").mockImplementation((channel, payload) => {
      if (channel !== "thread.worktreeChanged") return;
      expect(payload).toEqual({ threadId: thread.id, worktreePath });
      pathsReadableAtPush.push(threads.findById(thread.id)?.worktree_path);
    });

    await service.provisionThreadWorktree(thread, workspace.id, "main");

    expect(pathsReadableAtPush).toEqual([worktreePath]);
  });
});
