import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Play, X } from "lucide-react";
import type { BrowserHistory, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import { applyActionRun } from "@/features/terminal";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import {
  projectServerTiles,
  recentAge,
  recentPages,
  type RecentPage,
  type ServerTile,
} from "./browserNewPageModel";

const EMPTY_HISTORY: BrowserHistory = { entries: [], thumbnails: [] };
const EMPTY_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

function showFailure(title: string, error: unknown): void {
  useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : String(error) });
}

/** The web runtime has no desktop bridge, so it has no history and no thumbnails. */
function historyBridge() {
  return window.desktopBridge?.preview?.history ?? null;
}

function useBrowserHistory(browserWorkspaceId: string) {
  const [history, setHistory] = useState<BrowserHistory>(EMPTY_HISTORY);
  useEffect(() => {
    const bridge = historyBridge();
    if (!bridge) return;
    let active = true;
    bridge.list(browserWorkspaceId).then(
      (listed) => {
        if (active) setHistory(listed);
      },
      (error: unknown) => {
        if (active) showFailure("Couldn't load recent pages", error);
      },
    );
    return () => {
      active = false;
    };
  }, [browserWorkspaceId]);
  const remove = useCallback(async (url: string) => {
    const bridge = historyBridge();
    if (!bridge) return;
    try {
      await bridge.remove(browserWorkspaceId, url);
      setHistory(await bridge.list(browserWorkspaceId));
    } catch (error) {
      showFailure("Couldn't remove the page", error);
    }
  }, [browserWorkspaceId]);
  return { history, remove };
}

/** Reads this thread's action runs, which the `action.updated` push keeps current. */
function useThreadActionRuns(threadId: string, enabled: boolean) {
  const runs = useProjectActionStore((state) => (enabled ? state.runsByThread[threadId] : undefined)) ?? EMPTY_RUNS;
  useEffect(() => {
    if (!enabled) return;
    const store = useProjectActionStore.getState();
    const requestEpoch = store.updateEpochByThread[threadId] ?? 0;
    const hydrationGeneration = store.beginHydration(threadId);
    let active = true;
    getTransport()
      .listWorkspaceActionRuns(threadId)
      .then((listed) => {
        if (active) useProjectActionStore.getState().hydrateRuns(threadId, listed, requestEpoch, hydrationGeneration);
      })
      .catch((error: unknown) => {
        if (active) showFailure("Couldn't load project servers", error);
      })
      .finally(() => useProjectActionStore.getState().endHydration(threadId));
    return () => {
      active = false;
    };
  }, [enabled, threadId]);
  return runs;
}

/**
 * Start reruns the action in this thread and opens its page once the new run reports a
 * reachable port. Restart reuses the terminal that is still open. Start makes a new one.
 */
function useStartServer(tiles: readonly ServerTile[], onOpen: (url: string) => void) {
  const [starting, setStarting] = useState<ReadonlyMap<string, string>>(new Map());
  // Action id to the run that was stopped. The page opens only for a later run.
  const awaitingPage = useRef(new Map<string, string>());

  useEffect(() => {
    for (const tile of tiles) {
      const fromRunId = awaitingPage.current.get(tile.actionId);
      if (fromRunId === undefined || tile.run.runId === fromRunId) continue;
      if (tile.url !== null) {
        awaitingPage.current.delete(tile.actionId);
        onOpen(tile.url);
      } else if (tile.run.status !== "running" && tile.run.status !== "awaiting-approval") {
        awaitingPage.current.delete(tile.actionId);
      }
    }
  }, [onOpen, tiles]);

  const start = useCallback(async (tile: ServerTile) => {
    const { run } = tile;
    awaitingPage.current.set(run.actionId, run.runId);
    setStarting((current) => new Map(current).set(run.actionId, run.runId));
    try {
      const transport = getTransport();
      const next = run.terminalSessionId !== null
        ? await transport.restartWorkspaceAction(run.threadId, run.actionId)
        : await transport.startWorkspaceAction(run.threadId, run.actionId);
      if (next) applyActionRun(next, { focus: false });
    } catch (error) {
      awaitingPage.current.delete(run.actionId);
      showFailure(`Couldn't start ${run.actionName}. Try again.`, error);
    } finally {
      setStarting((current) => {
        const next = new Map(current);
        next.delete(run.actionId);
        return next;
      });
    }
  }, []);

  return { start, isRequesting: (actionId: string) => starting.has(actionId) };
}

function ServerTileLabel({ tile }: { readonly tile: ServerTile }) {
  const running = tile.url !== null;
  return (
    <div className="flex items-center gap-[7px] px-1 pb-0.5">
      <span
        aria-hidden
        className={cn("size-[7px] shrink-0 rounded-full", running ? "bg-success" : "box-border border-[1.5px] border-muted")}
      />
      <span className={cn("min-w-0 flex-1 text-fade text-label font-semibold", running ? "text-ink" : "text-muted")}>
        {tile.name}
      </span>
      <span className="shrink-0 font-mono text-caption text-muted">:{tile.port}</span>
    </div>
  );
}

