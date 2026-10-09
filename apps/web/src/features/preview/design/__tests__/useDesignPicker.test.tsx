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
  const capture = usePreviewCapture({ threadId: THREAD_ID, pushSync });
  const designModeActive = usePreviewDesignModeStore((s) => s.modes[THREAD_ID] === true);
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);
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
    designModeActive,
    hasOpenBubble: false,
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
    designModeSetActive,
    designModeToggle,
    capture,
  });
}

beforeEach(() => {
  window.desktopBridge = {
    preview: mockPreview,
  } as unknown as typeof window.desktopBridge;
  usePreviewDesignModeStore.setState({ modes: {} });
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
});

afterEach(() => {
  // Unmount first so resetting the stores does not re-render the harness outside act().
  cleanup();
  delete (window as unknown as Record<string, unknown>).desktopBridge;
  usePreviewDesignModeStore.setState({ modes: {} });
  usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
  vi.clearAllMocks();
});

describe("useDesignPicker", () => {
  it("arms a single element pick while Design mode waits for the user's click", async () => {
    // The pick stays pending until the user clicks an element in the guest page.
    mockPreview.capturePictureReferenceElementPick.mockReturnValue(new Promise(() => {}));
    usePreviewDesignModeStore.getState().setActive(THREAD_ID, true);

    renderHook(() => useDesignPickerHarness());
    // Let the busy-flag re-renders, their effects and the awaited pushSync settle.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Each extra call makes the desktop host abort the pending pick and
    // reinject the guest overlay, so the hover highlight never appears.
    expect(mockPreview.capturePictureReferenceElementPick).toHaveBeenCalledTimes(1);
    expect(usePreviewDesignModeStore.getState().isActive(THREAD_ID)).toBe(true);
  });
});
