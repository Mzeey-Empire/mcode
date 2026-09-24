import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";
import type { BrowserTabInfo } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { navCodeToPageError } from "./nav-errors";
import { usePreviewTabsStore } from "../state/previewTabsStore";

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Z]:[\\/]/i;

/** Returns true when the event is a Ctrl+click (Windows/Linux) or Cmd+click (macOS). */
export function isModifierClick(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}

/** Whether an address can be sent to the embedded Preview resolver. */
export function isPreviewableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (isMcodeWorkspacePreviewUrl(trimmed)) return true;
  if (WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) return true;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Options for {@link openUrlInPreview}. */
export interface OpenUrlInPreviewOptions {
  /** URL to load in the preview panel. */
  url: string;
  /** Thread that owns the preview session. */
  threadId: string;
  /** Workspace root used to resolve relative paths and mcode-workspace URLs. */
  workspacePath?: string | null;
  /**
   * When true (default), opens in a new preview tab so the active tab keeps
   * its current page.
   */
  newTab?: boolean;
}

function resolveWorkspacePath(
  explicit: string | null | undefined,
  workspaceId: string | undefined,
): string | null {
  if (explicit !== undefined) return explicit;
  const { activeWorkspaceId, workspaces } = useWorkspaceStore.getState();
  // The clicked link's thread scope wins: resolving a relative path against a
  // different active workspace would report missing for a file that exists.
  return workspaces.find((w) => w.id === workspaceId)?.path
    ?? workspaces.find((w) => w.id === activeWorkspaceId)?.path
    ?? null;
}

/**
 * True when a preview tab has no real page loaded yet. Mirrors the host-side
 * `guestUrlNeedsHttpRestore` check so empty tabs are reused instead of spawning
 * another blank tab.
 */
export function isEmptyPreviewTabUrl(url: string | null | undefined): boolean {
  if (!url || url.trim().length === 0) return true;
  const lower = url.trim().toLowerCase();
  if (lower === "about:blank") return true;
  if (lower.startsWith("about:")) return true;
  if (lower.startsWith("chrome-error:")) return true;
  return false;
}

/** Resolves the active tab from a tab set snapshot. */
function findActiveTab(
  tabs: readonly BrowserTabInfo[],
  activeTabId: string | null,
): BrowserTabInfo | undefined {
  if (activeTabId) {
    const byId = tabs.find((t) => t.id === activeTabId);
    if (byId) return byId;
  }
  return tabs.find((t) => t.active);
}

type PreviewTabsApi = NonNullable<NonNullable<typeof window.desktopBridge>["preview"]>["tabs"];

/** Resolves the tab that must receive a preview URL, or a new-tab request. */
async function resolvePreviewTabTarget(
  threadId: string,
  workspaceId: string,
  tabsApi: PreviewTabsApi,
  newTab: boolean,
): Promise<{ readonly tabId?: string } | null> {
  if (!tabsApi?.list || !tabsApi.open) return null;

  const listed = await tabsApi.list(threadId, workspaceId);
  if (!listed.ok) return newTab ? {} : null;

  const active = findActiveTab(listed.data.tabs, listed.data.activeTabId);
  if (!active) return {};

  if (newTab && !isEmptyPreviewTabUrl(active.url)) return {};
  return { tabId: active.id };
}

/** Opens `address` on the resolved tab; retries as a fresh tab when the reuse target vanished. */
async function openTabWithAddress(
  tabsApi: PreviewTabsApi,
  threadId: string,
  workspaceId: string,
  target: { readonly tabId?: string } | null,
  address: string,
): Promise<{ readonly tabId: string | null } | null> {
  if (!target || !tabsApi.open) return null;
  let opened = await tabsApi.open(threadId, workspaceId, {
    activate: true,
    ...target,
    initialAddress: address,
  });
  // A listed tab can close between list and open; retry as a fresh tab.
  if (!opened.ok && target.tabId) {
    opened = await tabsApi.open(threadId, workspaceId, {
      activate: true,
      initialAddress: address,
    });
  }
  return opened.ok ? { tabId: opened.data.tabId } : null;
}

/**
 * Opens an activated blank tab and attaches the resolver failure to it. The
 * address is already known-bad, so passing it as `initialAddress` would just
 * bounce back as `invalid-initial-address`; the renderer-owned pending error
 * is what turns the blank tab into the error page.
 */
async function openPreviewErrorTab(
  tabsApi: PreviewTabsApi,
  threadId: string,
  workspaceId: string,
  input: string,
  code: string,
  newTab: boolean,
): Promise<boolean> {
  if (!tabsApi?.open) return false;
  const target = await resolvePreviewTabTarget(threadId, workspaceId, tabsApi, newTab);
  if (!target) return false;
  const opened = await tabsApi.open(threadId, workspaceId, {
    activate: true,
    ...target,
  });
  if (!opened.ok) return false;
  // Land the host's tab set before the pending entry: a stale tabs snapshot
  // arriving afterwards would otherwise prune the just-opened tab's error.
  usePreviewTabsStore.getState().setTabSet(workspaceId, threadId, opened.data.tabs);
  usePreviewTabsStore.getState().setPendingNavError(workspaceId, threadId, opened.data.tabId, {
    input,
    error: navCodeToPageError(code),
    supersededUrl: null,
  });
  return true;
}

