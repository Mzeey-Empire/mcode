import type { SessionEvent } from "@github/copilot-sdk";
import type { AgentEvent } from "@mcode/contracts";
import { z } from "zod";
import { normalizeQuotaSnapshots } from "./copilot-helpers.js";

/** Per-turn protocol state, stored with the runtime-owned native session. */
export interface CopilotTurnState {
  outcome?: "completed" | "cancelled" | "failed";
  nativeIdleObserved: boolean;
  assistantText?: { messageId: string; content: string };
  pendingAssistantMessage?: Extract<SessionEvent, { type: "assistant.message" }>;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  contextWindow?: number;
  tools: Map<string, { name: string; startedAt: number }>;
  pendingPermissions: Map<string, { request: import("@mcode/contracts").ApprovalRequestEnvelope & { body: import("@mcode/contracts").ApprovalRequestBody }; resolve: (result: import("@github/copilot-sdk").PermissionRequestResult) => void }>;
  settle: (outcome: "completed" | "cancelled" | "failed", error?: Error) => void;
  completed: Promise<void>;
  abortTask?: Promise<void>;
}

/** Maps native evidence without treating chronological predecessors as child lineage. */
export function mapCopilotEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  validateEnvelope(event);
  validateData(event);
  if ("parentToolCallId" in event.data && typeof event.data.parentToolCallId === "string") return [{ type: "system", threadId, subtype: `copilot_child:${event.type}` }];
  return mapAssistantEvent(event, threadId, turn) ?? mapToolEvent(event, threadId, turn) ?? mapUsageEvent(event, threadId, turn) ?? mapCompactionEvent(event, threadId) ?? mapLifecycleEvent(event, threadId, turn) ?? [{ type: "system", threadId, subtype: `copilot_native:${event.type}` }];
}

function mapAssistantEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): AgentEvent[] | undefined {
  switch (event.type) {
    case "assistant.turn_start": return [...resetAssistantText(turn, threadId), { type: "system", threadId, subtype: `copilot_native:${event.type}` }];
    case "assistant.message_delta": {
      const events = beginAssistantText(turn, threadId, event.data.messageId);
      turn.assistantText!.content += event.data.deltaContent;
      return [...events, { type: "textDelta", threadId, delta: event.data.deltaContent }];
    }
    case "assistant.message": return deferAssistantMessage(event, threadId, turn);
    default: return undefined;
  }
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
  if (event.data.phase === "thinking" || !event.data.content) return [];
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
function mapToolEvent(event: SessionEvent, threadId: string, turn: CopilotTurnState): AgentEvent[] | undefined {
  switch (event.type) {
    case "tool.execution_start":
      if (turn.tools.size >= 1_024) throw new Error("Copilot tool index overflowed");
      turn.tools.set(event.data.toolCallId, { name: event.data.toolName, startedAt: Date.parse(event.timestamp) });
      return [{ type: "toolUse", threadId, toolCallId: event.data.toolCallId, toolName: event.data.toolName, toolInput: event.data.arguments ?? {} }];
    case "tool.execution_complete": return completeTool(event, threadId, turn);
    case "tool.execution_progress": return toolProgress(event, threadId, turn);
    default: return undefined;
  }
}
function completeTool(event: Extract<SessionEvent, { type: "tool.execution_complete" }>, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  turn.tools.delete(event.data.toolCallId);
  return [{ type: "toolResult", threadId, toolCallId: event.data.toolCallId, output: event.data.result?.detailedContent ?? event.data.result?.content ?? event.data.error?.message ?? "", isError: !event.data.success }];
}
function toolProgress(event: Extract<SessionEvent, { type: "tool.execution_progress" }>, threadId: string, turn: CopilotTurnState): AgentEvent[] {
  const tool = turn.tools.get(event.data.toolCallId);
  const at = Date.parse(event.timestamp);
  return [{ type: "toolProgress", threadId, toolCallId: event.data.toolCallId, toolName: tool?.name ?? "", elapsedSeconds: Math.max(0, (at - (tool?.startedAt ?? at)) / 1_000) }];
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
      return [...finishAssistantText(turn, threadId), { type: "error", threadId, error: event.data.message }];
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
function validateOptionalData(event: SessionEvent): void {
  if (event.type === "tool.execution_start" && !toolArgumentsSchema.safeParse(event.data.arguments).success) throw new Error("Malformed Copilot tool arguments");
  if (event.type === "tool.execution_complete" && (!toolResultSchema.safeParse(event.data.result).success || !nativeErrorSchema.safeParse(event.data.error).success)) throw new Error("Malformed Copilot tool output");
  if (event.type === "session.idle" && !idleDataSchema.safeParse(event.data).success) throw new Error("Malformed Copilot idle outcome");
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
