// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePreviewCapture, type UsePreviewCaptureOptions } from "../usePreviewCapture";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";

// ---------------------------------------------------------------------------
// Store mocks — must be declared before the module is imported.
// ---------------------------------------------------------------------------

const mockShow = vi.fn();
const mockEnqueue = vi.fn();

vi.mock("@/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ show: mockShow }) },
}));

vi.mock("../../state/previewReferenceQueueStore", () => ({
  usePreviewReferenceQueueStore: {
    getState: () => ({ enqueuePreviewReference: mockEnqueue }),
  },
}));

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/** Minimal successful capture result. */
function makeCapturePngResult(overrides?: object) {
  return {
    ok: true as const,
    meta: {
      id: "capture-id-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      sourcePath: "/tmp/capture.png",
    },
    previewBytes: new Uint8Array([1, 2, 3]),
    capture: {} as never,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const mockPreview = {
  capturePictureReference: vi.fn(),
  capturePictureReferenceElementPick: vi.fn(),
  captureAnnotationSnapshot: vi.fn(),
  cancelCapture: vi.fn(),
};

const THREAD_ID = "thread-abc";
const defaultOptions = () => ({
  threadId: THREAD_ID,
  activeTabId: "tab-1",
  presentationActive: true,
  pushSync: vi.fn().mockResolvedValue(undefined),
  onSuccess: vi.fn(),
});

beforeEach(() => {
  window.desktopBridge = {
    preview: mockPreview,
  } as unknown as typeof window.desktopBridge;
  mockPreview.cancelCapture.mockResolvedValue(undefined);
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });

  // jsdom does not implement URL.createObjectURL
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).desktopBridge;
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usePreviewCapture", () => {
  describe("onToggleScreenshot", () => {
    it.each(["viewport", "region"] as const)(
      "syncs bounds, then attaches one %s capture and confirms that kind",
      async (captureKind) => {
        const opts = defaultOptions();
        mockPreview.capturePictureReference.mockResolvedValue(
          makeCapturePngResult({ capture: { captureKind } }),
        );
        const { result } = renderHook(() => usePreviewCapture(opts));

        await act(async () => {
          await result.current.onToggleScreenshot();
        });

        expect(opts.pushSync.mock.invocationCallOrder[0]).toBeLessThan(
          mockPreview.capturePictureReference.mock.invocationCallOrder[0],
        );
        expect(mockEnqueue).toHaveBeenCalledOnce();
        expect(mockEnqueue).toHaveBeenCalledWith(
          THREAD_ID,
          expect.objectContaining({ id: "capture-id-1", previewUrl: "blob:mock-url" }),
        );
        expect(opts.onSuccess).toHaveBeenCalledWith(captureKind);
        expect(result.current.screenshotArmed).toBe(false);
      },
    );

    it("stays armed until the overlay resolves, and a second press cancels it", async () => {
      const capture = deferred<unknown>();
      mockPreview.capturePictureReference.mockReturnValue(capture.promise);
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        void result.current.onToggleScreenshot();
      });
      expect(result.current.screenshotArmed).toBe(true);
      expect(result.current.anyCaptureActive).toBe(true);

      await act(async () => {
        await result.current.onToggleScreenshot();
      });
      expect(mockPreview.cancelCapture).toHaveBeenCalledOnce();
      expect(mockPreview.capturePictureReference).toHaveBeenCalledOnce();
      expect(result.current.screenshotArmed).toBe(false);

      await act(async () => {
        capture.resolve(makeCapturePngResult());
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("Escape before bounds sync resolves skips the overlay entirely", async () => {
      const opts = defaultOptions();
      const sync = deferred<undefined>();
      opts.pushSync.mockReturnValue(sync.promise);
      const { result } = renderHook(() => usePreviewCapture(opts));

      act(() => {
        void result.current.onToggleScreenshot();
      });
      const escape = pressEscape();
      expect(escape.defaultPrevented).toBe(true);

      await act(async () => {
        sync.resolve(undefined);
      });
      expect(mockPreview.capturePictureReference).not.toHaveBeenCalled();
      expect(mockPreview.cancelCapture).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(result.current.screenshotArmed).toBe(false);
    });

    it("Escape after the overlay arms cancels it and attaches nothing", async () => {
      const capture = deferred<unknown>();
      mockPreview.capturePictureReference.mockReturnValue(capture.promise);
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        void result.current.onToggleScreenshot();
      });
      pressEscape();
      expect(mockPreview.cancelCapture).toHaveBeenCalledOnce();

      await act(async () => {
        capture.resolve(makeCapturePngResult());
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(result.current.screenshotArmed).toBe(false);
    });

    it("leaves Escape alone when no Screenshot is open", () => {
      renderHook(() => usePreviewCapture(defaultOptions()));
      expect(pressEscape().defaultPrevented).toBe(false);
    });

    it.each([
      ["tab change", { activeTabId: "tab-2" }],
      ["thread change", { threadId: "thread-other" }],
      ["preview hidden", { presentationActive: false }],
    ] as const)("%s mid-capture cancels and drops the late result", async (_label, change) => {
      const opts = defaultOptions();
      const capture = deferred<unknown>();
      mockPreview.capturePictureReference.mockReturnValue(capture.promise);
      const { result, rerender } = renderHook(
        (props: UsePreviewCaptureOptions) => usePreviewCapture(props),
        { initialProps: opts },
      );

      await act(async () => {
        void result.current.onToggleScreenshot();
      });
      rerender({ ...opts, ...change });
      expect(mockPreview.cancelCapture).toHaveBeenCalledOnce();
      expect(result.current.screenshotArmed).toBe(false);

      await act(async () => {
        capture.resolve(makeCapturePngResult());
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(opts.onSuccess).not.toHaveBeenCalled();
    });

    it("unmount mid-capture cancels the overlay and drops the late result", async () => {
      const capture = deferred<unknown>();
      mockPreview.capturePictureReference.mockReturnValue(capture.promise);
      const { result, unmount } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        void result.current.onToggleScreenshot();
      });
      unmount();
      expect(mockPreview.cancelCapture).toHaveBeenCalledOnce();

      await act(async () => {
        capture.resolve(makeCapturePngResult());
      });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("two presses in one tick start a single request", async () => {
      const opts = defaultOptions();
      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        void result.current.onToggleScreenshot();
        void result.current.onToggleScreenshot();
      });

      expect(opts.pushSync).toHaveBeenCalledOnce();
      expect(mockPreview.capturePictureReference).not.toHaveBeenCalled();
      expect(result.current.screenshotArmed).toBe(false);
    });

    it("does not arm while the preview is hidden", async () => {
      const opts = { ...defaultOptions(), presentationActive: false };
      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.onToggleScreenshot();
      });

      expect(opts.pushSync).not.toHaveBeenCalled();
      expect(result.current.screenshotArmed).toBe(false);
    });

    it("stays silent when the user cancels in the overlay", async () => {
      mockPreview.capturePictureReference.mockResolvedValue({ ok: false, error: "cancelled" });
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onToggleScreenshot();
      });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("shows a failure toast for capture-failed", async () => {
      mockPreview.capturePictureReference.mockResolvedValue({ ok: false, error: "capture-failed" });
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onToggleScreenshot();
      });

      expect(mockShow).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "failed", meta: "Screenshot failed." }),
      );
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(result.current.screenshotArmed).toBe(false);
    });

    it("shows a failure toast and disarms when the bridge throws", async () => {
      mockPreview.capturePictureReference.mockRejectedValue(new Error("ipc down"));
      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onToggleScreenshot();
      });

      expect(mockShow).toHaveBeenCalledOnce();
      expect(result.current.screenshotArmed).toBe(false);
    });
  });


  // -------------------------------------------------------------------------
  // captureAnnotationSnapshot
  // -------------------------------------------------------------------------

  describe("captureAnnotationSnapshot", () => {
    const overlay = {
      activeDisplayNumber: 2,
      activeBounds: { x: 40, y: 50, width: 120, height: 32 },
      markers: [
        { displayNumber: 1, bounds: { x: 10, y: 12, width: 80, height: 24 } },
        { displayNumber: 2, bounds: { x: 40, y: 50, width: 120, height: 32 } },
      ],
    };

    const capture = {
      schemaVersion: 2 as const,
      pageUrl: "https://example.com",
      pageTitle: "Example",
      capturedAt: "2026-07-02T00:00:00.000Z",
      captureKind: "viewport" as const,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };

    it("calls pushSync(true) before captureAnnotationSnapshot", async () => {
      const opts = defaultOptions();
      mockPreview.captureAnnotationSnapshot.mockResolvedValue(
        makeCapturePngResult({ capture }),
      );

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.captureAnnotationSnapshot(overlay);
      });

      expect(opts.pushSync).toHaveBeenCalledWith(true);
      expect(mockPreview.captureAnnotationSnapshot).toHaveBeenCalledWith(overlay);
      const pushOrder = opts.pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.captureAnnotationSnapshot.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("returns snapshot metadata from the annotated capture result", async () => {
      mockPreview.captureAnnotationSnapshot.mockResolvedValue(
        makeCapturePngResult({ capture }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));
      let snapshot: Awaited<ReturnType<typeof result.current.captureAnnotationSnapshot>> = null;

      await act(async () => {
        snapshot = await result.current.captureAnnotationSnapshot(overlay);
      });

      expect(snapshot).toEqual({
        id: "capture-id-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        sourcePath: "/tmp/capture.png",
        capture,
      });
    });
  });

  // -------------------------------------------------------------------------
  // onAddElementPickPictureReference
  // -------------------------------------------------------------------------

  describe("onAddElementPickPictureReference", () => {
    it("calls pushSync(true) before capturePictureReferenceElementPick", async () => {
      const opts = defaultOptions();
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(opts));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(opts.pushSync).toHaveBeenCalledWith(true);
      const pushOrder = opts.pushSync.mock.invocationCallOrder[0];
      const captureOrder = mockPreview.capturePictureReferenceElementPick.mock.invocationCallOrder[0];
      expect(pushOrder).toBeLessThan(captureOrder);
    });

    it("enqueues the attachment on success", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(mockEnqueue).toHaveBeenCalledOnce();
    });

    it("shows a toast on non-silent error", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue({
        ok: false,
        error: "no-hit",
      });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(mockShow).toHaveBeenCalledOnce();
    });

    it("does NOT show a toast for silent error 'cancelled'", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue({ ok: false, error: "cancelled" });

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(mockShow).not.toHaveBeenCalled();
    });

    it("resets elementPickBusy to false after completion", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(makeCapturePngResult());

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementPickPictureReference();
      });

      expect(result.current.elementPickBusy).toBe(false);
    });
  });

  describe("onAddElementAnnotation", () => {
    it("stores selected element style details on the draft", async () => {
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(
        makeCapturePngResult({
          capture: {
            schemaVersion: 2,
            pageUrl: "https://example.com/products#details",
            pageTitle: "Products",
            capturedAt: "2026-07-01T00:00:00.000Z",
            captureKind: "element",
            selectorHint: "button.buy",
            bounds: { x: 10, y: 20, width: 120, height: 40 },
            elementStyle: {
              textColor: "rgb(255, 255, 255)",
              background: "rgb(10, 52, 92)",
              opacity: 0.75,
              font: "Inter, sans-serif",
              fontSize: "14px",
            },
          },
        }),
      );

      const { result } = renderHook(() => usePreviewCapture(defaultOptions()));

      await act(async () => {
        await result.current.onAddElementAnnotation();
      });

      expect(usePreviewAnnotationStore.getState().drafts[THREAD_ID]).toMatchObject({
        pageIdentity: "https://example.com/products",
        selectorHint: "button.buy",
        elementStyle: {
          textColor: "rgb(255, 255, 255)",
          background: "rgb(10, 52, 92)",
          opacity: 0.75,
          font: "Inter, sans-serif",
          fontSize: "14px",
        },
      });
    });

    it("rejects v1 captures so annotation drafts retain v2 context only", async () => {
      const onSuccess = vi.fn();
      mockPreview.capturePictureReferenceElementPick.mockResolvedValue(
        makeCapturePngResult({
          capture: {
            schemaVersion: 1,
            pageUrl: "https://example.com/products",
            pageTitle: "Products",
            capturedAt: "2026-07-01T00:00:00.000Z",
            captureKind: "element",
            bounds: { x: 10, y: 20, width: 120, height: 40 },
          },
        }),
      );

      const { result } = renderHook(() => usePreviewCapture({ ...defaultOptions(), onSuccess }));
      let outcome: { ok: boolean } | undefined;

      await act(async () => {
        outcome = await result.current.onAddElementAnnotation();
      });

      expect(outcome).toEqual({ ok: false });
      expect(usePreviewAnnotationStore.getState().drafts[THREAD_ID]).toBeUndefined();
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });
});
