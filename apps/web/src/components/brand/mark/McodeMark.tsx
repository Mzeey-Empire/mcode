import { useId, useMemo } from "react";
import { cn } from "@/lib/utils";
import { markSvg, type McodeMarkState } from "./mark-svg";

interface McodeMarkProps {
  readonly state: McodeMarkState;
  readonly className?: string;
}

/**
 * The Mcode mark drawn inline in one state. A state change replaces the markup, so a one-shot state
 * plays from its start; a re-render in the same state leaves the DOM alone.
 */
export function McodeMark({ state, className }: McodeMarkProps) {
  const prefix = useId().replace(/[^A-Za-z0-9_-]/g, "");
  // React rewrites innerHTML whenever this object's identity changes, which would restart a one-shot.
  const html = useMemo(() => ({ __html: markSvg(state, prefix) }), [state, prefix]);
  return <span className={cn("inline-flex", className)} dangerouslySetInnerHTML={html} />;
}
