import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreviewDockStore } from "@/stores/previewDockStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";
import { SmartOmnibox } from "./SmartOmnibox";
import { PreviewToolbar } from "./PreviewToolbar";
import { PreviewTabBar } from "./PreviewTabBar";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewDevDock } from "./PreviewDevDock";
import { usePreviewBridge } from "./hooks/usePreviewBridge";
import {
  usePreviewCapture,
  type PreviewCaptureKind,
} from "./hooks/usePreviewCapture";
import { usePreviewTabs } from "./hooks/usePreviewTabs";

/** Human-readable label for the capture confirmation badge. */
const CAPTURE_KIND_LABEL: Record<PreviewCaptureKind, string> = {
  viewport: "screenshot",
  region: "region",
  element: "element",
  context: "page context",
};

/** How long the capture confirmation badge stays visible after a successful attach. */
const CAPTURE_CONFIRMATION_DURATION_MS = 2200;

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

  // Inline capture confirmation. The composer chip lives in another panel and
  // may scroll off; this badge acknowledges the action where the user is
  // looking. The timer ref lets a second capture reset the dismissal window
  // without leaving a stale badge behind.
  const [lastCapture, setLastCapture] = useState<PreviewCaptureKind | null>(null);
  const captureConfirmTimerRef = useRef<number | null>(null);
  const onCaptureSuccess = useCallback((kind: PreviewCaptureKind): void => {
    setLastCapture(kind);
    if (captureConfirmTimerRef.current !== null) {
      window.clearTimeout(captureConfirmTimerRef.current);
    }
    captureConfirmTimerRef.current = window.setTimeout(() => {
      setLastCapture(null);
      captureConfirmTimerRef.current = null;
    }, CAPTURE_CONFIRMATION_DURATION_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (captureConfirmTimerRef.current !== null) {
        window.clearTimeout(captureConfirmTimerRef.current);
      }
    };
  }, []);

  const capture = usePreviewCapture({
    threadId,
    pushSync: bridge.pushSync,
    onSuccess: onCaptureSuccess,
  });
  const tabs = usePreviewTabs(threadId);
  // Each selector returns a stable primitive/function reference so Zustand
  // does not re-render on unrelated store mutations.
  const dock = usePreviewDockStore((s) => s.docks[threadId]) ?? {
    open: false,
    edge: "bottom" as const,
    size: 240,
  };
  const dockToggle = usePreviewDockStore((s) => s.toggle);
  const dockSetOpen = usePreviewDockStore((s) => s.setOpen);
  const dockSetEdge = usePreviewDockStore((s) => s.setEdge);
  const dockSetSize = usePreviewDockStore((s) => s.setSize);

  // Splitter drag state. Tracking via ref (not state) avoids a re-render
  // on every pointermove tick; the dock's size already comes from the
  // store and will re-render when setSize is called.
  const splitterDragRef = useRef<{ startPos: number; startSize: number } | null>(null);
  const onSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dock.open) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitterDragRef.current = {
      startPos: dock.edge === "bottom" ? e.clientY : e.clientX,
      startSize: dock.size,
    };
  };
  const onSplitterPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!splitterDragRef.current) return;
    e.preventDefault();
    const { startPos, startSize } = splitterDragRef.current;
    // Both dock edges grow when the user drags the splitter AWAY from
    // the surface: bottom dock grows when dragged up, right dock grows
    // when dragged left. delta is therefore startPos - currentPos.
    const currentPos = dock.edge === "bottom" ? e.clientY : e.clientX;
    const delta = startPos - currentPos;
    dockSetSize(threadId, startSize + delta);
  };
  const onSplitterPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!splitterDragRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    splitterDragRef.current = null;
  };
  const designModeActive = usePreviewDesignModeStore((s) => s.modes[threadId] === true);
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);
  const omniboxFocusTick = usePreviewFocusStore((s) => s.omniboxFocusTick);

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
          focusRequest={omniboxFocusTick}
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
          hasLoadedPage={hasLoadedPage}
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
          className={cn(
            "relative min-h-[min(40vh,20rem)] min-w-0 flex-1 rounded-md bg-muted/10",
            // Dashed border codes "drop zone / not implemented" in web vocab,
            // which reads as a stuck loading state once a real page is showing.
            // Keep dashed for the empty-state placeholder cue, solid once live.
            hasLoadedPage
              ? "border border-border/40"
              : "border border-dashed border-border/50",
          )}
          aria-hidden
        >
          {/* Loading: thin indeterminate progress bar at top of content area.
              motion-safe gates the animation so users with prefers-reduced-motion
              get a static bar instead of a perpetual sweep. */}
          {bridge.previewLoading ? (
            <div
              data-testid="preview-loading-banner"
              className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md"
              role="status"
              aria-live="polite"
              aria-label="Page loading"
            >
              <div className="h-full w-1/3 motion-safe:animate-preview-loading rounded-full bg-primary/80" />
            </div>
          ) : null}
          {lastCapture ? (
            // Brief acknowledgement of a successful attachment. Sits in the
            // bottom-right so it never overlaps the loading banner at the top
            // and never blocks the page's interactive area. Auto-dismiss after
            // ~2.2s via the host timer.
            <div
              role="status"
              aria-live="polite"
              data-testid="preview-capture-confirmation"
              className={cn(
                "pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1.5",
                // No backdrop-blur: the BrowserView paints opaque underneath
                // anyway, so the blur is a no-op render cost. bg-background/90
                // gives enough contrast over any guest page color.
                "rounded-sm border border-primary/30 bg-background/90 px-2 py-1 shadow-sm",
                "font-mono text-[10px] uppercase tracking-[0.16em] text-primary",
                "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
              )}
            >
              <Check size={11} aria-hidden />
              <span>attached</span>
              <span className="text-primary/60">{"\u00b7"}</span>
              <span>{CAPTURE_KIND_LABEL[lastCapture]}</span>
            </div>
          ) : null}
          {!hasLoadedPage && !bridge.previewLoading ? (
            // Empty state teaches what becomes available once a URL loads.
            // hasLoadedPage gates every capture/design action; without this hint
            // a first-timer lands on a bare Globe and never discovers the picker,
            // region drag, or context dump.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <Globe className="size-7 text-muted-foreground/15" aria-hidden />
              <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted-foreground/40">
                enter a url to preview
              </span>
              <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted-foreground/25">
                then{" "}
                <span className="text-muted-foreground/40">pick</span>
                {" \u00b7 "}
                <span className="text-muted-foreground/40">screenshot</span>
                {" \u00b7 "}
                <span className="text-muted-foreground/40">region</span>
                {" \u00b7 "}
                <span className="text-muted-foreground/40">context</span>
              </span>
            </div>
          ) : null}
        </div>
        {dock.open ? (
          <>
            <div
              role="separator"
              aria-label="Resize capture tools"
              aria-orientation={dock.edge === "bottom" ? "horizontal" : "vertical"}
              tabIndex={0}
              data-testid="preview-dock-splitter"
              onPointerDown={onSplitterPointerDown}
              onPointerMove={onSplitterPointerMove}
              onPointerUp={onSplitterPointerUp}
              onPointerCancel={onSplitterPointerUp}
              className={cn(
                // Subtle at rest so the boundary reads as a separator the
                // user can find by sight; hover ramps to amber to confirm
                // the affordance; active strengthens during drag for tactile
                // feedback. Pointer Events already pin the cursor through
                // setPointerCapture so :active stays true for the whole drag.
                "shrink-0 bg-border/40 transition-colors",
                "hover:bg-primary/50 active:bg-primary/60",
                "focus-visible:outline-none focus-visible:bg-primary/50",
                // A 6px hit target on the splitter axis keeps the surface
                // and dock cells flush while still being grabbable.
                dock.edge === "bottom"
                  ? "h-1.5 w-full cursor-ns-resize"
                  : "h-full w-1.5 cursor-ew-resize",
              )}
            />
            <div
              style={
                dock.edge === "bottom"
                  ? { height: `${dock.size}px`, width: "100%" }
                  : { width: `${dock.size}px`, height: "100%" }
              }
              className="shrink-0 overflow-hidden rounded-md border border-border/40 bg-muted/5"
            >
              <PreviewDevDock
                edge={dock.edge}
                onChangeEdge={(e) => dockSetEdge(threadId, e)}
                onClose={() => dockSetOpen(threadId, false)}
                threadId={threadId}
                hasLoadedPage={hasLoadedPage}
                regionBusy={capture.regionBusy}
                onAddRegionPictureReference={capture.onAddRegionPictureReference}
                contextBusy={capture.contextBusy}
                onAddPageContextOnly={capture.onAddPageContextOnly}
              />
            </div>
          </>
        ) : null}
      </div>
      <PreviewPerfHud />
    </div>
  );
}
