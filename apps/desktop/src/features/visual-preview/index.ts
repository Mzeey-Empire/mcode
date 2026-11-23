import { BrowserWindow, ipcMain, session, type NativeImage } from "electron";
import { HTML_VISUAL_MIN_HEIGHT } from "@mcode/contracts/models/html-visual";
import {
  VISUAL_PREVIEW_QUEUE_LIMIT_MS,
  type VisualPreviewOutcome,
  type VisualPreviewRequest,
} from "@mcode/contracts/ws/visual-preview";
import { HTML_VISUAL_HEIGHT_MESSAGE, htmlVisualFrameHeight } from "@mcode/shared/html-visual-document";
import { parseVisualPreviewRequest, VisualPreviewConsole, visualPreviewConsoleEntry } from "./preview-input.js";

const PARTITION = "mcode-visual-preview";
const AFTER_PAINT = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))";
const MIN_AFTER_LOAD_MS = 1_000;
const HEIGHT_STABLE_MS = 300;
const MAX_AFTER_LOAD_MS = 5_000;
// Mirrors SCREENSHOT_BINARY_LIMIT in preview/automation/kernel.ts.
const SCREENSHOT_BINARY_LIMIT = 360 * 1_024;
const SCREENSHOT_MAX_WIDTH = 1_280;
const SCREENSHOT_MIN_RESIZE_WIDTH = 320;
const SCREENSHOT_SHRINK_FACTOR = 0.75;
const TIMEOUT = {
  kind: "failed", reason: "timeout", message: "The preview rendering deadline elapsed.",
} satisfies VisualPreviewOutcome;
const BUSY = {
  kind: "failed", reason: "busy", message: "The desktop preview queue wait limit elapsed.",
} satisfies VisualPreviewOutcome;
const OWNER_CLOSED = {
  kind: "failed", reason: "error", message: "The desktop window closed.",
} satisfies VisualPreviewOutcome;
type StoppedPreview = typeof TIMEOUT | typeof BUSY | typeof OWNER_CLOSED;
const previewWindows = new WeakSet<BrowserWindow>();

/** Identifies offscreen windows that should not count as open desktop windows. */
export function isVisualPreviewWindow(window: BrowserWindow): boolean {
  return previewWindows.has(window);
}

function hostScript({ frameDocument, maxHeight }: VisualPreviewRequest): string {
  return `new Promise(resolve => {
    document.documentElement.style.margin = document.body.style.margin = "0";
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-scripts";
    frame.referrerPolicy = "no-referrer";
    frame.style.cssText = "width:100%;display:block;border:0;height:${HTML_VISUAL_MIN_HEIGHT}px";

    let loadedAt;
    let height;
    let heightChangedAt;
    let timer;
    function settle() {
      clearTimeout(timer);
      if (loadedAt === undefined || height === undefined) return;
      const stableAt = heightChangedAt + ${HEIGHT_STABLE_MS};
      const deadline = loadedAt + ${MAX_AFTER_LOAD_MS};
      const captureAt = Math.min(deadline, Math.max(loadedAt + ${MIN_AFTER_LOAD_MS}, stableAt));
      const remaining = captureAt - performance.now();
      if (remaining > 0) {
        timer = setTimeout(settle, Math.ceil(remaining));
        return;
      }
      removeEventListener("message", onHeight);
      resolve({ contentHeight: height, heightStillChanging: stableAt > deadline });
    }

    frame.addEventListener("load", () => {
      loadedAt = performance.now();
      settle();
    }, { once: true });
    function onHeight(event) {
      const data = event.data;
      if (event.source !== frame.contentWindow || typeof data !== "object" || data === null) return;
      if (data.type !== "${HTML_VISUAL_HEIGHT_MESSAGE}" || !Number.isFinite(data.height) || data.height < 0) return;
      if (data.height === height) return;
      height = data.height;
      heightChangedAt = performance.now();
      const frameHeight = Math.min(${maxHeight}, Math.max(${HTML_VISUAL_MIN_HEIGHT}, Math.ceil(height)));
      frame.style.height = frameHeight + "px";
      settle();
    }
    addEventListener("message", onHeight);

    frame.srcdoc = ${JSON.stringify(frameDocument)};
    document.body.append(frame);
  })`;
}

function createPreviewWindow(width: number): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    useContentSize: true,
    width,
    height: HTML_VISUAL_MIN_HEIGHT,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  previewWindows.add(window);
  return window;
}

function encodeScreenshot(image: NativeImage, cssWidth: number): string | undefined {
  if (image.isEmpty()) throw new Error("The visual capture returned an empty image.");
  const maxWidth = Math.min(cssWidth, SCREENSHOT_MAX_WIDTH);
  if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth, quality: "better" });
  let png = image.toPNG();
  while (png.byteLength > SCREENSHOT_BINARY_LIMIT && image.getSize().width > SCREENSHOT_MIN_RESIZE_WIDTH) {
    const width = Math.max(SCREENSHOT_MIN_RESIZE_WIDTH, Math.floor(image.getSize().width * SCREENSHOT_SHRINK_FACTOR));
    image = image.resize({ width, quality: "better" });
    png = image.toPNG();
  }
  if (png.byteLength > SCREENSHOT_BINARY_LIMIT) return undefined;
  return png.toString("base64");
}

