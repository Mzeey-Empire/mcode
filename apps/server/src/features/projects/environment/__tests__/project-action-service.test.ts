import "reflect-metadata";
import { logger } from "@mcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import {
  WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  WorkspaceEnvironmentActionRunSchema,
  type WorkspaceEnvironmentActionRun,
} from "@mcode/contracts";
import {
  PreparedTerminalCommandApprovalMismatchError,
  PreparedTerminalCommandStartError,
  type ActionTerminal,
} from "../../../terminal/backends/terminal-backend.js";
import { ProjectActionService, PROJECT_ACTION_CLOCK_TOKEN, PROJECT_ACTION_RUN_ID_FACTORY_TOKEN } from "../project-action-service.js";
import { ProjectActionRunRepo } from "../persistence/project-action-run-repo.js";
import { WorkspaceEnvironmentService } from "../workspace-environment-service.js";
import { InMemoryPtyHostAdapter } from "../../../terminal/testing/in-memory-pty-host-adapter.js";
import { actionTerminalTestFixture, ACTION_TEST_THREAD, ACTION_TEST_WORKSPACE } from "../../../terminal/testing/action-terminal-test-fixture.js";
import { TERMINAL_BACKEND_TOKEN } from "../../../terminal/backends/terminal-backend.js";
import type { PtyHostCommand } from "../../../terminal/host/pty-host-adapter.js";

class Runs {
  private readonly values = new Map<string, WorkspaceEnvironmentActionRun>();
  get(threadId: string, actionId: string) { return this.values.get(`${threadId}\0${actionId}`) ?? null; }
  list(threadId: string) { return [...this.values.values()].filter((run) => run.threadId === threadId); }
  async replace(run: WorkspaceEnvironmentActionRun) { this.values.set(`${run.threadId}\0${run.actionId}`, run); return run; }
  async updateIfCurrent(run: WorkspaceEnvironmentActionRun) {
    const current = this.get(run.threadId, run.actionId);
    if (!current || current.runId !== run.runId) return false;
    await this.replace(run);
    return true;
  }
  async interruptRunning() { return []; }
}

function session(
  id: string,
  replay?: {
    readonly output?: string;
    readonly outputChunks?: readonly Uint8Array[];
    readonly exitCode?: number | null;
  },
  stopAction?: () => Promise<void>,
): ActionTerminal & {
  emit(data: string): void;
  emitBytes(data: Uint8Array): void;
  exit(code: number | null): void;
  close(): void;
  captureOutput(): (data: string) => void;
} {
  const outputs = new Set<(data: Uint8Array) => void>();
  const exits = new Set<(exit: { exitCode: number | null }) => void>();
  const closed = new Set<() => void>();
  return {
    terminalSessionId: id,
    snapshot: {
      platform: "windows",
      script: "bun run build",
      checkoutPath: "C:\\repo",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
      environmentNames: ["PATH"],
    },
    async run() {
      if (!this.snapshot) throw new Error("Missing test launch");
      return this.snapshot;
    },
    onClosed(listener) { closed.add(listener); return () => closed.delete(listener); },
    close() { for (const listener of closed) listener(); },
    onCommandOutput(listener) {
      outputs.add(listener);
      if (replay?.output !== undefined) listener(new TextEncoder().encode(replay.output));
      for (const output of replay?.outputChunks ?? []) listener(output);
      return () => outputs.delete(listener);
    },
    onCommandExit(listener) {
      exits.add(listener);
      if (replay?.exitCode !== undefined) listener({ exitCode: replay.exitCode });
      return () => exits.delete(listener);
    },
    async stopCommand() {
      if (stopAction) return stopAction();
      for (const listener of exits) listener({ exitCode: null });
    },
    captureOutput() { const listeners = [...outputs]; return (data) => { for (const listener of listeners) listener(Buffer.from(data)); }; },
    emit(data) { for (const listener of outputs) listener(new TextEncoder().encode(data)); },
    emitBytes(data) { for (const listener of outputs) listener(data); },
    exit(exitCode) { for (const listener of exits) listener({ exitCode }); },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const integrationCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of integrationCleanups.splice(0)) await cleanup();
});

class ActionTestHost extends InMemoryPtyHostAdapter {
  interruptOnInput = false;
  private readonly commands = new Set<string>();
  override async create(input: Parameters<InMemoryPtyHostAdapter["create"]>[0]) {
    if (input.launch.arguments.length > 0) this.commands.add(input.sessionId);
    return super.create(input);
  }
  override async send(command: PtyHostCommand): Promise<void> {
    await super.send(command);
    if (this.interruptOnInput && this.commands.has(command.sessionId) && command.kind === "input" && Buffer.from(command.data).toString() === "\u0003") {
      this.emitExit(command.sessionId, 130);
    }
  }
}

