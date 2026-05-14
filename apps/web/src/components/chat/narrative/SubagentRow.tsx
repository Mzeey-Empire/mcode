import { useState } from "react";
import { Bot, ChevronRight, ChevronDown } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
} from "../tool-renderers/constants";
import type { ToolCall, HookExecution } from "@/transport/types";

interface SubagentRowProps {
  /** The Agent tool call that spawned this subagent. */
  toolCall: ToolCall;
  /** All child tool calls executed within this subagent. */
  children: readonly ToolCall[];
  /** Hook executions associated with this subagent. */
  hooks: readonly HookExecution[];
  /**
   * Whether this subagent is the most recently active one.
   * Only the most active running subagent receives the primary background tint.
   */
  isMostActive?: boolean;
}

/**
 * Extracts a short display string from a tool call's input for use in detail rows.
 * Mirrors the extractDetail logic from ToolSummaryLine.
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
 * Derives a human-readable description from the Agent tool call's input.
 * Prefers `description`, then the first 60 chars of `prompt`, then a fallback.
 */
function extractDescription(toolCall: ToolCall): string {
  const input = toolCall.toolInput;
  if (typeof input.description === "string" && input.description.length > 0) {
    return input.description;
  }
  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    return input.prompt.length > 60
      ? input.prompt.slice(0, 60) + "…"
      : input.prompt;
  }
  return "Delegated task";
}

interface SubagentStatusBadgeProps {
  /** The status variant to render. */
  status: "running" | "completed" | "errored";
}

/**
 * Small monospace badge showing the current status of the subagent.
 */
function SubagentStatusBadge({ status }: SubagentStatusBadgeProps) {
  const styles: Record<string, string> = {
    running: "bg-primary/15 text-primary",
    completed: "bg-[var(--diff-add)]/15 text-[var(--diff-add)]",
    errored: "bg-[var(--diff-remove)]/15 text-[var(--diff-remove)]",
  };
  return (
    <span
      className={`font-mono text-[0.625rem] font-medium px-1.5 py-px rounded-sm shrink-0 ${styles[status]}`}
    >
      {status}
    </span>
  );
}

/**
 * Renders a subagent as a collapsible row in the narrative timeline.
 *
 * Shows a summary line with the subagent icon, description, child tool count or
 * summary, and status badge. Expands to reveal a flat indented list of child
 * tool calls. Active subagents start expanded automatically.
 */
/** Maximum number of child tool calls shown before a "Show all" toggle appears. */
const CHILD_CAP = 8;

export function SubagentRow({ toolCall, children, isMostActive = false }: SubagentRowProps) {
  const isRunning = !toolCall.isComplete;
  const isErrored = toolCall.isComplete && toolCall.isError;

  const [open, setOpen] = useState(isRunning);
  const [showAll, setShowAll] = useState(false);

  const description = extractDescription(toolCall);

  const status: "running" | "completed" | "errored" = isRunning
    ? "running"
    : isErrored
    ? "errored"
    : "completed";

  // For completed subagents show a summary like "read 3 files, 2 searches".
  // For running subagents show "N calls".
  const metaText =
    !isRunning && children.length > 0
      ? buildToolSummaryText(children)
      : children.length > 0
      ? `${children.length} call${children.length === 1 ? "" : "s"}`
      : null;

  // The last incomplete child is treated as "active" for styling purposes.
  const lastIncompleteIdx = children.reduce<number>(
    (acc, tc, idx) => (!tc.isComplete ? idx : acc),
    -1,
  );

  // Apply the primary tint only to the most recently active running subagent.
  const rowBg = isRunning && isMostActive ? "bg-primary/8" : "hover:bg-muted/30";

  return (
    <div className="rounded-md">
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left rounded-md transition-colors duration-100 text-[0.8125rem] ${rowBg}`}
        aria-expanded={open}
      >
        {/* Subagent icon */}
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0">
          <Bot
            className={`w-[14px] h-[14px] text-[var(--ring)]/85 ${
              isRunning ? "animate-spin" : ""
            }`}
          />
        </span>

        {/* Description */}
        <span className="font-medium text-[var(--ring)]/90 truncate flex-1 min-w-0">
          {description}
        </span>

        {/* Child count/summary */}
        {metaText && (
          <span className="font-mono text-[0.75rem] text-muted-foreground/70 truncate shrink-0">
            {isRunning ? metaText : ` · ${metaText}`}
          </span>
        )}

        {/* Status badge */}
        <SubagentStatusBadge status={status} />

        {/* Chevron */}
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Expanded child list */}
      <AnimatedCollapsible open={open}>
        <ul className="pl-7 mt-0.5 space-y-0.5 pb-1 max-h-48 overflow-y-auto">
          {(showAll ? children : children.slice(0, CHILD_CAP)).map((tc, idx) => {
            const Icon = TOOL_ICONS[tc.toolName] ?? DEFAULT_ICON;
            const label = TOOL_LABELS[tc.toolName] ?? tc.toolName;
            const detail = extractDetail(tc);
            const isActiveChild = idx === lastIncompleteIdx;

            return (
              <li key={tc.id} className="flex items-center gap-1.5 text-[0.8125rem]">
                <Icon
                  className={`w-[14px] h-[14px] shrink-0 ${
                    isActiveChild
                      ? "text-primary animate-spin"
                      : "text-muted-foreground/75"
                  }`}
                />
                <span
                  className={`font-medium shrink-0 ${
                    isActiveChild ? "text-foreground" : "text-foreground/65"
                  }`}
                >
                  {label}
                </span>
                <span className="font-mono text-[0.75rem] text-muted-foreground/80 truncate flex-1 min-w-0">
                  {detail}
                </span>
                {tc.isError && (
                  <span className="font-mono text-[0.625rem] font-medium px-1.5 py-px rounded-sm bg-[var(--diff-remove)]/15 text-[var(--diff-remove)] shrink-0">
                    errored
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {/* Show all toggle - only when there are more than CHILD_CAP children */}
        {children.length > CHILD_CAP && (
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="flex items-center gap-1 pl-7 pb-1 text-[0.75rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-100"
          >
            <ChevronDown
              className={`h-3 w-3 shrink-0 transition-transform duration-150 ${showAll ? "rotate-180" : ""}`}
            />
            {showAll ? "Show less" : `Show all ${children.length}`}
          </button>
        )}
      </AnimatedCollapsible>
    </div>
  );
}
