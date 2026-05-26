import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Loader2,
  PanelBottom,
  PanelRight,
  PenTool,
  RotateCw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

/** Edge the dev dock attaches to in the preview surface. */
export type DevDockEdge = "bottom" | "right";

/** Props for the presentational preview toolbar row. */
export interface PreviewToolbarProps {
  readonly canBack: boolean;
  readonly canFwd: boolean;
  readonly captureBusy: boolean;
  readonly regionBusy: boolean;
  readonly elementPickBusy: boolean;
  readonly contextBusy: boolean;
  readonly anyCaptureActive: boolean;
  readonly threadId: string;
  /** True while design mode is engaged (DesignBar visible, pick affordance armable). */
  readonly designModeActive: boolean;
  /** True while the dev dock is open at its persisted edge. */
  readonly devDockOpen: boolean;
  /** Persisted edge for the dev dock; controls which lucide glyph appears on the toggle. */
  readonly devDockEdge: DevDockEdge;
  readonly onGoBack: () => void;
  readonly onGoForward: () => void;
  readonly onReload: () => void;
  readonly onOpenExternal: () => void;
  /** Capture-the-whole-viewport screenshot. The everyday secondary action. */
  readonly onAddPictureReference: () => void;
  /** Toggle Design mode. In transitional Phase 1 this also fires the element-pick session
      so the feature keeps working until the DesignBar owns the Pick affordance. */
  readonly onToggleDesign: () => void;
  /** Toggle the dev dock open/closed. */
  readonly onToggleDevDock: () => void;
  /** Region-crop handler. Wired in Phase 4 from the dev dock; retained here as
      a prop so the capture hook stays unchanged through the refactor. */
  readonly onAddRegionPictureReference: () => void;
  /** Element-pick handler. Phase 3 moves this into the DesignBar; retained for now. */
  readonly onAddElementPickPictureReference: () => void;
  /** Page-context dump handler. Phase 5 moves this into the dev dock. */
  readonly onAddPageContextOnly: () => void;
}

/**
 * Presentational toolbar for the browser preview panel. Three primary actions:
 * Design (mode toggle), Screenshot (one-shot viewport capture), and the dev dock
 * toggle. The Design pill appears at the right while an element-pick session is
 * in flight (the in-guest highlight handles the rest of the visual feedback).
 */
export function PreviewToolbar({
  canBack,
  canFwd,
  captureBusy,
  regionBusy,
  elementPickBusy,
  threadId,
  designModeActive,
  devDockOpen,
  devDockEdge,
  onGoBack,
  onGoForward,
  onReload,
  onOpenExternal,
  onAddPictureReference,
  onToggleDesign,
  onToggleDevDock,
}: PreviewToolbarProps) {
  const designOn = designModeActive || elementPickBusy;
  const DockIcon = devDockEdge === "right" ? PanelRight : PanelBottom;

  return (
    <div className="flex min-w-0 items-center">
      {/* Nav cluster */}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                disabled={!canBack}
                onClick={onGoBack}
                aria-label="Back"
              >
                <ArrowLeft size={14} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Navigate back
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                disabled={!canFwd}
                onClick={onGoForward}
                aria-label="Forward"
              >
                <ArrowRight size={14} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Navigate forward
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                onClick={onReload}
                aria-label="Reload"
              >
                <RotateCw size={14} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Reload page
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

      {/* Action cluster: Design (mode) + Screenshot (one-shot) */}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-pressed={designOn}
                className={cn(
                  "shrink-0",
                  designOn && "bg-primary/10 text-primary",
                )}
                disabled={!threadId}
                onClick={onToggleDesign}
                aria-label="Design"
              >
                {elementPickBusy ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <PenTool size={14} aria-hidden />
                )}
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="max-w-[19rem] text-xs">
            Design — pick an element to attach to the chat
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "shrink-0",
                  captureBusy && "bg-primary/10 text-primary",
                )}
                disabled={captureBusy || regionBusy || elementPickBusy || !threadId}
                onClick={onAddPictureReference}
                aria-label="Screenshot"
              >
                {captureBusy ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <Camera size={14} aria-hidden />
                )}
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="max-w-[16rem] text-xs">
            Screenshot the visible viewport
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

      {/* External */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              onClick={onOpenExternal}
              aria-label="Open in system browser"
            >
              <ExternalLink size={14} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Open in system browser
        </TooltipContent>
      </Tooltip>

      <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

      {/* Dev dock toggle */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-pressed={devDockOpen}
              className={cn(
                "shrink-0",
                devDockOpen && "bg-muted text-foreground",
              )}
              onClick={onToggleDevDock}
              aria-label="Toggle dev tools"
            >
              <DockIcon size={14} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Dev tools (Ctrl+Shift+D)
        </TooltipContent>
      </Tooltip>

      {/* Design pill: appears at right while element-pick is in flight.
          The pick session runs inside the guest page (no overlay window),
          so this pill is the only chrome affordance for the active mode. */}
      {elementPickBusy ? (
        <>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Exit design mode"
            title="Exit design mode (Esc)"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15"
            onClick={() => void window.desktopBridge?.preview.cancelCapture()}
          >
            <PenTool size={12} aria-hidden />
            Design
            <span className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary/15 text-primary hover:bg-primary/25">
              <X size={10} aria-hidden />
            </span>
          </button>
        </>
      ) : regionBusy ? (
        <>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Cancel capture"
            className="flex shrink-0 items-center gap-1 rounded border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive/80 transition-colors hover:bg-destructive/15"
            onClick={() => void window.desktopBridge?.preview.cancelCapture()}
          >
            <kbd className="rounded border border-destructive/15 bg-destructive/5 px-1 py-px text-[10px] font-medium">
              Esc
            </kbd>
            Cancel
          </button>
        </>
      ) : null}
    </div>
  );
}
