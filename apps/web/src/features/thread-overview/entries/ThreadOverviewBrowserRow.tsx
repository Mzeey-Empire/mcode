import { Button } from "@/components/ui/button";
import { SiteFavicon } from "@/components/ui/favicon";
import { liveBrowserStepLabel } from "@/features/conversation/narrative/BrowserActivityRow";
import {
  handBackBrowserControl,
  loopbackPort,
  openUrlInPreview,
  projectServerTiles,
  useBrowserActingTabId,
  useBrowserAutomationStore,
  useBrowserUserHeldTabId,
  usePreviewTabsStore,
  useStartServer,
  useThreadActionRuns,
} from "@/features/preview";
import type { ServerTile } from "@/features/preview";
import type { ThreadOverviewBrowserTab } from "@/features/thread-overview/entries/browser";
import { type BrowserRowState, deriveBrowserRow } from "@/features/thread-overview/entries/browser-row-model";
import { OVERVIEW_ROW_CLASS } from "@/features/thread-overview/overview-row";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { type Thread } from "@/transport";
import { Globe, MousePointer2 } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";

function roleTargetName(args: object): string | undefined {
  if (!("target" in args) || typeof args.target !== "object" || args.target === null) return undefined;
  return "accessibleName" in args.target && typeof args.target.accessibleName === "string"
    ? args.target.accessibleName
    : undefined;
}

function useLiveStep(threadId: string, tabId: string | null): string | null {
  return useBrowserAutomationStore((state) => {
    if (tabId === null) return null;
    let step: string | null = null;
    for (const { dispatch } of state.activeRequests.values()) {
      if (dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
      step = liveBrowserStepLabel(dispatch.request.operation, roleTargetName(dispatch.request.args)) ?? step;
    }
    return step;
  });
}

function openBrowserOnPage(thread: Thread, tabId: string): void {
  showRightPanelAdaptive(thread.workspace_id, thread.id);
  useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "preview");
  void usePreviewTabsStore.getState().activatePage(thread.workspace_id, thread.id, tabId);
}

function PageGlyph({ state }: { state: BrowserRowState }) {
  if (state.kind === "acting") {
    return <MousePointer2 className="size-3.5 shrink-0 fill-primary text-primary" aria-hidden />;
  }
  if (state.kind === "paused") {
    return <MousePointer2 className="size-3.5 shrink-0 text-muted" aria-hidden />;
  }
  if (state.kind === "server-stopped") {
    return <span className="size-2 shrink-0 rounded-full bg-error" aria-hidden />;
  }
  return <SiteFavicon src={state.page.faviconUrl} fallback={<Globe size={14} className="text-muted" />} />;
}

function RowText({ state }: { state: BrowserRowState }) {
  const { page } = state;
  if (state.kind === "open") {
    return (
      <>
        <span className="min-w-0 text-fade text-xs font-medium">{page.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums text-muted">
          {page.host}
          {state.otherPages > 0 ? <span data-testid="thread-overview-browser-more">+{state.otherPages}</span> : null}
        </span>
      </>
    );
  }
  const lead =
    state.kind === "acting" ? state.step
    : state.kind === "paused" ? "Paused"
    : `${state.tile.name} isn't running`;
  return (
    <>
      <span className="shrink-0 text-xs font-medium">{lead}</span>
      {state.kind === "server-stopped" ? null : (
        <span className="min-w-0 text-fade text-xs text-muted">{page.title}</span>
      )}
    </>
  );
}

function RowAction({ children, onPress, loading = false }: { children: ReactNode; onPress: () => void; loading?: boolean }) {
  return (
    <Button
      type="button"
      variant="subtle"
      shape="round"
      size="compact"
      className="h-6 shrink-0 px-2.5 text-xs"
      loading={loading}
      onClick={onPress}
    >
      {children}
    </Button>
  );
}

function summaryOf(state: BrowserRowState): string {
  const { page } = state;
  if (state.kind === "acting") return `Browser, ${state.step}, ${page.title}`;
  if (state.kind === "paused") return `Browser, paused, ${page.title}`;
  if (state.kind === "server-stopped") return `Browser, ${state.tile.name} isn't running, ${page.title}`;
  return `Browser, ${page.title}, ${page.host}${state.otherPages > 0 ? `, ${state.otherPages} more pages` : ""}`;
}

interface ThreadOverviewBrowserRowProps {
  readonly thread: Thread;
  readonly pages: readonly ThreadOverviewBrowserTab[];
  readonly activeTabId: string | null;
}

/** The overview's single Browser row. */
export function ThreadOverviewBrowserRow({ thread, pages, activeTabId }: ThreadOverviewBrowserRowProps) {
  const actingTabId = useBrowserActingTabId(thread.workspace_id, thread.id);
  const heldTabId = useBrowserUserHeldTabId(thread.workspace_id, thread.id);
  const liveStep = useLiveStep(thread.id, actingTabId);
  // Runs are only needed to name a stopped server for a loopback page, so other threads skip the fetch.
  const hasLoopbackPage = pages.some(({ tab }) => tab.url !== null && loopbackPort(tab.url) !== null);
  const runs = useThreadActionRuns(thread.id, hasLoopbackPage);
  const tiles = useMemo(() => projectServerTiles(runs, []), [runs]);
  const state = deriveBrowserRow({ pages, activeTabId, actingTabId, heldTabId, liveStep, tiles });
  // After Start the page reloads in the Browser once the new run's port answers.
  const loadStartedServer = useCallback(
    (url: string) => openUrlInPreview({ url, threadId: thread.id, newTab: false }),
    [thread.id],
  );
  const { start, isRequesting } = useStartServer(tiles, loadStartedServer);
  if (state === null) return null;

  return (
    <div className="flex w-full items-center gap-1" data-testid="thread-overview-browser" data-state={state.kind}>
      <Button
        variant="ghost"
        size="compact"
        type="button"
        aria-label={summaryOf(state)}
        onClick={() => openBrowserOnPage(thread, state.page.tabId)}
        className={cn(OVERVIEW_ROW_CLASS, "min-w-0 flex-1 cursor-pointer justify-start gap-2")}
      >
        <PageGlyph state={state} />
        <RowText state={state} />
      </Button>
      <BrowserRowAction state={state} thread={thread} start={start} isRequesting={isRequesting} />
    </div>
  );
}

function BrowserRowAction({
  state,
  thread,
  start,
  isRequesting,
}: {
  readonly state: BrowserRowState;
  readonly thread: Thread;
  readonly start: (tile: ServerTile) => Promise<void>;
  readonly isRequesting: (actionId: string) => boolean;
}) {
  if (state.kind === "paused") {
    return <RowAction onPress={() => void handBackBrowserControl(thread.workspace_id, thread.id)}>Hand back</RowAction>;
  }
  if (state.kind === "server-stopped") {
    const { tile } = state;
    const tabId = state.page.tabId;
    // The reload lands in the active tab, so make the stopped page the active one before it starts.
    const startOnThisPage = () => {
      void usePreviewTabsStore.getState().activatePage(thread.workspace_id, thread.id, tabId);
      void start(tile);
    };
    return (
      <RowAction loading={isRequesting(tile.actionId)} onPress={startOnThisPage}>
        {isRequesting(tile.actionId) ? "Starting" : `Start ${tile.name}`}
      </RowAction>
    );
  }
  return null;
}
