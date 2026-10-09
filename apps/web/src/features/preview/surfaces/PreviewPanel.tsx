/**
 * Composes Browser chrome, page surfaces and design tools. State hooks stay in their original declaration order so navigation and annotation effects retain their ordering.
 */
import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import type { PreviewPageError, PreviewPageStatus } from "@mcode/contracts";
import { isEmptyPreviewTabUrl } from "../navigation/open-url-in-preview";
import { cn } from "@/lib/utils";
import { usePreviewTabsStore, type PendingNavError, type PreviewLiveChrome } from "../state/previewTabsStore";
import type { PreviewWebviewHandle } from "./PreviewWebview";
import { useWorkspaceFileRefresh } from "@/features/projects/files/useWorkspaceFileRefresh";
import { isBrowserAutomationWebRuntimeEnabled } from "../automation/browserAutomationRuntime";
import {
  calculateViewportPresentationScale,
  type ViewportCoordinatorState,
} from "../automation/services/viewportCoordinator";
import { fitViewportCanvasBounds, usePreviewViewport } from "./usePreviewViewport";
import { useDesignAnnotationState } from "../design/useDesignAnnotationState";
import { usePreviewPage } from "./usePreviewPage";
import { useDesignAnnotationEditor } from "../design/useDesignAnnotationEditor";
import { useDesignPicker } from "../design/useDesignPicker";
import { WebRuntimePreview } from "./WebRuntimePreview";
import { previewSurfaceWidth, shouldShowAnnotationCommandBar } from "../design/annotationBubble";
import { BrowserChrome } from "./BrowserChrome";
import { BrowserPageLayer } from "./BrowserPageLayer";
import { DesignLayer } from "../design/DesignLayer";

export { PREVIEW_WEBVIEW_FALLBACK_TAB_ID } from "./usePreviewViewport";
export { WEB_RUNTIME_PREVIEW_TAB_ID } from "./WebRuntimePreview";

function hasLoadedPreviewPage(
  activeWebviewUrl: string | null,
  pageStatus: PreviewPageStatus,
): boolean {
  return !isEmptyPreviewTabUrl(activeWebviewUrl ?? pageStatus.url);
}

function previewPageError(
  pageStatus: PreviewPageStatus,
  pendingNavError: PendingNavError | null,
): PreviewPageError | undefined {
  return pendingNavError?.error
    ?? (pageStatus.phase === "error" ? pageStatus.error : undefined);
}

function previewLiveChrome(
  pageStatus: PreviewPageStatus,
  pendingNavError: PendingNavError | null,
): PreviewLiveChrome {
  // A rejected navigation never reaches the guest, so the error headline
  // stands in as the tab's title and its attempted address as the url.
  if (pendingNavError) {
    return { title: pendingNavError.error.message, url: pendingNavError.input, favicon: null };
  }
  return { title: pageStatus.title, url: pageStatus.url, favicon: pageStatus.favicon };
}

function previewSurfaceState(
  hasLoadedPage: boolean,
  isLoading: boolean,
  pageError: PreviewPageError | undefined,
  warmTabCount: number,
): {
  readonly showLocalPorts: boolean;
  readonly hasWebviewLayer: boolean;
  readonly webviewLayerInteractive: boolean;
} {
  const showLocalPorts = !hasLoadedPage && !isLoading && !pageError;
  const hasWebviewLayer = warmTabCount > 0;
  return {
    showLocalPorts,
    hasWebviewLayer,
    webviewLayerInteractive: hasWebviewLayer && !showLocalPorts && !pageError,
  };
}

function responsiveViewportPresentation(
  viewportState: ViewportCoordinatorState | undefined,
  canvasBounds: { readonly width: number; readonly height: number },
): {
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly scale: number;
} {
  const size = viewportState?.mode === "responsive" ? viewportState.confirmed : null;
  if (!size) return { size, scale: 1 };
  return {
    size,
    scale: calculateViewportPresentationScale(
      size,
      fitViewportCanvasBounds(canvasBounds),
      viewportState?.presentation ?? "fit",
    ),
  };
}

