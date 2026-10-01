import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { WorkerOwnedTurnRuntime } from "../../../features/agents/execution/worker-owned-turn-runtime.js";
import { GithubService } from "../../../features/pull-requests/github/github-service.js";
import { CiWatcherService } from "../../../features/pull-requests/status/ci-watcher.js";
import { WorkspaceRepo } from "../../../features/projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../features/thread-control/persistence/thread-repo.js";
import { ThreadService } from "../../../features/thread-control/lifecycle/thread-service.js";
import { ThreadDeletionTeardownService } from "../../../features/thread-control/lifecycle/thread-deletion-teardown-service.js";
import { setupContainer } from "../container.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";

describe("server container thread deletion composition", () => {
  let database: Database | undefined;
  let workerRuntime: WorkerOwnedTurnRuntime | undefined;
  let temporaryDirectory: string | undefined;
  let ciWatcher: CiWatcherService | undefined;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(async () => {
    container.reset();
    temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-container-thread-deletion-"));
    process.env.MCODE_DB_PATH = NodePath.join(temporaryDirectory, "mcode.db");
    await setupContainer(temporaryDirectory);
    database = container.resolve<Database>("Database");
    workerRuntime = container.resolve(WorkerOwnedTurnRuntime);
    await workerRuntime.whenReady();
  });

  afterEach(async () => {
    await ciWatcher?.dispose();
    ciWatcher = undefined;
    await workerRuntime?.close();
    workerRuntime = undefined;
    if (container.isRegistered(ApplicationDatabaseWriter)) await container.resolve(ApplicationDatabaseWriter).close();
    database?.close(true);
    database = undefined;
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    if (temporaryDirectory) NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("binds thread admission before the manual CI watcher registration and deletion after it", async () => {
    const progress = workerRuntime?.progress;
    if (!progress || !temporaryDirectory) throw new Error("The production container must be initialized");
    const threadService = container.resolve(ThreadService);
    expect(container.isRegistered(CiWatcherService)).toBe(false);
    threadService.bindAcceptedProgress(progress);

    ciWatcher = new CiWatcherService(container.resolve(GithubService), () => {});
    container.registerInstance(CiWatcherService, ciWatcher);
    const deletion = container.resolve(ThreadDeletionTeardownService);
    deletion.bindAcceptedProgress(progress);
    expect(container.resolve(ThreadDeletionTeardownService)).toBe(deletion);
    const workspace = await container.resolve(WorkspaceRepo).create("deletion-composition", temporaryDirectory);
    const threads = container.resolve(ThreadRepo);
    const thread = await threads.create(workspace.id, "Deletion composition", "direct", "main", true, "codex");

    await deletion.deletePersistentData([thread.id], async () => threads.hardDelete(thread.id));

    expect(threads.findById(thread.id)).toBeNull();
  });
});
