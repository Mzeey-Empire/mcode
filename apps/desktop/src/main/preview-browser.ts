/**
 * Embedded preview BrowserView: navigation, bounds sync from the React shell, and idle teardown.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserView, BrowserWindow, app, ipcMain, session, shell } from "electron";
import type { AttachmentMeta, McodeBrowserCaptureV1 } from "@mcode/contracts";

const IDLE_MS = 120_000;

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

type Bounds = { x: number; y: number; width: number; height: number };

/** Outcome of capturing the visible preview viewport as a PNG attachment. */
export type PreviewPictureReferenceResult =
  | {
      ok: true;
      meta: AttachmentMeta;
      previewBytes: Uint8Array;
      /** Structured page context paired with {@link meta} for outbound prompts. */
      capture: McodeBrowserCaptureV1;
    }
  | { ok: false; error: string };

interface PreviewSession {
  view: BrowserView | null;
  idleTimer: NodeJS.Timeout | null;
  /** Last shell-reported bounds so navigate can attach the view before the next sync tick. */
  lastBounds: Bounds | null;
  /** Key from the last insertCSS call; cleared when the guest navigates or the view is destroyed. */
  scrollbarCssKey: string | null;
  /** Drag-marquee overlay; BrowserView sits above shell HTML while this catches pointer input. */
  selectionOverlay: BrowserWindow | null;
  regionCapturePending:
    | { finish: (r: PreviewPictureReferenceResult) => void; hostWin: BrowserWindow }
    | null;
}

const sessions = new Map<number, PreviewSession>();

function getSession(win: BrowserWindow): PreviewSession {
  let s = sessions.get(win.id);
  if (!s) {
    s = {
      view: null,
      idleTimer: null,
      lastBounds: null,
      scrollbarCssKey: null,
      selectionOverlay: null,
      regionCapturePending: null,
    };
    sessions.set(win.id, s);
  }
  return s;
}

function clearIdle(s: PreviewSession): void {
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
}

function resetIdle(win: BrowserWindow, s: PreviewSession): void {
  clearIdle(s);
  s.idleTimer = setTimeout(() => {
    parkPreview(win, s);
  }, IDLE_MS);
}

/** Full viewport bounds in BrowserView-relative CSS pixels. */
function viewportBoundsFallback(viewWidth: number, viewHeight: number): Bounds {
  return { x: 0, y: 0, width: Math.max(1, viewWidth), height: Math.max(1, viewHeight) };
}

/** Typed capture envelope aligned with PNG bytes for outbound prompt augmentation. */
function buildBrowserCapturePayload(
  webContents: BrowserView["webContents"],
  boundsCss: Bounds,
): McodeBrowserCaptureV1 {
  return {
    schemaVersion: 1,
    pageUrl: webContents.getURL(),
    pageTitle: webContents.getTitle() ?? "",
    capturedAt: new Date().toISOString(),
    bounds: { ...boundsCss },
    selectorHint: null,
  };
}

function detachViewListeners(view: BrowserView): void {
  view.webContents.removeAllListeners("did-navigate");
  view.webContents.removeAllListeners("did-navigate-in-page");
  view.webContents.removeAllListeners("page-title-updated");
  view.webContents.removeAllListeners("did-finish-load");
}

/**
 * Drag-marquee overlay: nodeIntegration is limited to this inline page string so OS-level
 * pointer events sit above the preview BrowserView while the user draws a crop rectangle.
 */
