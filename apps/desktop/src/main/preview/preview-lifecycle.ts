/**
 * WebContentsView lifecycle management: create, attach, hide, park, and dispose
 * the embedded preview view for a given BrowserWindow.
 *
 * Migrated from BrowserView (deprecated in Electron 30+) to WebContentsView
 * which is mounted via `BaseWindow.contentView.addChildView`. `BrowserWindow`
 * extends `BaseWindow` so the same window reference works for both APIs.
 */

import { BrowserWindow, WebContentsView, shell } from "electron";
import { logger } from "@mcode/shared";
import {
  type PreviewSession,
  sessions,
  clearIdle,
  sendPreviewLoading,
  isAllowedPreviewUrl,
  syncActiveTabFromSession,
  toBrowserTabSet,
} from "./preview-session.js";
import { removeEpPickHighlighter, abortOverlayCapture } from "./preview-overlay.js";
import { pushPreviewConsoleLine } from "./preview-capture.js";
import { validateResumeUrl, trustMainProcessFileNavigation } from "./preview-local-file.js";

/**
 * Injected into every guest document so preview scrollbars match the app shell on Windows
 * and other platforms where Chromium draws legacy arrow buttons by default.
 */
const PREVIEW_SCROLLBAR_CSS = [
  "::-webkit-scrollbar{width:10px;height:10px}",
  "::-webkit-scrollbar-corner{background:transparent}",
  "::-webkit-scrollbar-track{background:rgba(0,0,0,.18);border-radius:8px}",
  "::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:8px;border:2px solid transparent;background-clip:padding-box}",
  "::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34);background-clip:padding-box}",
  "::-webkit-scrollbar-button{height:0;width:0;display:none}",
  "*{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.28) transparent}",
].join("");

/** True when `view` is currently a child of the window's contentView. */
function isMounted(win: BrowserWindow, view: WebContentsView): boolean {
  try {
    return win.contentView.children.includes(view);
  } catch {
    return false;
  }
}

/** Idempotently mount the view inside the window's contentView. */
export function mountView(win: BrowserWindow, view: WebContentsView): void {
  if (isMounted(win, view)) return;
  try {
    win.contentView.addChildView(view);
  } catch {
    /* window may be tearing down */
  }
}

/** Idempotently remove the view from the window's contentView. */
export function unmountView(win: BrowserWindow, view: WebContentsView): void {
  if (!isMounted(win, view)) return;
  try {
    win.contentView.removeChildView(view);
  } catch {
    /* already detached */
  }
}

/**
 * Removes all preview-related webContents listeners from a WebContentsView so
 * teardown does not fire stale callbacks after the view is detached.
 */
export function detachViewListeners(view: WebContentsView): void {
  view.webContents.removeAllListeners("did-navigate");
  view.webContents.removeAllListeners("did-navigate-in-page");
  view.webContents.removeAllListeners("page-title-updated");
  view.webContents.removeAllListeners("page-favicon-updated");
  view.webContents.removeAllListeners("did-finish-load");
  view.webContents.removeAllListeners("did-start-loading");
  view.webContents.removeAllListeners("did-stop-loading");
  view.webContents.removeAllListeners("console-message");
  view.webContents.removeAllListeners("render-process-gone");
  view.webContents.removeAllListeners("will-navigate");
}

/**
 * Returns the existing WebContentsView for the session, or creates and wires
 * a new one. Attaches navigation, loading, console, crash recovery, and
 * file-URL gate listeners.
 */
