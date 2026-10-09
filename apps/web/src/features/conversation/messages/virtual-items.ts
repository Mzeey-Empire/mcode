import type { AgentTurnStatus, PermissionDecision, TurnOutcome, TurnRuntimePhase } from "@mcode/contracts";
import type { Message, ToolCall, HookExecution, ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord } from "@/transport/types";
import type { NarrativeCounts, ThoughtSegment, TurnSummary } from "../narrative/types";
import { buildNarrativeItems, computeLiveStreamingText } from "../narrative/build-narrative";
import { buildPersistedNarrativeItems } from "../narrative/build-persisted-narrative";
import { currentActivityHeading } from "../narrative/activity-label";
import { isRoutineProviderNotice } from "../notices/provider-notices";
import { approvalReviewNote, persistedTurnCounts, persistedTurnDurationMs } from "../turn/turn-summary";

/**
 * A plan-questions assistant message is a COMPLETED "ask the user" turn whose
 * bubble renders as the collapsed AnsweredSummary. Answering it creates no user
 * message, so it can be the trailing stable item while the NEXT turn generates
 * the plan. It is never the live turn's own response, so the in-flight narrative
 * must append AFTER it (preserving chronological order: questions answered → new
 * turn's actions → response) rather than being split in ABOVE it. Plan capture
 * bubbles are intentionally excluded — their own turn's narrative belongs above
 * the saved Plan tab answer.
 */
function isPlanQuestionsMessage(content: string): boolean {
  return content.includes("```plan-questions");
}

const EMPTY_HOOKS: readonly HookExecution[] = [];
const EMPTY_THOUGHT_SEGMENTS: readonly ThoughtSegment[] = [];

/** Cached persisted narrative rows for an assistant message. */
export type PersistedNarrativeRecords = {
  tools: ToolCallRecord[];
  thoughts: ThoughtSegmentRecord[];
  hooks: HookExecutionRecord[];
} | undefined;

/** Persisted narrative cache keyed by assistant message id. */
export type PersistedNarrativeRecordsByMessage = Record<string, PersistedNarrativeRecords>;

/** State that lets the current turn's live and persisted assistant rows share one React key. */
export interface CurrentTurnResponseIdentity {
  threadId: string;
  executionId?: string;
  messageId?: string;
  responseKey?: string;
  responseKeysByMessageId?: Record<string, string>;
}
/** UI state for one agent response, projected from its authoritative turn lifecycle. */
export type AgentDisplayState =
  | { phase: "streaming" }
  | { phase: "finalizing" }
  | { phase: "completed" }
  | { phase: "errored"; reason?: string }
  | { phase: "cancelled" }
  | { phase: "interrupted" };

/** Maps the runtime lifecycle for the current turn into transcript display state. */
export function agentDisplayStateFromRuntimePhase(
  phase: TurnRuntimePhase,
  reason?: string | null,
): AgentDisplayState | undefined {
  switch (phase) {
    case "idle":
      return undefined;
    case "running":
      return { phase: "streaming" };
    case "finalizing":
      return { phase: "finalizing" };
    case "completed":
      return { phase: "completed" };
    case "errored":
      return reason ? { phase: "errored", reason } : { phase: "errored" };
    case "cancelled":
      return { phase: "cancelled" };
    case "interrupted":
      return { phase: "interrupted" };
  }
}

/** Maps a canonical turn status into the shared transcript display state. */
export function agentDisplayStateFromCanonicalTurnStatus(
  status: AgentTurnStatus,
): AgentDisplayState {
  switch (status) {
    case "Pending":
    case "Running":
      return { phase: "streaming" };
    case "Completed":
      return { phase: "completed" };
    case "Cancelled":
      return { phase: "cancelled" };
    case "Interrupted":
      return { phase: "interrupted" };
    case "Errored":
      return { phase: "errored" };
  }
}

/** Returns the terminal display state for one persisted agent message. */
function agentDisplayStateFromOutcome(
  outcome: TurnOutcome | null | undefined,
): AgentDisplayState {
  switch (outcome) {
    case "errored":
      return { phase: "errored" };
    case "cancelled":
      return { phase: "cancelled" };
    case "interrupted":
      return { phase: "interrupted" };
    case "completed":
    case null:
    case undefined:
      return { phase: "completed" };
  }
}

