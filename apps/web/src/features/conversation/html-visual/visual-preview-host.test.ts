// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualPreviewRequest } from "@mcode/contracts/ws/visual-preview";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { pushEmitter } from "@/transport";
import { startVisualPreviewHost } from "./visual-preview-host";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

const request: VisualPreviewRequest = {
  requestId: "8ab6eb1f-97a8-4813-b3cf-37a89670b485",
  frameDocument: "<p>chart</p>",
  width: 420,
  maxHeight: 2000,
  deadlineMs: 15_000,
};

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  useConnectionStore.getState().setStatus("connecting");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("desktop visual preview relay", () => {
  it("registers when connected, returns the desktop capture, and registers after reconnect", async () => {
    vi.stubGlobal("desktopBridge", {
      renderVisualPreview: async (input: VisualPreviewRequest) => {
        if (input.frameDocument !== "<p>chart</p>" || input.width !== 420) throw new Error("Wrong page");
        return { kind: "rendered", contentHeight: 180, console: [], png: "cG5n" };
      },
    });

    stop = startVisualPreviewHost();
    expect(mockTransport.registerVisualPreviewHost).toHaveBeenCalledTimes(0);
    useConnectionStore.getState().setStatus("connected");
    expect(mockTransport.registerVisualPreviewHost).toHaveBeenCalledTimes(1);
    pushEmitter.emit("visualPreview.request", request);

    await vi.waitFor(() => expect(mockTransport.respondToVisualPreview).toHaveBeenCalledExactlyOnceWith({
      requestId: request.requestId,
      outcome: { kind: "rendered", contentHeight: 180, console: [], png: "cG5n" },
    }));

    useConnectionStore.getState().setStatus("reconnecting");
    useConnectionStore.getState().setStatus("connected");
    expect(mockTransport.registerVisualPreviewHost).toHaveBeenCalledTimes(2);
  });

  it("returns an error outcome when the bridge rejects", async () => {
    vi.stubGlobal("desktopBridge", {
      renderVisualPreview: async () => { throw new Error("Capture unavailable"); },
    });
    useConnectionStore.getState().setStatus("connected");
    stop = startVisualPreviewHost();
    expect(mockTransport.registerVisualPreviewHost).toHaveBeenCalledTimes(1);
    pushEmitter.emit("visualPreview.request", request);
    await vi.waitFor(() => expect(mockTransport.respondToVisualPreview).toHaveBeenCalledExactlyOnceWith({
      requestId: request.requestId,
      outcome: { kind: "failed", reason: "error", message: "Capture unavailable" },
    }));
  });

  it("leaves a plain browser unregistered", () => {
    vi.stubGlobal("desktopBridge", undefined);
    useConnectionStore.getState().setStatus("connected");
    stop = startVisualPreviewHost();
    pushEmitter.emit("visualPreview.request", request);
    expect(mockTransport.registerVisualPreviewHost).toHaveBeenCalledTimes(0);
    expect(mockTransport.respondToVisualPreview).toHaveBeenCalledTimes(0);
  });
});
