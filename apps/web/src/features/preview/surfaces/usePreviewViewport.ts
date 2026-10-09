/**
 * Owns the tab and viewport subscriptions and device toolbar lifecycle, separate from page navigation and rendering.
 */
import { useCallback, useEffect, useState } from "react";
import { BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX } from "@mcode/contracts";
import { previewTabsScopeKey, usePreviewTabsStore } from "../state/previewTabsStore";
import { useViewportCoordinatorState } from "./useViewportCoordinatorState";
import { usePreviewTabs } from "../tabs/usePreviewTabs";
import {
  browserAutomationTargetKey,
  invalidateBrowserAutomationTargetObservation,
  useBrowserAutomationStore,
} from "../automation/browserAutomationStore";
import {
  DEFAULT_VIEWPORT_SIZE,
  type ViewportCoordinator,
  type ViewportCoordinatorState,
} from "../automation/services/viewportCoordinator";
import {
  getOrCreateViewportCoordinator,
  waitForViewportLayout,
} from "../automation/services/viewportCoordinatorFactory";
import { WEB_RUNTIME_PREVIEW_TAB_ID } from "./WebRuntimePreview";

function activePreviewTabId(
  tabSet: ReturnType<typeof usePreviewTabs>["tabSet"],
  hasDesktopPreview: boolean,
): string {
  if (tabSet?.activeTabId) return tabSet.activeTabId;
  return hasDesktopPreview
    ? PREVIEW_WEBVIEW_FALLBACK_TAB_ID
    : WEB_RUNTIME_PREVIEW_TAB_ID;
}

function browserWorkspaceScopeId(
  workspaceId: string | null | undefined,
  threadId: string,
): string {
  return workspaceId ?? threadId;
}

/** Fallback tab id used until the host tab list has loaded. */
export const PREVIEW_WEBVIEW_FALLBACK_TAB_ID =
  "__mcode_webview_active_fallback__";

const INACTIVE_VIEWPORT_STATE: ViewportCoordinatorState = {
  mode: "regular",
  presentation: "fit",
  confirmed: DEFAULT_VIEWPORT_SIZE,
  userConfirmed: DEFAULT_VIEWPORT_SIZE,
  targetGeneration: 0,
  pending: null,
  pendingReset: null,
  pendingPresentation: null,
  presentationError: null,
  agentActive: false,
};

function useLiveViewportCoordinatorState(
  coordinator: ViewportCoordinator | undefined,
  projectedState: ViewportCoordinatorState | undefined,
): ViewportCoordinatorState | undefined {
  const fallback = projectedState ?? INACTIVE_VIEWPORT_STATE;
  const state = useViewportCoordinatorState(coordinator, fallback);
  return coordinator || projectedState ? state : undefined;
}

/** Subtracts the existing canvas padding before calculating viewport fit. */
export function fitViewportCanvasBounds(bounds: { readonly width: number; readonly height: number }): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(0, bounds.width - BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX),
    height: Math.max(0, bounds.height - BROWSER_AUTOMATION_VIEWPORT_CANVAS_PADDING_PX),
  };
}

interface PreviewViewportOptions {
  readonly threadId: string;
  readonly workspaceId: string | null | undefined;
}

