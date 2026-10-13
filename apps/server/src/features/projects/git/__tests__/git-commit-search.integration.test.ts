import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitSearchCommitsResultSchema, WS_METHODS } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { createOwnedTestDatabase } from "../../testing/owned-test-database.js";
import { GitComparisonService } from "../git-comparison-service.js";
import { GitRepositoryService } from "../git-repository-service.js";
import { GitWorktreeService } from "../git-worktree-service.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";
import { routeGitRpc, type GitRouterDeps } from "../transport/git-rpc.js";

const directory = NodeFS.realpathSync.native(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-commit-search-")));
const root = NodePath.join(directory, "repo");
const linked = NodePath.join(directory, "branchless");
const executor = new RealGitExecutor();
const service = new GitComparisonService({ findById: () => undefined }, executor);
const params = { workspaceId: "fixture", offset: 0, limit: 100 };

function git(args: string[], input?: string): string {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 15_000, input,
  }).trim();
}

async function search(query?: string, offset = 0) {
  const result = GitSearchCommitsResultSchema().parse(await service.searchCommits({ ...params, query, offset }, linked));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result;
}

function unrelated(): never { throw new Error("Unexpected unrelated operation"); }

beforeAll(() => {
  NodeFS.mkdirSync(root);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Commit search test"]);
  git(["config", "user.email", "search@example.test"]);
  git(["config", "commit.gpgSign", "false"]);
  git(["config", "core.hooksPath", directory]);
  git(["commit", "--allow-empty", "-m", "delete outside the range"]);
  const base = git(["rev-parse", "HEAD"]);
  const commits: string[] = [];
  for (let index = 1; index <= 300; index++) {
    const subject = `${index % 2 ? "Delete" : "Keep"} item ${index}`;
    const file = index === 1 ? "M 100644 inline feature.txt\ndata 8\nfeature\n" : "";
    commits.push(`commit refs/heads/feature\nmark :${index}\ncommitter Commit search test <search@example.test> ${1_700_000_000 + index} +0000\ndata ${subject.length}\n${subject}\nfrom ${index === 1 ? base : `:${index - 1}`}\n${file}\n`);
  }
  git(["fast-import", "--quiet"], commits.join(""));
  git(["branch", "release", "feature~10"]);
  git(["update-ref", "refs/remotes/origin/main", base]);
  git(["worktree", "add", "--detach", linked, "feature"]);
});

afterAll(() => { NodeFS.rmSync(directory, { recursive: true, force: true }); });

