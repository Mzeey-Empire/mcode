/**
 * Embedded preview BrowserView: navigation, bounds sync from the React shell, and idle teardown.
 */

import { mkdir, writeFile, readdir, stat, unlink, lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserView, BrowserWindow, app, ipcMain, session, shell } from "electron";
import {
  clampMcodeBrowserCaptureV2,
  isBrowserCaptureSpillAppDataPath,
  MCODE_BROWSER_CAPTURE_V2_STRING_MAX,
  type AttachmentMeta,
  type McodeBrowserCaptureEmulation,
  type McodeBrowserCaptureV2,
  type PreviewDeviceEmulationConfig,
} from "@mcode/contracts";
import { getMcodeDir, redactMcodeBrowserCaptureV2, spillWorkspaceDirSegment } from "@mcode/shared";

// Idle teardown removed: the React shell already hides the view on unmount/tab-switch
// via pushSync(false), so a timer-based teardown is redundant and caused the view to
// go blank while the user was still looking at it.
// const IDLE_MS = 120_000;

/** Hard cap per guest-derived string before redaction so hostile pages cannot exhaust memory. */
const GUEST_TEXT_SAFETY_MAX = 500_000;

/** Delete spill files older than this under `browser-capture-spill/` in the Mcode app data dir. */
const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum time between full-tree spill prune walks so capture stays off the hot path. */
const SPILL_PRUNE_MIN_INTERVAL_MS = 30 * 60 * 1000;

/** Debounce after the last spill write before attempting a prune pass. */
const SPILL_PRUNE_DEBOUNCE_MS = 30_000;

/** One delayed prune shortly after startup so old JSON is collected even without new captures. */
const SPILL_PRUNE_STARTUP_DELAY_MS = 120_000;

let spillPruneDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastGlobalSpillPruneAt = 0;

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

/**
 * Tells the React shell to show or hide the loading affordance. The native
 * BrowserView stacks above HTML, so the indicator lives in chrome above the
 * guest bounds rather than inside the surface div.
 */
function sendPreviewLoading(win: BrowserWindow, loading: boolean): void {
  if (win.isDestroyed()) return;
  try {
    win.webContents.send("preview:loading-state", { loading });
  } catch {
    /* sender may be gone */
  }
}

/** Outcome of capturing the visible preview viewport as a PNG attachment. */
export type PreviewPictureReferenceResult =
  | {
      ok: true;
      meta: AttachmentMeta;
      previewBytes: Uint8Array;
      /** Structured page context paired with {@link meta} for outbound prompts. */
      capture: McodeBrowserCaptureV2;
    }
  | { ok: false; error: string };

/** Structured preview context without PNG bytes (fence-only composer attachment). */
export type PreviewContextReferenceResult =
  | { ok: true; capture: McodeBrowserCaptureV2 }
  | { ok: false; error: string };

interface PreviewSession {
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
    | { mode: "region" | "element"; finish: (r: PreviewPictureReferenceResult) => void; hostWin: BrowserWindow }
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
  /**
   * Lets the next main-process `file:` navigation skip {@link ensureView}'s will-navigate gate,
   * since those loads already passed {@link resolveLocalFileUrl}.
   */
  trustedFileNavigationBudget: number;
  /** Per-thread device emulation config from the renderer (synced on each preview:sync). */
  deviceEmulationConfig: PreviewDeviceEmulationConfig;
  /** Full shell surface rect for emulation layout (the panel bounds before centering). */
  shellBounds: Bounds | null;
  /** Default Chromium user agent captured when the view was created (restored when emulation turns off). */
  defaultGuestUserAgent: string;
  /** Structured emulation metadata included on v2 captures (null when emulation is off). */
  captureEmulationSnapshot: McodeBrowserCaptureEmulation | null;
}

const sessions = new Map<number, PreviewSession>();