async function actionFixture(shared = false, script = "vite --open http://localhost:5173/") {
  const fixtureRoot = NodePath.resolve("../..", ".dev/fixture-repo");
  await NodeFSPromises.mkdir(fixtureRoot, { recursive: true });
  const root = await NodeFSPromises.mkdtemp(NodePath.join(fixtureRoot, "action-terminal-"));
  const host = new ActionTestHost("1");
  const creates = vi.spyOn(host, "create");
  const fixture = actionTerminalTestFixture(host, root, {
    id: "certified:windows-powershell-7", name: "PowerShell 7", executable: "pwsh.exe",
    arguments: [], source: "certified", platform: "windows",
  });
  const environment = new WorkspaceEnvironmentService({
    mcodeDir: NodePath.join(root, "data"), platform: "windows",
    threads: fixture.threads, workspaces: fixture.workspaces, terminalCommands: fixture.commands,
  });
  const document = { version: "0.0.1", actions: [{ id: "build", name: "Build", command: { default: script } }] };
  const sharedPath = NodePath.join(root, ".mcode/environment.json");
  if (shared) {
    await NodeFSPromises.mkdir(NodePath.dirname(sharedPath), { recursive: true });
    await NodeFSPromises.writeFile(sharedPath, JSON.stringify(document));
  } else {
    await environment.save({ workspaceId: ACTION_TEST_WORKSPACE, sourceRevision: null, document });
  }
  const runs = new Runs();
  fixture.scope.registerInstance<unknown>(ProjectActionRunRepo, runs);
  fixture.scope.registerInstance(WorkspaceEnvironmentService, environment);
  fixture.scope.registerInstance(TERMINAL_BACKEND_TOKEN, fixture.backend);
  fixture.scope.registerInstance(PROJECT_ACTION_CLOCK_TOKEN, () => new Date("2026-10-10T12:00:00.000Z"));
  let id = 0;
  fixture.scope.registerInstance(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN, () => `run-${++id}`);
  const actions = fixture.scope.resolve(ProjectActionService);
  integrationCleanups.push(async () => {
    await fixture.terminals.shutdown();
    await NodeFSPromises.rm(root, { recursive: true, force: true });
  });
  return { ...fixture, actions, runs, environment, host, creates, sharedPath, document };
}

const actionSlot = { threadId: ACTION_TEST_THREAD, actionId: "build" };

