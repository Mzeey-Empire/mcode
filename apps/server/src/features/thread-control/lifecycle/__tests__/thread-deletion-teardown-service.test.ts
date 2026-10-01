import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { GithubService } from "../../../pull-requests/github/github-service.js";
import type { CiWatcherService } from "../../../pull-requests/status/ci-watcher.js";
import type { ProjectActionService } from "../../../projects/environment/project-action-service.js";
import type { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import type { GitWatcherService } from "../../../projects/git/git-watcher-service.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { ThreadDeletionTeardownService } from "../thread-deletion-teardown-service.js";
import type { ThreadTeardownService } from "../thread-teardown-service.js";

describe("ThreadDeletionTeardownService", () => {
  it("rejects missing save ownership before removing persistent data", async () => {
    const remove = vi.fn(async () => true);
    await expect(createService([]).deletePersistentData(["thread"], remove)).rejects.toThrow("accepted progress boundary");
    expect(remove).not.toHaveBeenCalled();
  });

  it("waits for the exact save disposal before removing persistent data and holds the fence until removal finishes", async () => {
    const service = createService([]);
    let releaseSave: (() => void) | undefined;
    let releaseRemoval: (() => void) | undefined;
    const save = new Promise<void>((resolve) => { releaseSave = resolve; });
    const removal = new Promise<boolean>((resolve) => { releaseRemoval = () => resolve(true); });
    const discardThreads = vi.fn(() => save);
    const finishThreadDeletion = vi.fn();
    service.bindAcceptedProgress({ discardThreads, finishThreadDeletion });
    const remove = vi.fn(() => removal);
    const deleting = service.deletePersistentData(["parent", "native-child"], remove);
    expect(discardThreads).toHaveBeenCalledExactlyOnceWith(["parent", "native-child"]);
    expect(remove).not.toHaveBeenCalled();
    releaseSave?.();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(finishThreadDeletion).not.toHaveBeenCalled();
    releaseRemoval?.();
    expect(await deleting).toBe(true);
    expect(finishThreadDeletion.mock.calls).toEqual([["parent"], ["native-child"]]);
  });

  it("releases the admission fence while preserving the original persistent deletion failure", async () => {
    const service = createService([]);
    const finishThreadDeletion = vi.fn();
    service.bindAcceptedProgress({ discardThreads: async () => {}, finishThreadDeletion });
    const error = new Error("hard deletion failed");
    await expect(service.deletePersistentData(["thread"], async () => { throw error; })).rejects.toBe(error);
    expect(finishThreadDeletion).toHaveBeenCalledExactlyOnceWith("thread");
  });

  it("stops every owned resource before releasing deletion barriers", async () => {
    const calls: string[] = [];
    const service = createService(calls);

    await service.teardownThread("thread-1");

    expect(calls).toEqual([
      "begin-deletion",
      "begin-action",
      "cancel-setup",
      "stop-action",
      "cancel-github",
      "teardown-ci",
      "teardown-thread",
      "unwatch",
      "release-action",
      "release-deletion",
    ]);
  });

  it("releases both barriers when stopping the action fails", async () => {
    const calls: string[] = [];
    const service = createService(calls, { stopFails: true });

    await expect(service.teardownThread("thread-1")).rejects.toThrow("stop failed");

    expect(calls).toEqual([
      "begin-deletion",
      "begin-action",
      "cancel-setup",
      "stop-action",
      "release-action",
      "release-deletion",
    ]);
  });

  it("releases the deletion barrier when action admission fails", async () => {
    const calls: string[] = [];
    const service = createService(calls, { admissionFails: true });

    await expect(service.teardownThread("thread-1")).rejects.toThrow("admission failed");

    expect(calls).toEqual([
      "begin-deletion",
      "begin-action",
      "release-deletion",
    ]);
  });
});

function createService(
  calls: string[],
  options: { stopFails?: boolean; admissionFails?: boolean } = {},
): ThreadDeletionTeardownService {
  const workspaceEnvironment = {
    beginThreadDeletion: vi.fn(() => {
      calls.push("begin-deletion");
      return () => calls.push("release-deletion");
    }),
    cancelSetupForThread: vi.fn(async () => calls.push("cancel-setup")),
  } as unknown as WorkspaceEnvironmentService;
  const projectActions = {
    beginThreadTeardown: vi.fn(async () => {
      calls.push("begin-action");
      if (options.admissionFails) throw new Error("admission failed");
      return () => calls.push("release-action");
    }),
    stopForThread: vi.fn(async () => {
      calls.push("stop-action");
      if (options.stopFails) throw new Error("stop failed");
    }),
  } as unknown as ProjectActionService;
  const github = {
    cancelForRepoPath: vi.fn(async () => calls.push("cancel-github")),
  } as unknown as GithubService;
  const ciWatcher = {
    teardownThread: vi.fn(async () => calls.push("teardown-ci")),
  } as unknown as CiWatcherService;
  const threadTeardown = {
    teardownThread: vi.fn(async () => calls.push("teardown-thread")),
  } as unknown as ThreadTeardownService;
  const gitWatcher = {
    unwatchThreadWorktree: vi.fn(() => calls.push("unwatch")),
  } as unknown as GitWatcherService;

  return new ThreadDeletionTeardownService(
    { findById: vi.fn(() => ({ worktree_path: "C:/repo/worktree" })) } as unknown as ThreadRepo,
    workspaceEnvironment,
    projectActions,
    github,
    ciWatcher,
    threadTeardown,
    gitWatcher,
  );
}