function RunningTile({ tile, url, onOpen }: { readonly tile: ServerTile; readonly url: string; readonly onOpen: (url: string) => void }) {
  return (
    <button
      type="button"
      data-testid="browser-server-tile"
      data-state="running"
      aria-label={`Open ${tile.name} on port ${tile.port}`}
      onClick={() => onOpen(url)}
      className="flex min-w-0 flex-col gap-1.5 rounded-[14px] p-1.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
    >
      <div className="h-24 overflow-hidden rounded-[10px] bg-page">
        {tile.thumbnail !== null ? <img src={tile.thumbnail} alt="" className="size-full object-cover object-top" /> : null}
      </div>
      <ServerTileLabel tile={tile} />
    </button>
  );
}

function PendingTile({ tile, state, children }: { readonly tile: ServerTile; readonly state: "starting" | "stopped"; readonly children: ReactNode }) {
  return (
    <div
      data-testid="browser-server-tile"
      data-state={state}
      className="flex min-w-0 flex-col gap-1.5 rounded-[14px] border border-dashed border-border p-1.5"
    >
      <div className="flex h-24 items-center justify-center">{children}</div>
      <ServerTileLabel tile={tile} />
    </div>
  );
}

function ServerTileView({
  tile,
  requesting,
  onOpen,
  onStart,
}: {
  readonly tile: ServerTile;
  readonly requesting: boolean;
  readonly onOpen: (url: string) => void;
  readonly onStart: (tile: ServerTile) => void;
}) {
  if (tile.url !== null) return <RunningTile tile={tile} url={tile.url} onOpen={onOpen} />;
  if (tile.state === "starting" || requesting) {
    return (
      <PendingTile tile={tile} state="starting">
        <span className="text-xs text-muted">Starting</span>
      </PendingTile>
    );
  }
  return (
    <PendingTile tile={tile} state="stopped">
      <button
        type="button"
        aria-label={`Start ${tile.name}`}
        onClick={() => onStart(tile)}
        className="flex h-7 items-center gap-1.5 rounded-full bg-selected pr-3 pl-2.5 text-caption font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
      >
        <Play className="size-2.5 shrink-0" aria-hidden />
        Start
      </button>
    </PendingTile>
  );
}

function RecentRow({
  page,
  now,
  onOpen,
  onRemove,
}: {
  readonly page: RecentPage;
  readonly now: number;
  readonly onOpen: (url: string) => void;
  readonly onRemove: (url: string) => void;
}) {
  return (
    <li data-testid="browser-recent-page" className="group relative">
      <button
        type="button"
        aria-label={`Open ${page.title}`}
        onClick={() => onOpen(page.url)}
        className="flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left group-hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
      >
        {page.faviconUrl !== null
          ? <img src={page.faviconUrl} alt="" className="size-4 shrink-0 rounded-[4px]" />
          : <span aria-hidden className="size-4 shrink-0 rounded-[4px] bg-selected" />}
        <span className="shrink-0 text-label text-ink">{page.title}</span>
        <span className="min-w-0 flex-1 text-fade text-body-small text-muted">
          {page.server}
          {page.path !== "" ? ` ${page.path}` : ""}
        </span>
        <span className="shrink-0 text-caption text-muted group-hover:invisible group-focus-within:invisible">
          {recentAge(page.lastVisitedAt, now)}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${page.title} from recent pages`}
        onClick={() => onRemove(page.url)}
        className="absolute top-1/2 right-2.5 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted group-focus-within:flex group-hover:flex hover:bg-selected hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

interface BrowserNewPageProps {
  /** The thread id, or the workspace id when the Browser runs without a thread. */
  readonly threadId: string;
  /** Scope of the local Browser profile that owns the recent pages. */
  readonly browserWorkspaceId: string;
  /** Navigates the current tab. */
  readonly onOpen: (url: string) => void;
}

/**
 * Body of a new page tab. Tiles show this thread's project servers and recent pages show
 * where this project's Browser has been. A Browser without a thread has no action runs,
 * so it shows recent pages only.
 */
export function BrowserNewPage({ threadId, browserWorkspaceId, onOpen }: BrowserNewPageProps) {
  const hasThread = useWorkspaceThread(threadId, (thread) => thread !== undefined);
  const runs = useThreadActionRuns(threadId, hasThread);
  const { history, remove } = useBrowserHistory(browserWorkspaceId);
  const tiles = useMemo(() => projectServerTiles(runs, history.thumbnails), [runs, history.thumbnails]);
  const recents = useMemo(() => recentPages(history.entries, tiles), [history.entries, tiles]);
  const { start, isRequesting } = useStartServer(tiles, onOpen);
  const now = Date.now();

  return (
    <div data-testid="browser-new-page" className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-7">
      {tiles.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {tiles.map((tile) => (
            <ServerTileView
              key={tile.actionId}
              tile={tile}
              requesting={isRequesting(tile.actionId)}
              onOpen={onOpen}
              onStart={(target) => void start(target)}
            />
          ))}
        </div>
      ) : null}
      {recents.length > 0 ? (
        <ul aria-label="Recent pages" className="flex flex-col">
          {recents.map((page) => (
            <RecentRow key={page.url} page={page} now={now} onOpen={onOpen} onRemove={(url) => void remove(url)} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
