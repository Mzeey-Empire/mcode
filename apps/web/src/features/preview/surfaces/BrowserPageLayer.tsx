/**
 * Owns resident page surfaces, viewport presentation, loading and control overlays, error and empty states, and the performance HUD. Design overlays occupy an explicit slot in the existing element order.
 */
import { useCallback, useMemo, type RefObject, type ReactNode } from "react";
import type { PreviewPageError } from "@mcode/contracts";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreviewTabsStore } from "../state/previewTabsStore";
import { BrowserActingOverlay } from "./BrowserActingOverlay";
import { BrowserNewPage } from "./BrowserNewPage";
import { BrowserViewportCanvas } from "./BrowserViewportCanvas";
import { useBrowserCertificate } from "./useBrowserCertificate";
import { BrowserErrorPage } from "./BrowserErrorPage";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewWebview, type PreviewWebviewHandle } from "./PreviewWebview";
import type { PreviewCaptureKind } from "../capture/usePreviewCapture";
import { browserAutomationTargetKey } from "../automation/browserAutomationStore";
import type { usePreviewPage } from "./usePreviewPage";
import type { usePreviewViewport } from "./usePreviewViewport";
import { RenderWhen, RenderValue } from "./previewRender";

/** Human-readable label for the capture confirmation badge. */
const CAPTURE_KIND_LABEL: Record<PreviewCaptureKind, string> = {
  viewport: "screenshot",
  region: "region",
  element: "element",
};

function previewSurfaceClassName(
  responsiveViewportSize: { readonly width: number; readonly height: number } | null,
  webviewLayerInteractive: boolean,
  showNewPage: boolean,
): string {
  // No z-index here: a stacking context on the surface would trap the Design
  // layer below the Browser surface host root, which paints the hosted page.
  return cn(
    "relative min-h-[min(40vh,20rem)] min-w-0 flex-1 basis-0",
    "rounded-tr-md",
    responsiveViewportSize ? "mx-2 mb-2 overflow-auto rounded-control bg-page" : "overflow-hidden",
    webviewLayerInteractive && "pointer-events-none",
    showNewPage && "overflow-y-auto",
  );
}

interface BrowserPageLayerProps {
  readonly warmWebviewTabs: ReturnType<typeof usePreviewPage>["warmWebviewTabs"];
  readonly browserWorkspaceId: ReturnType<typeof usePreviewViewport>["browserWorkspaceId"];
  readonly threadId: string;
  readonly automationViewports: ReturnType<typeof usePreviewViewport>["automationViewports"];
  readonly automationViewportStates: ReturnType<typeof usePreviewViewport>["automationViewportStates"];
  readonly automationOnly: boolean;
  readonly activeWebviewTabId: ReturnType<typeof usePreviewViewport>["activeWebviewTabId"];
  readonly webviewLayerInteractive: boolean;
  readonly webviewRefs: RefObject<Record<string, PreviewWebviewHandle | null>>;
  readonly workspaceId: string | null | undefined;
  readonly presentationActive: boolean;
  readonly coveredRight: number | undefined;
  readonly responsiveViewportSize: { readonly width: number; readonly height: number; } | null;
  readonly clearPendingNavOnCommit: ReturnType<typeof usePreviewPage>["clearPendingNavOnCommit"];
  readonly onWebviewPageStatus: ReturnType<typeof usePreviewPage>["onWebviewPageStatus"];
  readonly setWebviewCanBack: ReturnType<typeof usePreviewPage>["setWebviewCanBack"];
  readonly setWebviewCanFwd: ReturnType<typeof usePreviewPage>["setWebviewCanFwd"];
  readonly webviewNavError: ReturnType<typeof usePreviewPage>["webviewNavError"];
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly showNewPage: boolean;
  readonly webviewLoading: ReturnType<typeof usePreviewPage>["webviewLoading"];
  readonly lastCapture: ReturnType<typeof usePreviewPage>["lastCapture"];
  readonly hasWebviewLayer: boolean;
  readonly activeViewportCoordinator: ReturnType<typeof usePreviewViewport>["activeViewportCoordinator"];
  readonly activeViewportState: ReturnType<typeof usePreviewViewport>["activeViewportState"];
  readonly viewportCanvasBounds: { width: number; height: number; };
  readonly responsiveViewportScale: number;
  readonly invalidateActiveViewportObservation: ReturnType<typeof usePreviewViewport>["invalidateActiveViewportObservation"];
  readonly pageError: PreviewPageError | undefined;
  readonly webviewInputUrl: ReturnType<typeof usePreviewPage>["webviewInputUrl"];
  readonly webviewCanBack: ReturnType<typeof usePreviewPage>["webviewCanBack"];
  readonly onPreviewErrorRetry: ReturnType<typeof usePreviewPage>["onPreviewErrorRetry"];
  readonly activeWebviewRef: ReturnType<typeof usePreviewPage>["activeWebviewRef"];
  readonly onWebviewNavigate: ReturnType<typeof usePreviewPage>["onWebviewNavigate"];
  readonly designLayer: ReactNode;
}

