import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { FileService } from "../../../projects/files/file-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { TurnAdmissionDispatchCoordinator, type TurnParentStartOwner, type TurnRuntimeAdmissionAuthority } from "../../turns/turn-admission-dispatch-coordinator.js";
import { isAgentRpcMethod, routeAgentRpc, type AgentRouterDeps } from "../agent-rpc.js";

let directory: string;
let settings: SettingsService;

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-confirm-message-"));
  vi.stubEnv("MCODE_DATA_DIR", directory);
  settings = new SettingsService();
});

afterEach(async () => {
  settings.dispose();
  await closeAgentStorageTestDatabases();
  vi.unstubAllEnvs();
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

function routerDeps(sendMessage: AgentRouterDeps["agentService"]["sendMessage"], messageRepo: MessageRepo): AgentRouterDeps {
  const unused = (): never => { throw new Error("Unexpected dependency in confirmation route"); };
  return {
    agentService: { sendMessage, createAndSend: unused, stopSession: unused, runtimeAccess: unused },
    agentPermissionService: { respondToPermission: unused, listPendingPermissions: unused },
    hookExecutionRepo: { listByMessage: unused },
    messageRepo,
    narrativeStore: { load: unused },
    planQuestionAnswersRepo: { listAnsweredForThread: unused },
    planRepo: { updateStatus: unused, listByThread: unused },
    planTurnService: { answerQuestions: unused, dismissQuestions: unused },
    recapService: { generate: unused },
    subagentLifecycleService: { loadRoster: unused, stop: unused },
    taskRepo: { get: unused },
    thoughtSegmentRepo: { listByMessage: unused },
    threadControlService: { respondToApproval: unused, listPendingApprovals: unused },
    toolCallRecordRepo: { listByMessage: unused, listByParent: unused },
    turnRecoveryService: { currentRecoveryIncident: unused, retry: unused },
  };
}

async function fixture(
  beforeCommit: () => Promise<void> = async () => {},
  startParentTurn: (commit: () => Promise<unknown>) => Promise<unknown> = (commit) => commit(),
) {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const workspaces = new WorkspaceRepo(db, writer);
  const messages = new MessageRepo(db, writer);
  const workspace = await workspaces.create("Confirmation fixture", directory, false);
  const thread = await threads.create(workspace.id, "Confirm message", "direct", "main", false, "codex");
  const providerFinished = Promise.withResolvers<void>();
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex", descriptor: { id: "codex", capabilities: [] }, supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Not used by admission"); } },
    sendTurn: () => providerFinished.promise, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const git = new FakeGitExecutor();
  const worktrees = new GitWorktreeService(workspaces, git, hostRuntime);
  const canonical = new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), () => {});
  const commands = new AgentRuntimeCommandPort();
  const plans = new PlanTurnService(threads, providers, new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db, writer)), new PlanRepo(db, writer), new AgentTurnCommandPort(commands));
  const owner: TurnParentStartOwner = { start: async ({ parentTurn }) => {
    await beforeCommit();
    await startParentTurn(() => canonical.startParentTurn(parentTurn));
  } };
  const admission = new TurnAdmissionDispatchCoordinator(
    threads, workspaces, messages, worktrees, new AttachmentService(), providers,
    new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
    new GoalLifecycleService(threads, providers, writer, commands, canonical), undefined,
    new FileService(workspaces, threads, worktrees, git, hostRuntime), hostRuntime.platform, owner,
  );
  let reserved = false;
  const runtime: TurnRuntimeAdmissionAuthority = {
    reserve: (command) => {
      if (reserved) throw new Error("Thread already reserved");
      reserved = true;
      const turnExecutionId = NodeCrypto.randomUUID();
      command.onTurnStarted?.({ threadId: thread.id, turnExecutionId, phase: "running" });
      return { threadId: thread.id, turnExecutionId, mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 };
    },
    activate: () => {}, abort: async () => {}, release: () => { reserved = false; }, owns: () => true,
  };
  const deps = routerDeps(async (command) => {
    const admitted = await admission.admit(command, runtime);
    if (admitted.kind === "dispatch") await provider.sendTurn(admitted.request);
  }, messages);
  const messageId = NodeCrypto.randomUUID();
  const params = { threadId: thread.id, messageId };
  return {
    db, writer, deps, messages, params, providerFinished,
    send: () => routeAgentRpc("agent.send", { ...params, content: "Review these comments" }, deps),
    confirm: () => routeAgentRpc("agent.confirmMessage", params, deps),
  };
}

