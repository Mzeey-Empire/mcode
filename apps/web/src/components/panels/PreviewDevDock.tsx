import {
  Camera,
  FileText,
  Loader2,
  PanelBottom,
  PanelRight,
  SquareDashedMousePointer,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import type { PreviewDockEdge } from "@/stores/previewDockStore";

/** Props for the capture dock chrome and its content rows. */
export interface PreviewDevDockProps {
  /** Persisted edge the dock attaches to (bottom or right). */
  readonly edge: PreviewDockEdge;
  /** Flip the persisted edge. */
  readonly onChangeEdge: (edge: PreviewDockEdge) => void;
  /** Close the dock. */
  readonly onClose: () => void;
  /** Thread id; rows disable themselves when this is empty so we never fire a
   *  capture against a non-existent attachment queue. */
  readonly threadId: string;
  /** True once the guest WebContents has a real http(s) URL loaded. Region
   *  and page-context capture against an empty preview just surface a toast,
   *  so the rows go disabled until a page is loaded. */
  readonly hasLoadedPage: boolean;
  /** True while a region drag-marquee is in flight in the guest page. */
  readonly regionBusy: boolean;
  /** Fires the region-capture session (handled by usePreviewCapture). */
  readonly onAddRegionPictureReference: () => void;
  /** True while a page-context dump is in progress. */
  readonly contextBusy: boolean;
  /** Captures structured page context (selectors, console buffer, failed
   *  requests) without a screenshot. */
  readonly onAddPageContextOnly: () => void;
}

/**
 * Capture dock for the preview panel. A DevTools-style dockable surface
 * (bottom or right edge) that houses capture utilities the primary toolbar
 * intentionally omits. Houses two rows today: region drag-marquee and
 * page-context dump. Real Chrome DevTools for the guest page is available
 * separately via the mod+shift+y shortcut.
 *
 * Sizing is handled by the parent flex container; this component fills its
 * available cell. The header uses the editorial mono small-caps treatment
 * from the project aesthetic; rows are flat, button-styled, no card chrome.
 */
export function PreviewDevDock({
  edge,
  onChangeEdge,
  onClose,
  threadId,
  hasLoadedPage,
  regionBusy,
  onAddRegionPictureReference,
  contextBusy,
  onAddPageContextOnly,
}: PreviewDevDockProps) {
  const OppositeEdgeIcon = edge === "right" ? PanelBottom : PanelRight;
  const oppositeEdge: PreviewDockEdge = edge === "right" ? "bottom" : "right";
  const oppositeLabel = oppositeEdge === "right" ? "Dock to right" : "Dock to bottom";
  // Mono small-caps hint sits next to the icon so the panel-edge glyph is legible
  // without a tooltip hover. The tooltip still carries the full label for AT.
  const oppositeShortLabel = oppositeEdge === "right" ? "right" : "bottom";
  const regionDisabled = regionBusy || !threadId || !hasLoadedPage;
  const contextDisabled = contextBusy || !threadId || !hasLoadedPage;

  return (
    <div
      data-testid="preview-dev-dock"
      data-edge={edge}
      role="region"
      aria-label="Preview capture tools"
      className={cn(
        "flex min-h-0 min-w-0 flex-col border-border/40 bg-muted/5",
        edge === "bottom" ? "border-t" : "border-l",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/30 px-2 py-1">
        <Camera size={11} aria-hidden className="text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          capture
        </span>
        <div className="flex-1" />
        <span
          aria-hidden
          // The arrow makes the label read as the click action ("\u2192 right")
          // not the current state ("currently right"). Important because the
          // label sits next to the flip-edge button, which would otherwise
          // read as labelling the wrong thing.
          className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80"
        >
          {"\u2192 "}
          {oppositeShortLabel}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onChangeEdge(oppositeEdge)}
                aria-label={oppositeLabel}
              >
                <OppositeEdgeIcon size={16} aria-hidden />
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
                size="icon-sm"
                onClick={onClose}
                aria-label="Close capture tools"
              >
                <X size={16} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Close capture tools
          </TooltipContent>
        </Tooltip>
      </header>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-1.5">
        <Button
          type="button"
          variant="ghost"
          data-testid="preview-dev-dock-region"
          disabled={regionDisabled}
          onClick={onAddRegionPictureReference}
          aria-busy={regionBusy}
          className={cn(
            "group h-auto w-full items-center justify-start gap-2.5 rounded-sm px-1.5 py-1.5 text-left font-normal",
            "hover:bg-muted/60",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded border border-border/40 bg-muted/30 text-muted-foreground transition-colors",
              !regionDisabled && "group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary",
              regionBusy && "border-primary/30 bg-primary/10 text-primary",
            )}
            aria-hidden
          >
            {regionBusy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <SquareDashedMousePointer size={13} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[11px] font-medium text-foreground/90">
              {regionBusy ? "Selecting region…" : "Region capture"}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              {regionBusy
                ? "Drag on the page · Esc to cancel"
                : "Drag a rectangle on the page to attach as PNG"}
            </span>
          </span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          data-testid="preview-dev-dock-context"
          disabled={contextDisabled}
          onClick={onAddPageContextOnly}
          aria-busy={contextBusy}
          className={cn(
            "group h-auto w-full items-center justify-start gap-2.5 rounded-sm px-1.5 py-1.5 text-left font-normal",
            "hover:bg-muted/60",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded border border-border/40 bg-muted/30 text-muted-foreground transition-colors",
              !contextDisabled && "group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary",
              contextBusy && "border-primary/30 bg-primary/10 text-primary",
            )}
            aria-hidden
          >
            {contextBusy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <FileText size={13} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[11px] font-medium text-foreground/90">
              {contextBusy ? "Collecting context…" : "Page context"}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              {contextBusy
                ? "Reading DOM, console, and failed requests"
                : "Attach structured page context (no screenshot)"}
            </span>
          </span>
        </Button>
      </div>
    </div>
  );
}
