import { PanelBottom, PanelRight, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import type { PreviewDockEdge } from "@/stores/previewDockStore";

/** Props for the dev dock chrome. The dock is a presentational shell; rows that
 *  call into capture handlers land in later phases. */
export interface PreviewDevDockProps {
  /** Persisted edge the dock attaches to (bottom or right). */
  readonly edge: PreviewDockEdge;
  /** Flip the persisted edge. */
  readonly onChangeEdge: (edge: PreviewDockEdge) => void;
  /** Close the dock. */
  readonly onClose: () => void;
}

/**
 * Dev dock chrome for the preview panel. A DevTools-style dockable surface
 * (bottom or right edge) that houses power-user rows the primary toolbar
 * intentionally omits. Phase 2 ships the shell + edge toggle + close. Region
 * capture (Phase 4) and page-context dump (Phase 5) attach as content rows.
 *
 * Sizing is handled by the parent flex container; this component fills its
 * available cell. Header uses the editorial mono small-caps treatment from
 * the project aesthetic.
 */
export function PreviewDevDock({
  edge,
  onChangeEdge,
  onClose,
}: PreviewDevDockProps) {
  const OppositeEdgeIcon = edge === "right" ? PanelBottom : PanelRight;
  const oppositeEdge: PreviewDockEdge = edge === "right" ? "bottom" : "right";
  const oppositeLabel = oppositeEdge === "right" ? "Dock to right" : "Dock to bottom";

  return (
    <div
      data-testid="preview-dev-dock"
      data-edge={edge}
      role="region"
      aria-label="Preview developer tools"
      className={cn(
        "flex min-h-0 min-w-0 flex-col border-border/40 bg-muted/5",
        edge === "bottom" ? "border-t" : "border-l",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/30 px-2 py-1">
        <Wrench size={11} aria-hidden className="text-muted-foreground/60" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
          dev tools
        </span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onChangeEdge(oppositeEdge)}
                aria-label={oppositeLabel}
              >
                <OppositeEdgeIcon size={13} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            {oppositeLabel}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onClose}
                aria-label="Close dev tools"
              >
                <X size={13} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Close dev tools
          </TooltipContent>
        </Tooltip>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-6 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
          surface ready
        </span>
        <p className="max-w-[18rem] text-balance text-[11px] leading-snug text-muted-foreground/60">
          Region capture and page-context tools attach here as later phases land.
        </p>
      </div>
    </div>
  );
}
