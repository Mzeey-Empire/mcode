import { useMemo } from "react";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserDeviceRow } from "./BrowserDeviceRow";
import { invalidateBrowserAutomationTargetObservation } from "../automation/browserAutomationStore";
import { useBrowserControl } from "./useBrowserControl";
import type { usePreviewViewport } from "./usePreviewViewport";
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
  type BrowserTrustException,
} from "./browserToolbarModel";
import type { PreviewPageError } from "@mcode/contracts";
import { useBrowserCommands } from "./useBrowserCommands";
import { useBrowserCertificate, type BrowserCertificate } from "./useBrowserCertificate";

interface BrowserChromeProps {
  readonly viewportToolbarOpen: ReturnType<typeof usePreviewViewport>["viewportToolbarOpen"];
  readonly activeViewportState: ReturnType<typeof usePreviewViewport>["activeViewportState"];
  readonly activeViewportCoordinator: ReturnType<typeof usePreviewViewport>["activeViewportCoordinator"];
  readonly responsiveViewportScale: number;
  readonly closeViewportToolbar: ReturnType<typeof usePreviewViewport>["closeViewportToolbar"];
  readonly invalidateActiveViewportObservation: ReturnType<typeof usePreviewViewport>["invalidateActiveViewportObservation"];
  readonly coveredRight: number | undefined;
  readonly threadId: string;
  readonly webviewInputUrl: ReturnType<typeof usePreviewPage>["webviewInputUrl"];
  readonly hasLoadedPage: boolean;
  readonly webviewLoading: ReturnType<typeof usePreviewPage>["webviewLoading"];
  /** Load or rejected-navigation error, taking precedence over the address. */
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
      design: browserAction(threadId ? null : "Open a thread to add notes", onToggleDesignMode),
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
> & { readonly invalidateObservation: () => void };

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
  };
}

function desktopAddress(
  props: Pick<BrowserChromeProps, "webviewInputUrl" | "onWebviewNavigate" | "onWebviewOpenExternal" | "activeAutomationController">,
  invalidateObservation: () => void,
  trustException: BrowserAddress["trustException"],
): BrowserAddress {
  return {
    url: props.webviewInputUrl,
    trustException,
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

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The exception a loaded page rests on. A failed page has none, because the warning page shows instead. */
function loadedOnTrust(
  certificate: BrowserCertificate,
  url: string,
  pageError: PreviewPageError | undefined,
): BrowserTrustException | undefined {
  const host = certificate.state?.exceptionInUse && !pageError ? hostOf(url) : null;
  return host === null ? undefined : { host, stopTrusting: () => void certificate.revoke() };
}

/** Browser header with annotation controls and a viewport toolbar. */
export function BrowserChrome(props: BrowserChromeProps) {
  const { threadId, browserWorkspaceId, activeWebviewTabId } = props;
  const invalidateObservation = (): void => {
    invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
  };
  const control = useBrowserControl(browserWorkspaceId, threadId, activeWebviewTabId);
  const identity = useMemo(
    () => ({ workspaceId: browserWorkspaceId, scope: { kind: "thread" as const, id: threadId }, tabId: activeWebviewTabId }),
    [browserWorkspaceId, threadId, activeWebviewTabId],
  );
  const certificate = useBrowserCertificate(
    identity,
    // Loading is part of the revision because a fresh tab reads before the guest is adopted and then loads the same address.
    `${props.webviewInputUrl}|${props.pageError?.code ?? ""}|${props.webviewLoading}`,
    () => void props.activeWebviewRef()?.reload(),
  );
  const trustException = loadedOnTrust(certificate, props.webviewInputUrl, props.pageError);
  const tools = desktopTools({ ...props, invalidateObservation });
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
          <BrowserToolbar
            page={desktopPage({ ...props, invalidateObservation })}
            address={desktopAddress(props, invalidateObservation, trustException)}
            tools={tools}
            control={control}
            focusRequest={props.omniboxFocusTick}
          />
        </div>
      </PanelHeaderSlot>
      <DeviceRow {...props} />
    </div>
  );
}

function DeviceRow({
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
    <BrowserDeviceRow
      coordinator={activeViewportCoordinator}
      state={activeViewportState}
      scale={responsiveViewportScale}
      onClose={closeViewportToolbar}
      onUserViewportChange={invalidateActiveViewportObservation}
    />
  );
}