/** Whether an agent display state still owns live narrative activity. */
export function isAgentDisplayActive(
  state: AgentDisplayState | undefined,
): boolean {
  return state?.phase === "streaming" || state?.phase === "finalizing";
}

/** Inputs for projecting one transcript into stable and volatile virtual rows. */
export interface TranscriptProjectionInput {
  /** Persisted conversation messages in chronological order. */
  messages: readonly Message[];
  /** Persisted file changes keyed by assistant message id. */
  persistedFilesChanged?: Record<string, string[]>;
  /** Assistant message that owns the latest file-change disclosure. */
  latestTurnWithChanges?: string | null;
  /** Identity that keeps live and persisted assistant rows in one React slot. */
  currentTurn?: CurrentTurnResponseIdentity;
  /** Authoritative lifecycle projected into the current agent response state. */
  agentDisplayState?: AgentDisplayState;
  /** Persisted narrative records keyed by assistant message id. */
  persistedNarrativeByMessage?: PersistedNarrativeRecordsByMessage;
  /** Canonical child turn summaries keyed by assistant message id. */
  turnSummariesByMessageId?: Record<string, TurnSummary>;
  /** In-memory tool calls for the active turn. */
  toolCalls: readonly ToolCall[];
  /** Start time for active-turn timing displays. */
  agentStartTime: number | undefined;
  /** Latest streamed assistant text. */
  streamingText: string | undefined;
  /** Text openness does not describe the execution lifecycle. */
  responseTextIsStreaming?: boolean;
  /** Permission requests for the active turn. */
  permissions?: Parameters<typeof buildVolatileItems>[4];
  /** Hook events for the active turn. */
  hooks?: readonly HookExecution[];
  /** Reasoning segments for the active turn. */
  thoughtSegments?: readonly ThoughtSegment[];
  /** Persisted assistant text that remains visible while volatile rows settle. */
  committedAssistantBody?: string;
}

function messageOutcome(message: Message): TurnOutcome | null | undefined {
  return (message as Message & { outcome?: TurnOutcome | null }).outcome;
}

function messageOutcomeExecutionId(message: Message): string | null | undefined {
  return (message as Message & { outcomeExecutionId?: string | null }).outcomeExecutionId;
}

/** Returns the stable final-response key for a live turn. */
export function liveFinalResponseItemKey(
  threadId: string,
  responseKey?: string,
): string {
  return responseKey || `turn-response:${threadId}:pending`;
}

/** Returns the agent message item key, preserving the current turn's live key after persistence. */
export function agentMessageItemKey(
  message: Message,
  currentTurn?: CurrentTurnResponseIdentity,
): string {
  const mappedKey = currentTurn?.responseKeysByMessageId?.[message.id];
  if (message.role === "assistant" && mappedKey) {
    return liveFinalResponseItemKey(currentTurn.threadId, mappedKey);
  }
  if (
    message.role === "assistant" &&
    currentTurn?.messageId === message.id &&
    currentTurn.responseKey
  ) {
    return liveFinalResponseItemKey(currentTurn.threadId, currentTurn.responseKey);
  }
  return message.id;
}

/**
 * Creates a transcript projector with separate stable and volatile caches.
 * Callers provide one explicit transcript state instead of coordinating three builders.
 */
export function createTranscriptItemProjector(): (input: TranscriptProjectionInput) => ChatVirtualItem[] {
  const buildVolatile = createVolatileItemsBuilder();
  const buildVirtual = createVirtualItemsBuilder();
  let previousStableInput: StableTranscriptInput | undefined;
  let previousStableItems: ChatVirtualItem[] = [];

  return (input) => {
    const stableInput = {
      messages: input.messages,
      persistedFilesChanged: input.persistedFilesChanged,
      latestTurnWithChanges: input.latestTurnWithChanges,
      currentTurn: input.currentTurn,
      agentDisplayState: input.agentDisplayState,
      responseTextIsStreaming: input.responseTextIsStreaming,
      persistedNarrativeByMessage: input.persistedNarrativeByMessage,
      turnSummariesByMessageId: input.turnSummariesByMessageId,
      currentTurnHasNarrative: hasLiveNarrative(input),
    };
    const stableItems = sameStableTranscriptInput(previousStableInput, stableInput)
      ? previousStableItems
      : buildStableItems(
        stableInput.messages,
        stableInput.persistedFilesChanged,
        stableInput.latestTurnWithChanges,
        stableInput.currentTurn,
        stableInput.persistedNarrativeByMessage,
        stableInput.turnSummariesByMessageId,
        stableInput.agentDisplayState,
        stableInput.responseTextIsStreaming,
        stableInput.currentTurnHasNarrative,
      );
    previousStableInput = stableInput;
    previousStableItems = stableItems;

    const volatileItems = buildVolatile(
      input.toolCalls,
      input.agentDisplayState,
      input.agentStartTime,
      input.streamingText,
      input.permissions,
      input.hooks,
      input.thoughtSegments,
      input.currentTurn,
      input.committedAssistantBody,
      input.responseTextIsStreaming,
    );
    const responseMessageId = input.messages.find((message) => message.role === "assistant" && isCurrentResponse(message, stableInput))?.id;
    return buildVirtual(stableItems, volatileItems, hasLiveNarrative(input), responseMessageId);
  };
}

