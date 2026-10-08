import { useMemo, useRef, type ReactElement } from "react";
import {
  CircleCheck,
  CircleX,
  CircleMinus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
import { sidePlacement } from "@/components/ui/side-placement";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChecksStatus, CheckRun } from "@mcode/contracts";

/** Props for {@link ChecksPopover}. */
interface ChecksPopoverProps {
  /** Latest CI check status to display. */
  checks: ChecksStatus;
  /** Trigger element rendered as the CI summary row. */
  children: ReactElement;
  /** Controlled open state. */
  open?: boolean;
  /** Called when the local flyout open state should change. */
  onOpenChange?: (open: boolean) => void;
}

interface CheckRunVisual {
  icon?: LucideIcon;
  iconClassName: string;
  label: string;
  labelClassName: string;
  spinning?: boolean;
}

function getRunVisual(run: CheckRun): CheckRunVisual {
  if (run.status !== "completed") {
    return {
      iconClassName: "text-primary",
      label: "Running",
      labelClassName: "text-muted",
      spinning: true,
    };
  }

  switch (run.conclusion) {
    case "success":
      return {
        icon: CircleCheck,
        iconClassName: "text-[var(--diff-add-strong)]",
        label: "Succeeded",
        labelClassName: "text-muted",
      };
    case "failure":
    case "timed_out":
      return {
        icon: CircleX,
        iconClassName: "text-[var(--diff-remove-strong)]",
        label: "Failed",
        labelClassName: "text-muted",
      };
    default:
      return {
        icon: CircleMinus,
        iconClassName: "text-muted/80",
        label: run.conclusion ? run.conclusion.replace(/_/g, " ") : "Completed",
        labelClassName: "text-muted",
      };
  }
}

/** Format a duration in milliseconds to a compact human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

/**
 * Flat CI job flyout anchored to the Overview CI summary row.
 */
export function ChecksPopover({
  checks,
  children,
  open,
  onOpenChange,
}: ChecksPopoverProps) {
  const triggerRef = useRef<HTMLDivElement | null>(null);

  const sortedRuns = useMemo(() => {
    const priority = (run: CheckRun): number => {
      if (run.status !== "completed") return 0;
      if (run.conclusion === "success") return 1;
      if (run.conclusion === "failure" || run.conclusion === "timed_out") return -1;
      return 2;
    };
    return [...checks.runs].sort((a, b) => priority(a) - priority(b));
  }, [checks.runs]);

  // The row's own button toggles the flyout, so a press on it is not an outside press.
  const handleOpenChange = (nextOpen: boolean, details: PopoverRootChangeEventDetails) => {
    const target = details.event?.target;
    if (details.reason === "outside-press" && target instanceof Node && triggerRef.current?.contains(target)) {
      return;
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <Popover open={open ?? false} onOpenChange={handleOpenChange}>
      <div ref={triggerRef} className="w-full">
        {children}
      </div>
      <PopoverContent
        {...sidePlacement(triggerRef)}
        role="dialog"
        data-testid="thread-overview-ci-popover"
        className="w-[356px] overflow-hidden p-0"
      >
        <div className="max-h-[320px] overflow-y-auto py-1 scrollbar-on-hover">
          {sortedRuns.length > 0 ? (
            sortedRuns.map((run, index) => (
              <RunRow key={`${run.name}-${index}`} run={run} />
            ))
          ) : (
            <div className="px-4 py-3 text-xs text-muted">No checks configured</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Single CI run row in the flat Codex-style job list. */
function RunRow({ run }: { run: CheckRun }) {
  const visual = getRunVisual(run);
  const Icon = visual.icon;
  const title =
    run.durationMs != null && run.status === "completed"
      ? `${visual.label} in ${formatDuration(run.durationMs)}`
      : visual.label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<div className="flex h-[30px] min-h-[30px] items-center gap-2 px-3.5 text-sm" />}
      >
        {visual.spinning ? (
          <Spinner size={16} className={visual.iconClassName} />
        ) : Icon ? (
          <Icon
            size={16}
            className={cn("shrink-0", visual.iconClassName)}
          />
        ) : null}
        <span className="min-w-0 flex-1 text-fade text-sm text-ink">
          {run.name}
        </span>
        <span className={cn("shrink-0 text-xs", visual.labelClassName)}>
          {visual.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
