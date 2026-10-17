import type {
  BrowserHistoryEntry,
  BrowserServerThumbnail,
  WorkspaceEnvironmentActionRun,
} from "@mcode/contracts";
import { loopbackPort } from "../navigation/nav-errors";

/** What a project server tile shows. Derived from the run, never stored. */
export type ServerTileState = "running" | "starting" | "stopped";

/** One project server: an action that has run in this thread and announced a port. */
export interface ServerTile {
  readonly actionId: string;
  readonly name: string;
  readonly state: ServerTileState;
  /** The run's page, present only while the run's own port answers. */
  readonly url: string | null;
  readonly run: WorkspaceEnvironmentActionRun;
  /** Port of the latest run that announced one. Muted history unless the tile is running. */
  readonly port: number;
  readonly thumbnail: string | null;
}

/** A recent page row, with the project server that served it when one did. */
export interface RecentPage {
  readonly url: string;
  readonly title: string;
  readonly faviconUrl: string | null;
  readonly server: string;
  readonly path: string;
  readonly lastVisitedAt: number;
}

/**
 * Running needs the current run's own port to answer. A port kept from an earlier
 * run, or one that stopped answering, leaves a running action Starting so the tile
 * never offers Start for a process that is still alive.
 */
export function serverTileState(run: WorkspaceEnvironmentActionRun): ServerTileState {
  if (run.status !== "running") return "stopped";
  const { port } = run;
  return port !== null && port.runId === run.runId && port.reachable ? "running" : "starting";
}

/** Thumbnails are keyed by origin, which the desktop records with whichever loopback name the page used. */
function thumbnailForPort(thumbnails: readonly BrowserServerThumbnail[], port: number): string | null {
  const match = thumbnails
    .filter((thumbnail) => loopbackPort(thumbnail.origin) === String(port))
    .sort((a, b) => b.capturedAt - a.capturedAt)[0];
  return match?.dataUrl ?? null;
}

/** One tile per action in this thread whose latest run carries a port, ordered by name. */
export function projectServerTiles(
  runsByAction: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
  thumbnails: readonly BrowserServerThumbnail[],
): readonly ServerTile[] {
  const tiles: ServerTile[] = [];
  for (const run of Object.values(runsByAction)) {
    if (run.port === null) continue;
    const state = serverTileState(run);
    tiles.push({
      actionId: run.actionId,
      name: run.actionName,
      state,
      url: state === "running" ? run.port.url : null,
      run,
      port: run.port.port,
      thumbnail: thumbnailForPort(thumbnails, run.port.port),
    });
  }
  return tiles.sort((a, b) => a.name.localeCompare(b.name) || a.actionId.localeCompare(b.actionId));
}

function describeAddress(url: string, tiles: readonly ServerTile[]): { server: string; path: string } {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const port = loopbackPort(url);
    const tile = port === null ? undefined : tiles.find((candidate) => String(candidate.port) === port);
    return { server: tile?.name ?? parsed.host, path: path === "/" ? "" : path };
  } catch {
    return { server: url, path: "" };
  }
}

/** Recent pages, newest first, each named after the project server whose port served it. */
export function recentPages(
  entries: readonly BrowserHistoryEntry[],
  tiles: readonly ServerTile[],
): readonly RecentPage[] {
  return [...entries]
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .map((entry) => {
      const { server, path } = describeAddress(entry.url, tiles);
      return {
        url: entry.url,
        title: entry.title?.trim() || server,
        faviconUrl: entry.faviconUrl,
        server,
        path,
        lastVisitedAt: entry.lastVisitedAt,
      };
    });
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact age for a recent row: "now", "14m", "1h", "Yesterday", then "3d". */
export function recentAge(visitedAt: number, now: number): string {
  const elapsed = Math.max(0, now - visitedAt);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "Yesterday" : `${days}d`;
}
