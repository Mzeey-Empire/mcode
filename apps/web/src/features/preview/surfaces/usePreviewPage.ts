/**
 * Owns resident webview navigation, status hydration and capture feedback. Keeping these effects together preserves their ordering and per-tab navigation guards.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { WS_CHANNELS, type PreviewPageStatus } from "@mcode/contracts";
import { pushEmitter } from "@/transport/ws-transport";
import { isEmptyPreviewTabUrl } from "../navigation/open-url-in-preview";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewFocusStore } from "../state/previewFocusStore";
import { usePreviewTabsStore, type PendingNavError } from "../state/previewTabsStore";
import type { PreviewWebviewHandle } from "./PreviewWebview";
import { formatNavError, usePreviewSurfaceBridge } from "../navigation/usePreviewSurfaceBridge";
import { isPageEligibleNavError, navCodeToPageError } from "../navigation/nav-errors";
import { usePreviewCapture, type PreviewCaptureKind } from "../capture/usePreviewCapture";
import {
  browserAutomationTargetKey,
  isBrowserAutomationAgentControlled,
  selectWarmBrowserTabIds,
} from "../automation/browserAutomationStore";
import { browserSurfaceHost } from "./BrowserSurfaceHostRoot";
import { type usePreviewViewport, PREVIEW_WEBVIEW_FALLBACK_TAB_ID } from "./usePreviewViewport";

/** Checks whether a file-change event belongs to this preview scope. */
export function fileChangeMatchesPreviewScope(
  data: unknown,
  workspaceId: string | null | undefined,
  threadId: string,
): boolean {
  const parsed = WS_CHANNELS["files.changed"].safeParse(data);
  return parsed.success && parsed.data.workspaceId === workspaceId &&
    (parsed.data.threadId === undefined || parsed.data.threadId === threadId);
}

/** Checks whether a persisted turn changed files in this thread. */
export function turnPersistedMatchesPreviewScope(data: unknown, threadId: string): boolean {
  const parsed = WS_CHANNELS["turn.persisted"].safeParse(data);
  return parsed.success && parsed.data.threadId === threadId && parsed.data.filesChanged.length > 0;
}

/** Returns a loopback address eligible for automatic preview reload. */
export function localPreviewAddress(address: string | null): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
      ? address
      : null;
  } catch {
    return null;
  }
}

/** How long the capture confirmation badge stays visible after a successful attach. */
const CAPTURE_CONFIRMATION_DURATION_MS = 2200;

function previewInputUrl(
  pageStatus: PreviewPageStatus,
  activeUrl: string | null,
  pendingNavError: PendingNavError | null,
): string {
  return pendingNavError?.input ?? pageStatus.url ?? activeUrl ?? "";
}

function webRuntimeWithoutDesktopBridge(): boolean {
  return typeof window.desktopBridge?.preview !== "object";
}

function previewTabUrl(
  tab: { readonly url?: string | null } | undefined,
): string | null {
  return tab?.url ?? null;
}

function requestedWebviewUrl(
  requestedUrls: Readonly<Record<string, string | null>>,
  tabId: string,
  activeTabUrl: string | null,
): string | null {
  return requestedUrls[tabId] ?? activeTabUrl;
}

function activeAutomationPointer(
  controller: { readonly pointer?: { readonly x: number; readonly y: number } | null } | undefined,
): { readonly x: number; readonly y: number } | null {
  return controller?.pointer ?? null;
}

/** Uses live page status before the input address when identifying annotations. */
export function previewPageIdentityUrl(
  pageStatus: PreviewPageStatus,
  inputUrl: string,
): string {
  return pageStatus.url ?? inputUrl;
}

