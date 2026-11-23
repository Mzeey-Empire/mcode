import * as NodeCrypto from "node:crypto";
import { HTML_VISUAL_MAX_HEIGHT } from "@mcode/contracts/models/html-visual";
import {
  VISUAL_PREVIEW_QUEUE_LIMIT_MS,
  visualPreviewConsolePriority,
  type VisualPreviewOutcome,
  type VisualPreviewRequest,
  type VisualPreviewResponse,
} from "@mcode/contracts/ws/visual-preview";
import {
  buildHtmlVisualDocument,
  HTML_VISUAL_DEFAULT_THEMES,
  htmlVisualFrameHeight,
  type HtmlVisualAppearance,
} from "@mcode/shared/html-visual-document";
import type { WebSocket } from "ws";
import type { BrowserAutomationHostConnectionAuthorization } from "../../browser-automation/index.js";

/** The inlined page and viewport to render for one tool call. */
export interface HtmlPreviewRequest {
  readonly html: string;
  readonly width: number;
  readonly appearance: HtmlVisualAppearance;
  readonly signal: AbortSignal;
}

/** Console and browser diagnostic levels reported to the agent. */
export type HtmlPreviewConsoleLevel = "log" | "info" | "warning" | "error";

/** One diagnostic, with an optional one-based location in the visual's HTML. */
export interface HtmlPreviewConsoleEntry {
  readonly level: HtmlPreviewConsoleLevel;
  readonly text: string;
  readonly line?: number;
}

/** Measured content, diagnostics and an optional PNG of the clamped frame. */
export interface HtmlPreview {
  readonly width: number;
  readonly contentHeight: number;
  readonly frameHeight: number;
  readonly console: readonly HtmlPreviewConsoleEntry[];
  readonly screenshot?: { readonly data: string };
}

/** Headless rendering boundary for the Visuals toolkit. */
export interface HtmlPreviewRenderer {
  render(request: HtmlPreviewRequest): Promise<HtmlPreview>;
}

/** The desktop host is unavailable and the message explains how to recover. */
export class HtmlPreviewUnavailableError extends Error {}

const MAX_CONSOLE_ENTRIES = 50;
const MAX_CONSOLE_TEXT_LENGTH = 2000;
const RENDER_DEADLINE_MS = 15_000;
const REPLY_GRACE_MS = 5_000;
const REPLY_DEADLINE_MS = VISUAL_PREVIEW_QUEUE_LIMIT_MS + RENDER_DEADLINE_MS + REPLY_GRACE_MS;

type DirectedSender = (socket: WebSocket, channel: "visualPreview.request", request: VisualPreviewRequest) => boolean;

interface Pending {
  readonly socket: WebSocket;
  resolve(outcome: VisualPreviewOutcome): void;
  reject(reason: unknown): void;
}

function desktopStoppedResponding(): HtmlPreviewUnavailableError {
  return new HtmlPreviewUnavailableError("The Mcode desktop app stopped responding to html_preview. Check that it is open, then retry.");
}

