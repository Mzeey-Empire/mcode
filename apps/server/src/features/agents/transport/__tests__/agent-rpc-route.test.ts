import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { container } from "tsyringe";
import type { Database } from "bun:sqlite";
import { setupContainer } from "../../../../application/composition/container.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkerOwnedTurnRuntime } from "../../execution/worker-owned-turn-runtime.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { AgentService } from "../../orchestration/agent-service.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { routeAgentRpc, type AgentRouterDeps } from "../agent-rpc.js";
import { PlanServiceError } from "../../planning/plan-service.js";
import { TurnSteerConflictError, TurnSteerError, TurnSteerMentionError } from "../../steering/turn-steer.js";
import type { PlanVersion } from "@mcode/contracts";
import type { SendMessageCommand } from "../../turns/turn-admission-dispatch-coordinator.js";

function admissionFixture(sendMessage: AgentRouterDeps["agentService"]["sendMessage"]): {
  deps: AgentRouterDeps; close(): void;
} {
  const unused = (): never => { throw new Error("Unexpected dependency in admission-only route"); };
  const deps: AgentRouterDeps = {
    agentService: { sendMessage, createAndSend: unused, stopSession: unused, runtimeAccess: unused },
    approvalService: { respondToApproval: unused, listPendingApprovals: unused },
    hookExecutionRepo: { listByMessage: unused },
    messageRepo: { listByThread: unused, listByThreadAfter: unused, listSessionNotices: unused, confirmUserMessage: unused },
    narrativeStore: { load: unused },
    planQuestionAnswersRepo: { listAnsweredForThread: unused },
    planService: { saveVersion: unused, snapshot: unused, implement: unused },
    planTurnService: { answerQuestions: unused, dismissQuestions: unused },
    recapService: { generate: unused },
    subagentRosterService: { loadRoster: unused, loadDetail: unused, stop: unused },
    taskRepo: { get: unused },
    thoughtSegmentRepo: { listByMessage: unused },
    threadControlService: { respondToApproval: unused, listPendingApprovals: unused },
    toolCallRecordRepo: { listByMessage: unused, listByParent: unused },
    turnRecoveryService: { retryErroredTurn: unused, resumeTurn: unused },
    turnResumeScheduler: { schedule: unused, unschedule: unused },
  };
  return { deps, close: () => undefined };
}

