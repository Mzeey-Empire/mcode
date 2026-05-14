import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
} from "../tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import type { ToolGroup } from "./types";

interface ToolSummaryLineProps {
  /** The group of consecutive tool calls to summarize. */
  group: ToolGroup;
  /** Whether any call in the group errored. */
  hasError: boolean;
  /** Whether any call in the group was cancelled. */
  hasCancelled: boolean;
}

/**
 * Extracts a short display string from a tool call's input for use in detail rows.
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
 * Returns the worst-status badge variant for a single tool call.
 * Errored calls take priority over cancelled (incomplete + error) calls.
 */
function getCallStatus(tc: ToolCall): "completed" | "errored" | "cancelled" {
  if (tc.isError) return "errored";
  if (!tc.isComplete) return "cancelled";
  return "completed";
}

interface StatusBadgeProps {
  /** The status variant to render. */
  status: "completed" | "errored" | "cancelled";
}

/**
 * Small monospace badge showing the outcome of a tool call.
 */
function StatusBadge({ status }: StatusBadgeProps) {
  const styles: Record<string, string> = {
    completed:
      "bg-[var(--diff-add)]/15 text-[var(--diff-add)]",
    errored:
      "bg-[var(--diff-remove)]/15 text-[var(--diff-remove)]",
    cancelled:
      "bg-muted-foreground/18 text-muted-foreground",
  };
  return (
    <span
      className={`font-mono text-[0.625rem] font-medium px-1.5 py-px rounded-sm ${styles[status]}`}
    >
      {status}
    </span>
  );
}

/**
 * Renders a compact one-liner summarizing a group of consecutive tool calls.
 *
 * The collapsed state shows a leading icon, summary text (e.g. "Read 3 files,
 * 1 search"), an optional worst-status badge, and a chevron. Clicking the row
 * expands an indented list of individual tool calls with per-call icons,
 * labels, detail text, status badges, and optional inline output blocks.
 */
export function ToolSummaryLine({
  group,
  hasError,
  hasCancelled,
}: ToolSummaryLineProps) {
  const [open, setOpen] = useState(false);

  const firstCall = group.calls[0];
  const LeadingIcon = firstCall
    ? (TOOL_ICONS[firstCall.toolName] ?? DEFAULT_ICON)
    : DEFAULT_ICON;

  const summaryText = buildToolSummaryText(group.calls);

  const worstBadge: "errored" | "cancelled" | null = hasError
    ? "errored"
    : hasCancelled
    ? "cancelled"
    : null;

  return (
    <div className="rounded-md">
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/30 rounded-md transition-colors duration-100 text-[0.8125rem]"
        aria-expanded={open}
      >
        {/* Leading icon */}
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0">
          <LeadingIcon className="w-[13px] h-[13px] text-muted-foreground/75" />
        </span>

        {/* Summary text */}
        <span className="font-medium text-foreground/65 flex-1 min-w-0 truncate">
          {summaryText}
        </span>

        {/* Worst-status badge */}
        {worstBadge && <StatusBadge status={worstBadge} />}

        {/* Chevron */}
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Expanded detail list */}
      <AnimatedCollapsible open={open}>
        <ul className="pl-6 mt-0.5 space-y-0.5 pb-1">
          {group.calls.map((tc) => {
            const Icon = TOOL_ICONS[tc.toolName] ?? DEFAULT_ICON;
            const label = TOOL_LABELS[tc.toolName] ?? tc.toolName;
            const detail = extractDetail(tc);
            const status = getCallStatus(tc);

            return (
              <li key={tc.id} className="flex flex-col gap-0.5">
                {/* Row: icon + label + detail + badge */}
                <div className="flex items-center gap-1.5 text-[0.8125rem]">
                  <Icon className="w-[14px] h-[14px] text-muted-foreground/75 shrink-0" />
                  <span className="text-foreground/65 font-medium shrink-0">
                    {label}
                  </span>
                  <span className="font-mono text-[0.75rem] text-muted-foreground/80 truncate flex-1 min-w-0">
                    {detail}
                  </span>
                  {status !== "completed" && <StatusBadge status={status} />}
                </div>

                {/* Inline content blocks */}
                {tc.isComplete && !tc.isError && tc.toolName === "Bash" && tc.output && (
                  <pre className="text-[0.75rem] font-mono rounded px-2 py-1 bg-[var(--code-bg)] text-foreground/80 overflow-x-auto whitespace-pre-wrap break-words max-h-40">
                    {tc.output}
                  </pre>
                )}

                {tc.isComplete && !tc.isError && tc.toolName === "Edit" && (
                  <span className="font-mono text-[0.75rem] text-muted-foreground/70">
                    {detail}
                  </span>
                )}

                {tc.isError && tc.output && (
                  <pre className="text-[0.75rem] font-mono rounded px-2 py-1 bg-[var(--diff-remove)]/10 text-[var(--diff-remove)] overflow-x-auto whitespace-pre-wrap break-words max-h-40">
                    {tc.output}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      </AnimatedCollapsible>
    </div>
  );
}