function getSession(win: BrowserWindow): PreviewSession {
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
      trustedFileNavigationBudget: 0,
      deviceEmulationConfig: { kind: "off" },
      shellBounds: null,
      defaultGuestUserAgent: "",
      captureEmulationSnapshot: null,
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

/** No-op: idle teardown removed (the React shell parks the view on unmount). */
function resetIdle(_win: BrowserWindow, s: PreviewSession): void {
  clearIdle(s);
}

/** Full viewport bounds in BrowserView-relative CSS pixels. */
function viewportBoundsFallback(viewWidth: number, viewHeight: number): Bounds {
  return { x: 0, y: 0, width: Math.max(1, viewWidth), height: Math.max(1, viewHeight) };
}

const PREVIEW_CONSOLE_BUFFER_MAX = 48;
const PREVIEW_CONSOLE_LINE_MAX = 480;
const PREVIEW_FAILED_REQUEST_MAX = 24;

function pushPreviewConsoleLine(s: PreviewSession, level: number, message: string): void {
  if (s.consoleBuffer.length >= PREVIEW_CONSOLE_BUFFER_MAX) {
    s.consoleBuffer.shift();
  }
  const kind = level >= 3 ? "error" : level === 2 ? "warning" : "log";
  const line = `${kind}: ${message.replace(/[\u0000-\u001F\u007F]/g, " ")}`.slice(0, PREVIEW_CONSOLE_LINE_MAX);
  s.consoleBuffer.push(line);
}

function pushFailedRequest(
  s: PreviewSession,
  entry: { url: string; statusCode: number; resourceType: string },
): void {
  if (s.failedRequestBuffer.length >= PREVIEW_FAILED_REQUEST_MAX) {
    s.failedRequestBuffer.shift();
  }
  s.failedRequestBuffer.push(entry);
}

function snapshotFailedRequestsForCapture(s: PreviewSession): McodeBrowserCaptureV2["failedRequests"] {
  if (s.failedRequestBuffer.length === 0) return undefined;
  return s.failedRequestBuffer.map((e) => ({
    url: e.url.length > 2048 ? e.url.slice(0, 2048) : e.url,
    statusCode: e.statusCode,
    resourceType: e.resourceType,
  }));
}

/** Joins recent main-process console lines for v2 capture (last chars if very long). */
function formatConsoleTail(buffer: readonly string[]): string | undefined {
  if (buffer.length === 0) return undefined;
  const joined = buffer.join("\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (joined.length === 0) return undefined;
  return joined.length > 4000 ? joined.slice(-4000) : joined;
}

/** Guest-run: visible text, headings, interactive outline, scroll and layout viewport metrics. */
const CAPTURE_PAGE_CONTEXT_JS = `(function () {
  try {
    var de = document.documentElement;
    var body = document.body;
    var vw = Math.max(0, de.clientWidth || 0);
    var vh = Math.max(0, de.clientHeight || 0);
    var sx = window.scrollX || 0;
    var sy = window.scrollY || 0;
    var vt = "";
    if (body) {
      vt = (body.innerText || "").replace(/\\s+/g, " ").trim();
    }
    if (vt.length > 12000) vt = vt.slice(0, 12000) + String.fromCharCode(10) + "...[truncated]";
    var ho = [];
    var hs = document.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (var i = 0; i < hs.length && i < 80; i++) {
      var t = (hs[i].textContent || "").trim().replace(/\\s+/g, " ");
      if (!t) continue;
      ho.push(hs[i].tagName.toUpperCase() + ": " + t.slice(0, 200));
    }
    var headingOutline = ho.slice(0, 60).join(String.fromCharCode(10));
    if (headingOutline.length > 4000) headingOutline = headingOutline.slice(0, 4000) + String.fromCharCode(10) + "...[truncated]";
    var io = [];
    var els = document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab]');
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return false;
      var st = window.getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") return false;
      return true;
    }
    function visibleLabel(el) {
      var lab = el.getAttribute("aria-label");
      if (lab && lab.trim()) return lab.trim();
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        var ph = el.placeholder || "";
        if (ph.trim()) return ph.trim();
        return String(el.name || el.type || "input");
      }
      var tx = (el.textContent || "").trim().replace(/\\s+/g, " ");
      if (tx) return tx.slice(0, 80);
      return String(el.getAttribute("href") || "");
    }
    for (var j = 0, seen = 0; j < els.length && seen < 120; j++) {
      var el = els[j];
      if (!isVisible(el)) continue;
      seen++;
      io.push("- [" + (el.getAttribute("role") || el.tagName.toLowerCase()) + "] " + visibleLabel(el).slice(0, 120));
    }
    var interactiveOutline = io.join(String.fromCharCode(10));
    if (interactiveOutline.length > 8000) interactiveOutline = interactiveOutline.slice(0, 8000) + String.fromCharCode(10) + "...[truncated]";
    return JSON.stringify({
      visibleText: vt,
      headingOutline: headingOutline,
      interactiveOutline: interactiveOutline,
      scrollX: sx,
      scrollY: sy,
      layoutWidth: vw,
      layoutHeight: vh
    });
  } catch (e) {
    return JSON.stringify({ error: "context-failed" });
  }
})()`;

type GuestPageContextPayload = {
  visibleText?: string;
  headingOutline?: string;
  interactiveOutline?: string;
  scrollX?: number;
  scrollY?: number;
  layoutWidth?: number;
  layoutHeight?: number;
  error?: string;
};

async function captureGuestPageContextForCapture(
  webContents: BrowserView["webContents"],
): Promise<GuestPageContextPayload | null> {
  if (webContents.isDestroyed()) return null;
  try {
    const raw: unknown = await webContents.executeJavaScript(CAPTURE_PAGE_CONTEXT_JS, true);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as GuestPageContextPayload;
  } catch {
    return null;
  }
}

/** Strips control chars from visible text shipped to the model (guest innerText). */
function scrubVisibleTextForOutbound(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Max length for selector hints after guest + main sanitization (keeps prompts small, bounds CSS injection). */
const SELECTOR_HINT_MAX_LEN = 512;

/** Injected into the guest so the highlight shares the page coordinate system (layout viewport). */
const EP_INJECT_JS = `(function(){
  var id="__mcode_ep_hl", tid="__mcode_ep_tip";
  if (document.getElementById(id)) return;
  var s = document.createElement("style");
  s.setAttribute("data-mcode-ep", "1");
  s.textContent = "#__mcode_ep_hl{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;border:2px solid #22d3ee;box-sizing:border-box;z-index:2147483646;display:none;box-shadow:0 0 0 1px rgba(0,0,0,.35) inset;border-radius:2px}#__mcode_ep_tip{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;display:none;max-width:min(440px,calc(100vw - 12px));font:11px/1.35 ui-sans-serif,system-ui,sans-serif;color:#e2e8f0;background:rgba(15,23,42,.94);border:1px solid #22d3ee;border-radius:4px;padding:5px 8px;box-shadow:0 2px 10px rgba(0,0,0,.35);word-break:break-all}";
  (document.head || document.documentElement).appendChild(s);
  var box = document.createElement("div");
  box.id = id;
  box.setAttribute("aria-hidden", "true");
  var tip = document.createElement("div");
  tip.id = tid;
  tip.setAttribute("aria-live", "polite");
  var root = document.body || document.documentElement;
  root.appendChild(box);
  root.appendChild(tip);
})()`;

const EP_REMOVE_JS = `(function(){
  var h = document.getElementById("__mcode_ep_hl");
  var t = document.getElementById("__mcode_ep_tip");
  if (h) h.remove();
  if (t) t.remove();
  document.querySelectorAll('style[data-mcode-ep="1"]').forEach(function (n) { n.remove(); });
})()`;

/**
 * Draws the element-pick highlight inside the guest page (not the shell overlay), matching layout viewport coords.
 * Must run removeEpPickHighlighter before capturePage so the cyan frame is not in the PNG.
 */
async function injectEpPickHighlighter(wc: BrowserView["webContents"]): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(EP_INJECT_JS, true);
  } catch {
    /* guest mid-navigation */
  }
}

/** Updates or clears the guest highlight box and selector tooltip. */
async function updateEpPickHighlighter(
  wc: BrowserView["webContents"],
  bounds: Bounds | null,
  label: string,
): Promise<void> {
  if (wc.isDestroyed()) return;
  const bJson = bounds === null ? "null" : JSON.stringify(bounds);
  const lJson = JSON.stringify(label);
  const js = `(function(b,label){
  var el = document.getElementById("__mcode_ep_hl");
  var tip = document.getElementById("__mcode_ep_tip");
  if (!el || !tip) return;
  if (!b || b.width < 1 || b.height < 1) {
    el.style.display = "none";
    tip.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.style.left = b.x + "px";
  el.style.top = b.y + "px";
  el.style.width = b.width + "px";
  el.style.height = b.height + "px";
  tip.textContent = label || "";
  tip.style.display = label ? "block" : "none";
  if (!label) return;
  var gap = 6, pad = 6;
  var below = b.y + b.height + gap;
  var vw = window.innerWidth || 1;
  var vh = window.innerHeight || 1;
  var ty = below;
  var est = 22;
  if (below + est > vh - pad && b.y > est + pad) ty = b.y - est - gap;
  tip.style.left = Math.min(b.x, Math.max(0, vw - 420)) + "px";
  tip.style.top = Math.round(ty) + "px";
  requestAnimationFrame(function () {
    var h = tip.offsetHeight || est;
    var b2 = below;
    if (b2 + h > vh - pad && b.y > h + pad) ty = b.y - h - gap;
    else ty = b2;
    var tw = tip.offsetWidth || 200;
    tip.style.left = Math.max(pad, Math.min(b.x, vw - tw - pad)) + "px";
    tip.style.top = Math.round(ty) + "px";
  });
})(${bJson}, ${lJson})`;
  try {
    await wc.executeJavaScript(js, true);
  } catch {
    /* guest torn down */
  }
}

async function removeEpPickHighlighter(wc: BrowserView["webContents"]): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(EP_REMOVE_JS, true);
  } catch {
    /* already destroyed */
  }
}

