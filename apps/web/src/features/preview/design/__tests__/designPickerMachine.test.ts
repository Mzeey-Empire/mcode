import { describe, expect, it } from "vitest";
import {
  DESIGN_PICKER_OFF,
  designPickerReducer,
  type DesignPickerEvent,
  type DesignPickerState,
} from "../designPickerMachine";

function run(events: readonly DesignPickerEvent[], from: DesignPickerState = DESIGN_PICKER_OFF) {
  const armings: number[] = [];
  let state = from;
  for (const event of events) {
    const next = designPickerReducer(state, event);
    if (next.phase === "picking" && (state.phase !== "picking" || next.armId !== state.armId)) {
      armings.push(next.armId);
    }
    state = next;
  }
  return { state, armings };
}

describe("designPickerReducer", () => {
  it("arms exactly once when Design turns on", () => {
    const { state, armings } = run([{ type: "toggle" }]);
    expect(state.phase).toBe("picking");
    expect(armings).toEqual([1]);
  });

  it("opens the note on a pick and re-arms once after the bubble closes", () => {
    const { state, armings } = run([
      { type: "toggle" },
      { type: "picked", armId: 1 },
      { type: "bubbleClosed" },
      { type: "bubbleClosed" },
    ]);
    expect(state).toEqual({ phase: "picking", armId: 2 });
    expect(armings).toEqual([1, 2]);
  });

  it("closes the bubble on the first Esc and leaves Design on the second", () => {
    const afterFirst = run([{ type: "toggle" }, { type: "picked", armId: 1 }, { type: "escape" }]);
    expect(afterFirst.state.phase).toBe("picking");
    const afterSecond = run([{ type: "escape" }], afterFirst.state);
    expect(afterSecond.state.phase).toBe("off");
  });

  it("ignores a pick result from an earlier arming", () => {
    const { state } = run([
      { type: "toggle" },
      { type: "picked", armId: 1 },
      { type: "bubbleClosed" },
      { type: "picked", armId: 1 },
      { type: "pickFailed", armId: 1 },
    ]);
    expect(state).toEqual({ phase: "picking", armId: 2 });
  });

  it("leaves Design when the pick fails or Design is toggled off mid-edit", () => {
    expect(run([{ type: "toggle" }, { type: "pickFailed", armId: 1 }]).state.phase).toBe("off");
    expect(
      run([{ type: "toggle" }, { type: "picked", armId: 1 }, { type: "toggle" }]).state.phase,
    ).toBe("off");
  });

  it("moves from picking to editing when a saved note is reopened", () => {
    const { state } = run([{ type: "toggle" }, { type: "edit" }]);
    expect(state).toEqual({ phase: "editing", armId: 1 });
  });

  it("does not wake an idle picker", () => {
    for (const event of [
      { type: "edit" },
      { type: "bubbleClosed" },
      { type: "escape" },
      { type: "exit" },
    ] as const) {
      expect(run([event]).state).toEqual(DESIGN_PICKER_OFF);
    }
  });
});
