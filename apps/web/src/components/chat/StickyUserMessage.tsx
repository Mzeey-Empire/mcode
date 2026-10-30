import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Approximate collapsed bar height (outer chrome, two-line preview, and footer
 * row). The transcript treats a prompt that scrolls above it as the one the bar stands in for.
 */
export const STICKY_USER_MESSAGE_ESTIMATED_HEIGHT = 90;

/** Props for {@link StickyUserMessage}. */
export interface StickyUserMessageProps {
  /** Plain-text preview of the prompt for the turn in view. */
  preview: string;
  /** When true, the chip is pinned above the scrolling transcript. */
  visible: boolean;
  /** Scrolls the transcript back to the original message bubble. */
  onJumpToMessage: () => void;
  /** Space reserved for Overview, shared with the transcript rows. */
  contentPaddingRight?: string;
}

/**
 * Sticky chip that keeps the current turn's prompt visible while users read
 * long assistant output below it in the transcript.
 */
export function StickyUserMessage({
  preview,
  visible,
  onJumpToMessage,
  contentPaddingRight,
}: StickyUserMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!visible) {
      // oxlint-disable-next-line react/set-state-in-effect -- A hidden sticky message must reopen collapsed.
      setExpanded(false);
    }
  }, [visible, preview]);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!visible || expanded || !text) return;
    const measure = () => setOverflows(text.scrollHeight > text.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [visible, expanded, preview]);

  const clamped = !expanded && overflows;
  const canToggle = overflows || expanded;

  if (!visible) {
    return null;
  }

  return (
    // The bar is opaque so rows scrolling under it, and the gaps around its card, stay hidden.
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-(--layer-sticky) bg-background px-4 pb-2 pt-1 sm:px-[var(--chat-gutter,--spacing(8))]"
      data-testid="sticky-user-message"
    >
      <div className="w-full" style={{ paddingRight: contentPaddingRight }}>
      <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "min-w-0")}>
        <div className="pointer-events-auto overflow-hidden rounded-lg bg-selected text-sm text-ink">
          <p
            ref={textRef}
            className={cn(
              "break-words px-3 pt-1.5 leading-5",
              expanded ? "max-h-40 overflow-y-auto whitespace-pre-wrap" : "max-h-[4.6rem] overflow-hidden",
              clamped && "[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]",
            )}
          >
            {preview}
          </p>
          <div className="flex items-center justify-end gap-0.5 px-1 pb-1">
            {canToggle && (
              <Button
                type="button"
                variant="ghost"
                size="compact"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="h-7 px-2 text-muted hover:bg-ink/5 hover:text-ink"
              >
                {expanded ? "Show less" : "Show full message"}
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-inline"
                    onClick={onJumpToMessage}
                    className="text-muted hover:bg-ink/5 hover:text-ink"
                    aria-label="Jump to your message"
                  >
                    <ArrowUp size={15} aria-hidden />
                  </Button>
                }
              />
              <TooltipContent side="bottom" sideOffset={6} className="text-xs">
                Jump to message
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
