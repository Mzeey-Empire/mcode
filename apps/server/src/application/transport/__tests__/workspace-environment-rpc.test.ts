import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../ws-router.js";
import { WorkspaceEnvironmentService } from "../../../features/projects/environment/workspace-environment-service.js";
import { createThreadPersistenceTestRuntime } from "../../../features/thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceEnvironmentConfigurationRepo } from "../../../features/projects/environment/persistence/workspace-environment-configuration-repo.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

describe("workspace environment RPC", () => {
  const actionRun = {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "action-1",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "terminal-1",
    trigger: "manual",
    port: null,
    actionName: "Run app",
    status: "running",
    snapshot: {
      platform: "linux",
      script: "bun run dev",
      checkoutPath: "/project",
      terminal: { executable: "bash", arguments: [] },
      environmentNames: [],
    },
    createdAt: "2026-08-30T00:00:00.000Z",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
  };

  it("serves valid read/save calls and reports malformed payloads structurally", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const workspaceEnvironmentService = new WorkspaceEnvironmentService(root);
    const deps = {
      workspaceService: { findById: (id: string) => id === "workspace-1" ? { id } : null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const read = await routeMessage(JSON.stringify({ id: "read", method: "workspace.environment.read", params: { workspaceId: "workspace-1" } }), deps);
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ status: "absent", revision: null });

    const save = await routeMessage(JSON.stringify({
      id: "save",
      method: "workspace.environment.save",
      params: {
        workspaceId: "workspace-1",
        sourceRevision: null,
        document: { version: "0.0.1", actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" } }] },
      },
    }), deps);
    expect(save.error).toBeUndefined();
    expect(save.result).toMatchObject({ status: "present" });

    const malformed = await routeMessage(JSON.stringify({
      id: "bad",
      method: "workspace.environment.save",
      params: {
        workspaceId: "workspace-1",
        sourceRevision: null,
        document: { version: "0.2.0", actions: [] },
      },
    }), deps);
    expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION");
    expect(malformed.error?.data).toEqual(expect.objectContaining({
      issues: [expect.objectContaining({ path: ["document", "version"], reason: "unsupported_version" })],
    }));
  });

  it("forgets only the requested stored action approval and reports approvals across read, save and storage selection", async () => {
    const fixture = NodePath.resolve("../..", ".dev/fixture-repo");
    await NodeFSPromises.mkdir(fixture, { recursive: true });
    const root = await NodeFSPromises.mkdtemp(NodePath.join(fixture, "mcode-environment-rpc-"));
    roots.push(root);
    const baseCheckout = NodePath.join(root, "base");
    const workspace = { id: "workspace-1", path: baseCheckout };
    const persistence = createThreadPersistenceTestRuntime();
    await persistence.writer.whenReady();
    for (const id of [workspace.id, "workspace-2"]) {
      persistence.database.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, ?, ?, '{}')")
        .run(id, id, NodePath.join(root, id));
    }
    const configuration = new WorkspaceEnvironmentConfigurationRepo(persistence.reader, persistence.writer);
    const workspaceEnvironmentService = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: persistence.reader,
      databaseWriter: persistence.writer,
      workspaces: { findById: (id) => id === workspace.id ? workspace : null },
    });
    const deps = {
      workspaceService: { findById: (id: string) => id === workspace.id ? workspace : null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const selected = await routeMessage(JSON.stringify({
      id: "storage",
      method: "workspace.environment.storage.set",
      params: { workspaceId: workspace.id, storageMode: "shared" },
    }), deps);
    expect(selected.result).toMatchObject({ status: "absent", storageMode: "shared", approvedActionIds: [] });

    await configuration.approve(workspace.id, "action:build", "old-build-fingerprint");
    await configuration.approve(workspace.id, "action:test", "old-test-fingerprint");
    await configuration.approve(workspace.id, "action:deleted", "deleted-action-fingerprint");
    await configuration.approve("workspace-2", "action:build", "other-workspace-fingerprint");
    const saved = await routeMessage(JSON.stringify({
      id: "save-approved-actions",
      method: "workspace.environment.save",
      params: {
        workspaceId: workspace.id,
        sourceRevision: null,
        document: {
          version: "0.1.0",
          actions: [
            { id: "build", name: "Build", command: { default: "new build command" } },
            { id: "test", name: "Test", command: { default: "new test command" } },
          ],
        },
      },
    }), deps);
    expect(saved.error).toBeUndefined();
    expect(saved.result).toMatchObject({ approvedActionIds: ["build", "test"] });

    const forgotten = await routeMessage(JSON.stringify({
      id: "forget",
      method: "workspace.environment.command.forget",
      params: { workspaceId: workspace.id, actionId: "build" },
    }), deps);
    expect(forgotten.error).toBeUndefined();
    expect(forgotten.result).toBeUndefined();
    expect(configuration.hasApproval(workspace.id, "action:build", "old-build-fingerprint")).toBe(false);
    expect(configuration.hasApproval(workspace.id, "action:test", "old-test-fingerprint")).toBe(true);
    expect(configuration.hasApproval("workspace-2", "action:build", "other-workspace-fingerprint")).toBe(true);

    const read = await routeMessage(JSON.stringify({
      id: "read-approved-actions",
      method: "workspace.environment.read",
      params: { workspaceId: workspace.id },
    }), deps);
    expect(read.result).toMatchObject({ approvedActionIds: ["test"] });

    for (const storageMode of ["system", "shared"]) {
      const switched = await routeMessage(JSON.stringify({
        id: "switch",
        method: "workspace.environment.storage.set",
        params: { workspaceId: workspace.id, storageMode },
      }), deps);
      expect(switched.error).toBeUndefined();
      expect(switched.result).toHaveProperty("approvedActionIds", storageMode === "shared" ? ["test"] : undefined);
    }

    const repeated = await routeMessage(JSON.stringify({
      id: "forget-again",
      method: "workspace.environment.command.forget",
      params: { workspaceId: workspace.id, actionId: "build" },
    }), deps);
    expect(repeated.error).toBeUndefined();
    expect(repeated.result).toBeUndefined();

    const missingWorkspace = await routeMessage(JSON.stringify({
      id: "forget-missing-workspace",
      method: "workspace.environment.command.forget",
      params: { workspaceId: "missing", actionId: "build" },
    }), deps);
    expect(missingWorkspace.error?.code).toBe("WORKSPACE_ENVIRONMENT_NOT_FOUND");

    for (const params of [
      { workspaceId: workspace.id },
      { workspaceId: workspace.id, actionId: "test", extra: true },
      { workspaceId: workspace.id, actionId: "" },
      { workspaceId: workspace.id, actionId: "a".repeat(257) },
      { workspaceId: workspace.id, actionId: 1 },
      { workspaceId: "", actionId: "test" },
      { workspaceId: "w".repeat(257), actionId: "test" },
    ]) {
      const malformed = await routeMessage(JSON.stringify({ id: "forget-invalid", method: "workspace.environment.command.forget", params }), deps);
      expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");
    }
    expect(configuration.hasApproval(workspace.id, "action:test", "old-test-fingerprint")).toBe(true);
  });

  it("routes command approval with the exact reviewed command", async () => {
    const approveCommand = vi.fn().mockResolvedValue(undefined);
    const params = {
      threadId: "thread-1",
      target: { kind: "action", actionId: "action-1" },
      fingerprint: "a".repeat(64),
    };
    const deps = {
      workspaceEnvironmentService: { approveCommand },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "approve",
      method: "workspace.environment.command.approve",
      params,
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toBeUndefined();
    expect(approveCommand).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("routes automatic Setup retry with the target thread", async () => {
    const snapshot = { gate: "not-required", attempt: null, queuedTurns: [] };
    const retryAutomaticSetup = vi.fn().mockResolvedValue(snapshot);
    const params = { threadId: "thread-1" };
    const deps = {
      workspaceEnvironmentService: { retryAutomaticSetup },
    } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "retry",
      method: "workspace.environment.automaticSetup.retry",
      params,
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(snapshot);
    expect(retryAutomaticSetup).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("routes Project Action list with its thread id", async () => {
    const list = vi.fn().mockReturnValue([actionRun]);
    const deps = { projectActionService: { list } } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "action-list",
      method: "workspace.environment.action.list",
      params: { threadId: actionRun.threadId },
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ runs: [actionRun] });
    expect(list).toHaveBeenCalledExactlyOnceWith(actionRun.threadId);
  });

  it("routes Project Action get with its slot", async () => {
    const get = vi.fn().mockReturnValue(actionRun);
    const params = { threadId: actionRun.threadId, actionId: actionRun.actionId };
    const deps = { projectActionService: { get } } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "action-get",
      method: "workspace.environment.action.get",
      params,
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ run: actionRun });
    expect(get).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("routes Project Action start with its slot", async () => {
    const start = vi.fn().mockResolvedValue(actionRun);
    const params = { threadId: actionRun.threadId, actionId: actionRun.actionId };
    const deps = { projectActionService: { start } } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "action-start",
      method: "workspace.environment.action.start",
      params,
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(actionRun);
    expect(start).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("routes Project Action stop with its slot and wraps the retained run", async () => {
    const stop = vi.fn().mockResolvedValue(actionRun);
    const params = { threadId: actionRun.threadId, actionId: actionRun.actionId };
    const deps = { projectActionService: { stop } } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "action-stop",
      method: "workspace.environment.action.stop",
      params,
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ run: actionRun });
    expect(stop).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("routes Project Action restart with its slot", async () => {
    const restart = vi.fn().mockResolvedValue(actionRun);
    const params = { threadId: actionRun.threadId, actionId: actionRun.actionId };
    const deps = { projectActionService: { restart } } as unknown as RouterDeps;

    const response = await routeMessage(JSON.stringify({
      id: "action-restart",
      method: "workspace.environment.action.restart",
      params,
    }), deps);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(actionRun);
    expect(restart).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("routes strict automatic Setup recovery mutations", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const persistence = createThreadPersistenceTestRuntime();
    await persistence.writer.whenReady();
    const database = persistence.database;
    const workspaceEnvironmentService = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: persistence.reader,
      databaseWriter: persistence.writer,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true, worktree_path: "/project/.worktrees/first" } : null },
      platform: "linux",
    });
    const deps = {
      workspaceService: { findById: () => null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const continued = await routeMessage(JSON.stringify({
      id: "automatic-continue",
      method: "workspace.environment.automaticSetup.continue",
      params: { threadId: "thread-1" },
    }), deps);
    expect(continued.error).toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
    expect(continued.result).toBeUndefined();
    expect(workspaceEnvironmentService.getAutomaticSetup({ threadId: "thread-1" })).toEqual({
      gate: "not-required",
      attempt: null,
      queuedTurns: [],
    });

    const malformed = await routeMessage(JSON.stringify({
      id: "automatic-bad",
      method: "workspace.environment.automaticSetup.retry",
      params: { threadId: "thread-1", extra: true },
    }), deps);
    expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");

    database.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES ('workspace-1', 'Project', '/project', '{}')").run();
    database.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, provider) VALUES ('thread-1', 'workspace-1', 'Blocked Turn', 'worktree', 'main', 1, 'claude')").run();
    database.prepare("INSERT INTO workspace_environment_automatic_setup_attempts (id, thread_id, state, reason, created_at, finished_at) VALUES ('attempt', 'thread-1', 'failed', 'setup_failed', ?, ?)").run("2026-10-16T12:00:00.000Z", "2026-10-16T12:00:01.000Z");
    database.prepare("INSERT INTO workspace_environment_setup_gates (thread_id, state, attempt_id, created_at, updated_at) VALUES ('thread-1', 'blocked', 'attempt', ?, ?)").run("2026-10-16T12:00:00.000Z", "2026-10-16T12:00:01.000Z");

    const validContinue = await routeMessage(JSON.stringify({
      id: "automatic-continue-valid",
      method: "workspace.environment.automaticSetup.continue",
      params: { threadId: "thread-1" },
    }), deps);
    expect(validContinue.error).toBeUndefined();
    expect(validContinue.result).toMatchObject({
      gate: "released-by-continue",
      attempt: { state: "failed" },
      queuedTurns: [],
    });
  });
});
