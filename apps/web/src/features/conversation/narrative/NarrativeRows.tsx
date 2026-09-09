import type { ToolCall } from "@/transport/types";
import { NarrativeRow } from "./NarrativeRow";
import { narrativePerformanceRowId } from "./NarrativePerformanceBoundary";
import type { NarrativeItem, SubagentRosterTarget } from "./types";

/** Props for the chronological rows inside a narrative timeline item. */
export interface NarrativeRowsProps {
  /** Ordered narrative items for one turn. */
  items: readonly NarrativeItem[];
  /** Full turn graph retained for the sub-agent detail contract. */
  allToolCalls: readonly ToolCall[];
  /** Adds the live row entry animation. */
  animateEntry?: boolean;
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
}

/** Returns the top margin for one narrative item. */
export function narrativeRowMargin(item: NarrativeItem, index: number): string {
  if (index === 0) return "mt-0";
  switch (item.type) {
    case "thought":
      return "mt-3";
    case "tool-group":
    case "hook":
    case "subagent":
    case "active-tool":
      return "mt-1";
    case "delta":
      return "mt-2";
  }
}

/** Returns the stable row key for one narrative item. */
export function narrativeRowKey(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return `thought-${item.segment.startedAt}-${index}`;
    case "tool-group":
      return `tool-group-${item.group.calls[0]?.id ?? index}`;
    case "hook":
      return `hook-${item.hook.hookName}-${item.hook.startedAt}-${index}`;
    case "subagent":
      return `subagent-${item.toolCall.id}-${item.lifecycle}-${index}`;
    case "active-tool":
      return `active-tool-${item.toolCall.id}`;
    case "delta":
      return "delta";
  }
}

/** Renders every narrative row inline in chronological order. */
export function NarrativeRows({
  items,
  allToolCalls,
  animateEntry = false,
  onSubagentSelect,
  onOpenSubagents,
}: NarrativeRowsProps) {
  return (
    <div
      className="flex min-w-0 max-w-full flex-col"
      data-narrative-source-row-count={items.length}
    >
      {items.filter((item) => item.type !== "hook").map((item, index) => {
        const key = narrativeRowKey(item, index);
        return (
          <div
            key={key}
            data-performance-row-id={narrativePerformanceRowId(key)}
            className={[
              narrativeRowMargin(item, index),
              animateEntry ? "narrative-row-enter" : "",
              "min-w-0 max-w-full",
            ].join(" ")}
          >
            <NarrativeRow
              rowId={key}
              item={item}
              allToolCalls={allToolCalls}
              onSubagentSelect={onSubagentSelect}
              onOpenSubagents={onOpenSubagents}
            />
          </div>
        );
      })}
    </div>
  );
}
