import { useState, useMemo, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { StackedLayersIcon } from "./StackedLayersIcon";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
  resolveToolName,
} from "../tool-renderers/constants";
import type { ToolCall, HookExecution } from "@/transport/types";
import { extractToolInputDetail } from "./tool-detail";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";

interface SubagentRowProps {
  toolCall: ToolCall;
  /** Direct children of this subagent. */
  children: readonly ToolCall[];
  hooks: readonly HookExecution[];
  /**
   * All tool calls in the current turn, used to find grandchildren when a
   * direct child is itself an Agent (nested subagent).
   */
  allToolCalls?: readonly ToolCall[];
  /** Nesting depth - increases left indentation for nested subagents. */
  depth?: number;
}

function extractDescription(toolCall: ToolCall): string {
  const input = toolCall.toolInput;
  if (typeof input.description === "string" && input.description.length > 0) return input.description;
  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    return input.prompt.length > 60 ? input.prompt.slice(0, 60) + "…" : input.prompt;
  }
  return "Delegated task";
}

const CHILD_CAP = 8;
const MAX_DEPTH = 4;

/**
 * Renders a subagent as a collapsible row in the narrative timeline.
 * Recursively renders Agent children as nested SubagentRows.
 */
export function SubagentRow({ toolCall, children, hooks, allToolCalls, depth = 0 }: SubagentRowProps) {
  const isRunning = !toolCall.isComplete;
  const isErrored = toolCall.isComplete && toolCall.isError;
  const [open, setOpen] = useState(isRunning);
  const userToggledRef = useRef(false);

  // Auto-collapse when the sub-agent finishes, unless the user manually
  // toggled it open during the run. Manual interactions win.
  useEffect(() => {
    if (!isRunning && !userToggledRef.current) {
      setOpen(false);
    }
  }, [isRunning]);

  const [showAll, setShowAll] = useState(false);

  const description = extractDescription(toolCall);

  // Count direct children only (Agents count as one item, not as their grandchildren).
  const metaText = !isRunning && children.length > 0
    ? buildToolSummaryText(children)
    : children.length > 0
    ? `${children.length} call${children.length === 1 ? "" : "s"}`
    : null;

  const lastIncompleteIdx = children.reduce<number>((acc, tc, idx) => (!tc.isComplete ? idx : acc), -1);

  // Build a grandchildren map: for each Agent child, find its own children in allToolCalls.
  const grandchildrenMap = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    if (!allToolCalls) return map;
    for (const tc of allToolCalls) {
      if (tc.parentToolCallId == null) continue;
      const arr = map.get(tc.parentToolCallId) ?? [];
      arr.push(tc);
      map.set(tc.parentToolCallId, arr);
    }
    return map;
  }, [allToolCalls]);

  const visibleChildren = showAll ? children : children.slice(0, CHILD_CAP);

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true;
          setOpen((o) => !o);
        }}
        className={`${NARRATIVE_TOOL_ROW} w-full px-2 py-1 text-left rounded-md hover:bg-muted/30 transition-colors duration-100 text-[0.8125rem]`}
        aria-expanded={open}
      >
        <StackedLayersIcon
          animated={isRunning}
          className={`w-3.5 h-3.5 shrink-0 ${isRunning ? "text-primary/80" : "text-muted-foreground/60"}`}
        />

        <span className="text-foreground/80 truncate flex-1 min-w-0">{description}</span>

        {metaText && (
          <span className="font-mono text-[0.6875rem] text-muted-foreground/50 shrink-0">
            {!isRunning ? `· ${metaText}` : metaText}
          </span>
        )}

        {isRunning && (
          <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />
        )}

        {isErrored && (
          <span className="font-mono text-[0.625rem] font-medium px-1 py-px rounded-sm bg-[var(--diff-remove)]/15 text-[var(--diff-remove)] shrink-0">
            errored
          </span>
        )}

        <ChevronRight
          className={`h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>

      <AnimatedCollapsible open={open}>
        {/* Mini-timeline: a hairline rail emerges inside the expanded sub-agent
            because the children are a nested group that the eye benefits from
            tracking as one unit. The rail aligns with the parent's stacked-
            layers icon (centred at ~x=15), so it reads as "these calls belong
            to this sub-agent" rather than a generic indent. */}
        <div className="relative min-w-0 max-w-full pl-7 mt-0.5 pb-1">
          <div
            className="absolute left-[14px] top-1 bottom-2 w-px bg-border/50 pointer-events-none"
            aria-hidden
          />
          <ul className="min-w-0 max-w-full space-y-px max-h-64 overflow-y-auto overflow-x-hidden">
          {visibleChildren.map((tc, idx) => {
            const isActive = idx === lastIncompleteIdx;

            // Nested Agent - recursively render as a SubagentRow
            if (tc.toolName === "Agent" && depth < MAX_DEPTH) {
              return (
                <li key={tc.id} className="list-none">
                  <SubagentRow
                    toolCall={tc}
                    children={grandchildrenMap.get(tc.id) ?? []}
                    hooks={hooks}
                    allToolCalls={allToolCalls}
                    depth={depth + 1}
                  />
                </li>
              );
            }

            const canonicalName = resolveToolName(tc.toolName);
            const Icon = TOOL_ICONS[canonicalName] ?? DEFAULT_ICON;
            const label = TOOL_LABELS[canonicalName] ?? tc.toolName;
            const detail = extractToolInputDetail(tc);

            return (
              <li key={tc.id} className={`${NARRATIVE_TOOL_ROW} py-px text-[0.8125rem]`}>
                <Icon className={`w-3 h-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/50"}`} />
                <span className={`shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground/70"}`}>{label}</span>
                <span className={narrativeToolDetailClass("sm")} title={detail}>
                  {detail}
                </span>
                {isActive && (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />
                )}
              </li>
            );
          })}
          </ul>
        </div>
        {children.length > CHILD_CAP && (
          <button
            type="button"
            onClick={() => setShowAll((o) => !o)}
            className="flex items-center gap-1 pl-7 pb-1 text-[0.6875rem] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
          >
            <ChevronDown className={`h-2.5 w-2.5 shrink-0 transition-transform duration-150 ${showAll ? "rotate-180" : ""}`} />
            {showAll ? "Show less" : `Show all ${children.length}`}
          </button>
        )}
      </AnimatedCollapsible>
    </div>
  );
}
