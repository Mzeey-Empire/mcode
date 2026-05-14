import {
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_PHASE_LABELS,
  DEFAULT_ICON,
} from "../tool-renderers/constants";
import type { ToolCall } from "@/transport/types";

interface ActiveToolRowProps {
  /** The tool call currently executing. */
  toolCall: ToolCall;
}

/**
 * Extracts a short display string from a tool call's input for the active tool row.
 * Prefers specific known fields (file paths, patterns, commands) before falling
 * back to the first short string value found in the input object.
 */
function extractDetail(tc: ToolCall): string {
  const input = tc.toolInput;
  if (typeof input.file_path === "string")
    return input.file_path.split("/").pop() ?? input.file_path;
  if (typeof input.path === "string")
    return input.path.split("/").pop() ?? input.path;
  if (typeof input.pattern === "string") return `"${input.pattern}"`;
  if (typeof input.query === "string") return `"${input.query}"`;
  if (typeof input.command === "string") return input.command;
  if (typeof input.description === "string") return input.description;
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length < 100) return v;
  }
  return tc.toolName;
}

/**
 * Renders the currently executing tool call as a single non-expandable row.
 *
 * Shows a primary-tinted background with a spinning tool icon, a present-tense
 * phase label (e.g. "Reading files..."), and a short detail string extracted
 * from the tool input (file path, query, command, etc.).
 */
export function ActiveToolRow({ toolCall }: ActiveToolRowProps) {
  const Icon = TOOL_ICONS[toolCall.toolName] ?? DEFAULT_ICON;
  const label =
    TOOL_PHASE_LABELS[toolCall.toolName] ??
    TOOL_LABELS[toolCall.toolName] ??
    toolCall.toolName;
  const detail = extractDetail(toolCall);

  return (
    <div className="bg-primary/8 rounded-md">
      <div className="flex items-center gap-2 px-2 py-1 text-[0.8125rem]">
        {/* Spinning tool icon */}
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0">
          <Icon className="w-[13px] h-[13px] text-primary animate-spin" />
        </span>

        {/* Phase label */}
        <span className="font-medium text-foreground shrink-0">{label}</span>

        {/* Detail text */}
        <span className="font-mono text-[0.75rem] text-muted-foreground/80 truncate flex-1 min-w-0">
          {detail}
        </span>
      </div>
    </div>
  );
}
