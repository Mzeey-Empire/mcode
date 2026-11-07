import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@/lib/utils";

/** Props for {@link SteppedSlider}. */
export interface SteppedSliderProps {
  /** Index of the selected stop, from 0 to `stops - 1`, or -1 when no stop matches. */
  readonly value: number;
  /** Number of stops on the ladder, at least 2; one dot is drawn per stop. */
  readonly stops: number;
  readonly "aria-label": string;
  /** Spoken name of a stop, such as "High", in place of its index. */
  readonly getStopLabel: (index: number) => string;
  readonly onValueChange: (index: number) => void;
  readonly className?: string;
}

// Base UI places the thumb with `inset-inline-start` and the fill is sized with `width`, so
// transitioning both makes the thumb glide onto a stop instead of teleporting there.
const SNAP_MOTION_CLASS =
  "transition-[inset-inline-start,width] duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none";

function stopPercent(index: number, stops: number): number {
  return stops > 1 ? (index / (stops - 1)) * 100 : 0;
}

/**
 * A discrete slider for ordered levels such as reasoning effort. The thumb is edge-aligned so it
 * never overhangs the track, and the stop dots sit in a rail inset by half a thumb so each dot
 * lands under the thumb's centre at that stop.
 */
export function SteppedSlider({
  value,
  stops,
  "aria-label": ariaLabel,
  getStopLabel,
  onValueChange,
  className,
}: SteppedSliderProps) {
  const thumbStartFraction = Math.max(0, stopPercent(value, stops)) / 100;

  return (
    <SliderPrimitive.Root
      value={value}
      min={0}
      max={stops - 1}
      step={1}
      thumbAlignment="edge"
      onValueChange={(next) => {
        if (typeof next === "number" && next !== value) onValueChange(next);
      }}
      className={cn(
        "group/slider flex w-full touch-none select-none items-center [--slider-thumb-size:2rem]",
        className,
      )}
      data-slot="slider"
    >
      <SliderPrimitive.Control className="flex w-full cursor-pointer items-center py-[3px]">
        <SliderPrimitive.Track className="relative h-5 w-full rounded-full bg-selected dark:bg-control-border/30">
          {/* Base UI's Indicator ends at the thumb's centre, leaving the knob's right half outside the tint. This fill
              ends at the thumb's right edge instead, so the tint wraps the knob with the same 3px it is inset by. */}
          <span
            aria-hidden="true"
            className={cn("absolute inset-y-0 left-0 rounded-full bg-primary/26", SNAP_MOTION_CLASS)}
            style={{
              width: `calc((100% - var(--slider-thumb-size)) * ${thumbStartFraction} + var(--slider-thumb-size))`,
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[calc(var(--slider-thumb-size)/2)] right-[calc(var(--slider-thumb-size)/2)]"
          >
            {Array.from({ length: stops }, (_, index) => (
              <span
                key={index}
                className={cn(
                  "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                  index <= value ? "bg-primary/70" : "bg-muted/55",
                )}
                style={{ left: `${stopPercent(index, stops)}%` }}
              />
            ))}
          </span>
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            // Base UI clamps an unmatched -1 to the first stop; the controlled value keeps the real label.
            getAriaValueText={() => getStopLabel(value)}
            className={cn("group/thumb size-(--slider-thumb-size) rounded-full outline-none", SNAP_MOTION_CLASS)}
          >
            {/* The Thumb spans the track's height so it stays edge-aligned; the visible knob is a smaller disc
                inset 3px inside it. Press feedback scales this disc, not the Thumb: Base UI measures the Thumb's
                box to place it, so scaling the Thumb would shift it off its stop. The focus ring goes on the disc
                too, because `outline-none` on the Thumb sets the outline style every later outline width reads. */}
            <span
              aria-hidden="true"
              className="m-[3px] block size-3.5 rounded-full bg-primary transition-transform duration-(--duration-fast) ease-(--ease-standard) group-active/slider:scale-105 group-has-focus-visible/thumb:outline-2 group-has-focus-visible/thumb:outline-offset-2 group-has-focus-visible/thumb:outline-focus motion-reduce:transition-none"
            />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
