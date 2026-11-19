import { useState } from "react";

interface RangeControlProps {
  /** Minimum slider value. */
  min: number;
  /** Maximum slider value. */
  max: number;
  /** Step increment. */
  step?: number;
  /** Current persisted value from the store. */
  value: number;
  /** Called with the final value when the user finishes dragging. */
  onCommit: (value: number) => void;
  /** Optional formatter for the displayed value (e.g. append " MB"). */
  formatValue?: (value: number) => string;
  /** Accessible name for the range input. */
  ariaLabel?: string;
}

/**
 * Themed range slider that defers store writes until the drag ends.
 * Local state tracks the in-progress value to avoid RPC on every pixel.
 */
export function RangeControl({
  min,
  max,
  step = 1,
  value,
  onCommit,
  formatValue,
  ariaLabel,
}: RangeControlProps) {
  const [local, setLocal] = useState<number | null>(null);
  const display = local ?? value;
  const formatted = formatValue ? formatValue(display) : display.toLocaleString();

  const commit = (v: number) => {
    setLocal(null);
    onCommit(v);
  };

  const handlePointerCommit = (e: React.SyntheticEvent<HTMLInputElement>) =>
    commit(Number(e.currentTarget.value));

  const VALUE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

  const fraction = max > min ? (display - min) / (max - min) : 0;

  return (
    <div className="flex items-center gap-3">
      {/* The track and fill are spans under a see-through input, because a gradient fill ends in a square cut beside
          the round knob. This fill ends at the thumb box's right edge with a full round end, so it wraps the knob
          with the same 3px it is inset by, as the composer's SteppedSlider does. */}
      <span className="relative flex h-5 w-40 items-center">
        <span aria-hidden="true" className="absolute inset-0 rounded-full bg-selected dark:bg-control-border/30" />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-full bg-primary/26"
          style={{ width: `calc((100% - 2rem) * ${fraction} + 2rem)` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={display}
          aria-label={ariaLabel}
          onChange={(e) => setLocal(Number(e.target.value))}
          onMouseUp={handlePointerCommit}
          onKeyUp={(e) => { if (VALUE_KEYS.has(e.key)) commit(Number(e.currentTarget.value)); }}
          onTouchEnd={() => { if (local !== null) commit(local); }}
          className="settings-range relative w-full"
        />
      </span>
      <span className="min-w-12 text-right text-body-small text-ink tabular-nums">
        {formatted}
      </span>
    </div>
  );
}
