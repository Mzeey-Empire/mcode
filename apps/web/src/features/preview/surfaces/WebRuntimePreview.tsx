/**
 * Owns the same-origin web runtime preview and its presentation registration, separate from desktop webview composition.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { pushEmitter } from "@/transport/ws-transport";
import { useDiffStore } from "@/stores/diffStore";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { BrowserToolbar } from "./BrowserToolbar";
import { useBrowserControl } from "./useBrowserControl";
import { BrowserDeviceRow } from "./BrowserDeviceRow";
import { BrowserViewportCanvas } from "./BrowserViewportCanvas";
import type { BrowserAction, BrowserToolbarPage, BrowserTools } from "./browserToolbarModel";
import { useBrowserCommands } from "./useBrowserCommands";
import {
  invalidateBrowserAutomationTargetObservation,
  useBrowserAutomationStore,
} from "../automation/browserAutomationStore";
import {
  isBrowserAutomationWebRuntimeEnabled,
  normalizeWebPreviewUrl,
  resolveWebPreviewState,
} from "../automation/browserAutomationRuntime";
import {
  calculateViewportPresentationScale,
  type ViewportCoordinator,
  type ViewportCoordinatorState,
} from "../automation/services/viewportCoordinator";
import type { BrowserSurfaceIdentity, BrowserSurfacePageState } from "../browser-surfaces";
import { browserSurfaceHost, browserSurfacePresentationCoordinator } from "./BrowserSurfaceHostRoot";
import type {
  BrowserSurfacePresentationRegistration,
  BrowserSurfacePresentationSource,
} from "./BrowserSurfacePresentationCoordinator";
import { fitViewportCanvasBounds } from "./usePreviewViewport";
import {
  localPreviewAddress,
  fileChangeMatchesPreviewScope,
  turnPersistedMatchesPreviewScope,
} from "./usePreviewPage";

function runtimeViewportPresentation(
  crossOriginObserved: boolean,
  requestedAddress: string | null,
  enabled: boolean,
  automationOnly: boolean,
  viewportState: ViewportCoordinatorState | undefined,
  canvasBounds: { readonly width: number; readonly height: number },
): {
  readonly state: ReturnType<typeof resolveWebPreviewState> | "cross-origin";
  readonly surfaceAvailable: boolean;
  readonly presentationSource: BrowserSurfacePresentationSource;
  readonly responsiveViewportSize: { readonly width: number; readonly height: number } | null;
  readonly responsiveViewportScale: number;
} {
  const requestedState = resolveWebPreviewState(requestedAddress, enabled);
  const state = crossOriginObserved ? "cross-origin" : requestedState;
  const responsiveViewportSize =
    viewportState?.mode === "responsive" ? viewportState.confirmed : null;
  const responsiveViewportScale = responsiveViewportSize
    ? calculateViewportPresentationScale(
        responsiveViewportSize,
        fitViewportCanvasBounds(canvasBounds),
        viewportState?.presentation ?? "fit",
      )
    : 1;
  return {
    state,
    surfaceAvailable: enabled && requestedAddress !== null,
    presentationSource: automationOnly ? "automation" : "panel",
    responsiveViewportSize,
    responsiveViewportScale,
  };
}

function runtimeVisiblePage(
  surfaceAvailable: boolean,
  pageState: BrowserSurfacePageState | null,
  requestedAddress: string | null,
): {
  readonly pageState: BrowserSurfacePageState | null;
  readonly address: string | null;
} {
  const visiblePageState = surfaceAvailable ? pageState : null;
  const visibleAddress = visiblePageState?.phase === "error"
    ? visiblePageState.pendingAddress ?? visiblePageState.committedAddress
    : visiblePageState?.committedAddress ?? visiblePageState?.pendingAddress ?? requestedAddress;
  return { pageState: visiblePageState, address: visibleAddress };
}

const DESKTOP_ONLY_REASON = "Available in the desktop app";

function runtimeToolbarPage(
  address: string | null,
  pageState: BrowserSurfacePageState | null,
  reload: BrowserAction,
): BrowserToolbarPage {
  const navigation = {
    back: { kind: "disabled", reason: DESKTOP_ONLY_REASON },
    forward: { kind: "disabled", reason: DESKTOP_ONLY_REASON },
    reload,
  } as const;
  if (pageState?.phase === "error") return { kind: "error", navigation };
  if (!address) return { kind: "new" };
  return { kind: "loaded", navigation, pageActions: { kind: "unavailable" } };
}

function runtimeTools(onToggleViewportToolbar: () => void): BrowserTools {
  const desktopOnly = { kind: "disabled", reason: DESKTOP_ONLY_REASON } as const;
  return {
    deviceToolbar: { kind: "enabled", run: onToggleViewportToolbar },
    developerTools: desktopOnly,
    forceReload: desktopOnly,
    zoom: desktopOnly,
    clearCookies: desktopOnly,
    clearCache: desktopOnly,
  };
}

function RuntimeDeviceRow({
  visible,
  coordinator,
  state,
  scale,
  onClose,
  onUserViewportChange,
}: {
  readonly visible: boolean;
  readonly coordinator: ViewportCoordinator | undefined;
  readonly state: ViewportCoordinatorState | undefined;
  readonly scale: number;
  readonly onClose: () => void;
  readonly onUserViewportChange: () => void;
}): ReactNode {
  if (!visible || !coordinator || !state) return null;
  return (
    <BrowserDeviceRow
      coordinator={coordinator}
      state={state}
      scale={scale}
      onClose={onClose}
      onUserViewportChange={onUserViewportChange}
    />
  );
}

function RuntimePreviewContent({
  state,
  requestedAddress,
  dockRef,
}: {
  readonly state: ReturnType<typeof resolveWebPreviewState> | "cross-origin";
  readonly requestedAddress: string | null;
  readonly dockRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  if (state === "same-origin" && requestedAddress) {
    return <div ref={dockRef} data-testid="web-runtime-preview-dock" className="absolute inset-0 h-full w-full" />;
  }
  if (state === "cross-origin" && requestedAddress) {
    return (
      <>
        <div ref={dockRef} data-testid="web-runtime-preview-dock" className="absolute inset-0 h-full w-full" />
        <div data-testid="web-runtime-cross-origin" className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-warning/40 bg-background/95 px-3 py-2 text-xs text-warning">
          Cross-origin preview is visible, but web automation and DOM access are unsupported.
        </div>
      </>
    );
  }
  return (
    <div data-testid={`web-runtime-${state}`} className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
      {state === "disabled"
        ? "Web preview automation is disabled. Set MCODE_WEB_AUTOMATION=1 and restart agent:up to enable it."
        : "Web preview is unavailable until an HTTP(S) same-origin target is loaded."}
    </div>
  );
}

/** Stable tab id used by the single web-runtime preview target. */
export const WEB_RUNTIME_PREVIEW_TAB_ID = "web-preview";

