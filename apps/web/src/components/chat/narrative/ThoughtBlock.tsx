import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import type { ThoughtSegment } from "./types";

/** Character threshold that distinguishes short from long thoughts. */
const LONG_THOUGHT_THRESHOLD = 200;

interface ThoughtBlockProps {
  /** The thought segment data to render. */
  segment: ThoughtSegment;
  /** Whether this thought is currently being streamed by the agent. */
  isActive: boolean;
}

/**
 * Renders a single agent thought segment in the narrative timeline.
 *
 * Short thoughts (< 200 chars, not active) start open and are collapsible.
 * Long thoughts (>= 200 chars, not active) start collapsed with a truncated
 * preview; clicking the chevron expands to show the full text.
 * Active thoughts (currently streaming) are always open with a typing cursor.
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  const isLong = segment.text.length >= LONG_THOUGHT_THRESHOLD;
  const [open, setOpen] = useState(!isLong);

  const durationSeconds =
    segment.endedAt != null
      ? Math.round((segment.endedAt - segment.startedAt) / 1000)
      : null;

  const showDuration = !isActive && durationSeconds != null;

  /** Toggle open state — disabled while actively streaming. */
  function handleToggle() {
    if (!isActive) {
      setOpen((prev) => !prev);
    }
  }

  const containerClass = isActive
    ? "rounded-md bg-primary/7 px-3 py-2"
    : "rounded-md px-3 py-2 hover:bg-muted/30 transition-colors duration-100";

  return (
    <div className={containerClass}>
      {/* Header row */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={isActive}
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={isActive ? true : open}
      >
        <span className="text-xs font-medium text-muted-foreground">
          Thought
        </span>

        {showDuration && (
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground/60">
            for {durationSeconds}s
          </span>
        )}

        <span className="ml-auto">
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ${
              isActive || open ? "rotate-90" : ""
            }`}
          />
        </span>
      </button>

      {/* Collapsed long-thought preview (rendered outside the collapsible so
          the truncated line remains visible when closed) */}
      {!isActive && isLong && !open && (
        <p className="mt-1 line-clamp-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {segment.text}
        </p>
      )}

      {/* Expanded content */}
      <AnimatedCollapsible open={isActive || open}>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {segment.text}
          {isActive && (
            <span
              aria-hidden="true"
              className="ml-px inline-block h-[0.875em] w-[1.5px] align-text-bottom bg-primary animate-[blink_0.8s_steps(1)_infinite]"
            />
          )}
        </p>
      </AnimatedCollapsible>
    </div>
  );
}