export function ensureView(win: BrowserWindow, s: PreviewSession): WebContentsView {
  if (s.view) return s.view;
  logger.info("Preview: WebContentsView created");
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: "persist:mcode-preview",
    },
  });

  view.webContents.setBackgroundThrottling(true);

  view.webContents.setWindowOpenHandler((details) => {
    try {
      const u = new URL(details.url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        void shell.openExternal(details.url);
      }
    } catch {
      // ignore malformed URLs
    }
    return { action: "deny" };
  });

  view.webContents.on("will-navigate", (event, navigationUrl) => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    let parsed: URL;
    try {
      parsed = new URL(navigationUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== "file:") return;
    if (s.trustedFileNavigationBudget > 0) {
      s.trustedFileNavigationBudget--;
      return;
    }
    event.preventDefault();
    void (async () => {
      if (win.isDestroyed() || view.webContents.isDestroyed()) return;
      const safe = await validateResumeUrl(navigationUrl);
      if (safe) {
        trustMainProcessFileNavigation(s, safe);
        sendPreviewLoading(win, true);
        try {
          await view.webContents.loadURL(safe);
        } catch {
          /* guest may be tearing down */
        }
      } else {
        s.resumePreviewUrl = null;
        sendPreviewLoading(win, true);
        try {
          await view.webContents.loadURL("about:blank");
        } catch {
          /* guest may be tearing down */
        }
      }
    })();
  });

  const forwardNav = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    const url = view.webContents.getURL();
    void (async () => {
      if (win.isDestroyed() || view.webContents.isDestroyed()) return;
      const persisted = await validateResumeUrl(isAllowedPreviewUrl(url) ? url : null);
      if (persisted) {
        s.resumePreviewUrl = persisted;
      } else {
        s.resumePreviewUrl = null;
      }
      if (!win.isDestroyed()) {
        win.webContents.send("preview:did-navigate", {
          url,
          title: view.webContents.getTitle(),
          favicon: s.lastFavicons[0] ?? null,
        });
        syncActiveTabFromSession(s);
        if (s.lastPreviewThreadId) {
          win.webContents.send(
            "preview:tabs-updated",
            toBrowserTabSet(s, s.lastPreviewThreadId),
          );
        }
      }
    })();
  };

  view.webContents.on("did-navigate", forwardNav);
  view.webContents.on("did-navigate-in-page", forwardNav);
  view.webContents.on("page-title-updated", forwardNav);
  view.webContents.on("page-favicon-updated", (_e, urls: string[]) => {
    s.lastFavicons = urls;
    if (!win.isDestroyed()) {
      win.webContents.send("preview:did-update-favicon", {
        favicon: urls[0] ?? null,
      });
      syncActiveTabFromSession(s);
      if (s.lastPreviewThreadId) {
        win.webContents.send(
          "preview:tabs-updated",
          toBrowserTabSet(s, s.lastPreviewThreadId),
        );
      }
    }
  });
  view.webContents.on("did-finish-load", () => {
    void injectPreviewScrollbarStyles(s);
  });

  const forwardLoadingStart = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    s.lastFavicons = [];
    win.webContents.send("preview:did-update-favicon", { favicon: null });
    sendPreviewLoading(win, true);
  };
  const forwardLoadingStop = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    sendPreviewLoading(win, false);
  };
  view.webContents.on("did-start-loading", forwardLoadingStart);
  view.webContents.on("did-stop-loading", forwardLoadingStop);

  view.webContents.on("console-message", (_event, level, message) => {
    pushPreviewConsoleLine(s, level, message);
  });

  view.webContents.on("render-process-gone", (_event, details) => {
    const url = s.resumePreviewUrl;
    logger.warn("Preview: renderer crashed", { reason: details.reason, exitCode: details.exitCode, url });

    // Tear down the dead view so ensureView creates a fresh one on next sync.
    if (s.view === view) {
      detachViewListeners(view);
      if (!win.isDestroyed()) {
        unmountView(win, view);
      }
      s.view = null;
      s.scrollbarCssKey = null;
      s.consoleBuffer.length = 0;
      s.failedRequestBuffer.length = 0;
    }

    // Rate-limit auto-recovery: if we already recovered within the last 30 s
    // the page is repeatedly crashing and retrying would loop forever.
    const now = Date.now();
    const CRASH_COOLDOWN_MS = 30_000;
    if (now - s.lastCrashRecoveryAt < CRASH_COOLDOWN_MS) {
      logger.warn("Preview: crash recovery skipped (cooldown active)");
      if (!win.isDestroyed()) {
        sendPreviewLoading(win, false);
      }
      return;
    }

    // Auto-recover once: recreate the view and reload the page that crashed.
    if (!win.isDestroyed() && url) {
      logger.info("Preview: auto-recovering after crash", { url });
      s.lastCrashRecoveryAt = now;
      const fresh = ensureView(win, s);
      if (s.lastBounds) {
        fresh.setBounds(s.lastBounds);
      }
      mountView(win, fresh);
      sendPreviewLoading(win, true);
      trustMainProcessFileNavigation(s, url);
      void fresh.webContents.loadURL(url);
    }
  });

  s.view = view;
  return view;
}

/**
 * Inserts or re-inserts the scrollbar CSS into the current guest document,
 * removing any stale key first to avoid duplicate rules.
 */
async function injectPreviewScrollbarStyles(s: PreviewSession): Promise<void> {
  const view = s.view;
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  if (s.scrollbarCssKey) {
    try {
      await wc.removeInsertedCSS(s.scrollbarCssKey);
    } catch {
      // Previous key may refer to a document that was torn down.
    }
    s.scrollbarCssKey = null;
  }
  try {
    s.scrollbarCssKey = await wc.insertCSS(PREVIEW_SCROLLBAR_CSS, { cssOrigin: "user" });
  } catch {
    // Guest may be mid-destruction.
  }
}

/**
 * Detaches the WebContentsView from the window without destroying it, and
 * aborts any in-progress overlay capture. Used by preview:sync when
 * visibility toggles off temporarily (e.g. React effect cleanup during
 * in-page navigations). The webContents stays alive so the page isn't
 * reloaded when the view is re-attached moments later.
 */
export function hidePreview(win: BrowserWindow, s: PreviewSession): void {
  abortOverlayCapture(s, "capture-interrupted");
  clearIdle(s);
  if (s.view && !win.isDestroyed()) {
    logger.info("Preview: view hidden (detached, kept alive)");
    unmountView(win, s.view);
  }
  if (!win.isDestroyed()) {
    sendPreviewLoading(win, false);
  }
}

/**
 * Detaches the WebContentsView from the window and closes its underlying
 * WebContents, clearing all buffers and stopping the idle timer. Saves the
 * current URL as the resume URL so the next ensureView call can reload it.
 */
export function parkPreview(win: BrowserWindow, s: PreviewSession): void {
  logger.info("Preview: view parked (destroyed)", { url: s.resumePreviewUrl });
  hidePreview(win, s);
  if (s.view) {
    try {
      if (!s.view.webContents.isDestroyed()) {
        void removeEpPickHighlighter(s.view.webContents);
        const parked = s.view.webContents.getURL();
        void validateResumeUrl(isAllowedPreviewUrl(parked) ? parked : null).then((safe) => {
          if (!win.isDestroyed()) {
            s.resumePreviewUrl = safe;
          }
        });
      }
      detachViewListeners(s.view);
      s.view.webContents.close();
    } catch {
      // Guest contents may already be destroyed.
    }
    s.view = null;
    s.scrollbarCssKey = null;
    s.consoleBuffer.length = 0;
    s.failedRequestBuffer.length = 0;
  }
}

/**
 * Removes the preview BrowserView and timers when a window is closing.
 */
export function disposePreviewForWindow(win: BrowserWindow): void {
  const s = sessions.get(win.id);
  if (!s) return;
  parkPreview(win, s);
  sessions.delete(win.id);
}
