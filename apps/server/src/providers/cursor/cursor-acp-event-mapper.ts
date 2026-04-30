/**
 * Maps ACP `session/update` notifications to mcode {@link AgentEvent} values.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import {
  extractCursorTodoEntries,
  normalizeCursorTodoEntry,
  reconcileCursorTodos,
  type CursorTodoSnapshot,
} from "./cursor-todo-snapshot.js";
import type { CursorStreamAccumulator } from "./cursor-stream-event-mapper.js";

const TOOL_NAME_BY_DISCRIMINATOR: Record<string, string> = {
  readToolCall: "Read",
  writeToolCall: "Write",
  editToolCall: "Edit",
  shellToolCall: "Bash",
  grepToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "LS",
  deleteToolCall: "Delete",
  webSearchToolCall: "WebSearch",
  fetchToolCall: "WebFetch",
};

/**
 * Accumulator for streaming state during one ACP prompt turn on a thread.
 */
export interface CursorAcpTurnState {
  accumulator: CursorStreamAccumulator;
}

/** Creates a fresh per-turn state bundle (wraps shared stream accumulator shape). */
export function createCursorAcpTurnState(): CursorAcpTurnState {
  return {
    accumulator: {
      assistantText: "",
      toolStartTimes: new Map(),
      chatId: null,
    },
  };
}

/**
 * Converts a single `session/update` notification into zero or more agent events.
 *
 * @param notification - ACP session update (already scoped to the active session).
 * @param threadId - Mcode thread UUID.
 * @param state - Mutable per-turn state; reset by the provider at the start of each prompt.
 * @param todoSnapshot - Optional todo merge state for `updateTodosToolCall` parity with stream-json.
 */
export function mapCursorAcpSessionNotification(
  notification: SessionNotification,
  threadId: string,
  state: CursorAcpTurnState,
  todoSnapshot?: CursorTodoSnapshot,
): AgentEvent[] {
  const { update } = notification;
  const acc = state.accumulator;

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return mapAgentLanguageChunk(threadId, acc, update);
    case "user_message_chunk":
    case "plan":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      return [];
    case "tool_call":
      return mapAcpToolCallStarted(update, threadId, acc, todoSnapshot);
    case "tool_call_update":
      return mapAcpToolCallUpdated(update, threadId, acc);
    default:
      return [];
  }
}

/**
 * Normal assistant text uses `agent_message_chunk`, but Cursor streams some models
 * (e.g. composer) as `agent_thought_chunk` only. Map both so the UI receives TextDelta.
 */
function mapAgentLanguageChunk(
  threadId: string,
  acc: CursorStreamAccumulator,
  update:
    | (import("@agentclientprotocol/sdk").ContentChunk & {
        sessionUpdate: "agent_message_chunk";
      })
    | (import("@agentclientprotocol/sdk").ContentChunk & {
        sessionUpdate: "agent_thought_chunk";
      }),
): AgentEvent[] {
  if (update.content.type !== "text" || !update.content.text) return [];
  const text = update.content.text;
  acc.assistantText += text;
  return [{ type: AgentEventType.TextDelta, threadId, delta: text }];
}

function extractToolCallDiscriminator(toolCall: Record<string, unknown> | undefined): {
  discriminator: string | null;
  payload: Record<string, unknown> | undefined;
} {
  if (!toolCall || typeof toolCall !== "object") return { discriminator: null, payload: undefined };
  for (const key of Object.keys(toolCall)) {
    if (key === "result" || key === "args") continue;
    const v = toolCall[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { discriminator: key, payload: v as Record<string, unknown> };
    }
  }
  return { discriminator: null, payload: undefined };
}

function extractArgs(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const v = payload.args;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function extractResult(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const v = payload.result;
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatResultOutput(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  const body = result.success ?? result.rejected ?? result.failure;
  if (body == null) return safeStringify(result);
  if (typeof body === "string") return body;
  return safeStringify(body);
}

function coerceRawToolEnvelope(rawInput: unknown): {
  discriminator: string | null;
  payload: Record<string, unknown> | undefined;
} {
  if (rawInput !== undefined && typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)) {
    const rec = rawInput as Record<string, unknown>;
    const extracted = extractToolCallDiscriminator(rec);
    if (extracted.discriminator) return extracted;
    return { discriminator: null, payload: rec };
  }
  return { discriminator: null, payload: undefined };
}

function mapAcpToolCallStarted(
  update: {
    rawInput?: unknown;
    toolCallId: string;
    title: string;
  },
  threadId: string,
  acc: CursorStreamAccumulator,
  todoSnapshot: CursorTodoSnapshot | undefined,
): AgentEvent[] {
  const raw = coerceRawToolEnvelope(update.rawInput);
  if (raw.discriminator === "updateTodosToolCall") {
    const args = extractArgs(raw.payload);
    const entries = extractCursorTodoEntries(args);
    if (!entries || entries.length === 0) return [];
    const merge = args?.merge === true;
    const incoming = entries.map((entry, index) => normalizeCursorTodoEntry(entry, index));
    const todos = reconcileCursorTodos(incoming, merge, todoSnapshot);
    acc.toolStartTimes.set(update.toolCallId, Date.now());
    return [
      {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId: update.toolCallId,
        toolName: "TodoWrite",
        toolInput: { todos },
      },
    ];
  }

  const toolName = raw.discriminator
    ? (TOOL_NAME_BY_DISCRIMINATOR[raw.discriminator] ?? raw.discriminator)
    : update.title || "Tool";
  const args = extractArgs(raw.payload);
  acc.toolStartTimes.set(update.toolCallId, Date.now());
  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId: update.toolCallId,
      toolName,
      toolInput: args ?? (update.rawInput as Record<string, unknown>) ?? {},
    },
  ];
}

function mapAcpToolCallUpdated(
  update: {
    rawInput?: unknown;
    rawOutput?: unknown;
    status?: unknown;
    toolCallId: string;
    title?: string | null;
  },
  threadId: string,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  const raw = coerceRawToolEnvelope(update.rawInput);
  const discriminator = raw.discriminator;
  const payload = raw.payload;

  let isError = update.status === "failed";

  const resultEnvelope =
    extractResult(payload) ??
    (update.rawOutput !== undefined && typeof update.rawOutput === "object" && update.rawOutput !== null
      ? (update.rawOutput as Record<string, unknown>)
      : typeof update.rawOutput === "string"
        ? ({ success: update.rawOutput } as Record<string, unknown>)
        : undefined);

  if (resultEnvelope) {
    isError = isError || resultEnvelope.rejected != null || resultEnvelope.failure != null;
  }

  const output =
    typeof update.rawOutput === "string"
      ? update.rawOutput
      : formatResultOutput(resultEnvelope);

  const events: AgentEvent[] = [];

  if (!acc.toolStartTimes.has(update.toolCallId)) {
    const toolName =
      discriminator != null ? (TOOL_NAME_BY_DISCRIMINATOR[discriminator] ?? discriminator) : update.title ?? "Tool";
    if (discriminator !== "updateTodosToolCall") {
      events.push({
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId: update.toolCallId,
        toolName,
        toolInput: extractArgs(payload) ?? {},
      });
    }
  }

  acc.toolStartTimes.delete(update.toolCallId);

  events.push({
    type: AgentEventType.ToolResult,
    threadId,
    toolCallId: update.toolCallId,
    output: output || (discriminator === "updateTodosToolCall" ? "Updated todos" : ""),
    isError,
  });
  return events;
}
