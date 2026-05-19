import { create } from "zustand";

/**
 * Tracks how many overlays (modals, dialogs, command palettes) are currently
 * obscuring the preview region. The Electron host's WebContentsView is a
 * native compositing layer that paints above all HTML, so any time something
 * in the renderer needs to appear above the preview we count it here and the
 * preview panel hides the native view until the count returns to zero.
 *
 * Each suppressor is responsible for calling `increment()` when it opens and
 * `decrement()` when it closes (or unmounts while open). The store guards
 * against negative counts so a stray decrement cannot leak the preview into a
 * permanently-hidden state.
 */
interface PreviewSuppressionState {
  readonly count: number;
  increment: () => void;
  decrement: () => void;
}

export const usePreviewSuppressionStore = create<PreviewSuppressionState>(
  (set) => ({
    count: 0,
    increment: () => set((s) => ({ count: s.count + 1 })),
    decrement: () =>
      set((s) => ({ count: s.count > 0 ? s.count - 1 : 0 })),
  }),
);
