import type { SessionEvent } from "@github/copilot-sdk";
import { createSubagentPresentation } from "@mcode/contracts/models/tool-call-record";
import { type AgentEvent } from "@mcode/contracts/events/agent-event";
import { type ChildThreadEvidence } from "@mcode/contracts/events/provider-runtime-event";
import { type TurnFailure } from "@mcode/contracts/models/turn-failure";
import { z } from "zod";
import { normalizeQuotaSnapshots } from "./copilot-helpers.js";

/** Per-turn protocol state, stored with the runtime-owned native session. */
export interface CopilotTurnState {
  turnExecutionId: string;
  outcome?: "completed" | "cancelled" | "failed";
  nativeIdleObserved: boolean;
  assistantText?: { messageId: string; content: string };
  /** Open reasoning block, so the final `assistant.reasoning` emits only the text its deltas missed. */
  reasoning?: { reasoningId: string; content: string };
  pendingAssistantMessage?: Extract<SessionEvent, { type: "assistant.message" }>;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  contextWindow?: number;
  tools: Map<string, { name: string; startedAt: number; input?: Record<string, unknown>; parentToolCallId?: string; failed?: boolean }>;
  invocations: Map<string, { parentToolCallId?: string; state: "open" | "closed" }>;
  pendingPermissions: Map<string, { request: import("@mcode/contracts/models/approval").ApprovalRequestEnvelope & { body: import("@mcode/contracts/models/approval").ApprovalRequestBody }; sessionGrantKeys: string[]; unanswerable?: boolean; resolve: (result: import("@github/copilot-sdk").PermissionRequestResult) => void }>;
  settle: (outcome: "completed" | "cancelled" | "failed", error?: Error) => void;
  completed: Promise<void>;
  abortTask?: Promise<void>;
}

/** One generic event with optional private child routing evidence. */
export interface CopilotMappedEvent {
  readonly event: AgentEvent;
  readonly childThread?: ChildThreadEvidence;
}

/** Maps native evidence without treating chronological predecessors as child lineage. */
export function mapCopilotEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] {
  validateEnvelope(event);
  validateData(event);
  const owner = nativeParentToolCallId(event);
  if (owner !== undefined) return mapChildEvent(event, threadId, turn, owner);
  const tools = mapToolEvent(event, threadId, turn);
  if (tools) return tools;
  const events = mapAssistantEvent(event, threadId, turn) ?? mapUsageEvent(event, threadId, turn)
    ?? mapCompactionEvent(event, threadId) ?? mapLifecycleEvent(event, threadId, turn)
    ?? [{ type: "system", threadId, subtype: `copilot_native:${event.type}` } satisfies AgentEvent];
  return events.map((event) => ({ event }));
}

function mapChildEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState, owner: string): CopilotMappedEvent[] {
  switch (event.type) {
    case "assistant.message_delta": return childEvent(turn, owner,
        { type: "textDelta", threadId, delta: event.data.deltaContent }, { nativeItemId: event.data.messageId });
    case "assistant.message":
      if (!event.data.content || event.data.phase === "thinking") return [];
      return childEvent(turn, owner,
        { type: "textDelta", threadId, delta: event.data.content }, { nativeItemId: event.data.messageId, final: true });
    case "tool.execution_start":
    case "tool.execution_complete": return mapToolEvent(event, threadId, turn) ?? [];
    default: return [];
  }
}

function delegationPath(turn: CopilotTurnState, toolCallId: string): string[] | undefined {
  const path: string[] = [];
  let current: string | undefined = toolCallId;
  while (current !== undefined) {
    if (path.includes(current) || path.length >= 8) return undefined;
    const invocation = turn.invocations.get(current);
    if (!invocation) return undefined;
    path.unshift(current);
    current = invocation.parentToolCallId;
  }
  return path;
}

// A closed child's transcript is final, so later observations are dropped here rather than surfaced as parent routing errors.
function childEvent(turn: CopilotTurnState, owner: string, event: AgentEvent,
  detail: Pick<Extract<ChildThreadEvidence, { role: "child" }>, "nativeItemId" | "final"> = {}): CopilotMappedEvent[] {
  if (turn.invocations.get(owner)?.state === "closed") return [];
  return childEvidence(turn, owner, event, detail);
}

function childEvidence(turn: CopilotTurnState, owner: string, event: AgentEvent,
  detail: Pick<Extract<ChildThreadEvidence, { role: "child" }>, "nativeItemId" | "final"> = {}): CopilotMappedEvent[] {
  const path = delegationPath(turn, owner);
  return path ? [{ event, childThread: { role: "child", path, ...detail } }] : [];
}

