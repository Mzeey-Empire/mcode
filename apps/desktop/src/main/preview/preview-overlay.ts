/**
 * Selection overlay management for region drag and element-pick capture modes.
 * Overlay BrowserWindows sit above the preview WebContentsView and intercept pointer events.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserWindow, app, ipcMain, type WebContents } from "electron";
import { type AttachmentMeta } from "@mcode/contracts";
import {
  type Bounds,
  type PreviewSession,
  getSession,
  clearIdle,
  resetIdle,
} from "./preview-session.js";
import {
  type PreviewPictureReferenceResult,
  buildBrowserCapturePayload,
  snapshotFailedRequestsForCapture,
  previewCaptureFileStem,
  clampRectInPlace,
  parseBoundsRecord,
  sanitizeSelectorHintFromGuest,
  scrubHtmlExcerptForOutbound,
} from "./preview-capture.js";

/**
 * Element-pick runs entirely inside the guest page: capture-phase event handlers block
 * the underlying page's pointer/keyboard activity, an in-page lightweight hit-test drives
 * the cyan highlight + tooltip, and a shared `window.__mcodeEpState` object queues the
 * commit point or cancellation flag for the host to drain via executeJavaScript polling.
 *
 * Why this replaces the previous transparent child BrowserWindow overlay: on Windows,
 * DWM cannot composite a transparent BrowserWindow over a WebContentsView — the overlay
 * paints opaque (black), hiding the page underneath. Injecting into the guest keeps the
 * cyan highlight visible on top of real page pixels.
 */
