import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentAction, ThreadStartupAction } from "@mcode/contracts";
import { createOwnedTestDatabase } from "../../testing/owned-test-database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { InMemoryPtyHostAdapter } from "../../../terminal/testing/in-memory-pty-host-adapter.js";
import { actionTerminalTestFixture, ACTION_TEST_THREAD, ACTION_TEST_WORKSPACE } from "../../../terminal/testing/action-terminal-test-fixture.js";
import type { PtyHostCommand } from "../../../terminal/host/pty-host-adapter.js";
import { TERMINAL_BACKEND_TOKEN } from "../../../terminal/backends/terminal-backend.js";
import { ProjectActionService, PROJECT_ACTION_CLOCK_TOKEN, PROJECT_ACTION_RUN_ID_FACTORY_TOKEN } from "../project-action-service.js";
import { ProjectActionRunRepo } from "../persistence/project-action-run-repo.js";
import { WorkspaceEnvironmentService } from "../workspace-environment-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const slot = { threadId: ACTION_TEST_THREAD, actionId: "install" };
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 2000, interval: 5 });

class StartupHost extends InMemoryPtyHostAdapter {
  override async send(command: PtyHostCommand): Promise<void> {
    await super.send(command);
    if (command.kind === "input" && Buffer.from(command.data).toString() === "\u0003") {
      this.emitExit(command.sessionId, 130);
    }
  }
}

function action(id: string, script = "echo ready"): WorkspaceEnvironmentAction {
  return { id, name: id, command: { default: script }, runOnStartup: true };
}

async function harness({ actions = [action("install")], shared = false, managed = true, legacy = false }:
  { actions?: WorkspaceEnvironmentAction[]; shared?: boolean; managed?: boolean; legacy?: boolean } = {}) {
  const fixtureRoot = NodePath.resolve("../..", ".dev/fixture-repo");
  await NodeFSPromises.mkdir(fixtureRoot, { recursive: true });
  const root = await NodeFSPromises.mkdtemp(NodePath.join(fixtureRoot, "startup-"));
  const owned = createOwnedTestDatabase();
  owned.db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, 'Fixture', ?, '{}')")
    .run(ACTION_TEST_WORKSPACE, root);
  owned.db.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, worktree_path, provider) VALUES (?, ?, 'First turn', 'worktree', 'main', ?, ?, 'claude')")
    .run(ACTION_TEST_THREAD, ACTION_TEST_WORKSPACE, Number(managed), root);
  const reader = openReadOnlyDatabase(owned.db.filename);
  const threads = new ThreadRepo(reader, owned.writer);
  const startups = new ThreadStartupService(new ThreadStartupRepo(reader, owned.writer), owned.writer);
  const host = new StartupHost("1");
  const creates = vi.spyOn(host, "create");
  const fixture = actionTerminalTestFixture(host, root, {
    id: "certified:windows-powershell-7", name: "PowerShell 7", executable: "pwsh.exe",
    arguments: [], source: "certified", platform: "windows",
  });
  const options = {
    mcodeDir: NodePath.join(root, "data"), platform: "windows" as const,
    threads, workspaces: fixture.workspaces, terminalCommands: fixture.commands,
    threadStartups: startups, database: reader, databaseWriter: owned.writer,
    projectActions: () => projectActions,
  };
  const service = new WorkspaceEnvironmentService(options);
  const projectActions = new ProjectActionService(
    new ProjectActionRunRepo(reader, owned.writer), service, threads, fixture.backend,
  );
  fixture.scope.registerInstance(WorkspaceEnvironmentService, service);
  fixture.scope.registerInstance(TERMINAL_BACKEND_TOKEN, fixture.backend);
  fixture.scope.registerInstance(PROJECT_ACTION_CLOCK_TOKEN, () => new Date());
  fixture.scope.registerInstance(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN, NodeCrypto.randomUUID);
  const document = legacy
    ? { version: "0.0.1", setup: { default: "bun install" }, actions: [] }
    : { version: "0.1.0", actions };
  const file = shared ? NodePath.join(root, ".mcode/environment.json") : service.filePath(ACTION_TEST_WORKSPACE);
  await NodeFSPromises.mkdir(NodePath.dirname(file), { recursive: true });
  const bytes = JSON.stringify(document);
  await NodeFSPromises.writeFile(file, bytes);
  const startupId = NodeCrypto.randomUUID();
  await startups.start({ startupId, workspaceId: ACTION_TEST_WORKSPACE, kind: managed ? "managed-worktree" : "attached-worktree" });
  await startups.advance(startupId, "thread");
  await startups.bindThread(startupId, ACTION_TEST_THREAD);
  await startups.advance(startupId, "worktree");
  await startups.advance(startupId, "setup");
  const dispatched: string[] = [];
  service.setAutomaticSetupDispatcher({
    dispatch: async (submission) => {
      dispatched.push(submission.messageId);
      await startups.advance(startupId, "agent");
      return { completion: Promise.resolve() };
    },
  });
  cleanups.push(async () => {
    await service.dispose();
    await fixture.terminals.shutdown();
    await projectActions.dispose();
    reader.close(true);
    await owned.close();
    await NodeFSPromises.rm(root, { recursive: true, force: true });
  });
  return {
    service, projectActions, startups, startupId, host, creates, reader, owned, options, dispatched, file, bytes,
    gate: () => service.getAutomaticSetup({ threadId: ACTION_TEST_THREAD }),
    commandId: () => {
      const call = creates.mock.calls.at(-1);
      if (!call) throw new Error("Command has not started");
      return call[0].sessionId;
    },
  };
}

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
}

