import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { GitPushService } from "../git-push-service.js";
import { GitRepositoryService } from "../git-repository-service.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";

describe("git.push", { timeout: 30_000 }, () => {
  let owned: OwnedTestDatabase;
  let directory: string;
  let cwd: string;
  let origin: string;
  let service: GitPushService;
  const executor = new RealGitExecutor();
  const git = (dir: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

  function configureIdentity(dir: string) {
    git(dir, "config", "user.name", "Push Test");
    git(dir, "config", "user.email", "push@example.test");
    git(dir, "config", "commit.gpgSign", "false");
  }

  function push() {
    return service.pushCheckedOutBranch({ workspaceId: "fixture", workspacePath: cwd, branch: "main" });
  }

  beforeAll(() => { owned = createOwnedTestDatabase(); });
  afterAll(async () => { await owned.close(); });
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-push-failure-"));
    cwd = NodePath.join(directory, "checkout");
    origin = NodePath.join(directory, "origin.git");
    NodeFS.mkdirSync(cwd);
    git(directory, "init", "--bare", origin);
    git(origin, "config", "core.hooksPath", NodePath.join(origin, "hooks"));
    git(cwd, "init", "-b", "main");
    configureIdentity(cwd);
    git(cwd, "config", "core.hooksPath", NodePath.join(directory, "no-hooks"));
    git(cwd, "remote", "add", "origin", origin);
    git(cwd, "commit", "--allow-empty", "-m", "initial");
    service = new GitPushService(
      executor,
      new GitRepositoryService(new WorkspaceRepo(owned.db, owned.writer), executor),
      { pushPullRequestReviewBranch: async () => {} },
      { resolvePushTarget: () => ({ kind: "standard" }) },
      { findByWorkspaceBranch: () => [], scheduleBumpAfterPush: () => {} },
      { findById: () => undefined },
    );
  });
  afterEach(() => { NodeFS.rmSync(directory, { recursive: true, force: true }); });

  it("pushes to the configured fork without updating origin or changing the upstream", async () => {
    git(cwd, "push", "origin", "main");
    const originHead = git(origin, "rev-parse", "refs/heads/main");
    const fork = NodePath.join(directory, "fork.git");
    git(directory, "init", "--bare", fork);
    git(cwd, "remote", "add", "fork", fork);
    git(cwd, "push", "-u", "fork", "main");
    git(cwd, "commit", "--allow-empty", "-m", "push to fork");
    const localHead = git(cwd, "rev-parse", "HEAD");

    await push();

    expect(git(fork, "rev-parse", "refs/heads/main")).toBe(localHead);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(originHead);
    expect(git(cwd, "config", "branch.main.remote")).toBe("fork");
  });

  it("shows both lines of a remote hook's message without the command line or local paths", async () => {
    NodeFS.writeFileSync(
      NodePath.join(origin, "hooks", "pre-receive"),
      "#!/bin/sh\necho 'Running release checks' >&2\necho 'branch is frozen for release review' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    await expect(push()).rejects.toHaveProperty(
      "message",
      "Running release checks\nbranch is frozen for release review",
    );
  });

  it("names the rejected ref when the remote has moved on", async () => {
    git(cwd, "push", "-u", "origin", "main");
    const other = NodePath.join(directory, "other");
    git(directory, "clone", "--branch", "main", origin, other);
    configureIdentity(other);
    git(other, "commit", "--allow-empty", "-m", "elsewhere");
    git(other, "push", "origin", "main");
    git(cwd, "commit", "--allow-empty", "-m", "here");

    await expect(push()).rejects.toThrow(/^! \[rejected\] +main -> main/);
  });
});
