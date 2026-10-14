import { create } from "zustand";
import {
  DESIGN_PICKER_OFF,
  designPickerReducer,
  type DesignPickerEvent,
  type DesignPickerState,
} from "../design/designPickerMachine";

interface PreviewDesignModeStore {
  readonly pickers: Record<string, DesignPickerState>;
  getPicker: (threadId: string) => DesignPickerState;
  /** Returns whether Design is on for the thread (picking or editing). */
  isActive: (threadId: string) => boolean;
  dispatch: (threadId: string, event: DesignPickerEvent) => void;
  toggle: (threadId: string) => void;
  /** Turns Design on or off without touching an active picker's arming. */
  setActive: (threadId: string, active: boolean) => void;
}

/**
 * Per-thread home of the `designPickerMachine`. State is scoped to the thread so Design
 * sessions do not bleed between contexts.
 */
export const usePreviewDesignModeStore = create<PreviewDesignModeStore>((set, get) => {
  const dispatch = (threadId: string, event: DesignPickerEvent): void => {
    const current = get().pickers[threadId] ?? DESIGN_PICKER_OFF;
    const next = designPickerReducer(current, event);
    if (next === current) return;
    set({ pickers: { ...get().pickers, [threadId]: next } });
  };
  return {
    pickers: {},
    getPicker: (threadId) => get().pickers[threadId] ?? DESIGN_PICKER_OFF,
    isActive: (threadId) => (get().pickers[threadId] ?? DESIGN_PICKER_OFF).phase !== "off",
    dispatch,
    toggle: (threadId) => dispatch(threadId, { type: "toggle" }),
    setActive: (threadId, active) => {
      const isActive = get().isActive(threadId);
      if (active === isActive) return;
      dispatch(threadId, { type: active ? "toggle" : "exit" });
    },
  };
});
