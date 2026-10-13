/**
 * Owns the desktop Browser toolbar, annotation header and viewport toolbar wiring, separate from the page surface and design overlays.
 */
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { BrowserToolbar } from "./BrowserToolbar";
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
import {
  browserAction,
  type BrowserAction,
  type BrowserAddress,
  type BrowserNavigation,
  type BrowserToolbarPage,
  type BrowserTools,
} from "./browserToolbarModel";
import type { PreviewPageError } from "@mcode/contracts";
import { useBrowserCommands } from "./useBrowserCommands";

interface BrowserChromeProps {
  readonly viewportToolbarOpen: ReturnType<typeof usePreviewViewport>["viewportToolbarOpen"];
  readonly activeViewportState: ReturnType<typeof usePreviewViewport>["activeViewportState"];
  readonly activeViewportCoordinator: ReturnType<typeof usePreviewViewport>["activeViewportCoordinator"];
  readonly responsiveViewportScale: number;
  readonly closeViewportToolbar: ReturnType<typeof usePreviewViewport>["closeViewportToolbar"];
  readonly invalidateActiveViewportObservation: ReturnType<typeof usePreviewViewport>["invalidateActiveViewportObservation"];
  readonly coveredRight: number | undefined;
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
  readonly hasLoadedPage: boolean;
  /** The page's load or rejected-navigation error; it wins over an address for the toolbar variant. */
  readonly pageError: PreviewPageError | undefined;
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
  readonly bridge: ReturnType<typeof usePreviewPage>["bridge"];
  readonly onWebviewGetZoom: ReturnType<typeof usePreviewPage>["onWebviewGetZoom"];
  readonly onWebviewSetZoom: ReturnType<typeof usePreviewPage>["onWebviewSetZoom"];
  readonly toggleViewportToolbar: ReturnType<typeof usePreviewViewport>["toggleViewportToolbar"];
  readonly activeAutomationController: ReturnType<typeof usePreviewPage>["activeAutomationController"];
  readonly activeAutomationRequest: ReturnType<typeof usePreviewPage>["activeAutomationRequest"];
  /** Whether this panel is the visible, interactive Browser and so owns the Browser commands. */
  readonly commandsActive: boolean;
}

const LOAD_A_PAGE_FIRST = "Load a page first";

function pageAction(hasLoadedPage: boolean, run: () => void): BrowserAction {
  return browserAction(hasLoadedPage ? null : LOAD_A_PAGE_FIRST, run);
}

type DesktopToolbarInputs = Pick<
  BrowserChromeProps,
  | "threadId"
  | "hasLoadedPage"
  | "pageError"
  | "webviewCanBack"
  | "webviewCanFwd"
  | "designModeActive"
  | "capture"
  | "activeWebviewRef"
  | "onToggleDesignMode"
> & { readonly invalidateObservation: () => void };

function desktopNavigation({
  webviewCanBack,
  webviewCanFwd,
  activeWebviewRef,
  invalidateObservation,
}: DesktopToolbarInputs): BrowserNavigation {
  const withInvalidation = (run: () => void) => () => {
    invalidateObservation();
    run();
  };
  return {
    back: browserAction(webviewCanBack ? null : "No earlier page", withInvalidation(() => activeWebviewRef()?.goBack())),
    forward: browserAction(webviewCanFwd ? null : "No later page", withInvalidation(() => activeWebviewRef()?.goForward())),
    reload: { kind: "enabled", run: withInvalidation(() => activeWebviewRef()?.reload()) },
  };
}

/** Error wins over an address; a page with an address counts as loaded even while it loads. */
function desktopPage(inputs: DesktopToolbarInputs): BrowserToolbarPage {
  const { threadId, hasLoadedPage, pageError, designModeActive, capture, onToggleDesignMode } = inputs;
  if (pageError) return { kind: "error", navigation: desktopNavigation(inputs) };
  if (!hasLoadedPage) return { kind: "new" };
  return {
    kind: "loaded",
    navigation: desktopNavigation(inputs),
    pageActions: {
      kind: "desktop",
      designActive: designModeActive,
      design: browserAction(threadId ? null : "Open a thread first", onToggleDesignMode),
      screenshotArmed: capture.screenshotArmed,
      screenshot: browserAction(
        capture.elementPickBusy ? "Finish picking an element first" : null,
        capture.onToggleScreenshot,
      ),
    },
  };
}

type DesktopToolsInputs = Pick<
  BrowserChromeProps,
  | "threadId"
  | "hasLoadedPage"
  | "activeWebviewTabId"
  | "activeWebviewRef"
  | "bridge"
  | "onWebviewGetZoom"
  | "onWebviewSetZoom"
  | "toggleViewportToolbar"
  | "activeAutomationController"
  | "activeAutomationRequest"
