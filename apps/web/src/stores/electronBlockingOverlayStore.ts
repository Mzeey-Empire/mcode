import { create } from "zustand";

/**
 * Counts fullscreen modal dialogs that must sit visually above Electron's embedded
 * preview BrowserView. The native view always composites above renderer HTML,
 * so the preview is temporarily hidden whenever this depth is greater than zero.
 */
interface ElectronBlockingOverlayState {
  readonly depth: number;
  increment: () => void;
  decrement: () => void;
}

export const useElectronBlockingOverlayStore = create<ElectronBlockingOverlayState>((set) => ({
  depth: 0,
  increment: () => set((s) => ({ depth: s.depth + 1 })),
  decrement: () => set((s) => ({ depth: Math.max(0, s.depth - 1) })),
}));

/**
 * Keeps preview BrowserView suppressed while at least one blocking modal reports open.
 * Call from modal root `onOpenChange` alongside any existing handler (Command Palette,
 * shadcn `Dialog`, or raw Base UI dialogs).
 *
 * @param open When `true`, a blocking overlay gained focus; when `false`, it closed.
 */
export function syncElectronBlockingOverlayOpen(open: boolean): void {
  const { increment, decrement } = useElectronBlockingOverlayStore.getState();
  if (open) increment();
  else decrement();
}
