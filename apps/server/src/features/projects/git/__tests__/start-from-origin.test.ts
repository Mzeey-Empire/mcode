import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { GitRepositoryService, OriginFetchError } from "../git-repository-service.js";
import { createOriginFixture, git } from "./start-from-origin-fixture.js";

describe("start from origin", { timeout: 20_000 }, () => {
  it("fetches behind checked-out main and creates a detached worktree without moving local refs", async () => {
    const fixture = await createOriginFixture();
    const { repoPath, publisher, repository, worktrees, localSha, originSha } = fixture;
    git(repoPath, "branch", "keep-local");
    git(repoPath, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/keep-local");
    git(publisher, "tag", "origin-only");
    git(publisher, "push", "origin", "--tags");
    expect(await repository.fetchOriginTrackingBranch(repoPath, "main")).toBe(originSha);
    const worktree = await worktrees.createWorktree(repoPath, "origin-start", "main", {
      branchless: true, startPoint: "refs/remotes/origin/main",
    });
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(originSha);
    expect(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(repoPath, "rev-parse", "main")).toBe(localSha);
    expect(git(repoPath, "rev-parse", "keep-local")).toBe(localSha);
    expect(git(repoPath, "tag", "--list")).toBe("");
    expect(await repository.fetchOriginTrackingBranch(repoPath, "main")).toBe(originSha);
  });

  it("reports a branch missing on origin", async () => {
    const { repository, repoPath } = await createOriginFixture();
    await expect(repository.fetchOriginTrackingBranch(repoPath, "missing")).rejects.toMatchObject({
      name: "OriginFetchError", code: "branch_missing", message: 'Branch "missing" does not exist on origin.',
      detail: "fatal: couldn't find remote ref refs/heads/missing",
    });
  });

  it("reports an absent origin", async () => {
    const { repository, repoPath } = await createOriginFixture();
    git(repoPath, "remote", "remove", "origin");
    await expect(repository.fetchOriginTrackingBranch(repoPath, "main")).rejects.toBeInstanceOf(OriginFetchError);
    await expect(repository.fetchOriginTrackingBranch(repoPath, "main")).rejects.toMatchObject({ code: "no_origin" });
  });

  it("reports network failures without falling back to the stale tracking ref", async () => {
    const { repository, repoPath, localSha } = await createOriginFixture();
    git(repoPath, "remote", "set-url", "origin", "http://127.0.0.1:1/unreachable.git");
    await expect(repository.fetchOriginTrackingBranch(repoPath, "main")).rejects.toMatchObject({ code: "network_or_auth" });
    expect(git(repoPath, "rev-parse", "main")).toBe(localSha);
  });

  it("rejects refspec syntax in branch names before fetching", async () => {
    const { repository, repoPath, localSha } = await createOriginFixture();
    await expect(repository.fetchOriginTrackingBranch(repoPath, "main:refs/heads/main")).rejects.toThrow();
    expect(git(repoPath, "rev-parse", "main")).toBe(localSha);
  });

  it("distinguishes a timed-out Git invocation", async () => {
    const { workspaces, executor, repoPath } = await createOriginFixture();
    const repository = new GitRepositoryService(workspaces, {
      exec: (args, options) => executor.exec(args, { ...options, timeout: 1 }),
    });
    await expect(repository.fetchOriginTrackingBranch(repoPath, "main")).rejects.toMatchObject({ code: "timed_out" });
  });
});
