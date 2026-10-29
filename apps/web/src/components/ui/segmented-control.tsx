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
  /** Draws a small primary dot after the label, flagging an option that holds content. */
  readonly marker?: boolean;
  /** Plain count drawn after the label. */
  readonly count?: number;
}

/**
 * Paper's segmented control heights: compact sits in pickers and dense rows, default in forms.
 * `small` is for the `pill` variant's in-card switches and reads as compact on the tray.
 */
export type SegmentedControlSize = "compact" | "default" | "small";

/** `tray` is the tinted picker control; `pill` is the rounded strip Project settings uses. */
export type SegmentedControlVariant = "tray" | "pill";

interface SegmentedControlProps {
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly size?: SegmentedControlSize;
  readonly variant?: SegmentedControlVariant;
  /** Stretches the tray to its container so segments share the width evenly. */
  readonly fill?: boolean;
  /** Draws a borderless strip of icon segments; each label stays as its segment's accessible name. */
  readonly iconOnly?: boolean;
  readonly "aria-label"?: string;
  readonly className?: string;
}

const TRAY_HEIGHT: Record<SegmentedControlSize, string> = {
  compact: "h-control-compact",
  default: "h-control-default",
  small: "h-control-compact",
};

const SEGMENT_HEIGHT: Record<SegmentedControlSize, string> = {
  compact: "h-7",
  default: "h-9",
  small: "h-7",
};

// Paper sizes the pill strip on its own scale; the 12px strip also drops to regular weight.
const PILL_TRAY: Record<SegmentedControlSize, string> = {
  default: "h-8",
  compact: "h-7",
  small: "h-[26px]",
};

const PILL_SEGMENT: Record<SegmentedControlSize, string> = {
  default: "h-7 px-3 text-body-small font-medium",
  compact: "h-6 px-3 text-body-small font-medium",
  small: "h-[22px] px-2.5 text-caption",
};

type Layout = SegmentedControlVariant | "icon";

function trayClass(layout: Layout, size: SegmentedControlSize): string {
  // An icon strip sits in a picker's tab row, so it drops the tray and packs tight to fit every provider.
  if (layout === "icon") return "shrink-0 gap-0.5";
  if (layout === "pill") return cn("gap-0.5 rounded-full bg-selected p-0.5", PILL_TRAY[size]);
  // Light --panel equals --background and light --field equals --page, so a solid fill vanishes on one
  // of them. An ink tint stays one step off any surface; the 2px inset keeps the corners concentric.
  return cn("gap-0.5 rounded-control bg-ink/[0.07] p-0.5", TRAY_HEIGHT[size]);
}

// Dark hover sits one step under selected, so a filled hover would read as a second choice.
const INACTIVE_TRAY_SEGMENT = "text-muted enabled:hover:text-ink";

const SEGMENT_BASE =
  "inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap transition-colors duration-(--duration-fast) ease-(--ease-standard)";

function segmentClass(layout: Layout, size: SegmentedControlSize, isActive: boolean, fill: boolean): string {
  if (layout === "icon") {
    return cn(SEGMENT_BASE, "h-7 w-[3rem] shrink-0 rounded-sm text-body-small", isActive ? "bg-selected font-medium text-ink" : INACTIVE_TRAY_SEGMENT);
  }
  if (layout === "pill") {
    return cn(SEGMENT_BASE, "rounded-full", fill ? "flex-1" : "shrink-0", PILL_SEGMENT[size], isActive ? "bg-border text-ink" : "text-muted enabled:hover:text-ink");
  }
  return cn(SEGMENT_BASE, "flex-1 rounded-md px-3 text-body-small", SEGMENT_HEIGHT[size], isActive ? "bg-ink/[0.07] font-medium text-ink" : INACTIVE_TRAY_SEGMENT);
}

/** Keeps a tooltip wrapper sized like the segment it holds. */
function tooltipWrapperClass(layout: Layout, fill: boolean): string {
  if (layout === "icon") return "flex min-w-0";
  return layout === "pill" && !fill ? "flex shrink-0" : "flex min-w-0 flex-1";
}

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
 * Paper's segmented control (AOT-0): a borderless tinted tray of equal segments where the chosen
 * one is filled. The `pill` variant swaps the tray for Paper's borderless rounded strip. It is a radio
 * group, so Tab enters it once and the arrow keys move the choice.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  size = "default",
  variant = "tray",
  fill = false,
  iconOnly = false,
  "aria-label": ariaLabel,
  className,
}: SegmentedControlProps) {
  const layout: Layout = iconOnly ? "icon" : variant;
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
          "items-center",
          trayClass(layout, size),
          fill ? "flex w-full" : "inline-flex",
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
                segmentClass(layout, size, isActive, fill),
                FOCUS_RING_CLASS,
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
                  {option.marker ? <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-primary" /> : null}
                  {option.count === undefined ? null : <span className="font-mono text-caption font-normal tabular-nums opacity-60">{option.count}</span>}
                </>
              )}
            </button>
          );

          if (!option.title) return <span key={option.value} className="contents">{segment}</span>;

          // Disabled buttons swallow pointer events, so the tooltip hangs off a wrapper instead.
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger render={<span className={tooltipWrapperClass(layout, fill)} />}>{segment}</TooltipTrigger>
              <TooltipContent>{option.title}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
