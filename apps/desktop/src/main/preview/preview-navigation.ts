/**
 * Navigation IPC handlers for the embedded preview BrowserView:
 * sync, navigate, go-back, go-forward, reload, open-external, get-navigation-state.
 */

import { BrowserWindow, ipcMain, shell } from "electron";
import {
  getSession,
  sendPreviewLoading,
  resetIdle,
  isAllowedHttpUrl,
  guestUrlNeedsHttpRestore,
} from "./preview-session.js";
import { hidePreview, ensureView } from "./preview-lifecycle.js";
import { type Bounds } from "./preview-session.js";

/**
 * Registers all navigation-related IPC handlers:
 * preview:sync, preview:navigate, preview:go-back, preview:go-forward,
 * preview:reload, preview:open-external, preview:get-navigation-state.
 * Call once at app startup.
 */
export function registerNavigationHandlers(): void {
  ipcMain.handle(
    "preview:sync",
    (
      _event,
      payload: {
        visible: boolean;
        bounds: Bounds | null;
        threadId?: string | null;
        resumeUrlHint?: string | null;
        workspaceId?: string | null;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return;

      const s = getSession(win);
      const ws = payload.workspaceId;
      s.workspaceId = typeof ws === "string" && ws.trim().length > 0 ? ws.trim() : null;
      const b = payload.bounds;
      if (!payload.visible || !b || b.width < 4 || b.height < 4) {
        hidePreview(win, s);
        return;
      }

      s.lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      const view = ensureView(win, s);
      view.setBounds(s.lastBounds);
      if (win.getBrowserView() !== view) {
        win.setBrowserView(view);
      }
      const wc = view.webContents;
      if (!wc.isDestroyed()) {
        const current = wc.getURL();
        const hintRaw = payload.resumeUrlHint?.trim() ?? "";
        const hint = hintRaw.length > 0 && isAllowedHttpUrl(hintRaw) ? hintRaw : null;
        const tid = payload.threadId ?? null;
        const switchedThread = tid != null && tid !== s.lastPreviewThreadId;
        s.lastPreviewThreadId = tid;

        // One BrowserView is shared across threads; without an explicit navigation on switch,
        // the previous thread's document (and resumePreviewUrl) would leak into the next thread.
        if (switchedThread) {
          if (hint) {
            sendPreviewLoading(win, true);
            void wc.loadURL(hint);
            s.resumePreviewUrl = hint;
          } else {
            s.resumePreviewUrl = null;
            sendPreviewLoading(win, true);
            void wc.loadURL("about:blank");
          }
        } else if (guestUrlNeedsHttpRestore(current) && hint) {
          sendPreviewLoading(win, true);
          void wc.loadURL(hint);
          s.resumePreviewUrl = hint;
        } else if (
          guestUrlNeedsHttpRestore(current) &&
          s.resumePreviewUrl &&
          isAllowedHttpUrl(s.resumePreviewUrl)
        ) {
          sendPreviewLoading(win, true);
          void wc.loadURL(s.resumePreviewUrl);
        }
      }
      resetIdle(win, s);
    },
  );

  ipcMain.handle(
    "preview:navigate",
    (_event, url: string): { ok: true } | { ok: false; error: string } => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const trimmed = url.trim();
      if (!trimmed) return { ok: false, error: "empty-url" };

      let target = trimmed;
      if (!/^https?:\/\//i.test(target)) {
        target = `https://${target}`;
      }
      if (!isAllowedHttpUrl(target)) {
        return { ok: false, error: "invalid-url" };
      }

      const s = getSession(win);
      if (!s.lastBounds) {
        return { ok: false, error: "no-bounds" };
      }

      const view = ensureView(win, s);
      view.setBounds(s.lastBounds);
      if (win.getBrowserView() !== view) {
        win.setBrowserView(view);
      }
      sendPreviewLoading(win, true);
      void view.webContents.loadURL(target);
      s.resumePreviewUrl = target;
      resetIdle(win, s);
      return { ok: true };
    },
  );

  ipcMain.handle("preview:go-back", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return false;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return false;
    if (s.view.webContents.canGoBack()) {
      sendPreviewLoading(win, true);
      s.view.webContents.goBack();
      resetIdle(win, s);
      return true;
    }
    return false;
  });

  ipcMain.handle("preview:go-forward", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return false;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return false;
    if (s.view.webContents.canGoForward()) {
      sendPreviewLoading(win, true);
      s.view.webContents.goForward();
      resetIdle(win, s);
      return true;
    }
    return false;
  });

  ipcMain.handle("preview:reload", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return;
    sendPreviewLoading(win, true);
    s.view.webContents.reload();
    resetIdle(win, s);
  });

  ipcMain.handle("preview:open-external", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return;
    const current = s.view.webContents.getURL();
    if (isAllowedHttpUrl(current)) {
      void shell.openExternal(current);
    }
  });

  ipcMain.handle("preview:get-navigation-state", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return { canGoBack: false, canGoForward: false };
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) {
      return { canGoBack: false, canGoForward: false };
    }
    return {
      canGoBack: s.view.webContents.canGoBack(),
      canGoForward: s.view.webContents.canGoForward(),
    };
  });
}