const EP_INJECT_JS = `(function(){
  if (window.__mcodeEpTeardown) return;
  var HL_ID = "__mcode_ep_hl", TIP_ID = "__mcode_ep_tip";
  var style = document.createElement("style");
  style.setAttribute("data-mcode-ep", "1");
  // Highlight: solid cyan rect around the picked element.
  // Tip: a small tab-style badge attached to the top-left of the rect (DevTools-style).
  // Sits flush above the rect's top border when there's room above, otherwise flips
  // inside the rect (rounded bottom corners) so it never overflows the viewport.
  style.textContent = "#__mcode_ep_hl{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;border:2px solid #22d3ee;box-sizing:border-box;z-index:2147483646;display:none;box-shadow:0 0 0 1px rgba(0,0,0,.35) inset;border-radius:2px}#__mcode_ep_tip{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;display:none;max-width:min(360px,calc(100vw - 12px));font:600 11px/1.2 ui-sans-serif,system-ui,sans-serif;color:#0f172a;background:#22d3ee;border-radius:3px 3px 0 0;padding:3px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.25)}#__mcode_ep_tip[data-flipped=\\"1\\"]{border-radius:0 0 3px 3px}html.__mcode_ep_active,html.__mcode_ep_active *{cursor:crosshair !important}";
  (document.head || document.documentElement).appendChild(style);
  var box = document.createElement("div");
  box.id = HL_ID;
  box.setAttribute("aria-hidden", "true");
  var tip = document.createElement("div");
  tip.id = TIP_ID;
  tip.setAttribute("aria-live", "polite");
  var root = document.body || document.documentElement;
  root.appendChild(box);
  root.appendChild(tip);
  try { document.documentElement.classList.add("__mcode_ep_active"); } catch (e0) {}

  // Shared state the host drains via executeJavaScript. seq increments on any state
  // change so the poll loop can detect activity without races.
  window.__mcodeEpState = { commit: null, cancelled: false, seq: 0 };
  function bump(){ try { window.__mcodeEpState.seq++; } catch (e) {} }

  function isEpNode(n){
    if (!n || n.nodeType !== 1) return false;
    if (n.id === HL_ID || n.id === TIP_ID) return true;
    return false;
  }
  function isInteractive(el){
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "a" || tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || tag === "label" || tag === "summary" || tag === "option") return true;
    var role = el.getAttribute && el.getAttribute("role");
    if (!role) return false;
    role = role.toLowerCase();
    return role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "option" || role === "checkbox" || role === "radio" || role === "switch";
  }
  function isHugeRect(r){
    var de = document.documentElement;
    var vw = Math.max(0, de.clientWidth || window.innerWidth || 0);
    var vh = Math.max(0, de.clientHeight || window.innerHeight || 0);
    if (vw < 1 || vh < 1) return false;
    return (r.width * r.height) >= (vw * vh * 0.92);
  }
  function hoverPickAt(px, py){
    var list;
    try { list = document.elementsFromPoint(px, py); } catch (e1) { list = []; }
    if (!list || !list.length) {
      try { return document.elementFromPoint(px, py); } catch (e2) { return null; }
    }
    var docEl = document.documentElement;
    var body = document.body;
    var cands = [];
    var maxScan = Math.min(list.length, 16);
    for (var i = 0; i < maxScan; i++) {
      var c = list[i];
      if (!c || c.nodeType !== 1) continue;
      if (c === docEl || c === body) continue;
      if (isEpNode(c)) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      cands.push({ el: c, area: r.width * r.height, huge: isHugeRect(r), interactive: isInteractive(c), depth: i });
    }
    var interact = cands.filter(function(c){ return c.interactive && !c.huge; });
    if (!interact.length) interact = cands.filter(function(c){ return c.interactive; });
    if (interact.length) {
      interact.sort(function(a,b){ if (a.area !== b.area) return a.area - b.area; return a.depth - b.depth; });
      return interact[0].el;
    }
    var normals = cands.filter(function(c){ return !c.huge; });
    if (normals.length) {
      normals.sort(function(a,b){ return a.area - b.area; });
      return normals[0].el;
    }
    if (cands.length) return cands[cands.length - 1].el;
    return null;
  }
  function labelFor(el){
    if (!el || !el.tagName) return "Element";
    var tag = el.tagName.toLowerCase();
    try {
      if (el.id && String(el.id).trim()) return tag + "#" + String(el.id).trim().slice(0, 48);
      var tid = el.getAttribute && el.getAttribute("data-testid");
      if (tid) return tag + "[data-testid=" + String(tid).slice(0, 48) + "]";
      var al = el.getAttribute && el.getAttribute("aria-label");
      if (al && String(al).trim()) return tag + " " + String(al).trim().slice(0, 48);
      if (typeof el.className === "string" && el.className.trim()) {
        var first = el.className.trim().split(/\\s+/)[0];
        if (first) return tag + "." + first.slice(0, 48);
      }
    } catch (e) {}
    return tag;
  }
  function paintHighlight(el){
    if (!el) { box.style.display = "none"; tip.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { box.style.display = "none"; tip.style.display = "none"; return; }
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    tip.textContent = labelFor(el);
    tip.style.display = "block";
    // Measure after content is set so flip detection uses the real tip height.
    var pad = 4;
    var vw = window.innerWidth || 1;
    var th = tip.offsetHeight || 20;
    var tw = tip.offsetWidth || 80;
    // Anchor to rect's top-left. Sit flush above the top border (DevTools tab look).
    // If there is no room above, flip inside the rect with rounded bottom corners.
    var flipped = r.top - th < pad;
    var ty = flipped ? r.top : Math.max(pad, r.top - th);
    var tx = Math.max(pad, Math.min(r.left, vw - tw - pad));
    tip.style.left = Math.round(tx) + "px";
    tip.style.top = Math.round(ty) + "px";
    if (flipped) tip.setAttribute("data-flipped", "1");
    else tip.removeAttribute("data-flipped");
  }

  var rafPending = 0;
  var lastX = 0, lastY = 0;
  function scheduleHover(){
    if (rafPending) return;
    rafPending = requestAnimationFrame(function(){
      rafPending = 0;
      var el = hoverPickAt(lastX, lastY);
      paintHighlight(el);
    });
  }

  // All listeners are capture-phase + preventDefault + stopImmediatePropagation so the
  // underlying page receives nothing. The seq bump on commit/cancel signals the host poll.
  function onMouseMove(ev){
    lastX = ev.clientX; lastY = ev.clientY;
    scheduleHover();
  }
  function onClick(ev){
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    if (window.__mcodeEpState.commit || window.__mcodeEpState.cancelled) return;
    window.__mcodeEpState.commit = { x: ev.clientX, y: ev.clientY };
    bump();
  }
  function blockEvent(ev){
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
  }
  function onKeydown(ev){
    if (ev.key === "Escape" || ev.key === "Esc") {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      if (!window.__mcodeEpState.commit) {
        window.__mcodeEpState.cancelled = true;
        bump();
      }
    } else {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    }
  }
  function onLeave(){
    if (rafPending) { cancelAnimationFrame(rafPending); rafPending = 0; }
    box.style.display = "none";
    tip.style.display = "none";
  }
  function onScroll(){ scheduleHover(); }

  var EVENTS_BLOCK = ["mousedown","mouseup","contextmenu","dblclick","auxclick","pointerdown","pointerup"];
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("mouseleave", onLeave, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);
  for (var i = 0; i < EVENTS_BLOCK.length; i++) {
    document.addEventListener(EVENTS_BLOCK[i], blockEvent, true);
  }

  window.__mcodeEpTeardown = function(){
    try {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("mouseleave", onLeave, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
      for (var j = 0; j < EVENTS_BLOCK.length; j++) {
        document.removeEventListener(EVENTS_BLOCK[j], blockEvent, true);
      }
      if (rafPending) cancelAnimationFrame(rafPending);
    } catch (e) {}
    try { document.documentElement.classList.remove("__mcode_ep_active"); } catch (e2) {}
    var h = document.getElementById(HL_ID);
    var t = document.getElementById(TIP_ID);
    if (h) h.remove();
    if (t) t.remove();
    var styles = document.querySelectorAll('style[data-mcode-ep="1"]');
    for (var k = 0; k < styles.length; k++) styles[k].remove();
    try { delete window.__mcodeEpState; } catch (e3) { window.__mcodeEpState = null; }
    try { delete window.__mcodeEpTeardown; } catch (e4) { window.__mcodeEpTeardown = null; }
  };
})()`;

