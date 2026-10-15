import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { useShallow } from "zustand/shallow";
import type { BrowserTabSet } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useBrowserThreadActing } from "@/features/preview/state/useBrowserActing";
import { useUiStore } from "@/stores/uiStore";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  COMPOSER_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  maxPanelWidthInSplit,
  projectRightPanelForScope,
  getDefaultPanelWidthPx,
  isSubagentTabInstance,
  rightPanelOpenTools,
} from "@/stores/diffStore";
import { PlanPanel } from "./plan";
import { PanelEmptyState } from "./PanelEmptyState";
import { ACTIVITY_RAIL_FLOATING_OVERLAP_PX, ActivityRail } from "./ActivityRail";
import { PanelHeader, PanelHeaderSlotScope, PanelToggleButton, type PanelHeaderElements } from "./shell/PanelHeader";
import { windowChromeKind } from "@/components/shell/window-chrome";
import type { PanelScope } from "@/lib/panel-tabs";
import { DiffPanel } from "@/components/diff";
import {
  BROWSER_AUTOMATION_WARM_TARGET_LIMIT,
  BrowserTabStrip,
  PreviewPanel,
  browserAutomationScopeKey,
  browserAutomationTargetKey,
  useBrowserAutomationStore,
  usePreviewTabSet,
  usePreviewTabsStore,
  browserSurfacePresentationCoordinator,
  type BrowserAutomationActiveRequest,
  type BrowserAutomationLiveTarget,
  type BrowserAutomationPendingAgentOpen,
  type BrowserSessionLifecycleTab,
} from "@/features/preview";
import {
  useTerminalStore,
  type TerminalInstance,
} from "@/features/terminal";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { OverlayGateContext } from "@/components/ui/overlay-gate";
import { ResizableRightPanel } from "./ResizableRightPanel";

/** One thread/workspace Browser panel retained by the warm LRU pool. */
export interface WarmPreviewScope {
  readonly scopeId: string;
  readonly workspaceId: string;
  readonly lastUsedAt: number;
}

function warmPreviewScopeKey(scope: Pick<WarmPreviewScope, "scopeId" | "workspaceId">): string {
  return browserAutomationScopeKey(scope.workspaceId, scope.scopeId);
}

/**
 * Retain active and agent-busy Browser scopes, then fill the warm budget by
 * recency. Busy scopes are leased until their operation settles.
 */