describe("commit search across the full ahead-of-base range", { timeout: 30_000 }, () => {
  it("keeps qualified Branch operands in their selected three-dot direction", async () => {
    const forward = await service.readReviewComparison("fixture", "branch", {
      base: "refs/remotes/origin/main", compare: "refs/heads/feature",
    }, linked);
    expect(forward).toMatchObject({ status: "ready", comparison: {
      files: [{ path: "feature.txt", changeType: "added", additions: 1, deletions: 0 }], additions: 1, deletions: 0,
    } });
    expect(await service.readReviewComparison("fixture", "branch", {
      base: "refs/heads/feature", compare: "refs/remotes/origin/main",
    }, linked)).toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
  });

  it("filters before paging so delete matches beyond the first hundred commits are reachable", async () => {
    const first = await search("dElEtE");
    const second = await search("delete", 100);
    expect(first.commits.map((commit) => commit.subject)).toEqual(
      Array.from({ length: 100 }, (_, index) => `Delete item ${299 - index * 2}`),
    );
    expect(second.commits.map((commit) => commit.subject)).toEqual(
      Array.from({ length: 50 }, (_, index) => `Delete item ${99 - index * 2}`),
    );
    expect([first.matchCount, second.matchCount]).toEqual([150, 150]);
    expect([first.totalCount, second.totalCount]).toEqual([300, 300]);
    expect(first.totalCount).toBe(Number(git(["rev-list", "--count", "main..feature"])));
  });

  it("searches SHA prefixes case-insensitively and returns commit metadata", async () => {
    const sha = git(["rev-parse", "feature~299"]);
    const result = await search(sha.slice(0, 12).toUpperCase());
    expect(result).toEqual({ ok: true, commits: [{
      sha, shortSha: git(["rev-parse", "--short", sha]), subject: "Delete item 1",
      date: "2023-11-14T22:13:21.000Z",
    }], matchCount: 1, totalCount: 300 });
  });

  it("counts the whole range for an empty query and preserves counts beyond the last page", async () => {
    const first = await search();
    expect(first.commits.map((commit) => commit.subject)).toEqual(
      Array.from({ length: 100 }, (_, index) => `${index % 2 ? "Delete" : "Keep"} item ${300 - index}`),
    );
    expect([first.matchCount, first.totalCount]).toEqual([300, 300]);
    expect(await search("", 300)).toEqual({ ok: true, commits: [], matchCount: 300, totalCount: 300 });
    expect(await search("--all; delete")).toEqual({ ok: true, commits: [], matchCount: 0, totalCount: 300 });
  });

  it("routes branchless threads to their checkout and saved base instead of the project branch", async () => {
    const database = createOwnedTestDatabase();
    try {
      const workspaceRepo = new WorkspaceRepo(database.db, database.writer);
      const threadRepo = new ThreadRepo(database.db, database.writer);
      const workspace = await workspaceRepo.create("Search fixture", root, true);
      const thread = await threadRepo.create(workspace.id, "Branchless", "worktree", "release");
      await threadRepo.updateWorktreePath(thread.id, linked);
      database.db.prepare("UPDATE threads SET checkout_state = 'branchless', base_branch = 'release' WHERE id = ?").run(thread.id);
      const deps: GitRouterDeps = {
        workspaceService: workspaceRepo, workspaceRepo, threadRepo, threadService: threadRepo,
        gitComparison: new GitComparisonService(workspaceRepo, executor),
        gitRepository: new GitRepositoryService(workspaceRepo, executor),
        gitWorktrees: new GitWorktreeService(workspaceRepo, executor, hostRuntime),
        handoffCheckoutService: { createBranchForThread: unrelated }, gitPush: { pushCheckedOutBranch: unrelated },
        gitCommit: { commit: unrelated }, commitMessages: { generate: unrelated },
      };
      const request = { ...params, workspaceId: workspace.id, threadId: thread.id };
      expect(await routeGitRpc("git.branchComparison", request, deps)).toEqual({
        compare: "HEAD", base: "refs/heads/release", isUnborn: false, isComparisonAvailable: true,
      });
      const result = GitSearchCommitsResultSchema().parse(await routeGitRpc("git.searchCommits", request, deps));
      expect(result).toMatchObject({ ok: true, matchCount: 10, totalCount: 10 });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.commits.map((commit) => commit.subject)).toEqual(
        Array.from({ length: 10 }, (_, index) => `${index % 2 ? "Delete" : "Keep"} item ${300 - index}`),
      );
      expect(await routeGitRpc("git.reviewState", request, deps)).toMatchObject({
        branchDefault: { compare: "HEAD", base: "refs/heads/release" },
        commitsAhead: { count: 10, base: "refs/heads/release" },
      });
    } finally { await database.close(); }
  });

  it("lists commits since the fork for a fully pushed branch", async () => {
    const pushed = NodePath.join(directory, "pushed");
    git(["worktree", "add", "-b", "pushed", pushed, "feature"]);
    git(["update-ref", "refs/remotes/origin/pushed", "feature"]);
    git(["config", "branch.pushed.remote", "origin"]);
    git(["config", "branch.pushed.merge", "refs/heads/pushed"]);
    const result = await service.searchCommits({ ...params, limit: 1 }, pushed);
    expect(result).toMatchObject({ ok: true, matchCount: 300, totalCount: 300 });
    expect(await service.readReviewState("fixture", pushed)).toMatchObject({ commitsAhead: { count: 300 } });
  });

  it.each(["log", "rev-list"])("returns a typed timeout when %s is killed", async (command) => {
    const timedOut = new GitComparisonService({ findById: () => undefined }, {
      exec: async (args, options) => {
        if (args[2] === command) {
          expect(options?.timeout).toBe(10_000);
          throw Object.assign(new Error("Git timed out"), { killed: true });
        }
        return executor.exec(args, options);
      },
    });
    expect(await timedOut.searchCommits(params, linked)).toMatchObject({ ok: false, error: { code: "timed_out" } });
  });

  it("preserves repository and revision failures as typed errors", async () => {
    expect(await service.searchCommits(params, directory)).toMatchObject({ ok: false, error: { code: "not_a_repository" } });
    expect(await service.searchCommits(params, linked, "refs/heads/missing")).toMatchObject({ ok: false, error: { code: "git_failed" } });
  });

  it.each([
    { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { query: "x".repeat(201) },
  ])("rejects invalid search bounds %j at the RPC boundary", (invalid) => {
    expect(WS_METHODS()["git.searchCommits"].params.safeParse({ ...params, ...invalid }).success).toBe(false);
  });
});