function scoped(turn: CopilotTurnState, toolCallId: string, event: AgentEvent): CopilotMappedEvent[] {
  const parent = turn.tools.get(toolCallId)?.parentToolCallId ?? turn.invocations.get(toolCallId)?.parentToolCallId;
  return parent === undefined ? [{ event }] : childEvent(turn, parent, event);
}

/** Close each unfinished child once while keeping its ancestry available for late observations. */
export function closeOpenChildren(turn: CopilotTurnState, threadId: string,
  outcome: "interrupted" | "cancelled" | "errored"): CopilotMappedEvent[] {
  const events: CopilotMappedEvent[] = [];
  for (const [toolCallId, invocation] of turn.invocations) {
    if (invocation.state === "closed") continue;
    invocation.state = "closed";
    events.push(...childEvidence(turn, toolCallId, { type: "ended", threadId, turnExecutionId: turn.turnExecutionId, outcome }));
  }
  return events;
}

function mapAssistantEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): AgentEvent[] | undefined {
  switch (event.type) {
    case "assistant.turn_start": return [...resetAssistantText(turn, threadId), { type: "system", threadId, subtype: `copilot_native:${event.type}` }];
    case "assistant.message_delta": {
      const events = beginAssistantText(turn, threadId, event.data.messageId);
      turn.assistantText!.content += event.data.deltaContent;
      return [...events, { type: "textDelta", threadId, delta: event.data.deltaContent }];
    }
    case "assistant.message": return event.data.phase === "thinking" ? mapThinkingMessage(event, threadId, turn) : deferAssistantMessage(event, threadId, turn);
    case "assistant.reasoning_delta": return mapReasoningDelta(event, threadId, turn);
    case "assistant.reasoning": return finishReasoning(event, threadId, turn);
    default: return undefined;
  }
}

// Reasoning leaves assistant text untouched: Copilot opens each model call with assistant.turn_start, which
// already settles prior narration, and the server closes open narration when a reasoning block opens.
function mapReasoningDelta(event: Extract<SessionEvent, { type: "assistant.reasoning_delta" }>, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  const { reasoningId, deltaContent } = event.data;
  if (turn.reasoning?.reasoningId !== reasoningId) turn.reasoning = { reasoningId, content: "" };
  turn.reasoning.content += deltaContent;
  return deltaContent ? reasoningDeltas(threadId, reasoningId, deltaContent) : [];
}

function finishReasoning(event: Extract<SessionEvent, { type: "assistant.reasoning" }>, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  const { reasoningId, content } = event.data;
  const streamed = turn.reasoning?.reasoningId === reasoningId ? turn.reasoning.content : "";
  if (turn.reasoning?.reasoningId === reasoningId) turn.reasoning = undefined;
  return reasoningDeltas(threadId, reasoningId, content.startsWith(streamed) ? content.slice(streamed.length) : content, true);
}

function mapThinkingMessage(event: Extract<SessionEvent, { type: "assistant.message" }>, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  // Deltas carry no phase, so streamed text for this message already went out as answer text; repeating it as reasoning would show it twice.
  if (!event.data.content || (turn.assistantText?.messageId === event.data.messageId && turn.assistantText.content)) return [];
  return reasoningDeltas(threadId, event.data.messageId, event.data.content, true);
}

const MAX_REASONING_DELTA_LENGTH = 65_536;
function reasoningDeltas(threadId: string, reasoningItemId: string, text: string, done?: true): AgentEvent[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_REASONING_DELTA_LENGTH) chunks.push(text.slice(start, start + MAX_REASONING_DELTA_LENGTH));
  if (chunks.length === 0) chunks.push("");
  return chunks.map((delta, index) => ({ type: "reasoningDelta", threadId, delta, reasoningItemId, ...(done && index === chunks.length - 1 ? { done } : {}) }));
}

function resetAssistantText(turn: CopilotTurnState, threadId: string): AgentEvent[] {
  const events: AgentEvent[] = turn.assistantText?.content ? [{ type: "assistantMessageBoundary", threadId, isFinalResponse: false }] : [];
  turn.assistantText = undefined;
  turn.pendingAssistantMessage = undefined;
  return events;
}

function beginAssistantText(turn: CopilotTurnState, threadId: string, messageId: string): AgentEvent[] {
  if (turn.assistantText?.messageId === messageId) return [];
  const events = resetAssistantText(turn, threadId);
  turn.assistantText = { messageId, content: "" };
  return events;
}