describe("agent.confirmMessage", () => {
  it("waits through reservation and commit, but not provider completion", async () => {
    const committing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const f = await fixture(async () => { committing.resolve(); await gate.promise; });
    const send = f.send();
    let settled = false;
    const confirmation = f.confirm().then((result) => { settled = true; return result; });
    try {
      await committing.promise;
      await NodeTimersPromises.setImmediate();
      expect(settled).toBe(false);
      expect(f.messages.findByIdInThread(f.params.threadId, f.params.messageId)).toBeNull();
      gate.resolve();
      await expect(confirmation).resolves.toEqual({ admitted: true });
      await send;
    } finally {
      gate.resolve();
      f.providerFinished.resolve();
      await send;
    }
  });

  it("routes confirmation and returns false without a row or admission", async () => {
    const f = await fixture();
    expect(isAgentRpcMethod("agent.confirmMessage")).toBe(true);
    await expect(f.confirm()).resolves.toEqual({ admitted: false });
  });

  it("waits for a failed admission and returns false without propagating its rejection", async () => {
    const committing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const failure = new Error("Commit refused");
    const f = await fixture(async () => { committing.resolve(); await gate.promise; throw failure; });
    const send = expect(f.send()).rejects.toBe(failure);
    let settled = false;
    const confirmation = f.confirm().then((result) => { settled = true; return result; });
    try {
      await committing.promise;
      await NodeTimersPromises.setImmediate();
      expect(settled).toBe(false);
      gate.resolve();
      await send;
      await expect(confirmation).resolves.toEqual({ admitted: false });
      await expect(f.confirm()).resolves.toEqual({ admitted: false });
    } finally { gate.resolve(); await send; }
  });

  it("confirms an existing user row with no in-flight admission after restart", async () => {
    const f = await fixture();
    const message = await f.messages.create(f.params.threadId, "user", "Previously queued", 1);
    await expect(routeAgentRpc("agent.confirmMessage", { ...f.params, messageId: message.id }, f.deps))
      .resolves.toEqual({ admitted: true });
  });

  it.each([true, false])("waits for a queued start write after admission rejects, committed: %s", async (committed) => {
    const failure = new Error("Execution worker lost");
    const write = Promise.withResolvers<unknown>();
    const outcome = write.promise.then(() => "committed", () => "failed");
    const f = await fixture(undefined, async (commit) => {
      f.db.run("BEGIN IMMEDIATE");
      if (!committed) f.db.run("DELETE FROM threads WHERE id = ?", [f.params.threadId]);
      void commit().then(write.resolve, write.reject);
      throw failure;
    });
    try {
      await expect(f.send()).rejects.toBe(failure);
      expect(f.messages.findByIdInThread(f.params.threadId, f.params.messageId)).toBeNull();
      const events: string[] = [];
      const drained = f.writer.barrier().then(() => { events.push("writes settled"); });
      const confirmation = f.confirm().then((result) => { events.push("confirmed"); return result; });
      f.db.run("COMMIT");
      await expect(confirmation).resolves.toEqual({ admitted: committed });
      await drained;
      expect(events).toEqual(["writes settled", "confirmed"]);
      await expect(outcome).resolves.toBe(committed ? "committed" : "failed");
      expect(f.messages.findByIdInThread(f.params.threadId, f.params.messageId)?.role ?? null)
        .toBe(committed ? "user" : null);
    } finally {
      if (f.db.inTransaction) f.db.run("ROLLBACK");
      await outcome;
    }
  });

  it("does not count an assistant row or a user row in another thread", async () => {
    const f = await fixture();
    const assistant = await f.messages.create(f.params.threadId, "assistant", "Response", 1);
    const user = await f.messages.create(f.params.threadId, "user", "Input", 2);
    await expect(routeAgentRpc("agent.confirmMessage", { ...f.params, messageId: assistant.id }, f.deps))
      .resolves.toEqual({ admitted: false });
    await expect(routeAgentRpc("agent.confirmMessage", { threadId: "other-thread", messageId: user.id }, f.deps))
      .resolves.toEqual({ admitted: false });
  });

  it("keeps tracking the first send when an overlapping send with the same id is rejected", async () => {
    const committing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const f = await fixture(async () => { committing.resolve(); await gate.promise; });
    const send = f.send();
    try {
      await committing.promise;
      await expect(f.send()).rejects.toBeInstanceOf(Error);
      let settled = false;
      const confirmation = f.confirm().then((result) => { settled = true; return result; });
      await NodeTimersPromises.setImmediate();
      expect(settled).toBe(false);
      await expect(routeAgentRpc("agent.confirmMessage", { ...f.params, messageId: NodeCrypto.randomUUID() }, f.deps))
        .resolves.toEqual({ admitted: false });
      await expect(routeAgentRpc("agent.confirmMessage", { ...f.params, threadId: "other-thread" }, f.deps))
        .resolves.toEqual({ admitted: false });
      gate.resolve();
      await expect(confirmation).resolves.toEqual({ admitted: true });
      await send;
    } finally { gate.resolve(); f.providerFinished.resolve(); await send; }
  });
});
