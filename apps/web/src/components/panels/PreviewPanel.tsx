import { useRef } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreviewDockStore } from "@/stores/previewDockStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { SmartOmnibox } from "./SmartOmnibox";
import { PreviewToolbar } from "./PreviewToolbar";
import { PreviewTabBar } from "./PreviewTabBar";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewDesignBar } from "./PreviewDesignBar";
import { PreviewDevDock } from "./PreviewDevDock";
import { usePreviewBridge } from "./hooks/usePreviewBridge";
import { usePreviewCapture } from "./hooks/usePreviewCapture";
import { usePreviewTabs } from "./hooks/usePreviewTabs";

export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
}

/**
 * Embedded site preview: omnibox and toolbar above a region aligned to an Electron BrowserView.
 * A loading banner sits between the form and guest region because the BrowserView stacks above HTML and would hide in-surface overlays. Full viewport, drag-selected region, element-pick PNGs, or fence-only page context attach to the composer. The chrome uses a
 * two-row header so the omnibox keeps usable width on narrow panels. Tooltips open upward so they stay
 * readable: the guest BrowserView is stacked above shell HTML and would hide downward popups.
 * In web-only builds without `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({ threadId, workspaceId }: PreviewPanelProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  const bridge = usePreviewBridge({ threadId, workspaceId, surfaceRef });
  const capture = usePreviewCapture({ threadId, pushSync: bridge.pushSync });
  const tabs = usePreviewTabs(threadId);
  // Each selector returns a stable primitive/function reference so Zustand
  // does not re-render on unrelated store mutations.
  const dock = usePreviewDockStore((s) => s.docks[threadId]) ?? {
    open: false,
    edge: "bottom" as const,
  };
  const dockToggle = usePreviewDockStore((s) => s.toggle);
  const dockSetOpen = usePreviewDockStore((s) => s.setOpen);
  const dockSetEdge = usePreviewDockStore((s) => s.setEdge);
  const designModeActive = usePreviewDesignModeStore((s) => s.modes[threadId] === true);
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);

  // Entering design mode auto-arms Pick so the user can click an element
  // immediately. Exiting cancels any in-flight pick session so the in-guest
  // highlight tears down with the bar.
  const onToggleDesignMode = () => {
    const willActivate = !designModeActive;
    designModeToggle(threadId);
    if (willActivate) {
      void capture.onAddElementPickPictureReference();
    } else {
      void window.desktopBridge?.preview?.cancelCapture();
    }
  };

  const onExitDesignMode = () => {
    designModeSetActive(threadId, false);
    void window.desktopBridge?.preview?.cancelCapture();
  };

  if (!window.desktopBridge?.preview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Embedded preview runs in the desktop app. Open Mcode from Electron to
          browse http and https sites alongside this thread.
        </p>
      </div>
    );
  }

  const hasLoadedPage = bridge.storedUrl.trim().length > 0;

  return (
    <div
      data-testid="preview-panel"
      className="flex min-h-0 min-w-[20rem] flex-1 flex-col"
    >
      <PreviewTabBar
        tabSet={tabs.tabSet}
        onNewTab={tabs.newTab}
        onActivate={tabs.activateTab}
        onClose={tabs.closeTab}
      />
      {designModeActive ? (
        <PreviewDesignBar
          elementPickBusy={capture.elementPickBusy}
          onPick={capture.onAddElementPickPictureReference}
          onExit={onExitDesignMode}
        />
      ) : null}
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex-none space-y-1.5 border-b border-border/40 px-2 pt-1 pb-1.5"
      >
        <SmartOmnibox
          url={bridge.inputUrl}
          pageTitle={bridge.pageTitle}
          faviconUrl={bridge.faviconUrl}
          onNavigate={bridge.onNavigate}
        />

        <PreviewToolbar
          canBack={bridge.canBack}
          canFwd={bridge.canFwd}
          captureBusy={capture.captureBusy}
          regionBusy={capture.regionBusy}
          elementPickBusy={capture.elementPickBusy}
          contextBusy={capture.contextBusy}
          anyCaptureActive={capture.anyCaptureActive}
          threadId={threadId}
          designModeActive={designModeActive}
          devDockOpen={dock.open}
          devDockEdge={dock.edge}
          onGoBack={bridge.onGoBack}
          onGoForward={bridge.onGoForward}
          onReload={bridge.onReload}
          onOpenExternal={bridge.onOpenExternal}
          onAddPictureReference={capture.onAddPictureReference}
          onToggleDesign={onToggleDesignMode}
          onExitDesignMode={onExitDesignMode}
          onToggleDevDock={() => dockToggle(threadId)}
          onAddRegionPictureReference={capture.onAddRegionPictureReference}
          onAddElementPickPictureReference={capture.onAddElementPickPictureReference}
          onAddPageContextOnly={capture.onAddPageContextOnly}
        />

        {bridge.navError ? (
          <p className="text-xs text-destructive" role="status">
            {bridge.navError}
          </p>
        ) : null}
      </form>

      {/* Surface + (optional) dev dock. The BrowserView is positioned to surfaceRef's
          bounding box, so shrinking surfaceRef when the dock opens automatically
          resizes the native guest view via the bridge's ResizeObserver. */}
      <div
        className={cn(
          "mx-2 mb-2 mt-1 flex min-h-0 min-w-0 flex-1 gap-1.5",
          dock.open && dock.edge === "right" ? "flex-row" : "flex-col",
        )}
      >
        <div
          ref={surfaceRef}
          className="relative min-h-[min(40vh,20rem)] min-w-0 flex-1 rounded-md border border-dashed border-border/50 bg-muted/10"
          aria-hidden
        >
          {/* Loading: thin indeterminate progress bar at top of content area */}
          {bridge.previewLoading ? (
            <div
              data-testid="preview-loading-banner"
              className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md"
              role="status"
              aria-live="polite"
              aria-label="Page loading"
            >
              <div className="h-full w-1/3 animate-preview-loading rounded-full bg-primary/80" />
            </div>
          ) : null}
          {!hasLoadedPage && !bridge.previewLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Globe className="size-7 text-muted-foreground/15" aria-hidden />
              <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted-foreground/40">
                enter a url to preview
              </span>
            </div>
          ) : null}
        </div>
        {dock.open ? (
          <div
            className={cn(
              "shrink-0 overflow-hidden rounded-md border border-border/40 bg-muted/5",
              dock.edge === "bottom"
                ? "h-[min(28vh,16rem)] w-full"
                : "h-full w-[min(32vw,22rem)]",
            )}
          >
            <PreviewDevDock
              edge={dock.edge}
              onChangeEdge={(e) => dockSetEdge(threadId, e)}
              onClose={() => dockSetOpen(threadId, false)}
            />
          </div>
        ) : null}
      </div>
      <PreviewPerfHud />
    </div>
  );
}