interface PreviewPageOptions {
  readonly threadId: string;
  readonly workspaceId: string | null | undefined;
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly automationOnly: boolean;
  readonly tabs: ReturnType<typeof usePreviewViewport>["tabs"];
  readonly browserWorkspaceId: ReturnType<typeof usePreviewViewport>["browserWorkspaceId"];
  readonly activeWebviewTabId: ReturnType<typeof usePreviewViewport>["activeWebviewTabId"];
  readonly automationControllers: ReturnType<typeof usePreviewViewport>["automationControllers"];
  readonly automationActiveRequests: ReturnType<typeof usePreviewViewport>["automationActiveRequests"];
  readonly pendingAgentOpens: ReturnType<typeof usePreviewViewport>["pendingAgentOpens"];
  readonly webviewRefs: RefObject<Record<string, PreviewWebviewHandle | null>>;
  readonly activeBrowserTargetKey: ReturnType<typeof usePreviewViewport>["activeBrowserTargetKey"];
  readonly previewScopeKey: ReturnType<typeof usePreviewViewport>["previewScopeKey"];
  readonly pendingNavError: ReturnType<typeof usePreviewViewport>["pendingNavError"];
}

/** Keeps webview navigation, capture feedback and status effects in their original order. */
export function usePreviewPage({
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
}: PreviewPageOptions) {
  const omniboxFocusTick = usePreviewFocusStore((s) => s.omniboxFocusTick);
  const webRuntime = webRuntimeWithoutDesktopBridge();

  const bridge = usePreviewSurfaceBridge({
    threadId,
    workspaceId,
    surfaceRef,
    automationOnly,
  });
  // Keep each mounted webview's requested URL separate from live page chrome.
  // A redirect updates the chrome, but must not rewrite the React `src` prop
  // while the guest is still navigating.
  const [webviewRequestedUrlByTab, setWebviewRequestedUrlByTab] = useState<Record<string, string | null>>(
    () => {
      const initial: Record<string, string | null> = {};
      for (const tab of tabs.tabSet?.tabs ?? []) {
        if (tab.url) initial[tab.id] = tab.url;
      }
      return initial;
    },
  );
  const webviewRequestedUrlRef = useRef<string | null>(null);
  const setWebviewRequestedUrl = useCallback((tabId: string, nextUrl: string | null): void => {
    webviewRequestedUrlRef.current = nextUrl;
    setWebviewRequestedUrlByTab((prev) => (
      (prev[tabId] ?? null) === nextUrl ? prev : { ...prev, [tabId]: nextUrl }
    ));
  }, []);
  useEffect(() => {
    const visibleTabs = tabs.tabSet?.tabs ?? [];
    // oxlint-disable-next-line react/set-state-in-effect -- A tab's host URL seeds the resident webview src; an in-flight renderer navigation keeps its request until it commits.
    setWebviewRequestedUrlByTab((current) => {
      let next: Record<string, string | null> | null = null;
      for (const tab of visibleTabs) {
        if (!tab.url || current[tab.id] === tab.url) continue;
        const existing = current[tab.id];
        if (existing) {
          // The recorded request only guards redirects while it is still the
          // surface's in-flight address; once it commits, fails, or was never
          // sent, the host's tab URL is newer intent and must replace it.
          const snapshot = browserSurfaceHost.getSnapshot({
            workspaceId: browserWorkspaceId,
            scope: { kind: "thread", id: threadId },
            tabId: tab.id,
          });
          if (snapshot?.phase === "loading" && snapshot.pendingAddress === existing) continue;
        }
        next ??= { ...current };
        next[tab.id] = tab.url;
      }
      return next ?? current;
    });
  }, [browserWorkspaceId, tabs.tabSet?.tabs, threadId]);
  const [webviewNavError, setWebviewNavError] = useState<string | null>(null);
  const [webviewCanBack, setWebviewCanBack] = useState(false);
  const [webviewCanFwd, setWebviewCanFwd] = useState(false);
  const [webviewPageStatus, setWebviewPageStatus] = useState<PreviewPageStatus>(
    {
      url: null,
      title: null,
      favicon: null,
      phase: "loaded",
    },
  );
  // A rejected navigation needs the page it replaced as its superseded marker;
  // async resolve callbacks can't see fresh state, so mirror it in a ref.
  const webviewPageStatusRef = useRef(webviewPageStatus);
  webviewPageStatusRef.current = webviewPageStatus;
  const activeWebviewTabIdRef = useRef(activeWebviewTabId);
  activeWebviewTabIdRef.current = activeWebviewTabId;
  const webviewNavSeqRef = useRef(0);

  // Inline capture confirmation. The composer chip lives in another panel and
  // may scroll off; this badge acknowledges the action where the user is
  // looking. The timer ref lets a second capture reset the dismissal window
  // without leaving a stale badge behind.
  const [lastCapture, setLastCapture] = useState<PreviewCaptureKind | null>(
    null,
  );
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
  const activeWebviewTab = tabs.tabSet?.tabs.find(
    (tab) => tab.id === activeWebviewTabId,
  );
  const hydratedWebviewTargetRef = useRef<string | null>(null);
  const activeWebviewTabUrl = previewTabUrl(activeWebviewTab);
  const activeWebviewSrc = requestedWebviewUrl(
    webviewRequestedUrlByTab,
    activeWebviewTabId,
    activeWebviewTabUrl,
  );
  const warmWebviewTabs = useMemo(() => {
    const sourceTabs =
      tabs.tabSet?.tabs.length
        ? tabs.tabSet.tabs
        : activeWebviewSrc
          ? [
              {
                id: activeWebviewTabId,
                url: activeWebviewSrc,
              },
            ]
          : webRuntime
            ? [{ id: PREVIEW_WEBVIEW_FALLBACK_TAB_ID, url: "about:blank" }]
            : [];
    const warmIds = selectWarmBrowserTabIds(sourceTabs, browserWorkspaceId, threadId, activeWebviewTabId);
    return sourceTabs
      .filter((tab) => warmIds.has(tab.id))
      .map((tab) => ({
        id: tab.id,
        src: webviewRequestedUrlByTab[tab.id] ?? tab.url ?? "about:blank",
      }));
  }, [
    activeWebviewSrc,
    activeWebviewTabId,
    tabs.tabSet,
    threadId,
    browserWorkspaceId,
    webviewRequestedUrlByTab,
    webRuntime,
  ]);
  const activeAutomationController = automationControllers.get(
    browserAutomationTargetKey(browserWorkspaceId, threadId, activeWebviewTabId),
  );
  const activeAutomationRequest = [...automationActiveRequests.values()].find(
    ({ dispatch }) =>
      dispatch.request.workspaceId === browserWorkspaceId &&
      dispatch.target.threadId === threadId && dispatch.target.tabId === activeWebviewTabId,
  );
  const agentControlsBrowser = isBrowserAutomationAgentControlled(
    { controllers: automationControllers, pendingAgentOpens },
    browserWorkspaceId,
    threadId,
    activeWebviewTabId,
  );
  const automationPointer = activeAutomationPointer(activeAutomationController);
  const activeWebviewRef = useCallback(
    (): PreviewWebviewHandle | null =>
      webviewRefs.current[activeWebviewTabId] ?? null,
    [activeWebviewTabId, webviewRefs],
  );

  useEffect(() => {
    const reload = () => {
      if (localPreviewAddress(activeWebviewRef()?.getUrl() ?? null)) activeWebviewRef()?.reload();
    };
    const offChanged = pushEmitter.on("files.changed", (data) => {
      if (fileChangeMatchesPreviewScope(data, workspaceId, threadId)) reload();
    });
    const offPersisted = pushEmitter.on("turn.persisted", (data) => {
      if (turnPersistedMatchesPreviewScope(data, threadId)) reload();
    });
    return () => { offChanged(); offPersisted(); };
  }, [activeWebviewRef, threadId, workspaceId]);

  useEffect(() => {
    webviewRequestedUrlRef.current = activeWebviewSrc;
  }, [activeWebviewSrc]);

  useEffect(() => {
    if (!activeWebviewTabUrl) return;
    const active = activeWebviewRef();
    const nextCanBack = active?.canGoBack() ?? false;
    const nextCanFwd = active?.canGoForward() ?? false;
    // oxlint-disable-next-line react/set-state-in-effect -- A newly active native webview has no navigation event to seed its browser chrome.
    setWebviewCanBack((value) => (value === nextCanBack ? value : nextCanBack));
    // oxlint-disable-next-line react/set-state-in-effect -- A newly active native webview has no navigation event to seed its browser chrome.
    setWebviewCanFwd((value) => (value === nextCanFwd ? value : nextCanFwd));
  }, [
    activeWebviewRef,
    activeWebviewTabUrl,
  ]);

  const hydrateHostTabStatus = useCallback((): boolean => {
    if (!tabs.tabSet) return false;
    if (hydratedWebviewTargetRef.current === activeBrowserTargetKey) return true;
    hydratedWebviewTargetRef.current = activeBrowserTargetKey;
    const nextStatus: PreviewPageStatus = isEmptyPreviewTabUrl(activeWebviewTabUrl)
      ? { url: null, title: null, favicon: null, phase: "loaded" }
      : {
          url: activeWebviewTabUrl,
          title: activeWebviewTab?.title ?? null,
          favicon: activeWebviewTab?.faviconUrl ?? null,
          phase: "loaded",
        };
    setWebviewPageStatus((status) => (
      status.url === nextStatus.url &&
      status.title === nextStatus.title &&
      status.favicon === nextStatus.favicon &&
      status.phase === nextStatus.phase &&
      status.error === undefined
        ? status
        : nextStatus
    ));
    return true;
  }, [
    activeBrowserTargetKey,
    activeWebviewTab,
    activeWebviewTabUrl,
    tabs.tabSet,
  ]);

  const hydrateStoredWebviewStatus = useCallback((): void => {
    hydratedWebviewTargetRef.current = null;
    const stored = bridge.storedUrl.trim();
    if (!stored) {
      setWebviewRequestedUrl(activeWebviewTabId, null);
      setWebviewPageStatus((status) => (
        status.url === null && status.title === null && status.favicon === null &&
        status.phase === "loaded" && status.error === undefined
          ? status
          : { url: null, title: null, favicon: null, phase: "loaded" }
      ));
      return;
    }
    if (activeWebviewRef()?.getUrl() === stored) return;
    if (webviewRequestedUrlRef.current === stored) return;
    setWebviewRequestedUrl(activeWebviewTabId, stored);
  }, [
    activeWebviewRef,
    activeWebviewTabId,
    bridge.storedUrl,
    setWebviewRequestedUrl,
  ]);

  useEffect(() => {
    if (hydrateHostTabStatus()) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Host tab hydration must synchronously replace stale browser chrome before a resident webview becomes visible.
    hydrateStoredWebviewStatus();
  }, [
    hydrateHostTabStatus,
    hydrateStoredWebviewStatus,
  ]);

  // A committed real address on the pending-error tab is the only publish that
  // clears it; republishes of the superseded page (or a blank error tab's null
  // url) must not, or the error would flash and die.
  const clearPendingNavOnCommit = useCallback(
    (tabId: string, url: string | null): void => {
      if (url === null || url.startsWith("about:") || url.startsWith("chrome-error:")) return;
      const pending = usePreviewTabsStore.getState().pendingNavErrorsByScope[previewScopeKey]?.[tabId];
      if (pending && url !== pending.supersededUrl) {
        usePreviewTabsStore.getState().clearPendingNavError(browserWorkspaceId, threadId, tabId);
      }
    },
    [browserWorkspaceId, previewScopeKey, threadId],
  );

  const onWebviewPageStatus = useCallback(
    (status: PreviewPageStatus): void => {
      setWebviewPageStatus(status);
      clearPendingNavOnCommit(activeWebviewTabId, status.url);
      const url = status.url;
      // Title events can arrive without a readable guest URL. They refine the
      // current page and must not erase it, while a titleless null status is an
      // authoritative blank or failed navigation and clears persisted state.
      if (url === null && (status.title !== null || status.phase === "loading")) return;
      const persistedUrl = url === null || url.startsWith("about:") || url.startsWith("chrome-error://")
        ? ""
        : url;
      useDiffStore.getState().setPreviewUrlForThread(threadId, persistedUrl);
    },
    [activeWebviewTabId, clearPendingNavOnCommit, threadId],
  );

  // Page-eligible rejections (missing file, folder, blocked file) replace the
  // page; input-shape failures keep the inline hint. Either way the sibling
  // state for the submitting tab is cleared, and panel-global chrome is only
  // touched while that tab is still active.
  const applyResolveFailure = useCallback(
    (code: string, input: string, tabId: string, supersededUrl: string | null): void => {
      const tabs = usePreviewTabsStore.getState();
      const stillActive = activeWebviewTabIdRef.current === tabId;
      if (stillActive) setWebviewPageStatus((status) => ({ ...status, phase: "loaded" }));
      if (isPageEligibleNavError(code)) {
        tabs.setPendingNavError(browserWorkspaceId, threadId, tabId, {
          input,
          error: navCodeToPageError(code),
          supersededUrl,
        });
        return;
      }
      tabs.clearPendingNavError(browserWorkspaceId, threadId, tabId);
      if (stillActive) setWebviewNavError(formatNavError(code));
    },
    [browserWorkspaceId, threadId],
  );

  const applyResolveSuccess = useCallback(
    (resolvedUrl: string, tabId: string): void => {
      usePreviewTabsStore.getState().clearPendingNavError(browserWorkspaceId, threadId, tabId);
      if (activeWebviewTabIdRef.current !== tabId) {
        // The user moved on mid-resolve; navigate the submitted tab in the
        // background instead of hijacking the active tab's chrome.
        setWebviewRequestedUrl(tabId, resolvedUrl);
        return;
      }
      useDiffStore.getState().setPreviewUrlForThread(threadId, resolvedUrl);
      setWebviewPageStatus({
        url: resolvedUrl,
        title: null,
        favicon: null,
        phase: "loading",
      });
      const active = activeWebviewRef();
      const liveUrl = active?.getUrl();
      const mountedSrc = webviewRequestedUrlRef.current;
      if (liveUrl === resolvedUrl) {
        active?.reload();
        return;
      }
      if (mountedSrc === resolvedUrl) {
        active?.navigate(resolvedUrl);
        return;
      }
      setWebviewRequestedUrl(tabId, resolvedUrl);
    },
    [activeWebviewRef, browserWorkspaceId, setWebviewRequestedUrl, threadId],
  );

  const onWebviewNavigate = useCallback(
    (url: string): void => {
      // Resolve is async: capture the submitting tab and its page so a result
      // landing after a tab switch or a newer submission can't clobber the
      // wrong tab's chrome or pin a stale error over a live page.
      const submitTabId = activeWebviewTabId;
      const submitPageUrl = webviewPageStatusRef.current.url;
      const submitSeq = ++webviewNavSeqRef.current;
      setWebviewNavError(null);
      setWebviewPageStatus((status) => ({ ...status, phase: "loading" }));
      void bridge.resolveNavigation(url).then((result) => {
        // A newer submission supersedes this result entirely.
        if (webviewNavSeqRef.current !== submitSeq) return;
        if (!result.ok) {
          applyResolveFailure(result.error, url, submitTabId, submitPageUrl);
          return;
        }
        applyResolveSuccess(result.url, submitTabId);
      });
    },
    [activeWebviewTabId, applyResolveFailure, applyResolveSuccess, bridge],
  );

  // A rejected address never reached the guest, so there is nothing to reload;
  // retry re-runs the whole resolve + navigate against the attempted input.
  const onPreviewErrorRetry = useCallback((): void => {
    const pending = usePreviewTabsStore.getState().pendingNavErrorsByScope[previewScopeKey]?.[activeWebviewTabId];
    if (pending) {
      onWebviewNavigate(pending.input);
      return;
    }
    void activeWebviewRef()?.reload();
  }, [activeWebviewRef, activeWebviewTabId, onWebviewNavigate, previewScopeKey]);

  const onWebviewOpenExternal = useCallback((): void => {
    const url = activeWebviewRef()?.getUrl() || activeWebviewSrc;
    if (url) void window.desktopBridge?.openExternalUrl(url);
  }, [activeWebviewRef, activeWebviewSrc]);

  const onWebviewGetZoom = useCallback(async (): Promise<number> => {
    return (await activeWebviewRef()?.getZoom()) ?? 1;
  }, [activeWebviewRef]);

  const onWebviewSetZoom = useCallback(
    async (factor: number): Promise<number> => {
      return (await activeWebviewRef()?.setZoom(factor)) ?? factor;
    },
    [activeWebviewRef],
  );

  const webviewInputUrl = previewInputUrl(webviewPageStatus, activeWebviewSrc, pendingNavError);
  const webviewLoading = webviewPageStatus.phase === "loading";

  return {
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
  };
}