/** A modifier-click promised an in-app preview, but a dead click is worse than an external one. */
function openUrlExternally(url: string, workspacePath: string | null): void {
  const openExternal = window.desktopBridge?.openExternalUrl;
  if (openExternal) {
    if (isMcodeWorkspacePreviewUrl(url)) void openExternal(url, workspacePath);
    else void openExternal(url);
    return;
  }
  if (!isMcodeWorkspacePreviewUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Points the right panel at the preview tab and returns the owning workspace.
 * The panel scope is the thread (per-thread record), or the workspace fallback
 * for the threadless new-thread preview. The incoming id may be either a thread
 * or a workspace id, so resolve the owning workspace from both.
 */
function revealPreviewPanel(threadId: string): string | undefined {
  const ws = useWorkspaceStore.getState();
  const thread = ws.threads.find((t) => t.id === threadId);
  const workspaceId = thread
    ? thread.workspace_id
    : ws.workspaces.find((w) => w.id === threadId)?.id ?? ws.activeWorkspaceId ?? undefined;
  if (!workspaceId) return undefined;
  const panelThreadId = thread ? threadId : undefined;
  showRightPanelAdaptive(workspaceId, panelThreadId);
  useDiffStore.getState().setRightPanelTab(workspaceId, panelThreadId, "preview");
  return workspaceId;
}

interface OpenPreviewAddressInput {
  readonly url: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly wsPath: string | null;
  readonly newTab: boolean;
  readonly setPreviewUrlForThread: (threadId: string, url: string) => void;
}

type PreviewBridge = NonNullable<typeof window.desktopBridge>["preview"];

/** Opens a resolved address on the target tab; failure re-resolves so a vanished file becomes the error page. */
async function openResolvedAddress(
  preview: PreviewBridge,
  input: OpenPreviewAddressInput,
  address: string,
): Promise<void> {
  const target = await resolvePreviewTabTarget(input.threadId, input.workspaceId, preview.tabs, input.newTab);
  const opened = await openTabWithAddress(preview.tabs, input.threadId, input.workspaceId, target, address);
  if (opened) {
    input.setPreviewUrlForThread(input.threadId, address);
    return;
  }
  // The host re-validates initialAddress on open, so a file can vanish between
  // resolve and open (invalid-initial-address). Re-resolving turns that race
  // into the same error page rather than a dead click.
  const recheck = await preview.resolveNavigation?.(input.url, input.wsPath ?? undefined);
  if (recheck && !recheck.ok) {
    if (await openPreviewErrorTab(preview.tabs, input.threadId, input.workspaceId, input.url, recheck.error, input.newTab)) return;
  }
  openUrlExternally(input.url, input.wsPath);
}

/** Resolves then opens the address; every failure surfaces as an error tab or an external open. */
async function openPreviewAddress(
  preview: PreviewBridge,
  input: OpenPreviewAddressInput,
): Promise<void> {
  const resolved = await preview.resolveNavigation?.(input.url, input.wsPath ?? undefined);
  if (resolved?.ok) {
    await openResolvedAddress(preview, input, resolved.url);
    return;
  }
  // A rejected local path must not dead-click: any known failure opens an
  // activated error tab instead of silently falling back to the OS.
  if (resolved && await openPreviewErrorTab(
    preview.tabs,
    input.threadId,
    input.workspaceId,
    input.url,
    resolved.error,
    input.newTab,
  )) return;
  openUrlExternally(input.url, input.wsPath);
}

/**
 * Opens a URL in the embedded browser preview, optionally in a new tab so the
 * current preview tab keeps its page.
 */
export function openUrlInPreview({
  url,
  threadId,
  workspacePath,
  newTab = true,
}: OpenUrlInPreviewOptions): void {
  if (!url.trim()) return;

  const preview = window.desktopBridge?.preview;
  if (!preview) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  const { setPreviewUrlForThread } = useDiffStore.getState();
  const workspaceId = revealPreviewPanel(threadId);
  const wsPath = resolveWorkspacePath(workspacePath, workspaceId);

  // Defer until the preview panel has mounted and reported bounds.
  setTimeout(() => {
    void openPreviewAddress(preview, {
      url,
      threadId,
      workspaceId: workspaceId ?? threadId,
      wsPath,
      newTab,
      setPreviewUrlForThread,
    });
  }, 0);
}

/**
 * Opens a GitHub HTTPS URL in the system browser when plain-clicked, or in the
 * embedded preview (new tab) when Ctrl/Cmd+clicked.
 */
export function openGitHubUrl(
  url: string,
  threadId: string,
  event?: { ctrlKey: boolean; metaKey: boolean },
): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return;
    if (event && isModifierClick(event)) {
      openUrlInPreview({ url, threadId });
      return;
    }
    if (window.desktopBridge?.openExternalUrl) {
      void window.desktopBridge.openExternalUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch {
    // Invalid URL - do nothing
  }
}
