/**
 * Shared session state types and accessors for the embedded preview BrowserView.
 * All other preview modules import from here rather than maintaining their own state.
 */

import { BrowserView, BrowserWindow } from "electron";
import type { AttachmentMeta, McodeBrowserCaptureV2 } from "@mcode/contracts";

/**
 * Result of a picture-reference capture; defined here so PreviewSession can reference
 * the finish callback type without creating a circular dependency with preview-capture.ts.
 */
export type CaptureFinishResult =
  | { ok: true; meta: AttachmentMeta; previewBytes: Uint8Array; capture: McodeBrowserCaptureV2 }
  | { ok: false; error: string };

/** CSS-pixel rectangle used for BrowserView bounds and capture regions. */
export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Per-window state for the embedded preview BrowserView.
 * One entry is created lazily per BrowserWindow id and removed when the window closes.
 */
export interface PreviewSession {
  view: BrowserView | null;
  idleTimer: NodeJS.Timeout | null;
  /** Last shell-reported bounds so navigate can attach the view before the next sync tick. */
  lastBounds: Bounds | null;
  /**
   * Last loaded http(s) URL before the view was torn down. New BrowserViews start blank;
   * sync restores this so closing and reopening the preview panel keeps the page.
   */
  resumePreviewUrl: string | null;
  /** Key from the last insertCSS call; cleared when the guest navigates or the view is destroyed. */
  scrollbarCssKey: string | null;
  /** Drag-marquee or element-pick overlay; sits above the BrowserView while capturing input. */
  selectionOverlay: BrowserWindow | null;
  overlayPending:
    | { mode: "region" | "element"; finish: (r: CaptureFinishResult) => void; hostWin: BrowserWindow }
    | null;
  /** Removes main-frame navigation listener registered during an overlay capture. */
  navigationAbortDisposable: (() => void) | null;
  /** Recent guest console lines for capture v2 diagnostics (cleared when the view is destroyed). */
  consoleBuffer: string[];
  /** Failed guest subresource responses for v2 capture (best-effort, capped). */
  failedRequestBuffer: Array<{ url: string; statusCode: number; resourceType: string }>;
  /** Last thread id synced from the renderer; used to load the correct resume URL per thread. */
  lastPreviewThreadId: string | null;
  /** Active workspace id from the renderer; scopes spill files under getMcodeDir(). */
  workspaceId: string | null;
  /** Favicon URLs from the last page-favicon-updated event. */
  lastFavicons: string[];
  /** Timestamp of the last renderer crash auto-recovery; used to rate-limit retries. */
  lastCrashRecoveryAt: number;
}

/** Global map of window id -> preview session state. */
export const sessions = new Map<number, PreviewSession>();

/**
 * Returns the existing session for the given window, or creates and registers a fresh one.
 */
export function getSession(win: BrowserWindow): PreviewSession {
  let s = sessions.get(win.id);
  if (!s) {
    s = {
      view: null,
      idleTimer: null,
      lastBounds: null,
      resumePreviewUrl: null,
      scrollbarCssKey: null,
      selectionOverlay: null,
      overlayPending: null,
      navigationAbortDisposable: null,
      consoleBuffer: [],
      failedRequestBuffer: [],
      lastPreviewThreadId: null,
      workspaceId: null,
      lastFavicons: [],
      lastCrashRecoveryAt: 0,
    };
    sessions.set(win.id, s);
  }
  return s;
}

/**
 * Cancels the idle teardown timer on the given session.
 */
export function clearIdle(s: PreviewSession): void {
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
}

/** No-op: idle teardown removed (the React shell parks the view on unmount). */
export function resetIdle(_win: BrowserWindow, s: PreviewSession): void {
  clearIdle(s);
}

/**
 * Tells the React shell to show or hide the loading affordance. The native
 * BrowserView stacks above HTML, so the indicator lives in chrome above the
 * guest bounds rather than inside the surface div.
 */
export function sendPreviewLoading(win: BrowserWindow, loading: boolean): void {
  if (win.isDestroyed()) return;
  try {
    win.webContents.send("preview:loading-state", { loading });
  } catch {
    /* sender may be gone */
  }
}

/**
 * Returns true when the URL is a valid http or https URL.
 * Moved here from preview-navigation to break the circular dependency between
 * preview-lifecycle (imports isAllowedHttpUrl) and preview-navigation (imports ensureView).
 */
export function isAllowedHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when the guest has no real document loaded yet (fresh view or error).
 * Moved here alongside isAllowedHttpUrl to keep URL utilities together.
 */
export function guestUrlNeedsHttpRestore(url: string): boolean {
  if (url.length === 0) return true;
  if (url === "about:blank") return true;
  if (url.startsWith("about:")) return true;
  if (url.startsWith("chrome-error:")) return true;
  return false;
}