type StableTranscriptInput = Pick<TranscriptProjectionInput,
  "messages" | "persistedFilesChanged" | "latestTurnWithChanges" | "currentTurn" | "agentDisplayState"
  | "responseTextIsStreaming" | "persistedNarrativeByMessage" | "turnSummariesByMessageId"> & {
  currentTurnHasNarrative: boolean;
};

function sameStableTranscriptInput(previous: StableTranscriptInput | undefined, current: StableTranscriptInput): boolean {
  return previous !== undefined && previous.messages === current.messages
    && previous.persistedFilesChanged === current.persistedFilesChanged
    && previous.latestTurnWithChanges === current.latestTurnWithChanges
    && previous.currentTurn === current.currentTurn
    && previous.agentDisplayState === current.agentDisplayState
    && previous.responseTextIsStreaming === current.responseTextIsStreaming
    && previous.persistedNarrativeByMessage === current.persistedNarrativeByMessage
    && previous.turnSummariesByMessageId === current.turnSummariesByMessageId
    && previous.currentTurnHasNarrative === current.currentTurnHasNarrative;
}

/** Thoughts go through the fold's own row builder, because a thought that repeats the answer renders no row. */
function hasLiveNarrative(input: TranscriptProjectionInput): boolean {
  if (input.toolCalls.length > 0) return true;
  if ((input.thoughtSegments?.length ?? 0) === 0) return false;
  return buildNarrativeItems({
    toolCalls: [],
    hooks: [],
    thoughtSegments: input.thoughtSegments ?? [],
    streamingText: "",
    isAgentRunning: false,
    committedAssistantBody: input.committedAssistantBody,
  }).items.some((item) => item.type !== "hook" && item.type !== "delta");
}

/** Represents an item rendered in the virtualized chat list: messages, tool indicators, or streaming text. */
export type ChatVirtualItem =
  | {
      key: string;
      type: "message";
      message: Message;
      agentDisplayState?: AgentDisplayState;
      textIsStreaming?: boolean;
    }
  | {
      key: string;
      type: "turn-changes";
      messageId: string;
      filesChanged: string[];
      isLatestTurn: boolean;
    }
  | {
      key: string;
      type: "permission-request";
      requestId: string;
      toolName: string;
      input: unknown;
      title?: string;
      questions?: import("@mcode/contracts").PermissionQuestion[];
      /** Provider-native selectable options rendered verbatim when present. */
      options?: import("@mcode/contracts").PermissionRequestOption[];
      settled: boolean;
      decision?: PermissionDecision;
      /** Verbatim label of the provider-native option the user picked, when one was offered. */
      optionLabel?: string;
    }
  | {
      key: string;
      type: "narrative-flow";
      toolCalls: readonly ToolCall[];
      hooks: readonly HookExecution[];
      thoughtSegments: readonly ThoughtSegment[];
      streamingText: string;
      isAgentRunning: boolean;
      startTime: number | undefined;
      /** Last assistant bubble text when the turn finished; duplicate thoughts are hidden. */
      committedAssistantBody?: string;
    }
  | {
      key: string;
      type: "work-fold";
      /** Assistant message whose settled turn this fold summarizes. */
      messageId: string;
      /** Assistant message body, used to hide thoughts that repeat the final answer. */
      messageContent: string;
      /** How the turn ended. Missing outcomes read as completed. */
      outcome?: TurnOutcome | null;
      /** Turn wall time, or null when no boundary is known. */
      durationMs: number | null;
      /** Approval-review sentence shown as the first row inside the open fold. */
      approvalNote?: string;
    }
  | {
      key: string;
      type: "turn-meta-line";
      /** Assistant message whose settled turn this line closes. */
      messageId: string;
      steps: number;
      subagents: number;
    }
  | {
      key: string;
      type: "narrative-indicator";
      summaryHeading?: string;
      /**
       * "X steps · N subagents · phase…" status footer rendered BELOW the
       * live assistant response so the writing animation reads as the primary
       * surface and the progress meta sits underneath. Emitted while the agent
       * is running and kept through the turn's volatile tail (tool calls still
       * in memory) so the component can animate out instead of vanishing in a
       * single frame; it renders nothing once its exit completes.
       */
      stepCount: number;
      subagentCount: number;
      activeToolCalls: readonly ToolCall[];
      startTime: number | undefined;
      /** False once the turn ended — tells the component to play its exit. */
      isAgentRunning: boolean;
    };