/** Prefer BrowserView bounds; shell-reported rect can lag ResizeObserver. */
function hostBoundsForHitTest(s: PreviewSession): Bounds | null {
  if (s.view && !s.view.webContents.isDestroyed()) {
    try {
      const b = s.view.getBounds();
      if (b.width > 0 && b.height > 0) {
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    } catch {
      /* use lastBounds */
    }
  }
  return s.lastBounds;
}

/**
 * Builds guest-executed hit-test script for element pick: bounds, heuristic selector, optional HTML excerpt.
 * Maps overlay pointer coords to the guest layout viewport using documentElement client metrics
 * (innerWidth/innerHeight can disagree with layout when scrollbars or root overflow differ).
 * Highlight nodes live on the root document: hit rects must be mapped from subframes by walking the frameElement chain.
 * Excerpt cloning strips active content and form state so hostile pages leak less into prompts.
 */
function buildHitTestJs(overlayX: number, overlayY: number, hostWidth: number, hostHeight: number): string {
  const xi = Math.max(0, Math.round(overlayX));
  const yi = Math.max(0, Math.round(overlayY));
  const hw = Math.max(0, Math.round(hostWidth));
  const hh = Math.max(0, Math.round(hostHeight));
  return `(function () {
  var hostW = ${hw}, hostH = ${hh};
  var ox = ${xi}, oy = ${yi};
  var REMOVE_TAGS = { SCRIPT:1, IFRAME:1, OBJECT:1, EMBED:1, LINK:1, NOSCRIPT:1, FRAME:1, META:1, BASE:1 };
  function classTokens(el) {
    var raw = "";
    if (typeof el.className === "string") raw = el.className;
    else if (el.className && typeof el.className.baseVal === "string") raw = el.className.baseVal;
    if (!raw || !raw.trim()) return [];
    return raw.trim().split(/\\s+/).filter(function (c) { return c.length > 0; }).slice(0, 4);
  }
  function escCls(t) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(t);
    return String(t).replace(/[^a-zA-Z0-9_-]/g, "");
  }
  function nthOfType(el) {
    var tag = el.tagName;
    var p = el.parentElement;
    if (!p || !tag) return 1;
    var n = 1;
    var kids = p.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === el) return n;
      if (kids[i].tagName === tag) n++;
    }
    return n;
  }
  function stripRiskyAttrs(el) {
    if (!el.attributes) return;
    var rm = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      var low = a.name.toLowerCase();
      if (low.indexOf("on") === 0) rm.push(a.name);
      if (low === "srcdoc") rm.push(a.name);
      if (low === "href" && a.value && /^javascript:/i.test(a.value)) {
        try { el.setAttribute("href", "#"); } catch (e1) {}
      }
      if ((low === "src" || low === "xlink:href") && a.value && /^javascript:/i.test(a.value)) rm.push(a.name);
    }
    rm.forEach(function (n) { try { el.removeAttribute(n); } catch (e2) {} });
  }
  function sanitizeTree(node) {
    if (!node || node.nodeType !== 1) return;
    var tg = node.tagName ? node.tagName.toUpperCase() : "";
    if (REMOVE_TAGS[tg]) {
      node.remove();
      return;
    }
    stripRiskyAttrs(node);
    var tn = node.tagName ? node.tagName.toUpperCase() : "";
    if (tn === "INPUT") {
      try {
        node.value = "";
        node.setAttribute("value", "");
      } catch (e3) {}
    }
    if (tn === "TEXTAREA") {
      try { node.textContent = ""; } catch (e4) {}
    }
    if (tn === "SELECT") {
      try {
        var os = node.querySelectorAll("option");
        for (var j = 0; j < os.length; j++) {
          os[j].value = "";
          os[j].textContent = "";
        }
      } catch (e5) {}
    }
    var ch = node.firstChild;
    while (ch) {
      var nx = ch.nextSibling;
      if (ch.nodeType === 1) sanitizeTree(ch);
      ch = nx;
    }
  }
  function selectorHintFor(el) {
    var tag = (el.tagName && el.tagName.toLowerCase()) || "*";
    var hint = null;
    try {
      if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement && el.type === "password") {
        var pn = el.getAttribute("name");
        return pn ? "input[type=password][name=" + JSON.stringify(String(pn)) + "]" : "input[type=password]";
      }
      if (el.id && String(el.id).trim()) {
        hint = "[id=" + JSON.stringify(String(el.id)) + "]";
      } else {
        var tid = el.getAttribute && el.getAttribute("data-testid");
        if (tid) hint = "[data-testid=" + JSON.stringify(String(tid)) + "]";
        else {
          var nm = el.getAttribute && el.getAttribute("name");
          if (nm && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) {
            hint = tag + "[name=" + JSON.stringify(String(nm)) + "]";
          } else {
            var al = el.getAttribute && el.getAttribute("aria-label");
            if (al && String(al).trim()) {
              var als = String(al).trim().slice(0, 64);
              hint = tag + "[aria-label=" + JSON.stringify(als) + "]";
            } else {
              var role = el.getAttribute && el.getAttribute("role");
              if (role && String(role).trim()) {
                var rls = String(role).trim().slice(0, 32);
                hint = tag + "[role=" + JSON.stringify(rls) + "]";
              } else {
                var parts = classTokens(el).filter(function (c) { return escCls(c).length > 0; }).slice(0, 3);
                var cls = parts.length ? "." + parts.map(escCls).join(".") : "";
                var nth = nthOfType(el);
                hint = tag + cls + ":nth-of-type(" + nth + ")";
              }
            }
          }
        }
      }
    } catch (se) {
      hint = tag;
    }
    if (hint && hint.length > 400) hint = hint.slice(0, 400);
    return hint;
  }
  function pointInRect(px, py, r) {
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }
  function isHugeRect(r) {
    var de = document.documentElement;
    var vw = Math.max(0, de.clientWidth || window.innerWidth || 0);
    var vh = Math.max(0, de.clientHeight || window.innerHeight || 0);
    if (vw < 1 || vh < 1) return false;
    return (r.width * r.height) >= (vw * vh * 0.92);
  }
  function isInteractive(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "a" || tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || tag === "label" || tag === "summary" || tag === "option") {
      return true;
    }
    var role = el.getAttribute && el.getAttribute("role");
    if (!role) return false;
    role = role.toLowerCase();
    return role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "option" || role === "checkbox" || role === "radio" || role === "switch";
  }
  function pickElementAt(px, py) {
    var list;
    try {
      list = document.elementsFromPoint(px, py);
    } catch (ept) {
      list = [];
    }
    if (!list || !list.length) {
      try {
        return document.elementFromPoint(px, py);
      } catch (ept2) {
        return null;
      }
    }
    var docEl = document.documentElement;
    var body = document.body;
    var candidates = [];
    var maxScan = Math.min(list.length, 16);
    for (var i = 0; i < maxScan; i++) {
      var c = list[i];
      if (!c || c.nodeType !== 1) continue;
      if (c === docEl || c === body) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (!pointInRect(px, py, r)) continue;
      var area = r.width * r.height;
      var huge = isHugeRect(r);
      candidates.push({ el: c, r: r, area: area, huge: huge, interactive: isInteractive(c), depth: i });
    }
    var interact = candidates.filter(function (c) { return c.interactive && !c.huge; });
    if (!interact.length) interact = candidates.filter(function (c) { return c.interactive; });
    if (interact.length) {
      interact.sort(function (a, b) {
        if (a.area !== b.area) return a.area - b.area;
        return a.depth - b.depth;
      });
      return interact[0].el;
    }
    var normals = candidates.filter(function (c) { return !c.huge; });
    if (normals.length) {
      normals.sort(function (a, b) { return a.area - b.area; });
      return normals[0].el;
    }
    if (candidates.length) return candidates[candidates.length - 1].el;
    try {
      return document.elementFromPoint(px, py);
    } catch (ept3) {
      return null;
    }
  }
  function roundBounds(r) {
    var x0 = Math.round(r.x);
    var y0 = Math.round(r.y);
    var w0 = Math.max(1, Math.round(r.width));
    var h0 = Math.max(1, Math.round(r.height));
    return { x: x0, y: y0, width: w0, height: h0 };
  }
  /** getBoundingClientRect in a subframe is relative to that frame; fixed overlays in the root need root layout coords. */
  function boundingRectInRootLayoutViewport(el) {
    var br = el.getBoundingClientRect();
    var x = br.left;
    var y = br.top;
    var w = br.width;
    var h = br.height;
    var doc = el.ownerDocument;
    var win = doc ? doc.defaultView : null;
    while (win && win !== win.top) {
      var frame = win.frameElement;
      if (!frame) break;
      var fr = frame.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      doc = frame.ownerDocument;
      win = doc ? doc.defaultView : null;
    }
    return { x: x, y: y, width: w, height: h };
  }
  try {
    var doc = document;
    var de = doc.documentElement;
    var px = ox, py = oy;
    if (hostW > 0 && hostH > 0) {
      var gww = Math.max(1, de.clientWidth || window.innerWidth || hostW);
      var ghh = Math.max(1, de.clientHeight || window.innerHeight || hostH);
      px = Math.round((ox * gww) / hostW);
      py = Math.round((oy * ghh) / hostH);
    }
    var iw = Math.max(1, de.clientWidth || window.innerWidth);
    var ih = Math.max(1, de.clientHeight || window.innerHeight);
    px = Math.max(0, Math.min(px, iw - 0.001));
    py = Math.max(0, Math.min(py, ih - 0.001));
    var el = pickElementAt(px, py);
    if (!el || el === doc.documentElement || el === doc.body) {
      return JSON.stringify({ ok: false, code: "no-hit" });
    }
    var r = boundingRectInRootLayoutViewport(el);
    var rbGuest = roundBounds(r);
    var selectorHint = selectorHintFor(el);
    var htmlExcerpt = null;
    if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement && el.type === "password") {
      htmlExcerpt = null;
    } else {
      try {
        var clone = el.cloneNode(true);
        if (clone && clone.nodeType === 1) {
          sanitizeTree(clone);
          var html = clone.outerHTML || "";
          var max = 8000;
          if (html.length > max) html = html.slice(0, max) + "\\n...[truncated]";
          htmlExcerpt = html;
        }
      } catch (he) {
        htmlExcerpt = null;
      }
    }
    return JSON.stringify({
      ok: true,
      bounds: rbGuest,
      selectorHint: selectorHint,
      htmlExcerpt: htmlExcerpt
    });
  } catch (err) {
    return JSON.stringify({ ok: false, code: "hit-test-error" });
  }
})()`;
}

/** Strips control chars and bounds length; defense in depth if guest output is abnormal. */
function sanitizeSelectorHintFromGuest(s: string | null | undefined): string | null {
  if (s == null || typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (t.length === 0) return null;
  return t.length > SELECTOR_HINT_MAX_LEN ? t.slice(0, SELECTOR_HINT_MAX_LEN) : t;
}

/** Removes disallowed characters and nested executable-ish blobs from excerpt text shipped to the model. */
function scrubHtmlExcerptForOutbound(s: string): string {
  let t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  t = t.replace(/<\/script\b[^>]*>[\s\S]*?<\/script>/gi, "<!-- stripped -->");
  t = t.replace(/<\/iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "<!-- stripped -->");
  t = t.replace(/<iframe\b[^>]*\/?>/gi, "<!-- stripped -->");
  return t;
}

type HitTestResult =
  | {
      ok: true;
      /** Guest viewport CSS pixels: used for capturePage and in-page highlight. */
      bounds: Bounds;
      selectorHint: string | null;
      htmlExcerpt: string | null;
    }
  | { ok: false; code: string };

function parseBoundsRecord(b: unknown): Bounds | null {
  if (!b || typeof b !== "object") return null;
  const bb = b as Record<string, unknown>;
  const x = bb.x;
  const y = bb.y;
  const width = bb.width;
  const height = bb.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return { x, y, width, height };
}

/** Validates hit-test JSON from the guest so spoofed shapes never become typed results. */
function parseHitTestPayload(parsed: unknown): HitTestResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.ok === false) {
    return typeof p.code === "string" ? { ok: false, code: p.code } : null;
  }
  if (p.ok !== true) return null;
  const bounds = parseBoundsRecord(p.bounds);
  if (!bounds) return null;
  const selectorHint =
    p.selectorHint == null ? null : sanitizeSelectorHintFromGuest(String(p.selectorHint));
  let htmlExcerpt: string | null = null;
  if (p.htmlExcerpt != null && typeof p.htmlExcerpt === "string" && p.htmlExcerpt.length > 0) {
    const scrubbed = scrubHtmlExcerptForOutbound(p.htmlExcerpt);
    htmlExcerpt = scrubbed.length > 0 ? scrubbed : null;
  }
  return {
    ok: true,
    bounds,
    selectorHint,
    htmlExcerpt,
  };
}

