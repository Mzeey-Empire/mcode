/**
 * Real-Git regression tests for issue #1730: fetchBranchAt must never silently
 * discard local-only branch history. Exercises the production
 * GitRepositoryService through RealGitExecutor against disposable repositories.
 */
import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";
import { GitRepositoryService } from "../git-repository-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

function commitFile(root: string, name: string, content: string, message: string): void {
  NodeFS.writeFileSync(NodePath.join(root, name), content);
  git(root, "add", name);
  git(root, "commit", "-m", message);
}

interface RepoFixture {
  root: string;
  remote: string;
  service: GitRepositoryService;
}

/** Disposable clone-shaped repo: main committed and pushed to a bare origin. */
function createRepo(): RepoFixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-fetch-1730-"));
  tempDirs.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "commit.gpgSign", "false");
  git(root, "config", "core.hooksPath", root);
  git(root, "config", "user.name", "Fetch Regression");
  git(root, "config", "user.email", "fetch@example.invalid");

  const remote = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-fetch-remote-1730-"));
  tempDirs.push(remote);
  NodeChildProcess.execFileSync("git", ["init", "--bare", remote], {
    encoding: "utf8",
    timeout: 15_000,
  });
  git(root, "remote", "add", "origin", remote);

  commitFile(root, "base.txt", "base", "base");
  git(root, "push", "-u", "origin", "main");

  const service = new GitRepositoryService(
    { findById: () => ({ path: root }) } as unknown as WorkspaceRepo,
    new RealGitExecutor(),
  );
  return { root, remote, service };
}

/** Push a commit that exists only on origin/<branch>, advancing it past the local tip. */
function pushRemoteOnlyCommit(fixture: RepoFixture, branch: string, message: string): void {
  const { root } = fixture;
  const current = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  git(root, "checkout", "-b", "remote-side", `origin/${branch}`);
  commitFile(root, "remote.txt", message, message);
  git(root, "push", "origin", `remote-side:${branch}`);
  git(root, "checkout", current);
  git(root, "branch", "-D", "remote-side");
}

/** Point refs/pull/<n>/head on the bare origin at the given commit. */
function setPullHead(fixture: RepoFixture, prNumber: number, sha: string): void {
  NodeChildProcess.execFileSync(
    "git",
    ["-C", fixture.remote, "update-ref", `refs/pull/${prNumber}/head`, sha],
    { encoding: "utf8", timeout: 15_000 },
  );
}