export function reconcileWarmPreviewScopes(
  previous: readonly WarmPreviewScope[],
  next: WarmPreviewScope | null,
  busyScopeKeys: ReadonlySet<string>,
): readonly WarmPreviewScope[] {
  const byId = new Map(previous.map((scope) => [warmPreviewScopeKey(scope), scope]));
  if (next) byId.set(warmPreviewScopeKey(next), next);
  const ordered = [...byId.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const leased = ordered.filter(
    (scope) => (next !== null && warmPreviewScopeKey(scope) === warmPreviewScopeKey(next)) ||
      busyScopeKeys.has(warmPreviewScopeKey(scope)),
  );
  const selected = new Map(leased.map((scope) => [warmPreviewScopeKey(scope), scope]));
  for (const scope of ordered) {
    if (selected.size >= BROWSER_AUTOMATION_WARM_TARGET_LIMIT) break;
    selected.set(warmPreviewScopeKey(scope), scope);
  }
  const result = [...selected.values()];
  return result.length === previous.length &&
    result.every((scope, index) => scope === previous[index])
    ? previous
    : result;
}
import { SubagentDetailTab, SubagentsPanel, useSubagentRoster } from "@/features/subagents";
import { ProjectEnvironmentPanel } from "@/features/projects/environment";
import { TerminalTool } from "./TerminalTool";
import { FilesTool } from "@/features/files/FilesTool";

const EMPTY_SCOPE_TERMINALS: readonly TerminalInstance[] = [];

interface AgentPageSelectorState {
  readonly activeRequests: ReadonlyMap<string, BrowserAutomationActiveRequest>;
  readonly lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  readonly liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  readonly pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
}

type WarmPreviewScopesAction =
  | {
      readonly type: "activate";
      readonly scope: Pick<WarmPreviewScope, "scopeId" | "workspaceId">;
      readonly busyScopeIds: ReadonlySet<string>;
      readonly becameActive: boolean;
    }
  | {
      readonly type: "reconcile";
      readonly activeWorkspaceId: string | null;
      readonly browserScopePresent: boolean;
      readonly busyScopeIds: ReadonlySet<string>;
      readonly panelScopeId: string | null;
      readonly previewActive: boolean;
    };

function warmPreviewScopesReducer(
  previous: readonly WarmPreviewScope[],
  action: WarmPreviewScopesAction,
): readonly WarmPreviewScope[] {
  if (action.type === "activate") {
    const existing = previous.find(
      (scope) =>
        scope.scopeId === action.scope.scopeId && scope.workspaceId === action.scope.workspaceId,
    );
    const next = !existing || action.becameActive
      ? { ...action.scope, lastUsedAt: Date.now() }
      : existing;
    return reconcileWarmPreviewScopes(previous, next, action.busyScopeIds);
  }

  const retained =
    !action.previewActive &&
    !action.browserScopePresent &&
    action.panelScopeId &&
    action.activeWorkspaceId &&
    !action.busyScopeIds.has(
      browserAutomationScopeKey(action.activeWorkspaceId, action.panelScopeId),
    )
      ? previous.filter(
          (scope) =>
            scope.scopeId !== action.panelScopeId ||
            scope.workspaceId !== action.activeWorkspaceId,
        )
      : previous;
  return reconcileWarmPreviewScopes(retained, null, action.busyScopeIds);
}

function latestPendingAgentPageId(
  pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>,
  workspaceId: string | null,
  scopeId: string | null,
): string | null {
  let latest: BrowserAutomationPendingAgentOpen | null = null;
  for (const pending of pendingAgentOpens.values()) {
    if (pending.workspaceId !== workspaceId || pending.threadId !== scopeId) continue;
    if (!latest || pending.startedAt > latest.startedAt) latest = pending;
  }
  return latest?.tabId ?? null;
}

function latestActiveAgentPageId(
  activeRequests: ReadonlyMap<string, BrowserAutomationActiveRequest>,
  workspaceId: string | null,
  scopeId: string | null,
): string | null {
  let latest: BrowserAutomationActiveRequest | null = null;
  for (const request of activeRequests.values()) {
    if (
      request.dispatch.request.workspaceId !== workspaceId ||
      request.dispatch.target.threadId !== scopeId
    ) continue;
    if (!latest || request.startedAt > latest.startedAt) latest = request;
  }
  return latest?.dispatch.target.tabId ?? null;
}

function latestOwnedAgentPageId(
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>,
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>,
  workspaceId: string | null,
  scopeId: string | null,
): string | null {
  let tabId: string | null = null;
  let lastUsedAt = 0;
  for (const lifecycle of lifecycleTabs.values()) {
    if (!isOwnedAgentLifecycle(lifecycle, workspaceId, scopeId)) continue;
    const targetLastUsedAt = getTargetLastUsedAt(liveTargets, workspaceId!, scopeId!, lifecycle.tabId);
    if (tabId === null || targetLastUsedAt > lastUsedAt) {
      tabId = lifecycle.tabId;
      lastUsedAt = targetLastUsedAt;
    }
  }
  return tabId;
}

function isOwnedAgentLifecycle(
  lifecycle: BrowserSessionLifecycleTab,
  workspaceId: string | null,
  scopeId: string | null,
): boolean {
  return lifecycle.workspaceId === workspaceId &&
    lifecycle.threadId === scopeId &&
    lifecycle.provenance === "agent-created" &&
    lifecycle.ownership === "owned";
}

function getTargetLastUsedAt(
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>,
  workspaceId: string,
  scopeId: string,
  tabId: string,
): number {
  return liveTargets.get(browserAutomationTargetKey(workspaceId, scopeId, tabId))?.lastUsedAt ?? 0;
}

function selectAgentPageIds(
  state: AgentPageSelectorState,
  workspaceId: string | null,
  scopeId: string | null,
): readonly [string | null, string | null, string | null] {
  return [
    latestPendingAgentPageId(state.pendingAgentOpens, workspaceId, scopeId),
    latestActiveAgentPageId(state.activeRequests, workspaceId, scopeId),
    latestOwnedAgentPageId(state.lifecycleTabs, state.liveTargets, workspaceId, scopeId),
  ];
}

interface AgentBrowserPage {
  readonly tabId: string;
  readonly presenting: boolean;
}

interface ExistingPreviewReveal {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly agentBrowserPage: AgentBrowserPage | null;
  readonly browserTabSet: BrowserTabSet | null;
  readonly panelScopeId: string | null;
  readonly revealExistingPreview: boolean;
  readonly requestedAgentPageActivationRef: RefObject<string | null>;
}

function canRevealExistingPreview(
  hasNonPreviewTab: boolean,
  currentVisible: boolean,
  agentBrowserPage: AgentBrowserPage | null,
): boolean {
  return currentVisible && (!hasNonPreviewTab || agentBrowserPage?.presenting === true);
}

function requestExistingPreviewPageActivation({
  activeWorkspaceId,
  agentBrowserPage,
  browserTabSet,
  panelScopeId,
  requestedAgentPageActivationRef,
}: Omit<ExistingPreviewReveal, "activeThreadId" | "revealExistingPreview">): void {
  const existingPageId = getExistingPreviewPageId(agentBrowserPage, browserTabSet);
  if (!panelScopeId || !existingPageId) return;
  const activationKey = `${panelScopeId}:${existingPageId}`;
  if (!shouldActivateExistingPreview(browserTabSet, activationKey, existingPageId, requestedAgentPageActivationRef)) return;
  requestedAgentPageActivationRef.current = activationKey;
  void usePreviewTabsStore.getState().activatePage(activeWorkspaceId!, panelScopeId, existingPageId);
}

function getExistingPreviewPageId(
  agentBrowserPage: AgentBrowserPage | null,
  browserTabSet: BrowserTabSet | null,
): string | null | undefined {
  return agentBrowserPage?.tabId ?? browserTabSet?.activeTabId ?? browserTabSet?.tabs[0]?.id;
}

function shouldActivateExistingPreview(
  browserTabSet: BrowserTabSet | null,
  activationKey: string,
  existingPageId: string,
  requestedAgentPageActivationRef: RefObject<string | null>,
): boolean {
  return browserTabSet?.activeTabId !== existingPageId &&
    requestedAgentPageActivationRef.current !== activationKey;
}

function synchronizeExistingPreview({
  activeThreadId,
  activeWorkspaceId,
  agentBrowserPage,
  browserTabSet,
  panelScopeId,
  revealExistingPreview: shouldRevealExistingPreview,
  requestedAgentPageActivationRef,
}: ExistingPreviewReveal): void {
  if (!shouldRevealExistingPreview || !activeWorkspaceId) return;
  const current = useDiffStore.getState().getRightPanel(activeWorkspaceId, activeThreadId);
  const hasNonPreviewTab = current.tabInstances.some((instance) => instance.type !== "preview");
  if (!canRevealExistingPreview(hasNonPreviewTab, current.visible, agentBrowserPage)) return;
  if (current.activeTab !== "preview") {
    useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "preview");
  }
  requestExistingPreviewPageActivation({
    activeWorkspaceId,
    agentBrowserPage,
    browserTabSet,
    panelScopeId,
    requestedAgentPageActivationRef,
  });
}