/**
 * Build the stable segment: messages with optional turn-change summaries.
 * This only changes when messages or persistedFilesChanged change (infrequent).
 */
export function buildStableItems(
  messages: readonly Message[],
  persistedFilesChanged?: Record<string, string[]>,
  latestTurnWithChanges?: string | null,
  currentTurn?: CurrentTurnResponseIdentity,
  persistedNarrativeByMessage?: PersistedNarrativeRecordsByMessage,
  turnSummariesByMessageId?: Record<string, TurnSummary>,
  currentAgentDisplayState?: AgentDisplayState,
  responseTextIsStreaming?: boolean,
  currentTurnHasNarrative?: boolean,
): ChatVirtualItem[] {
  return messages.flatMap((message) => isRoutineProviderNotice(message) ? [] : stableItemsForMessage(message, {
    persistedFilesChanged, latestTurnWithChanges, currentTurn, persistedNarrativeByMessage, turnSummariesByMessageId, currentAgentDisplayState, responseTextIsStreaming, currentTurnHasNarrative,
  }));
}

interface StableItemInput {
  persistedFilesChanged?: Record<string, string[]>;
  latestTurnWithChanges?: string | null;
  currentTurn?: CurrentTurnResponseIdentity;
  persistedNarrativeByMessage?: PersistedNarrativeRecordsByMessage;
  turnSummariesByMessageId?: Record<string, TurnSummary>;
  currentAgentDisplayState?: AgentDisplayState;
  responseTextIsStreaming?: boolean;
  /** Whether the live turn produced tools or thoughts that the fold should own once it settles. */
  currentTurnHasNarrative?: boolean;
};

function isCurrentResponse(message: Message, input: StableItemInput): boolean {
  return input.currentTurn?.threadId === message.thread_id
    && (input.currentTurn.messageId === message.id
      || (input.currentTurn.executionId !== undefined
        && input.currentTurn.executionId === messageOutcomeExecutionId(message)));
}

function currentResponseState(message: Message, input: StableItemInput): AgentDisplayState | undefined {
  return isCurrentResponse(message, input) ? input.currentAgentDisplayState : undefined;
}

function messageVirtualItem(message: Message, input: StableItemInput): ChatVirtualItem {
  const summary = input.turnSummariesByMessageId?.[message.id];
  const outcome = messageOutcome(message) ?? summary?.outcome;
  const display = message.role === "assistant"
    ? currentResponseState(message, input) ?? agentDisplayStateFromOutcome(outcome)
    : undefined;
  return { key: agentMessageItemKey(message, input.currentTurn), type: "message", message, ...(display ? { agentDisplayState: display, textIsStreaming: isCurrentResponse(message, input) && isAgentDisplayActive(display) ? input.responseTextIsStreaming : undefined } : {}) };
}

const NO_COUNTS: NarrativeCounts = { steps: 0, thoughts: 0, subagents: 0 };

/** Canonical summary when the turn has one, else counts and duration rebuilt from legacy records. */
function recordedTurnSummary(message: Message, input: StableItemInput): TurnSummary {
  const canonical = input.turnSummariesByMessageId?.[message.id];
  if (canonical) return canonical;
  const records = input.persistedNarrativeByMessage?.[message.id];
  return records
    ? { counts: persistedTurnCounts(records), durationMs: persistedTurnDurationMs(records) }
    : { counts: NO_COUNTS, durationMs: null };
}

