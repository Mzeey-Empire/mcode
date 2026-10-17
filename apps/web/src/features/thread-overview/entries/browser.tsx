import type {
  BrowserAutomationLiveTarget,
  BrowserAutomationPendingAgentOpen,
  BrowserSessionLifecycleTab,
} from "@/features/preview";
import {
  browserAutomationTargetKey,
  findPendingBrowserAutomationOpen,
  isEmptyPreviewTabUrl,
  useBrowserAutomationStore,
  usePreviewTabSet,
} from "@/features/preview";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { type Thread } from "@/transport";
import type { BrowserAutomationControllerState, BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { useMemo } from "react";
import { ThreadOverviewBrowserRow } from "@/features/thread-overview/entries/ThreadOverviewBrowserRow";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

const EMPTY_BROWSER_PENDING_OPENS: ReadonlyMap<string, BrowserAutomationPendingAgentOpen> = new Map();

/** One Browser tab row joined from a live target and tab chrome. */
export interface ThreadOverviewBrowserTab {
  readonly tab: BrowserTabInfo;
  readonly lifecycle?: BrowserSessionLifecycleTab;
  readonly controller: BrowserAutomationControllerState["controller"] | undefined;
}

function browserPendingTab(tab: BrowserTabInfo, pendingUrl: string | null): BrowserTabInfo {
  if (!pendingUrl || !isEmptyPreviewTabUrl(tab.url)) return tab;
  let title: string | null = null;
  try {
    title = new URL(pendingUrl).hostname || null;
  } catch {
    // The Browser host remains responsible for rejecting invalid navigation URLs.
  }
  return { ...tab, title, url: pendingUrl };
}

/** Indexes lifecycle records that match the active Browser scope. */
function getBrowserLifecycleByTarget(
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>,
  workspaceId: string,
  threadId: string,
): ReadonlyMap<string, BrowserSessionLifecycleTab> {
  const lifecycleByTarget = new Map<string, BrowserSessionLifecycleTab>();
  for (const lifecycle of lifecycleTabs.values()) {
    if (!isThreadLifecycleTab(lifecycle, workspaceId, threadId)) continue;
    lifecycleByTarget.set(browserAutomationTargetKey(workspaceId, threadId, lifecycle.tabId), lifecycle);
  }
  return lifecycleByTarget;
}

/** Returns whether a lifecycle record belongs to the active Browser scope. */
function isThreadLifecycleTab(
  lifecycle: BrowserSessionLifecycleTab,
  workspaceId: string,
  threadId: string,
): boolean {
  return lifecycle.workspaceId === workspaceId
    && lifecycle.threadId === threadId
    && lifecycle.target.threadId === threadId
    && lifecycle.target.tabId === lifecycle.tabId;
}

/** Returns whether a Browser target is live for one tab in the active scope. */
function isLiveThreadBrowserTarget(
  target: BrowserAutomationLiveTarget | undefined,
  workspaceId: string,
  threadId: string,
  tabId: string,
): boolean {
  return target?.workspaceId === workspaceId
    && target.threadId === threadId
    && target.tabId === tabId;
}

/** Resolves the Browser controller after lifecycle release semantics apply. */
function getBrowserTabController(
  lifecycle: BrowserSessionLifecycleTab | undefined,
  controller: BrowserAutomationControllerState | undefined,
  pendingOpen: BrowserAutomationPendingAgentOpen | null | undefined,
): BrowserAutomationControllerState["controller"] | undefined {
  if (lifecycle?.ownership === "released") return undefined;
  if (controller) return controller.controller;
  if (lifecycle?.target.controller) return lifecycle.target.controller.controller;
  return pendingOpen ? "agent" : undefined;
}

function getVisibleBrowserTabController(
  lifecycle: BrowserSessionLifecycleTab | undefined,
  controller: BrowserAutomationControllerState | undefined,
  pendingOpen: BrowserAutomationPendingAgentOpen | null | undefined,
  acting: boolean,
): BrowserAutomationControllerState["controller"] | undefined {
  const resolved = getBrowserTabController(lifecycle, controller, pendingOpen);
  return resolved === "agent" && !pendingOpen && !acting ? "none" : resolved;
}

/** Joins a scoped Browser tab with its lifecycle and controller state. */
function getThreadOverviewBrowserTab({
  tab,
  workspaceId,
  threadId,
  lifecycleByTarget,
  liveTargets,
  controllers,
  pendingAgentOpens,
  actingTargets,
}: {
  tab: BrowserTabInfo;
  workspaceId: string;
  threadId: string;
  lifecycleByTarget: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
  actingTargets: ReadonlySet<string>;
}): ThreadOverviewBrowserTab | null {
  if (tab.threadId !== threadId) return null;
  const targetKey = browserAutomationTargetKey(workspaceId, threadId, tab.id);
  const pendingOpen = findPendingBrowserAutomationOpen(pendingAgentOpens, workspaceId, threadId, tab.id);
  const pendingUrl = pendingOpen?.url?.trim() || null;
  if (isEmptyPreviewTabUrl(tab.url) && !pendingUrl) return null;
  if (!pendingOpen && !isLiveThreadBrowserTarget(liveTargets.get(targetKey), workspaceId, threadId, tab.id)) {
    return null;
  }
  const lifecycle = lifecycleByTarget.get(targetKey);
  const controller = getVisibleBrowserTabController(
    lifecycle,
    controllers.get(targetKey),
    pendingOpen,
    actingTargets.has(targetKey),
  );
  return {
    tab: browserPendingTab(tab, pendingUrl),
    ...(lifecycle ? { lifecycle } : {}),
    controller,
  };
}

/**
 * Selects navigated Browser rows for one exact workspace/thread scope. Live
 * targets provide row membership; lifecycle state only supplies fallback
 * controller metadata.
 */
export function getThreadOverviewBrowserTabs({
  workspaceId,
  threadId,
  tabSet,
  lifecycleTabs,
  liveTargets,
  controllers,
  pendingAgentOpens = EMPTY_BROWSER_PENDING_OPENS,
  actingTargets,
}: {
  workspaceId: string;
  threadId: string;
  tabSet: BrowserTabSet | null;
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  pendingAgentOpens?: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
  actingTargets: ReadonlySet<string>;
}): ThreadOverviewBrowserTab[] {
  if (!tabSet || tabSet.threadId !== threadId) return [];

  const lifecycleByTarget = getBrowserLifecycleByTarget(lifecycleTabs, workspaceId, threadId);
  const rows: ThreadOverviewBrowserTab[] = [];
  for (const tab of tabSet.tabs) {
    const row = getThreadOverviewBrowserTab({
      tab,
      workspaceId,
      threadId,
      lifecycleByTarget,
      liveTargets,
      controllers,
      pendingAgentOpens,
      actingTargets,
    });
    if (row) rows.push(row);
  }
  return rows;
}

function useBrowserTabSet(thread: Thread) {
  return { tabSet: usePreviewTabSet(thread.id, thread.workspace_id) };
}

/** Keeps the tab listing and its update subscription alive while the overview is closed. */
export const { Provider: BrowserEntryState, useEntryState: useBrowserEntryTabSet } =
  createOverviewEntryState(useBrowserTabSet);

function BrowserEntry({ thread }: { thread: Thread }) {
  const { tabSet: browserTabSet } = useBrowserEntryTabSet();
  const browserLifecycleTabs = useBrowserAutomationStore((state) => state.lifecycleTabs);
  const browserLiveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const browserControllers = useBrowserAutomationStore((state) => state.controllers);
  const browserPendingAgentOpens = useBrowserAutomationStore((state) => state.pendingAgentOpens);
  const browserActingTargets = useBrowserAutomationStore((state) => state.actingTargets);
  const browserHostStatus = useBrowserAutomationStore((state) => state.status);
  const browserHostRegistered = useBrowserAutomationStore((state) => state.registered);
  const browserTabs = useMemo(
    () =>
      browserHostRegistered && browserHostStatus === "registered"
        ? getThreadOverviewBrowserTabs({
          workspaceId: thread.workspace_id,
          threadId: thread.id,
          tabSet: browserTabSet,
          lifecycleTabs: browserLifecycleTabs,
          liveTargets: browserLiveTargets,
          controllers: browserControllers,
          pendingAgentOpens: browserPendingAgentOpens,
          actingTargets: browserActingTargets,
        })
        : [],
    [
      browserActingTargets,
      browserControllers,
      browserHostRegistered,
      browserHostStatus,
      browserLifecycleTabs,
      browserLiveTargets,
      browserPendingAgentOpens,
      browserTabSet,
      thread.id,
      thread.workspace_id,
    ],
  );
  return (<ThreadOverviewWhen when={browserTabs.length > 0}>
    <ThreadOverviewBrowserRow thread={thread} pages={browserTabs} activeTabId={browserTabSet?.activeTabId ?? null} />
  </ThreadOverviewWhen>);
}

/** Browser block in the thread overview, preserving its existing row position. */
export function BrowserEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <BrowserEntry thread={subject.thread} /> : null;
}
