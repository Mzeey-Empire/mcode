/**
 */

import { redactDiagnostic } from "@mcode/shared/diagnostics";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";

function previewText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function previewDiagnostic(s: string): string {
  return previewText(redactDiagnostic(s), 256);
}

/** Pulls correlation ids from notification params when present (Codex app-server payloads). */
function traceCorrelationIds(
  params: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!params || typeof params !== "object") return {};
  const out: Record<string, string> = {};
  for (const key of ["threadId", "turnId", "itemId"] as const) {
    const v = params[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

/**
 * Builds a compact, log-safe summary of codex JSON-RPC notification params
 * (no full prompts or command bodies).
 */
export function summarizeCodexNotificationParams(
  method: string,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const ids = traceCorrelationIds(params);
  if (!params || typeof params !== "object") return { ...ids, paramKeys: [] };
  const summarize = CODEX_NOTIFICATION_SUMMARIZERS[method];
  if (summarize) return summarize(params, ids);
  return { ...ids, paramKeys: Object.keys(params).filter((key) => key !== "item").slice(0, 20) };
}

type CodexNotificationSummary = (params: Record<string, unknown>, ids: Record<string, string>) => Record<string, unknown>;

const CODEX_NOTIFICATION_SUMMARIZERS: Record<string, CodexNotificationSummary> = {
  "item/completed": summarizeCompletedCodexItem,
  "item/reasoning/textDelta": summarizeCodexDelta,
  "item/reasoning/summaryTextDelta": summarizeCodexDelta,
  "item/plan/delta": summarizeCodexDelta,
  "item/agentMessage/delta": summarizeCodexDelta,
  "item/started": summarizeStartedCodexItem,
  "turn/completed": summarizeCodexTurn,
  "turn/started": summarizeCodexTurn,
  "mcpServer/startupStatus/updated": summarizeCodexMcpStartup,
};

function summarizeCompletedCodexItem(
  params: Record<string, unknown>,
  ids: Record<string, string>,
): Record<string, unknown> {
  const item = asCodexTraceRecord(params.item);
  return { ...ids, itemType: codexTraceString(item?.type), itemId: codexTraceString(item?.id), toolKind: codexTraceString(item?.toolKind) ?? codexTraceString(item?.tool_kind), functionName: codexTraceString(item?.name) };
}

function summarizeCodexDelta(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const delta = codexTraceString(params.delta) ?? codexTraceString(params.text) ?? "";
  return { ...ids, deltaLen: delta.length };
}

function summarizeStartedCodexItem(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const item = asCodexTraceRecord(params.item);
  return { ...ids, itemType: codexTraceString(item?.type), itemId: codexTraceString(item?.id) };
}

function summarizeCodexTurn(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const turn = asCodexTraceRecord(params.turn);
  return { ...ids, turnId: codexTraceString(turn?.id), status: codexTraceString(turn?.status) };
}

function summarizeCodexMcpStartup(params: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const error = codexTraceString(params.error);
  const failureReason = codexTraceString(params.failureReason);
  return { ...ids, name: codexTraceString(params.name), status: codexTraceString(params.status), errorPreview: error ? previewDiagnostic(error) : undefined, failureReasonPreview: failureReason ? previewDiagnostic(failureReason) : undefined };
}

function asCodexTraceRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function codexTraceString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Maps emitted `AgentEvent` objects to compact trace records (ToolUse parent ids, delta flags).
 */
export function summarizeAgentEventsForTrace(events: readonly AgentEvent[]): Record<string, unknown>[] {
  return events.map((e) => {
    switch (e.type) {
      case AgentEventType.TextDelta:
        return {
          type: "textDelta",
          isFinalResponse: e.isFinalResponse === true,
          len: e.delta.length,
        };
      case AgentEventType.ReasoningDelta:
        return { type: "reasoningDelta", reasoningItemId: e.reasoningItemId, done: e.done === true, len: e.delta.length };
      case AgentEventType.ToolUse:
        return {
          type: "toolUse",
          toolName: e.toolName,
          toolCallId: e.toolCallId,
          parentToolCallId: e.parentToolCallId,
          toolInputKeys: Object.keys(e.toolInput ?? {}).slice(0, 12),
        };
      case AgentEventType.ToolResult:
        return {
          type: "toolResult",
          toolCallId: e.toolCallId,
          isError: e.isError,
          outputLen: e.output.length,
        };
      case AgentEventType.Message:
        return {
          type: "message",
          contentLen: e.content.length,
        };
      case AgentEventType.TurnComplete:
        return { type: "turnComplete", tokensIn: e.tokensIn, tokensOut: e.tokensOut };
      case AgentEventType.Error:
        return { type: "error", errorLen: e.error.length };
      default:
        return { type: e.type };
    }
  });
}
