/**
 * @internal
 * Summarizes Cursor ACP `session/update` traffic for troubleshooting without recording its content
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";

/**
 * Recording is on by default, so Cursor envelopes keep their shape and protocol state but no
 * message text, tool input, or tool output. Strings under these keys name protocol state.
 */
const VERBATIM_STRING_KEYS = new Set(["sessionUpdate", "toolCallId", "kind", "status", "type", "priority", "stopReason"]);
/** Arrays longer than this are summarized with `{ head, omitted }`. */
const MAX_TRACE_ARRAY_ITEMS = 40;
const MAX_SUMMARY_DEPTH = 8;

/**
 * Reduce an ACP payload to its structure: key names, array sizes, protocol state, and string lengths.
 *
 * @param value Arbitrary Cursor / ACP JSON shape.
 * @param key The property name `value` was read from, which decides whether a string is kept.
 */
export function sanitizeCursorTraceValue(value: unknown, depth = 0, key = ""): unknown {
  if (depth >= MAX_SUMMARY_DEPTH) return "[max-depth]";
  if (Array.isArray(value)) return sanitizeCursorTraceArray(value, depth);
  if (value !== null && typeof value === "object") return sanitizeCursorTraceRecord(value as Record<string, unknown>, depth);
  return sanitizeCursorTraceScalar(value, key);
}

function sanitizeCursorTraceScalar(value: unknown, key: string): unknown {
  if (typeof value === "string") return VERBATIM_STRING_KEYS.has(key) ? value : `[${value.length} chars]`;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  return typeof value;
}

function sanitizeCursorTraceArray(value: unknown[], depth: number): unknown {
  const head = value.slice(0, MAX_TRACE_ARRAY_ITEMS).map((item) => sanitizeCursorTraceValue(item, depth + 1));
  if (value.length <= MAX_TRACE_ARRAY_ITEMS) return head;
  return { head, omitted: value.length - MAX_TRACE_ARRAY_ITEMS };
}

function sanitizeCursorTraceRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) sanitized[key] = sanitizeCursorTraceValue(entry, depth + 1, key);
  return sanitized;
}

/**
 * Narrow `SessionNotification` to the fields most useful when comparing Cursor
 * output to `mapCursorAcpSessionNotification` emissions.
 *
 * @param notification Inbound Cursor ACP session notification envelope.
 */
export function summarizeCursorSessionNotification(
  notification: SessionNotification,
): Record<string, unknown> {
  return sanitizeCursorTraceValue({
    sessionId: notification.sessionId,
    update: notification.update,
  }) as Record<string, unknown>;
}

/**
 * One log line worth of shape per outbound `AgentEvent` after Cursor mapping.
 *
 * @param events Events already mapped for the websocket pipeline.
 */
export function summarizeEmittedAgentEventsForTrace(events: AgentEvent[]): Record<string, unknown>[] {
  return events.map(summarizeCursorTraceEvent);
}

const TRACE_EVENT_SUMMARIZERS: Record<string, (event: AgentEvent) => Record<string, unknown>> = {
  [AgentEventType.ToolUse]: summarizeTraceToolUse,
  [AgentEventType.ToolResult]: summarizeTraceToolResult,
  [AgentEventType.System]: summarizeTraceSystem,
  [AgentEventType.TextDelta]: summarizeTraceTextDelta,
  [AgentEventType.ReasoningDelta]: summarizeTraceReasoningDelta,
  [AgentEventType.ToolInputDelta]: summarizeTraceToolInputDelta,
  [AgentEventType.ToolProgress]: summarizeTraceToolProgress,
  [AgentEventType.Message]: summarizeTraceMessage,
  [AgentEventType.ContextEstimate]: summarizeTraceContextEstimate,
  [AgentEventType.CompactSummary]: summarizeTraceCompactSummary,
  [AgentEventType.TurnStarted]: summarizeTraceEventType,
  [AgentEventType.TurnComplete]: summarizeTraceEventType,
  [AgentEventType.Ended]: summarizeTraceEventType,
  [AgentEventType.Error]: summarizeTraceEventType,
  [AgentEventType.Compacting]: summarizeTraceEventType,
  [AgentEventType.ModelFallback]: summarizeTraceEventType,
  [AgentEventType.QuotaUpdate]: summarizeTraceEventType,
  [AgentEventType.ProviderUnavailable]: summarizeTraceEventType,
  [AgentEventType.RateLimited]: summarizeTraceEventType,
  [AgentEventType.ApiRetry]: summarizeTraceEventType,
  [AgentEventType.HookStarted]: summarizeTraceEventType,
  [AgentEventType.HookProgress]: summarizeTraceEventType,
  [AgentEventType.HookCompleted]: summarizeTraceEventType,
};

