import { create } from "zustand";

interface PreviewDesignModeStore {
  /** Map of threadId -> whether design mode is currently active for that thread. */
  readonly modes: Record<string, boolean>;
  /** Returns the current active flag for a thread, defaulting to false. */
  isActive: (threadId: string) => boolean;
  /** Flip active/inactive for the thread. */
  toggle: (threadId: string) => void;
  /** Explicitly set the active flag (used by the exit pill and by escape handlers). */
  setActive: (threadId: string, active: boolean) => void;
}

/**
 * Per-thread persistence for the preview Design mode surface. When active,
 * `PreviewDesignBar` is rendered below the omnibox and the toolbar's Design
 * button reads as pressed; this state survives focus changes and re-mounts
 * but is intentionally scoped to one thread so design sessions do not bleed
 * between contexts.
 *
 * Design mode is independent of any in-flight element-pick session: the mode
 * may be on while no pick is active (user is browsing viewport presets), or
 * a one-shot pick can run while the mode stays on after the capture completes
 * so the user can pick another element without toggling the mode again.
 */
export const usePreviewDesignModeStore = create<PreviewDesignModeStore>((set, get) => ({
  modes: {},
  isActive: (threadId) => get().modes[threadId] === true,
  toggle: (threadId) => {
    const current = get().modes[threadId] === true;
    set({ modes: { ...get().modes, [threadId]: !current } });
  },
  setActive: (threadId, active) => {
    const current = get().modes[threadId] === true;
    if (current === active) return;
    set({ modes: { ...get().modes, [threadId]: active } });
  },
}));
