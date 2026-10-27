import { createSubagentPresentation, type SubagentPresentation } from "@mcode/contracts/models/tool-call-record";
import { isDelegateTaskToolName, isSubagentLaunchToolName } from "@mcode/contracts/models/subagent-roster";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import type { NarrativeItem, NarrativeCounts, SubagentActivity } from "./types";

/**
 * Provisional sub-agent presentation for a launch call, or undefined for any other tool.
 * A delegate_task input carries routing fields (target, isolation) that are not Agent
 * metadata, so only its title and prompt reach the shared Agent parser.
 */
export function createSubagentLaunchPresentation(
  toolName: string,
  toolInput: Record<string, unknown>,
  fallbackIdentityKey: string,
): SubagentPresentation | undefined {
  if (!isSubagentLaunchToolName(toolName)) return undefined;
  if (!isDelegateTaskToolName(toolName)) return createSubagentPresentation(toolInput, fallbackIdentityKey);
  return createSubagentPresentation(
    { description: toolInput.title, prompt: toolInput.prompt ?? toolInput.task },
    fallbackIdentityKey,
  );
}

/**
 * True when a call launched a sub-agent. A delegate_task the server rejected created no child
 * thread, so once it fails it is an ordinary failed tool call. A native Agent that errored still ran.
 */
export function isSubagentLaunchCall(call: Pick<ToolCall, "toolName" | "isComplete" | "isError">): boolean {
  if (!isSubagentLaunchToolName(call.toolName)) return false;
  return !(isDelegateTaskToolName(call.toolName) && call.isComplete && call.isError);
}

/** Persisted-record form of {@link isSubagentLaunchCall}. */
export function isSubagentLaunchRecord(record: Pick<ToolCallRecord, "tool_name" | "status">): boolean {
  if (!isSubagentLaunchToolName(record.tool_name)) return false;
  return !(isDelegateTaskToolName(record.tool_name) && record.status === "failed");
}

/**
 * True while a call still holds its turn's work open. A backgrounded call keeps running on its own,
 * so the turn may answer and end around it; only its own row shows that it is still working.
 */
export function isTurnWorkRunning(toolCall: Pick<ToolCall, "isComplete" | "background">): boolean {
  return !toolCall.isComplete && toolCall.background !== true;
}

/** Top-level calls and direct children indexed by their authoritative parent id. */
export interface ToolCallHierarchy<T> {
  topLevel: T[];
  childrenByParent: Map<string, T[]>;
}

/** Splits calls into top-level calls and direct children without changing input order. */
export function buildToolCallHierarchy<T>(
  calls: readonly T[],
  parentIdForCall: (call: T) => string | null | undefined,
  emptyParentIsTopLevel: boolean,
): ToolCallHierarchy<T> {
  const topLevel: T[] = [];
  const childrenByParent = new Map<string, T[]>();

  for (const call of calls) {
    const parentId = parentIdForCall(call);
    if (parentId == null || (emptyParentIsTopLevel && parentId.length === 0)) {
      topLevel.push(call);
      continue;
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(call);
    childrenByParent.set(parentId, siblings);
  }

  return { topLevel, childrenByParent };
}

/** Builds a grouped row for one contiguous sequence of completed tool calls. */
export function createToolGroupItem(
  calls: readonly ToolCall[],
): Extract<NarrativeItem, { type: "tool-group" }> | undefined {
  if (calls.length === 0) return undefined;
  return {
    type: "tool-group",
    group: { calls: [...calls] },
    hasError: calls.some((call) => call.isError),
    hasCancelled: calls.some(isCancelledCall),
  };
}

/** Builds one sub-agent row from one or more contiguous sibling activities. */
export function createSubagentItem(
  activities: readonly SubagentActivity[],
): Extract<NarrativeItem, { type: "subagent" }> {
  const firstActivity = activities[0]!;
  return {
    type: "subagent",
    ...firstActivity,
    ...(activities.length > 1 ? { activities } : {}),
  };
}

/** Derives the top-level tool, thought-row, and delegated-agent totals. */
export function createNarrativeCounts(
  topLevelCalls: readonly ToolCall[],
  items: readonly NarrativeItem[],
): NarrativeCounts {
  return {
    steps: topLevelCalls.length,
    thoughts: items.filter((item) => item.type === "thought").length,
    subagents: topLevelCalls.filter(isSubagentLaunchCall).length,
  };
}

/** Legacy persisted calls carry no terminal status, so being incomplete alone does not mean cancelled. */
export function isCancelledCall(call: ToolCall): boolean {
  return call.isCancelled === true
    || (typeof call.output === "string" && call.output.toLowerCase().includes("cancelled"));
}
