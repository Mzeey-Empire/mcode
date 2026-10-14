/** Where one thread's Design mode is: idle, waiting for a click on the page, or editing a note. */
export type DesignPickerPhase = "off" | "picking" | "editing";

/**
 * One thread's Design picker state. `armId` increases each time the picker arms, so a
 * pick result that outlives its arming can be recognised and dropped.
 */
export interface DesignPickerState {
  readonly phase: DesignPickerPhase;
  readonly armId: number;
}

/** Everything that can move the Design picker. */
export type DesignPickerEvent =
  | { readonly type: "toggle" }
  | { readonly type: "exit" }
  | { readonly type: "escape" }
  | { readonly type: "edit" }
  | { readonly type: "bubbleClosed" }
  | { readonly type: "picked"; readonly armId: number }
  | { readonly type: "pickFailed"; readonly armId: number };

/** Design is off and nothing is armed. */
export const DESIGN_PICKER_OFF: DesignPickerState = { phase: "off", armId: 0 };

function arm(state: DesignPickerState): DesignPickerState {
  return { phase: "picking", armId: state.armId + 1 };
}

function off(state: DesignPickerState): DesignPickerState {
  return state.phase === "off" ? state : { phase: "off", armId: state.armId };
}

function editing(state: DesignPickerState): DesignPickerState {
  return state.phase === "editing" ? state : { phase: "editing", armId: state.armId };
}

/**
 * Pure transition for the Design picker: off, picking, editing, then picking again.
 * Escape closes the note bubble first and leaves Design on the next press. Each arming
 * gets a fresh `armId`, and `picked` or `pickFailed` for an older one is ignored.
 */
export function designPickerReducer(
  state: DesignPickerState,
  event: DesignPickerEvent,
): DesignPickerState {
  switch (event.type) {
    case "toggle":
      return state.phase === "off" ? arm(state) : off(state);
    case "exit":
      return off(state);
    case "escape":
      if (state.phase === "editing") return arm(state);
      return off(state);
    case "edit":
      return state.phase === "off" ? state : editing(state);
    case "bubbleClosed":
      return state.phase === "editing" ? arm(state) : state;
    case "picked":
      return state.phase === "picking" && event.armId === state.armId ? editing(state) : state;
    case "pickFailed":
      return state.phase === "picking" && event.armId === state.armId ? off(state) : state;
  }
}
