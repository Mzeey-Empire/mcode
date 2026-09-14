/**
 * @internal
 * Maps Devin ACP `session/update` notifications to mcode {@link AgentEvent}s.
 *
 * Devin differs from Cursor in three load-bearing ways:
 * - the authoritative tool name is `_meta["cognition.ai/inferenceToolName"]`,
 *   not `kind` (`kind: "edit"` covers both write and write_plan, and
 *   `run_subagent` has no `kind` at all);
 * - plans arrive as `write_plan` tool calls editing `~/.devin/plans/*.md`,
 *   never as the spec `plan` update;
 * - subagent children stream orphan `tool_call_update`s keyed by agentId with
 *   `_meta.subagent_started`/`subagent_completed` and no `tool_call` marker.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";

const INFERENCE_TOOL_NAME_META = "cognition.ai/inferenceToolName";
const SUBAGENT_STARTED_META = "cognition.ai/subagent_started";
const SUBAGENT_COMPLETED_META = "cognition.ai/subagent_completed";
const EDITABLE_COMMAND_META = "cognition.ai/editableCommand";
const TERMINAL_EXIT_META = "terminal_exit";

const MAX_RETAINED_TOOL_RESULT_CHARS = 64_000;
const TRUNCATION_MARKER = "\n[Devin tool output truncated]";

/** Maps Devin's `_meta` inference tool name to an Mcode tool name. */
const TOOL_NAME_BY_INFERENCE_NAME: Record<string, string> = {
  read: "Read",
  exec: "Bash",
  write: "Write",
  write_plan: "Write",
  run_subagent: "Agent",
  search: "Grep",
  delete: "Bash",
};

/** Maps ACP `kind` to an Mcode tool name when no inference name exists. */
const TOOL_NAME_BY_ACP_KIND: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  command: "Bash",
  execute: "Bash",
  search: "Grep",
  subagent: "Agent",
  delegate: "Agent",
  other: "Tool",
};

const IGNORED_SESSION_UPDATES = new Set<string>([
  "user_message_chunk",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
]);

/** Accumulator and correlation state for one Devin ACP prompt turn. */
export interface DevinAcpTurnState {
  accumulator: {
    assistantText: string;
    assistantFinalText: string;
    toolStartTimes: Map<string, number>;
    pendingToolCalls: Set<string>;
    hasFiredToolThisTurn: boolean;
  };
  /** toolCallId -> snapshot for permission-request correlation. */
  toolCallById: Map<string, { toolName: string; input: Record<string, unknown>; title?: string }>;
  /** Unresolved `run_subagent` toolCallIds, in arrival order. */
  pendingSubagentCallIds: string[];
  /** agentId -> owning run_subagent toolCallId. */
  subagentParentByAgentId: Map<string, string>;
  /** toolCallId -> resolved Mcode tool name. */
  toolNameByCallId: Map<string, string>;
  /** Bounded in-progress result text kept until the terminal update. */
  retainedToolResultByCallId: Map<string, string>;
  /** toolCallIds whose tool_call marker emitted a sparse ToolUse; a merge ToolUse follows once rawInput arrives. */
  deferredToolCallIds: Set<string>;
  /** Latest model label from `_cognition.ai/agent_stopped`. */
  stoppedModelLabel: string | null;
}

/** Creates a fresh per-turn state bundle. */
export function createDevinAcpTurnState(): DevinAcpTurnState {
  return {
    accumulator: {
      assistantText: "",
      assistantFinalText: "",
      toolStartTimes: new Map(),
      pendingToolCalls: new Set(),
      hasFiredToolThisTurn: false,
    },
    toolCallById: new Map(),
    pendingSubagentCallIds: [],
    subagentParentByAgentId: new Map(),
    toolNameByCallId: new Map(),
    retainedToolResultByCallId: new Map(),
    deferredToolCallIds: new Set(),
    stoppedModelLabel: null,
  };
}

/** Converts one `session/update` notification into zero or more agent events. */
export function mapDevinAcpSessionNotification(
  notification: SessionNotification,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  const update = notification.update as Record<string, unknown>;
  const kind = update.sessionUpdate;
  if (typeof kind !== "string" || IGNORED_SESSION_UPDATES.has(kind)) return [];
  if (kind === "agent_message_chunk") return mapMessageChunk(threadId, state, update, false);
  if (kind === "agent_thought_chunk") return mapMessageChunk(threadId, state, update, true);
  if (kind === "tool_call") return mapToolCallStarted(update, threadId, state);
  if (kind === "tool_call_update") return mapToolCallUpdated(update, threadId, state);
  if (kind === "usage_update") return mapUsageUpdate(update, threadId);
  return [];
}

