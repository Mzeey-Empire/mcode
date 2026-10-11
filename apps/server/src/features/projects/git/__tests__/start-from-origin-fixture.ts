import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach } from "vitest";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";
import { GitRepositoryService } from "../git-repository-service.js";
import { GitWorktreeService } from "../git-worktree-service.js";

const roots: string[] = [];
const originalDataDir = process.env.MCODE_DATA_DIR;
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.MCODE_DATA_DIR;
  else process.env.MCODE_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** Execute Git against a disposable repository with stable fixture configuration. */
export function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, "-c", "commit.gpgSign=false", "-c", "core.hooksPath=", ...args], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Origin Test", GIT_AUTHOR_EMAIL: "origin@example.invalid",
      GIT_COMMITTER_NAME: "Origin Test", GIT_COMMITTER_EMAIL: "origin@example.invalid" },
  }).trim();
}

/** Real Git and persistence shared by fetch and coordinator behavior tests. */
export async function createOriginFixture() {
  const scratch = NodePath.resolve(".dev", "start-from-origin-tests");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const root = NodeFS.mkdtempSync(NodePath.join(scratch, "fixture-"));
  roots.push(root);
  process.env.MCODE_DATA_DIR = NodePath.join(root, "data");
  const repoPath = NodePath.join(root, "repo");
  const origin = NodePath.join(root, "origin.git");
  const publisher = NodePath.join(root, "publisher");
  NodeFS.mkdirSync(repoPath);
  git(repoPath, "init", "-b", "main");
  git(repoPath, "commit", "--allow-empty", "-m", "Local base");
  const localSha = git(repoPath, "rev-parse", "main");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(repoPath, "remote", "add", "origin", origin);
  git(repoPath, "push", "-u", "origin", "main");
  git(root, "clone", origin, publisher);
  git(publisher, "commit", "--allow-empty", "-m", "Origin tip");
  git(publisher, "push", "origin", "main");
  const originSha = git(publisher, "rev-parse", "main");
  const runtime = createThreadPersistenceTestRuntime();
  const workspaces = new WorkspaceRepo(runtime.reader, runtime.writer);
  const workspace = await workspaces.create("Origin fixture", repoPath);
  const executor = new RealGitExecutor();
  const repository = new GitRepositoryService(workspaces, executor);
  const host = { platform: process.platform, architecture: process.arch, nodeAbi: process.versions.modules };
  const worktrees = new GitWorktreeService(workspaces, executor, host);
  return { root, repoPath, origin, publisher, localSha, originSha, runtime, workspaces, workspace, repository, worktrees, executor, host };
}