function queued(messageId = "first-message") {
  return {
    threadId: ACTION_TEST_THREAD, messageId, content: "Build the feature", attachments: [], mentions: [],
    submission: {
      threadId: ACTION_TEST_THREAD, messageId, content: "Build the feature", displayContent: "Build the feature",
      model: "claude-sonnet-4-6", permissionMode: "default" as const, attachments: [], persistedAttachments: [],
      mentions: [], provider: "claude",
    },
  };
}

function blocked(f: Awaited<ReturnType<typeof harness>>) {
  expect(f.gate()).toMatchObject({ gate: "blocked", queuedTurns: [{ state: "queued" }] });
  expect(f.dispatched).toEqual([]);
}

async function start(f: Awaited<ReturnType<typeof harness>>, actionId = "install") {
  await f.service.queueAutomaticFirstTurn(queued());
  await eventually(() => expect({ run: f.projectActions.get({ ...slot, actionId }), gate: f.gate(), startup: f.startups.get(f.startupId) }, JSON.stringify(f.startups.get(f.startupId))).toMatchObject({ run: { status: "running" } }));
  blocked(f);
  return f.commandId();
}

function entries(f: Awaited<ReturnType<typeof harness>>): ThreadStartupAction[] {
  const detail = f.startups.get(f.startupId)?.steps.find((step) => step.phase === "setup")?.detail;
  return detail?.phase === "setup" ? detail.actions ?? [] : [];
}

function setupStartedAt(f: Awaited<ReturnType<typeof harness>>): number {
  const startedAt = f.startups.get(f.startupId)?.steps.find((step) => step.phase === "setup")?.startedAt;
  if (!startedAt) throw new Error("Setup has not started");
  return Date.parse(startedAt);
}

async function listener(host = "127.0.0.1") {
  const server = NodeNet.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, ipv6Only: host === "::1" }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  cleanups.push(close);
  return { port: address.port, close };
}

