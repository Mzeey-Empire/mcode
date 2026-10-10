import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { routeAgentRpc, type AgentRouterDeps } from "../agent-rpc.js";
import { PlanServiceError } from "../../planning/plan-service.js";
import type { PlanVersion } from "@mcode/contracts";
import type { SendMessageCommand } from "../../turns/turn-admission-dispatch-coordinator.js";

function admissionFixture(sendMessage: AgentRouterDeps["agentService"]["sendMessage"]): {
  deps: AgentRouterDeps; close(): void;
} {
  const unused = (): never => { throw new Error("Unexpected dependency in admission-only route"); };
  const deps: AgentRouterDeps = {
    agentService: { sendMessage, createAndSend: unused, stopSession: unused, runtimeAccess: unused },
    agentPermissionService: { respondToPermission: unused, listPendingPermissions: unused },
    hookExecutionRepo: { listByMessage: unused },
    messageRepo: { listByThread: unused, listByThreadAfter: unused, listSessionNotices: unused, confirmUserMessage: unused },
    narrativeStore: { load: unused },
    planQuestionAnswersRepo: { listAnsweredForThread: unused },
    planService: { saveVersion: unused, snapshot: unused },
    planTurnService: { answerQuestions: unused, dismissQuestions: unused },
    recapService: { generate: unused },
    subagentLifecycleService: { loadRoster: unused, stop: unused },
    taskRepo: { get: unused },
    thoughtSegmentRepo: { listByMessage: unused },
    threadControlService: { respondToApproval: unused, listPendingApprovals: unused },
    toolCallRecordRepo: { listByMessage: unused, listByParent: unused },
    turnRecoveryService: { currentRecoveryIncident: unused, retry: unused },
  };
  return { deps, close: () => undefined };
}

describe("routeMessage Agent RPCs", () => {
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

  it("retries the recovered command with its raw display content", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn(async (_executionId, dispatch) => {
      await dispatch({
        threadId: "thread-1",
        content: "Retry this work",
        model: "gpt-5",
      });
    });

    const response = await routeMessage(JSON.stringify({
      id: "retry-1",
      method: "agent.retry",
      params: { executionId: "00000000-0000-4000-8000-000000000001" },
    }), {
      agentService: { sendMessage },
      turnRecoveryService: { retry },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "retry-1", result: undefined });
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

  it("falls through from thread-control permission requests to agent requests", async () => {
    const calls: string[] = [];
    const respondToApproval = vi.fn(async () => {
      calls.push("thread-control");
      return false;
    });
    const respondToPermission = vi.fn(() => {
      calls.push("agent");
    });

    const response = await routeMessage(JSON.stringify({
      id: "permission-1",
      method: "permission.respond",
      params: { requestId: "request-1", decision: "allow" },
    }), {
      threadControlService: { respondToApproval },
      agentPermissionService: { respondToPermission },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "permission-1", result: undefined });
    expect(calls).toEqual(["thread-control", "agent"]);
  });

  it("forwards exact question answers and rejects malformed answer payloads", async () => {
    const respondToApproval = vi.fn(async () => false);
    const respondToPermission = vi.fn();
    const deps = {
      threadControlService: { respondToApproval },
      agentPermissionService: { respondToPermission },
    } as unknown as RouterDeps;

    const accepted = await routeMessage(JSON.stringify({
      id: "question-1",
      method: "permission.respond",
      params: { requestId: "que_1", decision: "allow", answers: [[" staging "]] },
    }), deps);
    expect(accepted).toEqual({ id: "question-1", result: undefined });
    expect(respondToPermission).toHaveBeenCalledWith("que_1", "allow", [[" staging "]], undefined);

    const rejected = await routeMessage(JSON.stringify({
      id: "question-2",
      method: "permission.respond",
      params: { requestId: "que_1", decision: "allow", answers: [[" "]] },
    }), deps);
    expect(rejected.error).toBeDefined();
    expect(respondToPermission).toHaveBeenCalledTimes(1);
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
      command?.onAdmissionComplete?.();
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
