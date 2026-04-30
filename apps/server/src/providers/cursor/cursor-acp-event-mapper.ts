/**
 * Maps Cursor ACP `session/update` notifications into {@link AgentEvent} objects.
 *
 * Cursor's `cursor-agent acp` subprocess speaks the Zed/ACP canonical protocol:
 * `tool_call` and `tool_call_update` for tool execution, `plan` for todo lists,
 * and `agent_message_chunk` carrying a single `ContentBlock` per chunk. An
 * earlier iteration of this mapper assumed Cursor-specific names
 * (`tool_start` / `tool_end` / `cursor/update_todos`) which Cursor never emits;
 * the result was tool calls and todo lists silently dropping while their text
 * content leaked into the streaming reasoning panel via `content.text`.
 *
 * Unknown sessionUpdate kinds are info-logged (not debug — global level is
 * "info") so future variants are observable without recompiling.
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

/**
 * Extracts visible text from an ACP `ContentBlock` (or a defensive array of
 * blocks). Non-text blocks (image, audio, resource_link, resource) yield "".
 */
function extractContentBlockText(content: unknown): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content.map((b) => extractContentBlockText(b)).join("");
  }
  if (typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  // Defensive fallback for legacy `{ text: "..." }` payloads observed in the
  // wild that omit the explicit type discriminator.
  if (c.type == null && typeof c.text === "string") return c.text;
  return "";
}

/**
 * Concatenates text out of an ACP `ToolCallContent[]` array. Diff and terminal
 * blocks are rendered as compact human-readable summaries so the resulting
 * `ToolResult.output` carries something meaningful for any tool kind.
 */
function extractToolCallContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "content") {
      const text = extractContentBlockText(b.content);
      if (text) parts.push(text);
    } else if (b.type === "diff") {
      const path = stringField(b, "path") ?? "";
      const oldText = stringField(b, "oldText") ?? "";
      const newText = stringField(b, "newText") ?? "";
      parts.push(`Diff: ${path}\n--- old\n${oldText}\n+++ new\n${newText}`);
    } else if (b.type === "terminal") {
      const terminalId = stringField(b, "terminalId") ?? "";
      parts.push(`Terminal: ${terminalId}`);
    }
  }
  return parts.join("\n");
}

/** Stringify a `rawOutput` payload for ToolResult.output, preferring strings. */
function stringifyRawOutput(rawOutput: unknown): string {
  if (rawOutput == null) return "";
  if (typeof rawOutput === "string") return rawOutput;
  try {
    return JSON.stringify(rawOutput);
  } catch {
    return String(rawOutput);
  }
}

/** Coerce ACP plan entry status to TodoWrite-compatible status. */
function coercePlanStatus(s: unknown): "pending" | "in_progress" | "completed" {
  if (s === "in_progress") return "in_progress";
  if (s === "completed") return "completed";
  return "pending";
}

/** Accumulates streamed state during a single prompt turn. */
export interface CursorStreamAccumulator {
  /** Full assistant text observed during the prompt. */
  assistantText: string;
  /**
   * Wall-clock start times for ToolProgress elapsed calculation. Presence of
   * a key also signals that a `ToolUse` has already been emitted for that id,
   * so a later `tool_call_update` does not need to synthesize a fresh one.
   */
  toolStartTimes: Map<string, number>;
}

/** sessionUpdate types we deliberately handle (or no-op on); rest get logged. */
const HANDLED_SESSION_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  // Cursor-specific informational notifications. We deliberately ignore them
  // (no UI surface yet) but they're frequent enough that letting them fall
  // through to the unhandled-info log spams `mcode.log`.
  "available_commands_update",
  "session_info_update",
]);

/** ACP tool-call statuses that should produce a ToolResult. */
const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"]);

/**
 * Maps a single JSON-RPC notification line object into zero or more agent events.
 *
 * @param notification - Parsed JSON-RPC notification object (`method` + optional `params`).
 * @param threadId - Mcode thread id (`mcode-…` prefix stripped by caller).
 * @param acc - Running accumulator for assistant message text and tool start times.
 */