// ---------------------------------------------------------------------------
// Text chunks
// ---------------------------------------------------------------------------

function mapMessageChunk(
  threadId: string,
  state: DevinAcpTurnState,
  update: Record<string, unknown>,
  isThought: boolean,
): AgentEvent[] {
  const content = asRecord(update.content);
  if (content?.type !== "text" || typeof content.text !== "string" || !content.text) return [];
  const acc = state.accumulator;
  if (isThought) {
    // Thought text is never part of the user-facing final response.
    return [{
      type: AgentEventType.TextDelta,
      threadId,
      delta: content.text,
      isFinalResponse: false,
    }];
  }
  acc.assistantText += content.text;
  const isFinalResponse = acc.pendingToolCalls.size === 0 && acc.hasFiredToolThisTurn;
  if (isFinalResponse) acc.assistantFinalText += content.text;
  return [{
    type: AgentEventType.TextDelta,
    threadId,
    delta: content.text,
    ...(isFinalResponse && { isFinalResponse: true }),
  }];
}

// ---------------------------------------------------------------------------
// usage_update
// ---------------------------------------------------------------------------

function mapUsageUpdate(update: Record<string, unknown>, threadId: string): AgentEvent[] {
  const used = typeof update.used === "number" ? update.used : undefined;
  if (used === undefined) return [];
  const meta = asRecord(update._meta) ?? {};
  const tokensOut = numberOrUndefined(meta["cognition.ai/outputTokens"]);
  const cacheReadTokens = numberOrUndefined(meta["cognition.ai/cachedReadTokens"]);
  return [{
    type: AgentEventType.ContextEstimate,
    threadId,
    tokensIn: used,
    ...(typeof update.size === "number" ? { contextWindow: update.size } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  }];
}

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

function resolveToolName(update: Record<string, unknown>): string {
  const meta = asRecord(update._meta);
  const inference = typeof meta?.[INFERENCE_TOOL_NAME_META] === "string"
    ? meta[INFERENCE_TOOL_NAME_META] as string
    : undefined;
  if (inference) return TOOL_NAME_BY_INFERENCE_NAME[inference] ?? inference;
  const kindName = typeof update.kind === "string" ? TOOL_NAME_BY_ACP_KIND[update.kind] : undefined;
  if (kindName) return kindName;
  return typeof update.title === "string" && update.title ? update.title : "Tool";
}

function mapToolCallStarted(
  update: Record<string, unknown>,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!toolCallId) return [];

  const toolName = resolveToolName(update);
  const title = typeof update.title === "string" ? update.title : undefined;
  const rawInput = asRecord(update.rawInput) ?? {};
  state.toolNameByCallId.set(toolCallId, toolName);
  state.toolCallById.set(toolCallId, { toolName, input: rawInput, title });

  if (toolName === "Agent" && !state.pendingSubagentCallIds.includes(toolCallId)) {
    state.pendingSubagentCallIds.push(toolCallId);
  }

  state.accumulator.toolStartTimes.set(toolCallId, Date.now());
  state.accumulator.pendingToolCalls.add(toolCallId);
  state.accumulator.hasFiredToolThisTurn = true;

  if (Object.keys(rawInput).length === 0) {
    // Marker-only tool_call: emit ToolUse now so the timeline keeps invocation
    // order; a merge ToolUse follows once an update carries rawInput.
    state.deferredToolCallIds.add(toolCallId);
  }
  return [{
    type: AgentEventType.ToolUse,
    threadId,
    toolCallId,
    toolName,
    toolInput: rawInput,
  }];
}

// ---------------------------------------------------------------------------
// tool_call_update
// ---------------------------------------------------------------------------