const EP_REMOVE_JS = `(function(){
  if (typeof window.__mcodeEpTeardown === "function") {
    try { window.__mcodeEpTeardown(); } catch (e) {}
  } else {
    var h = document.getElementById("__mcode_ep_hl");
    var t = document.getElementById("__mcode_ep_tip");
    if (h) h.remove();
    if (t) t.remove();
    document.querySelectorAll('style[data-mcode-ep="1"]').forEach(function (n) { n.remove(); });
    try { document.documentElement.classList.remove("__mcode_ep_active"); } catch (e2) {}
  }
})()`;

/** JSON payload returned by the host poll script. */
type EpPollPayload =
  | { state: "idle"; seq: number }
  | { state: "commit"; seq: number; x: number; y: number }
  | { state: "cancelled"; seq: number }
  | { state: "gone" };

/** Polls the guest state object, returning the current commit/cancel/idle status. */
const EP_POLL_JS = `(function(){
  var st = window.__mcodeEpState;
  if (!st) return JSON.stringify({ state: "gone" });
  if (st.cancelled) return JSON.stringify({ state: "cancelled", seq: st.seq });
  if (st.commit) return JSON.stringify({ state: "commit", seq: st.seq, x: st.commit.x, y: st.commit.y });
  return JSON.stringify({ state: "idle", seq: st.seq });
})()`;

/**
 * Drag-marquee overlay: nodeIntegration is limited to this inline page string so OS-level
 * pointer events sit above the preview WebContentsView while the user draws a crop rectangle.
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

/** Result type for element hit-testing against the guest page coordinate system. */
type HitTestResult =
  | {
      ok: true;
      /** Guest viewport CSS pixels: used for capturePage and in-page highlight. */
      bounds: Bounds;
      selectorHint: string | null;
      htmlExcerpt: string | null;
    }
  | { ok: false; code: string };

/**
 * Draws the element-pick highlight inside the guest page (not the shell overlay), matching layout viewport coords.
 * Must run removeEpPickHighlighter before capturePage so the cyan frame is not in the PNG.
 */
async function injectEpPickHighlighter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(EP_INJECT_JS, true);
  } catch {
    /* guest mid-navigation */
  }
}

/**
 * Removes the element-pick highlight + capture-phase event handlers injected by
 * injectEpPickHighlighter from the guest page.
 */
export async function removeEpPickHighlighter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(EP_REMOVE_JS, true);
  } catch {
    /* already destroyed */
  }
}

/** Prefer WebContentsView bounds; shell-reported rect can lag ResizeObserver. */
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

/**
 * Executes the hit-test script in the guest and returns the validated result,
 * or null if the webContents is gone or the script throws.
 */
