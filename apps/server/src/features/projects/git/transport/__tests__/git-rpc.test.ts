import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as NodePath from "node:path";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { routeGitRpc, type GitRouterDeps } from "../git-rpc.js";
import { FakeGitExecutor } from "../../execution/fake-git-executor.js";
import { GitComparisonService } from "../../git-comparison-service.js";
import { GitRepositoryService } from "../../git-repository-service.js";
import { GitWorktreeService } from "../../git-worktree-service.js";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { agentStorageTestWriter } from "../../../../agents/__tests__/agent-storage-fixture.js";
import { createSnapshotRangeFixture } from "../../../diffs/snapshots/__tests__/turn-snapshot-range-fixture.js";

function unrelated(): never { throw new Error("Unexpected unrelated operation"); }

describe("strict thread checkout resolution", () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  let deps: GitRouterDeps;
  let executor: FakeGitExecutor;
  beforeEach(async () => {
    fixture = await createSnapshotRangeFixture();
    const writer = agentStorageTestWriter(fixture.db);
    const workspace = new WorkspaceRepo(fixture.db, writer);
    const thread = new ThreadRepo(fixture.db, writer);
    executor = new FakeGitExecutor();
    deps = { workspaceService: workspace, workspaceRepo: workspace, threadService: thread, threadRepo: thread,
      gitComparison: new GitComparisonService(workspace, executor), gitRepository: new GitRepositoryService(workspace, executor),
      gitWorktrees: new GitWorktreeService(workspace, executor, hostRuntime),
      handoffCheckoutService: { createBranchForThread: unrelated }, pullRequestReviews: { pushPullRequestReviewBranch: unrelated },
      reviewWorktreeService: { resolvePushTarget: unrelated }, ciWatcherService: { findByWorkspaceBranch: unrelated, scheduleBumpAfterPush: unrelated } };
    fixture.db.prepare("UPDATE workspaces SET is_git_repo = 1").run();
  });
  afterEach(async () => { await fixture.close(); });

  it("returns worktree-missing without reading the workspace root", async () => {
    fixture.db.prepare("UPDATE threads SET mode = 'worktree', worktree_path = ?").run(NodePath.join(fixture.directory, "deleted-checkout"));
    expect(await routeGitRpc("git.reviewComparison", { workspaceId: "ws", threadId: "thread", view: "staged" }, deps))
      .toMatchObject({ status: "failed", failure: { kind: "worktree-missing" } });
    expect(executor.calls).toEqual([]);
  });

  it("allows draft Review reads but keeps other unknown-thread requests strict", async () => {
    expect(await routeGitRpc("git.reviewComparison", { workspaceId: "ws", threadId: "draft", view: "staged" }, deps))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    expect(executor.calls.every((call) => call.args[1] === fixture.directory)).toBe(true);
    executor.reset();
    await expect(routeGitRpc("git.log", { workspaceId: "ws", threadId: "unknown" }, deps)).rejects.toThrow();
    expect(executor.calls).toEqual([]);
  });

  it("uses the strict resolver for log, branch and file hydration", async () => {
    fixture.db.prepare("UPDATE threads SET mode = 'worktree', worktree_path = ?").run(NodePath.join(fixture.directory, "deleted-checkout"));
    await expect(routeGitRpc("git.log", { workspaceId: "ws", threadId: "thread" }, deps)).rejects.toThrow();
    await expect(routeGitRpc("git.branchDiff", { workspaceId: "ws", threadId: "thread", base: "main", target: "HEAD" }, deps)).rejects.toThrow();
    await expect(routeGitRpc("git.fileAtRef", { workspaceId: "ws", threadId: "thread", ref: "HEAD", filePath: "a.ts" }, deps)).rejects.toThrow();
    expect(executor.calls).toEqual([]);
  });
});
