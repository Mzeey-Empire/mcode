import type { ToolCall } from "@/transport/types";

/**
 * Short label derived from tool input for narrative rows (path tail, pattern, command, etc.).
 */
export function extractToolInputDetail(tc: ToolCall): string {
  const input = tc.toolInput;
  const detail = pathTail(input.file_path)
    ?? pathTail(input.path)
    ?? pathTail(singleFile(input.files))
    ?? quotedDetail(input.pattern)
    ?? quotedDetail(input.query)
    ?? stringDetail(input.command)
    ?? stringDetail(input.description)
    ?? Object.values(input).find(isShortString);
  return detail ?? tc.toolName;
}

function pathTail(value: unknown): string | undefined {
  return typeof value === "string" ? value.split(/[/\\]/).pop() ?? value : undefined;
}

/** Codex file changes list their paths as one comma-joined string. */
function singleFile(value: unknown): string | undefined {
  return typeof value === "string" && !value.includes(", ") ? value : undefined;
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