const REGION_OVERLAY_DATA_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;}
#layer{position:fixed;inset:0;background:rgba(15,23,42,.35);cursor:crosshair;touch-action:none;}
#box{position:fixed;border:2px dashed #fff;box-sizing:border-box;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(0,0,0,.4) inset;}
</style></head><body><div id="layer"></div><div id="box"></div>
<script>
const { ipcRenderer } = require("electron");
const layer = document.getElementById("layer");
const box = document.getElementById("box");
let start = null, drag = false, cx = 0, cy = 0;
function lay() {
  if (!start) { box.style.display = "none"; return; }
  const x = Math.min(start.x, cx), y = Math.min(start.y, cy), w = Math.abs(cx - start.x), h = Math.abs(cy - start.y);
  box.style.left = x + "px"; box.style.top = y + "px"; box.style.width = w + "px"; box.style.height = h + "px";
  box.style.display = w > 0 && h > 0 ? "block" : "none";
}
function pt(ev) {
  if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  return { x: ev.clientX, y: ev.clientY };
}
function endDrag() {
  if (!drag || !start) { drag = false; return; }
  drag = false;
  const x = Math.min(start.x, cx), y = Math.min(start.y, cy), w = Math.abs(cx - start.x), h = Math.abs(cy - start.y);
  start = null;
  box.style.display = "none";
  if (w >= 4 && h >= 4) void ipcRenderer.invoke("preview:region-overlay-submit", { x, y, width: w, height: h });
  else void ipcRenderer.invoke("preview:region-overlay-cancel");
}
layer.addEventListener("mousedown", (ev) => { drag = true; start = pt(ev); cx = start.x; cy = start.y; lay(); });
layer.addEventListener("mousemove", (ev) => { if (!drag) return; const p = pt(ev); cx = p.x; cy = p.y; lay(); });
layer.addEventListener("mouseup", () => { endDrag(); });
layer.addEventListener("touchstart", (ev) => { ev.preventDefault(); drag = true; start = pt(ev); cx = start.x; cy = start.y; lay(); }, { passive: false });
layer.addEventListener("touchmove", (ev) => { ev.preventDefault(); if (!drag) return; const p = pt(ev); cx = p.x; cy = p.y; lay(); }, { passive: false });
layer.addEventListener("touchend", (ev) => { ev.preventDefault(); endDrag(); }, { passive: false });
window.addEventListener("keydown", (ev) => { if (ev.key === "Escape") void ipcRenderer.invoke("preview:region-overlay-cancel"); });
</script></body></html>`);

function destroySelectionOverlayOnly(s: PreviewSession): void {
  if (!s.selectionOverlay || s.selectionOverlay.isDestroyed()) {
    s.selectionOverlay = null;
    return;
  }
  try {
    s.selectionOverlay.destroy();
  } catch {
    /* already gone */
  }
  s.selectionOverlay = null;
}

function abortRegionCapture(s: PreviewSession, error: string): void {
  const pending = s.regionCapturePending;
  s.regionCapturePending = null;
  destroySelectionOverlayOnly(s);
  if (pending) {
    if (!pending.hostWin.isDestroyed()) {
      resetIdle(pending.hostWin, s);
    }
    pending.finish({ ok: false, error });
  }
}

function clampRectInPlace(rect: Bounds, maxW: number, maxH: number): Bounds {
  let { x, y, width, height } = rect;
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  width = Math.floor(width);
  height = Math.floor(height);
  width = Math.min(width, Math.max(0, maxW - x));
  height = Math.min(height, Math.max(0, maxH - y));
  return { x, y, width, height };
}

function parkPreview(win: BrowserWindow, s: PreviewSession): void {
  abortRegionCapture(s, "capture-interrupted");
  clearIdle(s);
  if (s.view) {
    if (!win.isDestroyed()) {
      try {
        win.removeBrowserView(s.view);
      } catch {
        // Window may already be detaching the view.
      }
    }
    try {
      detachViewListeners(s.view);
      s.view.webContents.close();
    } catch {
      // Guest contents may already be destroyed.
    }
    s.view = null;
    s.scrollbarCssKey = null;
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

function ensureView(win: BrowserWindow, s: PreviewSession): BrowserView {
  if (s.view) return s.view;
  const view = new BrowserView({
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

  const forwardNav = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    win.webContents.send("preview:did-navigate", {
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    });
  };

  view.webContents.on("did-navigate", forwardNav);
  view.webContents.on("did-navigate-in-page", forwardNav);
  view.webContents.on("page-title-updated", forwardNav);
  view.webContents.on("did-finish-load", () => {
    void injectPreviewScrollbarStyles(s);
  });

  s.view = view;
  return view;
}

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

/** Sanitized hostname (or fallback) used in capture filenames for the preview tab. */
function previewCaptureFileStem(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "http:" || u.protocol === "https:") {
      const host = u.hostname
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48);
      if (host) return host;
    }
  } catch {
    /* use fallback stem */
  }
  return "page";
}

function isAllowedHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Registers ipcMain handlers for `preview:*` channels (call once at startup). */
export function registerPreviewBrowserHandlers(): void {
  session.fromPartition("persist:mcode-preview").setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  ipcMain.handle(
    "preview:sync",
    (_event, payload: { visible: boolean; bounds: Bounds | null }) => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return;

      const s = getSession(win);
      const b = payload.bounds;
      if (!payload.visible || !b || b.width < 4 || b.height < 4) {
        parkPreview(win, s);
        return;
      }

      s.lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      const view = ensureView(win, s);
      view.setBounds(s.lastBounds);
      if (win.getBrowserView() !== view) {
        win.setBrowserView(view);
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
      void view.webContents.loadURL(target);
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

  ipcMain.handle("preview:capture-picture-reference", async (_event): Promise<PreviewPictureReferenceResult> => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) {
      return { ok: false, error: "no-preview" };
    }

    try {
      const image = await s.view.webContents.capturePage();
      const buffer = image.toPNG();
      if (buffer.length === 0) {
        return { ok: false, error: "empty-capture" };
      }

      const id = randomUUID();
      const stem = previewCaptureFileStem(s.view.webContents.getURL());
      const name = `preview-${stem}-${Date.now()}.png`;
      const tempDir = join(app.getPath("temp"), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}.png`);
      await writeFile(tempPath, buffer);

      const meta: AttachmentMeta = {
        id,
        name,
        mimeType: "image/png",
        sizeBytes: buffer.length,
        sourcePath: tempPath,
      };

      const lb = s.lastBounds;
      const pngSize = image.getSize();
      const boundsCss =
        lb !== null ? viewportBoundsFallback(lb.width, lb.height) : viewportBoundsFallback(pngSize.width, pngSize.height);
      const capture = buildBrowserCapturePayload(s.view.webContents, boundsCss);
      resetIdle(win, s);
      return { ok: true, meta, previewBytes: Uint8Array.from(buffer), capture };
    } catch {
      return { ok: false, error: "capture-failed" };
    }
  });

  ipcMain.handle("preview:region-overlay-submit", async (event, rect: Bounds): Promise<void> => {
    const overlayWin = BrowserWindow.fromWebContents(event.sender);
    const parentWin = overlayWin?.getParentWindow();
    if (!overlayWin || overlayWin.isDestroyed() || !parentWin || parentWin.isDestroyed()) return;

    const s = getSession(parentWin);
    if (s.selectionOverlay?.id !== overlayWin.id) return;
    const pending = s.regionCapturePending;
    if (!pending) return;

    s.regionCapturePending = null;
    destroySelectionOverlayOnly(s);

    if (!s.view || s.view.webContents.isDestroyed()) {
      if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
      pending.finish({ ok: false, error: "no-preview" });
      return;
    }

    const lb = s.lastBounds;
    if (!lb) {
      if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
      pending.finish({ ok: false, error: "no-bounds" });
      return;
    }

    const r = clampRectInPlace(rect, lb.width, lb.height);
    if (r.width < 4 || r.height < 4) {
      if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
      pending.finish({ ok: false, error: "region-too-small" });
      return;
    }

    try {
      const image = await s.view.webContents.capturePage(r);
      const buffer = image.toPNG();
      if (buffer.length === 0) {
        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: false, error: "empty-capture" });
        return;
      }

      const id = randomUUID();
      const stem = previewCaptureFileStem(s.view.webContents.getURL());
      const name = `preview-region-${stem}-${Date.now()}.png`;
      const tempDir = join(app.getPath("temp"), "mcode-attachments");
      await mkdir(tempDir, { recursive: true });
      const tempPath = join(tempDir, `${id}.png`);
      await writeFile(tempPath, buffer);

      const meta: AttachmentMeta = {
        id,
        name,
        mimeType: "image/png",
        sizeBytes: buffer.length,
        sourcePath: tempPath,
      };

      const capture = buildBrowserCapturePayload(s.view.webContents, r);

      if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
      pending.finish({ ok: true, meta, previewBytes: Uint8Array.from(buffer), capture });
    } catch {
      if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
      pending.finish({ ok: false, error: "capture-failed" });
    }
  });

  ipcMain.handle("preview:region-overlay-cancel", (event): void => {
    const overlayWin = BrowserWindow.fromWebContents(event.sender);
    const parentWin = overlayWin?.getParentWindow();
    if (!overlayWin || overlayWin.isDestroyed() || !parentWin || parentWin.isDestroyed()) return;
    const s = getSession(parentWin);
    if (s.selectionOverlay?.id !== overlayWin.id) return;
    abortRegionCapture(s, "cancelled");
  });

  ipcMain.handle(
    "preview:capture-picture-region",
    async (_event): Promise<PreviewPictureReferenceResult> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const s = getSession(win);
      if (s.regionCapturePending) {
        abortRegionCapture(s, "cancelled");
      }

      if (!s.lastBounds) return { ok: false, error: "no-bounds" };
      if (!s.view || s.view.webContents.isDestroyed()) {
        return { ok: false, error: "no-preview" };
      }

      return await new Promise<PreviewPictureReferenceResult>((resolve) => {
        clearIdle(s);

        let settled = false;
        const finishOnce = (r: PreviewPictureReferenceResult): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };

        const b = s.lastBounds!;

        const ov = new BrowserWindow({
          parent: win,
          modal: false,
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.max(1, Math.round(b.width)),
          height: Math.max(1, Math.round(b.height)),
          frame: false,
          transparent: true,
          hasShadow: false,
          focusable: true,
          resizable: false,
          movable: false,
          skipTaskbar: true,
          show: false,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
          },
        });

        s.selectionOverlay = ov;
        s.regionCapturePending = { finish: finishOnce, hostWin: win };

        ov.once("ready-to-show", () => {
          ov.show();
          ov.focus();
        });

        ov.on("closed", () => {
          s.selectionOverlay = null;
          if (s.regionCapturePending) {
            const pend = s.regionCapturePending;
            s.regionCapturePending = null;
            if (!pend.hostWin.isDestroyed()) {
              resetIdle(pend.hostWin, s);
            }
            finishOnce({ ok: false, error: "cancelled" });
          }
        });

        void ov.loadURL(REGION_OVERLAY_DATA_URL);
      });
    },
  );
}
