/**
 * Owns the existing Browser header, annotation header and viewport toolbar wiring, separate from the page surface and design overlays.
 */
import type { ReactNode } from "react";
import { BrowserHeader } from "./BrowserHeader";
import { BrowserViewportToolbar } from "./BrowserViewportToolbar";
import { PreviewAnnotationHeader } from "./PreviewAnnotationHeader";
import { usePreviewAnnotationStore } from "../state/previewAnnotationStore";
import {
  interruptBrowserAutomationTarget,
  invalidateBrowserAutomationTargetObservation,
} from "../automation/browserAutomationStore";
import type { usePreviewViewport } from "./usePreviewViewport";
import type { useDesignAnnotationEditor } from "../design/useDesignAnnotationEditor";
import type { useDesignPicker } from "../design/useDesignPicker";
import type { useDesignAnnotationState } from "../design/useDesignAnnotationState";
import type { usePreviewPage } from "./usePreviewPage";

interface BrowserChromeProps {
  readonly viewportToolbarOpen: ReturnType<typeof usePreviewViewport>["viewportToolbarOpen"];
  readonly activeViewportState: ReturnType<typeof usePreviewViewport>["activeViewportState"];
  readonly activeViewportCoordinator: ReturnType<typeof usePreviewViewport>["activeViewportCoordinator"];
  readonly responsiveViewportScale: number;
  readonly closeViewportToolbar: ReturnType<typeof usePreviewViewport>["closeViewportToolbar"];
  readonly invalidateActiveViewportObservation: ReturnType<typeof usePreviewViewport>["invalidateActiveViewportObservation"];
  readonly coveredLeft: number | undefined;
  readonly showAnnotationCommandBar: boolean;
  readonly pageAnnotations: ReturnType<typeof useDesignAnnotationEditor>["pageAnnotations"];
  readonly bundleCount: ReturnType<typeof useDesignAnnotationEditor>["bundleCount"];
  readonly annotationHeaderPageLabel: ReturnType<typeof useDesignAnnotationEditor>["annotationHeaderPageLabel"];
  readonly threadId: string;
  readonly currentPageIdentity: ReturnType<typeof useDesignAnnotationEditor>["currentPageIdentity"];
  readonly requestComposerSubmit: () => void;
  readonly clearTransientAnnotationState: ReturnType<typeof useDesignPicker>["clearTransientAnnotationState"];
  readonly designModeSetActive: ReturnType<typeof useDesignAnnotationState>["designModeSetActive"];
  readonly webviewInputUrl: ReturnType<typeof usePreviewPage>["webviewInputUrl"];
  readonly webviewPageStatus: ReturnType<typeof usePreviewPage>["webviewPageStatus"];
  readonly hasLoadedPage: boolean;
  readonly webviewCanBack: ReturnType<typeof usePreviewPage>["webviewCanBack"];
  readonly webviewCanFwd: ReturnType<typeof usePreviewPage>["webviewCanFwd"];
  readonly designModeActive: ReturnType<typeof useDesignAnnotationState>["designModeActive"];
  readonly capture: ReturnType<typeof usePreviewPage>["capture"];
  readonly omniboxFocusTick: ReturnType<typeof usePreviewPage>["omniboxFocusTick"];
  readonly browserWorkspaceId: ReturnType<typeof usePreviewViewport>["browserWorkspaceId"];
  readonly activeWebviewTabId: ReturnType<typeof usePreviewViewport>["activeWebviewTabId"];
  readonly onWebviewNavigate: ReturnType<typeof usePreviewPage>["onWebviewNavigate"];
  readonly activeWebviewRef: ReturnType<typeof usePreviewPage>["activeWebviewRef"];
  readonly onWebviewOpenExternal: ReturnType<typeof usePreviewPage>["onWebviewOpenExternal"];
  readonly onToggleDesignMode: ReturnType<typeof useDesignPicker>["onToggleDesignMode"];
  readonly tabs: ReturnType<typeof usePreviewViewport>["tabs"];
  readonly bridge: ReturnType<typeof usePreviewPage>["bridge"];
  readonly onWebviewGetZoom: ReturnType<typeof usePreviewPage>["onWebviewGetZoom"];
  readonly onWebviewSetZoom: ReturnType<typeof usePreviewPage>["onWebviewSetZoom"];
  readonly toggleViewportToolbar: ReturnType<typeof usePreviewViewport>["toggleViewportToolbar"];
  readonly activeAutomationController: ReturnType<typeof usePreviewPage>["activeAutomationController"];
  readonly activeAutomationRequest: ReturnType<typeof usePreviewPage>["activeAutomationRequest"];
}

