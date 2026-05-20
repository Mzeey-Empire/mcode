/**
 * Maps Cursor `cursor/task` ACP ext payloads to Mcode `Agent` tool events.
 *
 * Live ACP capture shows subagent delegations use `tool_call` markers with
 * `rawInput._toolName === "task"` and `title: "Task: Subagent task"`, while
 * the real description/prompt/model arrive on `cursor/task` after completion.
 */

import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import type { CursorAcpTurnState } from "./cursor-acp-event-mapper.js";

/** Metadata cached between `cursor/task` and the matching `tool_call_update`. */
export interface CursorTaskMeta {
  toolCallId: string;
  description: string;
  prompt: string;
  model?: string;
  agentId?: string;
  durationMs?: number;
}

/**
 * Returns true when an ACP `tool_call` is Cursor's internal Task / subagent tool.
 */
export function isCursorTaskAcpTool(
  rawInput: Record<string, unknown> | undefined,
  title: string | null | undefined,
): boolean {
  if (rawInput && typeof rawInput._toolName === "string" && rawInput._toolName === "task") {
    return true;
  }
  const t = (title ?? "").trim();
  if (/^task:/i.test(t)) return true;
  if (/subagent/i.test(t)) return true;
  return false;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Builds {@link AgentEvent} values from a `cursor/task` ext method/request payload.
 *
 * @param threadId - Mcode thread id.
 * @param params - Cursor `cursor/task` JSON params.
 * @param state - Active ACP turn state (caches meta for ToolResult on completion).
 */
export function cursorTaskExtToAgentEvents(
  threadId: string,
  params: Record<string, unknown>,
  state: CursorAcpTurnState,
): AgentEvent[] {
  const toolCallId = stringField(params, "toolCallId");
  if (!toolCallId) return [];

  const description = stringField(params, "description") ?? "Subagent task";
  const prompt = stringField(params, "prompt") ?? "";
  const model = stringField(params, "model");
  const agentId = stringField(params, "agentId");
  const durationMs =
    typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
      ? params.durationMs
      : undefined;

  const meta: CursorTaskMeta = {
    toolCallId,
    description,
    prompt,
    model,
    agentId,
    durationMs,
  };
  state.taskMetaByCallId.set(toolCallId, meta);
  state.toolNameByCallId.set(toolCallId, "Agent");
  state.suppressedToolCallIds.add(toolCallId);
  state.pendingTaskToolCallIds.add(toolCallId);

  const acc = state.accumulator;
  acc.toolStartTimes.set(toolCallId, Date.now());
  acc.pendingToolCalls.add(toolCallId);
  acc.hasFiredToolThisTurn = true;

  const toolInput: Record<string, unknown> = {
    description,
    prompt,
  };
  if (model) toolInput.model = model;
  if (agentId) toolInput.agentId = agentId;
  if (params.subagentType !== undefined) toolInput.subagentType = params.subagentType;

  const events: AgentEvent[] = [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId,
      toolName: "Agent",
      toolInput,
    },
  ];

  if (state.taskCompletedAwaitingMeta.has(toolCallId)) {
    state.taskCompletedAwaitingMeta.delete(toolCallId);
    events.push(
      ...cursorTaskCompletionToAgentEvents(threadId, toolCallId, state, false),
    );
  }

  return events;
}

/**
 * Emits {@link AgentEventType.ToolResult} when a suppressed Task tool_call completes.
 *
 * @param threadId - Mcode thread id.
 * @param toolCallId - ACP tool call id.
 * @param state - Turn state with cached {@link CursorTaskMeta}.
 * @param isError - Whether ACP reported `failed`.
 */
export function cursorTaskCompletionToAgentEvents(
  threadId: string,
  toolCallId: string,
  state: CursorAcpTurnState,
  isError: boolean,
): AgentEvent[] {
  if (!state.pendingTaskToolCallIds.has(toolCallId)) return [];

  const meta = state.taskMetaByCallId.get(toolCallId);
  state.pendingTaskToolCallIds.delete(toolCallId);
  state.taskMetaByCallId.delete(toolCallId);
  state.suppressedToolCallIds.delete(toolCallId);
  state.toolNameByCallId.delete(toolCallId);

  const acc = state.accumulator;
  acc.toolStartTimes.delete(toolCallId);
  acc.pendingToolCalls.delete(toolCallId);

  const lines: string[] = [];
  if (meta?.description) lines.push(meta.description);
  if (meta?.durationMs != null) lines.push(`Completed in ${(meta.durationMs / 1000).toFixed(1)}s`);
  if (meta?.model) lines.push(`Model: ${meta.model}`);

  return [
    {
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId,
      output: lines.length > 0 ? lines.join("\n") : "Subagent finished",
      isError,
    },
  ];
}
