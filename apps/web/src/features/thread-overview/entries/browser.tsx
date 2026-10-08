import { Button } from "@/components/ui/button";
import { SiteFavicon } from "@/components/ui/favicon";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  usePreviewTabsStore,
} from "@/features/preview";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { type Thread } from "@/transport";
import type { BrowserAutomationControllerState, BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import { Globe, MousePointer2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

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

/** Joins a scoped Browser tab with its lifecycle and controller state. */
function getThreadOverviewBrowserTab({
  tab,
  workspaceId,
  threadId,
  lifecycleByTarget,
  liveTargets,
  controllers,
  pendingAgentOpens,
}: {
  tab: BrowserTabInfo;
  workspaceId: string;
  threadId: string;
  lifecycleByTarget: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
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
  const controller = getBrowserTabController(lifecycle, controllers.get(targetKey), pendingOpen);
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
}: {
  workspaceId: string;
  threadId: string;
  tabSet: BrowserTabSet | null;
  lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  pendingAgentOpens?: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
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
    });
    if (row) rows.push(row);
  }
  return rows;
}

interface ThreadOverviewBrowserSectionProps {
  rows: readonly ThreadOverviewBrowserTab[];
  onOpen: (tabId: string) => void;
}

/** Renders navigated live Browser tabs that can be opened in this thread. */
function ThreadOverviewBrowserSection({ rows, onOpen }: ThreadOverviewBrowserSectionProps) {
  if (rows.length === 0) return null;

  return (
    <section aria-label="Browser" data-testid="thread-overview-browser">
      <Separator className="my-1.5" />
      <div className="px-2 pt-1 text-xs font-medium text-muted">Browser</div>
      <div className="flex w-full flex-col gap-0.5">
        {rows.map(({ tab, controller }) => {
          const title = tab.title?.trim() || "Untitled page";
          const address = tab.url?.trim() || "No address";
          const isAgentControlled = controller === "agent";

          return (
            <Tooltip key={tab.id}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={`thread-overview-browser-tab-${tab.id}`}
                    aria-label={`Browser, ${title}, ${address}${isAgentControlled ? ", agent controls" : ""}`}
                    onClick={() => onOpen(tab.id)}
                    className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {isAgentControlled ? (
                        <MousePointer2
                          className="size-3.5 shrink-0 fill-primary text-primary"
                          aria-label="Agent controls this Browser tab"
                          data-testid="thread-overview-browser-agent-cursor"
                        />
                      ) : (
                        <SiteFavicon
                          src={tab.faviconUrl}
                          fallback={<Globe size={14} className="text-muted" />}
                        />
                      )}
                      <span className="min-w-0 text-fade text-xs font-medium">{title}</span>
                    </span>
                    <span
                      data-testid={`thread-overview-browser-address-${tab.id}`}
                      className="ml-auto text-fade font-mono text-xs tabular-nums text-muted"
                    >
                      {address}
                    </span>
                  </Button>
                }
              />
              <TooltipContent side="top" className="max-w-xs break-all text-xs">
                {address}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}

function BrowserEntry({ thread }: { thread: Thread }) {

  const browserTabSet = usePreviewTabSet(thread.id, thread.workspace_id);
  const browserLifecycleTabs = useBrowserAutomationStore((state) => state.lifecycleTabs);
  const browserLiveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const browserControllers = useBrowserAutomationStore((state) => state.controllers);
  const browserPendingAgentOpens = useBrowserAutomationStore((state) => state.pendingAgentOpens);
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
        })
        : [],
    [
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
  const openBrowserTab = useCallback(
    (tabId: string) => {
      showRightPanelAdaptive(thread.workspace_id, thread.id);
      useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "preview");
      void usePreviewTabsStore.getState().activatePage(thread.workspace_id, thread.id, tabId);
    },
    [thread.id, thread.workspace_id],
  );
  return (<ThreadOverviewWhen when={browserTabs.length > 0}>
    <ThreadOverviewBrowserSection rows={browserTabs} onOpen={openBrowserTab} />
  </ThreadOverviewWhen>);
}

/** Browser block in the thread overview, preserving its existing row position. */
export function BrowserEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <BrowserEntry thread={subject.thread} /> : null;
}