describe("ProjectActionService with the in-memory PTY host", () => {
  it("attaches to the action terminal and publishes coalesced command output with lifecycle changes", async () => {
    const f = await actionFixture();
    const updates: WorkspaceEnvironmentActionRun[] = [];
    f.actions.onUpdate((update) => updates.push(update.run));
    const bytes: Uint8Array[] = [];
    f.backend.setSender({ data: (_id, _seq, data) => bytes.push(data), json: () => undefined });
    const run = await f.actions.start(actionSlot);
    expect(run).toMatchObject({ trigger: "manual", status: "running", runId: "run-1" });
    expect(f.backend.listActiveSessions()).toEqual([expect.objectContaining({
      ptyId: run.terminalSessionId, kind: "action", actionId: "build", state: "running",
    })]);
    if (!run.terminalSessionId) throw new Error("Action did not create a terminal");
    expect(f.backend.reattach(run.terminalSessionId, -1)).toEqual({ mode: "delta" });
    const commandId = f.creates.mock.calls[0][0].sessionId;
    f.host.emitOutput(commandId, Buffer.from("ready\r\n"));
    f.host.emitOutput(commandId, Buffer.from("listening\r\n"));
    await vi.waitFor(() => expect(f.runs.get(ACTION_TEST_THREAD, "build")?.transcript).toBe("ready\r\nlistening\r\n"));
    await vi.waitFor(() => expect(updates.map((update) => update.transcript)).toEqual(["", "ready\r\n", "ready\r\nlistening\r\n"]));
    f.host.emitExit(commandId, 2);
    await vi.waitFor(() => expect(f.actions.get(actionSlot)).toMatchObject({ status: "failed", exitCode: 2 }));
    await vi.waitFor(() => expect(f.creates).toHaveBeenCalledTimes(2));
    f.host.emitOutput(f.creates.mock.calls[1][0].sessionId, Buffer.from("PS> "));
    bytes.length = 0;
    f.backend.reattach(run.terminalSessionId, -1);
    expect(Buffer.concat(bytes).toString()).toBe(
      `\u001b[90mPS ${f.creates.mock.calls[0][0].cwd}> \u001b[39mvite --open http://localhost:5173/\u001b[0m\r\nready\r\nlistening\r\nPS> `,
    );
    expect(f.actions.get(actionSlot)?.transcript).toBe("ready\r\nlistening\r\n");
    expect(updates.map((update) => update.status)).toEqual(["running", "running", "running", "failed"]);
    expect(await f.actions.start(actionSlot)).toEqual(f.actions.get(actionSlot));
    expect(f.creates).toHaveBeenCalledTimes(2);
  });

  it.each([130, 0xC000013A, -1073741510])("maps interrupt exit %s and leaves a live shell", async (code) => {
    const f = await actionFixture();
    const run = await f.actions.start(actionSlot);
    f.host.emitExit(f.creates.mock.calls[0][0].sessionId, code);
    await vi.waitFor(() => expect(f.actions.get(actionSlot)).toMatchObject({
      status: "interrupted", exitCode: null, terminalSessionId: run.terminalSessionId,
    }));
    await vi.waitFor(() => expect(f.creates).toHaveBeenCalledTimes(2));
    if (!run.terminalSessionId) throw new Error("Missing action terminal");
    await f.backend.write(run.terminalSessionId, "echo alive\r");
  });

  it("stops with Ctrl C then kills at five seconds and keeps the shell", async () => {
    const f = await actionFixture();
    const send = vi.spyOn(f.host, "send");
    const close = vi.spyOn(f.host, "close");
    const run = await f.actions.start(actionSlot);
    vi.useFakeTimers();
    const stopping = f.actions.stop(actionSlot);
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.map(([command]) => command.kind === "input" ? Buffer.from(command.data).toString() : "")).toEqual(["\u0003"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(close.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(close).toHaveBeenCalledOnce();
    expect(f.actions.get(actionSlot)).toMatchObject({ status: "interrupted", terminalSessionId: run.terminalSessionId });
    expect(f.creates).toHaveBeenCalledTimes(2);
    expect(f.creates.mock.calls[1][0].launch.arguments).toEqual([]);
  });

  it("closes an active command without leaving a shell and clears the run terminal id", async () => {
    const f = await actionFixture();
    const run = await f.actions.start(actionSlot);
    if (!run.terminalSessionId) throw new Error("Missing action terminal");
    await f.backend.kill(run.terminalSessionId);
    await vi.waitFor(() => expect(f.actions.get(actionSlot)).toMatchObject({
      status: "interrupted", terminalSessionId: null,
    }));
    expect(f.backend.listActiveSessions()).toEqual([]);
    expect(f.creates).toHaveBeenCalledOnce();
  });

  it("restarts commands and runs again from shells without waiting five seconds", async () => {
    const f = await actionFixture();
    f.host.interruptOnInput = true;
    const send = vi.spyOn(f.host, "send");
    const close = vi.spyOn(f.host, "close");
    const run = await f.actions.start(actionSlot);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const restart = f.actions.restart(actionSlot);
    expect(await restart).toMatchObject({ runId: "run-2", terminalSessionId: run.terminalSessionId, status: "running" });
    expect(f.creates).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([command]) => ({ sessionId: command.sessionId, data: command.kind === "input" ? Buffer.from(command.data).toString() : null }))).toEqual([
      { sessionId: f.creates.mock.calls[0][0].sessionId, data: "\u0003" },
    ]);
    const command = f.creates.mock.calls.at(-1)?.[0];
    if (!command) throw new Error("Missing rerun process");
    f.host.emitExit(command.sessionId, 0);
    await vi.waitFor(() => expect(f.actions.get(actionSlot)?.status).toBe("completed"));
    const again = f.actions.restart(actionSlot);
    expect(await again).toMatchObject({ runId: "run-3", terminalSessionId: run.terminalSessionId, status: "running" });
    expect(f.creates).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledTimes(1);
    expect(close.mock.calls.map(([process]) => process.sessionId)).toEqual([f.creates.mock.calls[2][0].sessionId]);
    expect(f.backend.listActiveSessions()).toHaveLength(1);
  });

  it("leaves a live shell untouched when Stop has no command to interrupt", async () => {
    const f = await actionFixture();
    const send = vi.spyOn(f.host, "send");
    const close = vi.spyOn(f.host, "close");
    await f.actions.start(actionSlot);
    f.host.emitExit(f.creates.mock.calls[0][0].sessionId, 0);
    await vi.waitFor(() => expect(f.actions.get(actionSlot)?.status).toBe("completed"));
    const retained = f.actions.get(actionSlot);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await f.actions.stop(actionSlot)).toEqual(retained);
    expect(send.mock.calls).toEqual([]);
    expect(close.mock.calls).toEqual([]);
    expect(f.creates).toHaveBeenCalledTimes(2);
    expect(f.backend.listActiveSessions()[0].state).toBe("running");
  });

  it.each(["thread", "dispose"])("closes commands and retained shells during %s teardown", async (kind) => {
    const f = await actionFixture();
    await f.actions.start(actionSlot);
    if (kind === "dispose") {
      f.host.emitExit(f.creates.mock.calls[0][0].sessionId, 0);
      await vi.waitFor(() => expect(f.actions.get(actionSlot)?.status).toBe("completed"));
      const first = f.actions.dispose();
      expect(f.actions.dispose()).toBe(first);
      await first;
    } else {
      await f.actions.stopForThread(ACTION_TEST_THREAD);
    }
    expect(f.actions.get(actionSlot)).toMatchObject({
      status: kind === "dispose" ? "completed" : "interrupted", terminalSessionId: null,
    });
    expect(f.backend.listActiveSessions()).toEqual([]);
    expect(f.creates).toHaveBeenCalledTimes(kind === "dispose" ? 2 : 1);
  });

  it.each([
    { phase: "first launch", boundary: "start" },
    { phase: "first launch", boundary: "create" },
    { phase: "replacement", boundary: "start" },
    { phase: "replacement", boundary: "create" },
  ])("records a close during $phase at host $boundary as interrupted", async ({ phase, boundary }) => {
    const f = await actionFixture();
    if (phase === "replacement") {
      await f.actions.start(actionSlot);
      f.host.emitExit(f.creates.mock.calls[0][0].sessionId, 0);
      await vi.waitFor(() => expect(f.actions.get(actionSlot)?.status).toBe("completed"));
    }
    const entered = deferred<void>();
    const release = deferred<void>();
    const startHost = f.host.start.bind(f.host);
    if (boundary === "start") {
      vi.spyOn(f.host, "start").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return startHost();
      });
    } else {
      const createHost = f.host.create.bind(f.host);
      f.creates.mockImplementationOnce(async (input) => {
        entered.resolve();
        await release.promise;
        return createHost(input);
      });
    }
    const starting = phase === "first launch" ? f.actions.start(actionSlot) : f.actions.restart(actionSlot);
    await entered.promise;
    const closing = f.backend.kill(f.backend.listActiveSessions()[0].ptyId);
    release.resolve();
    await closing;
    expect(await starting).toMatchObject({ status: "interrupted", terminalSessionId: null });
    expect(f.actions.get(actionSlot)).toMatchObject({ status: "interrupted", terminalSessionId: null });
    expect(f.backend.listActiveSessions()).toEqual([]);
  });

  it("reports the named cap error for eight retained shells without consuming an action slot", async () => {
    const f = await actionFixture();
    for (let i = 0; i < 8; i++) {
      const terminal = await f.backend.create(ACTION_TEST_THREAD);
      f.host.emitExit(terminal.ptyId, 0);
    }
    await expect(f.actions.start(actionSlot)).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_TERMINAL_CAP", message: "8 terminals are open. Close one to run Build.",
    });
    expect(f.actions.get(actionSlot)).toBeNull();
    await f.backend.kill(f.backend.listActiveSessions()[0].ptyId);
    expect(await f.actions.start(actionSlot)).toMatchObject({ status: "running" });
  });

  it("opens pending approval without a process, reuses approval, and asks again after the script changes", async () => {
    const f = await actionFixture(true);
    f.host.interruptOnInput = true;
    const pending = await f.actions.start(actionSlot);
    expect(pending.status).toBe("awaiting-approval");
    expect(f.backend.listActiveSessions()[0]).toMatchObject({ state: "pending", ptyId: pending.terminalSessionId });
    expect(f.creates.mock.calls).toEqual([]);
    if (!pending.snapshot.approval) throw new Error("Missing shared approval");
    await f.environment.approveCommand({ threadId: ACTION_TEST_THREAD, ...pending.snapshot.approval });
    const approved = await f.actions.start(actionSlot);
    expect(approved).toMatchObject({ status: "running", terminalSessionId: pending.terminalSessionId });
    f.host.emitExit(f.creates.mock.calls[0][0].sessionId, 0);
    await vi.waitFor(() => expect(f.actions.get(actionSlot)?.status).toBe("completed"));
    const restarting = f.actions.restart(actionSlot);
    expect(await restarting).toMatchObject({ status: "running", terminalSessionId: pending.terminalSessionId });
    await NodeFSPromises.writeFile(f.sharedPath, JSON.stringify({
      ...f.document, actions: [{ id: "build", name: "Build", command: { default: "vite --host" } }],
    }));
    const changed = f.actions.restart(actionSlot);
    expect(await changed).toMatchObject({ status: "awaiting-approval", snapshot: { script: "vite --host" } });
  });

  it("clears a pending terminal closed while its initial run is still being saved", async () => {
    const f = await actionFixture(true);
    const saving = deferred<void>();
    const release = deferred<void>();
    const replace = f.runs.replace.bind(f.runs);
    vi.spyOn(f.runs, "replace").mockImplementationOnce(async (run) => {
      saving.resolve();
      await release.promise;
      return replace(run);
    });
    const starting = f.actions.start(actionSlot);
    await saving.promise;
    const terminal = f.backend.listActiveSessions()[0];
    await f.backend.kill(terminal.ptyId);
    release.resolve();
    await starting;
    await vi.waitFor(() => expect(f.actions.get(actionSlot)).toMatchObject({
      status: "interrupted", terminalSessionId: null,
    }));
    expect(f.backend.listActiveSessions()).toEqual([]);
    expect(f.creates.mock.calls).toEqual([]);
  });
});

