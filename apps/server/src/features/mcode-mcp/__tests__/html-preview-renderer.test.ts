import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  DesktopHtmlPreviewRenderer, HtmlPreviewUnavailableError, type HtmlPreviewRequest,
} from "../toolkits/html-preview-renderer.js";

const authorization = { desktopInstanceId: "desktop", worktreeIdentity: "worktree", allowedWorkspaceIds: [] };
const html = "<script>\n\nthrow new Error('missing data');\n</script>";
const request: HtmlPreviewRequest = {
  html, width: 420, appearance: "light", signal: new AbortController().signal,
};

function fakeSocket() {
  return { readyState: 1, OPEN: 1 } as unknown as WebSocket;
}

function setup() {
  const send = vi.fn<ConstructorParameters<typeof DesktopHtmlPreviewRenderer>[0]>(() => true);
  const renderer = new DesktopHtmlPreviewRenderer(send);
  const host = fakeSocket();
  renderer.registerHost(host, authorization);
  function sentRequest() {
    expect(send.mock.calls).toHaveLength(1);
    const [socket, channel, dispatch] = send.mock.calls[0]!;
    expect(channel).toBe("visualPreview.request");
    return { socket, dispatch };
  }
  return { renderer, host, send, sentRequest };
}

const rendered = {
  kind: "rendered", contentHeight: 2114.25, heightStillChanging: false,
  console: [], droppedConsoleEntries: 0, png: "cG5n",
} satisfies Parameters<DesktopHtmlPreviewRenderer["respond"]>[1]["outcome"];

afterEach(() => vi.useRealTimers());