function shouldUseWebRuntimePreview(
  hasDesktopPreview: boolean,
  webRuntimeEnabled: boolean,
): boolean {
  return !hasDesktopPreview && webRuntimeEnabled;
}

/** Identifies the preview scope and its presentation within the activity panel. */
export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
  /** Mount only automation webviews without visible panel chrome. */
  readonly automationOnly?: boolean;
  /** Whether this warm panel currently owns the visible Browser presentation. */
  readonly presentationActive?: boolean;
  /** Explicit overlap supplied by the active Activity Rail. */
  readonly coveredLeft?: number;
}

/** Composes the existing preview layers and preserves the order of their state and effects. */
export function PreviewPanel({
  threadId,
  workspaceId,
  automationOnly = false,
  presentationActive = true,
  coveredLeft,
}: PreviewPanelProps) {
  useWorkspaceFileRefresh(workspaceId, threadId);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const webviewRefs = useRef<Record<string, PreviewWebviewHandle | null>>({});
  const [viewportCanvasBounds, setViewportCanvasBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => setViewportCanvasBounds({
      width: surface.clientWidth,
      height: surface.clientHeight,
    });
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(surface);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const {
    annotationSignal,
    editingAnnotationId,
    draftAnnotation,
    selectBubbleFileSuggestion,
    bubbleNoteInputRef,
    bubbleFileTriggerStart,
    bubbleFileSuggestions,
    bubbleFileQuery,
    bubbleFileOpen,
    dismissBubbleFile,
    designModeActive,
    setEditingAnnotationId,
    dismissBubbleSlash,
    linkedVisualPairs,
    setLinkedVisualPairs,
    setColorFormats,
    bubbleRef,
    bubbleSlashOpen,
    designModeSetActive,
    designModeToggle,
    onBubbleSlashSelect,
    onBubbleSlashKeyDown,
    bubbleSlashItems,
    bubbleSlashSelectedIndex,
    bubbleInputFocused,
    onBubbleSlashInputChange,
    onBubbleFileInputChange,
    setBubbleInputFocused,
    colorFormats,
    expandedVisualGroups,
    setExpandedVisualGroups,
    bubbleSlashState,
    bubbleSlashAnchorRect,
    retryBubbleSlash,
    filePopupAnchorRect,
  } = useDesignAnnotationState({
    threadId,
    workspaceId,
  });
  const {
    tabs,
    browserWorkspaceId,
    activeWebviewTabId,
    automationControllers,
    automationActiveRequests,
    pendingAgentOpens,
    activeBrowserTargetKey,
    previewScopeKey,
    pendingNavError,
    activeViewportCoordinator,
    activeViewportState,
    viewportToolbarOpen,
    toggleViewportToolbar,
    closeViewportToolbar,
    automationViewports,
    automationViewportStates,
    invalidateActiveViewportObservation,
  } = usePreviewViewport({
    threadId,
    workspaceId,
  });
  const {
    webviewPageStatus,
    webviewInputUrl,
    capture,
    activeWebviewSrc,
    webviewLoading,
    warmWebviewTabs,
    clearPendingNavOnCommit,
    onWebviewPageStatus,
    setWebviewCanBack,
    setWebviewCanFwd,
    webviewCanBack,
    webviewCanFwd,
    omniboxFocusTick,
    onWebviewNavigate,
    activeWebviewRef,
    onWebviewOpenExternal,
    bridge,
    onWebviewGetZoom,
    onWebviewSetZoom,
    activeAutomationController,
    activeAutomationRequest,
    webviewNavError,
    lastCapture,
    agentControlsBrowser,
    automationPointer,
    onPreviewErrorRetry,
  } = usePreviewPage({
    threadId,
    workspaceId,
    surfaceRef,
    automationOnly,
    tabs,
    browserWorkspaceId,
    activeWebviewTabId,
    automationControllers,
    automationActiveRequests,
    pendingAgentOpens,
    webviewRefs,
    activeBrowserTargetKey,
    previewScopeKey,
    pendingNavError,
  });
  const {
    openBubbleFocusKey,
    hasOpenBubble,
    setBubbleAdvancedOpen,
    setOutsideWarned,
    openBubbleBase,
    canSaveOpenBubble,
    outsideWarned,
    setBubbleVisuals,
    bubbleVisuals,
    bubbleNote,
    pageAnnotations,
    savedAnnotations,
    editingSavedAnnotation,
    setBubbleNote,
    bubbleFilePopup,
    bundleCount,
    annotationHeaderPageLabel,
    currentPageIdentity,
    bubbleAdvancedOpen,
    handleBubbleMentionSelect,
  } = useDesignAnnotationEditor({
    webviewPageStatus,
    webviewInputUrl,
    threadId,
    annotationSignal,
    editingAnnotationId,
    draftAnnotation,
    selectBubbleFileSuggestion,
    bubbleNoteInputRef,
    bubbleFileTriggerStart,
    bubbleFileSuggestions,
    bubbleFileQuery,
    bubbleFileOpen,
    dismissBubbleFile,
  });
  // Page events flow through `preview:page-status`, not `preview:tabs-updated`
  // (P2), so the host-truth tab set lags the active page's live chrome. Publish
  // it to the store so the rail's page switcher and Browser glyph reflect the
  // active page as it navigates, without re-serializing the whole tab set on
  // every favicon tick. Clear on unmount so a backgrounded scope falls back to
  // each tab's own persisted favicon rather than a stale overlay.
  useEffect(() => {
    usePreviewTabsStore.getState().setLiveChrome(
      browserWorkspaceId,
      threadId,
      previewLiveChrome(webviewPageStatus, pendingNavError),
    );
  }, [browserWorkspaceId, threadId, webviewPageStatus, pendingNavError]);
  useEffect(() => {
    return () => {
      usePreviewTabsStore.getState().setLiveChrome(browserWorkspaceId, threadId, null);
    };
  }, [browserWorkspaceId, threadId]);

  const {
    clearTransientAnnotationState,
    onToggleDesignMode,
    updateBubbleVisualControl,
    updateColorFormat,
    toggleVisualLinkPair,
  } = useDesignPicker({
    openBubbleFocusKey,
    bubbleNoteInputRef,
    designModeActive,
    hasOpenBubble,
    threadId,
    setEditingAnnotationId,
    setBubbleAdvancedOpen,
    setOutsideWarned,
    dismissBubbleSlash,
    dismissBubbleFile,
    openBubbleBase,
    canSaveOpenBubble,
    outsideWarned,
    linkedVisualPairs,
    setBubbleVisuals,
    setLinkedVisualPairs,
    setColorFormats,
    bubbleVisuals,
    bubbleRef,
    bubbleSlashOpen,
    bubbleFileOpen,
    designModeSetActive,
    designModeToggle,
    capture,
  });
  const hasDesktopPreview = !!window.desktopBridge?.preview;
  const webRuntimeEnabled = isBrowserAutomationWebRuntimeEnabled();
  if (shouldUseWebRuntimePreview(hasDesktopPreview, webRuntimeEnabled)) {
    return (
      <WebRuntimePreview
        key={threadId}
        threadId={threadId}
        workspaceId={workspaceId}
        viewportCoordinator={activeViewportCoordinator}
        viewportState={activeViewportState}
        viewportToolbarOpen={viewportToolbarOpen}
        onToggleViewportToolbar={toggleViewportToolbar}
        onCloseViewportToolbar={closeViewportToolbar}
        automationOnly={automationOnly}
        presentationActive={presentationActive}
      />
    );
  }
  if (!hasDesktopPreview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Web preview automation is disabled. Set MCODE_WEB_AUTOMATION=1 and
          restart agent:up to enable the same-origin Browser preview.
        </p>
      </div>
    );
  }

  const hasLoadedPage = hasLoadedPreviewPage(
    activeWebviewSrc,
    webviewPageStatus,
  );
  const pageError = previewPageError(webviewPageStatus, pendingNavError);
  const {
    showLocalPorts,
    hasWebviewLayer,
    webviewLayerInteractive,
  } = previewSurfaceState(
    hasLoadedPage,
    webviewLoading,
    pageError,
    warmWebviewTabs.length,
  );
  const requestComposerSubmit = (): void => {
    window.dispatchEvent(
      new CustomEvent("mcode:submit-composer", {
        detail: { threadId, source: "preview-annotation" },
      }),
    );
  };

  const surfaceWidth = previewSurfaceWidth(surfaceRef.current);
  const showAnnotationCommandBar = shouldShowAnnotationCommandBar(
    designModeActive,
    bundleCount,
  );
  const {
    size: responsiveViewportSize,
    scale: responsiveViewportScale,
  } = responsiveViewportPresentation(
    activeViewportState,
    viewportCanvasBounds,
  );
  return (
    <div
      data-testid="preview-panel"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden",
        webviewLayerInteractive && "pointer-events-none",
      )}
    >
      <BrowserChrome
        viewportToolbarOpen={viewportToolbarOpen}
        activeViewportState={activeViewportState}
        activeViewportCoordinator={activeViewportCoordinator}
        responsiveViewportScale={responsiveViewportScale}
        closeViewportToolbar={closeViewportToolbar}
        invalidateActiveViewportObservation={invalidateActiveViewportObservation}
        coveredLeft={coveredLeft}
        showAnnotationCommandBar={showAnnotationCommandBar}
        pageAnnotations={pageAnnotations}
        bundleCount={bundleCount}
        annotationHeaderPageLabel={annotationHeaderPageLabel}
        threadId={threadId}
        currentPageIdentity={currentPageIdentity}
        requestComposerSubmit={requestComposerSubmit}
        clearTransientAnnotationState={clearTransientAnnotationState}
        designModeSetActive={designModeSetActive}
        webviewInputUrl={webviewInputUrl}
        webviewPageStatus={webviewPageStatus}
        hasLoadedPage={hasLoadedPage}
        webviewCanBack={webviewCanBack}
        webviewCanFwd={webviewCanFwd}
        designModeActive={designModeActive}
        capture={capture}
        omniboxFocusTick={omniboxFocusTick}
        browserWorkspaceId={browserWorkspaceId}
        activeWebviewTabId={activeWebviewTabId}
        onWebviewNavigate={onWebviewNavigate}
        activeWebviewRef={activeWebviewRef}
        onWebviewOpenExternal={onWebviewOpenExternal}
        onToggleDesignMode={onToggleDesignMode}
        tabs={tabs}
        bridge={bridge}
        onWebviewGetZoom={onWebviewGetZoom}
        onWebviewSetZoom={onWebviewSetZoom}
        toggleViewportToolbar={toggleViewportToolbar}
        activeAutomationController={activeAutomationController}
        activeAutomationRequest={activeAutomationRequest}
      />

      <BrowserPageLayer
        warmWebviewTabs={warmWebviewTabs}
        browserWorkspaceId={browserWorkspaceId}
        threadId={threadId}
        automationViewports={automationViewports}
        automationViewportStates={automationViewportStates}
        automationOnly={automationOnly}
        activeWebviewTabId={activeWebviewTabId}
        webviewLayerInteractive={webviewLayerInteractive}
        webviewRefs={webviewRefs}
        workspaceId={workspaceId}
        presentationActive={presentationActive}
        coveredLeft={coveredLeft}
        responsiveViewportSize={responsiveViewportSize}
        clearPendingNavOnCommit={clearPendingNavOnCommit}
        onWebviewPageStatus={onWebviewPageStatus}
        setWebviewCanBack={setWebviewCanBack}
        setWebviewCanFwd={setWebviewCanFwd}
        webviewNavError={webviewNavError}
        surfaceRef={surfaceRef}
        showLocalPorts={showLocalPorts}
        webviewLoading={webviewLoading}
        lastCapture={lastCapture}
        hasWebviewLayer={hasWebviewLayer}
        activeViewportCoordinator={activeViewportCoordinator}
        activeViewportState={activeViewportState}
        viewportCanvasBounds={viewportCanvasBounds}
        responsiveViewportScale={responsiveViewportScale}
        invalidateActiveViewportObservation={invalidateActiveViewportObservation}
        agentControlsBrowser={agentControlsBrowser}
        automationPointer={automationPointer}
        pageError={pageError}
        webviewInputUrl={webviewInputUrl}
        webviewCanBack={webviewCanBack}
        onPreviewErrorRetry={onPreviewErrorRetry}
        activeWebviewRef={activeWebviewRef}
        onWebviewNavigate={onWebviewNavigate}
        designLayer={
          <DesignLayer
            openBubbleBase={openBubbleBase}
            bubbleVisuals={bubbleVisuals}
            bubbleNote={bubbleNote}
            setOutsideWarned={setOutsideWarned}
            capture={capture}
            pageAnnotations={pageAnnotations}
            savedAnnotations={savedAnnotations}
            editingSavedAnnotation={editingSavedAnnotation}
            threadId={threadId}
            editingAnnotationId={editingAnnotationId}
            setEditingAnnotationId={setEditingAnnotationId}
            requestComposerSubmit={requestComposerSubmit}
            onBubbleSlashSelect={onBubbleSlashSelect}
            setBubbleNote={setBubbleNote}
            bubbleNoteInputRef={bubbleNoteInputRef}
            onBubbleSlashKeyDown={onBubbleSlashKeyDown}
            bubbleSlashItems={bubbleSlashItems}
            bubbleSlashSelectedIndex={bubbleSlashSelectedIndex}
            bubbleFileOpen={bubbleFileOpen}
            bubbleFilePopup={bubbleFilePopup}
            bubbleSlashOpen={bubbleSlashOpen}
            setBubbleAdvancedOpen={setBubbleAdvancedOpen}
            designModeActive={designModeActive}
            bubbleRef={bubbleRef}
            outsideWarned={outsideWarned}
            bubbleInputFocused={bubbleInputFocused}
            bubbleAdvancedOpen={bubbleAdvancedOpen}
            surfaceWidth={surfaceWidth}
            onBubbleSlashInputChange={onBubbleSlashInputChange}
            onBubbleFileInputChange={onBubbleFileInputChange}
            setBubbleInputFocused={setBubbleInputFocused}
            canSaveOpenBubble={canSaveOpenBubble}
            colorFormats={colorFormats}
            updateBubbleVisualControl={updateBubbleVisualControl}
            updateColorFormat={updateColorFormat}
            linkedVisualPairs={linkedVisualPairs}
            toggleVisualLinkPair={toggleVisualLinkPair}
            expandedVisualGroups={expandedVisualGroups}
            setExpandedVisualGroups={setExpandedVisualGroups}
            bubbleSlashState={bubbleSlashState}
            bubbleSlashAnchorRect={bubbleSlashAnchorRect}
            dismissBubbleSlash={dismissBubbleSlash}
            retryBubbleSlash={retryBubbleSlash}
            bubbleFileSuggestions={bubbleFileSuggestions}
            handleBubbleMentionSelect={handleBubbleMentionSelect}
            filePopupAnchorRect={filePopupAnchorRect}
          />
        }
      />
    </div>
  );
}
