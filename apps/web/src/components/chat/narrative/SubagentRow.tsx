import { useState, useMemo, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { StackedLayersIcon } from "./StackedLayersIcon";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
} from "../tool-renderers/constants";
import type { ToolCall, HookExecution } from "@/transport/types";
import { extractToolInputDetail } from "./tool-detail";
import { buildDelegationTags } from "./subagent-delegation-tags";

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

interface DelegationTagsProps {
  tags: readonly string[];
}

/** Compact tags for model, task kind, and duration on delegation rows. */
function DelegationTags({ tags }: DelegationTagsProps) {
  if (tags.length === 0) return null;
  return (
    <span className="flex items-center gap-1 shrink-0">
      {tags.map((tag) => (
        <span
          key={tag}
          className="font-mono text-[0.625rem] font-medium px-1 py-px rounded-sm bg-muted-foreground/12 text-muted-foreground/70"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

interface SubagentStatusProps {
  isRunning: boolean;
  isErrored: boolean;
}

function SubagentStatus({ isRunning, isErrored }: SubagentStatusProps) {
  if (isRunning) {
    return <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />;
  }
  if (isErrored) {
    return (
      <span className="font-mono text-[0.625rem] font-medium px-1 py-px rounded-sm bg-[var(--diff-remove)]/15 text-[var(--diff-remove)] shrink-0">
        errored
      </span>
    );
  }
  return null;
}

const CHILD_CAP = 8;
const MAX_DEPTH = 4;

/**
 * Renders a subagent in the narrative timeline.
 *
 * When the parent stream has no nested tool calls (typical for Cursor Task
 * delegations), shows a flat row with delegation tags and no expand affordance.
 */
export function SubagentRow({ toolCall, children, hooks, allToolCalls, depth = 0 }: SubagentRowProps) {
  const isRunning = !toolCall.isComplete;
  const isErrored = toolCall.isComplete && toolCall.isError;
  const hasChildren = children.length > 0;
  const description = extractDescription(toolCall);
  const delegationTags = useMemo(() => buildDelegationTags(toolCall), [toolCall]);

  if (!hasChildren) {
    return (
      <div
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[0.8125rem]"
        data-testid="subagent-flat-row"
      >
        <StackedLayersIcon
          animated={isRunning}
          className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60"
        />
        <span className="text-foreground/80 truncate flex-1 min-w-0">{description}</span>
        <DelegationTags tags={delegationTags} />
        <SubagentStatus isRunning={isRunning} isErrored={isErrored} />
      </div>
    );
  }

  return (
    <ExpandableSubagentRow
      toolCall={toolCall}
      children={children}
      hooks={hooks}
      allToolCalls={allToolCalls}
      depth={depth}
      description={description}
      delegationTags={delegationTags}
      isRunning={isRunning}
      isErrored={isErrored}
    />
  );
}

interface ExpandableSubagentRowProps extends SubagentRowProps {
  description: string;
  delegationTags: readonly string[];
  isRunning: boolean;
  isErrored: boolean;
}

/**
 * Collapsible sub-agent row when nested tool calls exist (Claude SDK path).
 */
function ExpandableSubagentRow({
  toolCall,
  children,
  hooks,
  allToolCalls,
  depth = 0,
  description,
  delegationTags,
  isRunning,
  isErrored,
}: ExpandableSubagentRowProps) {
  const [open, setOpen] = useState(isRunning);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!isRunning && !userToggledRef.current) {
      setOpen(false);
    }
  }, [isRunning]);

  const [showAll, setShowAll] = useState(false);

  const metaText = !isRunning
    ? buildToolSummaryText(children)
    : `${children.length} call${children.length === 1 ? "" : "s"}`;

  const lastIncompleteIdx = children.reduce<number>((acc, tc, idx) => (!tc.isComplete ? idx : acc), -1);

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
    <div>
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true;
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left rounded-md hover:bg-muted/30 transition-colors duration-100 text-[0.8125rem]"
        aria-expanded={open}
      >
        <StackedLayersIcon
          animated={isRunning}
          className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60"
        />

        <span className="text-foreground/80 truncate flex-1 min-w-0">{description}</span>

        <DelegationTags tags={delegationTags} />

        <span className="font-mono text-[0.6875rem] text-muted-foreground/50 shrink-0">
          {!isRunning ? `· ${metaText}` : metaText}
        </span>

        <SubagentStatus isRunning={isRunning} isErrored={isErrored} />

        <ChevronRight
          className={`h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </button>

      <AnimatedCollapsible open={open}>
        <ul className="pl-7 mt-0.5 space-y-px pb-1 max-h-64 overflow-y-auto border-l border-muted-foreground/15 ml-3">
          {visibleChildren.map((tc, idx) => {
            const isActive = idx === lastIncompleteIdx;

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

            const Icon = TOOL_ICONS[tc.toolName] ?? DEFAULT_ICON;
            const label = TOOL_LABELS[tc.toolName] ?? tc.toolName;
            const detail = extractToolInputDetail(tc);

            return (
              <li key={tc.id} className="flex items-center gap-1.5 py-px text-[0.8125rem]">
                <Icon className={`w-3 h-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/50"}`} />
                <span className={`shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground/70"}`}>{label}</span>
                <span className="font-mono text-[0.6875rem] text-muted-foreground/50 truncate flex-1 min-w-0">{detail}</span>
                {isActive && (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary animate-pulse" />
                )}
              </li>
            );
          })}
        </ul>
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