async function runElementHitTest(
  webContents: BrowserView["webContents"],
  overlayX: number,
  overlayY: number,
  hostBounds: Bounds | null,
): Promise<HitTestResult | null> {
  if (webContents.isDestroyed()) return null;
  const rx = Math.round(overlayX);
  const ry = Math.round(overlayY);
  const hw = hostBounds && hostBounds.width > 0 ? hostBounds.width : 0;
  const hh = hostBounds && hostBounds.height > 0 ? hostBounds.height : 0;
  try {
    const raw: unknown = await webContents.executeJavaScript(buildHitTestJs(rx, ry, hw, hh), true);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed: unknown = JSON.parse(text);
    return parseHitTestPayload(parsed);
  } catch {
    return null;
  }
}

function endOverlaySession(s: PreviewSession): void {
  if (s.navigationAbortDisposable) {
    s.navigationAbortDisposable();
    s.navigationAbortDisposable = null;
  }
}

function abortOverlayCapture(s: PreviewSession, error: string): void {
  endOverlaySession(s);
  const pending = s.overlayPending;
  s.overlayPending = null;
  if (s.view && !s.view.webContents.isDestroyed()) {
    void removeEpPickHighlighter(s.view.webContents);
  }
  destroySelectionOverlayOnly(s);
  if (pending) {
    if (!pending.hostWin.isDestroyed()) {
      resetIdle(pending.hostWin, s);
    }
    pending.finish({ ok: false, error });
  }
}

function safetyCapGuestText(s: string): string {
  return s.length <= GUEST_TEXT_SAFETY_MAX ? s : s.slice(0, GUEST_TEXT_SAFETY_MAX);
}

function captureNeedsSpillPostRedact(c: McodeBrowserCaptureV2): boolean {
  const m = MCODE_BROWSER_CAPTURE_V2_STRING_MAX;
  return (
    (!!c.htmlExcerpt && c.htmlExcerpt.length > m.htmlExcerpt) ||
    (!!c.visibleTextExcerpt && c.visibleTextExcerpt.length > m.visibleTextExcerpt) ||
    (!!c.headingOutline && c.headingOutline.length > m.headingOutline) ||
    (!!c.interactiveOutlineExcerpt && c.interactiveOutlineExcerpt.length > m.interactiveOutlineExcerpt) ||
    (!!c.consoleTail && c.consoleTail.length > m.consoleTail)
  );
}

function resolveValidatedSpillAbsolutePath(rel: string): string | null {
  if (!isBrowserCaptureSpillAppDataPath(rel)) return null;
  const segments = rel.split("/");
  if (segments.length !== 3 || segments[0] !== "browser-capture-spill") return null;
  const [, wsSeg, file] = segments;
  const base = resolve(getMcodeDir(), "browser-capture-spill", wsSeg);
  const abs = resolve(base, file);
  if (normalize(dirname(abs)) !== normalize(base)) return null;
  return abs;
}

async function pruneStaleBrowserCaptureSpills(rootDir: string): Promise<void> {
  try {
    const now = Date.now();
    const top = await readdir(rootDir, { withFileTypes: true });
    for (const ent of top) {
      if (!ent.isDirectory()) continue;
      const dir = join(rootDir, ent.name);
      const files = await readdir(dir);
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const p = join(dir, name);
        const st = await stat(p);
        if (now - st.mtimeMs > SPILL_MAX_AGE_MS) {
          await unlink(p).catch(() => {});
        }
      }
    }
  } catch {
    /* missing dir or race */
  }
}

/**
 * Debounces and throttles global spill pruning so `persistBrowserCaptureSpill` does not scan
 * every workspace directory on every capture (noticeable on slow storage).
 */
function scheduleGlobalBrowserCaptureSpillPrune(): void {
  if (spillPruneDebounceTimer) clearTimeout(spillPruneDebounceTimer);
  spillPruneDebounceTimer = setTimeout(() => {
    spillPruneDebounceTimer = null;
    const now = Date.now();
    if (now - lastGlobalSpillPruneAt < SPILL_PRUNE_MIN_INTERVAL_MS) return;
    lastGlobalSpillPruneAt = now;
    void pruneStaleBrowserCaptureSpills(join(getMcodeDir(), "browser-capture-spill"));
  }, SPILL_PRUNE_DEBOUNCE_MS);
}

