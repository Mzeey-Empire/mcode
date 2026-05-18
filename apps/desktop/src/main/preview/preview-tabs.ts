/**
 * Tab IPC handlers for the embedded preview BrowserView.
 *
 * Phase A scope (this PR): the host still owns a single backing BrowserView per
 * window. These handlers maintain a per-thread tab set whose **active** tab
 * mirrors that single view, and surface a stable wire format so the renderer
 * can build a tab bar today. Future PRs replace the single backing view with
 * one BrowserView per warm tab; the wire contract here does not change.
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
import { hidePreview } from "./preview-lifecycle.js";

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
  try {
    win.webContents.send("preview:tabs-updated", set);
  } catch {
    /* sender may be gone */
  }
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
        // Phase A: activating a brand-new blank tab on the current thread
        // detaches the existing view so the bar reflects "new tab" state.
        // The renderer is expected to follow up with preview:navigate.
        set.activeTabId = tabId;
        hidePreview(win, s);
        s.resumePreviewUrl = null;
        s.lastFavicons = [];
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
          // Phase A: with a single backing view, "activating" a different tab
          // means hiding the current view and letting the renderer's next
          // preview:sync drive the new active tab's resume URL.
          hidePreview(win, s);
          s.resumePreviewUrl = tab.resumeUrl;
          s.lastFavicons = tab.faviconUrl ? [tab.faviconUrl] : [];
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
          hidePreview(win, s);
          s.resumePreviewUrl = null;
          s.lastFavicons = [];
        }
      } else if (wasActive) {
        const nextActive = set.tabs[Math.min(idx, set.tabs.length - 1)]!;
        set.activeTabId = nextActive.id;
        if (tid === s.lastPreviewThreadId) {
          hidePreview(win, s);
          s.resumePreviewUrl = nextActive.resumeUrl;
          s.lastFavicons = nextActive.faviconUrl ? [nextActive.faviconUrl] : [];
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab closed", { threadId: tid, tabId, wasActive });
      return { ok: true, data: tabs };
    },
  );
}
