import "reflect-metadata";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { createThreadPersistenceTestRuntime } from "../../thread-control/testing/thread-persistence-test-runtime.js";
import { TerminalCommandService } from "../../terminal/commands/terminal-command-service.js";
import * as projects from "../index.js";
import { registerProjectServices } from "../composition/register-projects.js";

const TEST_HOST_RUNTIME: HostRuntime = Object.freeze({
  platform: "win32",
  architecture: "x64",
  nodeAbi: "127",
});

describe("projects feature boundary", () => {
  it("exposes only the composition-root project symbols", () => {
    expect(Object.keys(projects).sort()).toStrictEqual([
      "FilesystemBrowser",
      "GitComparisonService",
      "GitRepositoryService",
      "GitWatcherService",
      "GitWorktreeService",
      "PROJECT_ACTION_CLOCK_TOKEN",
      "PROJECT_ACTION_RUN_ID_FACTORY_TOKEN",
      "ProjectActionService",
      "ProjectWorktreeService",
      "PullRequestReviewGitError",
      "PullRequestReviewGitService",
      "RepositoryGitMutationLock",
      "SandboxWorktreeCleanupPolicy",
      "WorkspaceEnricher",
      "WorkspaceEnvironmentService",
      "WorkspaceEnvironmentServiceError",
      "WorkspaceService",
      "WorktreeDirectoryRemover",
      "WorktreeSafetyService",
    ]);
  });

  it("resolves the workspace environment service from the project composition", async () => {
    const persistence = createThreadPersistenceTestRuntime();
    await persistence.writer.whenReady();
    const child = container.createChildContainer();
    child.register("Database", { useValue: persistence.reader });
    child.registerInstance(ApplicationDatabaseWriter, persistence.writer);
    child.register<HostRuntime>("HostRuntime", { useValue: TEST_HOST_RUNTIME });
    child.register(TerminalCommandService, {
      useValue: {
        prepare: async () => { throw new Error("Terminal execution is outside this composition test"); },
      } as unknown as TerminalCommandService,
    });
    registerProjectServices(child);
    expect(() => child.resolve(projects.WorkspaceEnvironmentService)).not.toThrow();
  });
});