async function runElementHitTest(
  webContents: WebContents,
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

/**
 * Tears down only the selection overlay BrowserWindow, leaving the session state intact.
 */
export function destroySelectionOverlayOnly(s: PreviewSession): void {
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

/**
 * Removes the main-frame navigation listener registered at the start of an overlay capture.
 */
function endOverlaySession(s: PreviewSession): void {
  if (s.navigationAbortDisposable) {
    s.navigationAbortDisposable();
    s.navigationAbortDisposable = null;
  }
}

/**
 * Aborts an in-progress overlay capture, cancels the pending promise, and tears down
 * the overlay window and guest highlight.
 */
export function abortOverlayCapture(s: PreviewSession, error: string): void {
  endOverlaySession(s);
  const pending = s.overlayPending;
  s.overlayPending = null;
  if (s.elementPickPollTimer) {
    clearTimeout(s.elementPickPollTimer);
    s.elementPickPollTimer = null;
  }
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

/**
 * Attaches a did-start-navigation listener that aborts the overlay capture when the
 * main frame navigates away. Returns a disposable that removes the listener.
 */
function attachMainFrameNavigationAbort(s: PreviewSession, webContents: WebContents): () => void {
  const handler = (_event: unknown, _url: string, _isSameDocument: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) abortOverlayCapture(s, "navigated-away");
  };
  webContents.on("did-start-navigation", handler);
  return () => webContents.removeListener("did-start-navigation", handler);
}

/**
 * Starts a new overlay capture session, replacing any previous navigation abort listener.
 */
function beginOverlaySession(s: PreviewSession, webContents: WebContents): void {
  if (s.navigationAbortDisposable) {
    s.navigationAbortDisposable();
    s.navigationAbortDisposable = null;
  }
  s.navigationAbortDisposable = attachMainFrameNavigationAbort(s, webContents);
}

/**
 * Registers all overlay-related IPC handlers:
 * region-overlay-submit, region-overlay-cancel, cancel-capture,
 * capture-picture-region, capture-picture-element-pick.
 *
 * Element-pick has no dedicated IPC handlers anymore — the pick session runs entirely
 * inside the guest page via {@link EP_INJECT_JS}; the host polls `window.__mcodeEpState`
 * for commit/cancel signals.
 * Call once at app startup.
 */
export function registerOverlayHandlers(): void {
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
    // Region capture sets selectionOverlay; element-pick does not. Cancel either.
    if (!s.selectionOverlay && !s.overlayPending) return;
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

        s.overlayPending = { mode: "element", finish: finishOnce, hostWin: win };
        beginOverlaySession(s, s.view!.webContents);

        void (async (): Promise<void> => {
          await injectEpPickHighlighter(s.view!.webContents);
          schedulePoll(s, win);
        })();
      });
    },
  );
}

/**
 * Schedules the next state poll in the element-pick loop. The recursive setTimeout
 * (vs. setInterval) lets us await executeJavaScript between ticks so we never queue
 * up overlapping polls if the guest is slow.
 */
function schedulePoll(s: PreviewSession, hostWin: BrowserWindow): void {
  if (s.elementPickPollTimer) {
    clearTimeout(s.elementPickPollTimer);
  }
  s.elementPickPollTimer = setTimeout(() => {
    s.elementPickPollTimer = null;
    void runElementPickPollTick(s, hostWin);
  }, 60);
}

/**
 * Drives one tick of the element-pick poll loop: reads `window.__mcodeEpState`,
 * commits or cancels accordingly, otherwise reschedules.
 */
async function runElementPickPollTick(s: PreviewSession, hostWin: BrowserWindow): Promise<void> {
  const pending = s.overlayPending;
  if (!pending || pending.mode !== "element") return;
  if (hostWin.isDestroyed()) {
    abortOverlayCapture(s, "no-window");
    return;
  }
  if (!s.view || s.view.webContents.isDestroyed()) {
    abortOverlayCapture(s, "no-preview");
    return;
  }

  let payload: EpPollPayload | null = null;
  try {
    const raw: unknown = await s.view.webContents.executeJavaScript(EP_POLL_JS, true);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    payload = JSON.parse(text) as EpPollPayload;
  } catch {
    payload = null;
  }

  // Re-read pending after the await: an earlier tick (or external abort) may have settled it.
  if (!s.overlayPending || s.overlayPending.mode !== "element") return;

  if (!payload || payload.state === "gone") {
    // Guest reloaded / navigated. Re-inject so the next tick can resume.
    if (s.view && !s.view.webContents.isDestroyed()) {
      try {
        await s.view.webContents.executeJavaScript(EP_INJECT_JS, true);
      } catch {
        /* navigation still in flight */
      }
    }
    schedulePoll(s, hostWin);
    return;
  }

  if (payload.state === "cancelled") {
    abortOverlayCapture(s, "cancelled");
    return;
  }

  if (payload.state === "commit") {
    await finishElementPickCapture(s, payload.x, payload.y);
    return;
  }

  schedulePoll(s, hostWin);
}

/**
 * Runs the authoritative hit-test on the commit point and produces the capture payload.
 * Tears down the injected handlers before capturePage so the cyan highlight isn't burned in.
 */
async function finishElementPickCapture(
  s: PreviewSession,
  x: number,
  y: number,
): Promise<void> {
  const pending = s.overlayPending;
  if (!pending || pending.mode !== "element") return;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    abortOverlayCapture(s, "no-hit");
    return;
  }

  s.overlayPending = null;
  endOverlaySession(s);
  if (s.elementPickPollTimer) {
    clearTimeout(s.elementPickPollTimer);
    s.elementPickPollTimer = null;
  }

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
}