describe("startup actions through the real action service and port probe", () => {
  it("keeps an occupied-port action queued through a reachable probe and its exit 1", async () => {
    const occupied = await listener();
    const f = await harness();
    const id = await start(f);
    f.host.emitOutput(id, Buffer.from(`http://localhost:${occupied.port}/\n`));
    await eventually(() => expect(f.projectActions.get(slot)?.port).toMatchObject({ reachable: true, port: occupied.port }));
    blocked(f);
    f.host.emitOutput(id, Buffer.from("address already in use\n"));
    blocked(f);
    f.host.emitExit(id, 1);
    await eventually(() => expect(f.gate().attempt).toMatchObject({ state: "failed", failedActionId: "install" }));
    blocked(f);
    expect(f.startups.get(f.startupId)).toMatchObject({
      state: "blocked", block: { code: "SETUP_FAILED", detail: "address already in use" },
      steps: expect.arrayContaining([expect.objectContaining({ phase: "setup", detail: expect.objectContaining({ exitCode: 1 }) })]),
    });
  });

  it("ignores an echoed URL and releases only after exit zero", async () => {
    const occupied = await listener();
    const f = await harness({ actions: [action("install", `echo http://localhost:${occupied.port}/`)] });
    const id = await start(f);
    expect(f.projectActions.get(slot)?.port).toBeNull();
    blocked(f);
    f.host.emitExit(id, 0);
    await eventually(() => expect(f.gate()).toMatchObject({ gate: "released-by-pass", queuedTurns: [{ state: "dispatched" }] }));
    expect(f.projectActions.get(slot)?.port).toBeNull();
    expect(f.dispatched).toEqual(["first-message"]);
  });

  it("releases the gate while a waitForExit:false action keeps running and ignores its later exit", async () => {
    const f = await harness({ actions: [{ ...action("dev", "vite"), waitForExit: false }] });
    await f.service.queueAutomaticFirstTurn(queued());
    await eventually(() => expect(f.gate()).toMatchObject({ gate: "released-by-pass", queuedTurns: [{ state: "dispatched" }] }));
    const devSlot = { ...slot, actionId: "dev" };
    expect(f.projectActions.get(devSlot)?.status).toBe("running");
    expect(f.dispatched).toEqual(["first-message"]);
    f.host.emitExit(f.commandId(), 1);
    await eventually(() => expect(f.projectActions.get(devSlot)?.status).toBe("failed"));
    expect(f.gate()).toMatchObject({ gate: "released-by-pass" });
    expect(f.startups.get(f.startupId)?.block).toBeFalsy();
  });

  it("keeps IPv6-only serving actions queued until Skip setup and leaves their commands running", async () => {
    const live = await listener("::1");
    const f = await harness();
    const id = await start(f);
    f.host.emitOutput(id, Buffer.from(`http://[::1]:${live.port}/\n`));
    await eventually(() => expect(f.projectActions.get(slot)?.port).toMatchObject({ host: "::1", reachable: true }));
    blocked(f);
    await f.service.continueAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    expect(f.gate()).toMatchObject({ gate: "released-by-continue", queuedTurns: [{ state: "dispatched" }] });
    expect(f.projectActions.get(slot)?.status).toBe("running");
    expect(f.dispatched).toEqual(["first-message"]);
    f.host.emitExit(id, 0);
  });

  it("never dispatches when a command prints a live URL and then fails", async () => {
    const live = await listener();
    const f = await harness();
    const id = await start(f);
    f.host.emitOutput(id, Buffer.from(`http://localhost:${live.port}/\n`));
    await eventually(() => expect(f.projectActions.get(slot)?.port?.reachable).toBe(true));
    blocked(f);
    await live.close();
    blocked(f);
    f.host.emitExit(id, 1);
    await eventually(() => expect(f.gate().attempt?.state).toBe("failed"));
    blocked(f);
    expect(f.startups.get(f.startupId)?.block?.code).toBe("SETUP_FAILED");
  });

  it("runs in order, retains terminals, and retries only failed or edited scripts", async () => {
    const f = await harness({ actions: [action("install"), action("check", "exit 3")] });
    const first = await start(f);
    const firstTerminal = f.projectActions.get(slot)?.terminalSessionId;
    f.host.emitExit(first, 0);
    await eventually(() => expect(f.projectActions.get({ ...slot, actionId: "check" })?.status).toBe("running"));
    const failedTerminal = f.projectActions.get({ ...slot, actionId: "check" })?.terminalSessionId;
    f.host.emitExit(f.commandId(), 3);
    await eventually(() => expect(f.gate().attempt).toMatchObject({ state: "failed", failedActionId: "check" }));
    blocked(f);
    const read = await f.service.read(ACTION_TEST_WORKSPACE);
    await f.service.save({ workspaceId: ACTION_TEST_WORKSPACE, sourceRevision: read.revision,
      document: { ...read.document, actions: [action("install"), action("check", "echo fixed")] } });
    const oldAttempt = f.gate().attempt?.id;
    await f.service.retryAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    expect(f.gate().attempt?.id).not.toBe(oldAttempt);
    expect(entries(f).map((entry) => entry.outcome)).toEqual(["skipped", "running"]);
    expect(f.projectActions.get(slot)?.terminalSessionId).toBe(firstTerminal);
    expect(f.projectActions.get({ ...slot, actionId: "check" })?.terminalSessionId).toBe(failedTerminal);
    f.host.emitExit(f.commandId(), 0);
    await eventually(() => expect(f.gate()).toMatchObject({ gate: "released-by-pass", queuedTurns: [{ state: "dispatched" }] }));
    expect(f.dispatched).toEqual(["first-message"]);
    expect(f.projectActions.list(ACTION_TEST_THREAD).map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("upgrades a shared legacy file without writing it and requests action:setup approval once", async () => {
    const f = await harness({ shared: true, legacy: true });
    await f.service.queueAutomaticFirstTurn(queued());
    const setupSlot = { ...slot, actionId: "setup" };
    await eventually(() => expect(f.gate().attempt?.state).toBe("awaiting-approval"));
    expect(f.startups.get(f.startupId)?.block?.code).toBe("SETUP_APPROVAL_REQUIRED");
    const beforeApproval = setupStartedAt(f);
    expect(await NodeFSPromises.readFile(f.file, "utf8")).toBe(f.bytes);
    const approval = f.projectActions.get(setupSlot)?.snapshot.approval;
    if (!approval) throw new Error("Expected shared approval");
    expect(approval.target).toEqual({ kind: "action", actionId: "setup" });
    await f.service.approveCommand({ threadId: ACTION_TEST_THREAD, ...approval });
    expect(f.gate().attempt?.state).toBe("awaiting-approval");
    await f.projectActions.start(setupSlot);
    await eventually(() => expect(f.gate().attempt?.state).toBe("running"));
    expect(setupStartedAt(f)).toBeGreaterThan(beforeApproval);
    expect(f.projectActions.get(setupSlot)?.trigger).toBe("startup");
    f.host.emitExit(f.commandId(), 1);
    await eventually(() => expect(f.gate().attempt?.state).toBe("failed"));
    await f.service.retryAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    expect(f.projectActions.get(setupSlot)?.status).toBe("running");
    expect(f.projectActions.get(setupSlot)?.snapshot.approval).toBeUndefined();
    f.host.emitExit(f.commandId(), 0);
    await eventually(() => expect(f.gate().gate).toBe("released-by-pass"));
  });

  it("rejects edits after startup approval was requested without launching the changed command", async () => {
    const f = await harness({ shared: true });
    await f.service.queueAutomaticFirstTurn(queued());
    await eventually(() => expect(f.gate().attempt?.state).toBe("awaiting-approval"));
    await NodeFSPromises.writeFile(f.file, JSON.stringify({
      version: "0.1.0", actions: [action("install", "echo changed")],
    }));
    await f.projectActions.start(slot);
    await eventually(() => expect(f.gate().attempt).toMatchObject({ state: "failed", failedActionId: "install" }));
    expect(f.creates.mock.calls).toEqual([]);
    expect(f.startups.get(f.startupId)?.block?.code).toBe("SETUP_FAILED");
    blocked(f);
  });

  it("does not release queued turns when exit zero races a requested cancellation", async () => {
    const f = await harness();
    const id = await start(f);
    await f.startups.cancel(f.startupId);
    f.host.emitExit(id, 0);
    await eventually(() => expect(f.projectActions.get(slot)?.status).toBe("completed"));
    await f.service.stopAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    expect(f.gate().queuedTurns).toMatchObject([{ state: "cancelled" }]);
    expect(f.dispatched).toEqual([]);
  });

  it("cancels the command phase, keeps the shell, and discards the queued first turn", async () => {
    const f = await harness({ managed: false, actions: [action("install"), action("check")] });
    await start(f);
    const terminal = f.projectActions.get(slot)?.terminalSessionId;
    await f.startups.cancel(f.startupId);
    await f.service.stopAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    await f.startups.markCancelled(f.startupId);
    expect(f.startups.get(f.startupId)?.state).toBe("cancelled");
    expect(f.gate()).toMatchObject({ gate: "not-required", queuedTurns: [{ state: "cancelled" }] });
    expect(f.projectActions.get(slot)).toMatchObject({ status: "interrupted", terminalSessionId: terminal });
    expect(f.projectActions.get({ ...slot, actionId: "check" })).toBeNull();
    expect(f.dispatched).toEqual([]);
  });

  it("releases without an executor run when no startup actions apply", async () => {
    const f = await harness({ actions: [] });
    await f.service.queueAutomaticFirstTurn(queued());
    await eventually(() => expect(f.gate()).toMatchObject({ gate: "not-required", queuedTurns: [{ state: "dispatched" }] }));
    expect(f.creates.mock.calls).toEqual([]);
    expect(f.dispatched).toEqual(["first-message"]);
  });

  it("restarts the setup clock on retry and preserves it between running actions", async () => {
    const f = await harness({ actions: [action("install"), action("check")] });
    const id = await start(f);
    const originalStart = setupStartedAt(f);
    f.host.emitOutput(id, Buffer.from("failed attempt\n"));
    f.host.emitExit(id, 3);
    await eventually(() => expect(f.gate().attempt?.state).toBe("failed"));
    const transcript = f.startups.get(f.startupId)?.transcript ?? [];
    expect(transcript.map((entry) => entry.content)).toEqual(["$ echo ready\n", "failed attempt\n"]);
    const lastOutputAt = Math.max(...transcript.map((entry) => Date.parse(entry.createdAt)));
    await eventually(() => expect(Date.now()).toBeGreaterThan(lastOutputAt));

    await f.service.retryAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    const retryStart = setupStartedAt(f);
    expect(retryStart).toBeGreaterThan(originalStart);
    expect(retryStart).toBeGreaterThan(lastOutputAt);
    expect(entries(f).map((entry) => entry.outcome)).toEqual(["running", "pending"]);
    await eventually(() => expect(Date.now()).toBeGreaterThan(retryStart));
    f.host.emitExit(f.commandId(), 0);
    await eventually(() => expect(entries(f).map((entry) => entry.outcome)).toEqual(["ready", "running"]));
    expect(setupStartedAt(f)).toBe(retryStart);
  });

  it("persists decoded output within 32 entries and 16 KB and retains it after reload", async () => {
    const f = await harness();
    const id = await start(f);
    f.host.emitOutput(id, Buffer.from("\u001b[31mfirst\u001b[0m\n"));
    f.host.emitOutput(id, Buffer.from("\u001b]8;;http://example.test\u0007link\u001b]8;;\u0007\n"));
    f.host.emitExit(id, 3);
    await eventually(() => expect(f.gate().attempt?.state).toBe("failed"));
    const record = new ThreadStartupRepo(f.reader, f.owned.writer).findById(f.startupId);
    expect(record?.transcript.map((entry) => entry.content)).toEqual(["$ echo ready\n", "first\n", "link\n"]);
    await f.service.retryAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    const next = f.commandId();
    for (let index = 0; index < 60; index++) f.host.emitOutput(next, Buffer.from(`${"é".repeat(1000)}-${index}\n`));
    f.host.emitExit(next, 3);
    await eventually(() => expect(f.gate().attempt?.state).toBe("failed"));
    const bounded = f.startups.get(f.startupId)?.transcript ?? [];
    expect(bounded.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(bounded.map((entry) => entry.content).join(""))).toBeLessThanOrEqual(16384);
    expect(bounded.at(-1)?.content.endsWith("-59\n")).toBe(true);
  });

  it("reconciles unfinished attempts as interrupted without replaying their commands", async () => {
    const f = await harness();
    const id = await start(f);
    await f.startups.interruptNonterminalOnStartup();
    const reloaded = new WorkspaceEnvironmentService(f.options);
    await reloaded.reconcileAutomaticSetup();
    expect(reloaded.getAutomaticSetup({ threadId: ACTION_TEST_THREAD }).attempt?.state).toBe("interrupted");
    expect(f.creates.mock.calls).toHaveLength(1);
    blocked(f);
    f.host.emitExit(id, 0);
    await eventually(() => expect(f.projectActions.get(slot)?.status).toBe("completed"));
    expect(f.gate().gate).toBe("blocked");
    await reloaded.dispose();
  });
  it("persists queued turns FIFO and claims each once while waiting for the prior provider turn", async () => {
    const f = await harness();
    const id = await start(f);
    await f.service.queueAutomaticFirstTurn(queued("second-message"));
    await f.service.queueAutomaticFirstTurn(queued("third-message"));
    const firstProvider = deferred();
    const sent: string[] = [];
    f.service.setAutomaticSetupDispatcher({
      dispatch: async (submission) => {
        sent.push(submission.messageId);
        return { completion: sent.length === 1 ? firstProvider.promise : Promise.resolve() };
      },
    });
    try {
      f.host.emitExit(id, 0);
      await eventually(() => expect(f.gate().queuedTurns.map((turn) => turn.state)).toEqual(["dispatched", "released", "released"]));
      expect(sent).toEqual(["first-message"]);
      firstProvider.resolve();
      await eventually(() => expect(f.gate().queuedTurns.map((turn) => turn.state)).toEqual(["dispatched", "dispatched", "dispatched"]));
      expect(sent).toEqual(["first-message", "second-message", "third-message"]);
    } finally {
      firstProvider.resolve();
    }
  });

  it("enforces queued-turn capacity without losing an admitted message", async () => {
    const f = await harness();
    await start(f);
    for (let index = 2; index <= 64; index++) await f.service.queueAutomaticFirstTurn(queued(`message-${index}`));
    await expect(f.service.queueAutomaticFirstTurn(queued("overflow"))).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY" });
    expect(f.gate().queuedTurns).toHaveLength(64);
    expect(f.gate().queuedTurns.at(-1)?.messageId).toBe("message-64");
    expect(f.dispatched).toEqual([]);
  });

  it("keeps an uncertain dispatch claim across restart without sending it twice", async () => {
    const f = await harness();
    const id = await start(f);
    const sent: string[] = [];
    f.service.setAutomaticSetupDispatcher({ dispatch: async (submission) => {
      sent.push(submission.messageId);
      throw new Error("Provider disconnected after acceptance");
    } });
    f.host.emitExit(id, 0);
    await eventually(() => expect(sent).toEqual(["first-message"]));
    expect(f.gate().queuedTurns[0]?.state).toBe("dispatching");
    const reloaded = new WorkspaceEnvironmentService(f.options);
    reloaded.setAutomaticSetupDispatcher({ dispatch: async (submission) => {
      sent.push(submission.messageId);
      return { completion: Promise.resolve() };
    } });
    await reloaded.reconcileAutomaticSetup();
    expect(sent).toEqual(["first-message"]);
    expect(reloaded.getAutomaticSetup({ threadId: ACTION_TEST_THREAD }).queuedTurns[0]?.state).toBe("dispatching");
    await reloaded.dispose();
  });

  it("skips a live sibling in the same normalized worktree", async () => {
    const f = await harness({ managed: false });
    const sibling = NodeCrypto.randomUUID();
    const checkout = f.options.workspaces.findById().path;
    f.owned.db.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, worktree_path, provider) VALUES (?, ?, 'Sibling', 'worktree', 'main', 0, ?, 'claude')")
      .run(sibling, ACTION_TEST_WORKSPACE, checkout.toUpperCase().replaceAll("/", "\\") + "\\");
    const service = new WorkspaceEnvironmentService({ ...f.options, runtimePhase: (id) => id === sibling ? "running" : undefined });
    await service.queueAutomaticFirstTurn(queued());
    await eventually(() => expect(service.getAutomaticSetup({ threadId: ACTION_TEST_THREAD }).gate).toBe("not-required"));
    expect(f.startups.get(f.startupId)?.steps.find((step) => step.phase === "setup")).toMatchObject({
      state: "skipped", detail: { skipReason: "thread-running-here" },
    });
    expect(f.projectActions.list(ACTION_TEST_THREAD)).toEqual([]);
    await service.dispose();
  });

  it("fails closed on malformed configuration and accepts the corrected document on Retry", async () => {
    const f = await harness();
    await NodeFSPromises.writeFile(f.file, "{ broken json");
    await f.service.queueAutomaticFirstTurn(queued());
    await eventually(() => expect(f.gate().attempt?.state).toBe("failed"));
    blocked(f);
    expect(f.startups.get(f.startupId)?.block?.code).toBe("SETUP_FAILED");
    await NodeFSPromises.writeFile(f.file, f.bytes);
    await f.service.retryAutomaticSetup({ threadId: ACTION_TEST_THREAD });
    expect(f.projectActions.get(slot)?.status).toBe("running");
  });

  it("does not start a command or dispatch after cancellation precedes admission", async () => {
    const f = await harness();
    await f.startups.cancel(f.startupId);
    await f.startups.markCancelled(f.startupId);
    await f.service.queueAutomaticFirstTurn(queued());
    expect(f.gate()).toMatchObject({ gate: "not-required", queuedTurns: [{ state: "cancelled" }] });
    expect(f.projectActions.list(ACTION_TEST_THREAD)).toEqual([]);
    expect(f.dispatched).toEqual([]);
  });

});
