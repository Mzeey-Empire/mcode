/**
 * Design Mode IPC handlers (Phase G MVP).
 *
 * Provides a read-only inspect overlay that injects a small in-guest script,
 * highlights the hovered element and ships its selector + bounding box
 * back to the renderer. No DOM mutations; no clicks captured.
 */

import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { logger } from "@mcode/shared";
import { getSession } from "../state/window-session.js";
import { resolveActivePreviewWebContents } from "../surfaces/active-web-contents.js";

const INSPECT_SCRIPT = String.raw`(() => {
  if (window.__mcodeInspectActive) return;
  window.__mcodeInspectActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed','pointer-events:none','z-index:2147483646',
    'border:2px solid rgba(56,189,248,0.9)',
    'background:rgba(56,189,248,0.08)','transition:all 60ms ease-out',
    'box-sizing:border-box','left:0','top:0','width:0','height:0','display:none',
  ].join(';');
  document.documentElement.appendChild(overlay);

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push('#' + el.id);
    if (el.classList && el.classList.length > 0) {
      parts.push('.' + Array.from(el.classList).slice(0, 3).join('.'));
    }
    return parts.join('');
  }

  function moveOverlay(el) {
    if (!el) {
      overlay.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }

  const onMove = (ev) => {
    moveOverlay(ev.target);
  };
  const onLeave = () => moveOverlay(null);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseleave', onLeave, true);

  window.__mcodeInspectTeardown = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseleave', onLeave, true);
    overlay.remove();
    delete window.__mcodeInspectActive;
    delete window.__mcodeInspectTeardown;
  };
})();`;

const TEARDOWN_SCRIPT = String.raw`(() => {
  if (typeof window.__mcodeInspectTeardown === 'function') {
    window.__mcodeInspectTeardown();
  }
})();`;

const ANNOTATION_GUARD_SCRIPT = String.raw`(() => {
  if (window.__mcodeAnnotationGuardActive) return;
  window.__mcodeAnnotationGuardActive = true;

  const block = (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.stopPropagation();
  };
  const events = [
    'click',
    'mousedown',
    'mouseup',
    'contextmenu',
    'dblclick',
    'auxclick',
    'pointerdown',
    'pointermove',
    'pointerup',
    'mousemove',
    'mouseover',
    'mouseout',
    'touchstart',
    'touchmove',
    'touchend',
  ];

  for (const eventName of events) {
    document.addEventListener(eventName, block, true);
  }

  window.__mcodeAnnotationGuardTeardown = () => {
    for (const eventName of events) {
      document.removeEventListener(eventName, block, true);
    }
    delete window.__mcodeAnnotationGuardActive;
    delete window.__mcodeAnnotationGuardTeardown;
  };
})();`;

const ANNOTATION_GUARD_TEARDOWN_SCRIPT = String.raw`(() => {
  if (typeof window.__mcodeAnnotationGuardTeardown === 'function') {
    window.__mcodeAnnotationGuardTeardown();
  }
})();`;

/** Where a Browser note sits on its page, in document pixels. */
interface RevealNoteTarget {
  readonly selector: string | null;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

const REVEAL_READY_TIMEOUT_MS = 5_000;
const REVEAL_POLL_INTERVAL_MS = 100;
const MAX_REVEAL_SELECTOR_LENGTH = 2_000;

function parseRevealTarget(payload: unknown): RevealNoteTarget | null {
  const candidate = payload as Partial<RevealNoteTarget> | null;
  const bounds = candidate?.bounds;
  if (!bounds) return null;
  const numbers = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const selector = typeof candidate.selector === "string" && candidate.selector.length <= MAX_REVEAL_SELECTOR_LENGTH
    ? candidate.selector
    : null;
  return { selector, bounds };
}

// A selector hint is not guaranteed to be valid or unique, so it only wins when it names exactly one element.
function revealScript(target: RevealNoteTarget): string {
  return `(() => {
  const target = ${JSON.stringify(target)};
  let element = null;
  if (target.selector) {
    try {
      const matches = document.querySelectorAll(target.selector);
      if (matches.length === 1) element = matches[0];
    } catch {
      element = null;
    }
  }
  if (element) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return;
  }
  const { x, y, width, height } = target.bounds;
  window.scrollTo({
    left: x + width / 2 - window.innerWidth / 2,
    top: y + height / 2 - window.innerHeight / 2,
    behavior: 'instant',
  });
})();`;
}

// A tab just opened or activated has no adopted guest, or only a blank one, until its navigation starts.
async function waitForLoadedGuest(resolve: () => WebContents | null): Promise<WebContents | null> {
  const deadline = Date.now() + REVEAL_READY_TIMEOUT_MS;
  for (;;) {
    const webContents = resolve();
    const ready = webContents && !webContents.isDestroyed() && !webContents.isLoading()
      && !webContents.getURL().startsWith("about:blank");
    if (ready) return webContents;
    if (Date.now() >= deadline) return webContents;
    await new Promise((done) => setTimeout(done, REVEAL_POLL_INTERVAL_MS));
  }
}

/** Registers the Preview design-mode IPC handlers. */
export function registerDesignModeHandlers(): void {
  ipcMain.handle("preview:design.reveal-note", async (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const target = parseRevealTarget(payload);
    if (!target) return { ok: false, error: "invalid-target" };
    const session = getSession(win);
    const webContents = await waitForLoadedGuest(() => resolveActivePreviewWebContents(session));
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no-view" };
    try {
      await webContents.executeJavaScript(revealScript(target), true);
    } catch (err) {
      logger.warn("Preview: reveal note script threw", { err: String(err) });
      return { ok: false, error: "script-failed" };
    }
    return { ok: true };
  });

  ipcMain.handle("preview:design.set-inspect", async (event, payload: { enabled?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const s = getSession(win);
    const webContents = resolveActivePreviewWebContents(s);
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no-view" };
    try {
      await webContents.executeJavaScript(
        payload?.enabled === false ? TEARDOWN_SCRIPT : INSPECT_SCRIPT,
        true,
      );
    } catch (err) {
      logger.warn("Preview: design inspect script threw", { err: String(err) });
      return { ok: false, error: "script-failed" };
    }
    return { ok: true };
  });

  ipcMain.handle("preview:design.set-annotation-guard", async (event, payload: { enabled?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const s = getSession(win);
    const webContents = resolveActivePreviewWebContents(s);
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no-view" };
    try {
      await webContents.executeJavaScript(
        payload?.enabled === false ? ANNOTATION_GUARD_TEARDOWN_SCRIPT : ANNOTATION_GUARD_SCRIPT,
        true,
      );
    } catch (err) {
      logger.warn("Preview: annotation guard script threw", { err: String(err) });
      return { ok: false, error: "script-failed" };
    }
    return { ok: true };
  });
}