function settledTurnSummary(message: Message, input: StableItemInput): TurnSummary {
  const summary = recordedTurnSummary(message, input);
  const currentState = currentResponseState(message, input);
  const outcome = currentState
    ? terminalDisplayOutcome(currentState)
    : summary.outcome ?? messageOutcome(message);
  const outcomeExecutionId = currentState
    ? input.currentTurn?.executionId
    : summary.outcomeExecutionId ?? messageOutcomeExecutionId(message);
  return { ...summary, ...(outcome === undefined ? {} : { outcome }), ...(outcomeExecutionId === undefined ? {} : { outcomeExecutionId }) };
}

function terminalDisplayOutcome(state: AgentDisplayState): TurnOutcome | undefined {
  return state.phase === "streaming" || state.phase === "finalizing" ? undefined : state.phase;
}

/**
 * Records decide when they are loaded, because the fold renders from them: a thought
 * that repeats the answer and hooks (shown in the actions row) produce no fold rows.
 */
function hasFoldableNarrative(message: Message, input: StableItemInput, summary: TurnSummary): boolean {
  if (isCurrentResponse(message, input) && input.currentTurnHasNarrative === true) return true;
  const records = input.persistedNarrativeByMessage?.[message.id];
  if (records) return hasFoldRows(records, message.content);
  return summary.counts.steps > 0 || summary.counts.thoughts > 0;
}

function hasFoldRows(records: NonNullable<PersistedNarrativeRecords>, messageContent: string): boolean {
  return buildPersistedNarrativeItems({ ...records, messageContent })
    .some((item) => item.type !== "hook" && item.type !== "delta");
}

function workFoldItem(message: Message, input: StableItemInput, summary: TurnSummary): ChatVirtualItem | undefined {
  if (!hasFoldableNarrative(message, input, summary)) return undefined;
  const approvalNote = approvalReviewNote(summary.approvalReview);
  return {
    key: `work-fold:${message.id}`,
    type: "work-fold",
    messageId: message.id,
    messageContent: message.content,
    outcome: summary.outcome,
    durationMs: summary.durationMs,
    ...(approvalNote ? { approvalNote } : {}),
  };
}

function turnMetaLineItem(message: Message, summary: TurnSummary): ChatVirtualItem | undefined {
  const { steps, subagents } = summary.counts;
  return steps > 0 || subagents > 0
    ? { key: `turn-meta-line:${message.id}`, type: "turn-meta-line", messageId: message.id, steps, subagents }
    : undefined;
}

function turnChangesItem(message: Message, input: StableItemInput): ChatVirtualItem | undefined {
  const files = input.persistedFilesChanged?.[message.id];
  return files && files.length > 0
    ? { key: `turn-changes-${message.id}`, type: "turn-changes", messageId: message.id, filesChanged: files, isLatestTurn: message.id === input.latestTurnWithChanges }
    : undefined;
}

function stableItemsForMessage(message: Message, input: StableItemInput): ChatVirtualItem[] {
  if (message.role !== "assistant") return [messageVirtualItem(message, input)];
  const settled = !isAgentDisplayActive(currentResponseState(message, input));
  const summary = settled ? settledTurnSummary(message, input) : undefined;
  const items: Array<ChatVirtualItem | undefined> = [
    summary && workFoldItem(message, input, summary),
    messageVirtualItem(message, input),
    summary && turnMetaLineItem(message, summary),
    turnChangesItem(message, input),
  ];
  return items.filter((item): item is ChatVirtualItem => item !== undefined);
}

/**
 * Build the volatile segment: permission requests and a single narrative-flow item
 * that consolidates tool calls, hooks, thought segments, streaming text, and indicator.
 * This changes on every tool call event but doesn't depend on messages.
 */
