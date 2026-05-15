import {
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_PHASE_LABELS,
  DEFAULT_ICON,
} from "../tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import { extractToolInputDetail } from "./tool-detail";

interface ActiveToolRowProps {
  toolCall: ToolCall;
}

/**
 * Renders the currently executing tool call. Spinning icon + label + detail.
 * No background tint - the spinning icon alone signals activity.
 */
export function ActiveToolRow({ toolCall }: ActiveToolRowProps) {
  const Icon = TOOL_ICONS[toolCall.toolName] ?? DEFAULT_ICON;
  const label = TOOL_PHASE_LABELS[toolCall.toolName] ?? TOOL_LABELS[toolCall.toolName] ?? toolCall.toolName;
  const detail = extractToolInputDetail(toolCall);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-[0.8125rem]">
      <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
      <span className="font-medium text-foreground shrink-0">{label}</span>
      <span className="font-mono text-[0.6875rem] text-muted-foreground/50 truncate flex-1 min-w-0">{detail}</span>
    </div>
  );
}