describe("GitRepositoryService.fetchBranchAt (issue #1730)", () => {
  it.each([undefined, 42])(
    "preserves an existing local branch that is ahead of the fetched head (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "feature");
      git(root, "push", "-u", "origin", "feature");
      commitFile(root, "local.txt", "unpushed work", "local unpushed work");
      const before = git(root, "rev-parse", "feature");
      git(root, "checkout", "main");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, git(root, "rev-parse", "origin/feature"));
      }

      await service.fetchBranchAt(root, "feature", prNumber);

      const after = git(root, "rev-parse", "feature");
      expect(after).toBe(before);
      expect(git(root, "log", "feature", "--format=%s")).toContain("local unpushed work");
    },
  );

  it.each([undefined, 42])(
    "rejects a diverged local branch without altering it (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "feature");
      commitFile(root, "feat.txt", "feat", "shared base commit");
      git(root, "push", "-u", "origin", "feature");
      commitFile(root, "local.txt", "divergent work", "local divergent work");
      const before = git(root, "rev-parse", "feature");
      git(root, "checkout", "main");
      pushRemoteOnlyCommit(fixture, "feature", "remote divergent work");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, git(root, "rev-parse", "origin/feature"));
      }

      await expect(service.fetchBranchAt(root, "feature", prNumber)).rejects.toThrow();

      expect(git(root, "rev-parse", "feature")).toBe(before);
      expect(git(root, "log", "feature", "--format=%s")).toContain("local divergent work");
    },
  );

  it.each([undefined, 42])(
    "fast-forwards a local branch that is behind the fetched head (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "feature");
      commitFile(root, "feat.txt", "feat", "local pushed commit");
      git(root, "push", "-u", "origin", "feature");
      git(root, "checkout", "main");
      pushRemoteOnlyCommit(fixture, "feature", "remote ahead commit");
      const remoteHead = git(root, "rev-parse", "origin/feature");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, remoteHead);
      }

      await service.fetchBranchAt(root, "feature", prNumber);

      expect(git(root, "rev-parse", "feature")).toBe(remoteHead);
      expect(git(root, "log", "feature", "--format=%s")).toContain("local pushed commit");
    },
  );

  it.each([undefined, 42])(
    "creates the local branch when it does not exist (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "incoming");
      commitFile(root, "incoming.txt", "incoming", "incoming commit");
      git(root, "push", "origin", "incoming");
      git(root, "checkout", "main");
      git(root, "branch", "-D", "incoming");
      const remoteHead = git(root, "rev-parse", "origin/incoming");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, remoteHead);
      }

      await service.fetchBranchAt(root, "incoming", prNumber);

      expect(git(root, "rev-parse", "incoming")).toBe(remoteHead);
      if (prNumber === undefined) {
        expect(git(root, "rev-parse", "--abbrev-ref", "incoming@{upstream}")).toBe(
          "origin/incoming",
        );
      }
    },
  );

  it.each([undefined, 42])(
    "leaves an up-to-date local branch untouched (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "feature");
      commitFile(root, "feat.txt", "feat", "feature commit");
      git(root, "push", "-u", "origin", "feature");
      const before = git(root, "rev-parse", "feature");
      git(root, "checkout", "main");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, before);
      }

      await service.fetchBranchAt(root, "feature", prNumber);

      expect(git(root, "rev-parse", "feature")).toBe(before);
    },
  );

  it.each([undefined, 42])(
    "does not move a branch checked out in a linked worktree (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "feature");
      commitFile(root, "feat.txt", "feat", "feature commit");
      git(root, "push", "-u", "origin", "feature");
      git(root, "checkout", "main");
      pushRemoteOnlyCommit(fixture, "feature", "remote ahead commit");
      const before = git(root, "rev-parse", "feature");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, git(root, "rev-parse", "origin/feature"));
      }
      const worktreeDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "mcode-fetch-wt-1730-"),
      );
      tempDirs.push(worktreeDir);
      git(root, "worktree", "add", NodePath.join(worktreeDir, "wt"), "feature");

      await expect(service.fetchBranchAt(root, "feature", prNumber)).rejects.toThrow();

      expect(git(root, "rev-parse", "feature")).toBe(before);
    },
  );

  it.each([undefined, 42])(
    "resolves without moving an up-to-date branch checked out in a worktree (PR %s)",
    async (prNumber) => {
      const fixture = createRepo();
      const { root, service } = fixture;
      git(root, "checkout", "-b", "feature");
      commitFile(root, "feat.txt", "feat", "feature commit");
      git(root, "push", "-u", "origin", "feature");
      const before = git(root, "rev-parse", "feature");
      git(root, "checkout", "main");
      if (prNumber !== undefined) {
        setPullHead(fixture, prNumber, before);
      }
      const worktreeDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "mcode-fetch-wt-eq-1730-"),
      );
      tempDirs.push(worktreeDir);
      git(root, "worktree", "add", NodePath.join(worktreeDir, "wt"), "feature");

      await service.fetchBranchAt(root, "feature", prNumber);

      expect(git(root, "rev-parse", "feature")).toBe(before);
    },
  );

  it("rejects a behind branch checked out in the current worktree", async () => {
    const fixture = createRepo();
    const { root, service } = fixture;
    git(root, "checkout", "-b", "feature");
    commitFile(root, "feat.txt", "feat", "feature commit");
    git(root, "push", "-u", "origin", "feature");
    pushRemoteOnlyCommit(fixture, "feature", "remote ahead commit");
    const before = git(root, "rev-parse", "feature");
    git(root, "checkout", "feature");

    await expect(service.fetchBranchAt(root, "feature")).rejects.toThrow();

    expect(git(root, "rev-parse", "feature")).toBe(before);
  });

  it("treats a tag-only name as an absent branch", async () => {
    const { root, service } = createRepo();
    git(root, "checkout", "-b", "incoming");
    commitFile(root, "incoming.txt", "incoming", "incoming commit");
    git(root, "push", "origin", "incoming");
    git(root, "checkout", "main");
    git(root, "branch", "-D", "incoming");
    commitFile(root, "unrelated.txt", "unrelated", "unrelated tag target");
    git(root, "tag", "incoming");
    const remoteHead = git(root, "rev-parse", "origin/incoming");

    await service.fetchBranchAt(root, "incoming");

    expect(git(root, "rev-parse", "refs/heads/incoming")).toBe(remoteHead);
  });

  it("fetches the remote branch, not a same-named remote tag", async () => {
    const fixture = createRepo();
    const { root, service } = fixture;
    git(root, "checkout", "-b", "shadow");
    commitFile(root, "feat.txt", "feat", "local pushed commit");
    git(root, "push", "-u", "origin", "shadow");
    git(root, "checkout", "main");
    pushRemoteOnlyCommit(fixture, "shadow", "remote ahead commit");
    const remoteHead = git(root, "rev-parse", "origin/shadow");
    git(root, "checkout", "-b", "tag-side");
    commitFile(root, "tag.txt", "tag", "tag-only commit");
    git(root, "push", "origin", "tag-side:refs/tags/shadow");
    git(root, "checkout", "main");
    git(root, "branch", "-D", "tag-side");

    await service.fetchBranchAt(root, "shadow");

    expect(git(root, "rev-parse", "refs/heads/shadow")).toBe(remoteHead);
  });

  it("keeps an existing local branch when the ordinary fetch fails", async () => {
    const { root, service } = createRepo();
    git(root, "checkout", "-b", "local-only");
    commitFile(root, "local.txt", "local only", "local only commit");
    const before = git(root, "rev-parse", "local-only");
    git(root, "checkout", "main");

    await service.fetchBranchAt(root, "local-only");

    expect(git(root, "rev-parse", "local-only")).toBe(before);
  });

  it("rejects when the branch exists neither locally nor on origin", async () => {
    const { root, service } = createRepo();

    await expect(service.fetchBranchAt(root, "missing")).rejects.toThrow(
      'Branch "missing" not found locally or on origin',
    );
    await expect(service.fetchBranchAt(root, "missing", 99)).rejects.toThrow();
  });
});