interface PreviewPresentation {
  readonly agentBrowserPage: AgentBrowserPage | null;
  readonly browserTabSet: BrowserTabSet | null;
  readonly renderedActiveTab: string | null;
  readonly renderedActiveTabId: string | null;
  readonly renderedOpenTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
}

function usePreviewPresentation({
  activeAgentRequestPageId,
  activeTab,
  activeTabId,
  activeThreadId,
  activeWorkspaceId,
  openTabs,
  ownedAgentPageId,
  panelScopeId,
  panelVisible,
  pendingAgentPageId,
  tabInstances,
}: {
  readonly activeAgentRequestPageId: string | null;
  readonly activeTab: string | null;
  readonly activeTabId: string | null;
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly ownedAgentPageId: string | null;
  readonly panelScopeId: string | null;
  readonly panelVisible: boolean;
  readonly pendingAgentPageId: string | null;
  readonly tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
}): PreviewPresentation {
  const browserTabSet = usePreviewTabSet(panelScopeId, activeWorkspaceId);
  const requestedAgentPageActivationRef = useRef<string | null>(null);
  const agentBrowserPage = useMemo(
    () => getAgentBrowserPage(
      activeWorkspaceId,
      panelScopeId,
      browserTabSet,
      pendingAgentPageId,
      activeAgentRequestPageId,
      ownedAgentPageId,
    ),
    [
      activeAgentRequestPageId,
      activeWorkspaceId,
      browserTabSet,
      ownedAgentPageId,
      panelScopeId,
      pendingAgentPageId,
    ],
  );
  const revealExistingPreview = isExistingPreviewVisible(
    activeTab,
    agentBrowserPage,
    browserTabSet,
    openTabs,
    panelVisible,
    tabInstances,
  );

  useLayoutEffect(() => {
    synchronizeExistingPreview({
      activeThreadId,
      activeWorkspaceId,
      agentBrowserPage,
      browserTabSet,
      panelScopeId,
      revealExistingPreview,
      requestedAgentPageActivationRef,
    });
  }, [
    activeThreadId,
    agentBrowserPage,
    activeWorkspaceId,
    browserTabSet,
    panelScopeId,
    revealExistingPreview,
  ]);

  const renderedTabInstances = addProjectedPreviewTab(tabInstances, openTabs, revealExistingPreview);
  return {
    agentBrowserPage,
    browserTabSet,
    renderedActiveTab: revealExistingPreview ? "preview" : activeTab,
    renderedActiveTabId: revealExistingPreview ? "singleton:preview" : activeTabId,
    renderedOpenTabs: rightPanelOpenTools(renderedTabInstances),
    renderedTabInstances,
  };
}

function getAgentBrowserPage(
  activeWorkspaceId: string | null,
  panelScopeId: string | null,
  browserTabSet: BrowserTabSet | null,
  pendingAgentPageId: string | null,
  activeAgentRequestPageId: string | null,
  ownedAgentPageId: string | null,
): AgentBrowserPage | null {
  if (!activeWorkspaceId || !panelScopeId || !browserTabSet) return null;
  if (hasBrowserPage(browserTabSet, pendingAgentPageId)) {
    return { tabId: pendingAgentPageId!, presenting: true };
  }
  if (hasBrowserPage(browserTabSet, activeAgentRequestPageId)) {
    return { tabId: activeAgentRequestPageId!, presenting: true };
  }
  return hasBrowserPage(browserTabSet, ownedAgentPageId)
    ? { tabId: ownedAgentPageId!, presenting: false }
    : null;
}

function hasBrowserPage(browserTabSet: BrowserTabSet, tabId: string | null): boolean {
  return tabId !== null && browserTabSet.tabs.some((tab) => tab.id === tabId);
}

function isExistingPreviewVisible(
  activeTab: string | null,
  agentBrowserPage: AgentBrowserPage | null,
  browserTabSet: BrowserTabSet | null,
  openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"],
  panelVisible: boolean,
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
): boolean {
  const shouldRevealAgentPage = shouldRevealActiveAgentPage(agentBrowserPage, openTabs, panelVisible);
  const shouldRestorePreviewTab = isPreviewOnlyTab(tabInstances) && activeTab !== "preview";
  return panelVisible &&
    (shouldRevealAgentPage || shouldRestorePreviewTab) &&
    (browserTabSet?.tabs.length ?? 0) > 0;
}

function shouldRevealActiveAgentPage(
  agentBrowserPage: AgentBrowserPage | null,
  openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"],
  panelVisible: boolean,
): boolean {
  return agentBrowserPage !== null &&
    (openTabs.length === 0 || (panelVisible && agentBrowserPage.presenting));
}

function isPreviewOnlyTab(
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
): boolean {
  return tabInstances.length === 1 && tabInstances[0]?.type === "preview";
}

function addProjectedPreviewTab(
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
  openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"],
  revealExistingPreview: boolean,
): ReturnType<typeof projectRightPanelForScope>["tabInstances"] {
  if (!revealExistingPreview || openTabs.includes("preview")) return tabInstances;
  return [...tabInstances, { id: "singleton:preview", type: "preview" }];
}

interface WarmPreviewSurfaceProps {
  readonly scope: WarmPreviewScope;
  readonly visible: boolean;
  readonly coveredRight: number;
}