/** Renders the existing header and toolbar without adding a DOM wrapper. */
export function BrowserChrome({
  viewportToolbarOpen,
  activeViewportState,
  activeViewportCoordinator,
  responsiveViewportScale,
  closeViewportToolbar,
  invalidateActiveViewportObservation,
  coveredLeft,
  showAnnotationCommandBar,
  pageAnnotations,
  bundleCount,
  annotationHeaderPageLabel,
  threadId,
  currentPageIdentity,
  requestComposerSubmit,
  clearTransientAnnotationState,
  designModeSetActive,
  webviewInputUrl,
  webviewPageStatus,
  hasLoadedPage,
  webviewCanBack,
  webviewCanFwd,
  designModeActive,
  capture,
  omniboxFocusTick,
  browserWorkspaceId,
  activeWebviewTabId,
  onWebviewNavigate,
  activeWebviewRef,
  onWebviewOpenExternal,
  onToggleDesignMode,
  tabs,
  bridge,
  onWebviewGetZoom,
  onWebviewSetZoom,
  toggleViewportToolbar,
  activeAutomationController,
  activeAutomationRequest,
}: BrowserChromeProps) {
  const renderViewportToolbar = (): ReactNode => {
    if (!viewportToolbarOpen && activeViewportState?.mode !== "responsive") return null;
    if (!activeViewportCoordinator || !activeViewportState) return null;
    return (
      <BrowserViewportToolbar
        coordinator={activeViewportCoordinator}
        state={activeViewportState}
        scale={responsiveViewportScale}
        onClose={closeViewportToolbar}
        onUserViewportChange={invalidateActiveViewportObservation}
      />
    );
  };

  return (
    <div
      className="pointer-events-auto relative z-(--layer-dropdown)"
      style={coveredLeft ? { clipPath: `inset(0 0 0 ${coveredLeft}px)` } : undefined}
    >
        {showAnnotationCommandBar ? (
          <PreviewAnnotationHeader
            pageCount={pageAnnotations.length}
            bundleCount={bundleCount}
            pageLabel={annotationHeaderPageLabel}
            onDiscardPage={() => {
              usePreviewAnnotationStore
                .getState()
                .discardPage(threadId, currentPageIdentity);
            }}
            onSend={requestComposerSubmit}
            onExit={() => {
              clearTransientAnnotationState();
              designModeSetActive(threadId, false);
              void window.desktopBridge?.preview?.cancelCapture();
            }}
          />
        ) : (
          <BrowserHeader
            url={webviewInputUrl}
            pageTitle={webviewPageStatus.title}
            faviconUrl={webviewPageStatus.favicon}
            hasLoadedPage={hasLoadedPage}
            canBack={webviewCanBack}
            canFwd={webviewCanFwd}
            threadId={threadId}
            designModeActive={designModeActive}
            elementPickBusy={capture.elementPickBusy}
            captureBusy={capture.captureBusy}
            regionBusy={capture.regionBusy}
            focusRequest={omniboxFocusTick}
            onNavigate={(url) => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              onWebviewNavigate(url);
            }}
            onGoBack={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              activeWebviewRef()?.goBack();
            }}
            onGoForward={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              activeWebviewRef()?.goForward();
            }}
            onReload={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              activeWebviewRef()?.reload();
            }}
            onOpenExternal={onWebviewOpenExternal}
            onToggleDesign={onToggleDesignMode}
            onScreenshot={capture.onAddPictureReference}
            onNewPage={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              tabs.newTab();
            }}
            onForceReload={() => {
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
              activeWebviewRef()?.forceReload();
            }}
            onRegionCapture={capture.onAddRegionPictureReference}
            onDumpContent={capture.onAddPageContextOnly}
            onClearCookies={bridge.clearCookies}
            onClearCache={bridge.clearCache}
            onGetZoom={onWebviewGetZoom}
            onSetZoom={onWebviewSetZoom}
            onOpenDevTools={() => {
              void window.desktopBridge?.preview.openGuestDevTools({
                threadId,
                tabId: activeWebviewTabId,
              });
            }}
            onToggleViewportToolbar={toggleViewportToolbar}
            viewportToolbarVisible={viewportToolbarOpen || activeViewportState?.mode === "responsive"}
            automationController={activeAutomationController ?? null}
            automationBusy={activeAutomationRequest !== undefined}
            onHumanFocus={() => {
              if (activeAutomationController?.controller !== "agent") return;
              invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
            }}
            onStopAutomation={() =>
              interruptBrowserAutomationTarget(
                browserWorkspaceId,
                threadId,
                activeWebviewTabId,
                "user-stopped",
              )
            }
          />
        )}
      {renderViewportToolbar()}
    </div>
  );

}
