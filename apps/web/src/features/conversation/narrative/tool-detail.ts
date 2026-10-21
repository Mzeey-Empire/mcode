import { resolveToolName } from "@/components/chat/tool-renderers/constants";
import type { ToolCall } from "@/transport/types";

/** Tools whose stored summary is the path they touched. */
const FILE_SUMMARY_TOOLS = new Set(["Read", "Edit", "Write"]);

/**
 * Short label derived from tool input for narrative rows (path tail, pattern, command, etc.).
 */
export function extractToolInputDetail(tc: ToolCall): string {
  const input = tc.toolInput;
  const detail = pathTail(input.file_path)
    ?? pathTail(input.path)
    ?? pathTail(singleFile(input.files))
    ?? fileSummaryTail(tc)
    ?? quotedDetail(input.pattern)
    ?? quotedDetail(input.query)
    ?? stringDetail(input.command)
    ?? stringDetail(input.description)
    ?? Object.values(input).find(isShortString);
  return detail ?? tc.toolName;
}

/**
 * The delegated task a task_status or task_cancel call names. A live call has
 * parsed input, while a reloaded one carries only the server's JSON summary.
 */
export function delegatedTaskId(tc: ToolCall): string | undefined {
  if (typeof tc.toolInput.taskId === "string") return tc.toolInput.taskId;
  const summary = tc.toolInput._summary ?? tc.toolInput.summary;
  if (typeof summary !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(summary);
    const taskId = typeof parsed === "object" && parsed !== null && "taskId" in parsed ? parsed.taskId : undefined;
    return typeof taskId === "string" ? taskId : undefined;
  } catch {
    // The server truncates long summaries, so stored JSON can be cut off.
    return undefined;
  }
}

function pathTail(value: unknown): string | undefined {
  return typeof value === "string" ? value.split(/[/\\]/).pop() ?? value : undefined;
}

/** Codex file changes list their paths as one comma-joined string. */
function singleFile(value: unknown): string | undefined {
  return typeof value === "string" && !value.includes(", ") ? value : undefined;
}

/**
 * Persisted and recovered calls carry only the server summary, which is a path
 * for file tools. Older Codex rows stored truncated JSON instead, so skip it.
 */
function fileSummaryTail(tc: ToolCall): string | undefined {
  if (!FILE_SUMMARY_TOOLS.has(resolveToolName(tc.toolName))) return undefined;
  const summary = tc.toolInput._summary ?? tc.toolInput.summary;
  if (typeof summary !== "string" || summary.startsWith("{")) return undefined;
  return pathTail(singleFile(summary)) || undefined;
}

function quotedDetail(value: unknown): string | undefined {
  return typeof value === "string" ? `"${value}"` : undefined;
}

function stringDetail(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length < 100;
}
