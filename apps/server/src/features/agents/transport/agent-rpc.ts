import type {
  SubagentRosterRequest,
  CanonicalSubagentStopRequest,
  WsMethodName,
} from "@mcode/contracts";
import { toPreviewAnnotationBundleV2, WS_METHODS } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import * as NodePerfHooks from "node:perf_hooks";
import type { z } from "zod";
import type { GitWatcherService } from "../../projects/git/git-watcher-service.js";
import type { ThreadControlService } from "../../thread-control/authority/thread-control-service.js";
import type { SubagentRosterService } from "../collaboration/subagent-roster-service.js";
import {
  loadConversationPage,
  loadConversationTail,
  loadNewerConversationPage,
  loadOlderConversationPage,
  type ConversationPageDeps,
} from "../conversation/read-model/conversation-page.js";
import type { ThoughtSegmentRepo } from "../conversation/narrative/persistence/thought-segment-repo.js";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import type { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { HookExecutionRepo } from "../events/persistence/hook-execution-repo.js";
import type { AgentService } from "../orchestration/agent-service.js";
import { appendPreviewAnnotations, sendAdmittedTurn, sendRecoveryAttempt } from "./turn-message-dispatch.js";
import type { TurnResumeScheduler } from "../recovery/turn-resume-scheduler.js";
import { serverWorkTrace } from "../diagnostics/server-work-trace.js";
import type { AgentTurnContinuationPort } from "../orchestration/agent-runtime-internal-ports.js";
import type { TaskRepo } from "../orchestration/persistence/task-repo.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import type { PlanTurnService } from "../planning/plan-turn-service.js";
import type { PlanService } from "../planning/plan-service.js";
import type { RecapService } from "../recap/recap-service.js";
import type { TurnRecoveryService } from "../recovery/turn-recovery-service.js";
import type { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";
import type { TurnSteerService } from "../steering/turn-steer-service.js";

type AgentRpcMethod =
  | "agent.send"
  | "agent.confirmMessage"
  | "agent.steer"
  | "agent.listHeldSteers"
  | "agent.settleUnknownSteer"
  | "turn.retry"
  | "turn.resume"
  | "turn.resume.schedule"
  | "turn.resume.unschedule"
  | "agent.continueWithoutSaving"
  | "agent.createAndSend"
  | "agent.stop"
  | "agent.retrySave"
  | "agent.activeCount"
  | "agent.listRunning"
  | "agent.answerQuestions"
  | "agent.dismissPlanQuestions"
  | "agent.child.stop"
  | "subagent.roster"
  | "subagent.detail"
  | "plan.saveVersion"
  | "plan.snapshot"
  | "plan.implement"
  | "plan.comment.create"
  | "plan.comment.update"
  | "plan.comment.setStatus"
  | "plan.comment.delete"
  | "message.list"
  | "conversation.page"
  | "conversation.olderPage"
  | "conversation.newerPage"
  | "conversation.tail"
  | "toolCallRecord.list"
  | "toolCallRecord.listByParent"
  | "turn.load"
  | "narrative.list"
  | "thread.getTasks"
  | "approval.respond"
  | "approval.listPending"
  | "recap.generate";

type AgentRpcParams<Method extends AgentRpcMethod> = Method extends "subagent.roster"
  ? SubagentRosterRequest
  : Method extends "agent.child.stop"
    ? CanonicalSubagentStopRequest
    : z.output<ReturnType<typeof WS_METHODS>[Method]["params"]>;

/** Defines the services required to route validated Agent RPC calls. */
export interface AgentRouterDeps {
  canonicalProgress?: Pick<import("../canonical/canonical-accepted-progress.js").CanonicalAcceptedProgress,
    "retry" | "getTasks">;
  agentService: Pick<
    AgentService,
    "sendMessage" | "createAndSend" | "stopSession" | "runtimeAccess"
  >;
  agentContinuation?: Pick<AgentTurnContinuationPort, "continueWithoutSaving">;
  approvalService: Pick<
    ApprovalService,
    "respondToApproval" | "listPendingApprovals"
  >;
  gitWatcherService?: Pick<GitWatcherService, "watchThreadWorktree">;
  hookExecutionRepo: Pick<HookExecutionRepo, "listByMessage">;
  messageRepo: ConversationPageDeps["messageRepo"] & Pick<MessageRepo, "confirmUserMessage">;
  narrativeStore: Pick<NarrativeStore, "load" | "listApprovals">;
  planQuestionAnswersRepo: ConversationPageDeps["planQuestionAnswersRepo"];
  planService: Pick<PlanService, "saveVersion" | "snapshot" | "implement" | "createComment" | "updateComment" | "setCommentStatus" | "deleteComment">;
  planTurnService: Pick<PlanTurnService, "answerQuestions" | "dismissQuestions">;
  recapService: Pick<RecapService, "generate">;
  subagentRosterService: Pick<SubagentRosterService, "loadRoster" | "loadDetail" | "stop">;
  taskRepo: Pick<TaskRepo, "get">;
  thoughtSegmentRepo: Pick<ThoughtSegmentRepo, "listByMessage">;
  threadControlService: Pick<
    ThreadControlService,
    "respondToApproval" | "listPendingApprovals"
  >;
  toolCallRecordRepo: Pick<ToolCallRecordRepo, "listByMessage" | "listByParent">;
  turnRecoveryService: Pick<TurnRecoveryService, "retryErroredTurn" | "resumeTurn">;
  turnResumeScheduler: Pick<TurnResumeScheduler, "schedule" | "unschedule">;
  turnSteers?: Pick<TurnSteerService, "steer" | "listHeldSteers" | "settleUnknownSteer">;
}

type AgentRpcHandlerMap = {
  [Method in AgentRpcMethod]: (
    deps: AgentRouterDeps,
    params: AgentRpcParams<Method>,
  ) => Promise<unknown> | unknown;
};

const pendingMessageAdmissions = new Map<string, Set<Promise<void>>>();

function registerMessageAdmission(params: AgentRpcParams<"agent.send">): (() => void) | undefined {
  if (!params.messageId) return undefined;
  const key = JSON.stringify([params.threadId, params.messageId]);
  const pending = pendingMessageAdmissions.get(key) ?? new Set<Promise<void>>();
  let resolveAdmission!: () => void;
  const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
  pending.add(admission);
  pendingMessageAdmissions.set(key, pending);
  return () => {
    pending.delete(admission);
    if (pending.size === 0) pendingMessageAdmissions.delete(key);
    resolveAdmission();
  };
}

const agentHandlers: AgentRpcHandlerMap = {
  "agent.send": async (deps, params) => {
    const settleAdmission = registerMessageAdmission(params);
    const started = serverWorkTrace ? NodePerfHooks.performance.now() : 0;
    try {
      const previewAnnotations = params.previewAnnotations && toPreviewAnnotationBundleV2(params.previewAnnotations);
      await sendAdmittedTurn(deps.agentService, {
        ...params,
        previewAnnotations,
        content: appendPreviewAnnotations(params.content, previewAnnotations),
        displayContent: params.displayContent ?? params.content,
      });
    } finally {
      settleAdmission?.();
      if (serverWorkTrace) serverWorkTrace.record("agent-send", params.threadId, undefined, NodePerfHooks.performance.now() - started);
    }
  },
  "agent.confirmMessage": async (deps, params) => {
    const key = JSON.stringify([params.threadId, params.messageId]);
    let pending = pendingMessageAdmissions.get(key);
    while (pending) {
      await Promise.all(pending);
      pending = pendingMessageAdmissions.get(key);
    }
    return { admitted: await deps.messageRepo.confirmUserMessage(params.threadId, params.messageId) };
  },
  "agent.steer": (deps, params) => requireTurnSteers(deps).steer(params),
  "agent.listHeldSteers": (deps) => requireTurnSteers(deps).listHeldSteers(),
  "agent.settleUnknownSteer": (deps, params) => requireTurnSteers(deps).settleUnknownSteer(params),
  "turn.retry": (deps, params) => deps.turnRecoveryService.retryErroredTurn(params, (command) =>
    sendRecoveryAttempt(deps.agentService, command)),
  "turn.resume": (deps, params) => deps.turnRecoveryService.resumeTurn(params, (command) =>
    sendRecoveryAttempt(deps.agentService, command)),
  "turn.resume.schedule": (deps, params) => deps.turnResumeScheduler.schedule(params),
  "turn.resume.unschedule": (deps, params) => deps.turnResumeScheduler.unschedule(params.threadId),
  "agent.continueWithoutSaving": (deps, params) => {
    if (!deps.agentContinuation) throw new Error("Agent turn continuation is unavailable");
    deps.agentContinuation.continueWithoutSaving(params.executionId);
  },
  "agent.createAndSend": async (deps, params) => {
    const previewAnnotations = params.previewAnnotations && toPreviewAnnotationBundleV2(params.previewAnnotations);
    const thread = await deps.agentService.createAndSend({
      ...params,
      previewAnnotations,
      content: appendPreviewAnnotations(params.content, previewAnnotations),
      displayContent: params.displayContent ?? params.content,
    });
    watchReturnedThreadWorktree(deps, thread);
    return thread;
  },
  "agent.stop": (deps, params) => deps.agentService.stopSession(params.threadId, { by: "user" }),
  "agent.retrySave": (deps, params) => ({ retried: deps.canonicalProgress?.retry(params.threadId) ?? false }),
  "agent.activeCount": (deps) => deps.agentService.runtimeAccess().activeCount(),
  // The runtime registry is the reconnect snapshot authority: startup recovery
  // interrupts every unfinished canonical checkpoint, so registry entries are
  // exactly the executions canonical state still considers live.
  "agent.listRunning": (deps) => deps.agentService.runtimeAccess().runtimeSnapshots(),
  "agent.answerQuestions": async (deps, params) => {
    await deps.planTurnService.answerQuestions(
      params.threadId,
      params.answers,
      params.permissionMode ?? "default",
      params.reasoningLevel,
      params.contextWindow,
      params.thinking,
    );
  },
  "agent.dismissPlanQuestions": (deps, params) => {
    deps.planTurnService.dismissQuestions(params.threadId);
  },
  "agent.child.stop": (deps, params) => deps.subagentRosterService.stop(params),
  "subagent.roster": (deps, params) => deps.subagentRosterService.loadRoster(params),
  "subagent.detail": (deps, params) => deps.subagentRosterService.loadDetail(params),
  "plan.saveVersion": (deps, params) => deps.planService.saveVersion(params),
  "plan.snapshot": (deps, params) => deps.planService.snapshot(params),
  "plan.implement": (deps, params) => deps.planService.implement(params),
  "plan.comment.create": (deps, params) => deps.planService.createComment(params),
  "plan.comment.update": (deps, params) => deps.planService.updateComment(params),
  "plan.comment.setStatus": (deps, params) => deps.planService.setCommentStatus(params),
  "plan.comment.delete": (deps, params) => deps.planService.deleteComment(params),
  "message.list": (deps, params) => ({
    ...deps.messageRepo.listByThread(params.threadId, params.limit, params.before),
    answeredPlanMessageIds: deps.planQuestionAnswersRepo.listAnsweredForThread(params.threadId),
  }),
  "conversation.page": (deps, params) => loadConversationPage(deps, params),
  "conversation.olderPage": (deps, params) => loadOlderConversationPage(deps, params),
  "conversation.newerPage": (deps, params) => loadNewerConversationPage(deps, params),
  "conversation.tail": (deps, params) => loadConversationTail(deps, params),
  "toolCallRecord.list": (deps, params) => deps.toolCallRecordRepo.listByMessage(params.messageId),
  "toolCallRecord.listByParent": (deps, params) =>
    deps.toolCallRecordRepo.listByParent(params.parentToolCallId),
  "turn.load": (deps, params) => deps.narrativeStore.load(params.threadId, params.range),
  "narrative.list": (deps, params) => ({
    tools: deps.toolCallRecordRepo.listByMessage(params.messageId),
    thoughts: deps.thoughtSegmentRepo.listByMessage(params.messageId),
    hooks: deps.hookExecutionRepo.listByMessage(params.messageId),
    approvals: deps.narrativeStore.listApprovals(params.messageId),
  }),
  "thread.getTasks": (deps, params) => deps.canonicalProgress?.getTasks(params.threadId) ?? deps.taskRepo.get(params.threadId),
  "approval.respond": async (deps, params) => {
    const { requestId, ...response } = params;
    return deps.approvalService.respondToApproval(requestId, response);
  },
  "approval.listPending": (deps, params) => deps.approvalService.listPendingApprovals(params.threadId),
  "recap.generate": (deps, params) => deps.recapService.generate(params),
};

function requireTurnSteers(deps: AgentRouterDeps): NonNullable<AgentRouterDeps["turnSteers"]> {
  if (!deps.turnSteers) throw new Error("Steering is unavailable");
  return deps.turnSteers;
}

/** Checks whether a WebSocket method belongs to the Agent RPC family. */
export function isAgentRpcMethod(method: WsMethodName): method is AgentRpcMethod {
  return Object.hasOwn(agentHandlers, method);
}

/** Routes validated Agent RPC parameters to their feature service methods. */
export async function routeAgentRpc<Method extends AgentRpcMethod>(
  method: Method,
  params: AgentRpcParams<Method>,
  deps: AgentRouterDeps,
): Promise<unknown> {
  return await agentHandlers[method](deps, params);
}

function watchReturnedThreadWorktree(
  deps: Pick<AgentRouterDeps, "gitWatcherService">,
  thread: { id: string; mode: string; worktree_path: string | null },
): void {
  if (thread.mode !== "worktree" || !thread.worktree_path) return;
  void Promise.resolve(
    deps.gitWatcherService?.watchThreadWorktree?.(thread.id, thread.worktree_path),
  ).catch((error: unknown) => {
    logger.warn("Failed to start thread worktree watcher", {
      threadId: thread.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