function deferAssistantMessage(event: Extract<SessionEvent, { type: "assistant.message" }>, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  if (!event.data.content) return [];
  const events = beginAssistantText(turn, threadId, event.data.messageId);
  const streamed = turn.assistantText!.content;
  const followsStream = event.data.content.startsWith(streamed);
  if (!followsStream) events.push(...resetAssistantText(turn, threadId));
  const missing = followsStream ? event.data.content.slice(streamed.length) : event.data.content;
  turn.assistantText = { messageId: event.data.messageId, content: event.data.content };
  turn.pendingAssistantMessage = event;
  if (missing) events.push({ type: "textDelta", threadId, delta: missing });
  return events;
}
function mapToolEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] | undefined {
  switch (event.type) {
    case "tool.execution_start": return startTool(event, threadId, turn);
    case "tool.execution_complete": return completeTool(event, threadId, turn);
    case "tool.execution_progress": return toolProgress(event, threadId, turn);
    case "subagent.started": return startSubagent(event, threadId, turn);
    case "subagent.failed": return failSubagent(event, threadId, turn);
    case "subagent.completed": return closeInvocation(turn, event.data.toolCallId,
      { type: "turnComplete", threadId, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    default: return undefined;
  }
}
function startTool(event: Extract<SessionEvent, { type: "tool.execution_start" }>, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] {
  if (turn.tools.size >= 1_024) throw new Error("Copilot tool index overflowed");
  const name = event.data.toolName === "task" ? "Agent" : event.data.toolName;
  const input = event.data.arguments ?? {};
  const parentToolCallId = event.data.parentToolCallId;
  turn.tools.set(event.data.toolCallId, { name, input, parentToolCallId, startedAt: Date.parse(event.timestamp) });
  const toolInput = name === "Agent" ? provisionalDelegationInput(input) : input;
  return scoped(turn, event.data.toolCallId, { type: "toolUse", threadId, toolCallId: event.data.toolCallId, toolName: name, toolInput,
    ...(name === "Agent" ? { subagentPresentation: createSubagentPresentation(toolInput, event.data.toolCallId) } : {}) });
}
function provisionalDelegationInput(input: Record<string, unknown>): Record<string, unknown> {
  const { prompt: _prompt, ...remaining } = input;
  return remaining;
}
function startSubagent(event: Extract<SessionEvent, { type: "subagent.started" }>, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] {
  const tool = turn.tools.get(event.data.toolCallId);
  if (!turn.invocations.has(event.data.toolCallId)) {
    if (turn.invocations.size >= 1_024) throw new Error("Copilot child invocation index overflowed");
    turn.invocations.set(event.data.toolCallId, { parentToolCallId: tool?.parentToolCallId, state: "open" });
  }
  const path = delegationPath(turn, event.data.toolCallId);
  if (!path) return [];
  const delegation = copilotDelegation(tool?.input, event.data);
  return [{ event: { type: "toolUse", threadId, toolCallId: event.data.toolCallId, toolName: "Agent", toolInput: delegation.input,
    subagentPresentation: createSubagentPresentation(delegation.input, event.data.toolCallId) },
    childThread: { role: "delegate", path, ...delegation.evidence } }];
}
function copilotDelegation(input: Record<string, unknown> | undefined, data: Extract<SessionEvent, { type: "subagent.started" }>["data"]) {
  const title = typeof input?.description === "string" && input.description.trim() ? input.description : data.agentDisplayName;
  return { input: { ...input, description: title, prompt: data.agentDescription, subagentType: data.agentName },
    evidence: { prompt: data.agentDescription, title, agentType: data.agentName } };
}
function failSubagent(event: Extract<SessionEvent, { type: "subagent.failed" }>, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] {
  const tool = turn.tools.get(event.data.toolCallId);
  if (tool) tool.failed = true;
  return [...closeInvocation(turn, event.data.toolCallId, { type: "error", threadId, error: event.data.error, failure: { kind: "fatal" } }),
    ...scoped(turn, event.data.toolCallId, { type: "toolResult", threadId, toolCallId: event.data.toolCallId, output: event.data.error, isError: true })];
}
function closeInvocation(turn: CopilotTurnState, toolCallId: string, event: AgentEvent): CopilotMappedEvent[] {
  const invocation = turn.invocations.get(toolCallId);
  if (!invocation || invocation.state === "closed") return [];
  invocation.state = "closed";
  return childEvidence(turn, toolCallId, event);
}
function completeTool(event: Extract<SessionEvent, { type: "tool.execution_complete" }>, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] {
  const tool = turn.tools.get(event.data.toolCallId);
  const parent = event.data.parentToolCallId ?? tool?.parentToolCallId;
  const result: AgentEvent = { type: "toolResult", threadId, toolCallId: event.data.toolCallId, output: toolOutput(event.data), isError: tool?.failed === true || !event.data.success };
  const events = parent === undefined ? scoped(turn, event.data.toolCallId, result) : childEvent(turn, parent, result);
  turn.tools.delete(event.data.toolCallId);
  return events;
}
function toolOutput(data: Extract<SessionEvent, { type: "tool.execution_complete" }>["data"]): string {
  return data.result?.detailedContent ?? data.result?.content ?? data.error?.message ?? "";
}

function nativeParentToolCallId(event: SessionEvent): string | undefined {
  return "parentToolCallId" in event.data && typeof event.data.parentToolCallId === "string" ? event.data.parentToolCallId : undefined;
}
function toolProgress(event: Extract<SessionEvent, { type: "tool.execution_progress" }>, threadId: string, turn: CopilotTurnState): CopilotMappedEvent[] {
  const tool = turn.tools.get(event.data.toolCallId);
  if (tool?.parentToolCallId !== undefined || turn.invocations.get(event.data.toolCallId)?.parentToolCallId !== undefined) return [];
  const at = Date.parse(event.timestamp);
  return [{ event: { type: "toolProgress", threadId, toolCallId: event.data.toolCallId, toolName: tool?.name ?? "", elapsedSeconds: Math.max(0, (at - (tool?.startedAt ?? at)) / 1_000) } }];
}
function mapUsageEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): AgentEvent[] | undefined {
  if (event.type === "session.usage_info") {
    turn.contextWindow = event.data.tokenLimit;
    return [{ type: "contextEstimate", threadId, contextWindow: event.data.tokenLimit, tokensIn: event.data.currentTokens }];
  }
  if (event.type !== "assistant.usage") return undefined;
  recordUsage(event, turn);
  return event.data.quotaSnapshots ? [{ type: "quotaUpdate", threadId, providerId: "copilot", categories: normalizeQuotaSnapshots(event.data.quotaSnapshots) }] : [];
}
function recordUsage(event: Extract<SessionEvent, { type: "assistant.usage" }>, turn: CopilotTurnState): void {
  turn.tokensIn += event.data.inputTokens ?? 0;
  turn.tokensOut += event.data.outputTokens ?? 0;
  turn.cacheRead += event.data.cacheReadTokens ?? 0;
  turn.cacheWrite += event.data.cacheWriteTokens ?? 0;
  if (event.data.cost !== undefined) turn.cost = (turn.cost ?? 0) + event.data.cost;
}
function mapCompactionEvent(event: SessionEvent, threadId: string): AgentEvent[] | undefined {
  if (event.type === "session.compaction_start") return [{ type: "compacting", threadId, active: true }];
  if (event.type !== "session.compaction_complete") return undefined;
  return [...(event.data.summaryContent ? [{ type: "compactSummary" as const, threadId, summary: event.data.summaryContent }] : []), { type: "compacting", threadId, active: false }];
}
function mapLifecycleEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): AgentEvent[] | undefined {
  switch (event.type) {
    case "session.error":
      turn.settle("failed", new Error(event.data.message));
      return [...finishAssistantText(turn, threadId), { type: "error", threadId, error: event.data.message, failure: classifyCopilotFailure(event.data) }];
    case "abort":
      turn.outcome ??= "cancelled";
      return [{ type: "system", threadId, subtype: "copilot_abort" }];
    case "session.idle":
      turn.nativeIdleObserved = true;
      turn.settle(event.data.aborted || turn.outcome === "cancelled" ? "cancelled" : "completed");
      return [...(turn.outcome === "completed" && turn.pendingAssistantMessage ? [] : finishAssistantText(turn, threadId)), { type: "system", threadId, subtype: "copilot_idle" }];
    default: return undefined;
  }
}

