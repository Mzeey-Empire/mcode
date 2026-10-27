import { AgentEventType, type AgentEvent } from "@mcode/contracts/events/agent-event";
import { type ContextWindowMode } from "@mcode/contracts/models/settings";
import { type ProviderBillingMode } from "@mcode/contracts/providers/usage";
import { type ProviderIdentity } from "@mcode/contracts/compat/agent-model";
import { type TurnFailure } from "@mcode/contracts/models/turn-failure";
import { logger } from "@mcode/shared";
import type { ProviderBackgroundToolSettlement } from "../../host-ports.js";
import { clampContextWindowToMode } from "./context-window.js";
import { parseClaudeGoalCommandResult } from "./claude-goal-command-parser.js";
import {
  classifyClaudeFailure,
  type ClaudeApiRetryEvidence,
  type ClaudeRateLimitEvidence,
} from "./claude-failure-classifier.js";

type Message = Record<string, unknown>;
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string;
};

/** Exact native parent evidence; absence never declares a root or active child. */
export type ClaudeParentEvidence = { kind: "absent" } | { kind: "root" } | { kind: "native"; id: string };
/** Native source identity travels with the semantic event produced from it. */
export interface ClaudeEventEvidence {
  parent: ClaudeParentEvidence;
  sourceIdentities: readonly ProviderIdentity[];
  nativeEventId?: string;
}
const MAX_TRACKED_TOOLS = 4_096;
/** Contract bound on one `reasoningDelta` text. */
const MAX_REASONING_DELTA_LENGTH = 65_536;
// Leaves room for the ":thinking:<index>" suffix inside the contract's 256-char item id bound.
const MAX_REASONING_MESSAGE_KEY = 200;
/**
 * Error results the Claude CLI synthesizes when a user interrupt ends a running
 * tool. They report a cancel, not a tool failure.
 */