/**
 * Writes full redacted excerpts under the Mcode app data directory so production and dev use
 * ~/.mcode / ~/.mcode-dev rather than the project tree or `.mcode-local/`.
 */
async function persistBrowserCaptureSpill(
  workspaceId: string,
  redacted: McodeBrowserCaptureV2,
): Promise<{ appDataPath: string; absolutePath: string } | null> {
  const wid = workspaceId.trim();
  if (!wid) return null;
  const sub = spillWorkspaceDirSegment(wid);
  const id = randomUUID();
  const fileName = `${id}.json`;
  const spillRoot = join(getMcodeDir(), "browser-capture-spill", sub);
  await mkdir(spillRoot, { recursive: true });
  const fields: Record<string, string> = {};
  if (redacted.htmlExcerpt) fields.htmlExcerpt = redacted.htmlExcerpt;
  if (redacted.visibleTextExcerpt) fields.visibleTextExcerpt = redacted.visibleTextExcerpt;
  if (redacted.headingOutline) fields.headingOutline = redacted.headingOutline;
  if (redacted.interactiveOutlineExcerpt) {
    fields.interactiveOutlineExcerpt = redacted.interactiveOutlineExcerpt;
  }
  if (redacted.consoleTail) fields.consoleTail = redacted.consoleTail;
  const body = {
    schemaVersion: 1 as const,
    capturedAt: redacted.capturedAt,
    pageUrl: redacted.pageUrl,
    pageTitle: redacted.pageTitle,
    fields,
  };
  const absolutePath = join(spillRoot, fileName);
  await writeFile(absolutePath, JSON.stringify(body), "utf8");
  scheduleGlobalBrowserCaptureSpillPrune();
  const appDataPath = `browser-capture-spill/${sub}/${fileName}`;
  return { appDataPath, absolutePath };
}

/** Typed capture envelope aligned with PNG bytes for outbound prompt augmentation (v2 adds text outline and console tail). */
async function buildBrowserCapturePayload(
  webContents: BrowserView["webContents"],
  boundsCss: Bounds,
  consoleBuffer: readonly string[],
  failedRequests: McodeBrowserCaptureV2["failedRequests"],
  workspaceId: string | null,
  extras?: {
    captureKind?: "viewport" | "region" | "element";
    selectorHint?: string | null;
    htmlExcerpt?: string | null;
  },
): Promise<McodeBrowserCaptureV2> {
  const ctx = await captureGuestPageContextForCapture(webContents);
  const tail = formatConsoleTail(consoleBuffer);

  const out: McodeBrowserCaptureV2 = {
    schemaVersion: 2,
    pageUrl: webContents.getURL(),
    pageTitle: webContents.getTitle() ?? "",
    capturedAt: new Date().toISOString(),
    bounds: { ...boundsCss },
    selectorHint:
      extras?.selectorHint != null ? sanitizeSelectorHintFromGuest(String(extras.selectorHint)) : null,
  };
  if (extras?.captureKind !== undefined) {
    out.captureKind = extras.captureKind;
  }
  if (extras?.htmlExcerpt != null && extras.htmlExcerpt.length > 0) {
    const scrubbed = scrubHtmlExcerptForOutbound(extras.htmlExcerpt);
    if (scrubbed.length > 0) {
      out.htmlExcerpt = safetyCapGuestText(scrubbed);
    }
  }
  if (tail) {
    out.consoleTail = tail;
  }
  if (ctx && !ctx.error) {
    if (ctx.visibleText != null && ctx.visibleText.length > 0) {
      const scrubbed = scrubVisibleTextForOutbound(ctx.visibleText);
      if (scrubbed.length > 0) {
        out.visibleTextExcerpt = safetyCapGuestText(scrubbed);
      }
    }
    if (ctx.headingOutline != null && ctx.headingOutline.length > 0) {
      const ho = scrubVisibleTextForOutbound(ctx.headingOutline);
      if (ho.length > 0) {
        out.headingOutline = safetyCapGuestText(ho);
      }
    }
    if (ctx.interactiveOutline != null && ctx.interactiveOutline.length > 0) {
      const io = scrubVisibleTextForOutbound(ctx.interactiveOutline);
      if (io.length > 0) {
        out.interactiveOutlineExcerpt = safetyCapGuestText(io);
      }
    }
    if (typeof ctx.scrollX === "number" && Number.isFinite(ctx.scrollX)) {
      const sy = typeof ctx.scrollY === "number" && Number.isFinite(ctx.scrollY) ? ctx.scrollY : 0;
      out.viewportScroll = { scrollX: ctx.scrollX, scrollY: sy };
    }
    if (
      typeof ctx.layoutWidth === "number" &&
      Number.isFinite(ctx.layoutWidth) &&
      typeof ctx.layoutHeight === "number" &&
      Number.isFinite(ctx.layoutHeight)
    ) {
      out.layoutViewport = { width: Math.max(0, ctx.layoutWidth), height: Math.max(0, ctx.layoutHeight) };
    }
  }
  if (failedRequests && failedRequests.length > 0) {
    out.failedRequests = failedRequests;
  }
  const redacted = redactMcodeBrowserCaptureV2(out);
  const clamped = clampMcodeBrowserCaptureV2(redacted);
  const wid = workspaceId?.trim() ?? "";
  if (wid && captureNeedsSpillPostRedact(redacted)) {
    const sp = await persistBrowserCaptureSpill(wid, redacted);
    if (sp) {
      clamped.spillAppDataPath = sp.appDataPath;
      clamped.spillAbsolutePath = sp.absolutePath;
    }
  }
  return clamped;
}

function attachMainFrameNavigationAbort(s: PreviewSession, webContents: BrowserView["webContents"]): () => void {
  const handler = (_event: unknown, _url: string, _isSameDocument: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) abortOverlayCapture(s, "navigated-away");
  };
  webContents.on("did-start-navigation", handler);
  return () => webContents.removeListener("did-start-navigation", handler);
}

function beginOverlaySession(s: PreviewSession, webContents: BrowserView["webContents"]): void {
  if (s.navigationAbortDisposable) {
    s.navigationAbortDisposable();
    s.navigationAbortDisposable = null;
  }
  s.navigationAbortDisposable = attachMainFrameNavigationAbort(s, webContents);
}

function detachViewListeners(view: BrowserView): void {
  view.webContents.removeAllListeners("will-navigate");
  view.webContents.removeAllListeners("did-navigate");
  view.webContents.removeAllListeners("did-navigate-in-page");
  view.webContents.removeAllListeners("page-title-updated");
  view.webContents.removeAllListeners("page-favicon-updated");
  view.webContents.removeAllListeners("did-finish-load");
  view.webContents.removeAllListeners("did-start-loading");
  view.webContents.removeAllListeners("did-stop-loading");
  view.webContents.removeAllListeners("console-message");
}

/**
 * Drag-marquee overlay: nodeIntegration is limited to this inline page string so OS-level
 * pointer events sit above the preview BrowserView while the user draws a crop rectangle.
 */
const REGION_OVERLAY_DATA_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;}
#layer{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,.35);cursor:crosshair;touch-action:none;}
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

/**
 * Pointer-capture overlay for element pick: hit-testing and highlight run in the guest page
 * so rects match {@link Element#getBoundingClientRect}; this layer only forwards pointer events.
 */