const copilotFailureDataSchema = z.object({
  errorType: z.string().trim().min(1).max(128).optional().catch(undefined),
  statusCode: z.number().int().min(100).max(599).optional().catch(undefined),
});
const copilotFailureKinds = new Map<string, TurnFailure["kind"]>([
  ["authentication", "auth"], ["authorization", "auth"], ["quota", "usage_limit"],
  ["rate_limit", "retryable"], ["context_limit", "fatal"],
]);

function classifyCopilotFailure(data: Extract<SessionEvent, { type: "session.error" }>["data"]): TurnFailure {
  const { errorType: code, statusCode: status } = copilotFailureDataSchema.parse(data);
  const kind = copilotFailureKinds.get(code ?? "") ?? (status !== undefined && status >= 500 ? "retryable" : "fatal");
  return { kind, ...(status === undefined ? {} : { status }), ...(code === undefined ? {} : { code }) };
}

const nativeEnvelopeSchema = z.object({ id: z.string().min(1).max(200), timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))), type: z.string().min(1), parentId: z.string().nullable(), data: z.record(z.unknown()) });
function validateEnvelope(event: SessionEvent): void {
  if (!nativeEnvelopeSchema.safeParse(event).success) throw new Error("Malformed Copilot native event envelope");
}

function finishAssistantText(turn: CopilotTurnState, threadId: string): AgentEvent[] {
  const content = turn.assistantText?.content;
  turn.assistantText = undefined;
  return content ? [{ type: "assistantMessageBoundary", threadId, isFinalResponse: true }] : [];
}

