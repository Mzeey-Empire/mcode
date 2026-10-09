import { describe, expect, it } from "vitest";
import { FRONT_PLACEMENT, layoutToastStack, type ToastPresence } from "../toast-presence";

const entry = (id: string, exiting = false): ToastPresence => ({
  toast: { id, kind: "failed", title: id },
  exiting,
  placement: FRONT_PLACEMENT,
});

describe("layoutToastStack", () => {
  it("aligns a shorter older toast's bottom with a taller front toast when collapsed", () => {
    const heights = new Map([["front", 90], ["older", 60]]);

    const placements = layoutToastStack([entry("front"), entry("older")], heights, false);

    // 90 - 60 + 8: the older toast's bottom edge sits 8px under the front toast's.
    expect(placements.get("older")).toEqual({ offset: 38, scale: 0.95 });
  });

  it("lets exiting toasts give up their place in either layout", () => {
    const heights = new Map([["leaving", 60], ["front", 60], ["older", 60]]);
    const entries = [entry("leaving", true), entry("front"), entry("older")];

    expect(layoutToastStack(entries, heights, true).get("older")).toEqual({ offset: 70, scale: 1 });
    expect(layoutToastStack(entries, heights, false).get("front")).toEqual(FRONT_PLACEMENT);
  });
});
