import "reflect-metadata";
import * as NodeEvents from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockThreadPullRequest } from "@mcode/contracts/testing";
import type { PullRequestWatchSnapshot, PullRequestWatchTarget } from "../../../../pull-requests/github/github-service.js";
import { PullRequestLinkFunnel } from "../../../../pull-requests/links/pull-request-link-funnel.js";
import { CiWatcherService } from "../../../../pull-requests/status/ci-watcher.js";
import { createThreadPersistenceTestRuntime } from "../../../../thread-control/testing/thread-persistence-test-runtime.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { addClient, broadcast, _resetForTest } from "../../../../../application/transport/push.js";
import { syncThreadPullRequests } from "../workspace-thread-rpc.js";

const pushSchema = z.object({ channel: z.string(), data: z.unknown() });
const checks = { aggregate: "passing", runs: [], fetchedAt: 1 } satisfies PullRequestWatchSnapshot["checks"];

async function fixture() {
  const runtime = createThreadPersistenceTestRuntime();
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const workspaces = new WorkspaceRepo(runtime.reader, runtime.writer);
  const workspace = await workspaces.create("Fixture", "/fixture", true);
  const other = await workspaces.create("Unopened", "/unopened", true);
  const thread = await threads.create(other.id, "Feature", "worktree", "feature");
  const github = {
    getBranchPr: vi.fn().mockResolvedValue(null),
    getPullRequestWatchSnapshots: vi.fn<(targets: PullRequestWatchTarget[]) => Promise<PullRequestWatchSnapshot[]>>()
      .mockResolvedValue([]),
    getCheckRuns: vi.fn().mockResolvedValue(checks),
    cancelCheckRuns: vi.fn().mockResolvedValue(undefined),
    cancelAllInFlight: vi.fn().mockResolvedValue(undefined),
  };
  const watcher = new CiWatcherService(github, broadcast);
  const funnel = new PullRequestLinkFunnel(runtime.writer, (threadId, pullRequests) => {
    broadcast("thread.pullRequests", { threadId, pullRequests });
  }, () => undefined);
  threads.pullRequests = funnel;
  const deps = {
    threadRepo: threads, workspaceService: workspaces, githubService: github,
    pullRequestLinkFunnel: funnel, ciWatcherService: watcher,
  };
  return { ...runtime, threads, workspaces, workspace, other, thread, github, watcher, funnel, deps };
}

async function connectClients() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", addClient);
  await NodeEvents.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const clients = [new WebSocket(`ws://127.0.0.1:${address.port}`), new WebSocket(`ws://127.0.0.1:${address.port}`)];
  await Promise.all(clients.map((client) => NodeEvents.once(client, "open")));
  return {
    clients,
    async close() {
      clients.forEach((client) => client.terminate());
      server.clients.forEach((client) => client.terminate());
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function nextPush(client: WebSocket): Promise<z.infer<typeof pushSchema>> {
  return new Promise((resolve, reject) => client.once("message", (data) => {
    try { resolve(pushSchema.parse(JSON.parse(data.toString()))); }
    catch (error) { reject(error); }
  }));
}

afterEach(() => _resetForTest());

describe("global thread PR sync", () => {
  it("publishes a found merge to every client without an active workspace", async () => {
    const f = await fixture();
    await f.funnel.observe(f.thread.id, [createMockThreadPullRequest()], "created");
    f.github.getPullRequestWatchSnapshots.mockResolvedValue([{
      threadId: f.thread.id, prNumber: 42, state: "MERGED", checks,
    }]);
    const sockets = await connectClients();
    try {
      const pushes = sockets.clients.map(nextPush);
      expect(await syncThreadPullRequests(f.deps)).toEqual({ checked: 1 });
      const expected = { channel: "thread.pullRequests", data: {
        threadId: f.thread.id, pullRequests: [createMockThreadPullRequest({ state: "merged" })],
      } };
      expect(await Promise.all(pushes)).toEqual([expected, expected]);
      expect(f.threads.findById(f.thread.id)?.pull_requests[0]?.state).toBe("merged");
      expect(f.github.getPullRequestWatchSnapshots).toHaveBeenCalledWith([
        { threadId: f.thread.id, prNumber: 42, repoPath: "/unopened" },
      ]);
    } finally {
      await sockets.close();
      await f.watcher.dispose();
    }
  });

  it("discovers PRs only on named worktree checkouts across projects", async () => {
    const f = await fixture();
    try {
      await f.threads.create(f.workspace.id, "Direct", "direct", "main");
      await f.threads.create(f.workspace.id, "Detached", "worktree", "HEAD", false, "codex", {}, "branchless");
      f.github.getBranchPr.mockResolvedValue({ number: 17, state: "OPEN", title: "New feature", url: "https://github.com/o/r/pull/17" });
      expect(await syncThreadPullRequests(f.deps)).toEqual({ checked: 1 });
      expect(f.threads.findById(f.thread.id)?.pull_requests).toEqual([
        createMockThreadPullRequest({ number: 17, title: "New feature", url: "https://github.com/o/r/pull/17" }),
      ]);
      expect(f.github.getBranchPr).toHaveBeenCalledExactlyOnceWith("feature", "/unopened");
    } finally { await f.watcher.dispose(); }
  });

  it("ignores a snapshot for a checkout changed while GitHub was responding", async () => {
    const f = await fixture();
    try {
      await f.funnel.observe(f.thread.id, [createMockThreadPullRequest()], "created");
      f.github.getPullRequestWatchSnapshots.mockImplementation(async () => {
        await f.threads.updateCheckoutFromHead(f.thread.id, "other", "named", null, null);
        return [{ threadId: f.thread.id, prNumber: 42, state: "MERGED", checks }];
      });
      await syncThreadPullRequests(f.deps);
      expect(f.threads.findById(f.thread.id)?.branch).toBe("other");
      expect(f.threads.findById(f.thread.id)?.pull_requests).toEqual([]);
    } finally { await f.watcher.dispose(); }
  });
});