function readMeasurement(result: unknown) {
  if (typeof result !== "object" || result === null
    || !("contentHeight" in result) || typeof result.contentHeight !== "number"
    || !Number.isFinite(result.contentHeight) || result.contentHeight < 0
    || !("heightStillChanging" in result) || typeof result.heightStillChanging !== "boolean") {
    throw new Error("Could not measure the visual's content height.");
  }
  return { contentHeight: result.contentHeight, heightStillChanging: result.heightStillChanging };
}

async function capture(win: BrowserWindow, request: VisualPreviewRequest): Promise<VisualPreviewOutcome> {
  const diagnostics = new VisualPreviewConsole();
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("console-message", ({ level, message, lineNumber, frame }) => {
    // The blank host page logs Electron's own diagnostics, which say nothing about the agent's page.
    if (frame === contents.mainFrame) return;
    diagnostics.add(visualPreviewConsoleEntry(level, message, lineNumber));
  });
  await win.loadURL("about:blank");
  // Allow the initial srcdoc load while blocking the page's subsequent navigation.
  let loadingFrame = true;
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && event.url === "about:srcdoc" && loadingFrame) {
      loadingFrame = false;
      return;
    }
    event.preventDefault();
  });
  const { contentHeight, heightStillChanging } = readMeasurement(await contents.executeJavaScript(hostScript(request)));
  const frameHeight = htmlVisualFrameHeight(contentHeight, request.maxHeight);
  win.setContentSize(request.width, frameHeight);
  await contents.executeJavaScript(AFTER_PAINT);
  const png = encodeScreenshot(await contents.capturePage(), request.width);
  return {
    kind: "rendered", contentHeight, heightStillChanging, console: [...diagnostics.entries],
    droppedConsoleEntries: diagnostics.dropped, ...(png === undefined ? {} : { png }),
  };
}

async function render(
  request: VisualPreviewRequest, stopped: Promise<StoppedPreview>,
): Promise<VisualPreviewOutcome> {
  let win: BrowserWindow | undefined;
  try {
    win = createPreviewWindow(request.width);
    return await Promise.race([capture(win, request), stopped]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: "error", message: message.slice(0, 2000) };
  } finally {
    if (win) await closePreviewWindow(win);
  }
}

// destroy() leaves the partition's offscreen renderer unable to load the next preview window, so close and wait.
function closePreviewWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    win.once("closed", () => resolve());
    win.close();
  });
}

function configurePreviewSession(): void {
  const previewSession = session.fromPartition(PARTITION);
  previewSession.webRequest.onBeforeRequest(({ url }, callback) => {
    callback({ cancel: !url.startsWith("data:") && !url.startsWith("about:") && !url.startsWith("blob:") });
  });
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.on("will-download", (event) => event.preventDefault());
}

/** Registers the isolated desktop renderer and serializes preview windows. */
export function registerVisualPreviewHandlers(): void {
  configurePreviewSession();
  const ownerSignals = new WeakMap<BrowserWindow, AbortSignal>();
  let queue = Promise.resolve();
  ipcMain.handle("visual-preview:render", async (event, input: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("The desktop preview sender is unavailable.");
    }

    const request = parseVisualPreviewRequest(input);
    let ownerSignal = ownerSignals.get(owner);
    if (!ownerSignal) {
      const controller = new AbortController();
      ownerSignal = controller.signal;
      ownerSignals.set(owner, ownerSignal);
      owner.once("closed", () => controller.abort());
    }
    let stop: (outcome: StoppedPreview) => void;
    const stopped = new Promise<StoppedPreview>((resolve) => { stop = resolve; });
    const onOwnerClosed = () => stop(OWNER_CLOSED);
    ownerSignal.addEventListener("abort", onOwnerClosed, { once: true });
    const queueDeadline = performance.now() + VISUAL_PREVIEW_QUEUE_LIMIT_MS;
    let queueExpired = false;
    let timer = setTimeout(() => {
      queueExpired = true;
      stop(BUSY);
    }, VISUAL_PREVIEW_QUEUE_LIMIT_MS);
    const job = queue.then(() => {
      if (ownerSignal.aborted) return OWNER_CLOSED;
      if (queueExpired || performance.now() >= queueDeadline) return BUSY;
      clearTimeout(timer);
      timer = setTimeout(() => stop(TIMEOUT), request.deadlineMs);
      return render(request, stopped);
    });
    queue = job.then(() => undefined, () => undefined);
    try {
      return await Promise.race([job, stopped]);
    } finally {
      clearTimeout(timer);
      ownerSignal.removeEventListener("abort", onOwnerClosed);
    }
  });
}
