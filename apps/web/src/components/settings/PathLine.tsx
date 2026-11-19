import { useState } from "react";
import { createTooltipHandle, Tooltip, TooltipContent, TooltipTrigger, type TooltipHandle } from "@/components/ui/tooltip";

/** Creates one tooltip handle that every {@link PathLine} in a list shares, kept for the component's lifetime. */
export function usePathTooltip(): TooltipHandle<string> {
  const [handle] = useState(() => createTooltipHandle<string>());
  return handle;
}

/** The one tooltip root for a list's path lines; it shows the full path of the hovered line. */
export function PathTooltipRoot({ handle }: { readonly handle: TooltipHandle<string> }) {
  return (
    <Tooltip handle={handle}>
      {({ payload }) => (payload ? <TooltipContent side="top" align="start" className="font-mono">{payload}</TooltipContent> : null)}
    </Tooltip>
  );
}

/**
 * A file path in mono: the file name first in ink, then its folder muted and fading at the right edge,
 * so the file name always shows. The full path is the line's accessible name and its tooltip.
 */
export function PathLine({ path, tooltip, "data-testid": testId }: { readonly path: string; readonly tooltip: TooltipHandle<string>; readonly "data-testid"?: string }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = path.slice(cut + 1);
  const dir = cut < 0 ? "" : path.slice(0, cut);
  return <TooltipTrigger handle={tooltip} payload={path} render={
    <span aria-label={path} data-testid={testId} className="flex min-w-0 gap-2 font-mono text-caption [font-variant-ligatures:none]">
      <span className="shrink-0 text-ink">{file}</span>
      {dir && <span className="text-fade text-muted">{dir}</span>}
    </span>
  } />;
}