export function buildVolatileItems(
  toolCalls: readonly ToolCall[],
  agentDisplayState: AgentDisplayState | undefined,
  agentStartTime: number | undefined,
  streamingText: string | undefined,
  permissions?: readonly {
    requestId: string;
    toolName: string;
    input?: unknown;
    title?: string;
    questions?: import("@mcode/contracts").PermissionQuestion[];
    options?: import("@mcode/contracts").PermissionRequestOption[];
    settled: boolean;
    decision?: PermissionDecision;
    optionLabel?: string;
  }[],
  hooks?: readonly HookExecution[],
  thoughtSegments?: readonly ThoughtSegment[],
  currentTurn?: CurrentTurnResponseIdentity,
  committedAssistantBody?: string,
  responseTextIsStreaming?: boolean,
): ChatVirtualItem[] {
  const isAgentRunning = isAgentDisplayActive(agentDisplayState);
  const resolvedHooks = hooks ?? EMPTY_HOOKS;
  const resolvedThoughtSegments = thoughtSegments ?? EMPTY_THOUGHT_SEGMENTS;
  const resolvedStreamingText = streamingText ?? "";
  const liveText = computeLiveStreamingText({
    thoughtSegments: resolvedThoughtSegments,
    streamingText: resolvedStreamingText,
    isAgentRunning,
    toolCalls,
  });

  return [
    narrativeFlowItem(toolCalls, resolvedHooks, resolvedThoughtSegments, resolvedStreamingText, liveText, isAgentRunning, agentStartTime, committedAssistantBody),
    liveResponseItem(liveText, currentTurn, agentDisplayState, responseTextIsStreaming),
    narrativeIndicatorItem(toolCalls, isAgentRunning, agentStartTime, resolvedThoughtSegments),
    ...permissionRequestItems(permissions),
  ].filter((item): item is ChatVirtualItem => item !== undefined);
}

function narrativeFlowItem(toolCalls: readonly ToolCall[], hooks: readonly HookExecution[], thoughts: readonly ThoughtSegment[], streamingText: string, liveText: string, isAgentRunning: boolean, startTime: number | undefined, committedAssistantBody: string | undefined): ChatVirtualItem | undefined {
  return isAgentRunning || toolCalls.length > 0 || thoughts.length > 0 ? { key: "narrative-flow", type: "narrative-flow", toolCalls, hooks, thoughtSegments: thoughts, streamingText: liveText.length > 0 ? "" : streamingText, isAgentRunning, startTime, committedAssistantBody } : undefined;
}

function liveResponseItem(liveText: string, currentTurn: CurrentTurnResponseIdentity | undefined, agentDisplayState: AgentDisplayState | undefined, textIsStreaming?: boolean): ChatVirtualItem | undefined {
  if (liveText.length === 0) return undefined;
  const threadId = currentTurn?.threadId ?? "__active_thread__";
  const responseKey = liveFinalResponseItemKey(threadId, currentTurn?.responseKey);
  return { key: responseKey, type: "message", message: { id: responseKey, thread_id: threadId, role: "assistant", content: liveText, tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: new Date(0).toISOString(), sequence: Number.MAX_SAFE_INTEGER, attachments: null }, textIsStreaming, agentDisplayState: agentDisplayState?.phase === "finalizing" ? { phase: "finalizing" } : { phase: "streaming" } };
}

function narrativeIndicatorItem(toolCalls: readonly ToolCall[], isAgentRunning: boolean, startTime: number | undefined, thoughts: readonly ThoughtSegment[]): ChatVirtualItem | undefined {
  if (!isAgentRunning && toolCalls.length === 0) return undefined;
  const topLevelTools = toolCalls.filter((toolCall) => toolCall.parentToolCallId == null);
  return { key: "narrative-indicator", type: "narrative-indicator", summaryHeading: currentActivityHeading(thoughts), stepCount: topLevelTools.length, subagentCount: topLevelTools.filter((toolCall) => toolCall.toolName === "Agent").length, activeToolCalls: toolCalls.filter((toolCall) => !toolCall.isComplete && toolCall.parentToolCallId == null), startTime, isAgentRunning };
}

function permissionRequestItems(permissions: Parameters<typeof buildVolatileItems>[4]): ChatVirtualItem[] {
  return permissions?.map((permission) => ({ key: `permission-${permission.requestId}`, type: "permission-request" as const, requestId: permission.requestId, toolName: permission.toolName, input: permission.input, title: permission.title, questions: permission.questions, options: permission.options, settled: permission.settled, decision: permission.decision, optionLabel: permission.optionLabel })) ?? [];
}

function sameArrayItems<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameAgentDisplayState(
  left: Extract<ChatVirtualItem, { type: "message" }>["agentDisplayState"],
  right: Extract<ChatVirtualItem, { type: "message" }>["agentDisplayState"],
): boolean {
  if (left === right) return true;
  if (left?.phase !== right?.phase) return false;
  const leftReason = left?.phase === "errored" ? left.reason : undefined;
  const rightReason = right?.phase === "errored" ? right.reason : undefined;
  return leftReason === rightReason;
}