const ELEMENT_OVERLAY_DATA_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;}
#layer{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,.18);cursor:crosshair;touch-action:none;}
</style></head><body><div id="layer"></div>
<script>
const { ipcRenderer } = require("electron");
const layer = document.getElementById("layer");
let rafHover = 0;
let hx = 0, hy = 0;
function scheduleHover() {
  if (rafHover) return;
  rafHover = requestAnimationFrame(async () => {
    rafHover = 0;
    try {
      await ipcRenderer.invoke("preview:element-pick-hover", { x: hx, y: hy });
    } catch (_e) {}
  });
}
function pt(ev) {
  if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  return { x: ev.clientX, y: ev.clientY };
}
function ptEnd(ev) {
  if (ev.changedTouches && ev.changedTouches[0]) {
    return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
  }
  return pt(ev);
}
layer.addEventListener("mousemove", (ev) => { hx = ev.clientX; hy = ev.clientY; scheduleHover(); });
layer.addEventListener("mouseleave", () => {
  if (rafHover) {
    cancelAnimationFrame(rafHover);
    rafHover = 0;
  }
  void ipcRenderer.invoke("preview:element-pick-hover", { x: -1, y: -1 });
});
layer.addEventListener("click", async (ev) => {
  ev.preventDefault();
  try { await ipcRenderer.invoke("preview:element-pick-commit", pt(ev)); } catch (_e) {}
});
layer.addEventListener("touchstart", (ev) => {
  ev.preventDefault();
  const p = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  hx = p.x; hy = p.y;
  scheduleHover();
}, { passive: false });
layer.addEventListener("touchmove", (ev) => {
  ev.preventDefault();
  const p = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  hx = p.x; hy = p.y;
  scheduleHover();
}, { passive: false });
layer.addEventListener("touchend", async (ev) => {
  ev.preventDefault();
  try { await ipcRenderer.invoke("preview:element-pick-commit", ptEnd(ev)); } catch (_e) {}
}, { passive: false });
window.addEventListener("keydown", (ev) => { if (ev.key === "Escape") void ipcRenderer.invoke("preview:element-pick-cancel"); });
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

/**
 * Detach the BrowserView from the window without destroying it. The web
 * contents stay alive so navigation history, scroll position, and page
 * state survive tab switches inside the right panel.
 */
function hidePreview(win: BrowserWindow, s: PreviewSession): void {
  abortOverlayCapture(s, "capture-interrupted");
  clearIdle(s);
  if (s.view && !win.isDestroyed()) {
    try {
      win.removeBrowserView(s.view);
    } catch {
      // Window may already be detaching the view.
    }
  }
  if (!win.isDestroyed()) {
    sendPreviewLoading(win, false);
  }
}

/**
 * Fully tear down the BrowserView, destroying its web contents. Used only
 * when the window is closing or the view must be replaced (not for
 * routine tab switches - use {@link hidePreview} for that).
 */
function parkPreview(win: BrowserWindow, s: PreviewSession): void {
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
    s.captureEmulationSnapshot = null;
  }
}

/**
 * Tears down the preview BrowserView without deleting the session.
 * Called when the shell renderer refreshes so the native overlay does not
 * linger on top of the fresh page; the next `preview:sync` from the
 * re-mounted React tree will recreate the view.
 */
export function parkPreviewForWindow(win: BrowserWindow): void {
  const s = sessions.get(win.id);
  if (!s) return;
  parkPreview(win, s);
}

/**
 * Removes the preview BrowserView and session when a window is closing.
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
          // Best-effort: lastFavicons is populated by page-favicon-updated which fires
          // after did-navigate, so this is often null on initial load. The dedicated
          // preview:did-update-favicon push (Step 3) is the canonical delivery path.
          favicon: s.lastFavicons[0] ?? null,
        });
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

  view.webContents.on("console-message", (event) => {
    const lvl = typeof event.level === "number" ? event.level : 0;
    pushPreviewConsoleLine(s, lvl, event.message);
  });

  s.view = view;
  try {
    s.defaultGuestUserAgent = view.webContents.getUserAgent();
  } catch {
    s.defaultGuestUserAgent = "";
  }
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

/** Accepts http, https, and file URLs for the preview BrowserView. */
function isAllowedPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
  } catch {
    return false;
  }
}

/** Pre-compiled regex for browser-viewable file extensions (hoisted to avoid recompilation per navigate). */
const BROWSER_VIEWABLE_EXT_RE = /\.(html?|pdf|svg|xml|xhtml|mhtml|txt|json|css|js|mjs|webp|png|jpe?g|gif|bmp|ico|avif)$/i;

/** Basename patterns that should never be served in the preview. */
const SENSITIVE_FILE_PATTERNS = [
  /^\.env/i,
  /^\.git$/i,
  /^\.ssh$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^\.aws$/i,
  /^credentials/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

/**
 * Returns true when any segment of a normalized path matches a sensitive
 * file or directory pattern (e.g. `.env`, `.git/config`, `.ssh/id_rsa`).
 */
function isSensitivePath(filePath: string): boolean {
  const segments = normalize(filePath).split(sep);
  return segments.some((seg) =>
    SENSITIVE_FILE_PATTERNS.some((pat) => pat.test(seg)),
  );
}

/**
 * Detects Windows UNC paths so SMB targets never reach `lstat` / `realpath`.
 * Keeps `\\?\` and `\\.\` prefixes (local extended/device paths) allowed.
 */
function isUncPath(filePath: string): boolean {
  const n = normalize(filePath);
  if (!n.startsWith("\\\\")) return false;
  if (n.startsWith("\\\\?\\") || n.startsWith("\\\\.\\")) return false;
  return true;
}

/** Marks the next main-process `file:` navigation as trusted for the will-navigate gate. */
function trustMainProcessFileNavigation(s: PreviewSession, url: string): void {
  try {
    if (new URL(url).protocol === "file:") {
      s.trustedFileNavigationBudget++;
    }
  } catch {
    /* malformed URLs do not consume budget */
  }
}

/**
 * Resolve user input into a `file://` URL.
 *
 * Handles tilde expansion (`~/...`), absolute paths, paths relative to
 * `workspacePath`, and raw `file://` inputs (rejecting non-local hosts).
 * Returns an error result when the path is not previewable, blocked, or missing.
 */
async function resolveLocalFileUrl(
  input: string,
  workspacePath: string | null,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const trimmed = input.trim();

  if (trimmed.startsWith("\\\\")) {
    return { ok: false, error: "sensitive-file" };
  }

  let resolved: string;

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "file:") {
        return { ok: false, error: "invalid-url" };
      }
      const host = u.hostname.toLowerCase();
      if (host !== "" && host !== "localhost") {
        return { ok: false, error: "sensitive-file" };
      }
      resolved = normalize(fileURLToPath(trimmed));
    } catch {
      return { ok: false, error: "invalid-url" };
    }
  } else if (trimmed.startsWith("~")) {
    resolved = resolve(homedir(), trimmed.slice(trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? 2 : 1));
    resolved = normalize(resolved);
  } else if (isAbsolute(trimmed)) {
    resolved = normalize(resolve(trimmed));
  } else if (workspacePath) {
    resolved = normalize(resolve(workspacePath, trimmed));
  } else {
    return { ok: false, error: "no-workspace" };
  }

  if (isUncPath(resolved)) {
    return { ok: false, error: "sensitive-file" };
  }

  if (isSensitivePath(resolved)) {
    return { ok: false, error: "sensitive-file" };
  }

  try {
    let info = await lstat(resolved);
    if (info.isSymbolicLink()) {
      const real = await realpath(resolved);
      if (isSensitivePath(real)) {
        return { ok: false, error: "sensitive-file" };
      }
      // Follow the symlink so subsequent checks use the target's type.
      resolved = real;
      info = await lstat(real);
    }
    if (info.isDirectory()) {
      const indexPath = join(resolved, "index.html");
      try {
        const indexInfo = await stat(indexPath);
        if (indexInfo.isFile()) {
          return { ok: true, url: pathToFileURL(indexPath).href };
        }
      } catch {
        return { ok: false, error: "is-directory" };
      }
    }
    if (!info.isFile()) {
      return { ok: false, error: "not-a-file" };
    }
  } catch {
    return { ok: false, error: "file-not-found" };
  }

  return { ok: true, url: pathToFileURL(resolved).href };
}