const WarmPreviewSurface = memo(function WarmPreviewSurface({
  scope,
  visible,
  coveredRight,
}: WarmPreviewSurfaceProps) {
  const automationHosted = useBrowserAutomationStore((state) =>
    state.hostedScopeIds.has(warmPreviewScopeKey(scope)),
  );
  const anchorCleanupRef = useRef<(() => void) | null>(null);
  const setAutomationAnchor = useCallback((element: HTMLDivElement | null): void => {
    anchorCleanupRef.current?.();
    anchorCleanupRef.current = element
      ? browserSurfacePresentationCoordinator.registerAutomationAnchor(
          scope.workspaceId,
          scope.scopeId,
          element,
          visible,
        )
      : null;
  }, [scope.scopeId, scope.workspaceId, visible]);
  useEffect(() => () => {
    anchorCleanupRef.current?.();
    anchorCleanupRef.current = null;
  }, []);
  useEffect(() => {
    browserSurfacePresentationCoordinator.setAutomationAnchorVisibility(
      scope.workspaceId,
      scope.scopeId,
      visible,
    );
  }, [scope.scopeId, scope.workspaceId, visible]);
  return (
    <div
      data-preview-scope={scope.scopeId}
      className={visible ? "flex min-h-0 flex-1" : "hidden"}
      inert={!visible ? true : undefined}
    >
      {automationHosted ? (
        <div
          ref={setAutomationAnchor}
          data-testid="automation-preview-dock"
          className="min-h-0 min-w-0 flex-1"
        />
      ) : (
        <PreviewPanel
          threadId={scope.scopeId}
          workspaceId={scope.workspaceId}
          presentationActive={visible}
          coveredRight={coveredRight}
        />
      )}
    </div>
  );
});

/**
 * Tracks whether the Changes tab has unreviewed new files for the active
 * thread. In-session only (the diff store is not persisted): the first time a
 * thread is seen, the current file count becomes the baseline so pre-existing
 * changes do not pulse. While the Changes tab is active the baseline tracks the
 * live count (you are looking at it, nothing is "new"); otherwise a count above
 * the baseline marks the tab fresh until it is next viewed.
 */
function useChangesFreshness(
  threadId: string | null,
  fileCount: number,
  isChangesActive: boolean,
): boolean {
  const seenByThread = useRef<Map<string, number>>(new Map());
  const baseline = threadId ? seenByThread.current.get(threadId) : undefined;
  const fresh =
    threadId !== null &&
    baseline !== undefined &&
    !isChangesActive &&
    fileCount > baseline;

  useEffect(() => {
    if (!threadId) return;
    const seen = seenByThread.current;
    if (seen.get(threadId) === undefined || isChangesActive) {
      seen.set(threadId, fileCount);
    }
  }, [threadId, fileCount, isChangesActive]);

  return fresh;
}

function RightPanelFrame({
  children,
  getMaxPanelWidth,
  handlePanelWidthChange,
  maximized,
  panelVisible,
  panelWidth,
}: {
  readonly children: React.ReactNode;
  readonly getMaxPanelWidth: (panel: HTMLDivElement | null) => number;
  readonly handlePanelWidthChange: (width: number, source: "preserve" | "user") => void;
  readonly maximized: boolean;
  readonly panelVisible: boolean;
  readonly panelWidth: number;
}) {
  return (
    <ResizableRightPanel
      testId="right-panel"
      width={panelWidth}
      minWidth={PANEL_MIN_WIDTH}
      maxWidth={`calc(100% - ${COMPOSER_MIN_WIDTH}px - ${PANEL_SPLIT_GAP_PX}px)`}
      getMaxWidth={getMaxPanelWidth}
      defaultWidth={getDefaultPanelWidthPx()}
      wideWidth={PANEL_WIDE_WIDTH}
      separatorLabel="Resize panel"
      resizeEnabled={panelVisible && !maximized}
      onWidthChange={handlePanelWidthChange}
      style={getRightPanelVisibilityStyle(panelVisible)}
      className={getRightPanelClassName(panelVisible, maximized)}
      data-right-panel-root=""
      data-visible={panelVisible}
      inert={!panelVisible ? true : undefined}
    >
      {/* A hidden panel stays mounted, but its body-portaled popups must close with it. */}
      <OverlayGateContext.Provider value={panelVisible}>{children}</OverlayGateContext.Provider>
    </ResizableRightPanel>
  );
}

function getRightPanelVisibilityStyle(panelVisible: boolean): React.CSSProperties | undefined {
  if (panelVisible) return undefined;
  return { width: 0, minWidth: 0, maxWidth: 0 };
}

function getRightPanelClassName(panelVisible: boolean, maximized: boolean): string {
  return cn(
    "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background focus:outline-none",
    "transition-[width,min-width,max-width,opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
    !panelVisible && "pointer-events-none translate-x-2 opacity-0",
    // No translate when visible: even translate-x-0 creates a stacking context
    // that traps Design overlays below the hosted Browser page.
    panelVisible && "opacity-100",
    panelVisible && maximized && "flex-1",
  );
}