describe("routeMessage Agent RPCs", () => {
  it("keeps an attached worktree behind configured Setup when wire params forge setupSkip", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rpc-setup-"));
    const oldDatabase = process.env.MCODE_DB_PATH;
    process.env.MCODE_DB_PATH = NodePath.join(root, "app.sqlite");
    container.reset();
    await setupContainer(root);
    const writer = container.resolve(ApplicationDatabaseWriter);
    const workers = container.resolve(WorkerOwnedTurnRuntime);
    const environment = container.resolve(WorkspaceEnvironmentService);
    const worktrees = container.resolve(GitWorktreeService);
    const listed = vi.spyOn(worktrees, "listWorktrees").mockResolvedValue([
      { path: root, name: "fixture", branch: "main", managed: false },
    ]);
    try {
      await workers.whenReady();
      const workspace = await container.resolve(WorkspaceRepo).create("RPC fixture", root, false);
      await environment.save({ workspaceId: workspace.id, sourceRevision: null,
        document: { version: "0.0.1", setup: { windows: "echo setup", linux: "echo setup" }, actions: [] } });
      const fixture = admissionFixture(async () => {});
      fixture.deps.agentService = container.resolve(AgentService);
      const startupId = NodeCrypto.randomUUID();
      const params = { workspaceId: workspace.id, startupId, content: "Implement", mode: "worktree" as const,
        existingWorktreePath: root, provider: "codex" as const,
        setupSkip: { reason: "plan-implement", sourceThreadId: "forged-source" } };
      await routeAgentRpc("agent.createAndSend", params, fixture.deps);
      const startup = container.resolve(ThreadStartupService).get(startupId);
      if (!startup?.threadId) throw new Error("Expected attached startup");
      const snapshot = environment.getAutomaticSetup({ threadId: startup.threadId });
      expect(snapshot.gate).toBe("blocked");
      expect(snapshot.queuedTurns.map(turn => turn.state)).toEqual(["queued"]);
      expect(startup.steps.find(step => step.phase === "setup")).toMatchObject({ state: "running" });
    } finally {
      await environment.dispose();
      await workers.close();
      await writer.close();
      container.resolve<Database>("Database").close(true);
      container.reset();
      listed.mockRestore();
      if (oldDatabase === undefined) delete process.env.MCODE_DB_PATH;
      else process.env.MCODE_DB_PATH = oldDatabase;
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("records the user as the cause of an agent.stop", async () => {
    const fixture = admissionFixture(async () => {});
    const stopSession = vi.fn<AgentRouterDeps["agentService"]["stopSession"]>(async (threadId) => ({
      threadId, turnExecutionId: null, status: "already-terminal", dispatchState: "not-dispatched",
      snapshot: { threadId, turnExecutionId: null, phase: "idle" } }));
    fixture.deps.agentService.stopSession = stopSession;

    await routeAgentRpc("agent.stop", { threadId: "thread-one" }, fixture.deps);

    expect(stopSession).toHaveBeenCalledExactlyOnceWith("thread-one", { by: "user" });
  });

  it("returns the saved version only after the plan service commits", async () => {
    const fixture = admissionFixture(async () => {});
    const version: PlanVersion = { id: "00000000-0000-4000-8000-000000000002", threadId: "thread-one",
      version: 2, title: "Edited", contentMd: "# Edited", status: "draft", author: "user",
      providerId: null, captureSource: "edit", messageId: null,
      baseVersionId: "00000000-0000-4000-8000-000000000001", revision: 1,
      createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z", acceptedAt: null, acceptedMessageId: null };
    const input = { threadId: version.threadId, versionId: version.id, baseVersionId: "00000000-0000-4000-8000-000000000001",
      baseRevision: 0, contentMd: version.contentMd };
    let confirm: (() => void) | undefined;
    fixture.deps.planService.saveVersion = async (params) => {
      expect(params).toEqual(input);
      await new Promise<void>((resolve) => { confirm = resolve; });
      return version;
    };
    let settled = false;
    const pending = routeAgentRpc("plan.saveVersion", input, fixture.deps).then((result) => { settled = true; return result; });
    expect(settled).toBe(false);
    confirm?.();
    await expect(pending).resolves.toEqual(version);
    fixture.deps.planService.snapshot = async () => ({ versions: [version] });
    await expect(routeAgentRpc("plan.snapshot", { threadId: version.threadId }, fixture.deps)).resolves.toEqual({ versions: [version] });
  });

  it.each(["plan_busy", "plan_read_only", "plan_conflict"] as const)("preserves the typed %s save failure", async (code) => {
    const fixture = admissionFixture(async () => {});
    const failure = new PlanServiceError({ code, latestVersion: null });
    fixture.deps.planService.saveVersion = async () => { throw failure; };
    await expect(routeAgentRpc("plan.saveVersion", { threadId: "thread-one",
      versionId: "00000000-0000-4000-8000-000000000002", baseVersionId: "00000000-0000-4000-8000-000000000001",
      baseRevision: 0, contentMd: "# Edited" }, fixture.deps)).rejects.toBe(failure);
  });

  it("resumes the interrupted turn by sending its continuation with raw display content", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const resumeTurn = vi.fn(async (_params, dispatch) => {
      await dispatch({
        threadId: "thread-1",
        content: "Retry this work",
        model: "gpt-5",
      });
      return { turnId: "turn-2", mode: "native-session" };
    });

    const response = await routeMessage(JSON.stringify({
      id: "resume-1",
      method: "turn.resume",
      params: { threadId: "thread-1", turnId: "turn-1" },
    }), {
      agentService: { sendMessage },
      turnRecoveryService: { resumeTurn },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "resume-1", result: { turnId: "turn-2", mode: "native-session" } });
    expect(resumeTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1" }, expect.any(Function));
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: "thread-1",
      content: "Retry this work",
      displayContent: "Retry this work",
      model: "gpt-5",
      onAdmissionComplete: expect.any(Function),
    });
  });

  it("starts a watcher for a returned worktree thread", async () => {
    const createAndSend = vi.fn().mockResolvedValue({
      id: "thread-2",
      mode: "worktree",
      worktree_path: "C:/repo-worktree",
    });
    const watchThreadWorktree = vi.fn();

    const response = await routeMessage(JSON.stringify({
      id: "create-1",
      method: "agent.createAndSend",
      params: {
        workspaceId: "workspace-1",
        content: "Start work",
        model: "gpt-5",
      },
    }), {
      agentService: { createAndSend },
      gitWatcherService: { watchThreadWorktree },
    } as unknown as RouterDeps);

    expect(response.error).toBeUndefined();
    expect(watchThreadWorktree).toHaveBeenCalledWith("thread-2", "C:/repo-worktree");
  });

  it("uses the default plan-question permission mode", async () => {
    const answerQuestions = vi.fn().mockResolvedValue(undefined);

    const response = await routeMessage(JSON.stringify({
      id: "answer-1",
      method: "agent.answerQuestions",
      params: {
        threadId: "thread-1",
        answers: [],
        reasoningLevel: "high",
        contextWindow: "1m",
        thinking: true,
      },
    }), {
      planTurnService: { answerQuestions },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "answer-1", result: undefined });
    expect(answerQuestions).toHaveBeenCalledWith(
      "thread-1",
      [],
      "default",
      "high",
      "1m",
      true,
    );
  });

  it("returns the approval service delivery result", async () => {
    const respondToApproval = vi.fn(async () => ({ status: "not_pending" }));
    const response = await routeMessage(JSON.stringify({
      id: "approval-1", method: "approval.respond", params: { requestId: "request-1", choiceId: "allow" },
    }), { approvalService: { respondToApproval } } as unknown as RouterDeps);
    expect(response).toEqual({ id: "approval-1", result: { status: "not_pending" } });
    expect(respondToApproval.mock.calls).toEqual([["request-1", { choiceId: "allow" }]]);
  });

  it("forwards exact question answers and rejects malformed answers", async () => {
    const respondToApproval = vi.fn(async () => ({ status: "resolved" }));
    const deps = { approvalService: { respondToApproval } } as unknown as RouterDeps;
    const accepted = await routeMessage(JSON.stringify({
      id: "question-1", method: "approval.respond",
      params: { requestId: "que_1", choiceId: "answer", answers: [[" staging "]] },
    }), deps);
    expect(accepted).toEqual({ id: "question-1", result: { status: "resolved" } });
    expect(respondToApproval.mock.calls).toEqual([["que_1", { choiceId: "answer", answers: [[" staging "]] }]]);
    const rejected = await routeMessage(JSON.stringify({
      id: "question-2", method: "approval.respond",
      params: { requestId: "que_1", choiceId: "answer", answers: [[" "]] },
    }), deps);
    expect(rejected.error?.code).toBe("INVALID_PARAMS");
    expect(respondToApproval).toHaveBeenCalledTimes(1);
  });
});

describe("routeMessage steer RPCs", () => {
  const STEER_ID = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";
  const steerParams = { threadId: "thread-1", turnExecutionId: "execution-1", messageId: STEER_ID, content: "Use staging." };
  const steerRequest = (params: unknown) => JSON.stringify({ id: "steer-1", method: "agent.steer", params });
  const steerDeps = (steer: (params: unknown) => Promise<unknown>) =>
    ({ turnSteers: { steer, listHeldSteers: vi.fn(), settleUnknownSteer: vi.fn() } }) as unknown as RouterDeps;

  it("forwards a valid steer and returns its result", async () => {
    const steer = vi.fn(async () => ({ status: "delivered", messageId: STEER_ID }));
    await expect(routeMessage(steerRequest(steerParams), steerDeps(steer)))
      .resolves.toEqual({ id: "steer-1", result: { status: "delivered", messageId: STEER_ID } });
    expect(steer.mock.calls).toEqual([[steerParams]]);
  });

  it.each([
    ["a non-uuid message id", { ...steerParams, messageId: "steer-1" }],
    ["empty content", { ...steerParams, content: "" }],
    ["attachments", { ...steerParams, attachments: [] }],
  ])("rejects %s before the service runs", async (_case, params) => {
    const steer = vi.fn();
    const response = await routeMessage(steerRequest(params), steerDeps(steer));
    expect(response.error?.code).toBe("INVALID_PARAMS");
    expect(steer).not.toHaveBeenCalled();
  });

  it.each([
    ["turn_not_running", new TurnSteerError("turn_not_running", "The turn is no longer running."),
      { code: "turn_not_running", message: "The turn is no longer running." }],
    ["steer_unsupported", new TurnSteerError("steer_unsupported", "This provider cannot add a message to a running turn."),
      { code: "steer_unsupported", message: "This provider cannot add a message to a running turn." }],
    ["steer_rejected", new TurnSteerError("steer_rejected", "The provider refused the message.", "input too large"),
      { code: "steer_rejected", message: "The provider refused the message.", data: { detail: "input too large" } }],
    ["an id conflict", new TurnSteerConflictError(),
      { code: "INVALID_PARAMS", message: "This steer id was already used with different inputs." }],
    ["a refused mention", new TurnSteerMentionError(new Error("Mention path is outside the workspace.")),
      { code: "INVALID_PARAMS", message: "Mention path is outside the workspace." }],
  ])("maps %s to its wire error", async (_case, failure, error) => {
    const response = await routeMessage(steerRequest(steerParams), steerDeps(async () => { throw failure; }));
    expect(response).toEqual({ id: "steer-1", error });
  });

  it("maps a resend claim refused inside the database writer to steer_resend_closed", async () => {
    // The writer rebuilds thrown errors as plain Errors that keep only name, message and code.
    const rebuilt = Object.assign(new Error("This resend was already sent or removed."),
      { name: "TurnSteerError", code: "steer_resend_closed" });
    const sendMessage = vi.fn(async () => { throw rebuilt; });
    const response = await routeMessage(JSON.stringify({ id: "send-1", method: "agent.send",
      params: { threadId: "thread-1", content: "Use staging.", resendOfSteerId: STEER_ID } }),
    { agentService: { sendMessage } } as unknown as RouterDeps);
    expect(response).toEqual({ id: "send-1",
      error: { code: "steer_resend_closed", message: "This resend was already sent or removed." } });
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ resendOfSteerId: STEER_ID });
  });

  it("forwards held steer listing and settling", async () => {
    const held = [{ messageId: STEER_ID, threadId: "thread-1", content: "Use staging.", state: "delivery_unknown" }];
    const listHeldSteers = vi.fn(() => held);
    const settleUnknownSteer = vi.fn(async () => ({ status: "removed" }));
    const deps = { turnSteers: { steer: vi.fn(), listHeldSteers, settleUnknownSteer } } as unknown as RouterDeps;

    await expect(routeMessage(JSON.stringify({ id: "held-1", method: "agent.listHeldSteers", params: {} }), deps))
      .resolves.toEqual({ id: "held-1", result: held });
    await expect(routeMessage(JSON.stringify({ id: "settle-1", method: "agent.settleUnknownSteer",
      params: { messageId: STEER_ID, action: "remove" } }), deps))
      .resolves.toEqual({ id: "settle-1", result: { status: "removed" } });
    expect(settleUnknownSteer.mock.calls).toEqual([[{ messageId: STEER_ID, action: "remove" }]]);

    const invalid = await routeMessage(JSON.stringify({ id: "settle-2", method: "agent.settleUnknownSteer",
      params: { messageId: STEER_ID, action: "retry" } }), deps);
    expect(invalid.error?.code).toBe("INVALID_PARAMS");
    expect(settleUnknownSteer).toHaveBeenCalledTimes(1);
  });
});

