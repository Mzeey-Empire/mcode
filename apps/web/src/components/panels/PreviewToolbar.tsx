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
import { ICON_HIT_SLOP } from "@/lib/ui-hit-target";
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
  /** True once the guest WebContents has a real http(s) URL loaded. The
   *  capture / design affordances are gated on this: invoking them against
   *  an empty preview just surfaces a toast, so disable them upstream. */
  readonly hasLoadedPage: boolean;
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
  /** Toggle Design mode (opens or closes the DesignBar). Pick is owned by the
      DesignBar, so this is a pure mode toggle; it never starts an element-pick. */
  readonly onToggleDesign: () => void;
  /** Explicit exit-from-design-mode action, wired to the toolbar's right-side pill. */
  readonly onExitDesignMode: () => void;
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
 * toggle. The Design pill appears at the right whenever design mode is active
 * and serves as the always-visible Exit affordance; the DesignBar above the
 * omnibox owns the Pick interaction itself.
 */
export function PreviewToolbar({
  canBack,
  canFwd,
  captureBusy,
  regionBusy,
  elementPickBusy,
  threadId,
  hasLoadedPage,
  designModeActive,
  devDockOpen,
  devDockEdge,
  onGoBack,
  onGoForward,
  onReload,
  onOpenExternal,
  onAddPictureReference,
  onToggleDesign,
  onExitDesignMode,
  onToggleDevDock,
}: PreviewToolbarProps) {
  const designOn = designModeActive || elementPickBusy;
  const DockIcon = devDockEdge === "right" ? PanelRight : PanelBottom;

  return (
    // Outer gap-2 separates the three semantic groups (nav cluster, action
    // cluster, lone buttons) by spacing rather than visible dividers. The
    // dense editorial register of the app prefers proximity-as-grouping over
    // mid-row vertical rules. overflow-x-auto keeps narrow preview panels
    // usable without clipping the mode pills at the right edge.
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
      {/* Nav cluster - tightly packed */}
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", ICON_HIT_SLOP)}
                disabled={!canBack}
                onClick={onGoBack}
                aria-label="Back"
              >
                <ArrowLeft size={16} />
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
                size="icon-sm"
                className={cn("shrink-0", ICON_HIT_SLOP)}
                disabled={!canFwd}
                onClick={onGoForward}
                aria-label="Forward"
              >
                <ArrowRight size={16} />
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
                size="icon-sm"
                className={cn("shrink-0", ICON_HIT_SLOP)}
                disabled={!hasLoadedPage}
                onClick={onReload}
                aria-label="Reload"
              >
                <RotateCw size={16} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">
            Reload page
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Action cluster: Design (mode) + Screenshot (one-shot) */}
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-pressed={designOn}
                className={cn(
                  "shrink-0",
                  ICON_HIT_SLOP,
                  designOn && "bg-primary/10 text-primary",
                )}
                // The right-side Design pill is the only exit once the mode
                // is active; disable the left button so there are no two
                // routes for the same action (and no Fitts gripe from a
                // dual-affordance toolbar). Pressed visual stays so glance-
                // back mode awareness is preserved.
                disabled={!threadId || !hasLoadedPage || designModeActive}
                onClick={onToggleDesign}
                aria-label="Design"
              >
                {elementPickBusy ? (
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                ) : (
                  <PenTool size={16} aria-hidden />
                )}
              </Button>
            }
          />
          <TooltipContent
            side="top"
            sideOffset={6}
            // Viewport-aware cap so the tooltip never overflows off-screen when
            // the preview panel is docked narrow. min() falls back to the
            // intended 19rem on wide layouts and shrinks to fit on narrow ones.
            className="max-w-[min(19rem,calc(100vw-1.5rem))] text-xs"
          >
            Design: pick an element to attach to the chat
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "shrink-0",
                  ICON_HIT_SLOP,
                  captureBusy && "bg-primary/10 text-primary",
                )}
                disabled={captureBusy || regionBusy || elementPickBusy || !threadId || !hasLoadedPage}
                onClick={onAddPictureReference}
                aria-label="Screenshot"
              >
                {captureBusy ? (
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                ) : (
                  <Camera size={16} aria-hidden />
                )}
              </Button>
            }
          />
          <TooltipContent
            side="top"
            sideOffset={6}
            className="max-w-[min(16rem,calc(100vw-1.5rem))] text-xs"
          >
            Screenshot the visible viewport
          </TooltipContent>
        </Tooltip>
      </div>

      {/* External - lone, separated from the action cluster by parent gap-2 */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn("shrink-0", ICON_HIT_SLOP)}
              disabled={!hasLoadedPage}
              onClick={onOpenExternal}
              aria-label="Open in system browser"
            >
              <ExternalLink size={16} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Open in system browser
        </TooltipContent>
      </Tooltip>

      {/* Capture dock toggle. Houses region + page-context utilities the
          primary toolbar deliberately omits. Real Chrome DevTools for the
          guest page is opened separately via mod+shift+y. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={devDockOpen}
              className={cn(
                "shrink-0",
                ICON_HIT_SLOP,
                devDockOpen && "bg-muted text-foreground",
              )}
              onClick={onToggleDevDock}
              aria-label="Toggle capture tools"
            >
              <DockIcon size={16} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Capture tools (Ctrl+Shift+D)
        </TooltipContent>
      </Tooltip>

      {/* Mode pills: appear at right when design mode is active or a region
          drag is in flight. Pills share rounded-sm so the surface speaks one
          radius (matches the capture confirmation badge). The Design pill is
          the only mode-off affordance once active - the left toolbar button
          disables itself - so the X reads as the single exit, not a chip. */}
      {designModeActive ? (
        <>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Exit design mode"
                  className={cn(
                    "h-auto shrink-0 gap-1.5 rounded-sm border border-primary/30 bg-primary/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-primary",
                    "hover:bg-primary/15 hover:text-primary",
                  )}
                  onClick={onExitDesignMode}
                >
                  <PenTool size={14} aria-hidden />
                  <span>Design</span>
                  <X size={13} aria-hidden className="ml-0.5 opacity-70" />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={6} className="text-xs">
              Exit design mode
            </TooltipContent>
          </Tooltip>
        </>
      ) : regionBusy ? (
        <>
          <div className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Cancel capture"
            className={cn(
              "h-auto shrink-0 gap-1 rounded-sm border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive/80",
              "hover:bg-destructive/15 hover:text-destructive/80",
            )}
            onClick={() => void window.desktopBridge?.preview.cancelCapture()}
          >
            <kbd className="rounded-sm border border-destructive/15 bg-destructive/5 px-1 py-px text-[10px] font-medium">
              Esc
            </kbd>
            Cancel
          </Button>
        </>
      ) : null}
    </div>
  );
}
