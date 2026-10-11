import { ToolCallRecordSchema, type AgentEvent, type AgentItem, type ToolCallRecord } from "@mcode/contracts";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import type { CanonicalAgentEventDraft } from "./canonical-agent-boundary.js";
import { stepsSettledWith } from "../tools/background-held-tools.js";

/** Matches the preview bound the live narrative applies to ordinary tool output. */
const LATE_OUTPUT_LIMIT = 500;

/** The final outcome of a background tool call, reported after its turn ended. */
export interface LateToolResult {
  readonly toolCallId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly output: string;
}

/** Read the accepted record from either the bound or the still-recovering item shape. */
export function acceptedToolRecord(item: AgentItem): ToolCallRecord {
  const record = toolItemRecord(item);
  if (!record) throw new Error("Late tool result requires an accepted tool call");
  return record;
}

/** The accepted record of a tool item, or undefined for any other item. */
function toolItemRecord(item: AgentItem): ToolCallRecord | undefined {
  const payload = item.payload;
  const narrative = payload.projection === "narrativeRecovery" ? payload.narrative : undefined;
  const raw = payload.projection === "toolCall" ? payload.record : toolNarrativeRecord(narrative);
  return raw === undefined ? undefined : ToolCallRecordSchema().parse(raw);
}

function toolNarrativeRecord(narrative: unknown): unknown {
  if (typeof narrative !== "object" || narrative === null || !("kind" in narrative) || !("record" in narrative)) return undefined;
  return narrative.kind === "toolCall" ? narrative.record : undefined;
}

/**
 * Settle a held record. Returns null when the same outcome was already accepted, so a
 * repeated delivery is a no-op; a different outcome for a settled call is a conflict.
 */
export function settledLateToolRecord(
  record: ToolCallRecord,
  result: LateToolResult,
  messageId: string,
  completedAt: string,
): ToolCallRecord | null {
  const output = result.output.slice(0, LATE_OUTPUT_LIMIT);
  if (record.status !== "running") {
    if (record.status === result.status && record.output_summary === output) return null;
    throw new Error("Late tool result conflicts with the call's accepted outcome");
  }
  if (record.background !== true) throw new Error("Late tool result requires a background tool call");
  return { ...record, message_id: messageId, status: result.status, output_summary: output, completed_at: completedAt };
}

/** Re-record the settled item in its existing shape and publish the result to clients. */
export function lateToolResultEvents(input: {
  readonly item: AgentItem;
  readonly record: ToolCallRecord;
  readonly result: LateToolResult;
  readonly execution: ExecutionIdentity;
  readonly providerId: string;
  readonly publicationId: string;
}): CanonicalAgentEventDraft[] {
  const { item, record, execution, providerId, publicationId } = input;
  const operationId = `late-tool:${record.id}`;
  return [recordedToolItem(item, record, `${operationId}:record`, execution, providerId), {
    eventId: `${operationId}:publication`, routing: execution, sourceProviderId: providerId, sourceIdentities: [],
    payload: { type: "publication.recorded", publicationId, event: lateToolResultPublication(input) },
  }];
}

/**
 * Settle the running steps under a background call along with it. They outlived the turn
 * with the call, and once it ends no provider reports them again. Clients settle the same
 * steps from the call's own late result.
 */
export function lateToolStepEvents(input: {
  readonly turnItems: readonly AgentItem[];
  readonly record: ToolCallRecord;
  readonly execution: ExecutionIdentity;
  readonly providerId: string;
}): CanonicalAgentEventDraft[] {
  const { record, execution, providerId } = input;
  const tools = input.turnItems.flatMap((item) => {
    const tool = item.kind === "tool-call" ? toolItemRecord(item) : undefined;
    return tool ? [{ item, tool }] : [];
  });
  const steps = stepsSettledWith(tools.map(({ tool }) => ({
    id: tool.id, parentId: tool.parent_tool_call_id, background: tool.background === true })), record.id);
  return tools
    .filter(({ tool }) => steps.has(tool.id) && tool.status === "running")
    .map(({ item, tool }) => recordedToolItem(item, {
      ...tool, message_id: record.message_id, status: record.status, completed_at: record.completed_at,
    }, `late-tool:${record.id}:step:${tool.id}`, execution, providerId));
}

function recordedToolItem(
  item: AgentItem,
  record: ToolCallRecord,
  eventId: string,
  execution: ExecutionIdentity,
  providerId: string,
): CanonicalAgentEventDraft {
  const payload = item.payload.projection === "toolCall"
    ? { ...item.payload, record }
    : { ...item.payload, narrative: { kind: "toolCall", record } };
  return {
    eventId, routing: { ...execution, itemId: item.id }, sourceProviderId: providerId,
    sourceIdentities: [], payload: { type: "item.recorded",
      item: { ...item, payload, updatedAt: record.completed_at ?? item.updatedAt } },
  };
}

// The publication omits turnExecutionId: clients drop results whose execution differs
// from the live turn, and this one belongs to an earlier, finished turn. It carries the
// bounded summary so the live row matches what a reload shows.
function lateToolResultPublication(input: Parameters<typeof lateToolResultEvents>[0]): AgentEvent {
  const { record, result, execution, publicationId } = input;
  return { type: "toolResult", threadId: execution.threadId, toolCallId: record.id, output: record.output_summary,
    isError: result.status === "failed", ...(result.status === "cancelled" ? { cancelled: true } : {}),
    persistedMessageId: record.message_id, publicationId };
}