function toPreview(request: HtmlPreviewRequest, outcome: VisualPreviewOutcome): HtmlPreview {
  if (outcome.kind === "failed") {
    if (outcome.reason === "timeout") {
      throw new Error(`The page did not finish rendering within ${RENDER_DEADLINE_MS / 1000} seconds. A script may loop forever or wait on something that never happens.`);
    }
    if (outcome.reason === "busy") {
      throw new HtmlPreviewUnavailableError("The Mcode desktop app is busy rendering other previews. Retry in a few seconds.");
    }
    throw new Error(`The desktop app could not render the page: ${outcome.message}`);
  }

  // The bootstrap adds no line breaks, so Electron's line numbers are already page-relative.
  const console: HtmlPreviewConsoleEntry[] = outcome.console
    .map((entry, index) => ({ entry, index, priority: visualPreviewConsolePriority(entry) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_CONSOLE_ENTRIES)
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => ({ ...entry, text: entry.text.slice(0, MAX_CONSOLE_TEXT_LENGTH) }));
  const dropped = outcome.droppedConsoleEntries + outcome.console.length - console.length;
  const { width } = request;
  const contentHeight = Math.ceil(outcome.contentHeight);
  const frameHeight = htmlVisualFrameHeight(contentHeight, HTML_VISUAL_MAX_HEIGHT);
  if (outcome.heightStillChanging) {
    console.push({ level: "warning", text: `The page height was still changing 5 seconds after load; captured at ${frameHeight}px.` });
  }
  const screenshot = outcome.png === undefined ? undefined : { data: outcome.png };
  if (!screenshot) {
    console.push({ level: "info", text: "The screenshot did not fit the image size limit, so it was left out." });
  }
  if (dropped > 0) console.push({ level: "info", text: `Dropped ${dropped} additional console entries.` });
  return { width, contentHeight, frameHeight, console, ...(screenshot ? { screenshot } : {}) };
}

/** Routes HTML render requests to the latest open desktop host and correlates its replies. */
export class DesktopHtmlPreviewRenderer implements HtmlPreviewRenderer {
  private readonly hosts = new Set<WebSocket>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly send: DirectedSender) {}

  /** Registers an authenticated connection using the same authorization as the Browser host. */
  registerHost(socket: WebSocket, authorization?: BrowserAutomationHostConnectionAuthorization | null): void {
    if (!authorization) throw new Error("HTML preview host registration requires the same authenticated-connection authorization as the Browser host.");
    if (socket.readyState !== socket.OPEN) throw desktopStoppedResponding();
    this.hosts.delete(socket);
    this.hosts.add(socket);
  }

  /** Rejects outstanding renders owned by a closed desktop connection. */
  disconnect(socket: WebSocket): void {
    this.hosts.delete(socket);
    for (const pending of this.pending.values()) {
      if (pending.socket === socket) pending.reject(desktopStoppedResponding());
    }
  }

  /** Settles the request only when its intended recipient responds. */
  respond(socket: WebSocket, { requestId, outcome }: VisualPreviewResponse): void {
    const pending = this.pending.get(requestId);
    if (pending?.socket === socket) pending.resolve(outcome);
  }

  /** Renders an inlined page via the most recently registered open desktop host. */
  async render(request: HtmlPreviewRequest): Promise<HtmlPreview> {
    request.signal.throwIfAborted();
    const socket = [...this.hosts].reverse().find((host) => host.readyState === host.OPEN);
    if (!socket) {
      throw new HtmlPreviewUnavailableError("html_preview renders in the Mcode desktop app, and no desktop app is connected to this server. Open Mcode desktop, then retry.");
    }
    const frameDocument = buildHtmlVisualDocument(request.html, HTML_VISUAL_DEFAULT_THEMES[request.appearance]);
    const outcome = await this.requestPreview(socket, {
      requestId: NodeCrypto.randomUUID(),
      frameDocument,
      width: request.width,
      maxHeight: HTML_VISUAL_MAX_HEIGHT,
      deadlineMs: RENDER_DEADLINE_MS,
    }, request.signal);
    return toPreview(request, outcome);
  }

  private requestPreview(socket: WebSocket, request: VisualPreviewRequest, signal: AbortSignal): Promise<VisualPreviewOutcome> {
    const { requestId } = request;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (!this.pending.delete(requestId)) return false;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        return true;
      };
      const pending: Pending = {
        socket,
        resolve(outcome) {
          if (cleanup()) resolve(outcome);
        },
        reject(reason) {
          if (cleanup()) reject(reason);
        },
      };
      const abort = () => pending.reject(signal.reason);
      const timer = setTimeout(() => pending.reject(desktopStoppedResponding()), REPLY_DEADLINE_MS);
      this.pending.set(requestId, pending);
      signal.addEventListener("abort", abort, { once: true });

      try {
        if (!this.send(socket, "visualPreview.request", request)) pending.reject(desktopStoppedResponding());
      } catch (error) {
        pending.reject(error);
      }
    });
  }
}
