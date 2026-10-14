import { ChevronLeft, ChevronRight } from "lucide-react";

/** Props for {@link ApprovalPager}. */
export interface ApprovalPagerProps {
  readonly index: number;
  readonly count: number;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  /** What is being paged, for the screen-reader labels. */
  readonly noun?: string;
}

const STEP_CLASS = "-my-1.5 flex size-8 items-center justify-center rounded-full text-muted hover:text-ink disabled:pointer-events-none disabled:opacity-45";

/** "‹ 2 of 3 ›" with 32px hit areas around 14px glyphs; `[` and `]` do the same from the keyboard. */
export function ApprovalPager({ index, count, onPrevious, onNext, noun = "request" }: ApprovalPagerProps) {
  return (
    <div className="flex shrink-0 items-center">
      <button type="button" tabIndex={-1} aria-label={`Previous ${noun}`} className={STEP_CLASS} disabled={index === 0} onClick={onPrevious}>
        <ChevronLeft size={14} />
      </button>
      <span className="text-xs text-muted">{index + 1} of {count}</span>
      <button type="button" tabIndex={-1} aria-label={`Next ${noun}`} className={STEP_CLASS} disabled={index === count - 1} onClick={onNext}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
