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

// Base UI places the thumb with `inset-inline-start` and sizes the fill with `width`, so
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
  const valuePercent = stopPercent(value, stops);

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
        "flex w-full touch-none select-none items-center [--slider-thumb-size:2rem]",
        className,
      )}
      data-slot="slider"
    >
      <SliderPrimitive.Control className="flex w-full cursor-pointer items-center py-0.5">
        <SliderPrimitive.Track className="relative h-6 w-full rounded-full border border-control-border bg-panel">
          {/* At the first stop the fill sits wholly under the thumb, yet anti-aliasing leaves a
              sliver showing at the shared left edge, so it is hidden there instead. */}
          <SliderPrimitive.Indicator
            className={cn("rounded-full bg-primary", SNAP_MOTION_CLASS, valuePercent <= 0 && "opacity-0")}
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
                  index <= value ? "bg-primary-ink/60" : "bg-muted/60",
                )}
                style={{ left: `${stopPercent(index, stops)}%` }}
              />
            ))}
          </span>
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            // Base UI clamps an unmatched -1 to the first stop; the controlled value keeps the real label.
            getAriaValueText={() => getStopLabel(value)}
            className={cn(
              "size-(--slider-thumb-size) rounded-full border border-control-border bg-field outline-none has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus",
              SNAP_MOTION_CLASS,
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