/** Renders the page surface and status layers, with Design overlays in their own layer above the hosted page. */
export function BrowserPageLayer({
  warmWebviewTabs,
  browserWorkspaceId,
  threadId,
  automationViewports,
  automationViewportStates,
  automationOnly,
  activeWebviewTabId,
  webviewLayerInteractive,
  webviewRefs,
  workspaceId,
  presentationActive,
  coveredRight,
  responsiveViewportSize,
  clearPendingNavOnCommit,
  onWebviewPageStatus,
  setWebviewCanBack,
  setWebviewCanFwd,
  webviewNavError,
  surfaceRef,
  showNewPage,
  webviewLoading,
  lastCapture,
  hasWebviewLayer,
  activeViewportCoordinator,
  activeViewportState,
  viewportCanvasBounds,
  responsiveViewportScale,
  invalidateActiveViewportObservation,
  pageError,
  webviewInputUrl,
  webviewCanBack,
  onPreviewErrorRetry,
  activeWebviewRef,
  onWebviewNavigate,
  designLayer,
}: BrowserPageLayerProps) {
  const identity = useMemo(
    () => ({ workspaceId: browserWorkspaceId, scope: { kind: "thread" as const, id: threadId }, tabId: activeWebviewTabId }),
    [browserWorkspaceId, threadId, activeWebviewTabId],
  );
  const certificate = useBrowserCertificate(identity, `${webviewInputUrl}|${pageError?.code ?? ""}`, onPreviewErrorRetry);
  const backToSafety = useCallback(() => {
    if (webviewCanBack) {
      void activeWebviewRef()?.goBack();
      return;
    }
    const tabs = usePreviewTabsStore.getState();
    void tabs.openPage(browserWorkspaceId, threadId).then((opened) => {
      if (opened) return tabs.closePage(browserWorkspaceId, threadId, activeWebviewTabId);
    });
  }, [activeWebviewRef, activeWebviewTabId, browserWorkspaceId, threadId, webviewCanBack]);

  const warmWebviewLayer = warmWebviewTabs.map((tab) => {
    const tabKey = browserAutomationTargetKey(browserWorkspaceId, threadId, tab.id);
    const tabViewport = automationViewports.get(tabKey);
    const tabViewportState = automationViewportStates.get(tabKey);
    return (
      <PreviewWebview
        key={tab.id}
        active={automationOnly || (tab.id === activeWebviewTabId && webviewLayerInteractive)}
        ref={(handle) => {
          webviewRefs.current[tab.id] = handle;
        }}
        threadId={threadId}
        workspaceId={workspaceId ?? threadId}
        tabId={tab.id}
        src={tab.src}
        allowHiddenPresentation={automationOnly}
        presentationActive={automationOnly || presentationActive}
        presentationSource={automationOnly ? "automation" : "panel"}
        coveredRight={coveredRight}
        viewport={tabViewportState?.mode === "responsive" ? tabViewport : undefined}
        layoutKey={`${responsiveViewportScale}:${viewportCanvasBounds.width}x${viewportCanvasBounds.height}`}
        className={cn(
          responsiveViewportSize
            ? "absolute left-0 top-0"
            : "absolute inset-0 h-full w-full",
          tab.id === activeWebviewTabId
            ? "z-(--layer-base) block"
            : "pointer-events-none -z-(--layer-sticky) opacity-0",
        )}
        onPageStatus={(status) => {
          usePreviewTabsStore.getState().updateTabChrome(browserWorkspaceId, threadId, tab.id, {
            title: status.title,
            url: status.url,
            favicon: status.favicon,
          });
          // Warm tabs publish too; a real commit on a backgrounded tab must
          // still retire its own pending navigation error.
          clearPendingNavOnCommit(tab.id, status.url);
          if (tab.id !== activeWebviewTabId) return;
          onWebviewPageStatus(status);
        }}
        onNavigationStateChange={(state) => {
          if (tab.id !== activeWebviewTabId) return;
          setWebviewCanBack(state.canGoBack);
          setWebviewCanFwd(state.canGoForward);
        }}
      />
    );
  });

  return (
    <>
      <RenderWhen condition={Boolean(webviewNavError)}>
        <p
          className="flex-none px-3 py-1 text-xs text-destructive"
          role="status"
        >
          {webviewNavError}
        </p>
      </RenderWhen>

      {/* Surface aligned to the hosted Browser page. */}
      <div
        ref={surfaceRef}
        role="region"
        aria-label="Page preview"
        data-testid="preview-surface"
        className={previewSurfaceClassName(
          responsiveViewportSize,
          webviewLayerInteractive,
          showNewPage,
        )}
      >
        {/* Loading: thin indeterminate progress bar at top of content area.
            motion-safe gates the animation so users with prefers-reduced-motion
            get a static bar instead of a perpetual sweep. */}
        <RenderWhen condition={webviewLoading}>
          <div
            data-testid="preview-loading-banner"
            className="absolute inset-x-0 top-0 z-(--layer-sticky) h-0.5 overflow-hidden rounded-t-md"
            role="status"
            aria-live="polite"
            aria-label="Page loading"
          >
            <div className="h-full w-1/3 motion-safe:animate-preview-loading rounded-full bg-primary/80" />
          </div>
        </RenderWhen>
        <RenderValue value={lastCapture}>
          {(captureKind) => (
            <div
              role="status"
              aria-live="polite"
              data-testid="preview-capture-confirmation"
              className={cn(
                "pointer-events-none absolute right-2 bottom-2 z-(--layer-sticky) flex items-center gap-1.5",
                "rounded-sm border border-primary/30 bg-background/90 px-2 py-1 shadow-floating",
                "font-mono text-xs uppercase tracking-[0.14em] text-primary",
                "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
              )}
            >
              <Check size={11} aria-hidden />
              <span>attached</span>
              <span className="text-primary/60">{"\u00b7"}</span>
              <span>{CAPTURE_KIND_LABEL[captureKind]}</span>
            </div>
          )}
        </RenderValue>
        <RenderWhen condition={hasWebviewLayer}>
          <div
            data-testid="preview-webview-surface"
            className="pointer-events-none absolute inset-0 z-(--layer-base) overflow-hidden rounded-tr-md"
          >
          <BrowserViewportCanvas
            coordinator={activeViewportCoordinator}
            state={activeViewportState}
            bounds={viewportCanvasBounds}
            scale={responsiveViewportScale}
            className="absolute inset-0"
            onUserViewportChange={invalidateActiveViewportObservation}
          >
            {warmWebviewLayer}
          </BrowserViewportCanvas>
          </div>
        </RenderWhen>
        <BrowserActingOverlay
          workspaceId={browserWorkspaceId}
          threadId={threadId}
          tabId={activeWebviewTabId}
          coveredRight={coveredRight ?? 0}
        />
        {/* The hosted page paints later in the DOM from the Browser surface
            host root, so Design overlays need a higher layer to stay visible. */}
        <div
          data-testid="preview-design-layer"
          className="pointer-events-none absolute inset-0 z-(--layer-browser-overlay) overflow-hidden"
          style={{ clipPath: coveredRight ? `inset(0 ${coveredRight}px 0 0)` : undefined }}
        >
          {designLayer}
        </div>
        <RenderValue value={pageError}>
          {(error) => (
            <BrowserErrorPage
              error={error}
              url={webviewInputUrl || null}
              threadId={threadId}
              onRetry={onPreviewErrorRetry}
              onOpen={onWebviewNavigate}
              onBackToSafety={backToSafety}
              certificate={certificate}
            />
          )}
        </RenderValue>
        <RenderWhen condition={showNewPage}>
          <BrowserNewPage
            // A pending Start belongs to the tab that pressed it, so another tab must not inherit it.
            key={activeWebviewTabId ?? ""}
            threadId={threadId}
            browserWorkspaceId={browserWorkspaceId}
            onOpen={onWebviewNavigate}
          />
        </RenderWhen>
      </div>
      <PreviewPerfHud />
    </>
  );
}