function isTerminalStatus(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

function hasResultData(update: Record<string, unknown>): boolean {
  return update.rawOutput !== undefined
    || (Array.isArray(update.content) && update.content.length > 0);
}

function boundedOutput(output: string): string {
  if (output.length <= MAX_RETAINED_TOOL_RESULT_CHARS) return output;
  const retained = MAX_RETAINED_TOOL_RESULT_CHARS - TRUNCATION_MARKER.length;
  return `${output.slice(0, retained)}${TRUNCATION_MARKER}`;
}

/** Extracts displayable text from one tool_call_update content block. */
function blockText(block: unknown): string | undefined {
  const record = asRecord(block);
  if (!record || record.type === "diff") return undefined;
  const inner = asRecord(record.content);
  if (inner?.type === "text" && typeof inner.text === "string") return inner.text;
  const resource = inner ? asRecord(inner.resource) : undefined;
  return typeof resource?.text === "string" ? resource.text : undefined;
}

/** Extracts displayable output text from a tool_call_update payload. */
function formatToolResultOutput(update: Record<string, unknown>): string {
  const content = update.content;
  const pieces = Array.isArray(content)
    ? content.map(blockText).filter((text): text is string => text !== undefined)
    : [];
  if (pieces.length === 0 && typeof update.rawOutput === "string") return update.rawOutput;
  return pieces.join("\n");
}

function subagentStartedEvents(
  started: Record<string, unknown>,
  toolCallId: string,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  const parentToolCallId = state.pendingSubagentCallIds[
    state.pendingSubagentCallIds.length - 1
  ];
  if (parentToolCallId) state.subagentParentByAgentId.set(toolCallId, parentToolCallId);
  const task = typeof started.task === "string" ? started.task : undefined;
  const title = typeof started.title === "string" ? started.title : undefined;
  const profile = typeof started.profile === "string" ? started.profile : undefined;
  state.accumulator.toolStartTimes.set(toolCallId, Date.now());
  state.accumulator.pendingToolCalls.add(toolCallId);
  state.accumulator.hasFiredToolThisTurn = true;
  return [{
    type: AgentEventType.ToolUse,
    threadId,
    toolCallId,
    toolName: "Agent",
    toolInput: { task, title, profile, is_background: started.isBackground === true },
    ...(parentToolCallId ? { parentToolCallId } : {}),
  }];
}

function subagentCompletedEvents(
  completed: Record<string, unknown>,
  toolCallId: string,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  const parentToolCallId = state.subagentParentByAgentId.get(toolCallId);
  if (parentToolCallId) {
    const idx = state.pendingSubagentCallIds.indexOf(parentToolCallId);
    if (idx >= 0) state.pendingSubagentCallIds.splice(idx, 1);
    state.subagentParentByAgentId.delete(toolCallId);
  }
  state.accumulator.toolStartTimes.delete(toolCallId);
  state.accumulator.pendingToolCalls.delete(toolCallId);
  const summary = typeof completed.summary === "string" ? completed.summary : "";
  return [{
    type: AgentEventType.ToolResult,
    threadId,
    toolCallId,
    output: summary,
    isError: completed.success === false,
  }];
}

function mapSubagentUpdate(
  update: Record<string, unknown>,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] | null {
  const meta = asRecord(update._meta) ?? {};
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!toolCallId) return null;
  const started = asRecord(meta[SUBAGENT_STARTED_META]);
  if (started) return subagentStartedEvents(started, toolCallId, threadId, state);
  const completed = asRecord(meta[SUBAGENT_COMPLETED_META]);
  if (completed) return subagentCompletedEvents(completed, toolCallId, threadId, state);
  return null;
}

