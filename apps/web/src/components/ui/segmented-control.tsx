import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { FOCUS_RING_CLASS } from "./focus-ring";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** One choice in a {@link SegmentedControl}. */
export interface SegmentedOption {
  /** Value passed to `onChange` when chosen. */
  readonly value: string;
  /** Visible label. */
  readonly label: string;
  /** Keeps the option listed and dimmed but not choosable. */
  readonly disabled?: boolean;
  /** Icon drawn before the label. */
  readonly icon?: ReactNode;
  /** Tooltip text, typically the reason a disabled option is unavailable. */
  readonly title?: string;
}

/** Paper's segmented control heights: compact sits in pickers and dense rows, default in forms. */
export type SegmentedControlSize = "compact" | "default";

interface SegmentedControlProps {
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly size?: SegmentedControlSize;
  /** Stretches the tray to its container so segments share the width evenly. */
  readonly fill?: boolean;
  /** Draws each segment as its icon alone; the label stays as the segment's accessible name. */
  readonly iconOnly?: boolean;
  readonly "aria-label"?: string;
  readonly className?: string;
}

const TRAY_HEIGHT: Record<SegmentedControlSize, string> = {
  compact: "h-control-compact",
  default: "h-control-default",
};

const SEGMENT_HEIGHT: Record<SegmentedControlSize, string> = {
  compact: "h-6",
  default: "h-8",
};

const NEXT_KEYS: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Index of the enabled option reached from `from` by `key`, or `null` when the key does not move.
 * Arrows wrap around and skip disabled options, matching the WAI-ARIA radio group pattern.
 */
function nextEnabledIndex(options: readonly SegmentedOption[], from: number, key: string): number | null {
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0] ?? null;
  if (key === "End") return enabled.at(-1) ?? null;
  const step = NEXT_KEYS[key];
  if (step === undefined) return null;
  const position = enabled.indexOf(from);
  const start = position === -1 ? (step === 1 ? -1 : 0) : position;
  return enabled[(start + step + enabled.length) % enabled.length] ?? null;
}

/**
 * Paper's segmented control (AOT-0): a bordered tray of equal segments where the chosen one is
 * filled. It is a radio group, so Tab enters it once and the arrow keys move the choice.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  size = "default",
  fill = false,
  iconOnly = false,
  "aria-label": ariaLabel,
  className,
}: SegmentedControlProps) {
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = options.findIndex((option) => option.value === value);
  // A disabled button can't take focus, so with no enabled match the first enabled segment takes the tab stop.
  const tabStopIndex =
    activeIndex !== -1 && !options[activeIndex]?.disabled ? activeIndex : options.findIndex((option) => !option.disabled);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Move from the focused segment: with a disabled choice, focus sits on a different segment than the value.
    const focusedIndex = segmentRefs.current.findIndex((segment) => segment === document.activeElement);
    const from = focusedIndex !== -1 ? focusedIndex : activeIndex;
    const next = nextEnabledIndex(options, from, event.key);
    const option = next === null ? undefined : options[next];
    if (next === null || option === undefined) return;
    event.preventDefault();
    segmentRefs.current[next]?.focus();
    // Compare against where the move started, not `value`: an async owner may not have applied the last move yet.
    if (next !== from) onChange(option.value);
  };

  return (
    <TooltipProvider>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className={cn(
          "items-center gap-2 rounded-control border border-control-border bg-panel p-[3px]",
          fill ? "flex w-full" : "inline-flex",
          TRAY_HEIGHT[size],
          className,
        )}
      >
        {options.map((option, index) => {
          const isActive = index === activeIndex;
          const segment = (
            <button
              ref={(node) => {
                segmentRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={option.disabled}
              tabIndex={index === tabStopIndex ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cn(
                "inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent text-body-small transition-colors duration-(--duration-fast) ease-(--ease-standard)",
                iconOnly ? "w-[3rem] shrink-0" : "flex-1 px-2",
                SEGMENT_HEIGHT[size],
                FOCUS_RING_CLASS,
                isActive
                  ? "bg-selected font-medium text-ink"
                  : "text-muted enabled:hover:border-muted enabled:hover:bg-hover enabled:hover:text-ink",
                option.disabled && "cursor-not-allowed opacity-50",
              )}
            >
              {iconOnly ? (
                <>
                  <span aria-hidden className="contents">{option.icon}</span>
                  <span className="sr-only">{option.label}</span>
                </>
              ) : (
                <>
                  {option.icon}
                  {option.label}
                </>
              )}
            </button>
          );

          if (!option.title) return <span key={option.value} className="contents">{segment}</span>;

          // Disabled buttons swallow pointer events, so the tooltip hangs off a wrapper instead.
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger render={<span className={cn("flex min-w-0", !iconOnly && "flex-1")} />}>{segment}</TooltipTrigger>
              <TooltipContent>{option.title}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
