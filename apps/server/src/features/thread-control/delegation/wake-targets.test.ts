import { describe, expect, it } from "vitest";
import { wakeTargets } from "./wake-targets.js";

describe("wakeTargets", () => {
  it("nudges a nested Coordinator's parent and the Coordinator itself", () => {
    expect(wakeTargets({ id: "B", delegation_coordinator_thread_id: "A" }).sort()).toEqual(["A", "B"]);
  });

  it("nudges only a top-level Coordinator itself", () => {
    expect(wakeTargets({ id: "A", delegation_coordinator_thread_id: null })).toEqual(["A"]);
  });
});
