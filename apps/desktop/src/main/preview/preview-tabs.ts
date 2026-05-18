/**
 * Tab IPC handlers for the embedded preview WebContentsView.
 *
 * Phase A scope (this PR): the host still owns a single backing WebContentsView per
 * window. These handlers maintain a per-thread tab set whose **active** tab
 * mirrors that single view, and surface a stable wire format so the renderer
 * can build a tab bar today. Future PRs replace the single backing view with
 * one WebContentsView per warm tab; the wire contract here does not change.
 */

import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserTabSet } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  getSession,
  syncActiveTabFromSession,
  toBrowserTabSet,
  type PreviewSession,
} from "./preview-session.js";
import { bumpPerf } from "./preview-perf.js";
import {
  isAllowedPreviewUrl,
  sendPreviewLoading,
} from "./preview-session.js";
import { trustMainProcessFileNavigation } from "./preview-local-file.js";

type TabIpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

function normaliseThreadId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normaliseTabId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sendTabsUpdated(win: BrowserWindow, set: BrowserTabSet): void {
  if (win.isDestroyed()) return;
  bumpPerf("stateEmitCalls");
  try {
    win.webContents.send("preview:tabs-updated", set);
  } catch {
    bumpPerf("stateEmitSkips");
  }
}

/**
 * Drive the single backing view to the new active tab's URL. Phase A keeps a
 * single WebContentsView per window (Slice 2 lifts this); after `tabs.activate`
 * or `tabs.create` we navigate that view so what the user sees matches the
 * activated tab. When no view is mounted yet, the next `preview:sync` will
 * create one and restore from `s.resumePreviewUrl`, so we still update that.
 */
function navigateActiveBackingViewToTab(
  win: BrowserWindow,
  s: PreviewSession,
  resumeUrl: string | null,
): void {
  s.resumePreviewUrl = resumeUrl;
  if (!s.view || s.view.webContents.isDestroyed()) {
    return; // sync will recreate and restore from resumeUrl
  }
  const target = resumeUrl ?? "about:blank";
  const wc = s.view.webContents;
  if (wc.getURL() === target) return;
  if (resumeUrl && !isAllowedPreviewUrl(resumeUrl)) {
    // Defensive: should not happen because resumeUrl came from a vetted path,
    // but never navigate to a non-whitelisted protocol.
    return;
  }
  sendPreviewLoading(win, true);
  if (resumeUrl && resumeUrl.startsWith("file:")) {
    trustMainProcessFileNavigation(s, resumeUrl);
  }
  void wc.loadURL(target);
}

/**
 * Phase A: returns the active thread's tab set, but only meaningfully when
 * `threadId` matches the session's current thread. For inactive threads we
 * still materialise their saved tab set so the renderer can preview the list
 * before switching.
 */
function buildTabSet(s: PreviewSession, threadId: string): BrowserTabSet {
  if (threadId === s.lastPreviewThreadId) {
    syncActiveTabFromSession(s);
  }
  return toBrowserTabSet(s, threadId);
}

export function registerTabHandlers(): void {
  ipcMain.handle(
    "preview:tabs.list",
    (_event, payload: { threadId?: unknown }): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const s = getSession(win);
      return { ok: true, data: buildTabSet(s, tid) };
    },
  );

  ipcMain.handle(
    "preview:tabs.create",
    (
      _event,
      payload: { threadId?: unknown; activate?: unknown },
    ): TabIpcResult<{ tabId: string; tabs: BrowserTabSet }> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const activate = payload?.activate !== false; // default: true

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const tabId = randomUUID();
      set.tabs.push({
        id: tabId,
        threadId: tid,
        view: null,
        resumeUrl: null,
        title: null,
        faviconUrl: null,
      });

      if (activate && tid === s.lastPreviewThreadId) {
        // Activating a brand-new blank tab on the current thread: navigate
        // the backing view to about:blank so the user sees a clean slate.
        set.activeTabId = tabId;
        s.lastFavicons = [];
        navigateActiveBackingViewToTab(win, s, null);
      } else if (activate) {
        set.activeTabId = tabId;
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab created", { threadId: tid, tabId, activate });
      return { ok: true, data: { tabId, tabs } };
    },
  );

  ipcMain.handle(
    "preview:tabs.activate",
    (
      _event,
      payload: { threadId?: unknown; tabId?: unknown },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const tabId = normaliseTabId(payload?.tabId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const tab = set.tabs.find((t) => t.id === tabId);
      if (!tab) return { ok: false, error: "tab-not-found" };

      if (set.activeTabId !== tabId) {
        set.activeTabId = tabId;
        if (tid === s.lastPreviewThreadId) {
          // Drive the single backing view to the activated tab's URL so the
          // user sees the right page immediately. Slice 2 swaps per-tab
          // webContents here instead of navigating one shared view.
          s.lastFavicons = tab.faviconUrl ? [tab.faviconUrl] : [];
          navigateActiveBackingViewToTab(win, s, tab.resumeUrl);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab activated", { threadId: tid, tabId });
      return { ok: true, data: tabs };
    },
  );

  ipcMain.handle(
    "preview:tabs.close",
    (
      _event,
      payload: { threadId?: unknown; tabId?: unknown },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const tabId = normaliseTabId(payload?.tabId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const idx = set.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return { ok: false, error: "tab-not-found" };

      const wasActive = set.activeTabId === tabId;
      set.tabs.splice(idx, 1);

      if (set.tabs.length === 0) {
        // Always keep at least one tab so the renderer never sees an empty bar.
        const fallbackId = randomUUID();
        set.tabs.push({
          id: fallbackId,
          threadId: tid,
          view: null,
          resumeUrl: null,
          title: null,
          faviconUrl: null,
        });
        set.activeTabId = fallbackId;
        if (tid === s.lastPreviewThreadId) {
          s.lastFavicons = [];
          navigateActiveBackingViewToTab(win, s, null);
        }
      } else if (wasActive) {
        const nextActive = set.tabs[Math.min(idx, set.tabs.length - 1)]!;
        set.activeTabId = nextActive.id;
        if (tid === s.lastPreviewThreadId) {
          s.lastFavicons = nextActive.faviconUrl ? [nextActive.faviconUrl] : [];
          navigateActiveBackingViewToTab(win, s, nextActive.resumeUrl);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab closed", { threadId: tid, tabId, wasActive });
      return { ok: true, data: tabs };
    },
  );
}
