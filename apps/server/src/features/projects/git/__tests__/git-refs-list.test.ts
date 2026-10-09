import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRefsListResultSchema, type GitRefsListParams } from "@mcode/contracts";
import { RealGitExecutor } from "../execution/real-git-executor.js";
import { GitRepositoryService } from "../git-repository-service.js";
import { GitWorktreeService } from "../git-worktree-service.js";
import { routeGitRpc, type GitRouterDeps } from "../transport/git-rpc.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { createOwnedTestDatabase } from "../../testing/owned-test-database.js";
import { hostRuntime } from "@mcode/shared/node/host-runtime";

const directory = NodeFS.realpathSync.native(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-refs-1830-")));
const root = NodePath.join(directory, "repo");
const linked = NodePath.join(directory, "Linked Folder");
const detached = NodePath.join(directory, "Detached Folder");
const service = new GitRepositoryService({ findById: () => undefined }, new RealGitExecutor());
let baseSha: string;
let localSha: string;
let originSha: string;

function git(args: string[], input?: string): string {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 15_000, input,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  }).trim();
}

async function list(options: Omit<GitRefsListParams, "workspaceId">, path = root) {
  const result = GitRefsListResultSchema().parse(await service.listRefsAt(path, options));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result;
}

function unexpected(): never { throw new Error("Unexpected unrelated router operation"); }

function routerDeps(workspaceRepo: WorkspaceRepo, threadRepo: ThreadRepo): GitRouterDeps {
  return {
    workspaceService: workspaceRepo, workspaceRepo, threadRepo, threadService: threadRepo,
    gitRepository: service,
    gitWorktrees: new GitWorktreeService(workspaceRepo, new RealGitExecutor(), hostRuntime),
    gitComparison: {
      listCommits: unexpected, readCommitDiff: unexpected, listCommitChangedFiles: unexpected,
      readWorkingTreeDiff: unexpected, readFileAtRef: unexpected,
      readBranchComparisonDiff: unexpected,
      resolveBranchComparison: unexpected, readReviewState: unexpected, readReviewComparison: unexpected,
    },
    handoffCheckoutService: { createBranchForThread: unexpected },
    pullRequestReviews: { pushPullRequestReviewBranch: unexpected },
    reviewWorktreeService: { resolvePushTarget: unexpected },
    ciWatcherService: { findByWorkspaceBranch: unexpected, scheduleBumpAfterPush: unexpected },
  };
}