function RightPanelContent({
  activeThreadId,
  activeWorkspaceId,
  activityRailExpanded,
  browserTabSet,
  changesActive,
  headerElements,
  panelScope,
  panelScopeId,
  previewActive,
  renderedActiveTab,
  renderedActiveTabId,
  renderedOpenTabs,
  renderedTabInstances,
  terminalActive,
  warmPreviewScopes,
  onCreateTab,
}: {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string;
  readonly activityRailExpanded: boolean;
  readonly browserTabSet: BrowserTabSet | null;
  readonly changesActive: boolean;
  readonly headerElements: PanelHeaderElements;
  readonly panelScope: PanelScope;
  readonly panelScopeId: string | null;
  readonly previewActive: boolean;
  readonly renderedActiveTab: string | null;
  readonly renderedActiveTabId: string | null;
  readonly renderedOpenTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly terminalActive: boolean;
  readonly warmPreviewScopes: readonly WarmPreviewScope[];
  readonly onCreateTab: (id: Parameters<ReturnType<typeof useDiffStore.getState>["setRightPanelTab"]>[2]) => void;
}) {
  // Tools that mount only while active can always own the header; Review and
  // warm Browser surfaces stay mounted, so they narrow it to their own activity.
  return (
    <PanelHeaderSlotScope active elements={headerElements}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <PanelEmptyContent
          panelScope={panelScope}
          renderedOpenTabs={renderedOpenTabs}
          onCreateTab={onCreateTab}
        />
        <PlanPanelContent activeTab={renderedActiveTab} openTabs={renderedOpenTabs} threadId={activeThreadId} />
        <SubagentsPanelContent activeTabId={renderedActiveTabId} tabInstances={renderedTabInstances} threadId={activeThreadId} />
        <EnvironmentPanelContent
          activeTab={renderedActiveTab}
          openTabs={renderedOpenTabs}
          threadId={activeThreadId}
          workspaceId={activeWorkspaceId}
        />
        {renderedActiveTab === "files" && renderedOpenTabs.includes("files") && panelScopeId ? (
          <FilesTool key={panelScopeId} workspaceId={activeWorkspaceId} threadId={activeThreadId} scopeId={panelScopeId} />
        ) : null}
        <PanelHeaderSlotScope active={changesActive} elements={headerElements}>
          <ChangesPanelContent active={changesActive} />
        </PanelHeaderSlotScope>
        <WarmPreviewSurfaces
          activeWorkspaceId={activeWorkspaceId}
          activityRailExpanded={activityRailExpanded}
          headerElements={headerElements}
          panelScopeId={panelScopeId}
          previewActive={previewActive}
          scopes={warmPreviewScopes}
        />
        {previewActive && panelScopeId ? (
          <BrowserTabStrip
            workspaceId={activeWorkspaceId}
            threadId={activeThreadId}
            scopeId={panelScopeId}
            tabSet={browserTabSet}
          />
        ) : null}
        <TerminalTool
          active={terminalActive}
          workspaceId={activeWorkspaceId}
          threadId={activeThreadId}
          scopeId={panelScopeId}
        />
      </div>
    </PanelHeaderSlotScope>
  );
}

function PanelEmptyContent({
  panelScope,
  renderedOpenTabs,
  onCreateTab,
}: {
  readonly panelScope: PanelScope;
  readonly renderedOpenTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly onCreateTab: (id: Parameters<ReturnType<typeof useDiffStore.getState>["setRightPanelTab"]>[2]) => void;
}) {
  if (renderedOpenTabs.length > 0) return null;
  return <PanelEmptyState scope={panelScope} openTabs={renderedOpenTabs} onOpen={onCreateTab} />;
}

function PlanPanelContent({
  activeTab,
  openTabs,
  threadId,
}: {
  readonly activeTab: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly threadId: string | null;
}) {
  if (activeTab !== "tasks" || !openTabs.includes("tasks") || !threadId) return null;
  return <PlanPanel threadId={threadId} />;
}

/** The Subagents list and each subagent's own tab share the "subagents" tool, so they are told apart by instance id. */
function SubagentsPanelContent({
  activeTabId,
  tabInstances,
  threadId,
}: {
  readonly activeTabId: string | null;
  readonly tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly threadId: string | null;
}) {
  const active = tabInstances.find((instance) => instance.id === activeTabId);
  if (!active || !threadId) return null;
  if (isSubagentTabInstance(active)) {
    return <SubagentDetailTab key={`${threadId}:${active.entryId}`} threadId={threadId} entryId={active.entryId} />;
  }
  return active.type === "subagents" ? <SubagentsPanel key={threadId} threadId={threadId} /> : null;
}

function EnvironmentPanelContent({
  activeTab,
  openTabs,
  threadId,
  workspaceId,
}: {
  readonly activeTab: string | null;
  readonly openTabs: ReturnType<typeof projectRightPanelForScope>["openTabs"];
  readonly threadId: string | null;
  readonly workspaceId: string;
}) {
  if (activeTab !== "environment" || !openTabs.includes("environment")) return null;
  return (
    <ProjectEnvironmentPanel
      key={`${workspaceId}:${threadId ?? "base"}`}
      workspaceId={workspaceId}
      threadId={threadId ?? undefined}
      active
    />
  );
}

function ChangesPanelContent({ active }: { readonly active: boolean }) {
  return (
    <div className={active ? "flex flex-1 flex-col min-h-0" : "hidden"}>
      <DiffPanel />
    </div>
  );
}

function WarmPreviewSurfaces({
  activeWorkspaceId,
  activityRailExpanded,
  headerElements,
  panelScopeId,
  previewActive,
  scopes,
}: {
  readonly activeWorkspaceId: string;
  readonly activityRailExpanded: boolean;
  readonly headerElements: PanelHeaderElements;
  readonly panelScopeId: string | null;
  readonly previewActive: boolean;
  readonly scopes: readonly WarmPreviewScope[];
}) {
  return scopes.map((scope) => {
    const visible = previewActive && scope.scopeId === panelScopeId && scope.workspaceId === activeWorkspaceId;
    return (
      <PanelHeaderSlotScope key={warmPreviewScopeKey(scope)} active={visible} elements={headerElements}>
        <WarmPreviewSurface
          scope={scope}
          visible={visible}
          coveredRight={visible && activityRailExpanded ? ACTIVITY_RAIL_FLOATING_OVERLAP_PX : 0}
        />
      </PanelHeaderSlotScope>
    );
  });
}

function browserChromeMarker(browserSelected: boolean): { readonly "data-browser-chrome"?: "" } {
  return browserSelected ? { "data-browser-chrome": "" } : {};
}

/**
 * Windows and Linux caption buttons cover the rail's top strip, so the toggle
 * stays in row 1 there. Elsewhere the strip is free, and the toggle lands where
 * the canvas toggle sits while the panel is closed.
 */
