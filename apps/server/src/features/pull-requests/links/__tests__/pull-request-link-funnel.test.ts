import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { createMockThreadPullRequest } from "@mcode/contracts/testing";
import type { ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { PullRequestLinkFunnel } from "../pull-request-link-funnel.js";

async function setup() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("PR links", "/fixture");
  const thread = await threads.create(workspace.id, "Feature", "worktree", "feature");
  const published: ThreadPullRequest[][] = [];
  const watchSets: number[][] = [];
  const funnel = new PullRequestLinkFunnel(runtime.writer, (id, prs) => {
    expect(threads.findById(id)?.pull_requests).toEqual(prs);
    published.push(prs);
  }, (_id, numbers) => watchSets.push(numbers));
  return { ...runtime, threads, thread, funnel, published, watchSets };
}

describe("PullRequestLinkFunnel", () => {
  it("keeps the first PR when a second arrives and projects the ranked primary into legacy columns", async () => {
    const { funnel, thread, threads, database, published } = await setup();
    await funnel.observe(thread.id, [createMockThreadPullRequest({ number: 10, state: "merged" })], "sync");
    await funnel.observe(thread.id, [createMockThreadPullRequest({ number: 20, state: "draft" })], "created");
    expect(threads.findById(thread.id)?.pull_requests.map((pr) => pr.number)).toEqual([20, 10]);
    expect(database.query("SELECT pr_number, pr_status FROM threads WHERE id = ?").get(thread.id))
      .toEqual({ pr_number: 20, pr_status: "draft" });
    expect(published.map((prs) => prs.map((pr) => pr.number))).toEqual([[10], [20, 10]]);
    expect(threads.findById(thread.id)?.last_activity_at).toBe(thread.last_activity_at);
  });

  it("does not write or publish a repeated snapshot", async () => {
    const { funnel, thread, database, published, watchSets } = await setup();
    database.exec(`CREATE TABLE pr_write_audit (number INTEGER);
      CREATE TRIGGER audit_pr_insert AFTER INSERT ON thread_pull_requests
      BEGIN INSERT INTO pr_write_audit VALUES (new.number); END;
      CREATE TRIGGER audit_pr_delete AFTER DELETE ON thread_pull_requests
      BEGIN INSERT INTO pr_write_audit VALUES (old.number); END;`);
    const pr = createMockThreadPullRequest();
    await funnel.observe(thread.id, [pr], "created");
    await funnel.observe(thread.id, [pr], "sync");
    expect(database.query("SELECT number FROM pr_write_audit").all()).toEqual([{ number: 42 }]);
    expect(published).toEqual([[pr]]);
    expect(watchSets).toEqual([[42]]);
  });

  it("keeps merged sticky and preserves metadata from a fuller observation", async () => {
    const { funnel, thread, threads, published } = await setup();
    const pr = createMockThreadPullRequest({ state: "merged", title: "Feature", url: "https://github.com/o/r/pull/42" });
    await funnel.observe(thread.id, [pr], "watcher");
    await funnel.observe(thread.id, [createMockThreadPullRequest({ state: "open" })], "turn-settled");
    expect(threads.findById(thread.id)?.pull_requests).toEqual([pr]);
    expect(published).toEqual([[pr]]);
  });

  it("watches only open and draft PR numbers and clears links on branch changes", async () => {
    const { funnel, thread, threads, watchSets, published } = await setup();
    await funnel.observe(thread.id, [
      createMockThreadPullRequest({ number: 1, state: "open" }),
      createMockThreadPullRequest({ number: 2, state: "draft" }),
      createMockThreadPullRequest({ number: 3, state: "merged" }),
      createMockThreadPullRequest({ number: 4, state: "closed" }),
      createMockThreadPullRequest({ number: 5, state: "unresolved" }),
    ], "sync");
    expect(watchSets).toEqual([[1, 2]]);
    await funnel.forgetBranch(thread.id);
    expect(threads.findById(thread.id)?.pull_requests).toEqual([]);
    expect(threads.findById(thread.id)?.pr_number).toBeNull();
    expect(watchSets).toEqual([[1, 2], []]);
    expect(published.at(-1)).toEqual([]);
  });

  it("does not publish a failed transaction", async () => {
    const { funnel, thread, database, threads, published, watchSets } = await setup();
    database.exec(`CREATE TRIGGER reject_link BEFORE INSERT ON thread_pull_requests
      BEGIN SELECT RAISE(ABORT, 'rejected'); END;`);
    await expect(funnel.observe(thread.id, [createMockThreadPullRequest()], "created")).rejects.toThrow();
    expect(threads.findById(thread.id)?.pull_requests).toEqual([]);
    expect(published).toEqual([]);
    expect(watchSets).toEqual([]);
  });
});
