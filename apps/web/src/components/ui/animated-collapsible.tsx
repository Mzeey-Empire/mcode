import { type ReactNode, type TransitionEventHandler } from "react";

import { cn } from "@/lib/utils";

interface AnimatedCollapsibleProps {
  /** Whether the content is expanded. */
  open: boolean;
  /** Content to show/hide. */
  children: ReactNode;
  /** Additional class names on the outer grid container. */
  className?: string;
  /** Runs after the outer grid's height transition completes. */
  onTransitionEnd?: TransitionEventHandler<HTMLDivElement>;
}

/**
 * Smooth height animation using CSS grid-template-rows.
 * Transitions between 0fr (collapsed) and 1fr (expanded) using the shared motion tokens.
 */
export function AnimatedCollapsible({
  open,
  children,
  className,
  onTransitionEnd,
}: AnimatedCollapsibleProps) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-(--duration-standard) ease-(--ease-standard) motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      onTransitionEnd={onTransitionEnd}
    >
      <div
        className="min-h-0 overflow-hidden"
        aria-hidden={!open}
        inert={!open}
      >
        {children}
      </div>
    </div>
  );
}