function placePanelToggle(toggle: React.ReactNode): { row1: React.ReactNode; rail: React.ReactNode } {
  const captionButtonsCoverRail = windowChromeKind(window.desktopBridge?.window?.platform) === "caption-overlay";
  return captionButtonsCoverRail ? { row1: toggle, rail: null } : { row1: null, rail: toggle };
}

function RightPanelActivityRail({
  captionAction,
  activeThreadId,
  activeWorkspaceId,
  changesCount,
  changesFresh,
  closeRightPanelTabInstance,
  onCreateTab,
  panelScope,
  renderedActiveTabId,
  renderedTabInstances,
  reorderRightPanelTab,
  setActivityRailExpanded,
  setRightPanelTabInstance,
}: {
  readonly captionAction: React.ReactNode;
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string;
  readonly changesCount: number;
  readonly changesFresh: boolean;
  readonly closeRightPanelTabInstance: ReturnType<typeof useDiffStore.getState>["closeRightPanelTabInstance"];
  readonly onCreateTab: (id: Parameters<ReturnType<typeof useDiffStore.getState>["setRightPanelTab"]>[2]) => void;
  readonly panelScope: PanelScope;
  readonly renderedActiveTabId: string | null;
  readonly renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"];
  readonly reorderRightPanelTab: ReturnType<typeof useDiffStore.getState>["reorderRightPanelTab"];
  readonly setActivityRailExpanded: (expanded: boolean) => void;
  readonly setRightPanelTabInstance: ReturnType<typeof useDiffStore.getState>["setRightPanelTabInstance"];
}) {
  // Only a rail holding subagent tabs needs their names, so other threads never fetch a roster.
  const rosterThreadId = renderedTabInstances.some(isSubagentTabInstance) ? activeThreadId ?? undefined : undefined;
  const subagentEntries = useSubagentRoster(rosterThreadId)?.entries;
  const browserActing = useBrowserThreadActing(activeWorkspaceId, activeThreadId ?? activeWorkspaceId);
  return (
    <ActivityRail
      tabInstances={renderedTabInstances}
      activeTabId={renderedActiveTabId}
      subagentEntries={subagentEntries}
      scope={panelScope}
      changesCount={changesCount}
      changesFresh={changesFresh}
      browserActing={browserActing}
      captionAction={captionAction}
      onSelect={(instanceId) => setRightPanelTabInstance(activeWorkspaceId, activeThreadId, instanceId)}
      // Closing the Terminal entry hides the tool; its records keep running.
      onClose={(instanceId) => closeRightPanelTabInstance(activeWorkspaceId, activeThreadId, instanceId)}
      onReorder={(instanceId, direction) =>
        reorderRightPanelTab(activeWorkspaceId, activeThreadId, instanceId, direction)}
      onCreate={onCreateTab}
      onExpandedChange={(expanded) => {
        setActivityRailExpanded(expanded);
        browserSurfacePresentationCoordinator.setActivityRailOverlap(
          expanded ? ACTIVITY_RAIL_FLOATING_OVERLAP_PX : 0,
        );
      }}
    />
  );
}

type RightPanelTabType = ReturnType<typeof projectRightPanelForScope>["tabInstances"][number]["type"];

function renderedToolState(
  renderedActiveTab: string | null,
  renderedTabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
) {
  return {
    changesActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "changes"),
    previewActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "preview"),
    terminalActive: isActiveRightPanelTab(renderedActiveTab, renderedTabInstances, "terminal"),
  };
}

function isActiveRightPanelTab(
  activeTab: string | null,
  tabInstances: ReturnType<typeof projectRightPanelForScope>["tabInstances"],
  tabType: RightPanelTabType,
): boolean {
  return activeTab === tabType && tabInstances.some((instance) => instance.type === tabType);
}

/**
 * Keeps the Terminal tool in step with the scope's terminal records. A record
 * this panel has not seen yet (a new shell, an action run, or the scope's
 * records on first visit) opens the tool without stealing focus. Losing the
 * last record closes the tool, since an empty Terminal tool has nothing to show.
 * Closing the tool by hand leaves the records alone, so it stays closed until
 * another record appears.
 */
function useTerminalToolSync(
  workspaceId: string | null,
  threadId: string | null,
  scopeId: string | null,
  terminals: readonly TerminalInstance[],
  hydrated: boolean,
): void {
  const seenByScope = useRef(new Map<string, ReadonlySet<string>>());
  useEffect(() => {
    if (!workspaceId || !scopeId || !hydrated) return;
    const seen = seenByScope.current.get(scopeId);
    const ids = new Set(terminals.map((terminal) => terminal.id));
    seenByScope.current.set(scopeId, ids);
    const diff = useDiffStore.getState();
    if (ids.size === 0) {
      if ((seen?.size ?? 0) > 0) diff.closeRightPanelTab(workspaceId, threadId, "terminal");
      return;
    }
    if ([...ids].some((id) => !seen?.has(id))) diff.ensureRightPanelTab(workspaceId, threadId, "terminal");
  }, [hydrated, scopeId, terminals, threadId, workspaceId]);
}

