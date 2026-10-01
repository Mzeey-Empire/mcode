import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { FakeGitExecutor } from "../../../projects/git/execution/index.js";
import { GitRepositoryService } from "../../../projects/git/git-repository-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { HandoffCheckoutService } from "../handoff-checkout-service.js";

describe("HandoffCheckoutService", () => {
  let db: Database;
  let owned: OwnedTestDatabase;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let gitService: GitRepositoryService;
  let gitWorktrees: GitWorktreeService;
  let service: HandoffCheckoutService;

  beforeEach(() => {
    owned = createOwnedTestDatabase();
    db = openReadOnlyDatabase(owned.db.filename);
    threadRepo = new ThreadRepo(db, owned.writer);
    workspaceRepo = new WorkspaceRepo(db, owned.writer);
    const gitExecutor = new FakeGitExecutor();
    gitService = new GitRepositoryService(workspaceRepo, gitExecutor);
    gitWorktrees = new GitWorktreeService(workspaceRepo, gitExecutor, hostRuntime);
    service = new HandoffCheckoutService(
      threadRepo,
      workspaceRepo,
      gitService,
      gitWorktrees,
    );
  });

  afterEach(async () => {
    await owned.writer.barrier();
    db.close(true);
    await owned.close();
    vi.restoreAllMocks();
  });

  it("creates a branch for a thread and marks its checkout state named", async () => {
    const workspace = await workspaceRepo.create("test", "/tmp/test");
    const thread = await threadRepo.create(
      workspace.id,
      "Branchless Thread",
      "worktree",
      "release",
      true,
      "claude",
      undefined,
      "branchless",
      "release",
    );
    await threadRepo.updateWorktreePath(thread.id, "/tmp/wt/main");
    vi.spyOn(gitWorktrees, "resolveWorkingDir").mockReturnValue("/tmp/wt/main");
    vi.spyOn(gitService, "createBranch").mockResolvedValue("feat/from-thread");

    const branch = await service.createBranchForThread(
      workspace.id,
      thread.id,
      "feat/from-thread",
    );

    expect(branch).toBe("feat/from-thread");
    expect(gitWorktrees.resolveWorkingDir).toHaveBeenCalledWith(
      "/tmp/test",
      "worktree",
      "/tmp/wt/main",
    );
    expect(gitService.createBranch).toHaveBeenCalledWith(
      "/tmp/wt/main",
      "feat/from-thread",
    );
    expect(threadRepo.findById(thread.id)).toMatchObject({
      branch: "feat/from-thread",
      checkout_state: "named",
      base_branch: "release",
    });
  });

  it("syncs a branchless thread worktree to a named external branch", async () => {
    const workspace = await workspaceRepo.create("test", "/tmp/test");
    const thread = await threadRepo.create(workspace.id, "Branchless", "worktree", "release", true, "claude", undefined, "branchless", "release");
    await threadRepo.updateWorktreePath(thread.id, "/tmp/wt/main");
    vi.spyOn(gitService, "getCurrentBranchAt").mockResolvedValue("feat/external");

    const result = await service.syncCheckoutFromHead(thread.id);

    expect(result?.changed).toBe(true);
    expect(result?.thread).toMatchObject({
      branch: "feat/external",
      checkout_state: "named",
      base_branch: "release",
    });
  });

  it("syncs a named thread worktree to detached HEAD", async () => {
    const workspace = await workspaceRepo.create("test", "/tmp/test");
    const thread = await threadRepo.create(workspace.id, "Named", "worktree", "feat/base");
    await threadRepo.updateWorktreePath(thread.id, "/tmp/wt/base");
    vi.spyOn(gitService, "getCurrentBranchAt").mockResolvedValue("HEAD");

    const result = await service.syncCheckoutFromHead(thread.id);

    expect(result?.changed).toBe(true);
    expect(result?.thread).toMatchObject({
      branch: "HEAD",
      checkout_state: "branchless",
      base_branch: "feat/base",
    });
  });
});
