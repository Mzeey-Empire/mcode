import {
  createSubagentPresentation, type ProviderId, type SubagentDetail, type SubagentRosterEntry,
  type SubagentStatus, type SubagentPresentation, type ToolCallRecord,
} from "@mcode/contracts";
import type { CreateToolCallRecordInput } from "../tools/persistence/tool-call-record-store.js";

/** Narrative evidence, retaining the provider and outcome of its owning message. */
export interface RosterToolCall extends CreateToolCallRecordInput {
  toolCallId: string;
  startedAt: string;
  provider: string | null;
  parentStopped: boolean;
  presentation?: SubagentPresentation;
}

/** Convert persisted narrative columns without reinterpreting provider identities. */
export function rosterToolCall(record: ToolCallRecord, provider: string | null, outcome: string | null): RosterToolCall {
  return {
    toolCallId: record.id, messageId: record.message_id, toolName: record.tool_name,
    parentToolCallId: record.parent_tool_call_id ?? undefined,
    displayName: record.display_name ?? undefined, inputSummary: record.input_summary,
    outputSummary: record.output_summary, status: record.status,
    startedAt: record.started_at, completedAt: record.completed_at ?? undefined,
    subagentPrompt: record.subagent_prompt ?? undefined,
    subagentType: record.subagent_type ?? undefined,
    model: record.model ?? undefined, reasoningEffort: record.reasoning_effort ?? undefined,
    sortOrder: record.sort_order, provider,
    parentStopped: outcome === "cancelled" || outcome === "interrupted",
    presentation: record.tool_name === "Agent" ? createSubagentPresentation({
      agentName: record.display_name, description: record.input_summary, prompt: record.subagent_prompt,
      model: record.model, reasoningEffort: record.reasoning_effort,
    }, record.id) : undefined,
  };
}

/** Normalize canonical and narrative outcomes at the server boundary. */
export function subagentStatusFrom(status: string | null, parentStopped = false): SubagentStatus {
  // Unrecognized persisted outcomes must not keep the active count stuck forever.
  const normalized = NORMALIZED_STATUS.get(status?.toLowerCase() ?? "") ?? "failed";
  return parentStopped && normalized !== "done" ? "stopped" : normalized;
}

const NORMALIZED_STATUS = new Map<string, SubagentStatus>([
  ["running", "running"], ["active", "running"],
  ["pending", "running"], ["starting", "running"],
  // Canonical children with no turn yet report their thread activity state instead.
  ["idle", "done"], ["closed", "stopped"], ["unavailable", "failed"],
  ["cancelled", "stopped"], ["interrupted", "stopped"], ["stopped", "stopped"],
  ["completed", "done"], ["done", "done"], ["success", "done"],
  ["errored", "failed"], ["error", "failed"], ["failed", "failed"],
]);

/** Find a root Agent through exact parent-call links, including old nested Devin markers. */
export function rootAgent<T extends { toolCallId?: string; toolName: string; parentToolCallId?: string }>(
  call: T, calls: ReadonlyMap<string | undefined, T>,
): T | undefined {
  let root = call.toolName === "Agent" ? call : undefined;
  let parentId = call.parentToolCallId;
  const visited = new Set([call.toolCallId]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = calls.get(parentId);
    if (!parent) break;
    if (parent.toolName === "Agent") root = parent;
    parentId = parent.parentToolCallId;
  }
  return root;
}

/** Project one narrative root using only its message identity and reported fields. */
export function narrativeRosterEntry(call: RosterToolCall, stepCount: number, provider: ProviderId, childSteps: boolean): SubagentRosterEntry {
  return {
    id: `call:${call.toolCallId}`, provider, ...narrativeMetadata(call),
    stepCount, status: subagentStatusFrom(call.status, call.parentStopped),
    startedAt: call.startedAt, endedAt: call.completedAt ?? null,
    tier: stepCount > 0 || childSteps ? "steps" : "meta", canStop: false,
    sourceToolCallId: call.toolCallId, childThreadId: null,
    sourceMessageId: call.messageId || null, parentEntryId: null,
  };
}

function narrativeMetadata(call: RosterToolCall) {
  const prompt = call.subagentPrompt ?? null;
  const title = (call.presentation?.task ?? prompt)?.split("\n")[0] || call.displayName || "Subagent task";
  return { title, prompt, subagentType: call.subagentType ?? null,
    model: subagentModelLabel(call.model, call.reasoningEffort) };
}

/** Combine the reported model and reasoning without inventing missing metadata. */
export function subagentModelLabel(model?: string, reasoning?: string): string | null {
  return [model, reasoning].filter(Boolean).join(" · ") || null;
}

/** Keep the latest activity while preserving its total count and summary. */
export function narrativeSubagentDetail(entryId: string, root: RosterToolCall, steps: readonly RosterToolCall[]): SubagentDetail {
  return {
    entryId, totalSteps: steps.length, summary: root.outputSummary || null,
    steps: steps.slice(-32).map((call) => ({
      toolCallId: call.toolCallId, toolName: call.toolName,
      label: call.displayName ?? (call.inputSummary || call.toolName),
      status: call.status === "running" ? "running" : call.status === "failed" ? "failed" : "done",
    })),
  };
}
