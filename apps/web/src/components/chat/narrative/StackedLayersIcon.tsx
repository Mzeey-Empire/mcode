import type { SVGProps } from "react";

interface StackedLayersIconProps extends SVGProps<SVGSVGElement> {
  /**
   * When true, applies a gentle float + per-layer breathing ripple animation.
   * Used by the agent status bar to signal active sub-agent work. Honors
   * `prefers-reduced-motion` via CSS.
   */
  animated?: boolean;
}

/**
 * Isometric stack of three diamonds with opacity falloff.
 *
 * Used as the sub-agent glyph in the narrative timeline and persisted
 * tool record renderers. Reads as a packaged sub-context (not a branch,
 * not a robot). Stroke and fill follow `currentColor` so callers can
 * tint via Tailwind (`text-primary`, `text-muted-foreground`, etc).
 *
 * Pass `animated` to enable the running-agent shimmer animation defined
 * in `index.css` under `.stacked-layers-animated`.
 */
export function StackedLayersIcon({
  animated = false,
  className,
  ...props
}: StackedLayersIconProps) {
  const combinedClassName = [className ?? "", animated ? "stacked-layers-animated" : ""]
    .filter(Boolean)
    .join(" ") || undefined;
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      aria-hidden="true"
      className={combinedClassName}
      {...props}
    >
      <path d="M8 2 L14 5 L8 8 L2 5 Z" />
      <path d="M2 8 L8 11 L14 8" opacity="0.65" />
      <path d="M2 11 L8 14 L14 11" opacity="0.4" />
    </svg>
  );
}