function projectActionEnvironment(read: () => Promise<{
  readonly document: {
    readonly actions: readonly { readonly id: string; readonly name: string; readonly command: { readonly default?: string; readonly windows?: string } }[];
  };
}>) {
  return {
    async resolveActionCommand(_threadId: string, actionId: string) {
      const document = (await read()).document;
      const action = document.actions.find((candidate) => candidate.id === actionId);
      if (!action) throw new Error("Project Action not found");
      const script = action.command.windows ?? action.command.default;
      if (!script) throw new Error("Project Action is unavailable");
      return {
        kind: "ready" as const,
        action,
        script,
        command: { close: async () => ({ kind: "contained" as const }) },
        snapshot: {
          platform: "windows" as const,
          script,
          checkoutPath: "C:\\repo",
          terminal: { executable: "powershell.exe", arguments: ["-Command", script] },
          approval: null,
        },
        approval: null,
      };
    },
  };
}

describe("ProjectActionService", () => {
  it("requires a fresh shared-command review when the Terminal launch changes after approval", async () => {
    const runs = new Runs();
    let resolutionCount = 0;
    const environment = {
      async resolveActionCommand() {
        resolutionCount += 1;
        const script = resolutionCount === 1 ? "bun run build" : "bun run build --fresh";
        const approval = resolutionCount === 1
          ? null
          : { target: { kind: "action" as const, actionId: "build" }, fingerprint: "b".repeat(64) };
        return {
          kind: "ready" as const,
          action: { id: "build", name: "Build", command: { default: script } },
          script,
          command: { close: async () => ({ kind: "contained" as const }) },
          snapshot: {
            platform: "windows" as const,
            script,
            checkoutPath: "C:\\repo",
            terminal: { executable: "powershell.exe", arguments: ["-Command", script] },
            approval,
          },
          approval,
        };
      },
    };
    const openActionTerminal = vi.fn(async (input: { launch: unknown }) => {
      if (input.launch === "pending-approval") return session("pending-terminal");
      throw new PreparedTerminalCommandApprovalMismatchError({
        platform: "windows",
        script: "bun run build --fresh",
        checkoutPath: "C:\\repo",
        terminal: { executable: "pwsh.exe", arguments: ["-Command", "bun run build --fresh"] },
        environmentNames: [],
      });
    });
    const service = new ProjectActionService(
      runs as never,
      environment as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const run = await service.start({ threadId: "thread-1", actionId: "build" });

    expect(openActionTerminal).toHaveBeenCalledWith(expect.objectContaining({
      launch: {
        script: "bun run build",
        expectedLaunch: { terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] } },
      },
    }));
    expect(run).toMatchObject({
      status: "awaiting-approval",
      snapshot: { script: "bun run build --fresh", approval: { fingerprint: "b".repeat(64) } },
    });
  });

  it("excludes one slot, allows a second Action, preserves its immutable snapshot, and ignores stale output", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const sessions = [first, second];
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => sessions.shift()! } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );

    const build = await service.start({ threadId: "thread-1", actionId: "build" });
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toEqual(build);
    const test = await service.start({ threadId: "thread-1", actionId: "test" });
    expect(test.runId).not.toBe(build.runId);
    expect(build.snapshot.terminal?.arguments).toEqual(["-Command", "bun run build"]);

    first.emit("old output");
    first.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runs.get("thread-1", "build")).toMatchObject({ status: "completed", revision: 2 });
    expect(runs.get("thread-1", "test")?.status).toBe("running");
  });

  it("reserves a slot while its environment document is still loading", async () => {
    const runs = new Runs();
    const environmentRead = deferred<{ readonly document: { readonly version: "0.0.1"; readonly actions: readonly [{ readonly id: "build"; readonly name: "Build"; readonly command: { readonly default: "bun run build" } }] } }>();
    const openActionTerminal = vi.fn(async () => session("terminal-1"));
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(() => environmentRead.promise),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const firstStart = service.start({ threadId: "thread-1", actionId: "build" });
    const secondStart = service.start({ threadId: "thread-1", actionId: "build" });

    expect(openActionTerminal).not.toHaveBeenCalled();
    environmentRead.resolve({ document: { version: "0.0.1", actions: [
      { id: "build", name: "Build", command: { default: "bun run build" } },
    ] } });
    await expect(secondStart).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING" });
    await firstStart;

    expect(openActionTerminal).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight Action start before stopping the prepared session", async () => {
    const runs = new Runs();
    const startup = deferred<ActionTerminal>();
    const backendStarted = deferred<void>();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      {
        openActionTerminal: () => {
          backendStarted.resolve();
          return startup.promise;
        },
      } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const launching = service.start({ threadId: "thread-1", actionId: "build" });
    await backendStarted.promise;
    const stopping = service.stop({ threadId: "thread-1", actionId: "build" });
    startup.resolve(prepared);

    await Promise.all([launching, stopping]);
    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("starts a replacement only after the prior Action stop barrier closes", async () => {
    const runs = new Runs();
    const stopBarrier = deferred<void>();
    let first!: ReturnType<typeof session>;
    const stop = vi.fn(async () => {
      await stopBarrier.promise;
      first.exit(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    });
    first = session("terminal-1", undefined, stop);
    const second = session("terminal-2");
    const openActionTerminal = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    const restarting = service.restart({ threadId: "thread-1", actionId: "build" });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(openActionTerminal).toHaveBeenCalledOnce();

    stopBarrier.resolve(undefined);
    await expect(restarting).resolves.toMatchObject({ runId: "run-2", terminalSessionId: "terminal-1" });
    expect(openActionTerminal).toHaveBeenCalledOnce();
  });

  it("persists a fast replayed exit as completed after the initial Action row exists", async () => {
    const runs = new Runs();
    const fast = session("terminal-1", { output: "fast output", exitCode: 0 });
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => fast } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await service.start({ threadId: "thread-1", actionId: "build" });

    expect(runs.get("thread-1", "build")).toMatchObject({
      status: "completed",
      transcript: "fast output",
      exitCode: 0,
    });
  });

  it("closes Action admission before thread teardown waits for an in-flight start", async () => {
    const runs = new Runs();
    const startup = deferred<ActionTerminal>();
    const enteredBackend = deferred<void>();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: () => { enteredBackend.resolve(); return startup.promise; } } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const launching = service.start({ threadId: "thread-1", actionId: "build" });
    await enteredBackend.promise;
    const tearingDown = service.beginThreadTeardown("thread-1");
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    startup.resolve(prepared);
    await launching;
    const release = await tearingDown;
    await service.stop({ threadId: "thread-1", actionId: "build" });
    release();

    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("keeps admission closed until every concurrent thread teardown releases its gate", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const firstRelease = await service.beginThreadTeardown("thread-1");
    const secondRelease = await service.beginThreadTeardown("thread-1");
    firstRelease();
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    secondRelease();

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({ status: "running" });
  });

  it("rejects starts while completed or disposed and restores admission only after reopen", async () => {
    const runs = new Runs();
    const thread = { id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: "2026-08-22T12:00:00.000Z" as string | null };
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => thread } as never,
      { openActionTerminal: async () => prepared, kill: async () => prepared.close() } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    thread.user_completed_at = null;
    service.reopenThread(thread.id);
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({ status: "running" });
    await service.dispose();
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
  });

  it("shares one idempotent shutdown barrier and stops its owned session once", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const close = vi.spyOn(prepared, "close");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared, kill: async () => prepared.close() } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    const first = service.dispose();
    const second = service.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(close).toHaveBeenCalledOnce();
    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("waits for an admitted start, stops it during shutdown, and rejects later starts", async () => {
    const runs = new Runs();
    const startup = deferred<ActionTerminal>();
    const enteredBackend = deferred<void>();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: () => { enteredBackend.resolve(); return startup.promise; }, kill: async () => prepared.close() } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const launching = service.start({ threadId: "thread-1", actionId: "build" });
    await enteredBackend.promise;
    const shuttingDown = service.dispose();
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    startup.resolve(prepared);

    await Promise.all([launching, shuttingDown]);
    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("retains a failed planned attempt without disturbing a concurrent Action result", async () => {
    const runs = new Runs();
    const successful = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      {
        openActionTerminal: vi.fn()
          .mockResolvedValueOnce(successful)
          .mockRejectedValueOnce(new Error("capacity reached")),
      } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );

    await service.start({ threadId: "thread-1", actionId: "build" });
    const failed = await service.start({ threadId: "thread-1", actionId: "test" });

    expect(failed).toMatchObject({
      status: "failed",
      terminalSessionId: null,
      startedAt: "2026-08-22T12:00:00.001Z",
      snapshot: {
        script: "bun test",
        terminal: { executable: "powershell.exe", arguments: ["-Command", "bun test"] },
        environmentNames: [],
      },
    });
    expect(runs.get("thread-1", "build")?.status).toBe("running");
  });

  it("retains resolved launch facts without inventing a terminal identity after pre-spawn failure", async () => {
    const runs = new Runs();
    const plannedSnapshot = {
      platform: "windows" as const,
      script: "bun run build",
      checkoutPath: "C:\\repo\\thread-1",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
      environmentNames: ["PATH"],
    };
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => { throw new PreparedTerminalCommandStartError(plannedSnapshot, new Error("host unavailable")); } } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const failed = await service.start({ threadId: "thread-1", actionId: "build" });

    expect(failed).toMatchObject({
      status: "failed",
      terminalSessionId: null,
      snapshot: plannedSnapshot,
    });
  });

  it("closes a prepared session when retained-run persistence fails and preserves that failure", async () => {
    const prepared = session("terminal-1");
    const stop = vi.spyOn(prepared, "stopCommand");
    const persistenceFailure = new Error("database unavailable");
    const service = new ProjectActionService(
      { get: () => null, list: () => [], replace: () => { throw persistenceFailure; }, updateIfCurrent: () => false, interruptRunning: () => [] } as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toBe(persistenceFailure);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preserves the initial persistence failure after a fast exit already released its prepared session", async () => {
    const persistenceFailure = new Error("database unavailable");
    const stop = vi.fn(async () => undefined);
    const prepared = session("terminal-1", { output: "fast output", exitCode: 0 }, stop);
    const updateIfCurrent = vi.fn(() => false);
    const service = new ProjectActionService(
      {
        get: () => null,
        list: () => [],
        replace: () => { throw persistenceFailure; },
        updateIfCurrent,
        interruptRunning: () => [],
      } as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toBe(persistenceFailure);

    expect(stop).toHaveBeenCalledOnce();
    expect(updateIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      status: "interrupted",
      transcript: "",
    }));
  });

  it("keeps a failed-compensation session owned until a later stop succeeds", async () => {
    const runs = new Runs();
    const persistenceFailure = new Error("database unavailable");
    const cleanupFailure = new Error("terminal close unavailable");
    let prepared!: ReturnType<typeof session>;
    const stop = vi.fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockImplementationOnce(async () => prepared.exit(null));
    prepared = session("terminal-1", undefined, stop);
    const replacement = session("terminal-2");
    const replace = vi.spyOn(runs, "replace")
      .mockImplementationOnce(() => { throw persistenceFailure; });
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: vi.fn().mockResolvedValueOnce(prepared).mockResolvedValueOnce(replacement) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );

    const failure = await service.start({ threadId: "thread-1", actionId: "build" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([persistenceFailure, cleanupFailure]);
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    });

    replace.mockRestore();
    await service.stop({ threadId: "thread-1", actionId: "build" });
    await expect(service.restart({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-1",
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("retries one exact natural-exit finalization during stop after persistence fails", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    const persistenceFailure = new Error("database unavailable");
    updateIfCurrent
      .mockImplementationOnce(() => { throw persistenceFailure; })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    expect(() => first.exit(0)).not.toThrow();
    expect(runs.get("thread-1", "build")).toMatchObject({ status: "running", revision: 0 });
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    });

    await service.stop({ threadId: "thread-1", actionId: "build" });

    expect(runs.get("thread-1", "build")).toMatchObject({
      runId: "run-1",
      status: "completed",
      revision: 1,
      exitCode: 0,
    });
    expect(updateIfCurrent.mock.calls.map(([run]) => ({
      runId: run.runId,
      status: run.status,
      revision: run.revision,
      exitCode: run.exitCode,
    }))).toEqual([
      { runId: "run-1", status: "completed", revision: 1, exitCode: 0 },
      { runId: "run-1", status: "completed", revision: 1, exitCode: 0 },
    ]);
    await expect(service.restart({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-1",
    });
  });

  it("retries a pending natural-exit finalization before restarting its slot", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    updateIfCurrent
      .mockImplementationOnce(() => { throw new Error("database unavailable"); })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    first.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const restarted = await service.restart({ threadId: "thread-1", actionId: "build" });

    expect(restarted).toMatchObject({ runId: "run-2", terminalSessionId: "terminal-1", status: "running" });
    expect(updateIfCurrent.mock.calls.map(([run]) => ({
      runId: run.runId,
      status: run.status,
      revision: run.revision,
    }))).toEqual([
      { runId: "run-1", status: "completed", revision: 1 },
      { runId: "run-1", status: "completed", revision: 1 },
    ]);
  });

  it("retries a pending natural-exit finalization during disposal without retaining the slot", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    updateIfCurrent
      .mockImplementationOnce(() => { throw new Error("database unavailable"); })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared, kill: async () => prepared.close() } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    prepared.exit(3);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await service.dispose();
    await service.stop({ threadId: "thread-1", actionId: "build" });

    expect(runs.get("thread-1", "build")).toMatchObject({
      runId: "run-1",
      status: "failed",
      revision: 2,
      exitCode: 3,
      terminalSessionId: null,
    });
    expect(updateIfCurrent.mock.calls.map(([run]) => ({
      status: run.status,
      revision: run.revision,
      exitCode: run.exitCode,
    }))).toEqual([
      { status: "failed", revision: 1, exitCode: 3 },
      { status: "failed", revision: 1, exitCode: 3 },
      { status: "failed", revision: 2, exitCode: 3 },
    ]);
  });

  it("releases an Action slot after final persistence even if a push listener throws", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    const listenerFailure = new Error("push unavailable");
    service.onUpdate((update) => {
      if (update.run.status === "completed") throw listenerFailure;
    });

    const publicationFailure = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    first.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.waitFor(() => expect(publicationFailure).toHaveBeenCalledWith("Project Action completion publication failed", expect.objectContaining({ error: listenerFailure.message })));
    publicationFailure.mockRestore();
    expect(runs.get("thread-1", "build")?.status).toBe("completed");
    await expect(service.restart({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-1",
    });
  });

  it("keeps terminal output and final persistence alive after an output write failure", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    updateIfCurrent
      .mockImplementationOnce(() => { throw new Error("database unavailable"); })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    expect(() => prepared.emit("retained output")).not.toThrow();
    prepared.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runs.get("thread-1", "build")).toMatchObject({
      status: "completed",
      transcript: "retained output",
      revision: 2,
      exitCode: 0,
    });
  });

  it("retains a valid UTF-8 suffix when a four-byte character crosses the transcript boundary", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    prepared.emit(`x😀${"z".repeat(WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES - 3)}`);
    prepared.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const run = runs.get("thread-1", "build");
    expect(run).toMatchObject({
      status: "completed",
      revision: 2,
      transcript: "z".repeat(WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES - 3),
      transcriptTruncated: true,
    });
    expect(new TextEncoder().encode(run?.transcript).byteLength).toBeLessThanOrEqual(
      WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
    );
    expect(run?.transcript).not.toContain("�");
    expect(WorkspaceEnvironmentActionRunSchema().parse(run)).toEqual(run);
  });

  it("decodes a four-byte character split across output calls without persisting a replacement character", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    prepared.emitBytes(new Uint8Array([0xf0, 0x9f]));
    expect(runs.get("thread-1", "build")).toMatchObject({ revision: 0, transcript: "" });
    prepared.emitBytes(new Uint8Array([0x98, 0x80]));
    prepared.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const run = runs.get("thread-1", "build");
    expect(run).toMatchObject({
      status: "completed",
      revision: 2,
      transcript: "😀",
      transcriptTruncated: false,
    });
    expect(run?.transcript).not.toContain("�");
    expect(WorkspaceEnvironmentActionRunSchema().parse(run)).toEqual(run);
  });

  it("decodes replayed output chunks that split a four-byte character", async () => {
    const runs = new Runs();
    const replayed = session("terminal-1", {
      outputChunks: [new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80])],
      exitCode: 0,
    });
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => replayed } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await service.start({ threadId: "thread-1", actionId: "build" });

    const run = runs.get("thread-1", "build");
    expect(run).toMatchObject({ status: "completed", revision: 2, transcript: "😀" });
    expect(run?.transcript).not.toContain("�");
    expect(WorkspaceEnvironmentActionRunSchema().parse(run)).toEqual(run);
  });

  it("flushes an incomplete trailing output sequence during finalization", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    prepared.emitBytes(new Uint8Array([0xf0, 0x9f]));
    prepared.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const run = runs.get("thread-1", "build");
    expect(run).toMatchObject({ status: "completed", revision: 2, transcript: "�" });
    expect(WorkspaceEnvironmentActionRunSchema().parse(run)).toEqual(run);
  });

  it("releases a reserved slot when environment resolution fails before terminal launch", async () => {
    const runs = new Runs();
    const resolutionFailure = new Error("environment document unavailable");
    const prepared = session("terminal-1");
    const resolveActionCommand = vi.fn()
      .mockRejectedValueOnce(resolutionFailure)
      .mockResolvedValueOnce({
        kind: "ready" as const,
        action: { id: "build", name: "Build", command: { default: "bun run build" } },
        script: "bun run build",
        command: { close: async () => ({ kind: "contained" as const }) },
        snapshot: {
          platform: "windows" as const,
          script: "bun run build",
          checkoutPath: "C:\\repo",
          terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
          approval: null,
        },
        approval: null,
      });
    const openActionTerminal = vi.fn(async () => prepared);
    const service = new ProjectActionService(
      runs as never,
      { resolveActionCommand } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toBe(resolutionFailure);
    await expect(service.restart({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-1",
    });

    expect(openActionTerminal).toHaveBeenCalledOnce();
  });

  it("ignores output delivered after finalization and after a replacement owns the slot", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const service = new ProjectActionService(
      runs as never,
      projectActionEnvironment(async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } })),
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    const staleOutput = first.captureOutput();
    first.exit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.emit("after finalization");

    expect(runs.get("thread-1", "build")).toMatchObject({
      runId: "run-1",
      status: "completed",
      revision: 1,
      transcript: "",
    });

    await service.restart({ threadId: "thread-1", actionId: "build" });
    staleOutput("after replacement");

    expect(runs.get("thread-1", "build")).toMatchObject({
      runId: "run-2",
      status: "running",
      revision: 0,
      transcript: "",
    });
  });

  it("prevents a workspace teardown race from launching a resolved Action", async () => {
    const runs = new Runs();
    const resolution = deferred<{
      readonly kind: "ready";
      readonly action: { readonly id: "build"; readonly name: "Build"; readonly command: { readonly default: "bun run build" } };
      readonly script: "bun run build";
      readonly command: { readonly close: () => Promise<{ readonly kind: "contained" }> };
      readonly snapshot: {
        readonly platform: "windows";
        readonly script: "bun run build";
        readonly checkoutPath: "C:\\repo";
        readonly terminal: { readonly executable: "powershell.exe"; readonly arguments: readonly ["-Command", "bun run build"] };
        readonly approval: null;
      };
      readonly approval: null;
    }>();
    const resolving = deferred<void>();
    const openActionTerminal = vi.fn(async () => session("terminal-1"));
    const service = new ProjectActionService(
      runs as never,
      {
        async resolveActionCommand() {
          resolving.resolve(undefined);
          return await resolution.promise;
        },
      } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { openActionTerminal } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const starting = service.start({ threadId: "thread-1", actionId: "build" });
    await resolving.promise;
    const tearingDown = service.beginWorkspaceTeardown("workspace-1");
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    resolution.resolve({
      kind: "ready",
      action: { id: "build", name: "Build", command: { default: "bun run build" } },
      script: "bun run build",
      command: { close: async () => ({ kind: "contained" }) },
      snapshot: {
        platform: "windows",
        script: "bun run build",
        checkoutPath: "C:\\repo",
        terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
        approval: null,
      },
      approval: null,
    });

    await expect(starting).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_NOT_FOUND" });
    const release = await tearingDown;
    release();

    expect(openActionTerminal).not.toHaveBeenCalled();
  });

  it("reaps every stale Action batch instead of stopping after the first 256 rows", async () => {
    const first = Array.from({ length: 256 }, (_, index) => ({ actionId: `first-${index}` } as WorkspaceEnvironmentActionRun));
    const second = Array.from({ length: 2 }, (_, index) => ({ actionId: `second-${index}` } as WorkspaceEnvironmentActionRun));
    const interruptRunning = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const service = new ProjectActionService(
      { get: () => null, list: () => [], replace: vi.fn(), updateIfCurrent: () => false, interruptRunning } as never,
      {} as never,
      {} as never,
      {} as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
    );

    expect(await service.recoverStaleRuns()).toHaveLength(258);
    expect(interruptRunning).toHaveBeenCalledTimes(2);
  });
});
