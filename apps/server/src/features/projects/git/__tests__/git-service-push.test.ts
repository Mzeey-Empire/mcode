import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { validateBranchName } from "@mcode/shared";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { GitComparisonService } from "../git-comparison-service.js";
import { GitPushService } from "../git-push-service.js";
import { GitRepositoryService } from "../git-repository-service.js";
import { GitWorktreeService } from "../git-worktree-service.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;
import { createMockGitExecutor } from "../execution/__tests__/mock-git-executor.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  rm: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  validateBranchName: vi.fn(),
  validateWorktreeName: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe("GitRepositoryService.push", () => {
  let gitService: GitRepositoryService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    const mockWorkspaceRepo = {
      findById: vi.fn().mockReturnValue({ path: "/repo" }),
    } as unknown as WorkspaceRepo;
    gitService = new GitRepositoryService(mockWorkspaceRepo, mock.executor);
  });

  it("pushes branch to origin with --set-upstream", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });

    await gitService.push("/repo", "feat/my-branch");

    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "push", "--set-upstream", "origin", "feat/my-branch"],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("throws when push fails", async () => {
    execFn.mockRejectedValue(new Error("rejected"));

    await expect(gitService.push("/repo", "feat/my-branch")).rejects.toThrow(
      "rejected",
    );
  });

  it("rejects branch names that look like git flags", async () => {
    const { validateBranchName } = await import("@mcode/shared");
    vi.mocked(validateBranchName).mockImplementation(() => {
      throw new Error("Branch name cannot start with '-'");
    });

    await expect(gitService.push("/repo", "--force")).rejects.toThrow(
      "Branch name cannot start with '-'",
    );
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe("GitPushService", () => {
  const sha = "d".repeat(40);
  const reviewTarget = {
    workspaceId: "workspace-1",
    worktreePath: "/review",
    localBranch: "mcode/pr-42",
    pushRemote: "contrib",
    pushRef: "feature/review",
    expectedHeadRepositoryUrl: "https://github.com/contributor/mcode",
  };

  function createPushService(options: { upstream?: boolean; review?: boolean } = {}) {
    const mock = createMockGitExecutor();
    mock.execFn.mockImplementation(async (args) => {
      if (args.includes("--symbolic-full-name") && !options.upstream) {
        throw Object.assign(new Error("no upstream configured"), { code: 128 });
      }
      return { stdout: "", stderr: "" };
    });
    const pushPullRequestReviewBranch = vi.fn().mockResolvedValue(undefined);
    const scheduleBumpAfterPush = vi.fn();
    const service = new GitPushService(
      mock.executor,
      { push: vi.fn(), getCurrentBranchAt: vi.fn() },
      { pushPullRequestReviewBranch },
      {
        resolvePushTarget: () => options.review
          ? { kind: "review", target: reviewTarget }
          : { kind: "standard" },
      },
      { findByWorkspaceBranch: () => ["thread-ci"], scheduleBumpAfterPush },
      { findById: vi.fn() },
    );
    return { service, execFn: mock.execFn, pushPullRequestReviewBranch, scheduleBumpAfterPush };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBranchName).mockImplementation(() => undefined);
  });

  it("pushes the captured SHA to the captured branch without force, then sets a missing upstream", async () => {
    const { service, execFn, scheduleBumpAfterPush } = createPushService();
    const destination = service.captureDestination("workspace-1", null, "feat/x");

    await service.pushCommit({ workspaceId: "workspace-1", repoPath: "/repo", sha, destination });

    const calls = execFn.mock.calls.map(([args]) => args);
    expect(calls).toContainEqual(["-C", "/repo", "push", "origin", `${sha}:refs/heads/feat/x`]);
    expect(calls.flat()).not.toContain("--force");
    expect(calls.at(-1)).toEqual(["-C", "/repo", "branch", "--set-upstream-to=origin/feat/x", "feat/x"]);
    expect(scheduleBumpAfterPush).toHaveBeenCalledWith("thread-ci");
  });

  it("leaves an existing upstream alone", async () => {
    const { service, execFn } = createPushService({ upstream: true });

    await service.pushCommit({
      workspaceId: "workspace-1",
      repoPath: "/repo",
      sha,
      destination: { kind: "standard", remote: "origin", branch: "feat/x" },
    });

    expect(execFn.mock.calls.some(([args]) => args.includes("--set-upstream-to=origin/feat/x"))).toBe(false);
  });

  it("does not report a landed push as failed when setting the upstream fails", async () => {
    const { service, execFn } = createPushService();
    execFn.mockImplementation(async (args) => {
      if (args.includes("--symbolic-full-name")) throw Object.assign(new Error("no upstream"), { code: 128 });
      if (args.includes("branch")) throw new Error("branch config is locked");
      return { stdout: "", stderr: "" };
    });

    await expect(service.pushCommit({
      workspaceId: "workspace-1",
      repoPath: "/repo",
      sha,
      destination: { kind: "standard", remote: "origin", branch: "feat/x" },
    })).resolves.toBeUndefined();
  });

  it("pushes a commit to a linked Review task's captured target by SHA", async () => {
    const { service, pushPullRequestReviewBranch } = createPushService({ review: true });
    const destination = service.captureDestination("workspace-1", "thread-42", "mcode/pr-42");

    await service.pushCommit({ workspaceId: "workspace-1", repoPath: "/review", sha, destination });

    expect(destination).toEqual({
      kind: "review",
      worktreePath: "/review",
      remote: "contrib",
      pushRef: "feature/review",
      localBranch: "mcode/pr-42",
      expectedHeadRepositoryUrl: reviewTarget.expectedHeadRepositoryUrl,
    });
    expect(pushPullRequestReviewBranch).toHaveBeenCalledWith(
      "/review", "contrib", "feature/review", reviewTarget.expectedHeadRepositoryUrl, sha,
    );
  });

  it("refuses to capture a Review target for another branch", () => {
    const { service } = createPushService({ review: true });

    expect(() => service.captureDestination("workspace-1", "thread-42", "main")).toThrow(
      "Review task push target does not match",
    );
  });

  it("refuses to push anything but a full object id", async () => {
    const { service, execFn } = createPushService();

    await expect(service.pushCommit({
      workspaceId: "workspace-1",
      repoPath: "/repo",
      sha: "HEAD",
      destination: { kind: "standard", remote: "origin", branch: "feat/x" },
    })).rejects.toThrow("Invalid commit SHA");
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe("GitRepositoryService.fetchBranchAt", () => {
  it("does not accept a stale local branch when fetching a pull request fails", async () => {
    const mock = createMockGitExecutor();
    const gitService = new GitRepositoryService({} as WorkspaceRepo, mock.executor);
    vi.mocked(validateBranchName).mockImplementation(() => undefined);
    mock.execFn.mockRejectedValue(new Error("pull request is unavailable"));

    await expect(gitService.fetchBranchAt("/repo", "contributor/review", 42)).rejects.toThrow(
      "pull request is unavailable",
    );
    expect(mock.execFn).toHaveBeenCalledTimes(1);
    expect(mock.execFn).toHaveBeenCalledWith([
      "-C",
      "/repo",
      "fetch",
      "origin",
      "pull/42/head",
    ]);
  });
});

describe("GitRepositoryService and GitWorktreeService branch creation", () => {
  let gitRepository: GitRepositoryService;
  let gitWorktrees: GitWorktreeService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBranchName).mockImplementation(() => undefined);
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    const workspaceRepo = {} as WorkspaceRepo;
    gitRepository = new GitRepositoryService(workspaceRepo, mock.executor);
    gitWorktrees = new GitWorktreeService(workspaceRepo, mock.executor, TEST_HOST_RUNTIME);
  });

  it("creates and checks out the branch with argv-safe git args", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });

    await expect(gitRepository.createBranch("/repo", "feat/create-branch")).resolves.toBe(
      "feat/create-branch",
    );

    expect(execFn).toHaveBeenCalledWith([
      "-C",
      "/repo",
      "checkout",
      "-b",
      "feat/create-branch",
    ]);
  });

  it("creates a detached worktree from the selected base branch without creating a branch", async () => {
    execFn.mockResolvedValue({ stdout: "", stderr: "" });
    vi.mocked(NodeFS.existsSync).mockImplementation((path) => path === "/repo");

    await expect(
      gitWorktrees.createWorktree("/repo", "main-branchless", "main", { branchless: true }),
    ).resolves.toMatchObject({
      branch: "main",
      createdBranch: false,
    });

    expect(execFn).toHaveBeenCalledWith([
      "-C",
      "/repo",
      "worktree",
      "add",
      "--detach",
      NodePath.join("/mock/mcode", "worktrees", "repo", "main-branchless"),
      "main",
    ], { timeout: 120_000 });
  });

  it("creates a named worktree branch from the exact requested base ref", async () => {
    execFn.mockImplementation(async (args) => {
      if (args[2] === "rev-parse") throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    });
    vi.mocked(NodeFS.existsSync).mockImplementation((path) => path === "/repo");

    await expect(
      gitWorktrees.createWorktree(
        "/repo",
        "issue-960",
        "codex/issue-960",
        { baseRef: "origin/main" },
      ),
    ).resolves.toMatchObject({
      branch: "codex/issue-960",
      createdBranch: true,
    });

    expect(execFn).toHaveBeenLastCalledWith([
      "-C",
      "/repo",
      "worktree",
      "add",
      NodePath.join("/mock/mcode", "worktrees", "repo", "issue-960"),
      "-b",
      "codex/issue-960",
      "origin/main",
    ], { timeout: 120_000 });
  });

  it("does not return a worktree after Git reports an incomplete checkout", async () => {
    const checkoutError = new Error("checkout did not finish");
    execFn.mockImplementation(async (args) => {
      if (args.includes("worktree") && args.includes("add")) throw checkoutError;
      return { stdout: "", stderr: "" };
    });
    const worktreePath = NodePath.join("/mock/mcode", "worktrees", "repo", "incomplete-checkout");
    vi.mocked(NodeFS.existsSync).mockImplementation((path) =>
      path === "/repo" || path === NodePath.join(worktreePath, ".git"),
    );

    await expect(
      gitWorktrees.createWorktree("/repo", "incomplete-checkout", "main", { branchless: true }),
    ).rejects.toBe(checkoutError);
  });

  it.each([
    "",
    "--force",
    "feat/has space",
    "feat/../escape",
    "feat;rm",
    "feat$(whoami)",
    "HEAD",
  ])("rejects unsafe branch name %j before exec", async (name) => {
    await expect(gitRepository.createBranch("/repo", name)).rejects.toThrow();
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe("GitComparisonService.readBranchComparisonDiffStat", () => {
  let gitService: GitComparisonService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateBranchName).mockImplementation(() => undefined);
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    const workspaceRepo = {} as WorkspaceRepo;
    gitService = new GitComparisonService(
      workspaceRepo,
      mock.executor,
      new GitRepositoryService(workspaceRepo, mock.executor),
    );
  });

  it("returns diff stat between two refs", async () => {
    execFn.mockResolvedValue({
      stdout: " 3 files changed, 42 insertions(+), 5 deletions(-)\n",
      stderr: "",
    });

    const result = await gitService.readBranchComparisonDiffStat("/repo", "main", "feat/x");

    expect(result).toBe("3 files changed, 42 insertions(+), 5 deletions(-)");
    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo", "diff", "--stat", "main...feat/x"],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });
});

describe("GitRepositoryService.getRemoteUrl", () => {
  let gitService: GitRepositoryService;
  let execFn: ReturnType<typeof createMockGitExecutor>["execFn"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockGitExecutor();
    execFn = mock.execFn;
    gitService = new GitRepositoryService({} as WorkspaceRepo, mock.executor);
  });

  it("normalizes SSH origin remotes to https web URLs", async () => {
    execFn.mockResolvedValue({
      stdout: "git@github.com:Mzeey-Empire/mcode.git\n",
      stderr: "",
    });

    await expect(gitService.getRemoteUrl("/repo/mcode")).resolves.toEqual({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    expect(execFn).toHaveBeenCalledWith(
      ["-C", "/repo/mcode", "remote", "get-url", "origin"],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("falls back to the folder name when origin is missing", async () => {
    execFn.mockRejectedValue(new Error("No such remote 'origin'"));

    await expect(gitService.getRemoteUrl("/repo/local-only")).resolves.toEqual({
      webUrl: null,
      label: "local-only",
    });
  });

  it("falls back to the folder name when origin is malformed", async () => {
    execFn.mockResolvedValue({
      stdout: "not-a-remote\n",
      stderr: "",
    });

    await expect(gitService.getRemoteUrl("/repo/local-only")).resolves.toEqual({
      webUrl: null,
      label: "local-only",
    });
  });

  it("falls back to the folder name when an SCP-like origin has an invalid host", async () => {
    execFn.mockResolvedValue({
      stdout: "git@github.com?x:Mzeey-Empire/mcode.git\n",
      stderr: "",
    });

    await expect(gitService.getRemoteUrl("/repo/local-only")).resolves.toEqual({
      webUrl: null,
      label: "local-only",
    });
  });
});
