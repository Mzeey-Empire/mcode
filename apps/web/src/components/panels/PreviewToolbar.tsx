import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Crop,
  ExternalLink,
  FileText,
  ImagePlus,
  Loader2,
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
  readonly onGoBack: () => void;
  readonly onGoForward: () => void;
  readonly onReload: () => void;
  readonly onOpenExternal: () => void;
  readonly onAddPictureReference: () => void;
  readonly onAddRegionPictureReference: () => void;
  readonly onAddElementPickPictureReference: () => void;
  readonly onAddPageContextOnly: () => void;
}

/**
 * Presentational toolbar with navigation, capture, and external-open buttons
 * for the browser preview panel. Includes a cancel pill during region/element-pick capture.
 */
export function PreviewToolbar({
  canBack,
  canFwd,
  captureBusy,
  regionBusy,
  elementPickBusy,
  contextBusy,
  anyCaptureActive,
  threadId,
  onGoBack,
  onGoForward,
  onReload,
  onOpenExternal,
  onAddPictureReference,
  onAddRegionPictureReference,
  onAddElementPickPictureReference,
  onAddPageContextOnly,
}: PreviewToolbarProps) {
  return (
    <div className="flex min-w-0 items-center">
      {/* Navigation group */}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" disabled={!canBack} onClick={onGoBack} aria-label="Back">
                <ArrowLeft size={14} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">Navigate back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" disabled={!canFwd} onClick={onGoForward} aria-label="Forward">
                <ArrowRight size={14} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">Navigate forward</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" onClick={onReload} aria-label="Reload">
                <RotateCw size={14} />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="text-xs">Reload page</TooltipContent>
        </Tooltip>
      </div>

      {/* Separator: nav | capture */}
      <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

      {/* Capture group */}
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn("shrink-0", regionBusy && "bg-primary/10 text-primary")}
                disabled={anyCaptureActive || !threadId}
                onClick={onAddRegionPictureReference}
                aria-label="Crop region"
              >
                {regionBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Crop size={14} aria-hidden />}
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="max-w-[18rem] text-xs">
            Drag to select a region and attach as PNG
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn("shrink-0", elementPickBusy && "bg-primary/10 text-primary")}
                disabled={anyCaptureActive || !threadId}
                onClick={onAddElementPickPictureReference}
                aria-label="Pick element"
              >
                {elementPickBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Crosshair size={14} aria-hidden />}
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="max-w-[19rem] text-xs">
            Hover to highlight, click to attach element crop and context
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn("shrink-0", captureBusy && "bg-primary/10 text-primary")}
                disabled={anyCaptureActive || !threadId}
                onClick={onAddPictureReference}
                aria-label="Capture viewport"
              >
                {captureBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ImagePlus size={14} aria-hidden />}
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="max-w-[16rem] text-xs">
            Capture full viewport as PNG
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn("shrink-0", contextBusy && "bg-primary/10 text-primary")}
                disabled={anyCaptureActive || !threadId}
                onClick={onAddPageContextOnly}
                aria-label="Attach page context"
              >
                {contextBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileText size={14} aria-hidden />}
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={6} className="max-w-[17rem] text-xs">
            Attach page text, headings, and diagnostics (no image)
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Separator: capture | external */}
      <div className="mx-1 h-4 w-px bg-border/40" aria-hidden />

      {/* External group */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="button" variant="ghost" size="icon-xs" className="shrink-0" onClick={onOpenExternal} aria-label="Open in system browser">
              <ExternalLink size={14} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={6} className="text-xs">
          Open in system browser
        </TooltipContent>
      </Tooltip>

      {/* Design pill: shows while the user is in element-pick ("design") mode.
          The pick session runs inside the guest page itself (no overlay window),
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
            <Crosshair size={12} aria-hidden />
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
