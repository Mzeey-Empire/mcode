/**
 * @internal
 * Summarizes Claude SDK stream messages for the diagnostics recording without their text.
 */
import type { EventPayload } from "@mcode/shared/diagnostics";

type ClaudeStreamSummary = EventPayload<"claude.stream">;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const event = asRecord(message.event);
  const started = asRecord(event?.content_block);
  if (message.type === "stream_event") return started ? [started] : [];
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const record = asRecord(block);
    return record ? [record] : [];
  });
}

function toolCalls(blocks: readonly Record<string, unknown>[]): ClaudeStreamSummary["tools"] {
  const calls = blocks.flatMap((block) => {
    if (block.type !== "tool_use" || typeof block.name !== "string" || typeof block.id !== "string") return [];
    return [{ name: block.name, id: block.id }];
  });
  return calls.length > 0 ? calls : undefined;
}

function toolResults(blocks: readonly Record<string, unknown>[]): ClaudeStreamSummary["results"] {
  const results = blocks.flatMap((block) => {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return [];
    return [{ id: block.tool_use_id, isError: block.is_error === true }];
  });
  return results.length > 0 ? results : undefined;
}

function streamEventType(message: Record<string, unknown>): string | undefined {
  if (message.type !== "stream_event") return undefined;
  const type = asRecord(message.event)?.type;
  return type === undefined ? undefined : String(type);
}

function stringField(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(message: Record<string, unknown>, key: string): boolean | undefined {
  const value = message[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Keep what places a message in the turn: its kind, the sub-agent it belongs to, and the tool
 * calls it starts or finishes, using ids, enum values, and flags only. Text, tool input,
 * and tool output stay out of the recording.
 */
export function summarizeClaudeStreamMessage(message: Record<string, unknown>): ClaudeStreamSummary {
  const blocks = contentBlocks(message);
  const parent = message.parent_tool_use_id;
  return {
    type: String(message.type ?? ""),
    subtype: typeof message.subtype === "string" ? message.subtype : undefined,
    eventType: streamEventType(message),
    uuid: stringField(message, "uuid"),
    taskId: stringField(message, "task_id"),
    toolUseId: stringField(message, "tool_use_id"),
    status: stringField(message, "status"),
    state: stringField(message, "state"),
    phase: stringField(message, "phase"),
    terminalReason: stringField(message, "terminal_reason"),
    stopReason: stringField(message, "stop_reason"),
    isError: booleanField(message, "is_error"),
    aborted: booleanField(message, "aborted"),
    parent: typeof parent === "string" ? parent : undefined,
    tools: toolCalls(blocks),
    results: toolResults(blocks),
  };
}