function validateData(event: SessionEvent): void {
  const fields = new Map(Object.entries(event.data));
  const requiredStrings: Record<string, string[]> = {
    "assistant.message": ["messageId", "content"], "assistant.message_delta": ["messageId", "deltaContent"],
    "tool.execution_start": ["toolCallId", "toolName"], "tool.execution_complete": ["toolCallId"],
    "tool.execution_progress": ["toolCallId"], "session.error": ["message"],
    "subagent.started": ["toolCallId", "agentName", "agentDisplayName", "agentDescription"],
    "subagent.completed": ["toolCallId", "agentName", "agentDisplayName"],
    "subagent.failed": ["toolCallId", "agentName", "agentDisplayName", "error"],
    "assistant.turn_start": ["turnId"], "assistant.turn_end": ["turnId"],
    "assistant.reasoning": ["reasoningId", "content"], "assistant.reasoning_delta": ["reasoningId", "deltaContent"],
  };
  for (const key of requiredStrings[event.type] ?? []) {
    if (typeof fields.get(key) !== "string") throw new Error(`Malformed Copilot ${event.type}.${key}`);
  }
  validateToolAndContextData(event, fields);
  validateUsageData(event, fields);
  validateOptionalData(event);
}
const toolArgumentsSchema = z.record(z.unknown()).optional();
const toolResultSchema = z.object({ content: z.string(), detailedContent: z.string().optional() }).optional();
const nativeErrorSchema = z.object({ message: z.string() }).optional();
const idleDataSchema = z.object({ aborted: z.boolean().optional() });
const reasoningItemIdSchema = z.string().min(1).max(256);
function validateOptionalData(event: SessionEvent): void {
  if (event.type === "tool.execution_start" && !toolArgumentsSchema.safeParse(event.data.arguments).success) throw new Error("Malformed Copilot tool arguments");
  if (event.type === "tool.execution_complete" && (!toolResultSchema.safeParse(event.data.result).success || !nativeErrorSchema.safeParse(event.data.error).success)) throw new Error("Malformed Copilot tool output");
  if (event.type === "session.idle" && !idleDataSchema.safeParse(event.data).success) throw new Error("Malformed Copilot idle outcome");
  validateReasoningId(event);
}
function validateReasoningId(event: SessionEvent): void {
  const reasoningId = event.type === "assistant.reasoning" || event.type === "assistant.reasoning_delta" ? event.data.reasoningId
    : event.type === "assistant.message" && event.data.phase === "thinking" ? event.data.messageId : undefined;
  if (reasoningId !== undefined && !reasoningItemIdSchema.safeParse(reasoningId).success) throw new Error("Malformed Copilot reasoning identity");
}
function validateToolAndContextData(event: SessionEvent, fields: Map<string, unknown>): void {
  if (fields.has("parentToolCallId") && typeof fields.get("parentToolCallId") !== "string") throw new Error("Malformed Copilot parent invocation identity");
  if (event.type === "tool.execution_complete" && typeof event.data.success !== "boolean") throw new Error("Malformed Copilot tool result outcome");
  if (event.type === "session.usage_info" && (![event.data.tokenLimit, event.data.currentTokens].every((number) => Number.isFinite(number) && number >= 0))) throw new Error("Malformed Copilot context usage");
}
function validateUsageData(event: SessionEvent, fields: Map<string, unknown>): void {
  if (event.type === "assistant.usage") {
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"]) {
      const value = fields.get(key);
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Malformed Copilot usage totals");
    }
  }
}