export function mapCursorAcpNotification(
  notification: Record<string, unknown>,
  threadId: string,
  acc: CursorStreamAccumulator,
): AgentEvent[] {
  const method = typeof notification.method === "string" ? notification.method : "";
  const params = notification.params as Record<string, unknown> | undefined;

  // cursor/task: status update for a running cursor task.
  if (method === "cursor/task" && params) {
    const status = stringField(params, "status") ?? "unknown";
    return [
      {
        type: AgentEventType.System,
        threadId,
        subtype: `cursor_task:${status}`,
      },
    ];
  }

  if (method !== "session/update") return [];

  const update = params?.update as Record<string, unknown> | undefined;
  if (!update) return [];

  const sessionUpdate = update.sessionUpdate as string | undefined;

  // ── Streaming assistant text ─────────────────────────────────────────────
  if (sessionUpdate === "agent_message_chunk") {
    const delta = extractContentBlockText(update.content);
    if (!delta) return [];
    acc.assistantText += delta;
    return [{ type: AgentEventType.TextDelta, threadId, delta }];
  }

  // Reasoning / thought chunks. Dropped for now: there is no first-class
  // reasoning event yet, and emitting these as TextDelta would corrupt the
  // assistant message body. Future work: add a dedicated reasoning channel.
  if (sessionUpdate === "agent_thought_chunk") return [];

  // Echo of the user message — uninteresting, the UI already has it.
  if (sessionUpdate === "user_message_chunk") return [];

  // ── Tool execution (canonical ACP names) ─────────────────────────────────
  if (sessionUpdate === "tool_call") {
    const toolCallId = stringField(update, "toolCallId");
    if (!toolCallId) {
      logger.info("Cursor ACP tool_call missing toolCallId", { update });
      return [];
    }

    const title = stringField(update, "title") ?? "";
    const kind = stringField(update, "kind") ?? "";
    const toolName = title || kind || "cursor_tool";

    const rawInput = update.rawInput;
    const toolInput: Record<string, unknown> =
      rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : title
          ? { title }
          : {};

    acc.toolStartTimes.set(toolCallId, Date.now());

    const events: AgentEvent[] = [
      {
        type: AgentEventType.ToolUse,
        threadId,
        toolCallId,
        toolName,
        toolInput,
      },
    ];

    // Cursor sometimes ships a tool_call already in a terminal state — emit
    // the matching ToolResult inline so the UI doesn't show a stuck spinner.
    const status = stringField(update, "status");
    if (status && TERMINAL_TOOL_STATUSES.has(status)) {
      const output =
        extractToolCallContentText(update.content) ||
        stringifyRawOutput(update.rawOutput);
      acc.toolStartTimes.delete(toolCallId);
      events.push({
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output,
        isError: status === "failed",
      });
    }

    return events;
  }

  if (sessionUpdate === "tool_call_update") {
    const toolCallId = stringField(update, "toolCallId");
    if (!toolCallId) {
      logger.info("Cursor ACP tool_call_update missing toolCallId", { update });
      return [];
    }

    const status = stringField(update, "status");

    if (status && TERMINAL_TOOL_STATUSES.has(status)) {
      const output =
        extractToolCallContentText(update.content) ||
        stringifyRawOutput(update.rawOutput);

      const events: AgentEvent[] = [];

      // If the agent skipped the initial `tool_call` (or it arrived in a
      // separate batch we missed), synthesize a ToolUse so the result has
      // something to anchor to. Better than dropping the result entirely.
      if (!acc.toolStartTimes.has(toolCallId)) {
        const title = stringField(update, "title") ?? "";
        const kind = stringField(update, "kind") ?? "";
        const toolName = title || kind || "cursor_tool";
        events.push({
          type: AgentEventType.ToolUse,
          threadId,
          toolCallId,
          toolName,
          toolInput: {},
        });
      }

      acc.toolStartTimes.delete(toolCallId);
      events.push({
        type: AgentEventType.ToolResult,
        threadId,
        toolCallId,
        output,
        isError: status === "failed",
      });
      return events;
    }

    // Non-terminal update → ToolProgress heartbeat. Skip when we never saw
    // the matching tool_call: elapsedSeconds would be a misleading 0.
    const startedAt = acc.toolStartTimes.get(toolCallId);
    if (startedAt == null) {
      logger.info("Cursor ACP tool_call_update for unknown toolCallId", {
        toolCallId,
        status,
      });
      return [];
    }
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const toolName =
      stringField(update, "title") ?? stringField(update, "kind") ?? "";
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

  // ── Plan / todo list ─────────────────────────────────────────────────────
  // ACP `plan` updates carry the entire current plan, not a delta. Synthesize
  // a TodoWrite ToolUse + ToolResult pair so the existing threadStore
  // interception (which keys on toolName === "TodoWrite") populates the
  // task panel without further integration work.
  if (sessionUpdate === "plan") {
    const entries = update.entries as Array<Record<string, unknown>> | undefined;
    if (!entries || !Array.isArray(entries)) return [];

    const todos = entries.map((entry, index) => ({
      id: stringField(entry, "id") ?? String(index + 1),
      content: stringField(entry, "content") ?? "",
      status: coercePlanStatus(entry.status),
      priority: stringField(entry, "priority"),
    }));

    const toolCallId = `cursor-plan-${randomUUID()}`;
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

  if (sessionUpdate && !HANDLED_SESSION_UPDATES.has(sessionUpdate)) {
    // Promoted from debug → info during the canonical-name rollout: global
    // log level is "info" so debug calls are silently dropped, leaving us
    // blind to any sessionUpdate variants we haven't mapped yet.
    logger.info("Cursor ACP unhandled sessionUpdate", {
      sessionUpdate,
      updateKeys: Object.keys(update).join(","),
      raw: JSON.stringify(update).slice(0, 2000),
    });
  }

  return [];
}