/** Right-side panel: a vertical activity rail with one entry per open tool. */
export function RightPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // Maximized mode fills the content area beside the project tree and hides the
  // chat/composer (App.tsx suppresses the chat pane). A transient view toggle,
  // not a stored width — the panel keeps its width so restoring drops back inline.
  const maximized = useUiStore((s) => s.rightPanelMaximized);
  const toggleMaximized = useUiStore((s) => s.toggleRightPanelMaximized);

  // Select raw records by reference, then project the scope in useMemo. The
  // projection removes the workspace Terminal tool only for untouched threads
  // (ADR-0026) while preserving thread-owned records.
  const ownedPanel = useDiffStore((s) =>
    activeWorkspaceId && activeThreadId
      ? s.rightPanelByThread[activeThreadId]
      : undefined,
  );
  const fallbackPanel = useDiffStore((s) =>
    activeWorkspaceId ? s.rightPanelFallbackByWorkspace[activeWorkspaceId] : undefined,
  );
  const panelState = useMemo(
    () => projectRightPanelForScope(ownedPanel, fallbackPanel, activeThreadId),
    [activeThreadId, fallbackPanel, ownedPanel],
  );
  const {
    width: panelWidth,
    activeTab,
    openTabs,
    tabInstances,
    activeTabId,
  } = panelState;
  // Plan is creatable only in a thread; threadless the panel runs
  // against the workspace root and offers just Browser/Terminal/Files.
  const panelScope: PanelScope = activeThreadId ? "thread" : "threadless";
  // The whole panel record (visibility included) is per-thread, falling back to
  // the workspace record for the threadless shell and uncustomized threads. See
  // ADR-0012.
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId
      ? s.getRightPanelVisible(activeWorkspaceId, activeThreadId)
      : false,
  );

  // The Terminal and Preview tabs bind to the active thread, or to the
  // workspace itself in the threadless new-thread view (where they run against
  // the local workspace root). Their stores treat this as an opaque scope key.
  const panelScopeId = activeThreadId ?? activeWorkspaceId;
  const [warmPreviewScopes, dispatchWarmPreviewScopes] = useReducer(
    warmPreviewScopesReducer,
    [],
  );
  const [activityRailExpanded, setActivityRailExpanded] = useState(false);
  const [headerLeading, setHeaderLeading] = useState<HTMLDivElement | null>(null);
  const [headerRow2, setHeaderRow2] = useState<HTMLDivElement | null>(null);
  const [headerRow3, setHeaderRow3] = useState<HTMLDivElement | null>(null);
  const headerElements = useMemo<PanelHeaderElements>(
    () => ({ leading: headerLeading, row2: headerRow2, row3: headerRow3 }),
    [headerLeading, headerRow2, headerRow3],
  );

  useEffect(() => () => {
    browserSurfacePresentationCoordinator.setActivityRailOverlap(0);
  }, []);
  const retainedPreviewScopeKeys = useMemo(
    () => new Set([
      ...(panelScopeId && activeWorkspaceId ? [browserAutomationScopeKey(activeWorkspaceId, panelScopeId)] : []),
      ...warmPreviewScopes.map(warmPreviewScopeKey),
    ]),
    [activeWorkspaceId, panelScopeId, warmPreviewScopes],
  );
  const [pendingAgentPageId, activeAgentRequestPageId, ownedAgentPageId] =
    useBrowserAutomationStore(
      useShallow((state) => selectAgentPageIds(state, activeWorkspaceId, panelScopeId)),
    );
  const busyPreviewScopeIdList = useBrowserAutomationStore(
    useShallow((state) => [
      ...new Set(
        [...state.activeRequests.values()]
          .map(({ dispatch }) => browserAutomationScopeKey(dispatch.request.workspaceId, dispatch.target.threadId))
          .filter((scopeKey) => retainedPreviewScopeKeys.has(scopeKey)),
      ),
    ].sort()),
  );
  const busyPreviewScopeIds = useMemo(
    () => new Set(busyPreviewScopeIdList),
    [busyPreviewScopeIdList],
  );
  const terminalsByScope = useTerminalStore((s) => s.terminals);
  const terminalsHydrated = useTerminalStore((s) => s.hasHydrated);
  const scopeTerminals = panelScopeId
    ? (terminalsByScope[panelScopeId] ?? EMPTY_SCOPE_TERMINALS)
    : EMPTY_SCOPE_TERMINALS;
  useTerminalToolSync(activeWorkspaceId, activeThreadId, panelScopeId, scopeTerminals, terminalsHydrated);

  const {
    browserTabSet,
    renderedActiveTab,
    renderedActiveTabId,
    renderedOpenTabs,
    renderedTabInstances,
  } = usePreviewPresentation({
    activeAgentRequestPageId,
    activeTab,
    activeTabId,
    activeThreadId,
    activeWorkspaceId,
    openTabs,
    ownedAgentPageId,
    panelScopeId,
    panelVisible,
    pendingAgentPageId,
    tabInstances,
  });

  // Zustand action refs are stable (same identity for the store's lifetime),
  // so destructuring from getState() at render time is safe and avoids
  // adding actions to useCallback/useEffect dependency arrays.
  const {
    setRightPanelWidth,
    setRightPanelTab,
    setRightPanelTabInstance,
    closeRightPanelTabInstance,
    reorderRightPanelTab,
  } =
    useDiffStore.getState();

  const handlePanelWidthChange = useCallback(
    (nextWidth: number, source: "preserve" | "user") => {
      if (!activeWorkspaceId) return;
      setRightPanelWidth(activeWorkspaceId, activeThreadId, nextWidth, source);
    },
    [activeThreadId, activeWorkspaceId, setRightPanelWidth],
  );

  const handleTogglePanel = useCallback(() => {
    if (!activeWorkspaceId) return;
    const activeElement = document.activeElement;
    if (
      panelVisible &&
      activeElement instanceof HTMLElement &&
      activeElement.closest("[data-right-panel-root]")
    ) {
      activeElement.blur();
    }
    toggleRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  }, [activeThreadId, activeWorkspaceId, panelVisible]);

  useLayoutEffect(() => {
    if (panelVisible) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement.closest("[data-right-panel-root]")
    ) {
      activeElement.blur();
    }
  }, [panelVisible]);

  // Review's rail badge counts distinct files across every turn snapshot (the
  // cumulative working-tree diff the user reviews and ships).
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  const changesCount = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return 0;
    const files = new Set<string>();
    for (const snap of snapshots) {
      for (const file of snap.files_changed) files.add(file);
    }
    return files.size;
  }, [snapshots]);

  const { changesActive, previewActive, terminalActive } = renderedToolState(
    renderedActiveTab,
    renderedTabInstances,
  );
  const activePreviewScopeKey = previewActive && panelScopeId && activeWorkspaceId
    ? `${activeWorkspaceId}\u0000${panelScopeId}`
    : null;
  const previousActivePreviewScopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePreviewScopeKey || !panelScopeId || !activeWorkspaceId) {
      previousActivePreviewScopeKeyRef.current = null;
      return;
    }
    const becameActive = previousActivePreviewScopeKeyRef.current !== activePreviewScopeKey;
    previousActivePreviewScopeKeyRef.current = activePreviewScopeKey;
    dispatchWarmPreviewScopes({
      type: "activate",
      scope: { scopeId: panelScopeId, workspaceId: activeWorkspaceId },
      busyScopeIds: busyPreviewScopeIds,
      becameActive,
    });
  }, [activePreviewScopeKey, activeWorkspaceId, busyPreviewScopeIds, panelScopeId]);

  const browserScopePresent = browserTabSet !== null;
  useEffect(() => {
    dispatchWarmPreviewScopes({
      type: "reconcile",
      activeWorkspaceId,
      browserScopePresent,
      busyScopeIds: busyPreviewScopeIds,
      panelScopeId,
      previewActive,
    });
  }, [activeWorkspaceId, browserScopePresent, busyPreviewScopeIds, panelScopeId, previewActive]);

  const isChangesActive = panelVisible && changesActive;
  const changesFresh = useChangesFreshness(
    activeThreadId,
    changesCount,
    isChangesActive,
  );

  // Exit maximize when the panel is hidden so the user never lands on a blank
  // full-screen shell with no panel chrome to restore from.
  const setMaximized = useUiStore.getState().setRightPanelMaximized;
  useEffect(() => {
    if (maximized && !panelVisible) setMaximized(false);
  }, [maximized, panelVisible, setMaximized]);

  /** Max panel width that still leaves {@link COMPOSER_MIN_WIDTH}px for the chat. */
  const getMaxPanelWidth = useCallback(
    (panel: HTMLDivElement | null): number => {
      const split = panel?.parentElement;
      if (!split) {
        return Math.max(
          PANEL_MIN_WIDTH,
          window.innerWidth - COMPOSER_MIN_WIDTH,
        );
      }
      return maxPanelWidthInSplit(split.clientWidth);
    },
    [],
  );

  const handleCreateTab = useCallback(
    (id: Parameters<typeof setRightPanelTab>[2]) => {
      // An empty Terminal tool has nothing to show, so opening it starts a shell.
      if (id === "terminal" && panelScopeId && scopeTerminals.length === 0) {
        createTerminalForScope(panelScopeId);
        return;
      }
      if (activeWorkspaceId) setRightPanelTab(activeWorkspaceId, activeThreadId, id);
    },
    [activeThreadId, activeWorkspaceId, panelScopeId, scopeTerminals.length, setRightPanelTab],
  );

  // Keep the panel (and terminal pool) mounted when hidden so xterm instances
  // and scroll anchors survive thread switches; a hidden panel collapses to zero
  // width rather than unmounting. The panel still renders with no thread (the
  // threadless shell against the workspace fallback) and only bails when there is
  // no workspace to anchor it to.
  if (!activeWorkspaceId) return null;

  const panelToggle = placePanelToggle(<PanelToggleButton onClick={handleTogglePanel} />);

  return (
    <RightPanelFrame
      getMaxPanelWidth={getMaxPanelWidth}
      handlePanelWidthChange={handlePanelWidthChange}
      maximized={maximized}
      panelVisible={panelVisible}
      panelWidth={panelWidth}
    >
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="contents" {...browserChromeMarker(previewActive)}>
            <PanelHeader
              maximized={maximized}
              leadingRef={setHeaderLeading}
              row2Ref={setHeaderRow2}
              row3Ref={setHeaderRow3}
              onToggleMaximized={toggleMaximized}
              panelToggle={panelToggle.row1}
            />
          </div>
          <RightPanelContent
            activeThreadId={activeThreadId}
            activeWorkspaceId={activeWorkspaceId}
            activityRailExpanded={activityRailExpanded}
            browserTabSet={browserTabSet}
            changesActive={changesActive}
            headerElements={headerElements}
            panelScope={panelScope}
            panelScopeId={panelScopeId}
            previewActive={previewActive}
            renderedActiveTab={renderedActiveTab}
            renderedActiveTabId={renderedActiveTabId}
            renderedOpenTabs={renderedOpenTabs}
            renderedTabInstances={renderedTabInstances}
            terminalActive={terminalActive}
            warmPreviewScopes={warmPreviewScopes}
            onCreateTab={handleCreateTab}
          />
        </div>
        <RightPanelActivityRail
          captionAction={panelToggle.rail}
          activeThreadId={activeThreadId}
          activeWorkspaceId={activeWorkspaceId}
          changesCount={changesCount}
          changesFresh={changesFresh}
          closeRightPanelTabInstance={closeRightPanelTabInstance}
          onCreateTab={handleCreateTab}
          panelScope={panelScope}
          renderedActiveTabId={renderedActiveTabId}
          renderedTabInstances={renderedTabInstances}
          reorderRightPanelTab={reorderRightPanelTab}
          setActivityRailExpanded={setActivityRailExpanded}
          setRightPanelTabInstance={setRightPanelTabInstance}
        />
      </div>
    </RightPanelFrame>
  );
}