/** Subscribes tabs and viewport state and wires the existing device toolbar lifecycle. */
export function usePreviewViewport({
  threadId,
  workspaceId,
}: PreviewViewportOptions) {
  // Subscribes the scope's tab set into usePreviewTabsStore and exposes the
  // "New page" action for the header. Page switching/closing is driven from the
  // activity rail (the page switcher), so this panel no longer renders a strip.
  const tabs = usePreviewTabs(threadId, workspaceId);
  const automationControllers = useBrowserAutomationStore((state) => state.controllers);
  const pendingAgentOpens = useBrowserAutomationStore((state) => state.pendingAgentOpens);
  const automationActiveRequests = useBrowserAutomationStore((state) => state.activeRequests);
  const automationLiveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const automationViewports = useBrowserAutomationStore((state) => state.viewportByTarget);
  const automationViewportStates = useBrowserAutomationStore((state) => state.viewportStateByTarget);
  const automationViewportCoordinators = useBrowserAutomationStore((state) => state.viewportCoordinators);
  const activeWebviewTabId = activePreviewTabId(
    tabs.tabSet,
    Boolean(window.desktopBridge?.preview),
  );
  const browserWorkspaceId = browserWorkspaceScopeId(workspaceId, threadId);
  const previewScopeKey = previewTabsScopeKey(browserWorkspaceId, threadId);
  // A rejected local navigation lives outside webviewPageStatus: hydration and
  // mount publishes rewrite that state, so the error survives in a keyed slot
  // until a real commit for its tab or the tab closes.
  const pendingNavError = usePreviewTabsStore(
    (s) => s.pendingNavErrorsByScope[previewScopeKey]?.[activeWebviewTabId] ?? null,
  );
  const activeBrowserTargetKey = browserAutomationTargetKey(browserWorkspaceId, threadId, activeWebviewTabId);
  const projectedActiveViewportState: ViewportCoordinatorState | undefined =
    automationViewportStates.get(activeBrowserTargetKey);
  const activeViewportCoordinator = automationViewportCoordinators.get(activeBrowserTargetKey);
  const activeViewportState = useLiveViewportCoordinatorState(
    activeViewportCoordinator,
    projectedActiveViewportState,
  );
  const [viewportToolbarOpen, setViewportToolbarOpen] = useState(false);
  useEffect(() => {
    if (window.desktopBridge?.preview) return;
    const target = automationLiveTargets.get(activeBrowserTargetKey);
    if (!target) return;
    getOrCreateViewportCoordinator({
      existing: automationViewportCoordinators.get(activeBrowserTargetKey),
      target,
      initial: automationViewportStates.get(activeBrowserTargetKey)?.confirmed ??
        automationViewports.get(activeBrowserTargetKey) ?? DEFAULT_VIEWPORT_SIZE,
      mode: automationViewportStates.get(activeBrowserTargetKey)?.mode,
      presentation: automationViewportStates.get(activeBrowserTargetKey)?.presentation,
      targetGeneration: target.revision,
      surface: {
        setViewport: (size, operation, coordinator) => useBrowserAutomationStore.getState().applyViewportIfCurrent(
          browserWorkspaceId,
          threadId,
          activeWebviewTabId,
          coordinator,
          operation.targetGeneration,
          size,
        ),
        resetViewport: (operation, coordinator) => useBrowserAutomationStore.getState().resetViewportIfCurrent(
          browserWorkspaceId,
          threadId,
          activeWebviewTabId,
          coordinator,
          operation.targetGeneration,
        ),
        readViewport: () => useBrowserAutomationStore.getState().viewportByTarget.get(activeBrowserTargetKey) ?? null,
        waitForLayout: waitForViewportLayout,
        isCurrent: (operation, coordinator) => {
          const current = useBrowserAutomationStore.getState();
          return current.viewportCoordinators.get(activeBrowserTargetKey) === coordinator &&
            current.liveTargets.get(activeBrowserTargetKey)?.revision === operation.targetGeneration;
        },
      },
      readConfirmed: () => useBrowserAutomationStore.getState().viewportStateByTarget.get(activeBrowserTargetKey)?.confirmed ??
        useBrowserAutomationStore.getState().viewportByTarget.get(activeBrowserTargetKey) ?? null,
      onStateChange: (nextState, coordinator) => useBrowserAutomationStore.getState().setViewportState(
        browserWorkspaceId,
        threadId,
        activeWebviewTabId,
        nextState,
        coordinator,
      ),
      onCreated: (coordinator) => useBrowserAutomationStore.getState().setViewportCoordinator(
        browserWorkspaceId,
        threadId,
        activeWebviewTabId,
        coordinator,
      ),
    });
  }, [
    activeBrowserTargetKey,
    activeWebviewTabId,
    automationLiveTargets,
    automationViewports,
    automationViewportStates,
    automationViewportCoordinators,
    threadId,
    browserWorkspaceId,
  ]);
  const invalidateActiveViewportObservation = useCallback((): void => {
    invalidateBrowserAutomationTargetObservation(browserWorkspaceId, threadId, activeWebviewTabId);
  }, [activeWebviewTabId, browserWorkspaceId, threadId]);
  useEffect(() => {
    if (!viewportToolbarOpen || !activeViewportCoordinator) return;
    let cancelled = false;
    void (async () => {
      await activeViewportCoordinator.requestUserMode("responsive");
      if (!cancelled) await activeViewportCoordinator.setPresentation("fit");
    })();
    return () => {
      cancelled = true;
    };
  }, [activeViewportCoordinator, viewportToolbarOpen]);
  const toggleViewportToolbar = useCallback((): void => {
    const next = !(viewportToolbarOpen || activeViewportState?.mode === "responsive");
    setViewportToolbarOpen(next);
    invalidateActiveViewportObservation();
    if (!next) void activeViewportCoordinator?.requestUserMode("regular");
  }, [activeViewportCoordinator, activeViewportState?.mode, invalidateActiveViewportObservation, viewportToolbarOpen]);
  const closeViewportToolbar = useCallback((): void => {
    void activeViewportCoordinator?.requestUserMode("regular");
    setViewportToolbarOpen(false);
  }, [activeViewportCoordinator]);

  return {
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
  };
}
