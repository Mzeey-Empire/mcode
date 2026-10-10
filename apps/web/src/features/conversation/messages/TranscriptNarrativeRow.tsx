import { useEffect } from "react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { BrowserActivityCall, isBrowserNarrativeCall } from "../narrative/BrowserActivityRow";
import { ActiveToolRow } from "../narrative/ActiveToolRow";
import { NarrativeRow } from "../narrative/NarrativeRow";
import type { RowExpansion } from "../narrative/NarrativeToolRow";
import { ToolCallDetailRow, ToolSummaryLine } from "../narrative/ToolSummaryLine";
import type { SubagentRosterTarget } from "../narrative/types";
import { toolCallDisclosureKey, type TranscriptNarrativeItem, type TranscriptToolItem } from "./transcript-narrative-items";

interface TranscriptNarrativeRowProps {
  readonly row: TranscriptNarrativeItem | TranscriptToolItem;
  readonly threadId: string | null | undefined;
  readonly expanded: boolean;
  /** Whether the output of the call this row discloses is open. */
  readonly callExpanded?: boolean;
  readonly entering?: boolean;
  readonly onToggle: (key: string) => void;
  readonly onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  readonly onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

/** Keeps loading detail while any virtual row from one persisted turn remains visible. */
export function VisibleNarrativeLoader({ threadId, messageId }: { threadId: string; messageId: string }) {
  const records = useThreadRecord(threadId, (record) => record.narrativeByMessage[messageId]);
  const load = useThreadStore((state) => state.loadNarrativeForMessage);

  useEffect(() => {
    void load(messageId, threadId);
  }, [load, messageId, records, threadId]);

  return null;
}

/**
 * A row that is its call's own row also flips its own key, so the call stays
 * listed and open when a lone group grows into a multi-call group.
 */
function callExpansionFor(
  row: TranscriptNarrativeItem | TranscriptToolItem,
  open: boolean,
  onToggle: (key: string) => void,
): RowExpansion | undefined {
  const key = toolCallDisclosureKey(row);
  if (!key) return undefined;
  return {
    open,
    onToggle: () => {
      if (row.type === "narrative-row") onToggle(row.key);
      onToggle(key);
    },
  };
}

function ToolChildRow({ row, open, entering, expansion }: {
  row: TranscriptToolItem;
  open: boolean;
  entering?: boolean;
  expansion?: RowExpansion;
}) {
  return (
    <AnimatedCollapsible open={open} className={entering ? "starting:grid-rows-[0fr]" : undefined}>
      <ul className={`min-w-0 max-w-full pt-1 pl-6 ${row.index === row.count - 1 ? "pb-2" : ""}`} aria-label={`Tool call ${row.index + 1} of ${row.count}`}>
        {isBrowserNarrativeCall(row.toolCall)
          ? <BrowserActivityCall toolCall={row.toolCall} />
          : <ToolCallDetailRow toolCall={row.toolCall} expansion={expansion} />}
      </ul>
    </AnimatedCollapsible>
  );
}

/** Renders group summaries and children as peers in the transcript viewport. */
export function TranscriptNarrativeRow({ row, threadId, expanded, callExpanded = false, entering, onToggle, onSubagentSelect, onOpenSubagents }: TranscriptNarrativeRowProps) {
  const loader = row.messageId && threadId
    ? <VisibleNarrativeLoader threadId={threadId} messageId={row.messageId} />
    : null;
  const callExpansion = callExpansionFor(row, callExpanded, onToggle);
  if (row.type === "tool-row") {
    return <>{loader}<ToolChildRow row={row} open={expanded} entering={entering} expansion={callExpansion} /></>;
  }
  if (row.item.type === "tool-group") {
    return <>{loader}<ToolSummaryLine {...row.item} virtualExpansion={callExpansion ?? { open: expanded, onToggle: () => onToggle(row.key) }} /></>;
  }
  if (row.item.type === "active-tool") {
    return (
      <>
        {loader}
        {/* An open running shell skips its exit collapse, because its completed row takes over the same open output. */}
        <AnimatedCollapsible open={row.transition !== "exiting" || callExpanded} className={row.transition === "entering" ? "starting:grid-rows-[0fr]" : undefined}>
          <ActiveToolRow toolCall={row.item.toolCall} expansion={callExpansion} />
        </AnimatedCollapsible>
      </>
    );
  }
  return <>{loader}<NarrativeRow rowId={row.key} item={row.item} allToolCalls={row.allToolCalls} onSubagentSelect={onSubagentSelect} onOpenSubagents={onOpenSubagents} /></>;
}
