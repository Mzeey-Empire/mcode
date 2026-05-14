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

  /** Toggle open state - disabled while actively streaming. */
  function handleToggle() {
    if (!isActive) {
      setOpen((prev) => !prev);
    }
  }

  return (
    <div
      className={`rounded-md transition-colors duration-120 ${
        isActive ? "bg-primary/7" : "hover:bg-muted/30"
      }`}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={isActive}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-xs text-left select-none"
        aria-expanded={isActive ? true : open}
      >
        <span
          className={`font-semibold ${
            isActive ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          Thought
        </span>

        {showDuration && (
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground/60">
            for {durationSeconds}s
          </span>
        )}

        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-150 ${
            isActive || open ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Collapsed long-thought preview */}
      {!isActive && isLong && !open && (
        <p className="px-2 pb-1 line-clamp-1 text-[0.8125rem] leading-relaxed text-muted-foreground/85">
          {segment.text}
        </p>
      )}

      {/* Expanded content */}
      <AnimatedCollapsible open={isActive || open}>
        <p
          className={`px-2 pt-0.5 pb-2 text-[0.8125rem] leading-relaxed ${
            isActive ? "text-foreground" : "text-foreground/85"
          }`}
        >
          {segment.text}
          {isActive && <span aria-hidden="true" className="typing-cursor" />}
        </p>
      </AnimatedCollapsible>
    </div>
  );
}
