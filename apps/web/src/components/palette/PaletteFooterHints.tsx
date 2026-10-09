import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";

/** One footer hint: the keys that trigger an action and the action's name. */
export interface PaletteHint {
  readonly keys: readonly string[];
  readonly label: string;
}

/** The hints every list view shows. */
export const PALETTE_LIST_HINTS: readonly PaletteHint[] = [
  { keys: ["↑", "↓"], label: "Navigate" },
  { keys: ["Enter"], label: "Select" },
  { keys: ["Esc"], label: "Close" },
];

/**
 * The palette's bottom row of keyboard hints, with optional content pinned to the right.
 */
export function PaletteFooterHints({ hints, trailing }: { hints: readonly PaletteHint[]; trailing?: ReactNode }) {
  return (
    <div data-slot="palette-footer" className="mt-1 flex items-center gap-3 border-t border-border px-2.5 pt-2 pb-1">
      {hints.map((hint) => (
        <span key={hint.label} className="flex items-center gap-2 text-caption text-muted">
          <span className="flex items-center gap-1">
            {hint.keys.map((key) => (
              <Kbd key={key} variant="hint">
                {key}
              </Kbd>
            ))}
          </span>
          {hint.label}
        </span>
      ))}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  );
}
