import { useState, useEffect } from "react";
import { Check, Clock, X, ChevronRight } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import type { HookExecution } from "@/transport/types";

interface HookRowProps {
  /** The hook execution to display. */
  hook: HookExecution;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Renders as "Nms" for durations under 1000ms, "N.Ns" for 1000ms and above.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compact inline row for displaying hook executions in the narrative timeline.
 *
 * Renders three visual states:
 * - **Passed** (status "completed", exitCode 0, !didBlock): green check, hook name, trigger, duration, expandable output.
 * - **Running** (status "running"): spinning clock, hook name, trigger, live elapsed timer, "running" badge.
 * - **Blocked** (didBlock true): red X, hook name, trigger, duration, "blocked" badge, error output in red.
 *
 * Output is expandable via a chevron. The chevron is only shown when the hook has output.
 */
export function HookRow({ hook }: HookRowProps) {
  const [open, setOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isRunning = hook.status === "running";
  const isBlocked = hook.didBlock === true;
  const hasPassed = !isBlocked && hook.status === "completed";

  const hasOutput =
    hook.fullOutput.length > 0 || hook.outputLines.length > 0;

  const outputText =
    hook.fullOutput.length > 0
      ? hook.fullOutput.join("\n")
      : hook.outputLines.join("\n");

  // Elapsed timer for running hooks - updates every second.
  useEffect(() => {
    if (!isRunning) return;

    const update = () => {
      setElapsedSeconds(Math.round((Date.now() - hook.startedAt) / 1000));
    };

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isRunning, hook.startedAt]);

  const handleClick = () => {
    if (hasOutput) setOpen((prev) => !prev);
  };

  return (
    <div className="rounded-md">
      {/* Main row */}
      <button
        type="button"
        onClick={handleClick}
        disabled={!hasOutput}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left rounded-md transition-colors duration-100 text-xs ${
          hasOutput ? "hover:bg-muted/30 cursor-pointer" : "cursor-default"
        }`}
        aria-expanded={hasOutput ? open : undefined}
      >
        {/* Status icon */}
        {isRunning ? (
          <span aria-label="running" className="flex w-[13px] h-[13px] items-center justify-center shrink-0">
            <Clock className="w-[13px] h-[13px] text-primary animate-spin" />
          </span>
        ) : isBlocked ? (
          <span aria-label="blocked" className="flex w-[13px] h-[13px] items-center justify-center shrink-0">
            <X className="w-[13px] h-[13px] text-[var(--diff-remove)]" />
          </span>
        ) : (
          <span aria-label="passed" className="flex w-[13px] h-[13px] items-center justify-center shrink-0">
            <Check className="w-[13px] h-[13px] text-[var(--diff-add)]" />
          </span>
        )}

        {/* Hook name */}
        <span className="font-medium text-foreground/60 shrink-0">
          {hook.hookName}
        </span>

        {/* Trigger label */}
        {hook.toolName && (
          <span className="font-mono text-[0.6875rem] text-muted-foreground/70 shrink-0">
            on {hook.toolName}
          </span>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Duration or elapsed timer */}
        <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground/60 shrink-0">
          {isRunning
            ? `${elapsedSeconds}s`
            : hook.durationMs != null
            ? formatDuration(hook.durationMs)
            : null}
        </span>

        {/* Status badge */}
        {isRunning && (
          <span className="font-mono text-[0.625rem] font-medium px-1.5 py-px rounded-sm bg-primary/15 text-primary shrink-0">
            running
          </span>
        )}
        {isBlocked && (
          <span className="font-mono text-[0.625rem] font-medium px-1.5 py-px rounded-sm bg-[var(--diff-remove)]/15 text-[var(--diff-remove)] shrink-0">
            blocked
          </span>
        )}

        {/* Chevron - only when output exists */}
        {hasOutput && (
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-200 ${
              open ? "rotate-90" : ""
            }`}
          />
        )}
      </button>

      {/* Expandable output */}
      {hasOutput && (
        <AnimatedCollapsible open={open}>
          <div className="pl-6 pb-1 mt-0.5">
            <pre
              className={`font-mono text-[0.6875rem] leading-normal bg-[var(--code-bg)] rounded-md px-2.5 py-1.5 whitespace-pre-wrap max-h-24 overflow-auto ${
                isBlocked || (hasPassed && hook.exitCode !== 0)
                  ? "text-[var(--diff-remove)]"
                  : ""
              }`}
            >
              {isRunning ? (
                <>
                  {outputText}
                  <span aria-hidden="true" className="typing-cursor" />
                </>
              ) : (
                outputText
              )}
            </pre>
          </div>
        </AnimatedCollapsible>
      )}
    </div>
  );
}
