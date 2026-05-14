import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import type { ThoughtSegment } from "./types";

const LONG_THRESHOLD = 200;

interface ThoughtBlockProps {
  segment: ThoughtSegment;
  isActive: boolean;
}

/**
 * Renders a thought segment in the narrative timeline.
 * Short thoughts start open. Long thoughts collapse to a single truncated line.
 * Active thoughts show a typing cursor and primary-tinted background.
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  const isLong = segment.text.length >= LONG_THRESHOLD;
  const [open, setOpen] = useState(!isLong);

  const durationSec =
    segment.endedAt != null
      ? Math.round((segment.endedAt - segment.startedAt) / 1000)
      : null;

  const handleToggle = () => { if (!isActive) setOpen((o) => !o); };

  return (
    <div className={isActive ? "bg-primary/7 rounded-md" : ""}>
      {/* Clickable header - just duration + chevron, no label */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={isActive}
        className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left select-none"
        aria-expanded={isActive || open}
      >
        {durationSec != null && (
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground/40">
            {durationSec}s
          </span>
        )}
        <ChevronRight
          className={`ml-auto h-3 w-3 text-muted-foreground/30 transition-transform duration-150 ${
            isActive || open ? "rotate-90" : ""
          }`}
        />
      </button>

      {/* Collapsed preview for long thoughts */}
      {!isActive && isLong && !open && (
        <p className="px-2 pb-1 line-clamp-1 text-[0.8125rem] leading-relaxed text-muted-foreground/70">
          {segment.text}
        </p>
      )}

      {/* Full text */}
      <AnimatedCollapsible open={isActive || open}>
        <p className={`px-2 pb-2 text-[0.8125rem] leading-relaxed ${
          isActive ? "text-foreground" : "text-foreground/85"
        }`}>
          {segment.text}
          {isActive && <span aria-hidden="true" className="typing-cursor" />}
        </p>
      </AnimatedCollapsible>
    </div>
  );
}