/**
 * Heuristic: returns true when the input looks like a local file path rather
 * than a domain name. Matches tilde prefix, drive letters (C:\), explicit
 * slashes (./, ../, /), and common file extensions (.html, .pdf, etc.).
 */
function looksLikeFilePath(input: string): boolean {
  if (input.startsWith("~")) return true;
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../")) return true;
  if (input.startsWith(".\\") || input.startsWith("..\\")) return true;
  // Windows drive letter (C:\ or C:/)
  if (/^[A-Za-z]:[/\\]/.test(input)) return true;
  // Reject inputs where the first segment looks like a domain (e.g.
  // "example.com/page.html"). A domain-like segment contains a dot but no
  // path separators before the first slash.
  const firstSlash = input.indexOf("/");
  const firstSegment = firstSlash >= 0 ? input.slice(0, firstSlash) : input;
  if (firstSegment.includes(".") && !firstSegment.includes("\\")) {
    // Could be a hostname - fall through to URL handling.
    return false;
  }
  // Ends with a browser-viewable file extension and has a path separator.
  const hasPathSep = input.includes("/") || input.includes("\\");
  if (hasPathSep && BROWSER_VIEWABLE_EXT_RE.test(input)) return true;
  return false;
}

/** True when the guest has no real document loaded yet (fresh view or error). */
function guestUrlNeedsHttpRestore(url: string): boolean {
  if (url.length === 0) return true;
  if (url === "about:blank") return true;
  if (url.startsWith("about:")) return true;
  if (url.startsWith("chrome-error:")) return true;
  return false;
}

/**
 * Validates a resume/hint URL before loading. HTTP(S) URLs pass through;
 * file:// URLs are re-checked through resolveLocalFileUrl to prevent
 * renderer-supplied hints from bypassing sensitive-path guards.
 */
async function validateResumeUrl(url: string | null): Promise<string | null> {
  if (!url || !isAllowedPreviewUrl(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "file:") {
      const host = u.hostname.toLowerCase();
      if (host !== "" && host !== "localhost") return null;
      const filePath = fileURLToPath(url);
      const result = await resolveLocalFileUrl(filePath, null);
      return result.ok ? result.url : null;
    }
  } catch {
    return null;
  }
  return url;
}