/** Orphan terminal update with no preceding marker: synthesizes its ToolUse. */
function lateToolUseEvent(
  update: Record<string, unknown>,
  toolCallId: string,
  toolName: string,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent {
  const snapshot = state.toolCallById.get(toolCallId);
  state.accumulator.toolStartTimes.set(toolCallId, Date.now());
  state.accumulator.pendingToolCalls.add(toolCallId);
  state.accumulator.hasFiredToolThisTurn = true;
  return {
    type: AgentEventType.ToolUse,
    threadId,
    toolCallId,
    toolName,
    toolInput: snapshot?.input ?? (asRecord(update.rawInput) ?? {}),
  };
}

function terminalToolResultEvent(
  update: Record<string, unknown>,
  toolCallId: string,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent {
  const output = hasResultData(update)
    ? formatToolResultOutput(update)
    : (state.retainedToolResultByCallId.get(toolCallId) ?? "");
  const meta = asRecord(update._meta) ?? {};
  const terminalExit = asRecord(meta[TERMINAL_EXIT_META]);
  const exitCode = numberOrUndefined(terminalExit?.exit_code);
  return {
    type: AgentEventType.ToolResult,
    threadId,
    toolCallId,
    output: boundedOutput(output),
    isError: update.status === "failed",
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function clearToolCallState(state: DevinAcpTurnState, toolCallId: string): void {
  state.accumulator.toolStartTimes.delete(toolCallId);
  state.accumulator.pendingToolCalls.delete(toolCallId);
  state.toolNameByCallId.delete(toolCallId);
  state.retainedToolResultByCallId.delete(toolCallId);
  state.deferredToolCallIds.delete(toolCallId);
  const pendingIdx = state.pendingSubagentCallIds.indexOf(toolCallId);
  if (pendingIdx >= 0) state.pendingSubagentCallIds.splice(pendingIdx, 1);
}

/** Retains bounded in-progress result text for the terminal update. */
function retainInProgressResult(
  update: Record<string, unknown>,
  toolCallId: string,
  state: DevinAcpTurnState,
): void {
  if (!hasResultData(update)) return;
  state.retainedToolResultByCallId.set(
    toolCallId,
    boundedOutput(formatToolResultOutput(update)),
  );
}

function mapTerminalToolUpdate(
  update: Record<string, unknown>,
  toolCallId: string,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const toolName = state.toolNameByCallId.get(toolCallId) ?? resolveToolName(update);
  if (!state.accumulator.toolStartTimes.has(toolCallId)) {
    events.push(lateToolUseEvent(update, toolCallId, toolName, threadId, state));
  }
  events.push(terminalToolResultEvent(update, toolCallId, threadId, state));
  clearToolCallState(state, toolCallId);
  return events;
}

function mapToolCallUpdated(
  update: Record<string, unknown>,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  const subagentEvents = mapSubagentUpdate(update, threadId, state);
  if (subagentEvents) return subagentEvents;

  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!toolCallId) return [];

  const mergeEvents = mergeDeferredToolInput(update, toolCallId, threadId, state);

  if (update.status === "in_progress") {
    retainInProgressResult(update, toolCallId, state);
    return mergeEvents;
  }

  const isStatuslessResult = update.status === undefined && hasResultData(update);
  if (!isTerminalStatus(update.status) && !isStatuslessResult) return mergeEvents;
  return [...mergeEvents, ...mapTerminalToolUpdate(update, toolCallId, threadId, state)];
}

/**
 * Emits a merge ToolUse when an update carries rawInput for a call whose marker
 * went out without args; the client folds it into the existing card.
 */
function mergeDeferredToolInput(
  update: Record<string, unknown>,
  toolCallId: string,
  threadId: string,
  state: DevinAcpTurnState,
): AgentEvent[] {
  if (!state.deferredToolCallIds.has(toolCallId)) return [];
  const rawInput = asRecord(update.rawInput);
  if (!rawInput || Object.keys(rawInput).length === 0) return [];
  state.deferredToolCallIds.delete(toolCallId);
  const toolName = state.toolNameByCallId.get(toolCallId) ?? resolveToolName(update);
  return [{
    type: AgentEventType.ToolUse,
    threadId,
    toolCallId,
    toolName,
    toolInput: rawInput,
  }];
}

// ---------------------------------------------------------------------------
// Extension notifications
// ---------------------------------------------------------------------------

/**
 * Handles Devin extension notifications. `_cognition.ai/agent_stopped` carries
 * the authoritative model label; it only feeds turn attribution, not a visible
 * event (the prompt response remains the turn boundary).
 */
export function observeDevinExtensionNotification(
  method: string,
  params: unknown,
  state: DevinAcpTurnState | null,
): void {
  if (!state) return;
  if (method !== "_cognition.ai/agent_stopped") return;
  const record = asRecord(params);
  const stats = record ? asRecord(record.stats) : undefined;
  const label = typeof stats?.modelLabel === "string" ? stats.modelLabel : undefined;
  if (label) state.stoppedModelLabel = label;
}

/** Command preview shown on a permission card, preferring Devin's editable command. */
export function devinPermissionPreview(toolCall: unknown): string | undefined {
  const record = asRecord(toolCall);
  const meta = record ? asRecord(record._meta) : undefined;
  const editable = meta?.[EDITABLE_COMMAND_META];
  return typeof editable === "string" ? editable : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