beforeAll(() => {
  NodeFS.mkdirSync(root);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Target tests"]);
  git(["config", "user.email", "targets@example.invalid"]);
  git(["config", "commit.gpgSign", "false"]);
  git(["config", "core.hooksPath", directory]);
  git(["commit", "--allow-empty", "-m", "base"]);
  baseSha = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  localSha = git(["commit-tree", tree, "-p", baseSha, "-m", "local"]);
  originSha = git(["commit-tree", tree, "-p", baseSha, "-m", "origin"]);
  const origin = NodePath.join(directory, "origin.git");
  git(["init", "--bare", origin]);
  git(["remote", "add", "origin", origin]);
  git(["push", "origin", "main"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const refs = Array.from({ length: 120 }, (_, index) => `update refs/heads/branch-${String(index).padStart(3, "0")} ${baseSha}`);
  refs.push(`update refs/heads/feature/x ${localSha}`, `update refs/remotes/origin/feature/x ${originSha}`);
  refs.push(`update refs/remotes/origin/remote-only ${originSha}`);
  git(["update-ref", "--stdin"], `${refs.join("\n")}\n`);
  git(["checkout", "-b", "context"]);
  git(["worktree", "add", "-b", "linked-branch", linked, "main"]);
  git(["worktree", "add", "--detach", detached, "main"]);
}, 30_000);

afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

describe("GitRepositoryService.listRefsAt", () => {
  it("routes a persisted thread to its linked checkout and rejects another workspace's thread", async () => {
    const database = createOwnedTestDatabase();
    try {
      const workspaceRepo = new WorkspaceRepo(database.db, database.writer);
      const threadRepo = new ThreadRepo(database.db, database.writer);
      const workspace = await workspaceRepo.create("Fixture", root, true);
      const other = await workspaceRepo.create("Other fixture", directory, false);
      const thread = await threadRepo.create(workspace.id, "Linked", "worktree", "linked-branch");
      await threadRepo.updateWorktreePath(thread.id, linked);
      const deps = routerDeps(workspaceRepo, threadRepo);
      const result = GitRefsListResultSchema().parse(await routeGitRpc("git.refs.list", {
        workspaceId: workspace.id, threadId: thread.id, purpose: "new-thread", limit: 2,
      }, deps));
      expect(result).toMatchObject({ ok: true, items: [
        { fullName: "refs/heads/main", isCurrent: false },
        { fullName: "refs/heads/linked-branch", isCurrent: true, worktree: null },
      ] });
      await expect(routeGitRpc("git.refs.list", {
        workspaceId: other.id, threadId: thread.id, purpose: "new-thread",
      }, deps)).rejects.toThrow();
      const nonRepo = await routeGitRpc("git.refs.list", { workspaceId: other.id, purpose: "new-thread" }, deps);
      expect(nonRepo).toMatchObject({ ok: false, error: { code: "not_a_repository" } });
      expect(await routeGitRpc("git.reviewState", {
        workspaceId: other.id, threadId: "missing-thread",
      }, deps)).toEqual({ isGitRepo: false });
    } finally { await database.close(); }
  });

  it("sorts by committer date before ref name, with local refs before newer remote-only refs", async () => {
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const newer = NodeChildProcess.execFileSync("git", ["-C", root, "commit-tree", tree, "-p", baseSha, "-m", "newer"], {
      encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z" },
    }).trim();
    git(["update-ref", "refs/heads/z-newest", newer]);
    git(["update-ref", "refs/remotes/origin/a-newest", newer]);
    try {
      const result = await list({ purpose: "new-thread", limit: 4 });
      expect(result.items.map((item) => item.kind === "ref" ? item.fullName : item.kind)).toEqual([
        "refs/heads/main", "refs/heads/context", "refs/heads/z-newest", "refs/heads/branch-000",
      ]);
      const remote = await list({ purpose: "review", side: "origin", limit: 3 });
      expect(remote.items.map((item) => item.kind === "ref" ? item.fullName : item.kind)).toEqual([
        "refs/remotes/origin/main", "refs/remotes/origin/a-newest", "refs/remotes/origin/feature/x",
      ]);
    } finally {
      git(["update-ref", "-d", "refs/heads/z-newest"]);
      git(["update-ref", "-d", "refs/remotes/origin/a-newest"]);
    }
  });
  it("pages 125 grouped targets as 50/50/25 with a stable total and full ref identities", async () => {
    const first = await list({ purpose: "new-thread" });
    const second = await list({ purpose: "new-thread", cursor: first.nextCursor ?? undefined });
    const third = await list({ purpose: "new-thread", cursor: second.nextCursor ?? undefined });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([50, 50, 25]);
    expect([first.total, second.total, third.total]).toEqual([125, 125, 125]);
    expect(third.nextCursor).toBeNull();
    const names = [...first.items, ...second.items, ...third.items].map((item) => item.kind === "ref" ? item.fullName : item.kind);
    expect(names).toEqual([
      "refs/heads/main", "refs/heads/context",
      ...Array.from({ length: 120 }, (_, index) => `refs/heads/branch-${String(index).padStart(3, "0")}`),
      "refs/heads/feature/x", "refs/heads/linked-branch", "refs/remotes/origin/remote-only",
    ]);
    expect(await list({ purpose: "new-thread", cursor: first.nextCursor ?? undefined })).toEqual(second);
  });

  it("keeps diverged refs on their review sides and groups the origin twin only for new threads", async () => {
    const local = await list({ purpose: "review", side: "local", query: "FEATURE/X" });
    const origin = await list({ purpose: "review", side: "origin", query: "feature/x" });
    const grouped = await list({ purpose: "new-thread", query: "feature/x" });
    expect(local.total).toBe(1);
    expect(origin.total).toBe(1);
    expect(grouped.total).toBe(1);
    expect(local.items[0]).toMatchObject({ fullName: "refs/heads/feature/x", headSha: localSha, twin: null, remote: null });
    expect(origin.items[0]).toMatchObject({ fullName: "refs/remotes/origin/feature/x", headSha: originSha, twin: null, remote: "origin" });
    expect(grouped.items[0]).toMatchObject({ fullName: "refs/heads/feature/x", twin: "refs/remotes/origin/feature/x", headSha: localSha });
    expect(localSha).not.toBe(originSha);
  });

  it("derives current/default flags from the context checkout and marks only other linked worktrees", async () => {
    const project = await list({ purpose: "review", side: "local", query: "linked" });
    expect(project.items[0]).toMatchObject({ isCurrent: false, worktree: { path: linked.replaceAll("\\", "/"), folder: "Linked Folder" } });
    const context = await list({ purpose: "new-thread", limit: 2 }, linked);
    expect(context.items).toMatchObject([
      { fullName: "refs/heads/main", isDefault: true, isCurrent: false },
      { fullName: "refs/heads/linked-branch", isCurrent: true, worktree: null },
    ]);
    const primary = await list({ purpose: "review", side: "local", query: "context" }, linked);
    expect(primary.items[0]).toMatchObject({ isCurrent: false, worktree: null });
  });

  it("lists only linked branches and detached checkouts in existing-worktree mode", async () => {
    const result = await list({ purpose: "existing-worktree" });
    expect(result.total).toBe(2);
    expect(result.items).toMatchObject([
      { kind: "ref", fullName: "refs/heads/linked-branch" },
      { kind: "detached-worktree", headShortSha: baseSha.slice(0, 7), worktree: { folder: "Detached Folder" } },
    ]);
    const searched = await list({ purpose: "existing-worktree", query: "DETACHED FOLDER", limit: 1 });
    expect(searched.total).toBe(1);
    expect(searched.items[0]?.kind).toBe("detached-worktree");
    expect((await list({ purpose: "review", side: "local", query: "LINKED FOLDER" })).total).toBe(1);
  });

  it("filters before paging and drops remote HEAD symrefs", async () => {
    const result = await list({ purpose: "review", side: "origin" });
    expect(result.items.map((item) => item.kind === "ref" ? item.fullName : item.kind)).toEqual([
      "refs/remotes/origin/main", "refs/remotes/origin/feature/x", "refs/remotes/origin/remote-only",
    ]);
    expect(result.items[0]).toMatchObject({ isDefault: true });
    const matches = await list({ purpose: "new-thread", query: "branch-01", limit: 3 });
    expect(matches.total).toBe(10);
    expect(matches.items.map((item) => item.kind === "ref" ? item.shortName : item.kind)).toEqual(["branch-010", "branch-011", "branch-012"]);
  });

  it("returns git_failed and the first stderr line for a corrupt ref", async () => {
    const ref = NodePath.join(root, ".git", "refs", "heads", "broken");
    NodeFS.writeFileSync(ref, `${"f".repeat(40)}\n`);
    const executor = new RealGitExecutor();
    let stderr = "";
    // Some Git releases abort with a glibc message instead of printing "fatal: missing object".
    const recording = new GitRepositoryService({ findById: () => undefined }, {
      exec: (args, opts) => executor.exec(args, opts).catch((error: unknown) => {
        if (args.includes("for-each-ref") && error instanceof Error && "stderr" in error) stderr = String(error.stderr);
        throw error;
      }),
    });
    try {
      const result = await recording.listRefsAt(root, { purpose: "new-thread" });
      expect(stderr).not.toBe("");
      expect(result).toEqual({
        ok: false, error: { code: "git_failed", message: "Could not list Git targets.", detail: stderr.split(/\r?\n/)[0] },
      });
    } finally { NodeFS.unlinkSync(ref); }
  });

  it("returns not_a_repository with stderr instead of an empty list", async () => {
    const result = await service.listRefsAt(directory, { purpose: "new-thread" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_a_repository" } });
    if (result.ok) throw new Error("Expected a non-repository error");
    expect(result.error.detail).toMatch(/^fatal: not a git repository/);
  });

  it("maps executor timeouts and rejects malformed cursors without restarting page one", async () => {
    const timed = new GitRepositoryService({ findById: () => undefined }, {
      exec: async () => { throw Object.assign(new Error("Timed out"), { code: null, signal: "SIGTERM", stderr: "", killed: true }); },
    });
    expect(await timed.listRefsAt(root, { purpose: "new-thread" })).toEqual({
      ok: false, error: { code: "timed_out", message: "Git target listing timed out.", detail: "Timed out" },
    });
    expect(await service.listRefsAt(root, { purpose: "new-thread", cursor: "bad-cursor" })).toMatchObject({ ok: false, error: { code: "git_failed" } });
  });
});