describe("routeAgentRpc", () => {
  it("acknowledges an admitted prompt while provider completion is still pending", async () => {
    let command: SendMessageCommand | undefined;
    let finish!: () => void;
    const dispatch = new Promise<void>((resolve) => { finish = resolve; });
    const sendMessage = vi.fn((input: SendMessageCommand) => { command = input; return dispatch; });
    const fixture = admissionFixture(sendMessage);
    try {
      const rpc = routeAgentRpc("agent.send", { threadId: "thread-1", content: "Long work" }, fixture.deps);
      command?.onAdmissionComplete?.(true);
      await expect(rpc).resolves.toBeUndefined();
      finish();
      await dispatch;
    } finally { fixture.close(); }
  });

  it("rejects a prompt that fails before its admission handshake", async () => {
    const failure = new Error("Admission rejected");
    const fixture = admissionFixture(vi.fn().mockRejectedValue(failure));
    try {
      await expect(routeAgentRpc("agent.send", { threadId: "thread-1", content: "Long work" }, fixture.deps)).rejects.toBe(failure);
    } finally { fixture.close(); }
  });

  it("keeps message.list pagination and answered-plan ids in its established response shape", async () => {
    const messagePage = {
      messages: [{ id: "message-1", sequence: 42 }],
      hasMore: true,
    };
    const listByThread = vi.fn(() => messagePage);
    const listAnsweredForThread = vi.fn(() => ["message-1"]);

    await expect(routeAgentRpc("message.list", {
      threadId: "thread-1",
      limit: 50,
      before: 43,
    }, {
      messageRepo: { listByThread },
      planQuestionAnswersRepo: { listAnsweredForThread },
    } as unknown as AgentRouterDeps)).resolves.toEqual({
      messages: messagePage.messages,
      hasMore: true,
      answeredPlanMessageIds: ["message-1"],
    });

    expect(listByThread).toHaveBeenCalledWith("thread-1", 50, 43);
    expect(listAnsweredForThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not delay a new worktree thread when its watcher fails", async () => {
    const thread = {
      id: "thread-2",
      mode: "worktree",
      worktree_path: "C:/repo-worktree",
    };
    const createAndSend = vi.fn().mockResolvedValue(thread);
    const watchThreadWorktree = vi.fn().mockRejectedValue(new Error("watch failed"));

    await expect(routeAgentRpc("agent.createAndSend", {
      workspaceId: "workspace-1",
      content: "Start work",
      model: "gpt-5",
    }, {
      agentService: { createAndSend },
      gitWatcherService: { watchThreadWorktree },
    } as unknown as AgentRouterDeps)).resolves.toBe(thread);

    expect(createAndSend).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      content: "Start work",
      displayContent: "Start work",
      model: "gpt-5",
    });
    expect(watchThreadWorktree).toHaveBeenCalledWith("thread-2", "C:/repo-worktree");
  });
});