function sameMessage(left: Message, right: Message): boolean {
  return [
    left.id === right.id,
    left.thread_id === right.thread_id,
    left.role === right.role,
    left.content === right.content,
    left.tool_calls === right.tool_calls,
    left.files_changed === right.files_changed,
    left.cost_usd === right.cost_usd,
    left.tokens_used === right.tokens_used,
    left.timestamp === right.timestamp,
    left.sequence === right.sequence,
    left.attachments === right.attachments,
    left.tool_call_count === right.tool_call_count,
    left.reply_to_message_id === right.reply_to_message_id,
    left.quoted_text === right.quoted_text,
    left.model === right.model,
    left.is_internal === right.is_internal,
  ].every(Boolean);
}

function sameMessageVirtualItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "message" && right.type === "message" && sameMessage(left.message, right.message) && left.textIsStreaming === right.textIsStreaming && sameAgentDisplayState(left.agentDisplayState, right.agentDisplayState);
}

function sameTurnChangesItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "turn-changes" && right.type === "turn-changes" && [left.messageId === right.messageId, left.filesChanged === right.filesChanged, left.isLatestTurn === right.isLatestTurn].every(Boolean);
}

function samePermissionRequestItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "permission-request" && right.type === "permission-request" && [left.requestId === right.requestId, left.toolName === right.toolName, left.input === right.input, left.title === right.title, left.questions === right.questions, left.options === right.options, left.settled === right.settled, left.decision === right.decision, left.optionLabel === right.optionLabel].every(Boolean);
}

function sameNarrativeFlowItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "narrative-flow" && right.type === "narrative-flow" && [left.toolCalls === right.toolCalls, left.hooks === right.hooks, left.thoughtSegments === right.thoughtSegments, left.streamingText === right.streamingText, left.isAgentRunning === right.isAgentRunning, left.startTime === right.startTime, left.committedAssistantBody === right.committedAssistantBody].every(Boolean);
}

function sameWorkFoldItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "work-fold" && right.type === "work-fold" && [left.messageId === right.messageId, left.messageContent === right.messageContent, left.outcome === right.outcome, left.durationMs === right.durationMs, left.approvalNote === right.approvalNote].every(Boolean);
}

function sameTurnMetaLineItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "turn-meta-line" && right.type === "turn-meta-line" && left.messageId === right.messageId && left.steps === right.steps && left.subagents === right.subagents;
}

function sameNarrativeIndicatorItem(left: ChatVirtualItem, right: ChatVirtualItem): boolean {
  return left.type === "narrative-indicator" && right.type === "narrative-indicator" && [left.summaryHeading === right.summaryHeading, left.stepCount === right.stepCount, left.subagentCount === right.subagentCount, sameArrayItems(left.activeToolCalls, right.activeToolCalls), left.startTime === right.startTime, left.isAgentRunning === right.isAgentRunning].every(Boolean);
}

const VIRTUAL_ITEM_EQUALITY: Record<ChatVirtualItem["type"], (left: ChatVirtualItem, right: ChatVirtualItem) => boolean> = {
  message: sameMessageVirtualItem,
  "turn-changes": sameTurnChangesItem,
  "permission-request": samePermissionRequestItem,
  "narrative-flow": sameNarrativeFlowItem,
  "work-fold": sameWorkFoldItem,
  "turn-meta-line": sameTurnMetaLineItem,
  "narrative-indicator": sameNarrativeIndicatorItem,
};

function sameVirtualItem(left: ChatVirtualItem | undefined, right: ChatVirtualItem): boolean {
  return left !== undefined && left.key === right.key && left.type === right.type && VIRTUAL_ITEM_EQUALITY[right.type](left, right);
}

function reuseVirtualItems(
  previous: readonly ChatVirtualItem[],
  next: ChatVirtualItem[],
): ChatVirtualItem[] {
  if (previous.length === 0) return next;
  const previousByKey = new Map(previous.map((item) => [item.key, item]));
  let changed = previous.length !== next.length;
  const reused = next.map((item, index) => {
    const prior = previousByKey.get(item.key);
    if (sameVirtualItem(prior, item)) {
      if (previous[index]?.key !== item.key) {
        changed = true;
      }
      return prior!;
    }
    changed = true;
    return item;
  });
  if (!changed) return previous as ChatVirtualItem[];
  return reused;
}

