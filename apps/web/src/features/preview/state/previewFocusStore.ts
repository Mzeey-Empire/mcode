import { create } from "zustand";

interface PreviewFocusStore {
  /** A focus-request counter preserves repeated requests and requests made before mount. */
  readonly omniboxFocusTick: number;
  /** Bump the focus tick. Called by the preview-opening keyboard command. */
  requestOmniboxFocus: () => void;
}

/** Requests address focus, including while the preview is closed. */
export const usePreviewFocusStore = create<PreviewFocusStore>((set) => ({
  omniboxFocusTick: 0,
  requestOmniboxFocus: () =>
    set((s) => ({ omniboxFocusTick: s.omniboxFocusTick + 1 })),
}));
