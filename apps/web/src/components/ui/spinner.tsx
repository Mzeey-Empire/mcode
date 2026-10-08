import type { CSSProperties, HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** Spinner diameters on the 4px scale (DESIGN.md, decision D5). */
export type SpinnerSize = 12 | 16 | 20;

type SpinnerStyle = CSSProperties & {
  "--spinner-size"?: string;
};

interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
}

/** Renders the shared faded-tail loading spinner used across the app. */
function Spinner({ size = 12, className, style, "aria-label": ariaLabel, ...props }: SpinnerProps) {
  const spinnerStyle: SpinnerStyle = {
    "--spinner-size": `${size}px`,
    ...style,
  };

  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      className={cn("spinner-tail-fade status-spin shrink-0", className)}
      style={spinnerStyle}
      {...props}
    />
  );
}

export { Spinner };
