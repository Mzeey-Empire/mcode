/**
 * Maps Cursor ACP `session/update` notifications into {@link AgentEvent} objects.
 *
 * Cursor adds fields over time; unknown shapes are debug-logged and ignored so
 * future tasks can observe and map them without breaking the stream.
 */

import { randomUUID } from "node:crypto";
import { AgentEventType } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { AgentEvent } from "@mcode/contracts";

/** Safely extract a string field from an untyped record. */
function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/** Accumulates streamed state during a single prompt turn. */
export interface CursorStreamAccumulator {
  /** Full assistant text observed during the prompt. */
  assistantText: string;
  /** Wall-clock start times for tool progress elapsed calculation. */
  toolStartTimes: Map<string, number>;
}

/** sessionUpdate types we handle; everything else gets debug-logged. */
const HANDLED_SESSION_UPDATES = new Set([
  "agent_message_chunk",
  "tool_start",
  "tool_end",
  "tool_progress",
  // Alternative names Cursor may use (aliases of the above)
  "agent_action_start",
  "agent_action_end",
  "agent_action_progress",
]);

/**
 * Maps a single JSON-RPC notification line object into zero or more agent events.
 *
 * @param notification - Parsed JSON-RPC notification object (`method` + optional `params`).
 * @param threadId - Mcode thread id (`mcode-…` prefix stripped by caller).
 * @param acc - Running accumulator for assistant message text across chunks.
 */
export function mapCursorAcpNotification(
  notification: Record<string, unknown>,
  threadId: string,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  const method = typeof notification.method === "string" ? notification.method : "";
  const params = notification.params as Record<string, unknown> | undefined;

  // cursor/update_todos: Cursor pushes its internal todo list.
  // Synthesize a TodoWrite ToolUse + ToolResult pair so the existing
  // threadStore interception populates the task panel automatically.
  if (method === "cursor/update_todos" && params) {
    const todos = params.todos as Array<Record<string, unknown>> | undefined;
    if (todos && Array.isArray(todos)) {
      const toolCallId = `cursor-todo-${randomUUID()}`;
      return [
        {
          type: AgentEventType.ToolUse,
          threadId,
          toolCallId,
          toolName: "TodoWrite",
          toolInput: { todos },
        },
        {
          type: AgentEventType.ToolResult,
          threadId,
          toolCallId,
          output: `Updated ${todos.length} todo(s)`,
          isError: false,
        },
      ];
    }
  }

  if (method !== "session/update") return [];

  const update = params?.update as Record<string, unknown> | undefined;
  if (!update) return [];

  const sessionUpdate = update.sessionUpdate as string | undefined;

  if (sessionUpdate === "agent_message_chunk") {
    const content = update.content as { text?: string } | undefined;
    const delta = typeof content?.text === "string" ? content.text : "";
    if (!delta) return [];
    acc.assistantText += delta;
    return [{ type: AgentEventType.TextDelta, threadId, delta }];
  }

  // Tool execution start: emit ToolUse
  if (
    sessionUpdate === "tool_start" ||
    sessionUpdate === "agent_action_start"
  ) {
    const toolCallId =
      stringField(update, "toolCallId") ??
      stringField(update, "actionId") ??
      `cursor-tc-${randomUUID()}`;
    const toolName =
      stringField(update, "toolName") ??
      stringField(update, "actionName") ??
      "cursor_tool";
    const toolInput =
      (update.toolInput as Record<string, unknown>) ??
      (update.parameters as Record<string, unknown>) ??
      {};

    acc.toolStartTimes.set(toolCallId, Date.now());

    return [
      {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName,
        toolInput,
      },
    ];
  }

  // Tool execution end: emit ToolResult
  if (
    sessionUpdate === "tool_end" ||
    sessionUpdate === "agent_action_end"
  ) {
    const toolCallId =
      stringField(update, "toolCallId") ??
      stringField(update, "actionId") ??
      "";
    const output =
      stringField(update, "output") ??
      stringField(update, "result") ??
      "";
    const isError =
      typeof update.isError === "boolean"
        ? update.isError
        : update.success === false;

    acc.toolStartTimes.delete(toolCallId);

    return [
      {
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output,
        isError: !!isError,
      },
    ];
  }

  // Tool progress heartbeat: emit ToolProgress
  if (
    sessionUpdate === "tool_progress" ||
    sessionUpdate === "agent_action_progress"
  ) {
    const toolCallId =
      stringField(update, "toolCallId") ??
      stringField(update, "actionId") ??
      "";
    const toolName =
      stringField(update, "toolName") ??
      stringField(update, "actionName") ??
      "";
    const startedAt = acc.toolStartTimes.get(toolCallId) ?? Date.now();
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    return [
      {
        type: AgentEventType.ToolProgress,
        threadId,
        toolCallId,
        toolName,
        elapsedSeconds,
      },
    ];
  }

  if (sessionUpdate && !HANDLED_SESSION_UPDATES.has(sessionUpdate)) {
    logger.debug("Cursor ACP unhandled sessionUpdate", {
      sessionUpdate,
      updateKeys: Object.keys(update).join(","),
      raw: JSON.stringify(update).slice(0, 2000),
    });
  }

  return [];
}
