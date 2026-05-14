import { useState, lazy, Suspense } from "react";
import type { ThoughtSegment } from "./types";

const LazyMarkdownContent = lazy(() => import("../MarkdownContent"));

/** Character threshold above which the body clamps and exposes `show more`. */
const CLAMP_THRESHOLD = 220;

interface ThoughtBlockProps {
  segment: ThoughtSegment;
  isActive: boolean;
}

/**
 * Renders a single thought segment as an inline row in the narrative timeline.
 *
 * Layout: a 2-column grid with a mono small-cap `THOUGHT` label in the left
 * column and the italic reasoning text on the right. Long thoughts clamp to
 * 2 lines and expose a `show more` button. Active thoughts brighten the label
 * and body colors; the dot pulse is rendered by `NarrativeFlow`.
 */
export function ThoughtBlock({ segment, isActive }: ThoughtBlockProps) {
  const isLong = segment.text.length >= CLAMP_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const shouldClamp = !isActive && isLong && !expanded;

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 items-start px-2 py-1">
      <span
        className={[
          "font-mono uppercase select-none pt-[2px]",
          "text-[0.59375rem] tracking-[0.18em]",
          isActive ? "text-primary" : "text-muted-foreground/40",
        ].join(" ")}
      >
        thought
      </span>

      <div className="min-w-0">
        <div
          className={[
            "text-[0.78125rem] leading-relaxed italic",
            isActive ? "text-foreground/90" : "text-muted-foreground/85",
            shouldClamp ? "line-clamp-2" : "",
          ].join(" ")}
        >
          <Suspense
            fallback={<span className="whitespace-pre-wrap">{segment.text}</span>}
          >
            <LazyMarkdownContent content={segment.text} isStreaming={isActive} />
          </Suspense>
        </div>

        {!isActive && isLong && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="mt-1 font-mono text-[0.625rem] tracking-[0.1em] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>
    </div>
  );
}
