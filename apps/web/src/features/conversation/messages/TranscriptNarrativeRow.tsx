import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { BrowserActivityCall, isBrowserNarrativeCall } from "../narrative/BrowserActivityRow";
import { NarrativeRow } from "../narrative/NarrativeRow";
import { ToolCallDetailRow, ToolSummaryLine } from "../narrative/ToolSummaryLine";
import type { SubagentRosterTarget } from "../narrative/types";
import type { TranscriptNarrativeItem, TranscriptToolItem } from "./transcript-narrative-items";

interface TranscriptNarrativeRowProps {
  readonly row: TranscriptNarrativeItem | TranscriptToolItem;
  readonly expanded: boolean;
  readonly entering?: boolean;
  readonly onToggle: (key: string) => void;
  readonly onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  readonly onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

/** Renders group summaries and children as peers in the transcript viewport. */
export function TranscriptNarrativeRow({ row, expanded, entering, onToggle, onSubagentSelect, onOpenSubagents }: TranscriptNarrativeRowProps) {
  if (row.type === "tool-row") {
    return (
      <AnimatedCollapsible open={expanded} className={entering ? "starting:grid-rows-[0fr]" : undefined}>
        <ul className={`min-w-0 max-w-full pt-1 pl-6 ${row.index === row.count - 1 ? "pb-2" : ""}`} aria-label={`Tool call ${row.index + 1} of ${row.count}`}>
          {isBrowserNarrativeCall(row.toolCall)
            ? <BrowserActivityCall toolCall={row.toolCall} />
            : <ToolCallDetailRow toolCall={row.toolCall} />}
        </ul>
      </AnimatedCollapsible>
    );
  }
  if (row.item.type === "tool-group") {
    return <ToolSummaryLine {...row.item} virtualExpansion={{ open: expanded, onToggle: () => onToggle(row.key) }} />;
  }
  if (row.item.type === "active-tool") {
    return (
      <AnimatedCollapsible open={row.transition !== "exiting"} className={row.transition === "entering" ? "starting:grid-rows-[0fr]" : undefined}>
        <NarrativeRow rowId={row.key} item={row.item} allToolCalls={row.allToolCalls} />
      </AnimatedCollapsible>
    );
  }
  return <NarrativeRow rowId={row.key} item={row.item} allToolCalls={row.allToolCalls} onSubagentSelect={onSubagentSelect} onOpenSubagents={onOpenSubagents} />;
}
