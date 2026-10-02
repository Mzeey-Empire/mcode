import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../../../runtime/persistence/sqlite/read-only-database.js";
import { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import { PullRequestReviewLinkRepo } from "../pull-request-review-link-repo.js";
import type { CreateReviewTaskInput } from "../review-write-operations.js";

const request: CreateReviewTaskInput = {
  identity: { provider: "github", repositoryNodeId: "repository", owner: "owner", repository: "repo", number: 42 },
  title: "Review #42", baseBranch: "main",
  checkout: {
    pullRequestUrl: "https://github.com/owner/repo/pull/42", pullRequestState: "open", workspaceId: "workspace",
    worktreePath: "fixture-review", worktreeManaged: true, headRepositoryNodeId: "head-repository",
    headRepositoryOwner: "owner", headRepositoryName: "repo", headRef: "feature", headOid: "a".repeat(40),
    localBranch: "review-42", pushRemote: "origin", pushRef: "feature", managedRemoteName: null,
  },
  defaults: { provider: "codex", model: "gpt-6-sol", reasoning: "high", interactionMode: "build", permission: "full", contextWindow: "200k", thinking: false },
};

describe("Review task owner transaction", () => {
  let directory: string;
  let reader: Database;
  let writer: ApplicationDatabaseWriter;
  let repo: PullRequestReviewLinkRepo;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-owner-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    const setup = openDatabase({ dbPath });
    setup.run("INSERT INTO workspaces (id, name, path) VALUES ('workspace', 'Fixture', 'fixture')");
    setup.run("CREATE TRIGGER fail_review_model BEFORE UPDATE OF model ON threads WHEN NEW.title = 'Fail model' BEGIN SELECT RAISE(ABORT, 'model configuration failed'); END");
    setup.close(true);
    reader = openReadOnlyDatabase(dbPath);
    writer = new ApplicationDatabaseWriter(dbPath);
    repo = new PullRequestReviewLinkRepo(reader, writer);
  });

  afterEach(async () => {
    await writer.close();
    reader.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("returns fully configured committed thread and link data through a physically readonly reader", async () => {
    const committed = await repo.persistReviewTask(request);
    expect(committed.thread).toMatchObject({ worktree_path: "fixture-review", branch: "review-42", provider: "codex", model: "gpt-6-sol", reasoning_level: "high", interaction_mode: "build", permission_mode: "full", pr_number: 42, pr_status: "OPEN" });
    expect(committed.link).toMatchObject({ threadId: committed.thread.id, worktreePath: "fixture-review", pushRemote: "origin", pushRef: "feature" });
    expect(repo.findByPrimaryThreadId(committed.thread.id)?.primaryThreadId).toBe(committed.thread.id);
    expect(() => reader.run("DELETE FROM threads")).toThrow(/readonly/);
  });

  it("rolls back the entire thread/link operation after mid-configuration failure and permits subsequent work", async () => {
    await expect(repo.persistReviewTask({ ...request, title: "Fail model" })).rejects.toThrow("model configuration failed");
    expect(reader.query("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 0 });
    expect(repo.findByIdentity({ provider: "github", repositoryNodeId: "repository", pullRequestNumber: 42 })).toBeNull();
    expect(await repo.persistReviewTask(request)).toMatchObject({ link: { worktreePath: "fixture-review" } });
  });

  it("rejects the losing concurrent identity without creating an orphan thread or replacing the canonical checkout", async () => {
    const first = repo.persistReviewTask(request);
    const second = repo.persistReviewTask({ ...request, checkout: { ...request.checkout, worktreePath: "losing-checkout" } });
    const observed = expect(second).rejects.toThrow("concurrently");
    const committed = await first;
    await observed;
    expect(reader.query("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 1 });
    expect(repo.findByPrimaryThreadId(committed.thread.id)?.worktreePath).toBe("fixture-review");
  });
});