const CLAUDE_USER_INTERRUPT_RESULTS: ReadonlySet<string> = new Set([
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
]);
// A warning reports usage while requests still succeed, so only a rejection is a block.
const RATE_LIMIT_ACTIVE_BY_STATUS: ReadonlyMap<string, boolean> = new Map([["allowed", false], ["allowed_warning", false], ["rejected", true]]);
// A stopped task was ended on purpose, so it reads as cancelled rather than failed.
const BACKGROUND_TASK_STATUS: ReadonlyMap<string, BackgroundToolStatus> = new Map([
  ["completed", "completed"], ["failed", "failed"], ["stopped", "cancelled"],
]);
const SESSION_ENDED_OUTPUT = "Stopped when the Claude session ended.";
// The CLI frames a subagent's report for the model's benefit. It indents every report
// line, so the first column-zero line after the frame ends the report.
const HANDBACK_FRAME_PREFIX = "[Subagent hand-back] ";
const HANDBACK_REPORT_INDENT = "  ";
const AGENT_RESUME_TRAILER = /^agentId: \S+ \(use SendMessage/;
type BackgroundToolStatus = ProviderBackgroundToolSettlement["status"];

/** State read by the Claude SDK event mapper. */
export interface ClaudeMappedSession {
  model: string;
  contextWindowMode: ContextWindowMode | undefined;
  pendingToolUses: Set<string>;
  hasFiredToolThisTurn: boolean;
  poisoned?: boolean;
}

/** Claude provider callbacks used by the stream event mapper. */
export interface ClaudeEventMapperCallbacks {
  emit(event: AgentEvent, evidence: ClaudeEventEvidence): void;
  getSession(): ClaudeMappedSession | undefined;
  captureSdkSessionId(id: string): boolean;
  observeNativeGoalCommands(
    commands: readonly unknown[],
    version?: unknown,
  ): void;
  applyNativeGoalCommandResult(
    result: NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>>,
  ): void;
  invalidateSdkSession(): void;
  markSessionPoisoned(): void;
  updateUsage(metrics: ClaudeUsageMetrics): ClaudeUsageSnapshot;
  invalidateUsage(): void;
  resolveBillingMode(): Promise<ProviderBillingMode>;
  isSessionStartHookSuppressed(): boolean;
  clearSessionStartHookSuppression(): void;
  /** Execution whose turn is open now; undefined between turns. */
  liveExecutionId(): string | undefined;
  /** Settles a background call whose launching turn has already ended. */
  settleBackgroundTool(settlement: Omit<ProviderBackgroundToolSettlement, "threadId">): void;
}

/** Usage metrics read from a successful Claude result message. */
export interface ClaudeUsageMetrics {
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  serviceTier?: "standard" | "priority" | "batch";
}
/** Usage data included in the provider quota event. */
export interface ClaudeUsageSnapshot {
  sessionCostUsd?: number;
  serviceTier?: "standard" | "priority" | "batch";
  numTurns?: number;
  durationMs?: number;
}
/** Mapping result needed by the stream lifecycle. */
export type ClaudeMapOutcome = "none" | "turn_complete" | "result_error";

/** Converts Claude SDK messages to provider-neutral events. */
export class ClaudeEventMapper {
  private lastAssistantText = "";
  // The CLI yields each finished block before the API reports stop_reason, so main-thread text waits for message_delta, a tool call, or the result.
  private boundaryAwaitsStopReason = false;
  private lastInputTokens: number | undefined;
  private lastContextWindow: number | undefined;
  private compacting = false;
  private readonly toolUseIds = new Set<string>();
  private readonly toolParents = new Map<string, ClaudeParentEvidence>();
  /** Agent calls by id, with the run settings already reported for each. */
  private readonly subagentRuns = new Map<string, { parentToolCallId: string | undefined; model?: string; reasoningEffort?: string }>();
  /** Open thinking content-block index to its reasoning item id, for the message currently streaming. */
  private readonly reasoningItemByBlock = new Map<number, string>();
  private reasoningMessageKey: string | undefined;
  private reasoningMessageOrdinal = 0;
  private nativeSource: Message = {};
  private assistantError: string | undefined;
  private apiError: string | undefined;
  private lastApiRetry: ClaudeApiRetryEvidence | undefined;
  // Claude reports rate-limit info only when it changes, so the last report outlives the turn that saw it.
  private lastRateLimit: ClaudeRateLimitEvidence | undefined;
  private readonly handlers: ReadonlyMap<
    string,
    (message: Message) => ClaudeMapOutcome | Promise<ClaudeMapOutcome>
  >;
  private readonly systemHandlers: ReadonlyMap<
    string,
    (message: Message) => void
  >;

  constructor(
    private readonly sessionId: string,
    private readonly threadId: string,
    private readonly callbacks: ClaudeEventMapperCallbacks,
    /** Background calls the SDK process still runs, keyed to the execution that launched them. */
    private readonly backgroundTools: Map<string, string> = new Map(),
  ) {
    this.handlers = new Map<
      string,
      (message: Message) => ClaudeMapOutcome | Promise<ClaudeMapOutcome>
    >([
      ["assistant", this.assistant.bind(this)],
      ["result", this.result.bind(this)],
      ["system", this.system.bind(this)],
      ["tool_use", this.standaloneToolUse.bind(this)],
      ["tool_result", this.toolResult.bind(this)],
      ["user", this.user.bind(this)],
      ["stream_event", this.streamEvent.bind(this)],
      ["tool_progress", this.toolProgress.bind(this)],
      ["rate_limit_event", this.rateLimit.bind(this)],
    ]);
    this.systemHandlers = new Map([
      ["init", this.systemInit.bind(this)],
      ["status", this.systemStatus.bind(this)],
      ["compact_boundary", this.compactBoundary.bind(this)],
      ["api_retry", this.apiRetry.bind(this)],
      ["hook_started", this.hookStarted.bind(this)],
      ["hook_progress", this.hookProgress.bind(this)],
      ["hook_response", this.hookResponse.bind(this)],
    ]);
  }

  /** Captures a valid SDK session identity before lifecycle routing. */
  captureSessionIdentity(message: Message, sessionInitialized: boolean): void {
    this.nativeSource = message;
    readParentEvidence(message);
    this.captureSessionId(message, sessionInitialized);
  }

  /** Maps one message after the lifecycle has confirmed whether the session is live. */
  async map(message: Message): Promise<ClaudeMapOutcome> {
    this.nativeSource = message;
    readParentEvidence(message);
    const type = typeof message.type === "string" ? message.type : "";
    const handler = this.handlers.get(type);
    return handler ? await handler(message) : "none";
  }

  /** Resets only derived attribution when a new queued execution consumes its prompt. */
  resetExecution(): void {
    this.toolUseIds.clear();
    this.toolParents.clear();
    this.subagentRuns.clear();
    this.reasoningItemByBlock.clear();
    this.reasoningMessageKey = undefined;
    this.lastAssistantText = "";
    this.boundaryAwaitsStopReason = false;
    this.lastInputTokens = undefined;
    this.nativeSource = {};
    this.resetFailureEvidence();
  }

  /** Classifies an exception thrown by the SDK stream with the evidence the turn gathered so far. */
  classifyStreamFailure(error: unknown, now: number): TurnFailure {
    return classifyClaudeFailure({
      assistantError: this.assistantError,
      apiError: this.apiError,
      rateLimit: this.lastRateLimit,
      apiRetry: this.lastApiRetry,
      streamErrorCode: nodeErrorCode(error),
    }, now);
  }

  private resetFailureEvidence(): void {
    this.assistantError = undefined;
    this.apiError = undefined;
    this.lastApiRetry = undefined;
  }

  /**
   * Settles a held background call from its SDK task notification. Runs before
   * turn ownership is checked because the notification usually arrives between turns.
   */
  settleBackgroundTask(message: Message): void {
    if (message.type !== "system" || message.subtype !== "task_notification") return;
    const toolCallId = validIdentity(message.tool_use_id);
    const executionId = toolCallId && this.backgroundTools.get(toolCallId);
    const status = BACKGROUND_TASK_STATUS.get(stringValue(message.status));
    if (!toolCallId || !executionId || !status) return;
    this.backgroundTools.delete(toolCallId);
    this.settleBackgroundTool(toolCallId, executionId, status, stringValue(message.summary));
  }

  /**
   * True for a step of a held background call's subagent. The subagent keeps
   * streaming after its launching turn ends, but its steps are not a turn Claude started.
   */
  isBackgroundTaskOutput(message: Message): boolean {
    const parent = parentId(message);
    return parent !== undefined && this.backgroundTools.has(parent);
  }

  /** Stops every held call because the SDK process that runs them is gone. */
  settleAllBackgroundTools(): void {
    this.nativeSource = {};
    for (const [toolCallId, executionId] of this.backgroundTools) {
      this.backgroundTools.delete(toolCallId);
      this.settleBackgroundTool(toolCallId, executionId, "cancelled", SESSION_ENDED_OUTPUT);
    }
  }

  private settleBackgroundTool(toolCallId: string, executionId: string, status: BackgroundToolStatus, output: string): void {
    if (executionId !== this.callbacks.liveExecutionId()) {
      this.callbacks.settleBackgroundTool({ executionId, toolCallId, status, output });
      return;
    }
    this.emit({
      type: AgentEventType.ToolResult,
      threadId: this.threadId,
      toolCallId,
      output,
      isError: status === "failed",
      ...(status === "cancelled" && { cancelled: true }),
    });
  }

  private captureSessionId(message: Message, initialized: boolean): void {
    const id = message.session_id;
    if (
      !initialized ||
      typeof id !== "string" ||
      id.trim().length === 0 ||
      !this.callbacks.captureSdkSessionId(id)
    )
      return;
    this.emit({
      type: AgentEventType.System,
      threadId: this.threadId,
      subtype: `sdk_session_id:${id}`,
    });
  }

  private assistant(message: Message): ClaudeMapOutcome {
    const assistant = message.message as
      { content?: Message[]; stop_reason?: string | null } | undefined;
    const content = assistant?.content ?? [];
    const parentToolCallId = parentId(message);
    // A subagent's API error ends only that subagent, not the turn. A later main-thread message
    // without an error means the CLI recovered, so the earlier error no longer explains a failure.
    if (!parentToolCallId) {
      this.assistantError = stringOrUndefined(message.error);
      this.apiError = stringOrUndefined(message.api_error);
    }
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => stringValue(block.text))
      .join("");
    if (text) {
      this.lastAssistantText = text;
      this.classifyAssistantText(assistant?.stop_reason ?? null, parentToolCallId);
    }
    this.emitToolUses(content, parentToolCallId);
    if (parentToolCallId) this.reportSubagentRun(parentToolCallId, { model: runModel(objectValue(assistant).model) });
    return "none";
  }

  private classifyAssistantText(stopReason: string | null, parentToolCallId: string | undefined): void {
    if (stopReason === null && !parentToolCallId) this.boundaryAwaitsStopReason = true;
    else this.emitBoundary(finalStopReason(stopReason));
  }

  private emitToolUses(content: Message[], parentToolCallId: string | undefined): void {
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (!parentToolCallId) this.emitPendingBoundary(false);
      this.emitToolUse(block, parentToolCallId);
    }
  }

  private emitBoundary(isFinalResponse: boolean): void {
    this.boundaryAwaitsStopReason = false;
    this.emit({ type: AgentEventType.AssistantMessageBoundary, threadId: this.threadId, isFinalResponse });
  }

  private emitPendingBoundary(isFinalResponse: boolean): void {
    if (this.boundaryAwaitsStopReason) this.emitBoundary(isFinalResponse);
  }

  /**
   * Adds the model or effort a subagent actually ran with to its Agent call.
   * The Agent input names a model only when Claude overrides it, so the run itself is the evidence.
   */
  reportSubagentRun(agentToolCallId: string, run: { model?: string; reasoningEffort?: string }): void {
    const reported = this.subagentRuns.get(agentToolCallId);
    if (!reported) return;
    const toolInput: Record<string, string> = {};
    if (run.model && !reported.model) toolInput.model = reported.model = run.model;
    if (run.reasoningEffort && !reported.reasoningEffort) toolInput.reasoningEffort = reported.reasoningEffort = run.reasoningEffort;
    if (Object.keys(toolInput).length === 0) return;
    // An empty source makes emit attribute the Agent call to its own recorded parent, not to the child message.
    const source = this.nativeSource;
    this.nativeSource = {};
    try {
      this.emit({ type: AgentEventType.ToolUse, threadId: this.threadId, toolCallId: agentToolCallId, toolName: "Agent", toolInput, parentToolCallId: reported.parentToolCallId });
    } finally {
      this.nativeSource = source;
    }
  }

  private emitToolUse(
    block: Message,
    parentToolCallId: string | undefined,
  ): void {
    const toolCallId = stringValue(block.id);
    this.rememberToolParent(toolCallId);
    if (toolCallId && this.toolUseIds.has(toolCallId)) return;
    if (toolCallId) this.registerToolUse(toolCallId);
    const toolName = stringOr(block.name, "unknown");
    if (toolName === "Agent" && toolCallId) this.trackSubagentRun(toolCallId, parentToolCallId);
    logger.debug("Claude ToolUse from assistant block", {
      toolId: toolCallId,
      toolName,
      parent_tool_use_id: parentToolCallId ?? null,
    });
    this.emit({
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName,
      toolInput: canonicalToolInput(toolName, objectValue(block.input)),
      parentToolCallId,
    });
  }

  private trackSubagentRun(toolCallId: string, parentToolCallId: string | undefined): void {
    if (this.subagentRuns.size >= MAX_TRACKED_TOOLS) throw new Error("Claude native tool identity bound exceeded");
    this.subagentRuns.set(toolCallId, { parentToolCallId });
  }

  private registerToolUse(id: string): void {
    if (!validIdentity(id)) throw new Error("Invalid Claude native tool identity");
    if (this.toolUseIds.size >= MAX_TRACKED_TOOLS) throw new Error("Claude native tool identity bound exceeded");
    this.toolUseIds.add(id);
    const session = this.callbacks.getSession();
    if (!session) return;
    session.pendingToolUses.add(id);
    session.hasFiredToolThisTurn = true;
  }

  private async result(message: Message): Promise<ClaudeMapOutcome> {
    if (message.is_error === true) return this.resultError(message);
    const usage = usageValue(message);
    this.observeGoal(message);
    this.emitResultMessage(usage);
    this.emitFallback(message);
    const snapshot = this.callbacks.updateUsage(metrics(message, usage));
    // The canonical writer rejects non-hook events after the terminal event, so quota must precede turnComplete.
    await this.emitQuotaUpdate(snapshot);
    this.emitTurnComplete(message, usage);
    this.resetResult();
    this.resetFailureEvidence();
    return "turn_complete";
  }

  /**
   * Close a segment the CLI cut short to answer a steered message. Its text and usage are kept,
   * but the turn goes on, so no turn-complete event is emitted.
   */
  closeAbortedSegment(message: Message): void {
    const usage = usageValue(message);
    this.emitResultMessage(usage);
    this.callbacks.updateUsage(metrics(message, usage));
    this.resetResult();
  }

  private resultError(message: Message): ClaudeMapOutcome {
    if (unrecoverableThinkingError(message.result))
      this.invalidatePoisonedSession();
    else this.emitResultError(message);
    this.resetResult();
    this.resetFailureEvidence();
    return "result_error";
  }

  private invalidatePoisonedSession(): void {
    logger.warn(
      "Claude session poisoned by unmodifiable thinking block; abandoning session",
      { sessionId: this.sessionId, threadId: this.threadId },
    );
    this.callbacks.invalidateSdkSession();
    this.callbacks.markSessionPoisoned();
    this.emit({
      type: AgentEventType.System,
      threadId: this.threadId,
      subtype: "sdk_session_invalidated",
    });
  }

  private emitResultError(message: Message): void {
    const errors = Array.isArray(message.errors) ? message.errors : [];
    const error =
      errors.join(", ") ||
      resultErrorText(message) ||
      "Claude SDK returned an error result";
    logger.error("Claude SDK result error", {
      sessionId: this.sessionId,
      threadId: this.threadId,
      errors,
      subtype: message.subtype,
      payload: message,
    });
    const failure = classifyClaudeFailure({
      assistantError: this.assistantError,
      apiError: stringOrUndefined(message.api_error) ?? this.apiError,
      resultSubtype: stringOrUndefined(message.subtype),
      terminalReason: stringOrUndefined(message.terminal_reason),
      startupFailureReason: stringOrUndefined(message.startup_failure_reason),
      apiErrorStatus: numberValue(message.api_error_status),
      rateLimit: this.lastRateLimit,
      apiRetry: this.lastApiRetry,
    }, Date.now());
    this.emit({ type: AgentEventType.Error, threadId: this.threadId, error, failure });
  }

  private observeGoal(message: Message): void {
    const goal = parseClaudeGoalCommandResult(this.lastAssistantText, message);
    if (goal) this.callbacks.applyNativeGoalCommandResult(goal);
  }

  private emitResultMessage(usage: Usage): void {
    if (!this.lastAssistantText) return;
    this.emitPendingBoundary(true);
    this.emit({
      type: AgentEventType.Message,
      threadId: this.threadId,
      content: this.lastAssistantText,
      tokens: usage.output_tokens ?? null,
    });
  }

  private emitFallback(message: Message): void {
    const requestedModel = this.callbacks.getSession()?.model;
    const actualModel = requestedModel
      ? fallbackModel(objectValue(message.modelUsage), requestedModel)
      : undefined;
    if (requestedModel && actualModel)
      this.emit({
        type: AgentEventType.ModelFallback,
        threadId: this.threadId,
        requestedModel,
        actualModel,
      });
  }

  private emitTurnComplete(message: Message, usage: Usage): void {
    const session = this.callbacks.getSession();
    const contextWindow = resultContextWindow(message, session);
    this.emit({
      type: AgentEventType.TurnComplete,
      threadId: this.threadId,
      reason: stringOr(
        message.stop_reason,
        stringOr(message.subtype, "end_turn"),
      ),
      costUsd: numberOrNull(message.total_cost_usd),
      tokensIn: this.lastInputTokens ?? inputTokens(usage),
      tokensOut: usage.output_tokens ?? 0,
      contextWindow,
      totalProcessedTokens: inputTokens(usage) + (usage.output_tokens ?? 0),
      cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
      providerId: "claude",
    });
    this.lastContextWindow = contextWindow;
  }

  private async emitQuotaUpdate(snapshot: ClaudeUsageSnapshot): Promise<void> {
    this.callbacks.invalidateUsage();
    this.emit({
      type: AgentEventType.QuotaUpdate,
      threadId: this.threadId,
      providerId: "claude",
      categories: [],
      billingMode: await this.callbacks.resolveBillingMode(),
      ...snapshot,
    });
  }

  private resetResult(): void {
    this.lastAssistantText = "";
    this.boundaryAwaitsStopReason = false;
    this.lastInputTokens = undefined;
  }

  private system(message: Message): ClaudeMapOutcome {
    const subtype = stringOr(message.subtype, "unknown");
    const handler =
      this.systemHandlers.get(subtype) ?? this.unknownSystem.bind(this);
    handler(message);
    return "none";
  }

  private systemInit(message: Message): void {
    if (Array.isArray(message.slash_commands))
      this.callbacks.observeNativeGoalCommands(
        message.slash_commands,
        message.claude_code_version,
      );
  }
  private systemStatus(message: Message): void {
    const active = message.status === "compacting";
    if (active !== this.compacting) {
      this.compacting = active;
      this.emit({
        type: AgentEventType.Compacting,
        threadId: this.threadId,
        active,
      });
    }
  }
  private compactBoundary(message: Message): void {
    const meta = message.compact_metadata as
      { pre_tokens?: number; trigger?: string } | undefined;
    if (meta)
      logger.info("Compact boundary received", {
        threadId: this.threadId,
        preTokens: meta.pre_tokens,
        trigger: meta.trigger,
      });
  }
  private apiRetry(message: Message): void {
    this.lastApiRetry = { attempt: numberValue(message.attempt), maxRetries: numberValue(message.max_retries) };
    this.emit({
      type: AgentEventType.ApiRetry,
      threadId: this.threadId,
      reason: stringOr(message.error, "unknown"),
      attempt: numberValue(message.attempt),
      maxRetries: numberValue(message.max_retries),
      delayMs: numberValue(message.retry_delay_ms),
      errorStatus: numberValue(message.error_status),
    });
  }
  private hookStarted(message: Message): void {
    const hookName = stringOr(message.hook_name, "unknown");
    if (
      hookName.startsWith("SessionStart") &&
      this.callbacks.isSessionStartHookSuppressed()
    )
      return;
    const toolName =
      typeof message.tool_name === "string" ? message.tool_name : undefined;
    this.emit({
      type: AgentEventType.HookStarted,
      threadId: this.threadId,
      hookName,
      hookType: toolName ? "permission" : "stop",
      ...(toolName ? { toolName } : {}),
    });
  }
  private hookProgress(message: Message): void {
    this.emit({
      type: AgentEventType.HookProgress,
      threadId: this.threadId,
      hookName: stringOr(message.hook_name, "unknown"),
      output: stringOr(message.output, ""),
    });
  }
  private hookResponse(message: Message): void {
    const hookName = stringOr(message.hook_name, "unknown");
    if (
      hookName.startsWith("SessionStart") &&
      this.callbacks.isSessionStartHookSuppressed()
    ) {
      this.callbacks.clearSessionStartHookSuppression();
      return;
    }
    this.emit({
      type: AgentEventType.HookCompleted,
      threadId: this.threadId,
      hookName,
      exitCode: numberValue(message.exit_code) ?? 1,
      durationMs: numberValue(message.duration_ms) ?? 0,
      didBlock: Boolean(message.did_block),
    });
  }
  private unknownSystem(message: Message): void {
    this.emit({
      type: AgentEventType.System,
      threadId: this.threadId,
      subtype: stringOr(message.subtype, "unknown"),
    });
  }

  private standaloneToolUse(message: Message): ClaudeMapOutcome {
    const toolCallId = stringValue(message.id);
    this.rememberToolParent(toolCallId);
    if (toolCallId && this.toolUseIds.has(toolCallId)) return "none";
    if (toolCallId) this.registerToolUse(toolCallId);
    const toolName = stringOr(
      message.tool_name,
      stringOr(message.name, "unknown"),
    );
    const parentToolCallId = parentId(message);
    logger.debug("Claude ToolUse from tool_use message", {
      toolId: toolCallId,
      toolName,
      parent_tool_use_id: parentToolCallId ?? null,
    });
    this.emit({
      type: AgentEventType.ToolUse,
      threadId: this.threadId,
      toolCallId,
      toolName,
      toolInput: canonicalToolInput(toolName, firstObjectValue(message.tool_input, message.input)),
      parentToolCallId,
    });
    return "none";
  }

  private toolResult(message: Message): ClaudeMapOutcome {
    const toolCallId = stringValue(message.tool_use_id);
    const output = toolResultText(message.content);
    if (toolCallId)
      this.callbacks.getSession()?.pendingToolUses.delete(toolCallId);
    // A failed result would persist the call as failed. Leaving it running lets
    // the cancelled turn settle it as cancelled, which the roster reads as stopped.
    if (message.is_error === true && CLAUDE_USER_INTERRUPT_RESULTS.has(output)) return "none";
    this.emit({
      type: AgentEventType.ToolResult,
      threadId: this.threadId,
      toolCallId,
      output,
      isError: Boolean(message.is_error),
    });
    return "none";
  }
  private user(message: Message): ClaudeMapOutcome {
    const user = objectValue(message.message);
    const results = Array.isArray(user.content)
      ? user.content.map(objectValue).filter((block) => block.type === "tool_result") : [];
    const launched = asyncLaunchId(message, results);
    const executionId = this.callbacks.liveExecutionId();
    if (launched && executionId) this.holdBackgroundTool(launched, executionId);
    else for (const block of results) this.toolResult(block);
    return "none";
  }
  /** An async launch result only acknowledges the start; the call runs on until its task notification. */
  private holdBackgroundTool(toolCallId: string, executionId: string): void {
    this.callbacks.getSession()?.pendingToolUses.delete(toolCallId);
    if (!this.backgroundTools.has(toolCallId) && this.backgroundTools.size >= MAX_TRACKED_TOOLS)
      throw new Error("Claude background tool bound exceeded");
    this.backgroundTools.set(toolCallId, executionId);
    this.emit({ type: AgentEventType.ToolBackgrounded, threadId: this.threadId, toolCallId });
  }
  private streamEvent(message: Message): ClaudeMapOutcome {
    const event = objectValue(message.event);
    const usage = (event.message as { usage?: Usage } | undefined)?.usage;
    if (event.type === "message_delta" && !parentId(message)) this.settleBoundaryFromDelta(event);
    if (event.type === "message_start") this.startReasoningMessage(event);
    if (event.type === "message_start" && usage)
      this.emitContextEstimate(usage);
    if (event.type === "content_block_start") this.openReasoningBlock(event);
    if (event.type === "content_block_delta")
      this.emitDelta(objectValue(event.delta), event.index);
    if (event.type === "content_block_stop") this.closeReasoningBlock(event.index);
    return "none";
  }
  private settleBoundaryFromDelta(event: Message): void {
    const stopReason = objectValue(event.delta).stop_reason;
    if (typeof stopReason === "string") this.emitPendingBoundary(finalStopReason(stopReason));
  }
  private startReasoningMessage(event: Message): void {
    this.reasoningItemByBlock.clear();
    const messageId = validIdentity(objectValue(event.message).id);
    this.reasoningMessageKey = messageId && messageId.length <= MAX_REASONING_MESSAGE_KEY
      ? messageId : `message-${++this.reasoningMessageOrdinal}`;
  }
  /** Thinking and redacted thinking open a row at the block's true start; redacted blocks never carry text. */
  private openReasoningBlock(event: Message): void {
    const type = objectValue(event.content_block).type;
    if ((type !== "thinking" && type !== "redacted_thinking") || typeof event.index !== "number") return;
    this.reasoningMessageKey ??= `message-${++this.reasoningMessageOrdinal}`;
    const reasoningItemId = `${this.reasoningMessageKey}:thinking:${event.index}`;
    this.reasoningItemByBlock.set(event.index, reasoningItemId);
    this.emitReasoningDelta("", reasoningItemId);
  }
  private closeReasoningBlock(index: unknown): void {
    if (typeof index !== "number") return;
    const reasoningItemId = this.reasoningItemByBlock.get(index);
    if (!reasoningItemId) return;
    this.reasoningItemByBlock.delete(index);
    this.emitReasoningDelta("", reasoningItemId, true);
  }
  private emitThinkingDelta(text: unknown, index: unknown): void {
    const reasoningItemId = typeof index === "number" ? this.reasoningItemByBlock.get(index) : undefined;
    if (!reasoningItemId || typeof text !== "string") return;
    for (let start = 0; start < text.length; start += MAX_REASONING_DELTA_LENGTH)
      this.emitReasoningDelta(text.slice(start, start + MAX_REASONING_DELTA_LENGTH), reasoningItemId);
  }
  private emitReasoningDelta(delta: string, reasoningItemId: string, done?: true): void {
    this.emit({
      type: AgentEventType.ReasoningDelta,
      threadId: this.threadId,
      delta,
      reasoningItemId,
      ...(done ? { done } : {}),
    });
  }
  private emitContextEstimate(usage: Usage): void {
    this.lastInputTokens = inputTokens(usage);
    if (this.lastInputTokens > 0)
      this.emit({
        type: AgentEventType.ContextEstimate,
        threadId: this.threadId,
        tokensIn: this.lastInputTokens,
        contextWindow: this.lastContextWindow,
      });
  }
  private emitDelta(delta: Message, index: unknown): void {
    if (delta.type === "thinking_delta") this.emitThinkingDelta(delta.thinking, index);
    if (
      delta.type === "text_delta" &&
      typeof delta.text === "string" &&
      delta.text
    )
      this.emitTextDelta(delta.text);
    if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string" &&
      delta.partial_json
    )
      this.emit({
        type: AgentEventType.ToolInputDelta,
        threadId: this.threadId,
        partialJson: delta.partial_json,
      });
  }
  private emitTextDelta(delta: string): void {
    const session = this.callbacks.getSession();
    const isFinalResponse =
      session !== undefined &&
      session.pendingToolUses.size === 0 &&
      session.hasFiredToolThisTurn;
    this.emit({
      type: AgentEventType.TextDelta,
      threadId: this.threadId,
      delta,
      ...(isFinalResponse ? { isFinalResponse: true } : {}),
    });
  }
  private toolProgress(message: Message): ClaudeMapOutcome {
    const toolCallId = stringValue(message.tool_use_id);
    if (toolCallId)
      this.emit({
        type: AgentEventType.ToolProgress,
        threadId: this.threadId,
        toolCallId,
        toolName: stringOr(message.tool_name, "unknown"),
        elapsedSeconds: numberValue(message.elapsed_time_seconds) ?? 0,
      });
    return "none";
  }
  private rateLimit(message: Message): ClaudeMapOutcome {
    const info = message.rate_limit_info as
      | {
          status?: string;
          resetsAt?: number;
          rateLimitType?: string;
          utilization?: number;
        }
      | undefined;
    const active = info?.status === undefined ? undefined : RATE_LIMIT_ACTIVE_BY_STATUS.get(info.status);
    if (!info || active === undefined) return "none";
    this.lastRateLimit = { status: info.status, resetsAt: info.resetsAt, rateLimitType: info.rateLimitType };
    this.emit(active
      ? {
        type: AgentEventType.RateLimited,
        threadId: this.threadId,
        active: true,
        retryAfterMs: info.resetsAt
          ? Math.max(0, info.resetsAt * 1000 - Date.now())
          : undefined,
        limitType: info.rateLimitType,
        utilization: info.utilization,
      }
      : { type: AgentEventType.RateLimited, threadId: this.threadId, active: false });
    return "none";
  }
  private emit(event: AgentEvent): void {
    const toolId = "toolCallId" in event ? event.toolCallId : undefined;
    const exactParent = readParentEvidence(this.nativeSource);
    const parent = exactParent.kind === "absent" && toolId
      ? this.toolParents.get(toolId) ?? exactParent : exactParent;
    const sourceIdentities: ProviderIdentity[] = [];
    const nativeEventId = validIdentity(this.nativeSource.uuid);
    const nativeItemId = toolId || validIdentity(objectValue(this.nativeSource.message).id);
    if (nativeItemId) sourceIdentities.push({ providerId: "claude", scope: "item", value: nativeItemId, provenance: "native" });
    if (parent.kind === "native") sourceIdentities.push({ providerId: "claude", scope: "parentItem", value: parent.id, provenance: "native" });
    this.callbacks.emit(event, { parent, sourceIdentities, ...(nativeEventId && { nativeEventId }) });
  }
  private rememberToolParent(toolId: string): void {
    if (!toolId) return;
    const parent = readParentEvidence(this.nativeSource);
    const existing = this.toolParents.get(toolId);
    if (existing && parent.kind !== "absent" && JSON.stringify(existing) !== JSON.stringify(parent)) {
      throw new Error(`Conflicting Claude native parent for tool ${toolId}`);
    }
    if (parent.kind === "absent") return;
    if (!existing && this.toolParents.size >= MAX_TRACKED_TOOLS) throw new Error("Claude native tool identity bound exceeded");
    this.toolParents.set(toolId, parent);
  }
}

