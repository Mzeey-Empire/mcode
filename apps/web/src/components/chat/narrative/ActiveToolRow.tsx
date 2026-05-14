import {
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_PHASE_LABELS,
  DEFAULT_ICON,
} from "../tool-renderers/constants";
import type { ToolCall } from "@/transport/types";

interface ActiveToolRowProps {
  toolCall: ToolCall;
}

function extractDetail(tc: ToolCall): string {
  const input = tc.toolInput;
  if (typeof input.file_path === "string") return input.file_path.split("/").pop() ?? input.file_path;
  if (typeof input.path === "string") return input.path.split("/").pop() ?? input.path;
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
 * Renders the currently executing tool call. Spinning icon + label + detail.
 * No background tint - the spinning icon alone signals activity.
 */
export function ActiveToolRow({ toolCall }: ActiveToolRowProps) {
  const Icon = TOOL_ICONS[toolCall.toolName] ?? DEFAULT_ICON;
  const label = TOOL_PHASE_LABELS[toolCall.toolName] ?? TOOL_LABELS[toolCall.toolName] ?? toolCall.toolName;
  const detail = extractDetail(toolCall);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-[0.8125rem]">
      <Icon className="w-3.5 h-3.5 shrink-0 text-primary animate-spin" />
      <span className="font-medium text-foreground shrink-0">{label}</span>
      <span className="font-mono text-[0.6875rem] text-muted-foreground/50 truncate flex-1 min-w-0">{detail}</span>
    </div>
  );
}
