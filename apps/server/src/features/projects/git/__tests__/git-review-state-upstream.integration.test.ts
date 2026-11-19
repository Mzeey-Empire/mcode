import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { GitComparisonService } from "../git-comparison-service.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";

describe("Review state against the Git upstream", { timeout: 30_000 }, () => {
  let owned: OwnedTestDatabase;
  let repo: WorkspaceRepo;
  let directory: string;
  let cwd: string;
  let service: GitComparisonService;
  const executor = new RealGitExecutor();
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  function commit(message: string) {
    git("commit", "--allow-empty", "-m", message);
  }

  beforeAll(() => {
    owned = createOwnedTestDatabase();
    repo = new WorkspaceRepo(owned.db, owned.writer);
  });
  afterAll(async () => { await owned.close(); });
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-upstream-"));
    cwd = NodePath.join(directory, "checkout");
    NodeFS.mkdirSync(cwd);
    const origin = NodePath.join(directory, "origin.git");
    git("init", "--bare", origin);
    git("-C", origin, "config", "core.hooksPath", "/dev/null");
    git("init", "-b", "main");
    git("config", "user.name", "Review Test");
    git("config", "user.email", "review@example.test");
    git("config", "commit.gpgSign", "false");
    git("config", "core.hooksPath", "/dev/null");
    git("remote", "add", "origin", origin);
    commit("initial");
    service = new GitComparisonService(repo, executor);
  });
  afterEach(() => { NodeFS.rmSync(directory, { recursive: true, force: true }); });

  it("reports null on a branch without an upstream", async () => {
    expect(await service.readReviewState("fixture", cwd)).toMatchObject({ upstream: null });
  });

  it("reports zero commits ahead of the upstream just pushed", async () => {
    git("push", "-u", "origin", "main");
    git("config", "status.aheadBehind", "false");
    expect(await service.readReviewState("fixture", cwd)).toMatchObject({ upstream: { ahead: 0 } });
  });

  it("counts two local commits on a tracking branch and reports null after detaching", async () => {
    git("push", "-u", "origin", "main");
    commit("first local commit");
    commit("second local commit");
    expect(await service.readReviewState("fixture", cwd)).toMatchObject({ upstream: { ahead: 2 } });

    git("checkout", "--detach");
    expect(await service.readReviewState("fixture", cwd)).toMatchObject({ upstream: null });
  });
});