/** The SDK reports an async launch on the message, so it only names a call when the message carries one result. */
function asyncLaunchId(message: Message, results: readonly Message[]): string | undefined {
  if (objectValue(message.tool_use_result).status !== "async_launched" || results.length !== 1) return undefined;
  return validIdentity(results[0]?.tool_use_id);
}
function validIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 ? value : undefined;
}
function readParentEvidence(message: Message): ClaudeParentEvidence {
  if (!("parent_tool_use_id" in message)) return { kind: "absent" };
  if (message.parent_tool_use_id === null) return { kind: "root" };
  const id = validIdentity(message.parent_tool_use_id);
  if (!id) throw new Error("Invalid Claude native parent identity");
  return { kind: "native", id };
}

/** Claude sends rich results as content blocks; keep their text so stored summaries read as prose, not JSON. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return subagentReport(content);
  if (Array.isArray(content)) {
    const texts = content.map(objectValue).filter((block) => block.type === "text").map((block) => stringValue(block.text))
      .filter((text) => !AGENT_RESUME_TRAILER.test(text));
    if (texts.length > 0) return subagentReport(texts.join("\n"));
  }
  return JSON.stringify(content ?? "");
}
/** Keeps only the subagent's own report from a framed hand-back; other text passes through. */
function subagentReport(text: string): string {
  const lines = text.split("\n");
  const frame = lines.findIndex((line) => line.startsWith(HANDBACK_FRAME_PREFIX));
  if (frame === -1) return text;
  const report: string[] = [];
  for (const line of lines.slice(frame + 1)) {
    if (!line.startsWith(HANDBACK_REPORT_INDENT)) break;
    report.push(line.slice(HANDBACK_REPORT_INDENT.length));
  }
  return report.join("\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
/** The model a subagent message ran on; the CLI labels messages it wrote itself, such as API errors, `<synthetic>`. */
function runModel(value: unknown): string | undefined {
  return typeof value === "string" && value !== "<synthetic>" ? validIdentity(value) : undefined;
}
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
/** Node system errors carry their errno name in `code`, e.g. "ECONNRESET". */
function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
/** Claude names an Agent's type `subagent_type`; the shared tool input contract reads `subagentType`. */
function canonicalToolInput(toolName: string, input: Message): Message {
  const subagentType = toolName === "Agent" ? validIdentity(input.subagent_type) : undefined;
  return subagentType ? { ...input, subagentType } : input;
}
function objectValue(value: unknown): Message {
  return objectOrUndefined(value) ?? {};
}
function objectOrUndefined(value: unknown): Message | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Message)
    : undefined;
}
function firstObjectValue(first: unknown, second: unknown): Message {
  return objectOrUndefined(first) ?? objectValue(second);
}
function parentId(message: Message): string | undefined {
  return typeof message.parent_tool_use_id === "string" &&
    message.parent_tool_use_id.length > 0
    ? message.parent_tool_use_id
    : undefined;
}
function resultErrorText(message: Message): string {
  if (typeof message.result === "string") return message.result;
  try {
    return (
      JSON.stringify(message.result ?? message) ||
      "Claude SDK returned an error result"
    );
  } catch {
    return "Claude SDK returned an error result";
  }
}
function finalStopReason(reason: string | null): boolean {
  return (
    reason === "end_turn" ||
    reason === "stop_sequence" ||
    reason === "max_tokens"
  );
}
function usageValue(message: Message): Usage {
  return objectValue(message.usage) as Usage;
}
function inputTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
function resultContextWindow(
  message: Message,
  session: ClaudeMappedSession | undefined,
): number | undefined {
  const models = objectValue(message.modelUsage) as Record<
    string,
    { contextWindow?: number }
  >;
  const contextWindow = Object.values(models).find(
    (item) =>
      typeof item.contextWindow === "number" &&
      Number.isFinite(item.contextWindow),
  )?.contextWindow;
  return clampContextWindowToMode(
    contextWindow,
    session?.contextWindowMode,
    session?.model,
  );
}
function metrics(message: Message, usage: Usage): ClaudeUsageMetrics {
  const serviceTier = usage.service_tier;
  return {
    costUsd: numberValue(message.total_cost_usd),
    numTurns: numberValue(message.num_turns),
    durationMs: numberValue(message.duration_ms),
    serviceTier:
      serviceTier === "standard" ||
      serviceTier === "priority" ||
      serviceTier === "batch"
        ? serviceTier
        : undefined,
  };
}
function fallbackModel(
  modelUsage: Message,
  requested: string,
): string | undefined {
  const models = Object.keys(modelUsage);
  const usedRequested = models.some(
    (model) =>
      model === requested ||
      (model.startsWith(`${requested}-`) &&
        /^\d{8}$/.test(model.slice(requested.length + 1))),
  );
  return usedRequested ? undefined : models[0];
}
function unrecoverableThinkingError(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /`?(?:thinking|redacted_thinking)`?[^]*?blocks in the latest assistant message cannot be modified/.test(
      value,
    )
  );
}