describe("desktop HTML previews", () => {
  it("tells the agent to open desktop when there is no host", async () => {
    const send = vi.fn();
    const renderer = new DesktopHtmlPreviewRenderer(send);
    const preview = renderer.render(request);
    await expect(preview).rejects.toBeInstanceOf(HtmlPreviewUnavailableError);
    await expect(preview).rejects.toThrow("Open Mcode desktop, then retry");
    expect(send).toHaveBeenCalledTimes(0);
  });

  it.each([null, undefined])("refuses registration without authorization (%s)", async (missing) => {
    const renderer = new DesktopHtmlPreviewRenderer(() => true);
    expect(() => renderer.registerHost(fakeSocket(), missing)).toThrow(/authorization/);
    await expect(renderer.render(request)).rejects.toBeInstanceOf(HtmlPreviewUnavailableError);
  });

  it("directs the framed page only to the newest open host and maps the capture", async () => {
    const { renderer, sentRequest } = setup();
    const newestOpen = fakeSocket();
    const closing = fakeSocket();
    renderer.registerHost(newestOpen, authorization);
    renderer.registerHost(closing, authorization);
    Object.defineProperty(closing, "readyState", { value: 2 });

    const preview = renderer.render(request);
    const { socket, dispatch } = sentRequest();
    expect(socket).toBe(newestOpen);
    expect(dispatch).toMatchObject({ width: 420, maxHeight: 2000, deadlineMs: 15_000 });
    const line = dispatch.frameDocument.split("\n").findIndex((text) => text.includes("missing data")) + 1;
    renderer.respond(newestOpen, {
      requestId: dispatch.requestId,
      outcome: { ...rendered, console: [
        { level: "error", text: "Uncaught Error: missing data", line },
        { level: "warning", text: "bootstrap warning", line: 1 },
      ] },
    });
    await expect(preview).resolves.toEqual({
      contentHeight: 2115, frameHeight: 2000, width: 420,
      screenshot: { data: "cG5n" },
      console: [{ level: "error", text: "Uncaught Error: missing data", line: 3 }, { level: "warning", text: "bootstrap warning", line: 1 }],
    });
  });

  it("preserves the source line of an error on a one-line page", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render({ ...request, html: "<!doctype html><script>throw new Error('broken chart')</script>" });
    const { requestId } = sentRequest().dispatch;
    const error = { level: "error", text: "Uncaught Error: broken chart", line: 1 } as const;
    renderer.respond(host, { requestId, outcome: { ...rendered, console: [error] } });
    await expect(preview).resolves.toMatchObject({ console: [error] });
  });

  it("keeps a late error in page order and counts drops at both limits", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render(request);
    const logs = Array.from({ length: 60 }, (_, index) => ({ level: "log" as const, text: `Log ${index + 1}` }));
    const error = { level: "error", text: "Uncaught Error: broken chart", line: 3 } as const;
    renderer.respond(host, {
      requestId: sentRequest().dispatch.requestId,
      outcome: { ...rendered, console: [...logs, error], droppedConsoleEntries: 2 },
    });
    const { console } = await preview;
    expect(console).toEqual([...logs.slice(0, 49), error, { level: "info", text: "Dropped 13 additional console entries." }]);
  });

  it("keeps an uncaught exception and height warning after 60 plain errors, even without a PNG", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render(request);
    const errors = Array.from({ length: 60 }, (_, index) => ({ level: "error" as const, text: `Error ${index + 1}` }));
    const exception = { level: "error", text: "Uncaught Error: broken chart", line: 3 } as const;
    renderer.respond(host, {
      requestId: sentRequest().dispatch.requestId,
      outcome: {
        kind: "rendered", contentHeight: 2114.25, heightStillChanging: true,
        console: [...errors, exception], droppedConsoleEntries: 2,
      },
    });
    const result = await preview;
    expect(result.console.slice(49)).toEqual([
      exception,
      { level: "warning", text: "The page height was still changing 5 seconds after load; captured at 2000px." },
      { level: "info", text: "The screenshot did not fit the image size limit, so it was left out." },
      { level: "info", text: "Dropped 13 additional console entries." },
    ]);
    expect(result.console.slice(0, 49)).toEqual(errors.slice(0, 49));
    expect(result).toMatchObject({ width: 420, contentHeight: 2115, frameHeight: 2000 });
    expect(result).not.toHaveProperty("screenshot");
  });

  it("truncates diagnostics and reports the number omitted", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render(request);
    const { requestId } = sentRequest().dispatch;
    renderer.respond(host, { requestId, outcome: { ...rendered, console: Array.from({ length: 53 }, () => ({
      level: "log", text: "x".repeat(2001),
    })) } });
    const { console } = await preview;
    expect(console).toHaveLength(51);
    expect(console[0]?.text).toHaveLength(2000);
    expect(console[50]).toEqual({ level: "info", text: "Dropped 3 additional console entries." });
  });

  it("ignores other sockets and unknown request ids", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render(request);
    const { requestId } = sentRequest().dispatch;
    renderer.respond(fakeSocket(), { requestId, outcome: { ...rendered, contentHeight: 100 } });
    renderer.respond(host, { requestId: NodeCrypto.randomUUID(), outcome: { ...rendered, contentHeight: 200 } });
    renderer.respond(host, { requestId, outcome: rendered });
    await expect(preview).resolves.toMatchObject({ contentHeight: 2115 });
  });

  it.each(["disconnect", "timeout"] as const)("rejects and clears a pending request on %s", async (reason) => {
    vi.useFakeTimers();
    const { renderer, host } = setup();
    const preview = renderer.render(request);
    const rejection = expect(preview).rejects.toBeInstanceOf(HtmlPreviewUnavailableError);
    if (reason === "disconnect") renderer.disconnect(host);
    else {
      await vi.advanceTimersByTimeAsync(24_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    await rejection;
    expect(renderer).toHaveProperty("pending.size", 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and clears a pending request on abort", async () => {
    vi.useFakeTimers();
    const { renderer } = setup();
    const controller = new AbortController();
    const preview = renderer.render({ ...request, signal: controller.signal });
    const stopped = new Error("stop preview");
    controller.abort(stopped);
    await expect(preview).rejects.toBe(stopped);
    expect(renderer).toHaveProperty("pending.size", 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a desktop render timeout as a page error", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render(request);
    renderer.respond(host, {
      requestId: sentRequest().dispatch.requestId,
      outcome: { kind: "failed", reason: "timeout", message: "render expired" },
    });
    await expect(preview).rejects.toThrow("The page did not finish rendering within 15 seconds");
    await expect(preview).rejects.not.toBeInstanceOf(HtmlPreviewUnavailableError);
  });

  it("tells the agent to retry when the desktop preview queue is busy", async () => {
    const { renderer, host, sentRequest } = setup();
    const preview = renderer.render(request);
    renderer.respond(host, {
      requestId: sentRequest().dispatch.requestId,
      outcome: { kind: "failed", reason: "busy", message: "Queue wait expired" },
    });
    await expect(preview).rejects.toBeInstanceOf(HtmlPreviewUnavailableError);
    await expect(preview).rejects.toThrow("The Mcode desktop app is busy rendering other previews. Retry in a few seconds.");
  });
});
