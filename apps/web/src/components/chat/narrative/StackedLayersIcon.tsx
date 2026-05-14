import type { SVGProps } from "react";

/**
 * Isometric stack of three diamonds with opacity falloff.
 *
 * Used as the sub-agent glyph in the narrative timeline and persisted
 * tool record renderers. Reads as a packaged sub-context (not a branch,
 * not a robot). Stroke and fill follow `currentColor` so callers can
 * tint via Tailwind (`text-primary`, `text-muted-foreground`, etc).
 */
export function StackedLayersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 2 L14 5 L8 8 L2 5 Z" />
      <path d="M2 8 L8 11 L14 8" opacity="0.65" />
      <path d="M2 11 L8 14 L14 11" opacity="0.4" />
    </svg>
  );
}