/** Creates a volatile item builder that preserves slot object identity across unchanged inputs. */
export function createVolatileItemsBuilder(): typeof buildVolatileItems {
  let previous: readonly ChatVirtualItem[] = [];
  return (...args) => {
    const next = buildVolatileItems(...args);
    previous = reuseVirtualItems(previous, next);
    return previous as ChatVirtualItem[];
  };
}

/** Creates a virtual item splicer that returns the same array when the splice inputs are unchanged. */
export function createVirtualItemsBuilder(): typeof buildVirtualItems {
  let previousStable: readonly ChatVirtualItem[] | undefined;
  let previousVolatile: readonly ChatVirtualItem[] | undefined;
  let previousHasNarrative: boolean | undefined;
  let previousResponseMessageId: string | undefined;
  let previousResult: readonly ChatVirtualItem[] = [];
  return (stableItems, volatileItems, hasNarrative, responseMessageId) => {
    if (
      previousStable === stableItems &&
      previousVolatile === volatileItems &&
      previousHasNarrative === hasNarrative && previousResponseMessageId === responseMessageId
    ) {
      return previousResult as ChatVirtualItem[];
    }
    previousStable = stableItems;
    previousVolatile = volatileItems;
    previousHasNarrative = hasNarrative;
    previousResponseMessageId = responseMessageId;
    previousResult = reuseVirtualItems(
      previousResult,
      buildVirtualItems(stableItems, volatileItems, hasNarrative, responseMessageId),
    );
    return previousResult as ChatVirtualItem[];
  };
}

/**
 * Combine stable and volatile segments into the final virtual item array.
 * Active narrative can precede only its own persisted response.
 * A new turn without a persisted response appends after the existing conversation.
 */
export function buildVirtualItems(
  stableItems: readonly ChatVirtualItem[],
  volatileItems: readonly ChatVirtualItem[],
  hasNarrative: boolean,
  responseMessageId?: string,
): ChatVirtualItem[] {
  const deduped = dedupeVolatileItems(stableItems, volatileItems);
  if (volatileItems.length === 0 || !hasNarrative || deduped.length === 0) return [...stableItems, ...deduped];
  const assistantIndex = responseMessageId === undefined
    ? -1
    : stableItems.findIndex((item) => item.type === "message" && item.message.id === responseMessageId);
  const assistant = stableItems[assistantIndex];
  if (assistant?.type !== "message" || assistant.message.id !== responseMessageId) return [...stableItems, ...deduped];
  return spliceNarrativeItems(stableItems, deduped, assistantIndex) ?? [...stableItems, ...deduped];
}

function dedupeVolatileItems(stableItems: readonly ChatVirtualItem[], volatileItems: readonly ChatVirtualItem[]): ChatVirtualItem[] {
  const stableKeys = new Set(stableItems.map((item) => item.key));
  return volatileItems.filter((item) => item.type !== "message" || !isAgentDisplayActive(item.agentDisplayState) || !stableKeys.has(item.key));
}

/**
 * A plan-questions message takes the narrative only once its own work fold precedes it.
 * The fold exists only after that turn settles, so a later turn's narrative still appends below the questions.
 */
function isAssistantInsertionPoint(stableItems: readonly ChatVirtualItem[], index: number): boolean {
  const item = stableItems[index];
  if (item?.type !== "message" || item.message.role !== "assistant") return false;
  if (!isPlanQuestionsMessage(item.message.content)) return true;
  const previous = stableItems[index - 1];
  return previous?.type === "work-fold" && previous.messageId === item.message.id;
}

function isNarrativeHeadItem(item: ChatVirtualItem): boolean {
  return item.type === "narrative-flow" || (item.type === "message" && item.message.role === "assistant" && isAgentDisplayActive(item.agentDisplayState));
}

function spliceNarrativeItems(stableItems: readonly ChatVirtualItem[], volatileItems: readonly ChatVirtualItem[], assistantIndex: number): ChatVirtualItem[] | undefined {
  const assistantItem = stableItems[assistantIndex];
  if (!assistantItem || !isAssistantInsertionPoint(stableItems, assistantIndex)) return undefined;
  const headItems = volatileItems.filter(isNarrativeHeadItem);
  const indicatorItems = volatileItems.filter((item) => item.type === "narrative-indicator");
  const tailItems = volatileItems.filter((item) => !isNarrativeHeadItem(item) && item.type !== "narrative-indicator");
  return [...stableItems.slice(0, assistantIndex), ...headItems, assistantItem, ...indicatorItems, ...stableItems.slice(assistantIndex + 1), ...tailItems];
}