const WEB_AUTOMATION_FIXTURE_URL = "/browser-automation-fixture.html";

/** Visible same-origin iframe surface used by the worktree-local web runtime. */
export function WebRuntimePreview({
  threadId,
  workspaceId,
  viewportCoordinator,
  viewportState,
  viewportToolbarOpen,
  onToggleViewportToolbar,
  onCloseViewportToolbar,
  automationOnly = false,
  presentationActive = true,
}: {
  readonly threadId: string;
  readonly workspaceId?: string | null;
  readonly viewportCoordinator?: ViewportCoordinator;
  readonly viewportState?: ViewportCoordinatorState;
  readonly viewportToolbarOpen: boolean;
  readonly onToggleViewportToolbar: () => void;
  readonly onCloseViewportToolbar: () => void;
  readonly automationOnly?: boolean;
  readonly presentationActive?: boolean;
}) {
  const storedUrl = useDiffStore((state) => state.previewUrlByThread[threadId] ?? "");
  const fixtureUrl = `${window.location.origin}${WEB_AUTOMATION_FIXTURE_URL}`;
  const [requestedAddress, setRequestedAddress] = useState<string | null>(
    () => normalizeWebPreviewUrl(storedUrl) ?? fixtureUrl,
  );
  const requestedAddressRef = useRef(requestedAddress);
  requestedAddressRef.current = requestedAddress;
  const [pageState, setPageState] = useState<BrowserSurfacePageState | null>(null);
  const [crossOriginObserved, setCrossOriginObserved] = useState(false);
  const [canvasBounds, setCanvasBounds] = useState({ width: 0, height: 0 });
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const presentationRegistrationRef = useRef<BrowserSurfacePresentationRegistration | null>(null);
  const identity = useMemo<BrowserSurfaceIdentity>(() => ({
    workspaceId: workspaceId ?? threadId,
    scope: {
      kind: "thread",
      id: threadId,
    },
    tabId: WEB_RUNTIME_PREVIEW_TAB_ID,
  }), [threadId, workspaceId]);
  const enabled = isBrowserAutomationWebRuntimeEnabled();
  const {
    state,
    surfaceAvailable,
    presentationSource,
    responsiveViewportSize,
    responsiveViewportScale,
  } = runtimeViewportPresentation(
    crossOriginObserved,
    requestedAddress,
    enabled,
    automationOnly,
    viewportState,
    canvasBounds,
  );
  const presentationIntentRef = useRef({
    automationOnly,
    presentationActive,
    presentationSource,
    responsiveViewportSize,
  });
  presentationIntentRef.current = {
    automationOnly,
    presentationActive,
    presentationSource,
    responsiveViewportSize,
  };
  const publishPresentation = useCallback((nextPageState: BrowserSurfacePageState | null): void => {
    const current = presentationIntentRef.current;
    browserSurfacePresentationCoordinator.publish(identity, {
      source: current.presentationSource,
      active: current.automationOnly || current.presentationActive,
      anchor: dockRef.current,
      pageState: nextPageState,
      viewport: current.responsiveViewportSize ?? undefined,
      inputEnabled: !current.automationOnly,
      accessible: !current.automationOnly,
    }, presentationRegistrationRef.current?.token);
  }, [identity]);

  useEffect(() => {
    const reload = () => {
      const current = browserSurfaceHost.getSnapshot(identity);
      const address = localPreviewAddress(current?.committedAddress ?? current?.pendingAddress ?? null);
      if (address) browserSurfaceHost.navigate(identity, address);
    };
    const offChanged = pushEmitter.on("files.changed", (data) => {
      if (fileChangeMatchesPreviewScope(data, workspaceId, threadId)) reload();
    });
    const offPersisted = pushEmitter.on("turn.persisted", (data) => {
      if (turnPersistedMatchesPreviewScope(data, threadId)) reload();
    });
    return () => { offChanged(); offPersisted(); };
  }, [identity, threadId, workspaceId]);
  useLayoutEffect(() => {
    if (!surfaceAvailable) return;
    useBrowserAutomationStore.getState().registerTarget(
      identity.workspaceId,
      threadId,
      WEB_RUNTIME_PREVIEW_TAB_ID,
    );
    const initial = browserSurfaceHost.ensure(identity, {
      address: requestedAddressRef.current ?? fixtureUrl,
    });
    const registration = dockRef.current
      ? browserSurfacePresentationCoordinator.registerAnchor(identity, presentationSource, dockRef.current)
      : null;
    presentationRegistrationRef.current = registration;
    setPageState(initial);
    publishPresentation(initial);
    const unsubscribe = browserSurfaceHost.subscribe(identity, (snapshot) => {
      setPageState(snapshot);
      setCrossOriginObserved(snapshot.documentAccess === "cross-origin");
      publishPresentation(snapshot);
    });
    return () => {
      unsubscribe();
      if (presentationRegistrationRef.current === registration) {
        registration?.release();
        presentationRegistrationRef.current = null;
      }
    };
  }, [automationOnly, fixtureUrl, identity, presentationSource, publishPresentation, surfaceAvailable, threadId]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A stored URL change is an external BrowserSurface session switch that must replace stale local navigation state.
    setRequestedAddress(normalizeWebPreviewUrl(storedUrl) ?? fixtureUrl);
    // oxlint-disable-next-line react/set-state-in-effect -- A stored URL change is an external BrowserSurface session switch that must replace stale local navigation state.
    setCrossOriginObserved(false);
  }, [fixtureUrl, storedUrl]);

  useEffect(() => {
    if (!requestedAddress) return;
    const current = browserSurfaceHost.getSnapshot(identity);
    if (!current) return;
    if (
      current.pendingAddress === requestedAddress ||
      current.committedAddress === requestedAddress
    ) return;
    browserSurfaceHost.navigate(identity, requestedAddress);
  }, [identity, requestedAddress]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => setCanvasBounds({ width: surface.clientWidth, height: surface.clientHeight });
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(surface);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    const update = (): void => {
      publishPresentation(pageState);
    };
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(update)
      : null;
    resizeObserver?.observe(dock);
    window.addEventListener("resize", update);
    update();
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [automationOnly, identity, pageState, presentationActive, presentationSource, publishPresentation, responsiveViewportScale, responsiveViewportSize, state]);

  const navigate = (candidate: string): void => {
    const next = normalizeWebPreviewUrl(candidate);
    if (!next) {
      setRequestedAddress(null);
      setCrossOriginObserved(false);
      return;
    }
    setRequestedAddress(next);
    setCrossOriginObserved(false);
    useDiffStore.getState().setPreviewUrlForThread(threadId, next);
  };

  const tools = runtimeTools(onToggleViewportToolbar);
  const control = useBrowserControl(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID);
  useBrowserCommands({ active: presentationActive && !automationOnly, actions: tools });

  const invalidateViewportObservation = (): void => {
    invalidateBrowserAutomationTargetObservation(identity.workspaceId, threadId, WEB_RUNTIME_PREVIEW_TAB_ID);
  };
  const visiblePage = runtimeVisiblePage(
    surfaceAvailable,
    pageState,
    requestedAddress,
  );
  const reload: BrowserAction = {
    kind: "enabled",
    run: () => {
      invalidateViewportObservation();
      browserSurfaceHost.navigate(identity, visiblePage.address ?? fixtureUrl);
    },
  };

  return (
    <div data-testid="web-runtime-preview" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PanelHeaderSlot slot="row2">
        <div data-browser-chrome="" className="min-w-0 flex-1">
          <BrowserToolbar
            page={runtimeToolbarPage(visiblePage.address, visiblePage.pageState, reload)}
            address={{
              url: visiblePage.address ?? "",
              onNavigate: (url) => {
                invalidateViewportObservation();
                navigate(url);
              },
              openExternal: { kind: "disabled", reason: DESKTOP_ONLY_REASON },
              onHumanFocus: invalidateViewportObservation,
            }}
            tools={tools}
            control={control}
          />
        </div>
      </PanelHeaderSlot>
      <RuntimeDeviceRow
        visible={viewportToolbarOpen || responsiveViewportSize !== null}
        coordinator={viewportCoordinator}
        state={viewportState}
        scale={responsiveViewportScale}
        onClose={onCloseViewportToolbar}
        onUserViewportChange={invalidateViewportObservation}
      />
      <div ref={surfaceRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-hover/10">
        <BrowserViewportCanvas
          coordinator={viewportCoordinator}
          state={viewportState}
          bounds={canvasBounds}
          scale={responsiveViewportScale}
          className="absolute inset-0"
          onUserViewportChange={invalidateViewportObservation}
        >
          <RuntimePreviewContent
            state={state}
            requestedAddress={requestedAddress}
            dockRef={dockRef}
          />
        </BrowserViewportCanvas>
      </div>
    </div>
  );
}