function summarizeCursorTraceEvent(event: AgentEvent): Record<string, unknown> {
  const summarize = TRACE_EVENT_SUMMARIZERS[event.type];
  return summarize ? summarize(event) : { type: event.type ?? "unknown" };
}

function summarizeTraceToolUse(event: AgentEvent): Record<string, unknown> {
  const toolUse = event as Extract<AgentEvent, { type: typeof AgentEventType.ToolUse }>;
  const toolInput = toolUse.toolInput ?? {};
  return { type: toolUse.type, toolCallId: toolUse.toolCallId, toolName: toolUse.toolName, parentToolCallId: toolUse.parentToolCallId, toolInputKeys: Object.keys(toolInput).slice(0, 48), toolInputSize: Object.keys(toolInput).length };
}

function summarizeTraceToolResult(event: AgentEvent): Record<string, unknown> {
  const toolResult = event as Extract<AgentEvent, { type: typeof AgentEventType.ToolResult }>;
  return { type: toolResult.type, toolCallId: toolResult.toolCallId, isError: toolResult.isError, outputChars: typeof toolResult.output === "string" ? toolResult.output.length : 0 };
}

function summarizeTraceSystem(event: AgentEvent): Record<string, unknown> {
  const system = event as Extract<AgentEvent, { type: typeof AgentEventType.System }>;
  return { type: system.type, subtype: system.subtype };
}

function summarizeTraceTextDelta(event: AgentEvent): Record<string, unknown> {
  const delta = event as Extract<AgentEvent, { type: typeof AgentEventType.TextDelta }>;
  return { type: delta.type, deltaChars: delta.delta?.length ?? 0 };
}

function summarizeTraceReasoningDelta(event: AgentEvent): Record<string, unknown> {
  return { type: event.type, deltaChars: event.type === AgentEventType.ReasoningDelta ? event.delta.length : 0 };
}

function summarizeTraceToolInputDelta(event: AgentEvent): Record<string, unknown> {
  const delta = event as Extract<AgentEvent, { type: typeof AgentEventType.ToolInputDelta }>;
  return { type: delta.type, partialChars: typeof delta.partialJson === "string" ? delta.partialJson.length : 0 };
}

function summarizeTraceToolProgress(event: AgentEvent): Record<string, unknown> {
  const progress = event as Extract<AgentEvent, { type: typeof AgentEventType.ToolProgress }>;
  return { type: progress.type, toolCallId: progress.toolCallId, toolName: progress.toolName, elapsedSeconds: progress.elapsedSeconds };
}

function summarizeTraceMessage(event: AgentEvent): Record<string, unknown> {
  const message = event as Extract<AgentEvent, { type: typeof AgentEventType.Message }>;
  return { type: message.type, contentChars: typeof message.content === "string" ? message.content.length : 0, tokens: message.tokens ?? null };
}

function summarizeTraceContextEstimate(event: AgentEvent): Record<string, unknown> {
  const estimate = event as Extract<AgentEvent, { type: typeof AgentEventType.ContextEstimate }>;
  return { type: estimate.type, tokensIn: estimate.tokensIn, contextWindow: estimate.contextWindow };
}

function summarizeTraceCompactSummary(event: AgentEvent): Record<string, unknown> {
  const summary = event as Extract<AgentEvent, { type: typeof AgentEventType.CompactSummary }>;
  return { type: summary.type, summaryChars: typeof summary.summary === "string" ? summary.summary.length : 0 };
}

function summarizeTraceEventType(event: AgentEvent): Record<string, unknown> {
  return { type: event.type };
}

/**
 * Decide whether tracing should persist for one inbound Cursor envelope.
 *
 * @param notification Handed straight from Cursor ACP.
 * @param emittedEventsCount Mapped event count (`mapCursorAcpSessionNotification` output length).
 */
export function shouldEmitCursorSessionTrace(
  notification: SessionNotification,
  emittedEventsCount: number,
): boolean {
  const kind = notification.update.sessionUpdate;
  if (kind === "agent_message_chunk") return false;
  if (emittedEventsCount > 0) return true;
  return (
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "plan" ||
    kind === "agent_thought_chunk"
  );
}
