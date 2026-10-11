import {
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_PHASE_LABELS,
  DEFAULT_ICON,
  resolveToolName,
  isShellTool,
} from "@/components/chat/tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import { extractToolInputDetail } from "./tool-detail";
import { ShellToolCallRow } from "./ShellToolCallRow";
import { BrowserActivitySummary, isBrowserNarrativeCall } from "./BrowserActivityRow";
import { NarrativeToolRow, NarrativeToolRowDetail, type RowExpansion } from "./NarrativeToolRow";

interface ActiveToolRowProps {
  toolCall: ToolCall;
  /** Transcript-owned open state, so a shell's open output survives its completion. */
  expansion?: RowExpansion;
}

/**
 * Renders the currently executing tool call as a collapsed row whose label
 * reads in the present tense, such as "Reading file".
 */
export function ActiveToolRow({ toolCall, expansion }: ActiveToolRowProps) {
  if (isBrowserNarrativeCall(toolCall)) {
    return <BrowserActivitySummary calls={[toolCall]} active />;
  }

  if (isShellTool(toolCall.toolName)) return <ShellToolCallRow toolCall={toolCall} expansion={expansion} />;

  if (toolCall.toolName === "Approval review") {
    return <NarrativeToolRow icon={DEFAULT_ICON} label="Reviewing" />;
  }

  const canonicalName = resolveToolName(toolCall.toolName);
  const label = TOOL_PHASE_LABELS[canonicalName] ?? TOOL_LABELS[canonicalName] ?? toolCall.toolName;
  return (
    <NarrativeToolRow icon={TOOL_ICONS[canonicalName] ?? DEFAULT_ICON} label={label}>
      <NarrativeToolRowDetail kind="file">{extractToolInputDetail(toolCall)}</NarrativeToolRowDetail>
    </NarrativeToolRow>
  );
}
