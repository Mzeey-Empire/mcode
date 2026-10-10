import { ArrowDown } from "lucide-react";

/** Props for {@link JumpToLatestPill}. */
export interface JumpToLatestPillProps {
  /** Moves the transcript to its newest row. */
  readonly onJumpToLatest: () => void;
}

/** Neutral pill that returns a reader who scrolled away from the tail to the newest row. */
export function JumpToLatestPill({ onJumpToLatest }: JumpToLatestPillProps) {
  return (
    <button
      type="button"
      onClick={onJumpToLatest}
      className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-selected pr-3 pl-2.5 text-xs font-medium text-ink shadow-floating focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
    >
      <ArrowDown size={14} aria-hidden />
      Jump to latest
    </button>
  );
}
