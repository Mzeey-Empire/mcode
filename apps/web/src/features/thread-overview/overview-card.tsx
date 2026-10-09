import { cn } from "@/lib/utils";
import type { OverviewPresentation } from "@/stores/overviewStore";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  OVERVIEW_SECTIONS,
  type OverviewEntry,
  type OverviewHeaderAction,
} from "./overview-registry";
import type { OverviewSubject } from "./overview-subject";
import "./overview-card.css";

/** Props for {@link OverviewCard}. */
export interface OverviewCardProps {
  subject: OverviewSubject;
  entries: readonly OverviewEntry[];
  headerActions: readonly OverviewHeaderAction[];
  presentation: Exclude<OverviewPresentation, "hidden">;
  className?: string;
  style?: CSSProperties;
}

/** Whether the scroller has content hidden below its bottom edge. */
function useMoreBelow() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setMoreBelow(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1);
  }, []);
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Rows expand and load in after mount, which changes the overflow without a scroll event.
    const observer = new ResizeObserver(measure);
    if (scrollerRef.current) observer.observe(scrollerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure]);
  return { scrollerRef, contentRef, moreBelow, measure };
}

/**
 * The Overview card: a header with the registered actions, then the registered entries grouped by
 * section. Sections with nothing to show, and the dividers around them, hide themselves in CSS.
 */
export function OverviewCard({ subject, entries, headerActions, presentation, className, style }: OverviewCardProps) {
  const { scrollerRef, contentRef, moreBelow, measure } = useMoreBelow();
  return (
    <div
      data-floating-card
      data-testid="thread-overview-card"
      data-presentation={presentation}
      className={cn("relative flex w-[28rem] flex-col overflow-hidden rounded-composer border border-border bg-panel text-ink", className)}
      style={style}
    >
      <div ref={scrollerRef} onScroll={measure} className="min-h-0 overflow-y-auto">
        <div ref={contentRef} className="flex flex-col gap-5 p-4">
          <div data-testid="thread-overview-card-header" className="flex h-8 shrink-0 items-center gap-1">
            <span className="min-w-0 flex-1 text-fade text-sm font-medium text-muted">Overview</span>
            {headerActions.map(({ id, Action }) => <Action key={id} subject={subject} />)}
          </div>
          {OVERVIEW_SECTIONS.map((section) => (
            <div key={section} data-overview-section={section} className="overview-section flex flex-col gap-1">
              {entries.filter((entry) => entry.section === section).map(({ id, Entry }) => (
                <div key={id} data-overview-entry={id} className="contents">
                  <Entry subject={subject} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {moreBelow ? (
        <div aria-hidden data-slot="overview-card-fade" className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-panel" />
      ) : null}
    </div>
  );
}