> & { readonly invalidateObservation: () => void; readonly takeControl: () => void };

function desktopTools(inputs: DesktopToolsInputs): BrowserTools {
  const { threadId, hasLoadedPage, activeWebviewTabId, activeWebviewRef, bridge, invalidateObservation } = inputs;
  return {
    deviceToolbar: { kind: "enabled", run: inputs.toggleViewportToolbar },
    developerTools: pageAction(hasLoadedPage, () => {
      void window.desktopBridge?.preview.openGuestDevTools({ threadId, tabId: activeWebviewTabId });
    }),
    forceReload: pageAction(hasLoadedPage, () => {
      invalidateObservation();
      activeWebviewRef()?.forceReload();
    }),
    zoom: hasLoadedPage
      ? { kind: "enabled", read: inputs.onWebviewGetZoom, set: inputs.onWebviewSetZoom }
      : { kind: "disabled", reason: LOAD_A_PAGE_FIRST },
    clearCookies: pageAction(hasLoadedPage, () => void bridge.clearCookies()),
    clearCache: pageAction(hasLoadedPage, () => void bridge.clearCache()),
    takeover: inputs.activeAutomationController?.controller === "agent"
      ? { kind: "agent", busy: inputs.activeAutomationRequest !== undefined, takeControl: inputs.takeControl }
      : { kind: "none" },
  };
}

function desktopAddress(
  props: Pick<BrowserChromeProps, "webviewInputUrl" | "onWebviewNavigate" | "onWebviewOpenExternal" | "activeAutomationController">,
  invalidateObservation: () => void,
): BrowserAddress {
  return {
    url: props.webviewInputUrl,
    onNavigate: (url) => {
      invalidateObservation();
      props.onWebviewNavigate(url);
    },
    openExternal: { kind: "enabled", run: props.onWebviewOpenExternal },
    onHumanFocus: () => {
      if (props.activeAutomationController?.controller === "agent") invalidateObservation();
    },
  };
}

/** Puts the Browser or annotation header in the panel header's row 2; the viewport toolbar stays over the page. */
export function BrowserChrome(props: BrowserChromeProps) {
  const { threadId, browserWorkspaceId, activeWebviewTabId } = props;
  const invalidateObservation = (): void => {
    invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
  };
  const takeControl = (): void => {
    interruptBrowserAutomationTarget(browserWorkspaceId, threadId, activeWebviewTabId, "user-stopped");
  };
  const tools = desktopTools({ ...props, invalidateObservation, takeControl });
  useBrowserCommands({ active: props.commandsActive, actions: tools });

  return (
    <div
      data-testid="browser-chrome"
      className="pointer-events-auto relative z-(--layer-dropdown)"
      style={props.coveredRight ? { clipPath: `inset(0 ${props.coveredRight}px 0 0)` } : undefined}
    >
      <PanelHeaderSlot slot="row2">
        {/* A block wrapper so the header's own flex row spans the full row. */}
        <div data-browser-chrome="" className="min-w-0 flex-1">
          {props.showAnnotationCommandBar ? (
            <AnnotationHeader {...props} />
          ) : (
            <BrowserToolbar
              page={desktopPage({ ...props, invalidateObservation })}
              address={desktopAddress(props, invalidateObservation)}
              tools={tools}
              focusRequest={props.omniboxFocusTick}
            />
          )}
        </div>
      </PanelHeaderSlot>
      <ViewportToolbar {...props} />
    </div>
  );
}

function AnnotationHeader({
  pageAnnotations,
  bundleCount,
  annotationHeaderPageLabel,
  threadId,
  currentPageIdentity,
  requestComposerSubmit,
  clearTransientAnnotationState,
  designModeSetActive,
}: BrowserChromeProps) {
  return (
    <PreviewAnnotationHeader
      pageCount={pageAnnotations.length}
      bundleCount={bundleCount}
      pageLabel={annotationHeaderPageLabel}
      onDiscardPage={() => {
        usePreviewAnnotationStore.getState().discardPage(threadId, currentPageIdentity);
      }}
      onSend={requestComposerSubmit}
      onExit={() => {
        clearTransientAnnotationState();
        designModeSetActive(threadId, false);
        void window.desktopBridge?.preview?.cancelCapture();
      }}
    />
  );
}

function ViewportToolbar({
  viewportToolbarOpen,
  activeViewportState,
  activeViewportCoordinator,
  responsiveViewportScale,
  closeViewportToolbar,
  invalidateActiveViewportObservation,
}: BrowserChromeProps) {
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
}
