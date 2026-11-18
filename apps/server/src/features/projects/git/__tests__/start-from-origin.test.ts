import "reflect-metadata";
import * as NodeNet from "node:net";
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

  it("explains a missing origin repository with git's fatal line, not the trailing advice", async () => {
    const { repository, repoPath } = await createOriginFixture();
    git(repoPath, "remote", "set-url", "origin", `${repoPath}-missing-origin.git`);
    const failure = await repository.fetchOriginTrackingBranch(repoPath, "main").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "network_or_auth" });
    expect(failure).toHaveProperty("detail", expect.stringMatching(/^fatal: .*does not appear to be a git repository$/));
  });

  it("rejects refspec syntax in branch names before fetching", async () => {
    const { repository, repoPath, localSha } = await createOriginFixture();
    await expect(repository.fetchOriginTrackingBranch(repoPath, "main:refs/heads/main")).rejects.toThrow();
    expect(git(repoPath, "rev-parse", "main")).toBe(localSha);
  });

  it("distinguishes a timed-out Git invocation", async () => {
    const { workspaces, executor, repoPath } = await createOriginFixture();
    // A listener that accepts and never answers keeps the fetch waiting for refs, so the timeout always fires.
    // A deadline shorter than git's own runtime would race: git can finish first on a fast runner.
    const sockets = new Set<NodeNet.Socket>();
    const silentOrigin = NodeNet.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silentOrigin.listen(0, "127.0.0.1", resolve));
    try {
      const address = silentOrigin.address();
      if (address === null || typeof address === "string") throw new Error("Silent origin has no TCP port");
      git(repoPath, "remote", "set-url", "origin", `git://127.0.0.1:${address.port}/origin.git`);
      const repository = new GitRepositoryService(workspaces, {
        exec: (args, options) => executor.exec(args, args.includes("fetch") ? { ...options, timeout: 500 } : options),
      });
      await expect(repository.fetchOriginTrackingBranch(repoPath, "main")).rejects.toMatchObject({ code: "timed_out" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silentOrigin.close(() => resolve()));
    }
  });
});
