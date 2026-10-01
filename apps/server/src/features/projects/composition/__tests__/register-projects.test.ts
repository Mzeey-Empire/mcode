import "reflect-metadata";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { TERMINAL_BACKEND_TOKEN, type TerminalBackend } from "../../../terminal/backends/terminal-backend.js";
import { TerminalCommandService } from "../../../terminal/commands/terminal-command-service.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ProjectActionService } from "../../environment/project-action-service.js";
import { WorkspaceEnvironmentService } from "../../environment/workspace-environment-service.js";
import { registerProjectServices } from "../register-projects.js";

const TEST_HOST_RUNTIME: HostRuntime = Object.freeze({
  platform: "win32",
  architecture: "x64",
  nodeAbi: "127",
});

describe("registerProjectServices", () => {
  it("registers one stateful workspace environment lifecycle service", async () => {
    const persistence = createThreadPersistenceTestRuntime();
    await persistence.writer.whenReady();
    const projectContainer = container.createChildContainer();
    projectContainer.register("Database", { useValue: persistence.reader });
    projectContainer.registerInstance(ApplicationDatabaseWriter, persistence.writer);
    projectContainer.register(ThreadRepo, { useValue: {} as ThreadRepo });
    projectContainer.register(WorkspaceRepo, { useValue: {} as WorkspaceRepo });
    projectContainer.register(TerminalCommandService, { useValue: {} as TerminalCommandService });
    projectContainer.register<HostRuntime>("HostRuntime", { useValue: TEST_HOST_RUNTIME });

    registerProjectServices(projectContainer);

    expect(projectContainer.resolve(WorkspaceEnvironmentService)).toBe(
      projectContainer.resolve(WorkspaceEnvironmentService),
    );
  });

  it("resolves Project Actions with production clock and run-ID registrations", async () => {
    const persistence = createThreadPersistenceTestRuntime();
    await persistence.writer.whenReady();
    const projectContainer = container.createChildContainer();
    projectContainer.registerInstance(ApplicationDatabaseWriter, persistence.writer);
    projectContainer.register(ThreadRepo, { useValue: {} as ThreadRepo });
    projectContainer.register("ThreadRepo", { useFactory: (c) => c.resolve(ThreadRepo) });
    projectContainer.register(TerminalCommandService, { useValue: {} as TerminalCommandService });
    projectContainer.register(TERMINAL_BACKEND_TOKEN, { useValue: {} as TerminalBackend });
    projectContainer.register("Database", { useValue: persistence.reader });
    projectContainer.register<HostRuntime>("HostRuntime", { useValue: TEST_HOST_RUNTIME });

    registerProjectServices(projectContainer);

    expect(projectContainer.resolve(ProjectActionService)).toBeInstanceOf(ProjectActionService);
  });
});
