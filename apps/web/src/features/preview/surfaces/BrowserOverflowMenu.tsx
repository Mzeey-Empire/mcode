import { useCallback, useEffect, useState } from "react";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
import {
  CodeXml,
  Cookie,
  EllipsisVertical,
  FileText,
  Hand,
  Minus,
  Plus,
  RotateCw,
  Smartphone,
  SquareDashedMousePointer,
  Trash2,
} from "lucide-react";
import type { BrowserAutomationControllerState } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Step applied per zoom in/out click (10 percentage points). */
const ZOOM_STEP = 0.1;

/** Props for the browser header's overflow (kebab) menu. */
export interface BrowserOverflowMenuProps {
  /** True once a real page is loaded; gates the page-scoped tools. */
  readonly hasLoadedPage: boolean;
  /** Open a new browser page (adds a tab). */
  readonly onNewPage: () => void;
  /** Hard reload that bypasses the guest cache. */
  readonly onForceReload: () => void;
  /** Attach the page's structured content to the chat without a screenshot. */
  readonly onDumpContent: () => void;
  /** Drag a region on the page and attach it to the chat. */
  readonly onRegionCapture: () => void;
  /** Clear the preview session's cookies. */
  readonly onClearCookies: () => void;
  /** Clear the preview session's HTTP cache. */
  readonly onClearCache: () => void;
  /** Read the guest's current zoom factor (1 = 100%). */
  readonly onGetZoom: () => Promise<number>;
  /** Set the guest's zoom factor; resolves to the clamped factor applied. */
  readonly onSetZoom: (factor: number) => Promise<number>;
  /** Open detached DevTools for the adopted active guest. */
  readonly onOpenDevTools: () => void;
  /** Toggle the responsive viewport toolbar below the Browser header. */
  readonly onToggleViewportToolbar?: () => void;
  /** Whether the responsive viewport toolbar is currently shown. */
  readonly viewportToolbarVisible?: boolean;
  /** Current controller for the active visible Browser tab. */
  readonly automationController?: BrowserAutomationControllerState | null;
  /** True while the active tab owns an in-flight browser operation. */
  readonly automationBusy?: boolean;
  /** Transfer the active tab back to human control. */
  readonly onStopAutomation?: () => void;
}

/**
 * Overflow menu for the browser header. Holds the rarely-used tools that the
 * minimal header deliberately omits, in the order set by the right-panel epic:
 * New page, Force reload, Dump page content, Region capture, Developer tools,
 * Show device toolbar, Zoom, Clear cookies, and Clear cache. Keeps the everyday
 * header to back/forward, the
 * URL, design, and screenshot.
 */
export function BrowserOverflowMenu({
  hasLoadedPage,
  onNewPage,
  onForceReload,
  onDumpContent,
  onRegionCapture,
  onClearCookies,
  onClearCache,
  onGetZoom,
  onSetZoom,
  onOpenDevTools,
  onToggleViewportToolbar,
  viewportToolbarVisible = false,
  automationController = null,
  automationBusy = false,
  onStopAutomation,
}: BrowserOverflowMenuProps) {
  const [open, setOpen] = usePanelHeaderMenuOpen();
  const [zoom, setZoom] = useState(1);
  // Read the live zoom factor when the menu opens so the readout reflects the
  // guest's actual state (which navigation can reset) rather than a stale value.
  useEffect(() => {
    if (!open || !hasLoadedPage) return;
    let cancelled = false;
    void onGetZoom().then((factor) => {
      if (!cancelled) setZoom(factor);
    });
    return () => {
      cancelled = true;
    };
  }, [open, hasLoadedPage, onGetZoom]);

  const applyZoom = useCallback(
    (factor: number) => {
      void onSetZoom(factor).then(setZoom);
    },
    [onSetZoom],
  );

  const pageReason = hasLoadedPage ? null : "Load a page first";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label="More browser tools"
            className="text-muted hover:text-ink"
          >
            <EllipsisVertical aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-[24rem]"
        data-testid="browser-overflow-menu"
      >
        <DropdownMenuItem label="New page" icon={<Plus />} onClick={onNewPage} />
        <DropdownMenuItem label="Force reload" icon={<RotateCw />} disabledReason={pageReason} onClick={onForceReload} />
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Dump page content" icon={<FileText />} disabledReason={pageReason} onClick={onDumpContent} />
        <DropdownMenuItem
          label="Region capture"
          icon={<SquareDashedMousePointer />}
          disabledReason={pageReason}
          onClick={onRegionCapture}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Developer tools" icon={<CodeXml />} disabledReason={pageReason} onClick={onOpenDevTools} />
        <DropdownMenuItem
          label={viewportToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
          icon={<Smartphone />}
          disabledReason={onToggleViewportToolbar ? null : "This page has no device toolbar"}
          onClick={onToggleViewportToolbar}
        />
        <TakeControlItem
          automationController={automationController}
          automationBusy={automationBusy}
          onStopAutomation={onStopAutomation}
        />
        <DropdownMenuSeparator />
        {/* Zoom is a control row, not a closeable menu item: a plain div keeps
            the popup open so −/+ can be tapped repeatedly without dismissing it,
            and avoids menu-item keyboard semantics fighting the nested buttons. */}
        <div
          className={cn(
            "flex h-row-default items-center justify-between px-3 text-body-small",
            !hasLoadedPage && "opacity-50",
          )}
        >
          <span className="text-muted">Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              aria-label="Zoom out"
              disabled={!hasLoadedPage}
              onClick={() => applyZoom(zoom - ZOOM_STEP)}
            >
              <Minus aria-hidden />
            </Button>
            <span className="w-9 text-center tabular-nums" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              aria-label="Zoom in"
              disabled={!hasLoadedPage}
              onClick={() => applyZoom(zoom + ZOOM_STEP)}
            >
              <Plus aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              aria-label="Reset zoom"
              disabled={!hasLoadedPage}
              className="ml-1"
              onClick={() => applyZoom(1)}
            >
              <RotateCw aria-hidden />
            </Button>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Clear cookies" icon={<Cookie />} disabledReason={pageReason} onClick={onClearCookies} />
        <DropdownMenuItem label="Clear cache" icon={<Trash2 />} disabledReason={pageReason} onClick={onClearCache} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Offered only while the agent drives the active tab, so the user can take it back. */
function TakeControlItem({
  automationController,
  automationBusy,
  onStopAutomation,
}: Pick<BrowserOverflowMenuProps, "automationController" | "automationBusy" | "onStopAutomation">) {
  if (automationController?.controller !== "agent" || !onStopAutomation) return null;
  return (
    <DropdownMenuItem
      label="Take control"
      icon={<Hand />}
      onClick={onStopAutomation}
      title={automationBusy ? "Stop the active operation and take control" : undefined}
    />
  );
}
