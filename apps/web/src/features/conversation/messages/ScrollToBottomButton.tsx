import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Props for {@link ScrollToBottomButton}. */
export interface ScrollToBottomButtonProps {
  /** Whether new content arrived while the user was scrolled up. */
  hasNewContent: boolean;
  /** Moves the transcript to its newest row. */
  onScrollToBottom: () => void;
}

/** Floating control that returns a transcript reader to the newest row. */
export function ScrollToBottomButton({ hasNewContent, onScrollToBottom }: ScrollToBottomButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-compact"
      onClick={onScrollToBottom}
      className={`pointer-events-auto h-7 w-7 rounded-md border backdrop-blur-sm transition-colors ${
        hasNewContent
          ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/25"
          : "border-border/40 bg-background/80 text-muted/70 hover:bg-hover/40 hover:text-ink"
      }`}
      aria-label={hasNewContent ? "New messages below" : "Scroll to bottom"}
    >
      <ArrowDown size={13} />
    </Button>
  );
}
