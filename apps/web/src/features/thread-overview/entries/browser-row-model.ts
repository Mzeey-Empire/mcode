import { loopbackPort, type ServerTile } from "@/features/preview";
import type { ThreadOverviewBrowserTab } from "@/features/thread-overview/entries/browser";

/** The page the Browser row speaks for. */
export interface BrowserRowPage {
  readonly tabId: string;
  readonly title: string;
  readonly host: string;
  readonly faviconUrl: string | null;
}

/** What the overview's single Browser row shows. Derived on every render, never stored. */
export type BrowserRowState =
  | { readonly kind: "acting"; readonly page: BrowserRowPage; readonly step: string }
  | { readonly kind: "paused"; readonly page: BrowserRowPage }
  | { readonly kind: "server-stopped"; readonly page: BrowserRowPage; readonly tile: ServerTile }
  | { readonly kind: "open"; readonly page: BrowserRowPage; readonly otherPages: number };

interface BrowserRowInput {
  readonly pages: readonly ThreadOverviewBrowserTab[];
  readonly activeTabId: string | null;
  readonly actingTabId: string | null;
  readonly heldTabId: string | null;
  /** The running step, or null while the acting agent sits in the linger window between steps. */
  readonly liveStep: string | null;
  readonly tiles: readonly ServerTile[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function toPage({ tab }: ThreadOverviewBrowserTab): BrowserRowPage {
  const url = tab.url?.trim() ?? "";
  return {
    tabId: tab.id,
    title: tab.title?.trim() || hostOf(url) || "Untitled page",
    host: hostOf(url),
    faviconUrl: tab.faviconUrl,
  };
}

/** The stopped project server whose port the page address points at, if any. */
function stoppedServerFor(url: string | null, tiles: readonly ServerTile[]): ServerTile | null {
  const port = url === null ? null : loopbackPort(url);
  if (port === null) return null;
  return tiles.find((tile) => String(tile.port) === port && tile.state === "stopped") ?? null;
}

/**
 * Picks the one state for the Browser row. Acting wins over a user hold, which wins over a stopped
 * server, because each is more urgent for the person watching the thread. The row follows the tab
 * behind the winning state so its title and Start web never describe a different page.
 */
export function deriveBrowserRow(input: BrowserRowInput): BrowserRowState | null {
  const { pages, activeTabId, actingTabId, heldTabId, liveStep, tiles } = input;
  if (pages.length === 0) return null;
  const find = (tabId: string | null) => pages.find(({ tab }) => tab.id === tabId);
  const acting = find(actingTabId);
  if (acting) return { kind: "acting", page: toPage(acting), step: liveStep ?? "Working on the page" };
  const held = find(heldTabId);
  if (held) return { kind: "paused", page: toPage(held) };
  const shown = find(activeTabId) ?? pages[0]!;
  const tile = stoppedServerFor(shown.tab.url, tiles);
  if (tile) return { kind: "server-stopped", page: toPage(shown), tile };
  return { kind: "open", page: toPage(shown), otherPages: pages.length - 1 };
}
