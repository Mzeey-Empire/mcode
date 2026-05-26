import { useEffect, useRef } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreviewDockStore } from "@/stores/previewDockStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { SmartOmnibox } from "./SmartOmnibox";
import { PreviewToolbar } from "./PreviewToolbar";
import { PreviewTabBar } from "./PreviewTabBar";
import { PreviewPerfHud } from "./PreviewPerfHud";
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

  // Design mode is a single state: "next click on the page captures the
  // element under the cursor, repeat until you turn the mode off." The chain
  // below auto-arms pick sessions back-to-back on success and exits the mode
  // on any non-success outcome (Esc inside the guest, user-initiated cancel,
  // IPC error). Success and cancel both surface as the same elementPickBusy
  // transition, so the loop relies on the hook's { ok } return to decide.
  const onToggleDesignMode = () => {
    const willActivate = !designModeActive;
    designModeToggle(threadId);
    if (!willActivate) {
      void window.desktopBridge?.preview?.cancelCapture();
    }
  };

  const onExitDesignMode = () => {
    designModeSetActive(threadId, false);
    void window.desktopBridge?.preview?.cancelCapture();
  };

  useEffect(() => {
    if (!designModeActive) return;
    let cancelled = false;
    const loop = async (): Promise<void> => {
      while (!cancelled) {
        if (!usePreviewDesignModeStore.getState().isActive(threadId)) return;
        const result = await capture.onAddElementPickPictureReference();
        if (cancelled) return;
        if (!result.ok) {
          // Cancel / error / Esc-in-guest: exit the mode entirely so the
          // user has a single, consistent way to escape a sticky picker.
          designModeSetActive(threadId, false);
          return;
        }
        // Successful pick attached an element; loop body re-arms for the
        // next click.
      }
    };
    void loop();
    return () => {
      cancelled = true;
    };
  }, [
    designModeActive,
    threadId,
    capture.onAddElementPickPictureReference,
    designModeSetActive,
  ]);

  // Esc must exit design mode no matter where focus is. The global
  // escape.handle binding (default-keybindings.json) closes the current
  // thread on Esc, which would yank the user out of their workspace mid
  // pick session. We attach at capture phase with stopImmediatePropagation
  // so this listener fires before the global keybinding-manager dispatch.
  useEffect(() => {
    if (!designModeActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      designModeSetActive(threadId, false);
      void window.desktopBridge?.preview?.cancelCapture();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [designModeActive, designModeSetActive, threadId]);

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
              threadId={threadId}
              regionBusy={capture.regionBusy}
              onAddRegionPictureReference={capture.onAddRegionPictureReference}
              contextBusy={capture.contextBusy}
              onAddPageContextOnly={capture.onAddPageContextOnly}
            />
          </div>
        ) : null}
      </div>
      <PreviewPerfHud />
    </div>
  );
}