/** Registers ipcMain handlers for `preview:*` channels (call once at startup). */
export function registerPreviewBrowserHandlers(): void {
  const previewPartition = session.fromPartition("persist:mcode-preview");
  previewPartition.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  previewPartition.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
    const code = details.statusCode ?? 0;
    if (code > 0 && code < 400) return;
    const wcId = details.webContentsId;
    if (wcId == null) return;
    const url = details.url;
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;
    const rt = String(details.resourceType ?? "other").slice(0, 32);
    const safeUrl = url.length > 2048 ? url.slice(0, 2048) : url;
    for (const s of sessions.values()) {
      if (!s.view || s.view.webContents.isDestroyed()) continue;
      if (s.view.webContents.id !== wcId) continue;
      pushFailedRequest(s, { url: safeUrl, statusCode: code, resourceType: rt });
      return;
    }
  });

  ipcMain.handle(
    "preview:sync",
    async (
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
        const hint = hintRaw.length > 0 && isAllowedPreviewUrl(hintRaw) ? hintRaw : null;
        const tid = payload.threadId ?? null;
        const switchedThread = tid != null && tid !== s.lastPreviewThreadId;
        s.lastPreviewThreadId = tid;

        // One BrowserView is shared across threads; without an explicit navigation on switch,
        // the previous thread's document (and resumePreviewUrl) would leak into the next thread.
        const safeHint = await validateResumeUrl(hint);
        if (switchedThread) {
          if (safeHint) {
            sendPreviewLoading(win, true);
            trustMainProcessFileNavigation(s, safeHint);
            void wc.loadURL(safeHint);
            s.resumePreviewUrl = safeHint;
          } else {
            s.resumePreviewUrl = null;
            sendPreviewLoading(win, true);
            void wc.loadURL("about:blank");
          }
        } else if (guestUrlNeedsHttpRestore(current) && safeHint) {
          sendPreviewLoading(win, true);
          trustMainProcessFileNavigation(s, safeHint);
          void wc.loadURL(safeHint);
          s.resumePreviewUrl = safeHint;
        } else if (guestUrlNeedsHttpRestore(current) && s.resumePreviewUrl) {
          const safeResume = await validateResumeUrl(s.resumePreviewUrl);
          if (safeResume) {
            sendPreviewLoading(win, true);
            trustMainProcessFileNavigation(s, safeResume);
            void wc.loadURL(safeResume);
          } else {
            s.resumePreviewUrl = null;
          }
        }
      }
      resetIdle(win, s);
    },
  );

  ipcMain.handle(
    "preview:navigate",
    async (
      _event,
      url: string,
      workspacePath?: string | null,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const trimmed = url.trim();
      if (!trimmed) return { ok: false, error: "empty-url" };

      let target: string;

      if (/^https?:\/\//i.test(trimmed)) {
        // Explicit http(s) URL - use as-is.
        target = trimmed;
      } else if (/^file:\/\//i.test(trimmed)) {
        const resolved = await resolveLocalFileUrl(trimmed, workspacePath?.trim() ?? null);
        if (!resolved.ok) return resolved;
        target = resolved.url;
      } else if (looksLikeFilePath(trimmed)) {
        // Resolve file path (relative, absolute, or tilde-prefixed).
        const resolved = await resolveLocalFileUrl(trimmed, workspacePath?.trim() ?? null);
        if (!resolved.ok) return resolved;
        target = resolved.url;
      } else {
        // Treat bare input as a URL and prepend https://.
        target = `https://${trimmed}`;
      }

      if (!isAllowedPreviewUrl(target)) {
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
      trustMainProcessFileNavigation(s, target);
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
    if (s.view.webContents.navigationHistory.canGoBack()) {
      sendPreviewLoading(win, true);
      s.view.webContents.navigationHistory.goBack();
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
    if (s.view.webContents.navigationHistory.canGoForward()) {
      sendPreviewLoading(win, true);
      s.view.webContents.navigationHistory.goForward();
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
      canGoBack: s.view.webContents.navigationHistory.canGoBack(),
      canGoForward: s.view.webContents.navigationHistory.canGoForward(),
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
      const capture = await buildBrowserCapturePayload(
        s.view.webContents,
        boundsCss,
        s.consoleBuffer,
        snapshotFailedRequestsForCapture(s),
        s.workspaceId,
        {
          captureKind: "viewport",
        },
      );
      resetIdle(win, s);
      return { ok: true, meta, previewBytes: Uint8Array.from(buffer), capture };
    } catch {
      return { ok: false, error: "capture-failed" };
    }
  });

  ipcMain.handle("preview:capture-context-reference", async (_event): Promise<PreviewContextReferenceResult> => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) {
      return { ok: false, error: "no-preview" };
    }

    const lb = s.lastBounds;
    if (!lb) {
      return { ok: false, error: "no-bounds" };
    }

    try {
      const boundsCss = viewportBoundsFallback(lb.width, lb.height);
      const capture = await buildBrowserCapturePayload(
        s.view.webContents,
        boundsCss,
        s.consoleBuffer,
        snapshotFailedRequestsForCapture(s),
        s.workspaceId,
        { captureKind: "viewport" },
      );
      resetIdle(win, s);
      return { ok: true, capture };
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
    const pending = s.overlayPending;
    if (!pending || pending.mode !== "region") return;

    s.overlayPending = null;
    endOverlaySession(s);
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

      const capture = await buildBrowserCapturePayload(
        s.view.webContents,
        r,
        s.consoleBuffer,
        snapshotFailedRequestsForCapture(s),
        s.workspaceId,
        {
          captureKind: "region",
        },
      );

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
    abortOverlayCapture(s, "cancelled");
  });

  ipcMain.handle("preview:cancel-capture", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.selectionOverlay) return;
    abortOverlayCapture(s, "cancelled");
  });

  ipcMain.handle(
    "preview:element-pick-hover",
    async (event, pt: { x: unknown; y: unknown }): Promise<{ ok: true } | { ok: false }> => {
      const overlayWin = BrowserWindow.fromWebContents(event.sender);
      const parentWin = overlayWin?.getParentWindow();
      if (!overlayWin || overlayWin.isDestroyed() || !parentWin || parentWin.isDestroyed()) {
        return { ok: false };
      }
      const s = getSession(parentWin);
      if (s.selectionOverlay?.id !== overlayWin.id) return { ok: false };
      if (!s.overlayPending || s.overlayPending.mode !== "element") return { ok: false };
      if (!s.view || s.view.webContents.isDestroyed()) return { ok: false };

      const x = typeof pt?.x === "number" && Number.isFinite(pt.x) ? pt.x : NaN;
      const y = typeof pt?.y === "number" && Number.isFinite(pt.y) ? pt.y : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };

      if (x < 0 || y < 0) {
        await updateEpPickHighlighter(s.view.webContents, null, "");
        return { ok: false };
      }

      const host = hostBoundsForHitTest(s);
      const hit = await runElementHitTest(s.view.webContents, x, y, host);
      if (!hit || !hit.ok) {
        await updateEpPickHighlighter(s.view.webContents, null, "");
        return { ok: false };
      }
      const label = hit.selectorHint && hit.selectorHint.length > 0 ? hit.selectorHint : "Element";
      await updateEpPickHighlighter(s.view.webContents, hit.bounds, label);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "preview:element-pick-commit",
    async (event, pt: { x: unknown; y: unknown }): Promise<void> => {
      const overlayWin = BrowserWindow.fromWebContents(event.sender);
      const parentWin = overlayWin?.getParentWindow();
      if (!overlayWin || overlayWin.isDestroyed() || !parentWin || parentWin.isDestroyed()) return;

      const s = getSession(parentWin);
      if (s.selectionOverlay?.id !== overlayWin.id) return;
      const pending = s.overlayPending;
      if (!pending || pending.mode !== "element") return;

      const x = typeof pt?.x === "number" && Number.isFinite(pt.x) ? pt.x : NaN;
      const y = typeof pt?.y === "number" && Number.isFinite(pt.y) ? pt.y : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        abortOverlayCapture(s, "no-hit");
        return;
      }

      s.overlayPending = null;
      endOverlaySession(s);
      destroySelectionOverlayOnly(s);

      if (!s.view || s.view.webContents.isDestroyed()) {
        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: false, error: "no-preview" });
        return;
      }

      const lb = s.lastBounds;
      if (!lb) {
        await removeEpPickHighlighter(s.view.webContents);
        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: false, error: "no-bounds" });
        return;
      }

      const hit = await runElementHitTest(s.view.webContents, x, y, hostBoundsForHitTest(s));
      if (!hit || !hit.ok) {
        await removeEpPickHighlighter(s.view.webContents);
        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: false, error: "no-hit" });
        return;
      }

      const r = clampRectInPlace(hit.bounds, lb.width, lb.height);
      if (r.width < 4 || r.height < 4) {
        await removeEpPickHighlighter(s.view.webContents);
        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: false, error: "region-too-small" });
        return;
      }

      try {
        await removeEpPickHighlighter(s.view.webContents);
        const image = await s.view.webContents.capturePage(r);
        const buffer = image.toPNG();
        if (buffer.length === 0) {
          if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
          pending.finish({ ok: false, error: "empty-capture" });
          return;
        }

        const id = randomUUID();
        const stem = previewCaptureFileStem(s.view.webContents.getURL());
        const name = `preview-element-${stem}-${Date.now()}.png`;
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

        const capture = await buildBrowserCapturePayload(
          s.view.webContents,
          r,
          s.consoleBuffer,
          snapshotFailedRequestsForCapture(s),
          s.workspaceId,
          {
            captureKind: "element",
            selectorHint: hit.selectorHint,
            htmlExcerpt: hit.htmlExcerpt,
          },
        );

        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: true, meta, previewBytes: Uint8Array.from(buffer), capture });
      } catch {
        if (!pending.hostWin.isDestroyed()) resetIdle(pending.hostWin, s);
        pending.finish({ ok: false, error: "capture-failed" });
      }
    },
  );

  ipcMain.handle("preview:element-pick-cancel", (event): void => {
    const overlayWin = BrowserWindow.fromWebContents(event.sender);
    const parentWin = overlayWin?.getParentWindow();
    if (!overlayWin || overlayWin.isDestroyed() || !parentWin || parentWin.isDestroyed()) return;
    const s = getSession(parentWin);
    if (s.selectionOverlay?.id !== overlayWin.id) return;
    abortOverlayCapture(s, "cancelled");
  });

  ipcMain.handle(
    "preview:capture-picture-region",
    async (_event): Promise<PreviewPictureReferenceResult> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const s = getSession(win);
      if (s.overlayPending) {
        abortOverlayCapture(s, "cancelled");
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
        const cb = win.getContentBounds();
        const ov = new BrowserWindow({
          parent: win,
          modal: false,
          x: Math.round(cb.x + b.x),
          y: Math.round(cb.y + b.y),
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
        s.overlayPending = { mode: "region", finish: finishOnce, hostWin: win };
        beginOverlaySession(s, s.view!.webContents);

        ov.once("ready-to-show", () => {
          ov.show();
          ov.focus();
        });

        ov.on("closed", () => {
          s.selectionOverlay = null;
          if (s.overlayPending) {
            const pend = s.overlayPending;
            s.overlayPending = null;
            endOverlaySession(s);
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

  ipcMain.handle(
    "preview:capture-picture-element-pick",
    async (_event): Promise<PreviewPictureReferenceResult> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const s = getSession(win);
      if (s.overlayPending) {
        abortOverlayCapture(s, "cancelled");
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
        const cb = win.getContentBounds();
        const ov = new BrowserWindow({
          parent: win,
          modal: false,
          x: Math.round(cb.x + b.x),
          y: Math.round(cb.y + b.y),
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
        s.overlayPending = { mode: "element", finish: finishOnce, hostWin: win };
        beginOverlaySession(s, s.view!.webContents);

        ov.once("ready-to-show", () => {
          ov.show();
          ov.focus();
        });

        ov.on("closed", () => {
          s.selectionOverlay = null;
          if (s.overlayPending) {
            const pend = s.overlayPending;
            s.overlayPending = null;
            endOverlaySession(s);
            if (!pend.hostWin.isDestroyed()) {
              resetIdle(pend.hostWin, s);
            }
            finishOnce({ ok: false, error: "cancelled" });
          }
        });

        void (async (): Promise<void> => {
          await injectEpPickHighlighter(s.view!.webContents);
          void ov.loadURL(ELEMENT_OVERLAY_DATA_URL);
        })();
      });
    },
  );

  ipcMain.handle("preview:release-browser-capture-spill", async (_event, relPaths: unknown) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const list = Array.isArray(relPaths) ? relPaths : [];
    for (const p of list) {
      if (typeof p !== "string") continue;
      const abs = resolveValidatedSpillAbsolutePath(p);
      if (abs) await unlink(abs).catch(() => {});
    }
  });

  setTimeout(() => {
    lastGlobalSpillPruneAt = Date.now();
    void pruneStaleBrowserCaptureSpills(join(getMcodeDir(), "browser-capture-spill"));
  }, SPILL_PRUNE_STARTUP_DELAY_MS);
}
