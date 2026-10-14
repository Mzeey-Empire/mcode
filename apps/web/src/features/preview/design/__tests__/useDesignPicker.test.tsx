import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useRef, useState } from "react";
import { useDesignPicker } from "../useDesignPicker";
import { useAnnotationBubbleEditor } from "../annotationBubble";
import type { VisualLinkPairId, ColorVisualProposalKey } from "../visualProposalModel";
import type { ColorFormat } from "../visualProposalColor";
import { usePreviewCapture } from "../../capture/usePreviewCapture";
import { usePreviewDesignModeStore } from "../../state/previewDesignModeStore";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";

vi.mock("@/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ show: vi.fn() }) },
}));

const THREAD_ID = "thread-design";

const mockPreview = {
  capturePictureReferenceElementPick: vi.fn(),
  cancelCapture: vi.fn().mockResolvedValue(undefined),
  design: { setAnnotationGuard: vi.fn().mockResolvedValue(undefined) },
};

const pushSync = vi.fn().mockResolvedValue(undefined);
const dismissBubbleSlash = vi.fn();
const dismissBubbleFile = vi.fn();

/**
 * Composes the real capture hook and the real picker the way PreviewPanel
 * does: `capture` is passed straight through, so its identity changes on
 * every render, including the renders caused by its own busy flags.
 */
function useDesignPickerHarness(): void {
  const capture = usePreviewCapture({
    threadId: THREAD_ID,
    activeTabId: "tab-1",
    presentationActive: true,
    pushSync,
  });
  const designPickerPhase = usePreviewDesignModeStore((s) => s.getPicker(THREAD_ID).phase);
  const designPickerArmId = usePreviewDesignModeStore((s) => s.getPicker(THREAD_ID).armId);
  const designPickerDispatch = usePreviewDesignModeStore((s) => s.dispatch);
  const hasOpenBubble = usePreviewAnnotationStore((s) => Boolean(s.drafts[THREAD_ID]));
  const editor = useAnnotationBubbleEditor(undefined, undefined);
  const [, setEditingAnnotationId] = useState<string | null>(null);
  const [linkedVisualPairs, setLinkedVisualPairs] = useState<
    Partial<Record<VisualLinkPairId, boolean>>
  >({});
  const [, setColorFormats] = useState<Partial<Record<ColorVisualProposalKey, ColorFormat>>>({});
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleNoteInputRef = useRef<HTMLInputElement | null>(null);

  useDesignPicker({
    openBubbleFocusKey: null,
    bubbleNoteInputRef,
    designModeActive: designPickerPhase !== "off",
    hasOpenBubble,
    threadId: THREAD_ID,
    setEditingAnnotationId,
    setBubbleAdvancedOpen: editor.setBubbleAdvancedOpen,
    setOutsideWarned: editor.setOutsideWarned,
    dismissBubbleSlash,
    dismissBubbleFile,
    openBubbleBase: undefined,
    canSaveOpenBubble: false,
    outsideWarned: editor.outsideWarned,
    linkedVisualPairs,
    setBubbleVisuals: editor.setBubbleVisuals,
    setLinkedVisualPairs,
    setColorFormats,
    bubbleVisuals: editor.bubbleVisuals,
    bubbleRef,
    bubbleSlashOpen: false,
    bubbleFileOpen: false,
    designPickerPhase,
    designPickerArmId,
    designPickerDispatch,
    capture,
  });
}

beforeEach(() => {
  window.desktopBridge = {
    preview: mockPreview,
  } as unknown as typeof window.desktopBridge;
  usePreviewDesignModeStore.setState({ pickers: {} });
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
});

afterEach(() => {
  // Unmount first so resetting the stores does not re-render the harness outside act().
  cleanup();
  delete (window as unknown as Record<string, unknown>).desktopBridge;
  usePreviewDesignModeStore.setState({ pickers: {} });
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
  vi.clearAllMocks();
});

const PICKED_ELEMENT = {
  ok: true as const,
  meta: { id: "pick-1", name: "pick.png", mimeType: "image/png", sizeBytes: 3, sourcePath: "/tmp/pick.png" },
  previewBytes: new Uint8Array([1, 2, 3]),
  capture: {
    schemaVersion: 2,
    pageUrl: "https://example.com/products",
    pageTitle: "Products",
    capturedAt: "2026-07-01T00:00:00.000Z",
    captureKind: "element",
    selectorHint: "button.buy",
    bounds: { x: 10, y: 20, width: 120, height: 40 },
  },
};

async function settle(): Promise<void> {
  // Let the busy-flag re-renders, their effects and the awaited pushSync settle.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

describe("useDesignPicker", () => {
  it("arms a single element pick while Design mode waits for the user's click", async () => {
    // The pick stays pending until the user clicks an element in the guest page.
    mockPreview.capturePictureReferenceElementPick.mockReturnValue(new Promise(() => {}));
    usePreviewDesignModeStore.getState().setActive(THREAD_ID, true);

    renderHook(() => useDesignPickerHarness());
    await settle();

    // Each extra call makes the desktop host abort the pending pick and
    // reinject the guest overlay, so the hover highlight never appears.
    expect(mockPreview.capturePictureReferenceElementPick).toHaveBeenCalledTimes(1);
    expect(usePreviewDesignModeStore.getState().isActive(THREAD_ID)).toBe(true);
  });

  it("holds the picker while a note is open and re-arms once after it closes", async () => {
    mockPreview.capturePictureReferenceElementPick
      .mockResolvedValueOnce(PICKED_ELEMENT)
      .mockReturnValue(new Promise(() => {}));
    usePreviewDesignModeStore.getState().setActive(THREAD_ID, true);

    renderHook(() => useDesignPickerHarness());
    await settle();

    expect(usePreviewAnnotationStore.getState().drafts[THREAD_ID]).toBeDefined();
    expect(usePreviewDesignModeStore.getState().getPicker(THREAD_ID).phase).toBe("editing");
    expect(mockPreview.capturePictureReferenceElementPick).toHaveBeenCalledTimes(1);

    act(() => usePreviewAnnotationStore.getState().setDraft(THREAD_ID, undefined));
    await settle();

    expect(usePreviewDesignModeStore.getState().getPicker(THREAD_ID).phase).toBe("picking");
    expect(mockPreview.capturePictureReferenceElementPick).toHaveBeenCalledTimes(2);
  });

  it("closes the note on the first Esc and leaves Design on the second", async () => {
    mockPreview.capturePictureReferenceElementPick
      .mockResolvedValueOnce(PICKED_ELEMENT)
      .mockReturnValue(new Promise(() => {}));
    usePreviewDesignModeStore.getState().setActive(THREAD_ID, true);
    renderHook(() => useDesignPickerHarness());
    await settle();

    pressEscape();
    await settle();

    expect(usePreviewAnnotationStore.getState().drafts[THREAD_ID]).toBeUndefined();
    expect(usePreviewDesignModeStore.getState().isActive(THREAD_ID)).toBe(true);
    expect(mockPreview.capturePictureReferenceElementPick).toHaveBeenCalledTimes(2);

    pressEscape();
    await settle();

    expect(usePreviewDesignModeStore.getState().isActive(THREAD_ID)).toBe(false);
    expect(mockPreview.cancelCapture).toHaveBeenCalled();
    expect(mockPreview.capturePictureReferenceElementPick).toHaveBeenCalledTimes(2);
  });
});
